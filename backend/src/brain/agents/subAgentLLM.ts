import OpenAI from "openai";

type ProviderName = "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";

const SUBAGENT_PREFERRED: ProviderName[] = ["QWEN_DASHSCOPE", "GROQ"];

function getEnvKey(p: ProviderName): string | null {
  if (p === "OPENAI") return process.env.OPENAI_API_KEY || null;
  if (p === "QWEN_DASHSCOPE") return process.env.DASHSCOPE_API_KEY || process.env.QWEN_DASHSCOPE || null;
  if (p === "GROQ") return process.env.GROQ_API_KEY || null;
  return null;
}

function getBaseURL(p: ProviderName): string {
  if (p === "QWEN_DASHSCOPE")
    return process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  if (p === "GROQ") return process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
  return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
}

function getSubAgentModel(p: ProviderName, kind: "researcher" | "file" = "file"): string {
  const override = process.env.SUBAGENT_MODEL;
  if (override) return override;
  if (kind === "researcher") {
    if (p === "QWEN_DASHSCOPE") return "qwen-max";
    if (p === "GROQ") return "llama-3.3-70b-versatile";
    return "qwen-max";
  }
  if (p === "QWEN_DASHSCOPE") return "qwen-plus";
  if (p === "GROQ") return "llama-3.3-70b-versatile";
  return "qwen-plus";
}

export interface SubAgentLLMClient {
  client: OpenAI;
  provider: ProviderName;
  model: string;
}

export async function createSubAgentLLMClient(opts: {
  userId?: string;
  workspaceId?: string;
  provider?: ProviderName;
  kind?: "researcher" | "file";
}): Promise<SubAgentLLMClient> {
  for (const p of SUBAGENT_PREFERRED) {
    const key = getEnvKey(p);
    if (key) {
      return {
        client: new OpenAI({ apiKey: key, baseURL: getBaseURL(p) }),
        provider: p,
        model: getSubAgentModel(p, opts.kind),
      };
    }
  }
  throw new Error("No sub-agent API key available. Configure DASHSCOPE_API_KEY or GROQ_API_KEY.");
}
