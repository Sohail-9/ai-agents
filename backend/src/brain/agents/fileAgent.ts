import OpenAI from "openai";
import { SubAgentContext, SubAgentResult, SubAgentLogEntry } from "./subAgentTypes";
import { read_file } from "../../skills/file_operations/read_file";
import { search_code } from "../../skills/code_intelligence/search_code";
import { execute_shell } from "../../skills/shell/execute_shell";
import { createSubAgentLLMClient } from "./subAgentLLM";

const MAX_ITERATIONS = 25;
const COMPLETION_MARKER = "FILE_COMPLETE";
const READONLY_PREFIXES = ["ls", "find", "cat", "grep", "head", "tail", "wc", "tree", "stat", "file", "pwd", "echo"];

function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase();
  return READONLY_PREFIXES.some(
    (r) => c === r || c.startsWith(r + " ") || c.startsWith(r + "\t"),
  );
}

function buildSystemPrompt(goal: string): string {
  return `You are a file exploration specialist working as part of a multi-agent coding assistant.
Your ONLY job is to explore the sandbox file system and return a structured report of relevant files and code patterns.

YOUR GOAL (you must fully satisfy every item before completing):
${goal}

Rules:
- Use read_file to inspect file contents
- Use search_code to locate patterns, imports, and definitions
- Use execute_shell ONLY for read-only commands: ls, find, cat, grep, head, tail, wc, tree, stat, file, pwd, echo
- Do NOT modify any files
- Do NOT start servers, install packages, or run write operations
- LOOP RULE: Before outputting ${COMPLETION_MARKER}, verify every item in your goal is satisfied.
  If any item is missing, continue exploring until it is found.
- When ALL goal items are satisfied, output the exact text ${COMPLETION_MARKER} on its own line,
  followed immediately by your report (markdown, under 2000 words, with clear sections)`;
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file at an absolute path in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path e.g. /workspace/src/App.tsx" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search for a text pattern or regex across files in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          directory: { type: "string", description: "Root directory. Default: /workspace" },
          isRegex: { type: "boolean" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_shell",
      description: "Read-only shell commands only: ls, find, cat, grep, head, tail, wc, tree, stat, file, pwd, echo.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
];

export async function runFileAgent(
  task: string,
  ctx: SubAgentContext,
): Promise<SubAgentResult> {
  const start = Date.now();
  let totalTokens = 0;
  console.log(`[File Agent] Starting. Goal: ${ctx.goal.slice(0, 200)}`);

  let report = "";
  const collectedLogs: SubAgentLogEntry[] = [];
  const MAX_STORED_LOGS = 40;

  const pushLog = (type: SubAgentLogEntry["type"], message: string, tool?: string) => {
    if (collectedLogs.length >= MAX_STORED_LOGS) collectedLogs.shift();
    collectedLogs.push({ type, message, tool, timestamp: Date.now() });
  };

  ctx.emit("AGENT_EVENT", {
    eventType: "SUBAGENT_GOAL",
    message: `GOAL: "${ctx.goal}"`,
    data: { agent: "file", goal: ctx.goal },
  });
  pushLog("goal", `GOAL: "${ctx.goal}"`);

  const { client, model, provider } = await createSubAgentLLMClient({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    provider: ctx.provider,
    kind: "file",
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(ctx.goal) },
    { role: "user", content: `File exploration task: ${task}` },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (ctx.signal.aborted) break;

    console.log(`[File Agent] Iteration ${iteration + 1}/${MAX_ITERATIONS}`);

    ctx.emit("AGENT_EVENT", {
      eventType: "SUBAGENT_THINKING",
      message: `[File Agent] Iteration ${iteration + 1} — exploring codebase…`,
      data: { agent: "file", iteration: iteration + 1 },
    });
    pushLog("thinking", `[File Agent] Iteration ${iteration + 1} — exploring codebase…`);

    const requestParams: any = {
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.2,
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
      console.log(`[File Agent] Goal achieved at iteration ${iteration + 1}`);

      ctx.emit("AGENT_EVENT", {
        eventType: "SUBAGENT_COMPLETE",
        message: `[File Agent] Goal achieved after ${iteration + 1} iteration(s)`,
        data: { agent: "file", iterations: iteration + 1, tokensUsed: totalTokens },
      });
      pushLog("complete", `[File Agent] Goal achieved after ${iteration + 1} iteration(s)`);
      break;
    }

    if (toolCalls.length > 0) {
      messages.push({ role: "assistant", content: assistantContent || null, tool_calls: toolCalls } as any);

      for (const tc of toolCalls) {
        if (ctx.signal.aborted) break;
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }

        const toolName = tc.function.name;

        // ── Emit tool started ──────────────────────────────────────────
        const toolInput = toolName === "read_file" ? args.path
          : toolName === "search_code" ? args.query
          : args.command;
        ctx.emit("AGENT_EVENT", {
          eventType: "TOOL_STARTED",
          message: `[File Agent] ${toolName}: ${String(toolInput ?? "").slice(0, 120)}`,
          toolCall: toolName,
          data: { tool: toolName, args, agent: "file" },
        });
        pushLog("tool_started", `[File Agent] ${toolName}: ${String(toolInput ?? "").slice(0, 120)}`, toolName);

        let resultContent = "";

        if (toolName === "read_file") {
          console.log(`[File Agent]-[read_file] path=${args.path}`);
          const result = await read_file({ path: args.path, sandboxId: ctx.sandboxId });
          resultContent = result.success ? (result.output ?? "") : `Error: ${result.error}`;
        } else if (toolName === "search_code") {
          console.log(`[File Agent]-[search_code] query="${args.query}"`);
          const result = await search_code({
            query: args.query,
            directory: args.directory,
            isRegex: args.isRegex,
            sandboxId: ctx.sandboxId,
          });
          resultContent = result.success ? (result.output ?? "") : `Error: ${result.error}`;
        } else if (toolName === "execute_shell") {
          const cmd: string = args.command ?? "";
          if (!isReadOnlyCommand(cmd)) {
            console.log(`[File Agent]-[execute_shell] BLOCKED: ${cmd}`);
            resultContent = `BLOCKED: Only read-only commands allowed. Received: "${cmd}"`;
          } else {
            console.log(`[File Agent]-[execute_shell] cmd=${cmd}`);
            const result = await execute_shell({ command: cmd, sandboxId: ctx.sandboxId });
            resultContent = result.success ? (result.output ?? "") : `Error: ${result.error}`;
          }
        } else {
          resultContent = `Unknown tool: ${toolName}`;
        }

        // ── Emit tool completed ────────────────────────────────────────
        ctx.emit("AGENT_EVENT", {
          eventType: "TOOL_COMPLETED",
          message: `[File Agent] ${toolName} completed`,
          toolCall: toolName,
          data: {
            tool: toolName,
            command: toolName,
            output: resultContent.slice(0, 300),
            agent: "file",
          },
        });
        pushLog("tool_completed", `[File Agent] ${toolName} completed`, toolName);

        messages.push({ role: "tool", tool_call_id: tc.id, content: resultContent } as any);
      }
    } else {
      report = assistantContent;
      console.log(`[File Agent] No tool calls — treating response as final report`);

      ctx.emit("AGENT_EVENT", {
        eventType: "SUBAGENT_COMPLETE",
        message: `[File Agent] Completed (no further tool calls)`,
        data: { agent: "file", iterations: iteration + 1, tokensUsed: totalTokens },
      });
      pushLog("complete", `[File Agent] Completed (no further tool calls)`);
      break;
    }
  }

  if (!report) {
    report = "File agent reached iteration limit without completing the goal.";
    ctx.emit("AGENT_EVENT", {
      eventType: "SUBAGENT_COMPLETE",
      message: `[File Agent] Hit iteration limit (${MAX_ITERATIONS}) — partial report returned`,
      data: { agent: "file", iterations: MAX_ITERATIONS, tokensUsed: totalTokens },
    });
    pushLog("complete", `[File Agent] Hit iteration limit (${MAX_ITERATIONS}) — partial report returned`);
  }

  const durationMs = Date.now() - start;
  console.log(`[File Agent] Done in ${durationMs}ms. tokens=${totalTokens}`);
  return { agent: "file", task, report, tokensUsed: totalTokens, durationMs, logs: collectedLogs };
}
