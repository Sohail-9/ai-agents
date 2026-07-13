import OpenAI from "openai";
import {
  SubAgentContext,
  SubAgentResult,
  SubAgentLogEntry,
} from "./subAgentTypes";
import { web_search } from "../../skills/web/web_search";
import { fetch_url } from "../../skills/web/fetch_url";
import { createSubAgentLLMClient } from "./subAgentLLM";

const MAX_ITERATIONS = 20;
const COMPLETION_MARKER = "RESEARCH_COMPLETE";

function buildSystemPrompt(goal: string): string {
  return `You are a deep research specialist working as part of a multi-agent coding assistant.
Your job is to gather thorough, accurate information and return a structured markdown report.

YOUR GOAL (you must fully satisfy every item before completing):
${goal}

Workflow — use all tools available to you:
1. web_search  — broad queries to find relevant pages, docs, solutions
2. fetch_url   — retrieve the actual content of a specific page (docs, GitHub README, blog post, )
   - After a web search, identify the 1-3 most useful URLs and fetch them for deeper detail
   - Prefer official docs, GitHub repos, and authoritative sources
3. Synthesize everything into a single coherent report

Rules:
- Do NOT write application code or access codebase files
- Do NOT describe what you will do — just search, fetch, and synthesize
- STRICTLY OFF-LIMITS — never search for any of the following (the main coding agent handles all of these without web search):
  • Next.js: routing, server components, API routes, middleware, app directory, layouts, data fetching
  • React: hooks, context, state management, component patterns, event handling, lifecycle
  • Tailwind CSS or any CSS/styling: class names, responsive design, theming, animations
  • TypeScript or JavaScript: patterns, syntax, idioms, type definitions
  • shadcn/ui, Radix UI, or any component library usage
  • Standard web patterns: forms, validation, pagination, tables, modals, navigation, authentication flows
  • General coding decisions or architectural questions about the existing codebase
  • Any library or framework that is already well-known (React, Next.js, Express, Prisma, etc.)
- ONLY search for: named external services with APIs requiring auth/setup (Stripe, Pusher, Twilio, etc.), real-world/time-sensitive domain content (news, prices, events, regulations), and genuinely unfamiliar third-party packages not covered by common web development knowledge
- If a task mentions a named third-party service or API — fetch its official docs
- If you find multiple competing approaches, compare them briefly and recommend one
- Extract concrete details: version numbers, config keys, method signatures, endpoint paths, real content
- LOOP RULE: Before outputting ${COMPLETION_MARKER}, verify every item in your goal is satisfied.
  If any item is missing, continue searching and fetching until it is found.
- When ALL goal items are satisfied, output the exact text ${COMPLETION_MARKER} on its own line,
  followed immediately by your report (markdown, under 2500 words, with clear sections and code snippets where useful)`;
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for named external service APIs (Stripe, Twilio, Pusher, etc.), real-world domain content (news, prices, events, regulations), and genuinely unfamiliar third-party packages. Do NOT use for Next.js, React, Tailwind, CSS, TypeScript, shadcn/ui, or any standard web framework feature.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch and read the full content of a specific URL (docs page, GitHub README, API reference, blog post). Use this after web_search to get deeper detail from a specific source.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The full URL to fetch (must start with http:// or https://)",
          },
          max_chars: {
            type: "number",
            description: "Maximum characters to return (default 8000)",
          },
        },
        required: ["url"],
      },
    },
  },
];

export async function runResearcherAgent(
  task: string,
  ctx: SubAgentContext,
): Promise<SubAgentResult> {
  const start = Date.now();
  let totalTokens = 0;
  console.log(`[Research Agent] Starting. Goal: ${ctx.goal.slice(0, 200)}`);

  let report = "";
  const collectedLogs: SubAgentLogEntry[] = [];
  const MAX_STORED_LOGS = 40;

  const pushLog = (
    type: SubAgentLogEntry["type"],
    message: string,
    tool?: string,
  ) => {
    if (collectedLogs.length >= MAX_STORED_LOGS) collectedLogs.shift();
    collectedLogs.push({ type, message, tool, timestamp: Date.now() });
  };

  ctx.emit("AGENT_EVENT", {
    eventType: "SUBAGENT_GOAL",
    message: `GOAL: "${ctx.goal}"`,
    data: { agent: "researcher", goal: ctx.goal },
  });
  pushLog("goal", `GOAL: "${ctx.goal}"`);

  const { client, model, provider } = await createSubAgentLLMClient({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    provider: ctx.provider,
    kind: "researcher",
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(ctx.goal) },
    { role: "user", content: `Research task: ${task}` },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (ctx.signal.aborted) break;

    console.log(
      `[Research Agent] Iteration ${iteration + 1}/${MAX_ITERATIONS}`,
    );

    ctx.emit("AGENT_EVENT", {
      eventType: "SUBAGENT_THINKING",
      message: `[Research Agent] Iteration ${iteration + 1} — working toward goal…`,
      data: { agent: "researcher", iteration: iteration + 1 },
    });
    pushLog(
      "thinking",
      `[Research Agent] Iteration ${iteration + 1} — working toward goal…`,
    );

    const requestParams: any = {
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
    };

    if (provider === "QWEN_DASHSCOPE") {
      requestParams.extra_body = { enable_thinking: false };
    }

    const response = await client.chat.completions.create(requestParams, {
      signal: ctx.signal,
    });

    const choice = response.choices[0];
    const assistantContent = choice?.message?.content ?? "";
    const toolCalls: any[] = (choice?.message?.tool_calls as any[]) ?? [];

    const usageDelta = response.usage?.total_tokens ?? 0;
    totalTokens += usageDelta;
    if (ctx.usageAccumulator && usageDelta > 0) {
      ctx.usageAccumulator.push({
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: usageDelta,
        provider,
        mode: "intent",
      });
    }

    if (assistantContent.includes(COMPLETION_MARKER)) {
      const idx = assistantContent.indexOf(COMPLETION_MARKER);
      report = assistantContent.slice(idx + COMPLETION_MARKER.length).trim();
      console.log(
        `[Research Agent] Goal achieved at iteration ${iteration + 1}`,
      );

      ctx.emit("AGENT_EVENT", {
        eventType: "SUBAGENT_COMPLETE",
        message: `[Research Agent] Goal achieved after ${iteration + 1} iteration(s)`,
        data: {
          agent: "researcher",
          iterations: iteration + 1,
          tokensUsed: totalTokens,
        },
      });
      pushLog(
        "complete",
        `[Research Agent] Goal achieved after ${iteration + 1} iteration(s)`,
      );
      break;
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: toolCalls,
      } as any);

      for (const tc of toolCalls) {
        if (ctx.signal.aborted) break;
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* ignore */
        }

        const toolName = tc.function.name;

        // ── Emit tool started ──────────────────────────────────────────
        const toolInput = toolName === "web_search" ? args.query : args.url;
        ctx.emit("AGENT_EVENT", {
          eventType: "TOOL_STARTED",
          message: `[Research Agent] ${toolName}: ${String(toolInput).slice(0, 120)}`,
          toolCall: toolName,
          data: { tool: toolName, args, agent: "researcher" },
        });
        pushLog(
          "tool_started",
          `[Research Agent] ${toolName}: ${String(toolInput).slice(0, 120)}`,
          toolName,
        );

        let resultContent = "";

        if (toolName === "web_search") {
          console.log(`[Research Agent]-[web_search] query="${args.query}"`);
          const result = await web_search({ query: args.query ?? "" });
          resultContent = result.success
            ? (result.output ?? "")
            : `Error: ${result.error}`;
        } else if (toolName === "fetch_url") {
          console.log(`[Research Agent]-[fetch_url] url=${args.url}`);
          const result = await fetch_url({
            url: args.url ?? "",
            max_chars: args.max_chars,
          });
          resultContent = result.success
            ? (result.output ?? "")
            : `Error: ${result.error}`;
        } else {
          resultContent = `Unknown tool: ${toolName}`;
        }

        // ── Emit tool completed ────────────────────────────────────────
        ctx.emit("AGENT_EVENT", {
          eventType: "TOOL_COMPLETED",
          message: `[Research Agent] ${toolName} completed`,
          toolCall: toolName,
          data: {
            tool: toolName,
            command: toolName,
            output: resultContent.slice(0, 300),
            agent: "researcher",
          },
        });
        pushLog(
          "tool_completed",
          `[Research Agent] ${toolName} completed`,
          toolName,
        );

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        } as any);
      }
    } else {
      // No tool calls and no completion marker — treat as final report
      report = assistantContent;
      console.log(`[Research Agent] No tool calls — treating as final report`);

      ctx.emit("AGENT_EVENT", {
        eventType: "SUBAGENT_COMPLETE",
        message: `[Research Agent] Completed (no further tool calls)`,
        data: {
          agent: "researcher",
          iterations: iteration + 1,
          tokensUsed: totalTokens,
        },
      });
      pushLog("complete", `[Research Agent] Completed (no further tool calls)`);
      break;
    }
  }

  if (!report) {
    report =
      "Research agent reached iteration limit without completing the goal.";
    ctx.emit("AGENT_EVENT", {
      eventType: "SUBAGENT_COMPLETE",
      message: `[Research Agent] Hit iteration limit (${MAX_ITERATIONS}) — partial report returned`,
      data: {
        agent: "researcher",
        iterations: MAX_ITERATIONS,
        tokensUsed: totalTokens,
      },
    });
    pushLog(
      "complete",
      `[Research Agent] Hit iteration limit (${MAX_ITERATIONS}) — partial report returned`,
    );
  }

  const durationMs = Date.now() - start;
  console.log(
    `[Research Agent] Done in ${durationMs}ms. tokens=${totalTokens}`,
  );
  return {
    agent: "researcher",
    task,
    report,
    tokensUsed: totalTokens,
    durationMs,
    logs: collectedLogs,
  };
}
