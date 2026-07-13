/**
 * queueBenchmark.ts
 *
 * Proves the worker-pickup fix.
 *
 *   npm run bench:queue
 *
 * What it does:
 *   1. Spins up N BullMQ Workers on a dedicated "bench-queue"
 *      - Each Worker gets its own IORedis connection (the fix we just shipped)
 *   2. Bursts JOBS_TOTAL no-op jobs into the queue, all in one shot
 *   3. Each job sleeps WORK_MS to simulate real work
 *   4. Measures per-job pickup delay = (processedOn - timestamp)
 *   5. Reports median / p95 / max pickup delay and total drain time
 *
 * Env overrides:
 *   BENCH_WORKERS   number of parallel workers      default 4
 *   BENCH_CONC      concurrency per worker          default 50
 *   BENCH_JOBS      total jobs to enqueue           default 200
 *   BENCH_WORK_MS   simulated work duration         default 200
 *   BENCH_MODE      "isolated" (fix) | "shared" (legacy bug repro)
 *
 * Compare:
 *   BENCH_MODE=shared   npm run bench:queue   # simulates pre-fix behaviour
 *   BENCH_MODE=isolated npm run bench:queue   # validates the fix
 */

import "../env";
import { Queue, Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/connection";

const BENCH_WORKERS = Number(process.env.BENCH_WORKERS ?? 4);
const BENCH_CONC = Number(process.env.BENCH_CONC ?? 50);
const BENCH_JOBS = Number(process.env.BENCH_JOBS ?? 200);
const BENCH_WORK_MS = Number(process.env.BENCH_WORK_MS ?? 200);
const MODE = (process.env.BENCH_MODE ?? "isolated") as "isolated" | "shared";
const QUEUE_NAME = "bench-queue";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log("──────────────────────────────────────────────────────");
  console.log(" Queue pickup benchmark");
  console.log("──────────────────────────────────────────────────────");
  console.log(` mode      : ${MODE}`);
  console.log(` workers   : ${BENCH_WORKERS}`);
  console.log(` conc/wkr  : ${BENCH_CONC}`);
  console.log(` jobs      : ${BENCH_JOBS}`);
  console.log(` work_ms   : ${BENCH_WORK_MS}`);
  console.log("──────────────────────────────────────────────────────");

  // Producer queue uses its own connection (non-blocking LPUSH).
  const producerConn = createRedisConnection("bench-producer");
  const queue = new Queue(QUEUE_NAME, { connection: producerConn });

  // Drain anything left from a prior run.
  await queue.obliterate({ force: true }).catch(() => {});

  // Per-job pickup delays, populated by worker handlers.
  const pickupDelays: number[] = [];
  let processed = 0;
  let allDone!: () => void;
  const drained = new Promise<void>((r) => (allDone = r));

  const sharedConn = MODE === "shared" ? createRedisConnection("bench-shared") : null;

  const workers: Worker[] = [];
  const workerConns: Array<{ quit(): Promise<unknown> }> = [];

  for (let i = 0; i < BENCH_WORKERS; i++) {
    const conn = MODE === "shared" ? sharedConn! : createRedisConnection(`bench-w${i}`);
    if (MODE === "isolated") workerConns.push(conn);

    const w = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const pickupDelay = Date.now() - job.timestamp;
        pickupDelays.push(pickupDelay);
        await sleep(BENCH_WORK_MS);
        return { ok: true };
      },
      {
        connection: conn,
        concurrency: BENCH_CONC,
        settings: { stalledInterval: 500, guardInterval: 1000 } as any,
      },
    );

    w.on("completed", () => {
      processed++;
      if (processed >= BENCH_JOBS) allDone();
    });
    w.on("failed", (job, err) => {
      console.error(`[bench] job ${job?.id} failed:`, err.message);
    });
    workers.push(w);
  }

  if (MODE === "shared" && sharedConn) workerConns.push(sharedConn);

  // Give the workers a moment to subscribe to the queue.
  await sleep(500);

  // ── Enqueue burst ────────────────────────────────────────────────────
  const enqueueStart = Date.now();
  const jobs = Array.from({ length: BENCH_JOBS }, (_, i) => ({
    name: `bench-${i}`,
    data: { i, enqueuedAt: Date.now() },
    opts: { removeOnComplete: true, removeOnFail: true },
  }));
  await queue.addBulk(jobs);
  const enqueueMs = Date.now() - enqueueStart;
  console.log(`[bench] Enqueued ${BENCH_JOBS} jobs in ${enqueueMs}ms`);

  // ── Wait for drain ───────────────────────────────────────────────────
  const drainStart = Date.now();
  await drained;
  const drainMs = Date.now() - drainStart;

  // ── Report ────────────────────────────────────────────────────────────
  const sum = pickupDelays.reduce((a, b) => a + b, 0);
  const avg = sum / pickupDelays.length;
  const p50 = pct(pickupDelays, 50);
  const p95 = pct(pickupDelays, 95);
  const max = Math.max(...pickupDelays);
  const min = Math.min(...pickupDelays);
  const throughput = (BENCH_JOBS / drainMs) * 1000;

  console.log("");
  console.log("══════════════════════════════════════════════════════");
  console.log(" Results");
  console.log("══════════════════════════════════════════════════════");
  console.log(` enqueue time     : ${enqueueMs} ms`);
  console.log(` drain time       : ${drainMs} ms`);
  console.log(` throughput       : ${throughput.toFixed(1)} jobs/sec`);
  console.log(` pickup delay min : ${min} ms`);
  console.log(` pickup delay avg : ${avg.toFixed(1)} ms`);
  console.log(` pickup delay p50 : ${p50} ms`);
  console.log(` pickup delay p95 : ${p95} ms`);
  console.log(` pickup delay max : ${max} ms`);
  console.log("══════════════════════════════════════════════════════");

  // Clean up
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(workerConns.map((c) => c.quit()));
  await queue.close();
  await producerConn.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error("[bench] fatal:", err);
  process.exit(1);
});
