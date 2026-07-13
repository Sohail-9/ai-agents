/**
 * sandboxReaperWorker.ts
 *
 * Periodic reaper that pauses E2B sandboxes whose `last_hit` TTL has
 * expired. Idle sandboxes cost money; pausing them does not.
 *
 * Implemented as a BullMQ repeatable job so we don't need a separate
 * setInterval daemon — the queue handles scheduling and persists across
 * worker restarts.
 *
 * Scheduling
 * ──────────
 *   queue: sandbox-reaper
 *   jobId (singleton): "reaper-tick"
 *   repeat: every SANDBOX_REAPER_INTERVAL_MS (default 15 min)
 *
 * The producer side (scheduling the repeatable job) lives inside this
 * file so simply registering the worker also schedules the cron.
 */

import "../env";
import { Queue, Worker } from "bullmq";
import { createRedisConnection } from "../queue/connection";
import { sandboxLifecycleService } from "../services/sandboxLifecycleService";
import { workspaceService } from "../services/workspaceService";

const QUEUE_NAME = "sandbox-reaper";
const TICK_JOB_NAME = "reaper-tick";
const INTERVAL_MS = Number(process.env.SANDBOX_REAPER_INTERVAL_MS ?? 15 * 60 * 1000);
const CONCURRENCY = 1; // single instance — reaper logic is idempotent but no point fanning out

export const reaperWorkerConnection = createRedisConnection("sandbox-reaper-worker");
const reaperQueueConnection = createRedisConnection("sandbox-reaper-queue");

const reaperQueue = new Queue(QUEUE_NAME, { connection: reaperQueueConnection });

async function processReaperTick() {
  const startedAt = Date.now();
  const workspaceIds = await sandboxLifecycleService.listIdleCandidates();
  if (workspaceIds.length === 0) {
    console.log(`[Reaper] No idle sandboxes — tick took ${Date.now() - startedAt}ms`);
    return;
  }
  console.log(`[Reaper] Found ${workspaceIds.length} idle workspace(s) — pausing…`);

  // Sleep all idle sandboxes in parallel. Resolve sandboxId via DB.
  const results = await Promise.allSettled(
    workspaceIds.map(async (wsId) => {
      const ws = await workspaceService.getWorkspace(wsId);
      if (!ws?.sandboxId) return { wsId, skipped: true };
      await sandboxLifecycleService.sleep(wsId, ws.sandboxId);
      return { wsId, paused: true };
    }),
  );

  const paused = results.filter(
    (r) => r.status === "fulfilled" && (r.value as any).paused,
  ).length;
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(
    `[Reaper] Tick done in ${Date.now() - startedAt}ms — paused=${paused} failed=${failed}`,
  );
}

export const sandboxReaperWorker = new Worker(
  QUEUE_NAME,
  processReaperTick,
  {
    connection: reaperWorkerConnection,
    concurrency: CONCURRENCY,
    lockDuration: 5 * 60 * 1000,
    settings: { stalledInterval: 1000, guardInterval: 2000 } as any,
  },
);

sandboxReaperWorker.on("error", (err) =>
  console.error("[Reaper] Worker error:", err.message),
);

// ── Schedule the repeatable tick (idempotent — BullMQ dedupes by repeat key) ──
(async () => {
  try {
    await reaperQueue.add(
      TICK_JOB_NAME,
      {},
      {
        repeat: { every: INTERVAL_MS },
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    );
    console.log(
      `[Reaper] Scheduled "${TICK_JOB_NAME}" every ${(INTERVAL_MS / 60_000).toFixed(1)} min`,
    );
  } catch (err: any) {
    console.error("[Reaper] Failed to schedule tick:", err.message);
  }
})();

console.log(`[Reaper] Listening on "${QUEUE_NAME}" queue (concurrency=${CONCURRENCY})`);
