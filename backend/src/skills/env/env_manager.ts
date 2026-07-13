import { Sandbox } from "@e2b/code-interpreter";
import { ToolResult } from "../types";
import { prisma } from "../../lib/prisma";

export type EnvManagerAction = "set_vars" | "get_vars" | "sync_to_sandbox" | "resolve_url";
export type EnvTarget = "frontend" | "backend" | "both";

export interface EnvEntry {
  value: string;
  frontend: boolean;
  backend: boolean;
}

export type EnvStore = Record<string, EnvEntry>;

export interface EnvManagerParams {
  action: EnvManagerAction;
  /** Required for set_vars / get_vars / sync_to_sandbox */
  workspaceId: string;
  /** Required for set_vars / sync_to_sandbox */
  sandboxId?: string;
  /** Key-value pairs to persist (set_vars only) */
  vars?: Record<string, string>;
  /** Which service the vars belong to (set_vars / get_vars / sync_to_sandbox) */
  target?: EnvTarget;
  /** Port to build a sandboxUrl for (resolve_url only) */
  port?: number;
}

/** Patterns that indicate a localhost reference — always forbidden in env values. */
const LOCALHOST_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0/i;

/**
 * Resolve the public E2B proxy URL for a given port + sandboxId.
 * This is the canonical way to reference any internal service from outside.
 */
export function resolveSandboxUrl(sandboxId: string, port: number): string {
  const domain = process.env.E2B_SANDBOX_DOMAIN || "e2b.app";
  return `https://${port}-${sandboxId}.${domain}`;
}

/**
 * Normalize the raw env JSON blob: old flat-string entries (before target support)
 * are treated as belonging to both frontend and backend.
 */
export function normalizeEnvStore(raw: any): EnvStore {
  const result: EnvStore = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (typeof v === "string") {
      result[k] = { value: v, frontend: true, backend: true };
    } else if (v && typeof v === "object") {
      const entry = v as any;
      result[k] = {
        value: entry.value ?? "",
        frontend: entry.frontend ?? true,
        backend: entry.backend ?? true,
      };
    }
  }
  return result;
}

/**
 * Filter a store by target and return flat key-value pairs.
 */
export function filterByTarget(store: EnvStore, target: EnvTarget): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, entry] of Object.entries(store)) {
    const include =
      target === "both" ||
      (target === "frontend" && entry.frontend) ||
      (target === "backend" && entry.backend);
    if (include) result[k] = entry.value;
  }
  return result;
}

/**
 * Read the current env store from the DB.
 */
async function getEnvStoreFromDb(workspaceId: string): Promise<EnvStore> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { env: true },
  });
  if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
  return normalizeEnvStore(ws.env);
}

/**
 * Merge-patch env entries into the DB store.
 */
async function patchEnvInDb(
  workspaceId: string,
  vars: Record<string, string>,
  target: EnvTarget,
): Promise<EnvStore> {
  const current = await getEnvStoreFromDb(workspaceId);
  const frontend = target === "frontend" || target === "both";
  const backend = target === "backend" || target === "both";

  for (const [k, v] of Object.entries(vars)) {
    const existing = current[k];
    current[k] = {
      value: v,
      frontend: existing ? existing.frontend || frontend : frontend,
      backend: existing ? existing.backend || backend : backend,
    };
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { env: current as any },
  });
  return current;
}

/**
 * Write env vars to sandbox files. Backend vars go to /workspace/backend/.env,
 * frontend vars go to /workspace/frontend/.env.local.
 */
async function isGithubImport(workspaceId: string): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { config: true },
  });
  const config = ws?.config as Record<string, unknown> | null;
  return config?.source === "github" || config?.framework === "github-import";
}

async function syncToSandbox(
  workspaceId: string,
  sandboxId: string,
  target: EnvTarget = "both",
): Promise<string> {
  const store = await getEnvStoreFromDb(workspaceId);
  const sandbox = await Sandbox.connect(sandboxId);
  const messages: string[] = [];

  if (await isGithubImport(workspaceId)) {
    // Imported repos have a single directory at /workspace/repo — no frontend/backend split.
    const allVars = filterByTarget(store, "both");
    const entries = Object.entries(allVars);
    if (entries.length > 0) {
      const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
      await sandbox.files.write("/workspace/repo/.env", content);
      messages.push(`Synced ${entries.length} var(s) to /workspace/repo/.env`);
    }
  } else {
    if (target === "backend" || target === "both") {
      const backendVars = filterByTarget(store, "backend");
      const entries = Object.entries(backendVars);
      if (entries.length > 0) {
        const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        await sandbox.files.write("/workspace/backend/.env", content);
        messages.push(`Synced ${entries.length} backend var(s) to /workspace/backend/.env`);
      }
    }

    if (target === "frontend" || target === "both") {
      const frontendVars = filterByTarget(store, "frontend");
      const entries = Object.entries(frontendVars);
      if (entries.length > 0) {
        const content = entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        await sandbox.files.write("/workspace/frontend/.env.local", content);
        messages.push(`Synced ${entries.length} frontend var(s) to /workspace/frontend/.env.local`);
      }
    }
  }

  if (messages.length === 0) {
    return "No env vars to sync for the specified target.";
  }
  return messages.join("\n");
}

export async function env_manager(params: EnvManagerParams): Promise<ToolResult> {
  const { action, workspaceId, sandboxId, vars, port } = params;
  const target: EnvTarget = params.target ?? "both";

  try {
    // ── resolve_url ──────────────────────────────────────────────
    if (action === "resolve_url") {
      if (!port) {
        return { success: false, error: "resolve_url requires 'port'." };
      }
      if (!sandboxId) {
        return { success: false, error: "resolve_url requires 'sandboxId'." };
      }
      const url = resolveSandboxUrl(sandboxId, port);
      return {
        success: true,
        output: `Sandbox URL for port ${port}: ${url}\nNEVER use localhost. Always use this URL in your env and code.`,
      };
    }

    // All other actions require workspaceId
    if (!workspaceId) {
      return { success: false, error: `'workspaceId' is required for action '${action}'.` };
    }

    // ── get_vars ─────────────────────────────────────────────────
    if (action === "get_vars") {
      const store = await getEnvStoreFromDb(workspaceId);
      const filtered = filterByTarget(store, target);
      const count = Object.keys(filtered).length;
      if (count === 0) {
        return { success: true, output: `No ${target} env vars stored for this workspace yet.` };
      }
      const display = Object.entries(filtered)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      return { success: true, output: `Current ${target} env vars (${count}):\n${display}` };
    }

    // ── set_vars ─────────────────────────────────────────────────
    if (action === "set_vars") {
      if (!vars || Object.keys(vars).length === 0) {
        return { success: false, error: "set_vars requires a non-empty 'vars' object." };
      }

      // ⛔ Reject any localhost references
      const violations: string[] = [];
      for (const [key, value] of Object.entries(vars)) {
        if (LOCALHOST_RE.test(value)) {
          violations.push(`${key}="${value}"`);
        }
      }
      if (violations.length > 0) {
        const msg = [
          `REJECTED: The following env values contain forbidden localhost references:`,
          ...violations.map(v => `  - ${v}`),
          ``,
          `Always use the sandbox URL instead. Call env_manager with action=resolve_url, port=<port>`,
          `to get the correct public URL: https://<port>-<sandboxId>.e2b.app`,
        ].join("\n");
        return { success: false, error: msg };
      }

      await patchEnvInDb(workspaceId, vars, target);
      const keys = Object.keys(vars).join(", ");

      let syncMsg = "";
      if (sandboxId) {
        syncMsg = "\n" + (await syncToSandbox(workspaceId, sandboxId, target));
      } else {
        syncMsg = "\nNote: sandboxId not provided — call sync_to_sandbox separately to write to the sandbox file.";
      }

      return {
        success: true,
        output: `Stored ${Object.keys(vars).length} ${target} env var(s) [${keys}] in DB for workspace ${workspaceId}.${syncMsg}`,
      };
    }

    // ── sync_to_sandbox ──────────────────────────────────────────
    if (action === "sync_to_sandbox") {
      if (!sandboxId) {
        return { success: false, error: "sync_to_sandbox requires 'sandboxId'." };
      }
      const msg = await syncToSandbox(workspaceId, sandboxId, target);
      return { success: true, output: msg };
    }

    return { success: false, error: `Unknown env_manager action: '${action}'.` };

  } catch (err: any) {
    return { success: false, error: `env_manager error: ${err.message}` };
  }
}
