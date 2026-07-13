import { SubAgentResult } from "./subAgentTypes";
import { createSubAgentLLMClient } from "./subAgentLLM";

const MAX_CONTEXT_CHARS = 12_000; // ~3000 tokens hard cap

const SYSTEM_PROMPT = `You are a context synthesis engine for a coding AI assistant.
You receive two specialist reports — one from a web research agent and one from a file-exploration agent.
Merge them into a single, focused "AGENT CONTEXT" block the main coding agent will use before it starts working.

Rules:
- Resolve contradictions between reports (surface both sides if genuinely conflicting)
- Keep only information directly relevant to the user's task
- Structure with clear markdown sections and bullet points
- Hard limit: 3000 tokens maximum
- Start your output directly with "## AGENT CONTEXT" — no preamble, no meta-commentary

DECISIVENESS RULES (critical):
- If the research report contains multiple options or a list of choices (e.g. several news stories, several topics), YOU must pick exactly ONE and include only that one in the context block. State clearly: "Selected topic: <name>". Do not pass a list to the main agent.
- If the task involves content that could be fetched via a public/live API, instruct the main agent to hardcode the content as static data — do NOT suggest using any external API, fetch call, or runtime data source. All content must be embedded directly in the code.`;

export async function synthesizeReports(
  researcher: SubAgentResult,
  file: SubAgentResult,
  userTask: string,
  opts: {
    userId?: string;
    workspaceId?: string;
    provider?: "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";
    signal?: AbortSignal;
  },
): Promise<string> {
  console.log(`[SynthesisNode] Merging researcher + file reports for task: ${userTask.slice(0, 80)}`);

  const { client, model, provider } = await createSubAgentLLMClient({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    provider: opts.provider,
  });

  const userPrompt = [
    `Original user task:\n${userTask}`,
    "",
    "## Research Agent Report",
    researcher.report || "(researcher agent timed out or produced no output)",
    "",
    "## File Exploration Report",
    file.report || "(file agent timed out or produced no output)",
  ].join("\n");

  const requestParams: any = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_completion_tokens: 3000,
  };

  if (provider === "QWEN_DASHSCOPE") {
    requestParams.extra_body = { enable_thinking: false };
  }

  let contextBlock = "## AGENT CONTEXT\n(synthesis failed — proceeding without pre-gathered context)";

  try {
    const response = await client.chat.completions.create(requestParams, {
      signal: opts.signal,
    });
    contextBlock = response.choices[0]?.message?.content ?? contextBlock;
  } catch (err: any) {
    console.error(`[SynthesisNode] LLM call failed: ${err.message}`);
  }

  // Hard truncate
  if (contextBlock.length > MAX_CONTEXT_CHARS) {
    contextBlock = contextBlock.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated by synthesis node]";
  }

  console.log(`[SynthesisNode] Context block ready (${contextBlock.length} chars)`);
  return contextBlock;
}
