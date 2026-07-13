export type Task = "chat" | "interview" | "code" | "summary" | "analysis";

export interface ModelConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export function getModelConfig(task: Task, provider: 'OPENAI' | 'QWEN_DASHSCOPE' | 'GROQ' | 'ANTHROPIC' | 'GEMINI' = 'QWEN_DASHSCOPE'): ModelConfig {
  const base = { temperature: task === "analysis" ? 0.2 : 0.7, maxTokens: 2000 };
  switch (provider) {
    case 'QWEN_DASHSCOPE':
      return { model: "qwen3.6-plus", ...base };
    case 'GROQ':
      return { model: "llama-3.3-70b-versatile", ...base };
    case 'ANTHROPIC':
      // claude-opus-4-6 supports up to 32k output tokens; use 16k so long tool call
      // payloads (e.g. plan.md content) are never truncated mid-argument.
      return { model: "claude-opus-4-6", temperature: base.temperature, maxTokens: 16000 };
    case 'GEMINI':
      return { model: "gemini-1.5-flash", ...base };
    case 'OPENAI':
    default:
      return { model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.5", ...base };
  }
}

// Determine the appropriate task type based on context
function getTaskType(context?: {
  framework?: string;
  taskType?: string;
  description?: string;
}): Task {
  console.log("[ModelSelector] Determining model config ");
  if (context?.taskType) {
    if (
      context.taskType.includes("code") ||
      context.taskType.includes("implement") ||
      context.taskType.includes("develop")
    ) {
      return "code";
    } else if (context.taskType.includes("interview")) {
      return "interview";
    } else if (context.taskType.includes("analyze") || context.taskType.includes("analysis")) {
      return "analysis";
    } else if (context.taskType.includes("summarize") || context.taskType.includes("summary")) {
      return "summary";
    }
  }

  // Check description for clues
  if (context?.description) {
    const desc = context.description.toLowerCase();
    if (
      desc.includes("code") ||
      desc.includes("implement") ||
      desc.includes("develop") ||
      desc.includes("create")
    ) {
      return "code";
    } else if (desc.includes("interview")) {
      return "interview";
    } else if (desc.includes("analyze") || desc.includes("analysis")) {
      return "analysis";
    } else if (desc.includes("summarize") || desc.includes("summary")) {
      return "summary";
    }
  }

  // Default to code for the agent since it primarily writes code
  return "code";
}

// Get model configuration based on context
export function getModelConfigForAgent(context?: {
  framework?: string;
  taskType?: string;
  description?: string;
  provider?: 'OPENAI' | 'QWEN_DASHSCOPE' | 'GROQ' | 'ANTHROPIC' | 'GEMINI';
}): ModelConfig {
  const task = getTaskType(context);
  return getModelConfig(task, context?.provider || 'QWEN_DASHSCOPE');
}
