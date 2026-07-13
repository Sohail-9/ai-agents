export interface UsageEntry {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  provider: string; // "QWEN_DASHSCOPE" | "OPENAI" | "ANTHROPIC" | etc.
  mode: string; // "intent" | "planning" | "build" | "tool_call"
}

export interface BillingJobPayload {
  userId: string;
  agentRunId: string;
  workspaceId: string;
  entries: UsageEntry[];
  reservedCredits: number;
}
