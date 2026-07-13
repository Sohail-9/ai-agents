export type ToolName =
  | "read_file"
  | "search_code"
  | "edit_file"
  | "context_save"
  | "execute_shell"
  | "check_health"
  | "todo_manager"
  | "web_search"
  | "fetch_url"
  | "request_env_vars"
  | "submit_plan_questions"
  | "env_manager"
  | "provision_database";

export type EditOperation = "overwrite" | "append" | "replace";

export type TodoAction = "get_current_todo" | "mark_todo_complete" | "list_pending_todos";

export interface ReadFileParams {
  path: string;
  sandboxId: string;
}

export interface SearchCodeParams {
  query: string;
  directory?: string;
  isRegex?: boolean;
  sandboxId: string;
}

export interface EditFileParams {
  path: string;
  operation: EditOperation;
  content?: string;
  find?: string;
  replace?: string;
  sandboxId: string;
}

export interface ContextSaveParams {
  key: string;
  data: string;
  sandboxId?: string;
}

export interface ExecuteShellParams {
  command: string;
  sandboxId: string;
  timeout_seconds?: number;
  background?: boolean;
}

export interface TodoManagerParams {
  action: TodoAction;
  workspaceId: string;
  todo_id?: string;
  notes?: string;
}

export interface WebSearchParams {
  query: string;
  max_results?: number;
}

export interface FetchUrlParams {
  url: string;
  max_chars?: number;
}

export interface CheckHealthParams {
  sandboxId: string;
  port: number;
  timeoutMs?: number;
  run_build?: boolean;
}

export interface EnvManagerParams {
  action: "set_vars" | "get_vars" | "sync_to_sandbox" | "resolve_url";
  workspaceId: string;
  sandboxId?: string;
  vars?: Record<string, string>;
  port?: number;
}

export interface ProvisionDatabaseParams {
  workspaceId: string;
  sandboxId: string;
}


export type ToolParams =
  | ReadFileParams
  | SearchCodeParams
  | EditFileParams
  | ContextSaveParams
  | ExecuteShellParams
  | CheckHealthParams
  | TodoManagerParams
  | WebSearchParams
  | FetchUrlParams
  | EnvManagerParams
  | ProvisionDatabaseParams;

export interface ToolCall {
  tool: ToolName;
  params: ToolParams;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  directory: string;
  skillMdPath: string;
  metadata?: Record<string, any>;
  hasPersona: boolean;
}

export interface ActiveSkillContext {
  manifest: SkillManifest;
  persona: string;
}
