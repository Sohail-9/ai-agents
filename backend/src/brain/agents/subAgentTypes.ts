import type { UsageEntry } from "../../billing/types";

export type AgentKind = "researcher" | "file";

export interface SubAgentContext {
  workspaceId: string;
  sandboxId: string;
  signal: AbortSignal;
  userId?: string;
  provider?: "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";
  goal: string;
  emit: (eventName: string, payload: Record<string, unknown>) => void;
  usageAccumulator?: UsageEntry[];
}

export interface SubAgentLogEntry {
  type: "goal" | "thinking" | "tool_started" | "tool_completed" | "complete";
  message: string;
  tool?: string;
  timestamp: number;
}

export interface SubAgentResult {
  agent: AgentKind;
  task: string;
  report: string;
  tokensUsed: number;
  durationMs: number;
  logs?: SubAgentLogEntry[];
}

export interface SubAgentPlan {
  researchTask: string;
  fileTask: string;
}
