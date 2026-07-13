/**
 * supportWorker.ts
 *
 * Processes support-queue jobs. Each job runs the SupportAgent loop
 * and streams events back to the WS client via Redis pub/sub.
 *
 * WS routing: events published to ws-events:{caseId}.
 * The client connects WS with workspaceId=caseId so the relay delivers them.
 */

import '../env';
import { Worker } from 'bullmq';
import { createRedisConnection } from '../queue/connection';
import { publishWsEvent } from '../queue/eventRelay';
import { supportCaseService } from '../services/supportCaseService';
import { SupportAgent } from '../brain/supportAgent';
import { SupportMessageRole } from '../../generated/prisma';

export const supportWorkerConnection = createRedisConnection('support-worker');

const CONCURRENCY = parseInt(process.env.SUPPORT_WORKER_CONCURRENCY || '10', 10);

export const supportWorker = new Worker<{ caseId: string; userId: string }>(
  'support-queue',
  async (job) => {
    const { caseId } = job.data;

    console.log(`[SupportWorker] Processing job ${job.id} for case ${caseId}`);

    const emit = (event: Record<string, unknown>) =>
      publishWsEvent(caseId, event);

    try {
      const agent = new SupportAgent();
      await agent.processMessage(caseId, emit);
    } catch (err) {
      console.error(`[SupportWorker] Job ${job.id} failed:`, err);

      await supportCaseService
        .addMessage(caseId, SupportMessageRole.SYSTEM, 'Something went wrong. Please try again.')
        .catch(() => {});

      await emit({
        type: 'SUPPORT_AGENT_ERROR',
        payload: { caseId, error: String(err) },
      });
    }
  },
  {
    connection: supportWorkerConnection,
    concurrency: CONCURRENCY,
    lockDuration: 120_000,
  },
);

supportWorker.on('failed', (job, err) => {
  console.error(`[SupportWorker] Job ${job?.id} permanently failed:`, err?.message);
});

console.log(`[SupportWorker] Listening on "support-queue" (concurrency=${CONCURRENCY})`);
