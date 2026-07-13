/**
 * toolExecutionGuard.ts
 *
 * Centralized guardrail middleware for all agent tool calls.
 * Uses Redis for distributed state so multi-worker deployments share the same view.
 *
 * Enforces two independent policies:
 *  1. DEDUPLICATION — blocks the exact same (workspaceId, toolName, args) within a TTL window.
 *     Configured per-tool: some tools (check_health, web_search) deduplicate aggressively;
 *     others (edit_file, execute_shell) allow more frequent re-invocation.
 *  2. RATE LIMITING — caps total tool calls per workspace per rolling 60-second window
 *     to prevent tool storms.
 */

import crypto from "crypto";
import { createRedisConnection } from "../queue/connection";

// ── One dedicated IORedis connection for guardrail reads/writes ─────────────
const redis = createRedisConnection("guardrail");

// ── Deduplication config ─────────────────────────────────────────────────────
interface DedupePolicy {
  /** How many seconds to block a duplicate call. 0 = never deduplicate. */
  ttlSeconds: number;
  /** Max identical calls allowed within the TTL window before blocking. */
  maxAllowed: number;
}

const DEDUP_POLICIES: Partial<Record<string, DedupePolicy>> = {
  // Soft-dedupe: allow retries during server startup, but limit to 6 calls per 30s window
  check_health:       { ttlSeconds: 5,  maxAllowed: 6 },
  // Soft-dedupe: allow 2 identical web searches before blocking for 2 minutes
  web_search:         { ttlSeconds: 120, maxAllowed: 2 },
  // Soft-dedupe: same read within 10s is pointless
  read_file:          { ttlSeconds: 10,  maxAllowed: 2 },
  search_code:        { ttlSeconds: 10,  maxAllowed: 2 },
  // Risky writes: allow the same command twice (e.g. npm install retry) but no more
  execute_shell:      { ttlSeconds: 15,  maxAllowed: 2 },
  // Soft-dedupe for edit_file: allow 5 identical writes (path+content) within 30s.
  // Complex apps write 25+ files; only truly repeated identical writes are loops.
  // The loop detector (in agentRunner) catches semantic loops separately.
  edit_file:          { ttlSeconds: 30,  maxAllowed: 5 },
  // Database provision is idempotent but should only run once per run
  provision_database: { ttlSeconds: 300, maxAllowed: 1 },
};

// Default policy for unlisted tools
const DEFAULT_DEDUP_POLICY: DedupePolicy = { ttlSeconds: 5, maxAllowed: 3 };

// ── Rate limit config ────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_CALLS = 60; // per workspace per minute — complex apps need 50+ calls/wave

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Stable hash of tool arguments — SHA-256 for collision-resistant deduplication. */
function hashArgs(args: unknown): string {
  if (args === null || args === undefined) return "null";
  try {
    // Sort object keys for stability
    const normalized = JSON.stringify(args, Object.keys(args as object).sort());
    return crypto.createHash("sha256").update(normalized).digest("hex");
  } catch {
    return crypto.createHash("sha256").update(String(args)).digest("hex");
  }
}

function dedupeKey(workspaceId: string, toolName: string, argsHash: string): string {
  return `guardrail:dedup:${workspaceId}:${toolName}:${argsHash}`;
}

function rateKey(workspaceId: string): string {
  return `guardrail:rate:${workspaceId}`;
}

// ── Main exported function ────────────────────────────────────────────────────
export interface GuardResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Check whether a tool call should be blocked.
 * Call this BEFORE executing the tool. Returns quickly (Redis INCR/EX).
 *
 * @returns `{ blocked: false }` when the call should proceed.
 *          `{ blocked: true, reason }` when the guardrail fires.
 */
export async function checkToolGuard(
  workspaceId: string,
  toolName: string,
  args: unknown,
): Promise<GuardResult> {
  try {
    // ── Rate limit check ──────────────────────────────────────────────────────
    const rk = rateKey(workspaceId);
    const count = await redis.incr(rk);
    if (count === 1) {
      await redis.expire(rk, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > RATE_LIMIT_MAX_CALLS) {
      console.warn(`[ToolGuard] 🚫 Rate limit hit workspaceId=${workspaceId} toolName=${toolName} count=${count}`);
      return {
        blocked: true,
        reason: `Tool rate limit exceeded (${count}/${RATE_LIMIT_MAX_CALLS} calls in the last ${RATE_LIMIT_WINDOW_SECONDS}s). Pause and consolidate your approach before continuing.`,
      };
    }

    // ── Deduplication check ───────────────────────────────────────────────────
    const policy = DEDUP_POLICIES[toolName] ?? DEFAULT_DEDUP_POLICY;
    if (policy.ttlSeconds > 0) {
      const argsHash = hashArgs(args);
      const dk = dedupeKey(workspaceId, toolName, argsHash);
      const calls = await redis.incr(dk);
      if (calls === 1) {
        await redis.expire(dk, policy.ttlSeconds);
      }
      if (calls > policy.maxAllowed) {
        console.warn(
          `[ToolGuard] 🔁 Duplicate tool blocked workspaceId=${workspaceId} toolName=${toolName} calls=${calls} maxAllowed=${policy.maxAllowed} ttl=${policy.ttlSeconds}s`,
        );
        return {
          blocked: true,
          reason: `Duplicate call to "${toolName}" blocked (${calls} identical calls within ${policy.ttlSeconds}s window). You already attempted this — analyze the previous result and try a different approach.`,
        };
      }
    }

    return { blocked: false };
  } catch (err: any) {
    // Never block the agent due to a Redis connectivity issue — fail open.
    console.error(`[ToolGuard] Redis error (failing open):`, err.message);
    return { blocked: false };
  }
}

/**
 * Reset the deduplication counter for a specific tool call.
 * Call this when the agent is explicitly retrying after a confirmed failure.
 */
export async function resetToolDedup(
  workspaceId: string,
  toolName: string,
  args: unknown,
): Promise<void> {
  try {
    const argsHash = hashArgs(args);
    const dk = dedupeKey(workspaceId, toolName, argsHash);
    await redis.del(dk);
  } catch {
    // no-op
  }
}

/**
 * Additional semantic guards for specific tools.
 * These check logical properties of the tool call itself (not just dedup/rate-limit).
 */

export function checkEnvWriteGuard(toolName: string, args: any): GuardResult {
  if (toolName === "edit_file" && args?.path) {
    const isEnvFile = /\.env(\.[^/]+)?$/.test(args.path);
    if (isEnvFile) {
      return {
        blocked: true,
        reason: `BLOCKED: Direct writes to .env files are not allowed (path: ${args.path}). Use the env_manager tool instead.`,
      };
    }
  }
  return { blocked: false };
}

export function checkLocalhostGuard(toolName: string, args: any): GuardResult {
  const LOCALHOST_RE = /localhost|127\.0\.0\.1/i;

  if (toolName === "edit_file" && args?.content && typeof args.content === "string") {
    if (LOCALHOST_RE.test(args.content)) {
      return {
        blocked: true,
        reason: `BLOCKED: The content contains a forbidden localhost or 127.0.0.1 reference. Use E2B sandbox URL format instead: https://<port>-<sandboxId>.e2b.app`,
      };
    }
  }

  return { blocked: false };
}

export function checkDevServerGuard(
  toolName: string,
  args: any,
  runCtx?: { startedServerPorts?: Set<number> },
): GuardResult {
  if (toolName !== "execute_shell" || !args?.command) {
    return { blocked: false };
  }

  const cmd = args.command;
  const isDevServer =
    /npm\s+(run\s+)?dev|next\s+dev|npm\s+start|npx\s+next|yarn\s+dev|pnpm\s+dev/.test(cmd);
  if (!isDevServer) {
    return { blocked: false };
  }

  // Extract port if specified
  const portMatch = cmd.match(/--port\s+(\d+)|-p\s+(\d+)|:(\d+)/);
  const port = portMatch ? parseInt(portMatch[1] || portMatch[2] || portMatch[3]) : null;

  // Check if port already started this run
  if (port && runCtx?.startedServerPorts?.has(port)) {
    return {
      blocked: true,
      reason: `Dev server already started on port ${port} this run.`,
    };
  }

  return { blocked: false };
}
