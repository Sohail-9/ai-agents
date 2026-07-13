import { runAgent, AgentRunnerContext } from "../agentRunner";
import { runResearcherAgent } from "./researcherAgent";
import { runFileAgent } from "./fileAgent";
import { synthesizeReports } from "./synthesisNode";
import { SubAgentContext, SubAgentResult } from "./subAgentTypes";
import { todoService, messageService, agentLogService } from "../../services";
import { createSubAgentLLMClient } from "./subAgentLLM";

// ─────────────────────────────────────────────────────────────────────────────
// Intent Classifier
// ─────────────────────────────────────────────────────────────────────────────

interface ClassifierDecision {
  needsResearch: boolean;
  needsFileExploration: boolean;
  reason: string;
}

// Real-time / web signals — force needsResearch = true regardless of LLM output.
const REALTIME_WEB_SIGNALS = [
  "latest",
  "recent",
  "current",
  "today",
  "tonight",
  "this week",
  "this month",
  "trending",
  "news",
  "headline",
  "breaking",
  "live",
  "real-time",
  "realtime",
  "price",
  "stock",
  "crypto",
  "bitcoin",
  "weather",
  "forecast",
  "what is happening",
  "what's happening",
  "right now",
  "at the moment",
];

// Named third-party services whose docs, API keys, SDK setup, or endpoint details
// must be fetched from the web. Only include services with external dependencies —
// do NOT list generic framework features or standard library patterns.
const TECH_INTEGRATION_SIGNALS = [
  // Payments & billing
  "stripe",
  "paypal",
  "razorpay",
  "braintree",
  "square",
  "lemon squeezy",
  "paddle",
  // Auth & identity (named external services only)
  "auth0",
  "clerk",
  "lucia",
  "better-auth",
  "kinde",
  "supertokens",
  "oauth",
  "openid",
  "saml",
  "sso",
  "passkey",
  // Email / SMS / notification services
  "sendgrid",
  "mailgun",
  "resend",
  "postmark",
  "mailchimp",
  "twilio",
  "vonage",
  "ses",
  // Storage & media services
  "cloudinary",
  "uploadthing",
  " s3 ",
  "cloudflare r2",
  "bunny.net",
  "minio",
  "imgix",
  // Hosted databases / BaaS (external service, not just an ORM)
  "supabase",
  "firebase",
  "neon",
  "planetscale",
  "turso",
  "convex",
  // AI / LLM external providers
  "openai api",
  "anthropic api",
  "gemini api",
  "replicate",
  "hugging face",
  "langchain",
  "vercel ai sdk",
  // Maps & geo services
  "mapbox",
  "google maps",
  // Analytics & monitoring services
  "posthog",
  "mixpanel",
  "amplitude",
  "segment",
  "sentry",
  "datadog",
  "logtail",
  "betterstack",
  // Real-time / collab services
  "pusher",
  "ably",
  "liveblocks",
  "partykit",
  // Search services (hosted)
  "algolia",
  "typesense",
  "meilisearch",
  // Background job services
  "inngest",
  "trigger.dev",
  "quirrel",
  // Vector / AI search
  "vector search",
  "semantic search",
  "embedding",
  "pinecone",
  "weaviate",
  "qdrant",
];

function hasRealtimeSignal(task: string): boolean {
  const lower = task.toLowerCase();
  return REALTIME_WEB_SIGNALS.some((s) => lower.includes(s));
}

function hasTechIntegrationSignal(task: string): boolean {
  const lower = task.toLowerCase();
  return TECH_INTEGRATION_SIGNALS.some((s) => lower.includes(s));
}

const CLASSIFIER_PROMPT = `You are an intent classifier for a multi-agent coding assistant.

Analyse the task and decide independently for each sub-agent. Be conservative about research — only trigger it when genuinely necessary.

needsResearch — TRUE only when the task explicitly requires:
- A named external third-party service whose API keys, SDK setup, or endpoint details must be fetched from the web (e.g. Stripe, Clerk, Twilio, Supabase, Pusher)
- Real-time, recent, or time-sensitive external data (current prices, live news, weather, trends)
- Domain facts or real-world content not derivable from the codebase (regulations, market data, events)
- An unfamiliar external package or API not already known (not React, Next.js, Tailwind, shadcn, Express, TypeScript, or any common web framework)

needsResearch — FALSE (handle in main agent, no web search needed) when:
- The task is about Next.js features: routing, server components, API routes, middleware, app directory, layouts
- The task is about React: hooks, context, state management, component patterns, event handling
- The task is about Tailwind CSS or any CSS/styling approach: class names, responsive design, theming
- The task is about TypeScript or JavaScript patterns, syntax, or idioms
- The task is about standard web patterns: forms, validation, pagination, modals, tables, navigation
- The task is a general coding decision or architectural question about an existing codebase
- The named library is already well-known (React, Next.js, Express, Prisma, shadcn/ui, etc.)

needsFileExploration — TRUE when ANY of the following apply:
- Task modifies, extends, or integrates into the existing codebase
- Task needs to follow folder structure, naming patterns, or existing conventions
- Task adds routes, components, services, models, or configuration to the project
- Task is anything beyond a one-liner isolated change

Examples:
"Fix typo in header"                                           → { needsResearch: false, needsFileExploration: false }
"Change button colour to blue"                                 → { needsResearch: false, needsFileExploration: false }
"Add a new /about route to the Next.js app"                    → { needsResearch: false, needsFileExploration: true  }
"Build a responsive navbar with Tailwind"                      → { needsResearch: false, needsFileExploration: true  }
"Add a React hook to debounce input"                           → { needsResearch: false, needsFileExploration: false }
"Create a dashboard page with charts using recharts"           → { needsResearch: false, needsFileExploration: true  }
"Add server-side pagination to the users table"                → { needsResearch: false, needsFileExploration: true  }
"Add a modal component using shadcn/ui"                        → { needsResearch: false, needsFileExploration: true  }
"Refactor auth module to use JWT"                              → { needsResearch: false, needsFileExploration: true  }
"Add Stripe payment checkout"                                  → { needsResearch: true,  needsFileExploration: true  }
"Set up Clerk authentication"                                  → { needsResearch: true,  needsFileExploration: true  }
"Build a weather widget using OpenWeatherMap"                  → { needsResearch: true,  needsFileExploration: true  }
"Add email sending with Resend"                                → { needsResearch: true,  needsFileExploration: true  }
"Show today's trending news on the homepage"                   → { needsResearch: true,  needsFileExploration: true  }
"Upload files to Cloudinary"                                   → { needsResearch: true,  needsFileExploration: true  }
"What is the current Bitcoin price?"                           → { needsResearch: true,  needsFileExploration: false }
"Integrate Pusher for real-time notifications"                 → { needsResearch: true,  needsFileExploration: true  }

Task: "{TASK}"

Respond with JSON only — no markdown:
{"needsResearch": true, "needsFileExploration": true, "reason": "one sentence why"}`;

async function classifyTask(
  taskDescription: string,
  ctx: AgentRunnerContext,
): Promise<ClassifierDecision> {
  // Fast-paths: keyword signals force research=true before the LLM can under-classify
  const realtimeForced = hasRealtimeSignal(taskDescription);
  const techForced = hasTechIntegrationSignal(taskDescription);
  const researchForced = realtimeForced || techForced;

  try {
    const { client, model, provider } = await createSubAgentLLMClient({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      provider: ctx.provider,
    });

    const prompt = CLASSIFIER_PROMPT.replace("{TASK}", taskDescription.slice(0, 600));

    const requestParams: any = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 120,
    };

    if (provider === "QWEN_DASHSCOPE") {
      requestParams.extra_body = { enable_thinking: false };
    }

    const response = await client.chat.completions.create(requestParams, { signal: ctx.signal });

    const raw = (response.choices[0]?.message?.content ?? "{}")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(raw);

    return {
      needsResearch: researchForced || parsed.needsResearch === true,
      // For non-trivial tasks, also default needsFileExploration to true if LLM says research is needed
      needsFileExploration:
        parsed.needsFileExploration === true ||
        (parsed.needsResearch === true && parsed.needsFileExploration !== false),
      reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
    };
  } catch (err: any) {
    console.error(`[Classifier] Failed (${err.message}) — using signal-based fallback`);
    return {
      needsResearch: researchForced,
      needsFileExploration: researchForced, // if research needed, explore files too
      reason: "classifier error — fell back to signal detection",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal generator — only generates goals for agents that will actually run
// ─────────────────────────────────────────────────────────────────────────────

interface SubAgentGoals {
  researchGoal?: string;
  fileGoal?: string;
}

const RESEARCH_GOAL_PROMPT = `
You are a task planner for a research sub-agent whose job is to use web search to gather EXTERNAL, CURRENT, and VERIFIABLE information.

Given a user task, generate a concrete numbered checklist of atomic research goals the agent MUST investigate.

Only include goals that require information outside the local codebase, including:

- Third-party APIs, services, SDKs
  (official docs, endpoints, auth methods, pricing, rate limits, setup requirements, version constraints)

- Packages, libraries, tools, and ecosystem options
  (recommended libraries, alternatives, maintenance status, compatibility, deprecations)

- Current or real-world domain information the task depends on
  (facts, datasets, examples, industry data, regulations, standards)

- News, recent developments, and time-sensitive information
  (latest announcements, releases, breaking changes, outages, security advisories, policy changes, market events, product updates)

- Comparative/vendor research
  (compare providers, tradeoffs, community consensus, benchmarks, adoption signals)

- Operational and compliance constraints
  (quotas, provider limitations, licensing, legal/regulatory requirements)

- Current implementation patterns from external sources when the task depends on them
  (documented integration patterns from official docs or credible sources, not generic coding advice)

Rules:
- Each goal must be specific, searchable, and independently executable.
- Use action-oriented phrasing such as:
  Find...
  Verify...
  Compare...
  Check latest...
  Identify current...
  Review recent...
- Include freshness-sensitive checks whenever information may have changed recently.
- Prefer official documentation as primary research targets.
- Include secondary/community-source validation when consensus or real-world experience matters.
- Focus only on WHAT must be researched, not HOW to implement it.
- Do NOT include:
  - Styling or UI guidance
  - Folder/code structure
  - Generic React/TypeScript/Next.js advice
  - Anything derivable from the existing codebase
  - Pure implementation tasks that do not need web research

If the task requires no external or current-world information, return an empty string for researchGoal.

Task: "{TASK}"

Return JSON only:
{"researchGoal":"1) ... 2) ... 3) ..."}
`;

const FILE_GOAL_PROMPT = `
You plan tasks for a file-exploration sub-agent operating only inside a sandboxed repository.

Given a user task, return a numbered checklist of atomic file exploration goals the agent must verify before implementation.

Include only goals to:
- Identify relevant files, modules, routes, configs, schemas, migrations, entry points
- Find existing patterns, similar implementations, imports, dependencies, utilities, services, models
- Verify folder structure, naming conventions, data flow, business logic, integration points
- Check configs, env usage, tests, examples, and files likely impacted

Rules:
- Goals must be specific, repository-searchable, and independently verifiable
- Use action verbs: Identify, Locate, Inspect, Verify, Check
- Focus on what to discover from files, not how to implement
- No coding steps
- No creating new code
- No web/external research
- Avoid vague goals like "review relevant files"

If no file exploration is needed, return:
{"fileGoal":""}

Task: "{TASK}"

Return JSON only:
{"fileGoal":"1) ... 2) ... 3) ..."}
`;

async function generateSubAgentGoals(
  taskDescription: string,
  needsResearch: boolean,
  needsFileExploration: boolean,
  ctx: AgentRunnerContext,
): Promise<SubAgentGoals> {
  const { client, model, provider } = await createSubAgentLLMClient({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    provider: ctx.provider,
  });

  const makeRequest = async (prompt: string) => {
    const requestParams: any = {
      model,
      messages: [
        { role: "user", content: prompt.replace("{TASK}", taskDescription.slice(0, 500)) },
      ],
      temperature: 0,
      max_completion_tokens: 250,
    };
    if (provider === "QWEN_DASHSCOPE") {
      requestParams.extra_body = { enable_thinking: false };
    }
    const res = await client.chat.completions.create(requestParams, { signal: ctx.signal });
    const raw = (res.choices[0]?.message?.content ?? "{}")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    return JSON.parse(raw);
  };

  const goals: SubAgentGoals = {};

  await Promise.allSettled([
    needsResearch
      ? makeRequest(RESEARCH_GOAL_PROMPT)
          .then((p) => {
            goals.researchGoal =
              p.researchGoal ||
              `Find all external docs, APIs, and content needed for: ${taskDescription.slice(0, 200)}`;
          })
          .catch(() => {
            goals.researchGoal = `Find all external docs, APIs, and content needed for: ${taskDescription.slice(0, 200)}`;
          })
      : Promise.resolve(),

    needsFileExploration
      ? makeRequest(FILE_GOAL_PROMPT)
          .then((p) => {
            goals.fileGoal =
              p.fileGoal ||
              `Identify all codebase files and patterns relevant to: ${taskDescription.slice(0, 200)}`;
          })
          .catch(() => {
            goals.fileGoal = `Identify all codebase files and patterns relevant to: ${taskDescription.slice(0, 200)}`;
          })
      : Promise.resolve(),
  ]);

  return goals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runOrchestrator(
  ctx: AgentRunnerContext,
  multiAgentEnabled: boolean,
  emit: (eventName: string, payload: Record<string, unknown>) => void,
): Promise<{
  success: boolean;
  summary: string;
  port?: number;
  backendPort?: number;
  modifiedFiles?: string[];
}> {
  if (!multiAgentEnabled) {
    return runAgent(ctx);
  }

  const todo = await todoService.getCurrentTodo(ctx.workspaceId);
  const taskDescription = todo
    ? `${todo.title}\n${todo.description ?? ""}`.trim()
    : (ctx.projectIdea ?? "Implement the requested feature");

  // ── Plan mode: research only — file agent does not run ────────────────────
  // The planner needs external API/library context from the web, but reading
  // the codebase at plan time is premature — there's nothing to explore yet
  // (or it's a new project scaffold). The main coding agent handles codebase
  // awareness when it executes the plan tasks.
  if (ctx.planMode) {
    const decision: ClassifierDecision = {
      needsResearch: true,
      needsFileExploration: false,
      reason: "plan mode — web research gathered before writing plan.md; file exploration skipped",
    };
    console.log(`[OrchestratorRunner] Plan mode: research only (no file agent)`);
    emit("AGENT_EVENT", {
      eventType: "CLASSIFIER_DECISION",
      message: "Plan mode: gathering research before planning…",
      data: decision,
    });
    return runMultiAgent(ctx, emit, taskDescription, decision);
  }

  // ── Initial project start: always run file agent immediately ──────────────
  // On the very first agent run after a project is set up, the file agent
  // maps the scaffold so the coding agent understands what already exists.
  if (ctx.isInitialSetup) {
    console.log(`[OrchestratorRunner] Initial setup: forcing file exploration only, skipping research`);
    const decision: ClassifierDecision = {
      needsResearch: false,
      needsFileExploration: true,
      reason: "initial project run — file exploration only; research skipped during setup",
    };
    emit("AGENT_EVENT", {
      eventType: "CLASSIFIER_DECISION",
      message: "Initial setup: file exploration only",
      data: decision,
    });
    return runMultiAgent(ctx, emit, taskDescription, decision);
  }

  // ── Standard mode: classify the task ──────────────────────────────────────
  console.log(`[OrchestratorRunner] Classifying: "${taskDescription.slice(0, 100)}"`);
  const decision = await classifyTask(taskDescription, ctx);

  console.log(
    `[OrchestratorRunner] → needsResearch=${decision.needsResearch} ` +
      `needsFileExploration=${decision.needsFileExploration} | ${decision.reason}`,
  );

  const activeAgents = [
    decision.needsResearch && "researcher",
    decision.needsFileExploration && "file",
  ].filter(Boolean);

  emit("AGENT_EVENT", {
    eventType: "CLASSIFIER_DECISION",
    message: activeAgents.length
      ? `Multi-agent (${activeAgents.join(" + ")}): ${decision.reason}`
      : `Single-agent: ${decision.reason}`,
    data: {
      needsResearch: decision.needsResearch,
      needsFileExploration: decision.needsFileExploration,
      reason: decision.reason,
    },
  });

  if (!decision.needsResearch && !decision.needsFileExploration) {
    return runAgent(ctx);
  }

  return runMultiAgent(ctx, emit, taskDescription, decision);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-agent path — only spawns the agents that are actually needed
// ─────────────────────────────────────────────────────────────────────────────

async function runMultiAgent(
  ctx: AgentRunnerContext,
  emit: (eventName: string, payload: Record<string, unknown>) => void,
  taskDescription: string,
  decision: ClassifierDecision,
) {
  const { workspaceId, sandboxId, userId, provider, signal } = ctx;
  const { needsResearch, needsFileExploration } = decision;

  console.log(
    `[OrchestratorRunner] Multi-agent. needsResearch=${needsResearch} needsFileExploration=${needsFileExploration}`,
  );

  // ── GOAL GENERATION (only for agents that will run) ───────────────────
  emit("AGENT_EVENT", {
    eventType: "SUBAGENT_PLANNING",
    message: "Generating goals for sub-agents…",
  });

  const goals = await generateSubAgentGoals(
    taskDescription,
    needsResearch,
    needsFileExploration,
    ctx,
  );

  if (goals.researchGoal)
    console.log(`[OrchestratorRunner] Research goal: ${goals.researchGoal.slice(0, 100)}`);
  if (goals.fileGoal)
    console.log(`[OrchestratorRunner] File goal:     ${goals.fileGoal.slice(0, 100)}`);

  emit("AGENT_EVENT", {
    eventType: "SUBAGENT_GOALS_READY",
    message: "Goals defined. Spawning agents…",
    data: {
      ...(goals.researchGoal && { researchGoal: goals.researchGoal }),
      ...(goals.fileGoal && { fileGoal: goals.fileGoal }),
    },
  });

  const subCtx: Omit<SubAgentContext, "goal"> = {
    workspaceId,
    sandboxId,
    signal: signal ?? new AbortController().signal,
    userId,
    provider,
    emit,
    usageAccumulator: ctx.usageAccumulator,
  };

  const researchTask = [
    `Research ONLY external information needed to build: ${taskDescription}`,
    "",
    "CRITICAL RULES:",
    "- Scope: named external service APIs/SDKs (endpoints, auth, install steps, config keys), real-world domain content (facts, data, events, regulations), and genuinely unfamiliar third-party packages.",
    "- NEVER search for: Next.js, React, Tailwind, CSS, TypeScript, JavaScript patterns, shadcn/ui, Radix, or any standard web framework topic — the main coding agent handles all of that.",
    "- If the task says 'any one of', 'some', 'a trending topic', or similar — pick exactly ONE specific item and research only that in depth. Do NOT return a list.",
    "- Do NOT suggest using live/public APIs to fetch data at runtime. All content must be static and hardcoded.",
    "- Return concrete content (real names, real facts, real details) about the ONE specific thing you chose.",
  ].join("\n");

  const fileTask = `Explore the workspace file structure and understand the existing codebase relevant to: ${taskDescription}`;

  // ── PARALLEL SPAWN — only needed agents ──────────────────────────────
  const activeAgentNames = [needsResearch && "researcher", needsFileExploration && "file"].filter(
    Boolean,
  );

  emit("AGENT_EVENT", {
    eventType: "SUBAGENT_START",
    message: `Starting: ${activeAgentNames.join(" + ")} agent(s)…`,
    data: { agents: activeAgentNames },
  });

  const [researcherSettled, fileSettled] = await Promise.allSettled([
    needsResearch
      ? runResearcherAgent(researchTask, { ...subCtx, goal: goals.researchGoal! })
      : Promise.resolve(null),
    needsFileExploration
      ? runFileAgent(fileTask, { ...subCtx, goal: goals.fileGoal! })
      : Promise.resolve(null),
  ]);

  const fallback = (kind: "researcher" | "file", task: string): SubAgentResult => ({
    agent: kind,
    task,
    report: "",
    tokensUsed: 0,
    durationMs: 0,
  });

  const researcher: SubAgentResult =
    researcherSettled.status === "fulfilled" && researcherSettled.value !== null
      ? researcherSettled.value
      : needsResearch
        ? (console.error(
            "[OrchestratorRunner] ResearcherAgent failed:",
            (researcherSettled as PromiseRejectedResult).reason,
          ),
          fallback("researcher", researchTask))
        : fallback("researcher", researchTask);

  const file: SubAgentResult =
    fileSettled.status === "fulfilled" && fileSettled.value !== null
      ? fileSettled.value
      : needsFileExploration
        ? (console.error(
            "[OrchestratorRunner] FileAgent failed:",
            (fileSettled as PromiseRejectedResult).reason,
          ),
          fallback("file", fileTask))
        : fallback("file", fileTask);

  // ── PERSIST SUB-AGENT SUMMARY ─────────────────────────────────────────
  const agentSummaries = [
    ...(needsResearch
      ? [
          {
            name: "researcher" as const,
            displayName: "Research Agent",
            logs: researcher.logs ?? [],
            isComplete: true,
          },
        ]
      : []),
    ...(needsFileExploration
      ? [
          {
            name: "file" as const,
            displayName: "File Agent",
            logs: file.logs ?? [],
            isComplete: true,
          },
        ]
      : []),
  ];
  if (agentSummaries.length > 0) {
    try {
      const anchorMessage = await messageService.createMessage({
        workspaceId,
        role: "system" as any,
        content: JSON.stringify({
          type: "SUB_AGENT_SUMMARY",
          agents: agentSummaries.map((a) => ({ name: a.name, displayName: a.displayName })),
        }),
      });
      await agentLogService.bulkCreate(anchorMessage.id, workspaceId, agentSummaries);
    } catch (err: unknown) {
      console.error("[OrchestratorRunner] Failed to save sub-agent summary:", err);
    }
  }

  // ── SYNTHESIS ─────────────────────────────────────────────────────────
  console.log("[OrchestratorRunner] Sub-agents done. Synthesizing…");

  emit("AGENT_EVENT", {
    eventType: "SYNTHESIS_STARTED",
    message: "Agents finished. Synthesizing context for main agent…",
  });

  const contextBlock = await synthesizeReports(researcher, file, taskDescription, {
    userId,
    workspaceId,
    provider,
    signal,
  });

  emit("AGENT_EVENT", {
    eventType: "SYNTHESIS_READY",
    message: "Context ready. Handing off to main agent…",
  });

  // ── INJECT CONTEXT ───────────────────────────────────────────────────
  await messageService.createMessage({
    workspaceId,
    role: "user",
    content: [
      "## Pre-Gathered Context (Multi-Agent Mode)",
      "",
      contextBlock,
      "",
      "---",
      "INSTRUCTIONS FOR MAIN AGENT:",
      "- Use the context above directly. Do not repeat web searches or file explorations.",
      "- If a specific topic/story/item was selected (look for 'Selected topic:'), build ONLY for that one — not a list, not a generic page.",
      "- Do NOT use any public/external APIs, fetch calls, or runtime data fetching. Hardcode all content as static data.",
    ].join("\n"),
  });

  console.log("[OrchestratorRunner] Handing off to main agent…");
  return runAgent(ctx);
}
