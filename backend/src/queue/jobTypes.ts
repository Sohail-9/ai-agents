/** Typed payloads for every BullMQ job kind */

export type LLMProvider = "OPENAI" | "QWEN_DASHSCOPE" | "GROQ" | "ANTHROPIC" | "GEMINI";

/** Forwarded WebSocket meta so workers can tag pub/sub events */
export interface JobMeta {
  requestId: string;
  workspaceId?: string;
  userId?: string;
}

// ─────────────────────────────────────────────────────────
// Agent run
// ─────────────────────────────────────────────────────────
export interface AgentJobPayload {
  workspaceId: string;
  sandboxId: string;
  todoId: string;
  userId?: string;
  provider?: LLMProvider;
  framework?: string;
  templateId?: string;
  projectIdea?: string;
  commitMessage?: string;
  overrideSystemPrompt?: string;
  planMode?: boolean;
  multiAgent?: boolean;
  isInitialSetup?: boolean;
  needsPlan?: boolean; // signals worker must run ai.planUpdate() before runOrchestrator()
  meta: JobMeta;
}

// ─────────────────────────────────────────────────────────
// New workspace setup  (AI analysis → sandbox → todos → agent)
// ─────────────────────────────────────────────────────────
export interface WorkspaceSetupPayload {
  workspaceId: string;
  idea: string;
  framework: string;
  language: string;
  database: string;
  databaseName?: string;
  databaseUrl?: string;
  databaseRequired?: boolean;
  planMode?: boolean;
  multiAgent?: boolean;
  userId?: string;
  sessionId: string;
  requestId?: string;
  imageIds?: string[];
  cachedAiResponse?: { contextContent?: string; contextPayload?: Record<string, unknown> };
  meta: JobMeta;
}

// ─────────────────────────────────────────────────────────
// GitHub import setup
// ─────────────────────────────────────────────────────────
export interface GitHubImportPayload {
  workspaceId: string;
  userId?: string;
  sessionId: string;
  userQuery?: string; // User's message/request for what to do with the repo
  meta: JobMeta;
}

// ─────────────────────────────────────────────────────────
// GitHub sync  (best-effort background mirror to GitHub)
// ─────────────────────────────────────────────────────────
export interface GitHubSyncPayload {
  workspaceId: string;
  triggeredAt: number;
}

export interface GitHubConnectPayload {
  workspaceId: string;
  clerkUserId: string;
  repoName: string;
  accessToken: string;
}
