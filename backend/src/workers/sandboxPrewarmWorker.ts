/**
 * sandboxPrewarmWorker.ts
 *
 * Maintains a pool of pre-warmed E2B sandboxes per framework so new
 * workspace setups can skip the ~30s cold-start of Sandbox.create.
 *
 * Per tick (every PREWARM_INTERVAL_MS, default 60s):
 *   1. evict sandboxes older than PREWARM_MAX_AGE_MS
 *   2. refill the pool to PREWARM_MIN_SIZE for each tracked framework
 *
 * Frameworks tracked
 * ──────────────────
 *   PREWARM_FRAMEWORKS env, comma-separated. Default: "Next.js"
 *
 * Caps
 * ────
 *   PREWARM_MAX_SIZE — never refill above this even if MIN > MAX (sanity).
 *
 * Failure handling
 * ────────────────
 *   Per-sandbox failures are isolated. If Sandbox.create fails we log
 *   and move on; next tick retries. The worker never throws (all errors
 *   are swallowed and logged) so the BullMQ repeatable job doesn't go
 *   into permanent fail / retry-backoff loops.
 */

import "../env";
import { Queue, Worker } from "bullmq";
import { Sandbox } from "@e2b/code-interpreter";
import { createRedisConnection } from "../queue/connection";
import { sandboxPrewarmService } from "../services/sandboxPrewarmService";
import { getTemplateId } from "../brain/systemPrompt";

const QUEUE_NAME = "sandbox-prewarm";
const TICK_JOB_NAME = "prewarm-tick";

const INTERVAL_MS = Number(process.env.PREWARM_INTERVAL_MS ?? 60_000);
const MIN_SIZE = Number(process.env.PREWARM_MIN_SIZE ?? 3);
const MAX_SIZE = Number(process.env.PREWARM_MAX_SIZE ?? 10);
const MAX_AGE_MS = Number(process.env.PREWARM_MAX_AGE_MS ?? 10 * 60 * 1000);
const FRAMEWORKS = (process.env.PREWARM_FRAMEWORKS ?? "Next.js")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SANDBOX_TIMEOUT_MS = Number(process.env.PREWARM_SANDBOX_TIMEOUT_MS ?? 15 * 60 * 1000);

export const prewarmWorkerConnection = createRedisConnection("sandbox-prewarm-worker");
const prewarmQueueConnection = createRedisConnection("sandbox-prewarm-queue");

const prewarmQueue = new Queue(QUEUE_NAME, { connection: prewarmQueueConnection });

// ── E2B operations isolated so they can be swapped in tests ──────────────────
async function createSandbox(framework: string): Promise<string | null> {
  const templateId = getTemplateId(framework);
  if (!templateId) {
    console.warn(`[Prewarm] No templateId for framework "${framework}", skipping`);
    return null;
  }
  try {
    const sb = await Sandbox.create(templateId, {
      timeoutMs: SANDBOX_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause" },
    });
    return sb.sandboxId;
  } catch (err: any) {
    console.warn(`[Prewarm] Sandbox.create("${framework}") failed: ${err.message}`);
    return null;
  }
}

async function killSandbox(sandboxId: string): Promise<void> {
  try {
    const sb = await Sandbox.connect(sandboxId);
    await sb.kill();
  } catch (err: any) {
    // Already dead / expired — that's fine, we're trying to evict anyway.
    console.warn(`[Prewarm] kill(${sandboxId}) failed (likely already gone): ${err.message}`);
  }
}

// ── Single maintenance pass for one framework ────────────────────────────────
async function maintainFramework(framework: string) {
  const startedAt = Date.now();

  // 1. Evict expired
  const expired = await sandboxPrewarmService.listExpired(framework, MAX_AGE_MS);
  if (expired.length > 0) {
    // Kill in E2B (parallel) then drop from pool
    await Promise.allSettled(expired.map(killSandbox));
    await sandboxPrewarmService.evict(framework, expired);
  }

  // 2. Refill to MIN_SIZE (but never above MAX_SIZE)
  const size = await sandboxPrewarmService.size(framework);
  const target = Math.min(MIN_SIZE, MAX_SIZE);
  const need = Math.max(0, target - size);

  let created = 0;
  if (need > 0) {
    const newIds = await Promise.all(
      Array.from({ length: need }, () => createSandbox(framework)),
    );
    const successful = newIds.filter((id): id is string => id !== null);
    await Promise.all(
      successful.map((id) => sandboxPrewarmService.release(framework, id)),
    );
    created = successful.length;
  }

  console.log(
    `[Prewarm] ${framework}: evicted=${expired.length} created=${created} size=${size + created - expired.length} (took ${Date.now() - startedAt}ms)`,
  );
}

async function processPrewarmTick() {
  if (FRAMEWORKS.length === 0) return;
  // Run each framework's maintenance in parallel — they touch different
  // Redis keys, so there's no contention.
  await Promise.allSettled(FRAMEWORKS.map(maintainFramework));
}

export const sandboxPrewarmWorker = new Worker(
  QUEUE_NAME,
  processPrewarmTick,
  {
    connection: prewarmWorkerConnection,
    concurrency: 1, // singleton — don't over-provision
    lockDuration: 5 * 60 * 1000,
    settings: { stalledInterval: 1000, guardInterval: 2000 } as any,
  },
);

sandboxPrewarmWorker.on("error", (err) =>
  console.error("[Prewarm] Worker error:", err.message),
);

// Schedule the repeatable tick.
(async () => {
  try {
    await prewarmQueue.add(
      TICK_JOB_NAME,
      {},
      {
        repeat: { every: INTERVAL_MS },
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    );
    console.log(
      `[Prewarm] Scheduled "${TICK_JOB_NAME}" every ${(INTERVAL_MS / 1000).toFixed(0)}s | frameworks=[${FRAMEWORKS.join(",")}] min=${MIN_SIZE} max=${MAX_SIZE} maxAge=${(MAX_AGE_MS / 60_000).toFixed(0)}m`,
    );
  } catch (err: any) {
    console.error("[Prewarm] Failed to schedule tick:", err.message);
  }
})();

console.log(`[Prewarm] Listening on "${QUEUE_NAME}" queue`);
