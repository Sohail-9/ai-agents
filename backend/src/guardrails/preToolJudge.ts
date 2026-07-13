/**
 * preToolJudge.ts
 *
 * A lightweight LLM-based safety judge that evaluates whether a risky tool
 * call makes logical sense given the agent's current goal and recent context.
 *
 * This is ONLY invoked for high-risk tools:
 *  - execute_shell  (can run arbitrary system commands)
 *  - edit_file      (when overwriting an entire file — operation=overwrite)
 *  - provision_database (irreversible infra change)
 *
 * Architecture decision:
 *  - Uses a minimal GPT-4o-mini or Claude-3-Haiku prompt (~200 tokens in, 10 out)
 *    to keep latency under 500ms.
 *  - Falls back to ALLOW if the LLM call fails — never blocks due to judge downtime.
 *  - Does NOT explain the block in verbose terms; returns a terse machine-readable verdict.
 */

import OpenAI from "openai";

// ── Tools that require AI judgment ──────────────────────────────────────────
export const JUDGED_TOOLS = new Set([
  "execute_shell",
  "provision_database",
  "env_manager",
]);

// For edit_file specifically we only judge "overwrite" operations on large content
export const JUDGED_EDIT_THRESHOLD_CHARS = 2000;

// ── Judge LLM client ──────────────────────────────────────────────────────────
// Uses a fast, cheap model intentionally — not the workspace's primary provider.
// Falls back gracefully if no key is configured.
type JudgeProvider = "openai" | "groq";

interface JudgeClientConfig {
  client: OpenAI;
  provider: JudgeProvider;
  model: string;
  baseURL: string;
}

function pickJudgeProvider(): JudgeProvider | null {
  const forced = process.env.JUDGE_PROVIDER?.trim().toLowerCase();
  if (forced === "openai") return process.env.OPENAI_API_KEY ? "openai" : null;
  if (forced === "groq") return process.env.GROQ_API_KEY ? "groq" : null;
  if (forced === "local" || forced === "deterministic") return null;

  // Default preference: OpenAI-compatible endpoint first (works for OpenAI proxy setups),
  // then Groq.
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GROQ_API_KEY) return "groq";
  return null;
}

function getJudgeClientConfig(): JudgeClientConfig | null {
  const provider = pickJudgeProvider();
  if (!provider) return null;

  if (provider === "openai") {
    const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    return {
      provider,
      baseURL,
      model: process.env.JUDGE_MODEL_OPENAI || "gpt-4o-mini",
      client: new OpenAI({
        apiKey: process.env.OPENAI_API_KEY!,
        baseURL,
      }),
    };
  }

  const baseURL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  return {
    provider,
    baseURL,
    model: process.env.JUDGE_MODEL_GROQ || "llama-3.1-8b-instant",
    client: new OpenAI({
      apiKey: process.env.GROQ_API_KEY!,
      baseURL,
    }),
  };
}

function isProvisionDatabaseCallSafe(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const rec = args as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length > 2) return false;
  if (typeof rec.workspaceId !== "string" || rec.workspaceId.trim().length === 0) return false;
  if (typeof rec.sandboxId !== "string" || rec.sandboxId.trim().length === 0) return false;
  return true;
}

// Once the judge provider returns an auth error (e.g. invalid/expired API key) there
// is no point calling it again this process — every call would 401, adding latency and
// (worse) BLOCKING risky execute_shell on what is really a config problem. Cache that
// state and behave as "judge not configured" instead.
let judgeDisabledReason: string | null = null;

function isAuthError(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.message ?? "");
  return status === 401 || status === 403 || /api key|incorrect api key|unauthor/i.test(msg);
}

// ── Verdict type ─────────────────────────────────────────────────────────────
export type JudgeVerdict = "ALLOW" | "BLOCK";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason?: string;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Ask the AI judge whether a specific tool call should be allowed.
 *
 * @param goal        - The current task title / description the agent is working on.
 * @param toolName    - Name of the tool being called.
 * @param args        - Arguments passed to the tool.
 * @param recentActions - Last N tool call signatures from the loop detector.
 * @returns ALLOW (default on error) or BLOCK with a reason.
 */
export async function judgeToolAction(params: {
  goal: string;
  toolName: string;
  args: unknown;
  recentActions: string[];
}): Promise<JudgeResult> {
  const { goal, toolName, args, recentActions } = params;

  // If a prior call hit an auth error, the key is broken for this whole process — skip
  // the LLM entirely and use the same fallbacks as "no judge configured".
  const judge = judgeDisabledReason ? null : getJudgeClientConfig();
  if (!judge) {
    if (toolName === "provision_database") {
      const safe = isProvisionDatabaseCallSafe(args);
      return safe
        ? { verdict: "ALLOW", reason: "Judge not configured; deterministic DB safeguard passed" }
        : { verdict: "BLOCK", reason: "Judge not configured and DB args failed deterministic safety checks" };
    }
    // No judge client configured (or disabled after auth error) — fail open
    return { verdict: "ALLOW", reason: judgeDisabledReason ? "Judge disabled (auth error)" : "Judge not configured (no API key)" };
  }

  // Serialize args safely, truncate to keep prompt tiny
  const argsStr = JSON.stringify(args, null, 2).slice(0, 600);
  const recentStr = recentActions.slice(-5).join("\n") || "(no recent actions)";

  const prompt = `You are a safety judge for an AI coding agent. Evaluate this tool call.

CURRENT GOAL: ${goal.slice(0, 200)}

TOOL: ${toolName}
ARGS:
${argsStr}

RECENT ACTIONS (last 5):
${recentStr}

Rules:
- BLOCK if the command appears destructive and unrelated to the goal (e.g. rm -rf /, curl | sh, mkfs, dd).
- BLOCK if this looks like an obvious retry loop (same action repeated with no goal progress).
- ALLOW if this is a routine development command (npm install, mkdir, cat, ls, git, node, python, etc.).
- ALLOW if this edit helps build the stated goal.
- When in doubt, ALLOW.

Respond with exactly one word: ALLOW or BLOCK
Then optionally one line reason after a newline.`;

  try {
    const response = await judge.client.chat.completions.create({
      model: judge.model,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 30,
      temperature: 0,
    });

    const text = (response.choices[0]?.message?.content ?? "ALLOW").trim();
    const firstLine = text.split("\n")[0].toUpperCase();
    const verdict: JudgeVerdict = firstLine.startsWith("BLOCK") ? "BLOCK" : "ALLOW";
    const reason = text.split("\n").slice(1).join(" ").trim() || undefined;

    if (verdict === "BLOCK") {
      console.warn(`[PreToolJudge] 🔴 BLOCKED tool=${toolName} reason=${reason || "judge decision"}`);
    } else {
      console.log(`[PreToolJudge] ✅ ALLOWED tool=${toolName}`);
    }

    return { verdict, reason };
  } catch (err: any) {
    // Auth error = broken/expired key (config issue, not a safety signal). Disable the
    // judge for the rest of the process and fail open uniformly so a bad key can't block
    // legitimate work. provision_database still goes through deterministic safeguards.
    if (isAuthError(err)) {
      if (!judgeDisabledReason) {
        judgeDisabledReason = String(err?.message ?? "auth error").slice(0, 120);
        console.warn(
          `[PreToolJudge] Auth error — disabling judge for this process (failing open / deterministic safeguards only): ${judgeDisabledReason}`,
        );
      }
      if (toolName === "provision_database") {
        const safe = isProvisionDatabaseCallSafe(args);
        return safe
          ? { verdict: "ALLOW", reason: "Judge auth error; deterministic DB safeguard passed" }
          : { verdict: "BLOCK", reason: "Judge auth error and DB safety checks failed" };
      }
      return { verdict: "ALLOW", reason: "Judge auth error — disabled, failing open" };
    }

    // For irreversible DB provisioning, use deterministic fallback to avoid
    // deadlocking valid requests when the judge provider is flaky/misconfigured.
    if (toolName === "provision_database") {
      const safe = isProvisionDatabaseCallSafe(args);
      if (safe) {
        console.warn(
          `[PreToolJudge] Judge unavailable on ${judge.provider} (${judge.baseURL}); allowing provision_database via deterministic safeguard: ${err.message}`,
        );
        return { verdict: "ALLOW", reason: "Judge unavailable; deterministic DB safeguard passed" };
      }
      console.warn(
        `[PreToolJudge] Judge unavailable and deterministic DB safeguard failed: ${err.message}`,
      );
      return { verdict: "BLOCK", reason: "Judge unavailable and DB safety checks failed" };
    }
    if (toolName === "execute_shell") {
      console.warn(`[PreToolJudge] Judge LLM call failed — blocking risky command: ${err.message}`);
      return { verdict: "BLOCK", reason: "Judge error; blocking risky command" };
    }
    // edit_file is destructive but not irreversible — fail open
    console.warn(`[PreToolJudge] Judge LLM call failed (failing open): ${err.message}`);
    return { verdict: "ALLOW", reason: "Judge error — failing open" };
  }
}

/**
 * Helper: should we even invoke the judge for this specific call?
 * Avoids the latency cost for safe, low-risk tools.
 *
 * KEY OPTIMIZATION: For execute_shell, only judge commands that match a
 * destructive risk profile. Routine dev commands (npm, mkdir, ls, git, node)
 * always get ALLOW from the judge anyway — calling it on every shell command
 * was adding 300-500ms × 40+ calls = 12-30s of pure overhead per build.
 */
const RISKY_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-[^\s]*r/,           // recursive delete
  /\bcurl\b.*\|\s*(ba)?sh/,    // pipe to shell
  /\bwget\b.*\|\s*(ba)?sh/,    // pipe to shell
  /\bdd\s+.*of=/,              // disk write
  /\bmkfs\b/,                  // format filesystem
  /\bshutdown\b/,              // shutdown
  /\breboot\b/,                // reboot
  /\bchmod\s+777/,             // world-writable
  /\bkill\s+-9\s+-1\b/,        // kill all
];

export function shouldJudge(toolName: string, args: unknown): boolean {
  if (toolName === "provision_database") return true;
  if (toolName === "env_manager") return true;

  // For execute_shell: only judge commands matching destructive patterns
  if (toolName === "execute_shell") {
    const cmd = ((args as any)?.command || "").toLowerCase();
    return RISKY_SHELL_PATTERNS.some(p => p.test(cmd));
  }

  // Judge large overwrites (high risk of data loss)
  if (
    toolName === "edit_file" &&
    typeof (args as any)?.operation === "string" &&
    (args as any).operation === "overwrite" &&
    typeof (args as any)?.content === "string" &&
    (args as any).content.length > JUDGED_EDIT_THRESHOLD_CHARS
  ) {
    return true;
  }

  return false;
}
