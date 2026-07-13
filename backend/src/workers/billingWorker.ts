import "../env";
import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../queue/connection";
import { BillingJobPayload } from "../billing/types";
import { billingService } from "../billing/billingService";
import { computeCredits } from "../billing/normalizeUsage";
import { MODE_BURN_RATES, PROVIDER_MULTIPLIERS, DEFAULT_PROVIDER_MULTIPLIER } from "../billing/constants";
import { publishWsEvent } from "../queue/eventRelay";
import { createEvent } from "../ws/protocol";
import type { EventType } from "../ws/protocol";

export const billingWorkerConnection = createRedisConnection("billing-worker");

async function processBillingJob(job: Job<BillingJobPayload>) {
  const { userId, agentRunId, workspaceId, entries, reservedCredits } = job.data;

  // Calculate breakdown
  const totalRawTokens = entries.reduce((sum, e) => sum + e.totalTokens, 0);
  const creditsToDeduct = computeCredits(entries);

  // Detailed per-entry breakdown
  const breakdown = entries.map((e) => {
    const burn = MODE_BURN_RATES[e.mode] ?? MODE_BURN_RATES["build"];
    const mult = PROVIDER_MULTIPLIERS[e.provider] ?? DEFAULT_PROVIDER_MULTIPLIER;
    const effective = e.totalTokens * burn * mult;
    return {
      provider: e.provider,
      mode: e.mode,
      raw: e.totalTokens,
      burn,
      mult,
      effective: Math.floor(effective),
    };
  });

  console.log(`[BillingWorker] ========================================`);
  console.log(`[BillingWorker] Job ${job.id} — userId=${userId.slice(0, 8)}...`);
  console.log(`[BillingWorker] agentRunId=${agentRunId}`);
  console.log(`[BillingWorker] USAGE SUMMARY:`);
  console.log(`[BillingWorker]   Total raw tokens: ${totalRawTokens.toLocaleString()}`);
  console.log(`[BillingWorker]   Entries processed: ${entries.length}`);
  console.log(`[BillingWorker] BREAKDOWN:`);

  breakdown.forEach((b, i) => {
    console.log(
      `[BillingWorker]   [${i + 1}] ${b.provider} | mode=${b.mode} | raw=${b.raw} × burn=${b.burn} × mult=${b.mult} = ${b.effective}`,
    );
  });

  const totalEffective = breakdown.reduce((sum, b) => sum + b.effective, 0);
  console.log(`[BillingWorker]   Total effective tokens: ${totalEffective.toLocaleString()}`);
  console.log(`[BillingWorker] DEDUCTION:`);
  console.log(`[BillingWorker]   Credits to deduct: ${creditsToDeduct}`);
  console.log(`[BillingWorker]   Reserved buffer: ${reservedCredits}`);
  console.log(`[BillingWorker] ========================================`);

  const newBalance = await billingService.finalize(userId, agentRunId, entries, reservedCredits);

  // Emit BILLING_FINALIZED event to notify client that deduction is complete
  const evt = createEvent("BILLING_FINALIZED" as EventType, { newBalance }, { workspaceId } as any);
  await publishWsEvent(workspaceId, evt).catch((e: any) =>
    console.error("[BillingWorker] BILLING_FINALIZED publish failed:", e.message)
  );

  console.log(`[BillingWorker] ✅ Job ${job.id} finalized (newBalance=${newBalance})`);
}

export const billingWorker = new Worker<BillingJobPayload>(
  "billing-finalize",
  processBillingJob,
  {
    connection: billingWorkerConnection,
    concurrency: 20,
    lockDuration: 60_000,
  },
);

billingWorker.on("failed", (job, err) => {
  console.error(`[BillingWorker] Job ${job?.id} failed:`, err.message);
});

billingWorker.on("error", (err) => {
  console.error("[BillingWorker] Worker error:", err.message);
});

console.log(`[BillingWorker] Listening on "billing-finalize" queue`);
