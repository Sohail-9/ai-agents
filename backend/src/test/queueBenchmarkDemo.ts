/**
 * queueBenchmarkDemo.ts
 *
 *   npm run bench:demo
 *
 * Runs TWO profiles back-to-back and prints a side-by-side comparison:
 *
 *   "Old" : concurrency 10 — what production was running before today's fix
 *   "New" : concurrency 50 — what production is running now
 *
 * Workload: 50 jobs × 5 seconds each.
 *   - Old can run 10 at a time → 5 batches → ~25 s drain
 *   - New can run 50 at a time → 1 batch  → ~5 s drain
 *
 * The dramatic metric is "pickup delay p95": with the old concurrency,
 * job #50 sits in the queue ~20 seconds before any worker even looks at it.
 * That delay is exactly what users were experiencing.
 *
 * Total runtime: ~30 seconds end-to-end.
 */

import "../env";
import { Queue, Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/connection";

const JOBS = 50;
const WORK_MS = 5_000;
const QUEUE_NAME = "bench-demo-queue";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

type Result = {
  label: string;
  concurrency: number;
  enqueueMs: number;
  drainMs: number;
  throughput: number;
  pickup: { min: number; avg: number; p50: number; p95: number; max: number };
};

async function runProfile(label: string, concurrency: number): Promise<Result> {
  console.log("");
  console.log(`──────────────────────────────────────────────────────`);
  console.log(` ▶ Running "${label}" profile  (concurrency=${concurrency})`);
  console.log(`──────────────────────────────────────────────────────`);

  const producerConn = createRedisConnection(`${label}-producer`);
  const workerConn = createRedisConnection(`${label}-worker`);
  const queue = new Queue(QUEUE_NAME, { connection: producerConn });

  // Wipe any prior state.
  await queue.obliterate({ force: true }).catch(() => {});

  const pickupDelays: number[] = [];
  let processed = 0;
  let allDone!: () => void;
  const drained = new Promise<void>((r) => (allDone = r));

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      pickupDelays.push(Date.now() - job.timestamp);
      await sleep(WORK_MS);
      return { ok: true };
    },
    {
      connection: workerConn,
      concurrency,
      settings: { stalledInterval: 500, guardInterval: 1000 } as any,
    },
  );

  worker.on("completed", () => {
    processed++;
    if (processed >= JOBS) allDone();
  });
  worker.on("failed", (job, err) => {
    console.error(`  job ${job?.id} failed:`, err.message);
  });

  // Let worker subscribe before bursting.
  await sleep(500);

  const enqueueStart = Date.now();
  await queue.addBulk(
    Array.from({ length: JOBS }, (_, i) => ({
      name: `j-${i}`,
      data: { i },
      opts: { removeOnComplete: true, removeOnFail: true },
    })),
  );
  const enqueueMs = Date.now() - enqueueStart;
  console.log(`  enqueued ${JOBS} jobs in ${enqueueMs} ms — waiting for drain…`);

  const drainStart = Date.now();
  await drained;
  const drainMs = Date.now() - drainStart;

  const sum = pickupDelays.reduce((a, b) => a + b, 0);

  await worker.close();
  await workerConn.quit();
  await queue.close();
  await producerConn.quit();

  return {
    label,
    concurrency,
    enqueueMs,
    drainMs,
    throughput: (JOBS / drainMs) * 1000,
    pickup: {
      min: Math.min(...pickupDelays),
      avg: sum / pickupDelays.length,
      p50: pct(pickupDelays, 50),
      p95: pct(pickupDelays, 95),
      max: Math.max(...pickupDelays),
    },
  };
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function row(label: string, oldVal: string, newVal: string, winner: "new" | "old" | null = "new") {
  const arrow = winner === "new" ? " ⬇" : winner === "old" ? " ⬆" : "  ";
  return ` ${label.padEnd(22)} │ ${oldVal.padStart(12)} │ ${newVal.padStart(12)}${arrow}`;
}

async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  Worker concurrency demo — before vs after the fix");
  console.log("══════════════════════════════════════════════════════");
  console.log(` Workload : ${JOBS} jobs × ${WORK_MS / 1000}s each`);
  console.log(` Old      : 1 worker, concurrency 10  (pre-fix production)`);
  console.log(` New      : 1 worker, concurrency 50  (post-fix production)`);

  const oldRes = await runProfile("OLD", 10);
  const newRes = await runProfile("NEW", 50);

  console.log("");
  console.log("══════════════════════════════════════════════════════");
  console.log(" Side-by-side comparison");
  console.log("══════════════════════════════════════════════════════");
  console.log(` ${"".padEnd(22)} │ ${"OLD".padStart(12)} │ ${"NEW".padStart(12)}`);
  console.log(` ${"".padEnd(22)}─┼─${"────────────".padStart(12)}─┼─${"────────────".padStart(12)}`);
  console.log(row("drain time",       fmt(oldRes.drainMs),         fmt(newRes.drainMs)));
  console.log(row("throughput (j/s)", oldRes.throughput.toFixed(1), newRes.throughput.toFixed(1), "old"));
  console.log(row("pickup avg",       fmt(oldRes.pickup.avg),      fmt(newRes.pickup.avg)));
  console.log(row("pickup p50",       fmt(oldRes.pickup.p50),      fmt(newRes.pickup.p50)));
  console.log(row("pickup p95",       fmt(oldRes.pickup.p95),      fmt(newRes.pickup.p95)));
  console.log(row("pickup max",       fmt(oldRes.pickup.max),      fmt(newRes.pickup.max)));
  console.log("══════════════════════════════════════════════════════");

  const speedup = oldRes.drainMs / newRes.drainMs;
  const pickupCut = (1 - newRes.pickup.p95 / oldRes.pickup.p95) * 100;
  console.log("");
  console.log(` 🚀 Drain time:        ${speedup.toFixed(1)}× faster`);
  console.log(` 🚀 p95 pickup delay:  ${pickupCut.toFixed(0)}% lower`);
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
