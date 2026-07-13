import OpenAI from "openai";
import "../env";
import { getAzureConfig } from "./tiers";

function getIntentClient(): { client: OpenAI; model: string } {
  // Prefer Azure/OpenAI for classification — better JSON fidelity. Fall back to Qwen.
  const azure = getAzureConfig();
  if (azure) {
    return {
      client: new OpenAI({
        apiKey: azure.apiKey,
        baseURL: azure.baseURL,
        defaultQuery: azure.defaultQuery,
        defaultHeaders: azure.defaultHeaders,
      }),
      model: azure.model,
    };
  }
  const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
  if (!qwenKey) throw new Error("No API key available for intent classification");
  return {
    client: new OpenAI({ apiKey: qwenKey, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }),
    model: "qwen-turbo",
  };
}

/**
 * Keyword-based fallback classifier. Conservative: defaults to "implementation"
 * only when strong imperative verbs are present, otherwise "conversational".
 */
function heuristicClassify(query: string): "conversational" | "implementation" {
  const q = query.toLowerCase().trim();

  // Strong signals for informational/state-retrieval queries
  const questionStarters = [
    "is ",
    "are ",
    "was ",
    "were ",
    "has ",
    "have ",
    "does ",
    "do ",
    "did ",
    "can ",
    "could ",
    "will ",
    "would ",
    "should ",
    "what ",
    "where ",
    "when ",
    "why ",
    "who ",
    "which ",
    "how ",
    "explain ",
    "describe ",
    "tell me ",
    "show me what ",
    "do we ",
  ];
  if (questionStarters.some((s) => q.startsWith(s)) || q.endsWith("?")) {
    return "conversational";
  }

  // Strong signals for implementation queries
  const implicitStarters = [
    "add ",
    "create ",
    "build ",
    "implement ",
    "fix ",
    "update ",
    "change ",
    "remove ",
    "delete ",
    "refactor ",
    "migrate ",
    "integrate ",
    "setup ",
    "configure ",
    "make ",
    "write ",
    "generate ",
    "deploy ",
    "install ",
    "optimize ",
    "redesign ",
    "rewrite ",
  ];
  if (implicitStarters.some((s) => q.startsWith(s))) {
    return "implementation";
  }

  // Default: if ambiguous, treat as conversational to avoid false plan triggers
  return "conversational";
}

/**
 * Extracts the 1–3 most meaningful keywords from a user query for targeted file search.
 */
export function extractQueryKeywords(query: string): string[] {
  const STOP_WORDS = new Set([
    "is",
    "are",
    "was",
    "were",
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "to",
    "do",
    "we",
    "i",
    "it",
    "of",
    "for",
    "and",
    "or",
    "but",
    "not",
    "with",
    "this",
    "that",
    "have",
    "has",
    "had",
    "be",
    "been",
    "will",
    "would",
    "can",
    "could",
    "should",
    "which",
    "where",
    "how",
    "what",
    "when",
    "who",
    "why",
    "currently",
    "implemented",
    "using",
    "our",
    "any",
    "there",
    "does",
    "did",
    "get",
    "use",
    "my",
    "your",
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3);
}

/**
 * LLM-based classification via Qwen-turbo.
 */
async function classifyViaLLM(query: string): Promise<"conversational" | "implementation"> {
  const { client, model } = getIntentClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Reply with exactly one word: conversational or implementation. conversational=question/inspection. implementation=build/change/fix request.",
      },
      { role: "user", content: query },
    ],
    max_completion_tokens: 5,
  });

  const raw = (response.choices[0]?.message?.content || "").trim().toLowerCase();
  return raw.startsWith("implementation") ? "implementation" : "conversational";
}

/**
 * Classifies a user query as "conversational" (informational question) or
 * "implementation" (work that needs planning and execution).
 *
 * Uses a fast Qwen-turbo call with 1.5s timeout. Falls back to heuristics on timeout/failure.
 */
export async function classifyPlanIntent(
  query: string,
): Promise<"conversational" | "implementation"> {
  const TIMEOUT_MS = 1200;

  // Race LLM call against a timeout; prefer heuristic over timeout
  const timeout = new Promise<"implementation">((resolve) =>
    setTimeout(() => resolve("implementation"), TIMEOUT_MS),
  );

  try {
    const intent = await Promise.race([classifyViaLLM(query), heuristicClassify(query), timeout]);
    console.log(`[PlanIntentClassifier] "${query.slice(0, 80)}" → ${intent}`);
    return intent;
  } catch (err) {
    const fallback = heuristicClassify(query);
    console.warn(
      `[PlanIntentClassifier] LLM failed (${(err as Error).message}), heuristic → ${fallback}`,
    );
    return fallback;
  }
}

/**
 * Answers an informational query using project context + relevant file snippets.
 * Lightweight — no sandbox agent, no planning, no todos.
 */
export async function answerConversationalQuery(
  query: string,
  projectContext: string,
  fileContext: string,
): Promise<string> {
  try {
    // Conversational answers use Qwen (longer context, cheaper for this task)
    const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE;
    const client = qwenKey
      ? new OpenAI({ apiKey: qwenKey, baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" })
      : getIntentClient().client;
    const response = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        {
          role: "system",
          content: `You are a technical assistant for a software project. Answer the user's question directly and concisely.

Rules:
- Be factual and specific to THIS project based on the code context provided
- Keep answers short and conversational (2–5 sentences max)
- If the context doesn't contain enough information to answer confidently, say so briefly
- Use inline \`code\` references when helpful (file names, class names, variable names)
- Do NOT suggest implementation steps, ask clarifying questions, or produce task lists

Project Description:
${projectContext || "No project description available."}

Relevant Code Context:
${fileContext || "No specific code context retrieved — answer based on project description only."}`,
        },
        { role: "user", content: query },
      ],
      max_completion_tokens: 600,
    });

    return (
      (response.choices[0]?.message?.content || "").trim() ||
      "I couldn't determine this from the available context. Please check the source code directly."
    );
  } catch (err) {
    console.error(
      "[PlanIntentClassifier] answerConversationalQuery failed:",
      (err as Error).message,
    );
    return "I couldn't retrieve an answer right now. Please check the relevant source files directly.";
  }
}
