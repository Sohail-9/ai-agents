import { Sandbox } from "@e2b/code-interpreter";
import { ContextSaveParams, ToolResult } from "../types";

const CONTEXT_PATH = "/workspace/.ai_context.json";

async function loadStore(sandbox: Sandbox): Promise<Record<string, string>> {
  try {
    const raw = await sandbox.files.read(CONTEXT_PATH);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function context_save(params: ContextSaveParams): Promise<ToolResult> {
  try {
    const sandboxId = (params as any).sandboxId;
    if (!sandboxId) {
      return { success: false, error: "sandboxId is required for context_save." };
    }

    const sandbox = await Sandbox.connect(sandboxId);
    const store = await loadStore(sandbox);
    store[params.key] = params.data;
    await sandbox.files.write(CONTEXT_PATH, JSON.stringify(store, null, 2));
    return { success: true, output: `Saved context under key "${params.key}".` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function context_read(key: string, sandboxId?: string): Promise<string | undefined> {
  if (!sandboxId) return undefined;
  try {
    const sandbox = await Sandbox.connect(sandboxId);
    const store = await loadStore(sandbox);
    return store[key];
  } catch {
    return undefined;
  }
}

export async function context_list(sandboxId?: string): Promise<string[]> {
  if (!sandboxId) return [];
  try {
    const sandbox = await Sandbox.connect(sandboxId);
    const store = await loadStore(sandbox);
    return Object.keys(store);
  } catch {
    return [];
  }
}
