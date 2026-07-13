import { ToolResult } from "../types";

export interface RequestEnvVarsParams {
  keys: string[];
  reason: string;
}

export async function request_env_vars(params: RequestEnvVarsParams): Promise<ToolResult> {
  // We return a message here, but the real magic happens in agentRunner.ts
  // which will intercept this tool execution and emit an ENV_REQUIRED event.
  return {
    success: true,
    output: `Requested environment variables: ${params.keys.join(", ")}. Reason: ${params.reason}. Waiting for user to provide them. Do not proceed until you have them.`
  };
}
