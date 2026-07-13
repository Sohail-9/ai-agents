import { Queue } from "bullmq";
import { redisConnection } from "./connection";
import type {
  AgentJobPayload,
  WorkspaceSetupPayload,
  GitHubImportPayload,
  GitHubSyncPayload,
  GitHubConnectPayload,
} from "./jobTypes";
import type { BillingJobPayload } from "../billing/types";

export interface SupportJobPayload {
  caseId: string;
  userId: string;
}

// ── Shared default job options ──────────────────────────────────────────────
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 250 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

// ── Queue definitions ───────────────────────────────────────────────────────

/** Heavy AI + sandbox agent runs */
export const agentQueue = new Queue<AgentJobPayload>("agent-run", {
  connection: redisConnection,
  defaultJobOptions,
});

/** New workspace bootstrap (AI plan → sandbox → todos → triggers agent job) */
export const setupQueue = new Queue<WorkspaceSetupPayload>("workspace-setup", {
  connection: redisConnection,
  defaultJobOptions,
});

/** GitHub repository import provisioning */
export const importQueue = new Queue<GitHubImportPayload>("github-import", {
  connection: redisConnection,
  defaultJobOptions,
});

/** Async credit billing finalization */
export const billingQueue = new Queue<BillingJobPayload>("billing-finalize", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 500 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

/** Best-effort GitHub mirror: syncs unsynced Snapshots to GitHub (OPT-3 debounced) */
export const githubSyncQueue = new Queue<GitHubSyncPayload>("github-sync", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 2_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});

/** One-time connect flow: create GitHub repo + bulk push existing snapshots */
export const githubConnectQueue = new Queue<GitHubConnectPayload>("github-connect", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 1000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

/** Support agent queue */
export const supportQueue = new Queue<SupportJobPayload>("support-queue", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential" as const, delay: 500 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});

// ── Graceful queue close (called on server shutdown) ───────────────────────
export async function closeQueues() {
  await Promise.allSettled([
    agentQueue.close(),
    setupQueue.close(),
    importQueue.close(),
    billingQueue.close(),
    githubSyncQueue.close(),
    githubConnectQueue.close(),
    supportQueue.close(),
  ]);
  console.log("[Queues] All queues closed.");
}
