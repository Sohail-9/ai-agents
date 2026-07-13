export type UUID = string;

export type EventType =
  | "AUTH"
  | "AUTH_OK"
  | "PING"
  | "PONG"
  | "SYSTEM_ERROR"
  // Todo: client -> server
  | "TODO_CREATE"
  | "TODO_UPDATE"
  | "TODO_COMPLETE"
  | "TODO_DELETE"
  | "TODO_LIST"
  // Todo: server -> client
  | "TODO_CREATED"
  | "TODO_UPDATED"
  | "TODO_DELETED"
  | "TODO_LIST_RESULT"
  // AI Flow
  | "USER_REQUEST"
  | "REQUEST_CLARIFICATION"
  | "CLARIFICATION_RESPONSE"
  | "REQUEST_CONFIRMATION"
  | "CONFIRMATION_RESPONSE"
  | "REQUEST_ACCEPTED"
  // Agent (todo execution)
  | "AGENT_RUN"
  | "STOP_AGENT"
  | "AGENT_EVENT"
  | "AGENT_STREAM_START"
  | "AGENT_STREAM_CHUNK"
  | "AGENT_DONE"
  | "WORKSPACE_READY"
  | "WORKSPACE_STATE"
  | "WORKSPACE_ERROR"
  | "SANDBOX_RESUMING"
  | "SANDBOX_READY"
  | "CHAT_HISTORY"
  | "ENV_REQUIRED"
  // File operations
  | "FILE_TREE_REQUEST"
  | "FILE_CONTENT_REQUEST"
  | "FILE_TREE_RESPONSE"
  | "FILE_CONTENT_RESPONSE"
  // App
  | "CHAT_HISTORY_REQUEST"
  | "SETUP_PROGRESS"
  // Plan Mode
  | "PLAN_ANSWERS"
  | "PLAN_QUESTIONS"
  | "PLAN_READY"
  // Multi-Agent
  | "SUBAGENT_START"
  | "SYNTHESIS_READY"
  // Support Agent
  | "SUPPORT_AGENT_START"
  | "SUPPORT_AGENT_TOOL_CALL"
  | "SUPPORT_AGENT_TOKEN"
  | "SUPPORT_AGENT_DONE"
  | "SUPPORT_AGENT_ERROR"
  | "SUPPORT_CASE_STATUS";

export interface BaseMeta {
  requestId: UUID;
  userId?: string;
  workspaceId?: string;
  timestamp?: number;
}

export interface BaseEvent<T extends EventType, P> {
  type: T;
  payload: P;
  meta: BaseMeta;
}

export type SystemErrorEvent = BaseEvent<
  "SYSTEM_ERROR",
  { message: string; code?: string; details?: unknown }
>;

export type AuthEvent = {
  type: "AUTH";
  payload: { token?: string; userId?: string; workspaceId?: string };
  meta?: Partial<BaseMeta>;
};

export type AuthOkEvent = BaseEvent<"AUTH_OK", { userId?: string; workspaceId?: string }>;

export type PingEvent = BaseEvent<"PING", {}>;
export type PongEvent = BaseEvent<"PONG", {}>;

export type UserRequestEvent = BaseEvent<"USER_REQUEST", { message: string; planMode?: boolean; imageIds?: string[] }>;

// ── Plan Mode Events ──────────────────────────────────────────
export interface PlanOption {
  id: string;
  text: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  options: PlanOption[];
}

export type PlanQuestionsEvent = BaseEvent<
  "PLAN_QUESTIONS",
  { questions: PlanQuestion[]; summary?: string }
>;

export type PlanReadyEvent = BaseEvent<
  "PLAN_READY",
  { content: string; path: string }
>;

export type PlanAnswersEvent = BaseEvent<
  "PLAN_ANSWERS",
  { answers: Record<string, string> }
>;

export interface ClarificationQuestion {
  key: string;
  question: string;
}

export type RequestClarificationEvent = BaseEvent<
  "REQUEST_CLARIFICATION",
  { questions: ClarificationQuestion[] }
>;

export type ClarificationResponseEvent = BaseEvent<
  "CLARIFICATION_RESPONSE",
  { answers: Record<string, string> }
>;

export type RequestConfirmationEvent = BaseEvent<"REQUEST_CONFIRMATION", { summary: string }>;

export type ConfirmationResponseEvent = BaseEvent<
  "CONFIRMATION_RESPONSE",
  { confirmed: boolean; summary?: string }
>;

export type RequestAcceptedEvent = BaseEvent<"REQUEST_ACCEPTED", {}>;

export type AgentRunEvent = BaseEvent<
  "AGENT_RUN",
  { workspaceId?: string; sandboxId?: string; todoId?: string; multiAgent?: boolean }
>;
export type StopAgentEvent = BaseEvent<"STOP_AGENT", { workspaceId?: string }>;

export type AgentEventEvent = BaseEvent<
  "AGENT_EVENT",
  { eventType: string; message: string; data?: unknown }
>;

export type AgentStreamStartEvent = BaseEvent<
  "AGENT_STREAM_START",
  { messageId: string }
>;

export type AgentStreamChunkEvent = BaseEvent<
  "AGENT_STREAM_CHUNK",
  { messageId: string; text: string }
>;

export type AgentDoneEvent = BaseEvent<
  "AGENT_DONE",
  { success: boolean; summary: string; sandboxId?: string; port?: number }
>;

export type EnvRequiredEvent = BaseEvent<
  "ENV_REQUIRED",
  { keys: string[]; reason: string }
>;

export type TodoPriority = "low" | "medium" | "high";
export type TodoStatus = "open" | "completed";

export interface Todo {
  id: UUID;
  workspaceId: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority?: TodoPriority;
  dueAt?: number; // unix ms
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  updatedBy?: string;
}

export type TodoCreateEvent = BaseEvent<
  "TODO_CREATE",
  {
    workspaceId?: string;
    title: string;
    description?: string;
    priority?: TodoPriority;
    dueAt?: number;
  }
>;

export type TodoUpdateEvent = BaseEvent<
  "TODO_UPDATE",
  {
    workspaceId?: string;
    id: UUID;
    title?: string;
    description?: string;
    priority?: TodoPriority;
    dueAt?: number | null;
  }
>;

export type TodoCompleteEvent = BaseEvent<
  "TODO_COMPLETE",
  { workspaceId?: string; id: UUID; completed: boolean }
>;

export type TodoDeleteEvent = BaseEvent<"TODO_DELETE", { workspaceId?: string; id: UUID }>;

export type TodoListEvent = BaseEvent<"TODO_LIST", { workspaceId?: string; status?: TodoStatus }>;

export type TodoCreatedEvent = BaseEvent<"TODO_CREATED", { todo: Todo }>;
export type TodoUpdatedEvent = BaseEvent<"TODO_UPDATED", { todo: Todo }>;
export type TodoDeletedEvent = BaseEvent<"TODO_DELETED", { id: UUID; workspaceId: string }>;
export type TodoListResultEvent = BaseEvent<
  "TODO_LIST_RESULT",
  { todos: Todo[]; workspaceId: string }
>;

// ── Workspace Events ─────────────────────────────────────────────────

export type WorkspaceReadyEvent = BaseEvent<
  "WORKSPACE_READY",
  { workspaceId: string; sandboxId: string }
>;

export type WorkspaceErrorEvent = BaseEvent<
  "WORKSPACE_ERROR",
  { message: string }
>;

export type WorkspaceStateEvent = BaseEvent<
  "WORKSPACE_STATE",
  { workspaceId: string; sandboxId?: string; port?: number; status?: string }
>;

// ── File Events ──────────────────────────────────────────────────────

export type FileTreeRequestEvent = BaseEvent<
  "FILE_TREE_REQUEST",
  { sandboxId: string; directory?: string }
>;

export type FileContentRequestEvent = BaseEvent<
  "FILE_CONTENT_REQUEST",
  { sandboxId: string; path: string }
>;

export type FileTreeResponseEvent = BaseEvent<
  "FILE_TREE_RESPONSE",
  { files: any[]; directory: string; error?: string }
>;

export type FileContentResponseEvent = BaseEvent<
  "FILE_CONTENT_RESPONSE",
  { path: string; content: string; error?: string }
>;

export type ChatHistoryRequestEvent = BaseEvent<
  "CHAT_HISTORY_REQUEST",
  { workspaceId: string; cursor?: number; limit?: number }
>;

export type SetupProgressEvent = BaseEvent<
  "SETUP_PROGRESS",
  { message: string; submessage?: string; progress?: number }
>;

// ── Multi-Agent Events ───────────────────────────────────────────────────

export type SubAgentStartEvent = BaseEvent<
  "SUBAGENT_START",
  { agent: "researcher" | "file"; task: string }
>;

export type SynthesisReadyEvent = BaseEvent<
  "SYNTHESIS_READY",
  { summary: string }
>;

// ── Support Agent Events ─────────────────────────────────────────────────────

export type SupportAgentStartEvent = BaseEvent<"SUPPORT_AGENT_START", { caseId: string }>;
export type SupportAgentToolCallEvent = BaseEvent<
  "SUPPORT_AGENT_TOOL_CALL",
  { caseId: string; toolName: string; status: "calling" | "done" }
>;
export type SupportAgentTokenEvent = BaseEvent<"SUPPORT_AGENT_TOKEN", { caseId: string; token: string }>;
export type SupportAgentDoneEvent = BaseEvent<"SUPPORT_AGENT_DONE", { caseId: string }>;
export type SupportAgentErrorEvent = BaseEvent<"SUPPORT_AGENT_ERROR", { caseId: string; error: string }>;
export type SupportCaseStatusEvent = BaseEvent<"SUPPORT_CASE_STATUS", { caseId: string; status: string }>;

export type ClientToServerEvent =
  | AuthEvent
  | PingEvent
  | TodoCreateEvent
  | TodoUpdateEvent
  | TodoCompleteEvent
  | TodoDeleteEvent
  | TodoListEvent
  | UserRequestEvent
  | ClarificationResponseEvent
  | ConfirmationResponseEvent
  | AgentRunEvent
  | StopAgentEvent
  | FileTreeRequestEvent
  | FileContentRequestEvent
  | ChatHistoryRequestEvent
  | PlanAnswersEvent;

export type ServerToClientEvent =
  | AuthOkEvent
  | PongEvent
  | SystemErrorEvent
  | TodoCreatedEvent
  | TodoUpdatedEvent
  | TodoDeletedEvent
  | TodoListResultEvent
  | RequestClarificationEvent
  | RequestConfirmationEvent
  | RequestAcceptedEvent
  | AgentEventEvent
  | AgentStreamStartEvent
  | AgentStreamChunkEvent
  | AgentDoneEvent
  | WorkspaceReadyEvent
  | WorkspaceErrorEvent
  | EnvRequiredEvent
  | SetupProgressEvent
  | FileTreeResponseEvent
  | FileContentResponseEvent
  | PlanQuestionsEvent
  | PlanReadyEvent
  | SubAgentStartEvent
  | SynthesisReadyEvent
  | SupportAgentStartEvent
  | SupportAgentToolCallEvent
  | SupportAgentTokenEvent
  | SupportAgentDoneEvent
  | SupportAgentErrorEvent
  | SupportCaseStatusEvent;

export type WSEvent = ClientToServerEvent | ServerToClientEvent;

export function nowMs() {
  return Date.now();
}

export function ensureMeta(
  meta: Partial<BaseMeta> | undefined,
  fallbackRequestId: string,
): BaseMeta {
  return {
    requestId: meta?.requestId ?? fallbackRequestId,
    userId: meta?.userId,
    workspaceId: meta?.workspaceId,
    timestamp: meta?.timestamp ?? nowMs(),
  };
}

export function createEvent<T extends EventType, P>(
  type: T,
  payload: P,
  meta: BaseMeta,
): BaseEvent<T, P> {
  return { type, payload, meta };
}
