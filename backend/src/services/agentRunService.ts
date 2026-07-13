import { prisma } from '../lib/prisma';

export const agentRunService = {
  create: async (workspaceId: string) => {
    return prisma.agentRun.create({
      data: { workspaceId },
    });
  },

  complete: async (
    id: string,
    data: {
      status: 'SUCCESS' | 'FAILED';
      summary?: string;
      port?: number;
      backendPort?: number;
    },
  ) => {
    return prisma.agentRun.update({
      where: { id },
      data: {
        status: data.status,
        summary: data.summary ?? null,
        port: data.port ?? null,
        backendPort: data.backendPort ?? null,
        completedAt: new Date(),
      },
    });
  },

  /** Returns recent completed runs (excludes in-flight RUNNING rows). */
  getRecent: async (workspaceId: string, limit = 3) => {
    return prisma.agentRun.findMany({
      where: {
        workspaceId,
        status: { not: 'RUNNING' },
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  },

  /** Marks RUNNING rows older than `maxAgeMs` as FAILED (crash recovery). */
  cleanupStale: async (maxAgeMs = 60 * 60 * 1_000) => {
    const cutoff = new Date(Date.now() - maxAgeMs);
    return prisma.agentRun.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'FAILED',
        summary: 'Marked as failed: worker crashed or timed out',
        completedAt: new Date(),
      },
    });
  },
};
