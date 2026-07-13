import { SkillManifest } from "../skills/types";
import { discoverSkills } from "../skills/skillDiscovery";
import { qwen } from "./providers/qwen";

// ── Router system prompt ──────────────────────────────────────────────────────
// Enumerates only the routable skills. Keep this in sync with the SKILL.md
// `name:` frontmatter values. Internal plumbing skills (shell, todo, etc.) are
// intentionally excluded — they are surfaced through SKILLS_METADATA but never
// selected as an active persona by the router.
const ROUTER_SYSTEM = `You are a skill router. Match tasks to ONE best skill by understanding intent.

SKILLS GUIDE:
- frontend-design: Build web UIs, components, pages, dashboards, landing pages, styling, layout
- backend-skill: APIs, routes, controllers, middleware, databases, authentication, server logic
- architect: System design, scalability, infrastructure, microservices, data flow, trade-offs
- web-design-guidelines: Review UI code, accessibility audits, UX reviews, design compliance
- code-intelligence: Find code, locate functions, refactor, trace calls, search codebase
- web: External research, documentation, API references, how-to guides, integrations

RULES:
1. Match by intent, not keywords
2. Return ONLY the skill name exactly as shown above
3. Return "none" if no skill fits
4. No explanation, no punctuation, no quotes — a single bare token only
5. 90%+ accuracy required

EXAMPLES:
"Design a beautiful landing page" → frontend-design
"Create API endpoint for users" → backend-skill
"How should we architect a microservice system?" → architect
"Check if my button follows accessibility standards" → web-design-guidelines
"Find where the login function is defined" → code-intelligence
"How do I integrate Stripe?" → web
"none" → if truly no fit`;

// ── Heuristic fallback ────────────────────────────────────────────────────────
const KEYWORD_MAP: Record<string, string[]> = {
  "frontend-design":       ["ui", "component", "page", "css", "design", "landing", "dashboard", "style", "layout", "beautiful", "interface", "app", "chat", "dark theme", "light theme"],
  "architect":             ["architecture", "system design", "schema", "service boundaries", "microservice", "infrastructure", "scale", "trade-off"],
  "web-design-guidelines": ["review ui", "check accessibility", "audit design", "ux review", "best practices", "wcag"],
  "code-intelligence":     ["find function", "locate", "refactor", "where is", "trace", "which file"],
  "web":                   ["documentation", "research", "how to", "integration", "api reference"],
  "backend-skill":         ["api endpoint", "backend logic", "server side", "route", "controller", "middleware"],
};

function heuristicSelect(task: string, skills: SkillManifest[]): SkillManifest | null {
  const lower = task.toLowerCase();
  for (const [skillName, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      const match = skills.find((s) => s.name.toLowerCase() === skillName);
      if (match) {
        console.log(`[SKILL] heuristic matched: "${skillName}" (keyword hit in task)`);
        return match;
      }
    }
  }
  return null;
}

// ── Qwen call with timeout ────────────────────────────────────────────────────
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ── shouldRoute ───────────────────────────────────────────────────────────────
export async function shouldRoute(taskDescription: string, mode: "plan" | "build"): Promise<boolean> {
  // Plan mode: always route (quality + safety)
  if (mode === "plan") {
    console.log(`[SKILL] Plan mode: always routing`);
    return true;
  }

  // Build mode: ask Qwen if task needs specialized skill
  try {
    const client = await qwen.getClient();

    console.log(`[SKILL] Routing decision: checking if task needs skill...`);
    const res = await withTimeout(
      client.chat.completions.create({
        model: "qwen-turbo",
        messages: [{
          role: "user",
          content: `Task: "${taskDescription}"\n\nDoes this task REQUIRE a specialized coding skill (like backend, frontend, architecture)?\nAnswer only: yes or no`
        }],
        max_tokens: 10,
        temperature: 0,
      }),
      5000, // 5s cap — routing must be fast
      "shouldRoute Qwen call",
    );

    const answer = res.choices[0]?.message?.content?.trim().toLowerCase() ?? "no";
    const doRoute = answer.includes("yes");

    console.log(`[SKILL] Routing decision: ${doRoute ? "yes (will route)" : "no (skip routing)"}`);
    return doRoute;

  } catch (err: any) {
    console.warn(`[SKILL] Route decision failed: ${err.message} — defaulting to heuristic-based decision`);
    // BUG FIX: was passing [] instead of discovered skills, making fallback always return false.
    const skills = await discoverSkills();
    return heuristicSelect(taskDescription, skills) !== null;
  }
}

// ── selectSkillForTask ────────────────────────────────────────────────────────
export async function selectSkillForTask(
  taskDescription: string,
): Promise<SkillManifest | null> {
  const skills = await discoverSkills();
  if (skills.length === 0) {
    console.log("[SKILL] no skills available — skipping routing");
    return null;
  }

  console.log(`[SKILL] ── routing ─────────────────────────────────────────────`);
  console.log(`[SKILL] task: "${taskDescription.slice(0, 100)}${taskDescription.length > 100 ? "..." : ""}"`);
  console.log(`[SKILL] available skills: ${skills.map((s) => s.name).join(", ")}`);

  try {
    const client = await qwen.getClient();

    console.log(`[SKILL] Sending skill classification to Qwen (qwen-plus for 90%+ accuracy)...`);

    const skillsList = skills.map(s => `${s.name}: ${s.description}`).join("\n");

    const res = await withTimeout(
      client.chat.completions.create({
        model: "qwen-plus",
        messages: [
          { role: "system", content: ROUTER_SYSTEM },
          { role: "user", content: `Task: "${taskDescription}"\n\nReturn the best skill name or "none":\n${skillsList}` }
        ],
        max_tokens: 32,
        temperature: 0,
      }),
      8000, // 8s cap
      "selectSkillForTask Qwen call",
    );

    if (!res.choices || res.choices.length === 0) {
      throw new Error("Qwen returned empty choices array");
    }

    // Normalise: strip quotes, extra whitespace, punctuation, take only first token
    const raw = res.choices[0].message?.content?.trim().toLowerCase() ?? "none";
    const selected = raw
      .replace(/^[`"']+|[`"']+$/g, "")  // strip surrounding quotes/backticks
      .replace(/[.,!?;:]+$/, "")          // strip trailing punctuation
      .split(/\s+/)[0]                    // take first token only (guards multi-word responses)
      .trim();

    console.log(`[SKILL] classifier result → "${selected}"`);

    if (selected === "none" || selected === "") {
      console.log("[SKILL] Classifier returned 'none' — running with base prompt only");
      return null;
    }

    // Exact match first
    const exactMatch = skills.find((s) => s.name.toLowerCase() === selected);
    if (exactMatch) {
      console.log(`[SKILL] ✓ Successfully matched skill: "${exactMatch.name}"`);
      return exactMatch;
    }

    // Partial match: prefer the most specific manifest whose name starts with the
    // classifier output (e.g. "frontend" → "frontend-design"), while avoiding
    // shorter skills like "web" shadowing longer matches such as
    // "web-design-guidelines".
    const partialMatches = skills
      .filter((s) => s.name.toLowerCase().startsWith(selected))
      .sort((a, b) => b.name.length - a.name.length);
    const partialMatch = partialMatches[0];
    if (partialMatch) {
      console.log(`[SKILL] ✓ Partial match: "${selected}" → "${partialMatch.name}"`);
      return partialMatch;
    }

    console.log(`[SKILL] Classifier returned "${selected}" — no match in manifest, trying heuristic fallback`);
    return heuristicSelect(taskDescription, skills);

  } catch (err: any) {
    console.error(`[SKILL] Qwen classifier failed: ${err.message} — falling back to heuristic`);
    return heuristicSelect(taskDescription, skills);
  }
}

// ── isSmallTask ───────────────────────────────────────────────────────────────
export function isSmallTask(description: string): boolean {
  if (description.length < 80) return true;

  const simpleKeywords = [
    "change", "update", "fix", "modify", "add", "remove",
    "delete", "rename", "color", "text", "spacing", "margin",
    "typo", "bug", "adjust", "tweak", "style", "format",
    "border", "padding", "font", "size", "weight",
  ];

  return simpleKeywords.some((kw) =>
    description.toLowerCase().includes(kw)
  );
}
