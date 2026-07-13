import { ToolCall, ToolResult, ToolName } from "./types";
import { read_file } from "./file_operations/read_file";
import { edit_file } from "./file_operations/edit_file";
import { search_code } from "./code_intelligence/search_code";
import { execute_shell } from "./shell/execute_shell";
import { check_health } from "./shell/check_health";
import { web_search } from "./web/web_search";
import { todo_manager } from "./todo/todo_manager";
import { context_save } from "./context/context_save";
import { request_env_vars } from "./env/request_env_vars";
import { submit_plan_questions } from "./plan/submit_plan_questions";
import { env_manager } from "./env/env_manager";
import { fetch_url } from "./web/fetch_url";
import { provision_database } from "./database/provision_database";
import {
  checkToolGuard,
  checkEnvWriteGuard,
  checkLocalhostGuard,
} from "../guardrails/toolExecutionGuard";
import { judgeToolAction, shouldJudge } from "../guardrails/preToolJudge";

export interface ToolSchema {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
      additionalProperties?: boolean;
    };
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file at an absolute path in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path (e.g. /workspace/frontend/src/App.tsx)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Find WHICH file/line contains a pattern. Line-based (grep -n): returns one line per match and CANNOT match across line breaks — multiline regex like `<tag>[\\s\\S]*?</tag>` will never work. Use this only to locate a file when you don't know its path. To read or edit a file's actual content, use read_file (returns the whole file), then edit_file — do NOT re-run search_code trying to assemble a multi-line block.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A short single-line substring to locate. Not for multi-line patterns." },
          directory: { type: "string", description: "Root directory to search. Default: /workspace" },
          isRegex: { type: "boolean", description: "Treat query as a (single-line) regex. Default false" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Create or modify a file in the sandbox. Operations: overwrite, append, replace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          operation: { type: "string", enum: ["overwrite", "append", "replace"] },
          content: { type: "string", description: "File content (for overwrite/append)" },
          find: { type: "string", description: "String to find (for replace)" },
          replace: { type: "string", description: "Replacement string (for replace)" },
        },
        required: ["path", "operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_shell",
      description: "Run a shell command in the E2B sandbox. Output includes [exit_code] for you to interpret. Use background: true for dev servers only. NOTE: The sandbox does not support interactive prompts - use non-interactive flags for commands that typically ask for user input.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "number", description: "Max seconds. Default 120. Use 600 for heavy installs (e.g. Next.js)." },
          background: { type: "boolean", description: "Run in background (for dev servers). Returns PID immediately." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for documentation, APIs, or error solutions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "context_save",
      description: "Persist a key-value note in the sandbox for later reference.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          data: { type: "string" },
        },
        required: ["key", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_manager",
      description: "Manage workspace todos. Only mark complete after verifying the task is done.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get_current_todo", "list_pending_todos", "mark_todo_complete"],
          },
          workspaceId: { type: "string" },
          todo_id: { type: "string", description: "Required for mark_todo_complete" },
          notes: { type: "string", description: "Completion summary" },
        },
        required: ["action", "workspaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_env_vars",
      description: "Request necessary environment variables from the user.",
      parameters: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Array of exactly which environment variables are needed"
          },
          reason: {
            type: "string",
            description: "A short, user-friendly explanation of why these keys are required"
          }
        },
        required: ["keys", "reason"],
        additionalProperties: false
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_plan_questions",
      description: "PLAN MODE ONLY: Submit clarifying questions to the user before writing the plan. Call this once after analyzing the codebase. Each question must have 2-4 options the user can choose from.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief 1-2 sentence summary of what you found in the codebase and what you plan to do."
          },
          questions: {
            type: "array",
            description: "2-4 questions to ask the user. Each must have predefined options.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique question ID (e.g. q1, q2)" },
                question: { type: "string", description: "The question to ask" },
                options: {
                  type: "array",
                  description: "2-4 answer options",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", description: "Option ID (e.g. a, b, c)" },
                      text: { type: "string", description: "Option text" }
                    },
                    required: ["id", "text"]
                  }
                }
              },
              required: ["id", "question", "options"]
            }
          }
        },
        required: ["summary", "questions"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_health",
      description: "Verify that a dev server is running and accessible. Checks if the port is listening on 0.0.0.0 (required for E2B proxy) and that HTTP returns a valid response. Returns HEALTH_OK, HEALTH_FAIL, or HEALTH_PARTIAL with actionable guidance. Use this INSTEAD of manually running ss or curl. Set run_build: true after completing code changes to also run npm run build and surface TypeScript/lint errors — the result will include BUILD_OK or BUILD_ERRORS.",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "The port to check (e.g. 3000 for Next.js, 5173 for Vite, 8000 for Express)" },
          timeoutMs: { type: "number", description: "HTTP timeout in milliseconds. Default: 5000" },
          run_build: { type: "boolean", description: "If true, run npm run build after confirming HEALTH_OK to surface TypeScript/lint errors. Use this after completing all code changes." },
        },
        required: ["port"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "provision_database",
      description: "Provision a Neon PostgreSQL database for this workspace and inject DATABASE_URL into the backend environment. Call this when the user asks to add a database to their project after it has already been set up. Safe to call multiple times — returns early if a database already exists.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "env_manager",
      description: [
        "Manage environment variables for the workspace. This is the ONLY way to set, read, or sync .env files.",
        "Agents MUST NOT use edit_file to write .env files — use this tool instead.",
        "Actions:",
        "  set_vars   — store key/value env vars in the DB (localhost values are REJECTED). Use 'target' to specify frontend, backend, or both. Automatically syncs to sandbox if sandboxId is provided.",
        "  get_vars   — read current env vars from the DB. Use 'target' to filter by frontend or backend.",
        "  sync_to_sandbox — write the DB env snapshot to the sandbox: backend vars → /workspace/backend/.env, frontend vars → /workspace/frontend/.env.local.",
        "  resolve_url — given port + sandboxId, returns the correct https://<port>-<sandboxId>.e2b.app URL. Use this instead of localhost.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set_vars", "get_vars", "sync_to_sandbox", "resolve_url"],
            description: "The operation to perform.",
          },
          workspaceId: {
            type: "string",
            description: "The workspace ID. Auto-injected by the runtime — do not guess.",
          },
          sandboxId: {
            type: "string",
            description: "The E2B sandbox ID. Required for sync_to_sandbox and resolve_url. Auto-injected by the runtime.",
          },
          vars: {
            type: "object",
            description: "Key-value pairs to store (set_vars only). Values MUST NOT contain localhost or 127.0.0.1.",
            additionalProperties: { type: "string" },
          },
          target: {
            type: "string",
            enum: ["frontend", "backend", "both"],
            description: "Which service these vars belong to. 'frontend' → /workspace/frontend/.env.local, 'backend' → /workspace/backend/.env, 'both' → written to both files. Required for set_vars; optional filter for get_vars and sync_to_sandbox (defaults to 'both').",
          },
          port: {
            type: "number",
            description: "Port number for resolve_url (e.g. 8000 for backend, 3000 for frontend).",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

// Export the registry for centralized tool distribution
export const SKILL_REGISTRY: Record<ToolName, (params: any, signal?: AbortSignal) => Promise<ToolResult>> = {
  read_file: (params) => read_file(params),
  edit_file: (params) => edit_file(params),
  search_code: (params) => search_code(params),
  execute_shell: (params, signal) => execute_shell(params, signal),
  check_health: (params, signal) => check_health(params, signal),
  web_search: (params) => web_search(params),
  fetch_url: (params) => fetch_url(params),
  todo_manager: (params) => todo_manager(params),
  context_save: (params) => context_save(params),
  request_env_vars: (params) => request_env_vars(params),
  submit_plan_questions: (params) => submit_plan_questions(params),
  env_manager: (params) => env_manager(params),
  provision_database: (params) => provision_database(params),
};

// Export individual handlers
export { read_file } from "./file_operations/read_file";
export { edit_file } from "./file_operations/edit_file";
export { search_code } from "./code_intelligence/search_code";
export { execute_shell } from "./shell/execute_shell";
export { check_health } from "./shell/check_health";
export { web_search } from "./web/web_search";
export { todo_manager } from "./todo/todo_manager";
export { context_save } from "./context/context_save";
export { request_env_vars } from "./env/request_env_vars";
export { submit_plan_questions } from "./plan/submit_plan_questions";
export { env_manager } from "./env/env_manager";
export { provision_database } from "./database/provision_database";

// Export a metadata mapping for prompt generation
export const SKILLS_METADATA = [
  {
    name: "File Operations",
    description: "Reading and modifying files in the sandbox. Use this whenever you need to explore the codebase, initialize projects, or write code.",
    tools: ["read_file", "edit_file"],
  },
  {
    name: "Code Intelligence",
    description: "Searching and understanding the codebase. Use this to find where specific functions or variables are defined, or to locate code for refactoring.",
    tools: ["search_code"],
  },
  {
    name: "Shell",
    description: "Running terminal commands in the sandbox. Use this for environment setup, building, and running applications (dev server).",
    tools: ["execute_shell", "check_health"],
  },
  {
    name: "Web",
    description: "Accessing external documentation and APIs. Use this when encountering unfamiliar technologies or complex errors that require external research.",
    tools: ["web_search"],
  },
  {
    name: "Task Management",
    description: "Managing workspace todos and tracking progress. Use this at the beginning to see tasks and at the end to mark them complete.",
    tools: ["todo_manager"],
  },
  {
    name: "Context",
    description: "Persisting long-term memory in the sandbox. Use this to save important state, port numbers, or decisions across restarts.",
    tools: ["context_save"],
  },
  {
    name: "Environment Manager",
    description: "The ONLY way to manage .env files and environment variables. Use env_manager to set, get, and sync env vars (DB is source of truth). Use resolve_url to get the correct sandboxUrl for any internal service \u2014 NEVER use localhost.",
    tools: ["env_manager"],
  },
];

export interface ExecuteSkillOptions {
  /** workspaceId is required for guardrails (dedup + rate limiting). */
  workspaceId?: string;
  /** Current goal/task title — passed to the AI judge for context. */
  currentGoal?: string;
  /** Rolling window of recent action signatures from the loop detector. */
  recentActions?: string[];
}

export async function executeSkill(
  call: ToolCall,
  signal?: AbortSignal,
  opts: ExecuteSkillOptions = {},
): Promise<ToolResult> {
  const handler = SKILL_REGISTRY[call.tool];
  if (!handler) {
    return { success: false, error: `Unknown tool: "${call.tool}"` };
  }

  const { workspaceId, currentGoal, recentActions = [] } = opts;

  // ── Guardrail 1: Deduplication + Rate Limit ─────────────────────────────────
  if (workspaceId) {
    const guardResult = await checkToolGuard(workspaceId, call.tool, call.params);
    if (guardResult.blocked) {
      return { success: false, error: `[Guardrail] ${guardResult.reason}` };
    }
  }

  // ── Guardrail 2: Pre-Tool AI Judge (only for risky tools) ──────────────────
  if (shouldJudge(call.tool, call.params)) {
    const judgment = await judgeToolAction({
      goal: currentGoal || call.tool,
      toolName: call.tool,
      args: call.params,
      recentActions,
    });
    if (judgment.verdict === "BLOCK") {
      return {
        success: false,
        error: `[Guardrail/Judge] Tool "${call.tool}" was blocked: ${judgment.reason || "deemed unsafe for current goal"}.`,
      };
    }
  }

  // ── Guardrail 3: Semantic guards (env write, localhost, dev server) ─────────
  const envGuard = checkEnvWriteGuard(call.tool, call.params);
  if (envGuard.blocked) {
    return { success: false, error: `[Guardrail] ${envGuard.reason}` };
  }

  const localhostGuard = checkLocalhostGuard(call.tool, call.params);
  if (localhostGuard.blocked) {
    return { success: false, error: `[Guardrail] ${localhostGuard.reason}` };
  }

  return handler(call.params, signal);
}
