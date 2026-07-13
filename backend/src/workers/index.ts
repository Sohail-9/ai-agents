/**
 * workers/index.ts
 *
 * Entry point for the dedicated worker process.
 *
 *   npm run worker          (dev — runs all kinds in one process via tsx watch)
 *   pm2 start ecosystem.config.cjs   (prod — split by WORKER_KIND)
 *
 * Env-gated by WORKER_KIND:
 *   WORKER_KIND=agent     → only registers agentWorker
 *   WORKER_KIND=setup     → only registers setupWorker
 *   WORKER_KIND=import    → only registers importWorker
 *   WORKER_KIND=reaper    → only registers sandboxReaperWorker
 *   WORKER_KIND=prewarm   → only registers sandboxPrewarmWorker
 *   WORKER_KIND=all (or unset) → all six (dev default)
 *
 * Per-kind isolation prevents a stalled agent run from blocking
 * setup/import pickup latency.
 */

import "../env";
import { redisConnection } from "../queue/connection";
import type IORedis from "ioredis";
import type { Worker } from "bullmq";

const KIND = (process.env.WORKER_KIND || "all").toLowerCase();
const wantsAll = KIND === "all";

type WorkerHandle = {
  name: string;
  worker: Worker;
  connection: IORedis;
};

const handles: WorkerHandle[] = [];

if (wantsAll || KIND === "agent") {
  const { agentWorker, agentWorkerConnection } = require("./agentWorker") as typeof import("./agentWorker");
  handles.push({ name: "agent", worker: agentWorker, connection: agentWorkerConnection });
}
if (wantsAll || KIND === "setup") {
  const { setupWorker, setupWorkerConnection } = require("./setupWorker") as typeof import("./setupWorker");
  handles.push({ name: "setup", worker: setupWorker, connection: setupWorkerConnection });
}
if (wantsAll || KIND === "import") {
  const { importWorker, importWorkerConnection } = require("./importWorker") as typeof import("./importWorker");
  handles.push({ name: "import", worker: importWorker, connection: importWorkerConnection });
}
if (wantsAll || KIND === "github-sync") {
  const { githubSyncWorker, githubSyncWorkerConnection, githubConnectWorker, githubConnectWorkerConnection } = require("./githubSyncWorker") as typeof import("./githubSyncWorker");
  handles.push({ name: "github-sync", worker: githubSyncWorker, connection: githubSyncWorkerConnection });
  handles.push({ name: "github-connect", worker: githubConnectWorker, connection: githubConnectWorkerConnection });
}
if (wantsAll || KIND === "reaper") {
  const { sandboxReaperWorker, reaperWorkerConnection } = require("./sandboxReaperWorker") as typeof import("./sandboxReaperWorker");
  handles.push({ name: "reaper", worker: sandboxReaperWorker, connection: reaperWorkerConnection });
}
if (wantsAll || KIND === "prewarm") {
  const { sandboxPrewarmWorker, prewarmWorkerConnection } = require("./sandboxPrewarmWorker") as typeof import("./sandboxPrewarmWorker");
  handles.push({ name: "prewarm", worker: sandboxPrewarmWorker, connection: prewarmWorkerConnection });
}
if (wantsAll || KIND === "support") {
  const { supportWorker, supportWorkerConnection } = require("./supportWorker") as typeof import("./supportWorker");
  handles.push({ name: "support", worker: supportWorker, connection: supportWorkerConnection });
}

let isBillingWorker = false;
if (wantsAll || KIND === "billing") {
  isBillingWorker = true;
  const { billingWorker, billingWorkerConnection } = require("./billingWorker") as typeof import("./billingWorker");
  handles.push({ name: "billing", worker: billingWorker, connection: billingWorkerConnection });
}

// Start cleanup loop only in billing worker (prevents N duplicate loops in production)
if (wantsAll || isBillingWorker) {
  const { startCleanupLoop } = require("./cleanupWorker") as typeof import("./cleanupWorker");
  startCleanupLoop();
}

if (handles.length === 0) {
  console.error(`[Workers] Unknown WORKER_KIND="${KIND}". Valid: agent | setup | import | github-sync | reaper | prewarm | billing | support | all`);
  process.exit(1);
}

console.log("╔══════════════════════════════════════╗");
console.log("║   AI Agents Worker Process Ready     ║");
console.log("╚══════════════════════════════════════╝");
console.log(`WORKER_KIND=${KIND} → ${handles.map((h) => h.name).join(", ")}`);
console.log(`Default LLM: QWEN_DASHSCOPE (qwen3.6-plus)`);

async function shutdown(signal: string) {
  console.log(`\n[Workers] ${signal} received — draining in-flight jobs…`);
  await Promise.allSettled(handles.map((h) => h.worker.close()));
  await Promise.allSettled(handles.map((h) => h.connection.quit()));
  await redisConnection.quit().catch(() => {});
  console.log("[Workers] All workers closed. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
