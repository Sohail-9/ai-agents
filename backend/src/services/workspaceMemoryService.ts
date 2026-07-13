import { prisma } from '../lib/prisma';
import type { MemoryCategory, ErrorPattern, DecisionRecord } from '../memory/types';
import { upsertEmbedding } from '../memory/embeddingService';

/** Recursively merges source into target. Arrays are replaced, not concatenated. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/** Shared read-modify-write for array fields in the details blob. Cap at 10, sync embedding. */
async function appendToArrayField<T>(
  workspaceId: string,
  field: string,
  _item: T,
  mutate: (items: T[]) => T[],
  embedContent: (capped: T[]) => string,
  embeddingKey: string,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.workspaceMemory.findUnique({ where: { workspaceId } });
    const details = (existing?.details ?? {}) as Record<string, unknown>;
    const items = Array.isArray(details[field]) ? [...details[field]] as T[] : [];

    const mutated = mutate(items);
    const capped = mutated.slice(-10);

    const merged = { ...details, [field]: capped };
    const result = await tx.workspaceMemory.upsert({
      where: { workspaceId },
      create: { workspaceId, details: merged as any },
      update: { details: merged as any },
    });
    const content = embedContent(capped).slice(0, 2000);
    upsertEmbedding(workspaceId, field, embeddingKey, content).catch((err) =>
      console.warn(`[WorkspaceMemory] ${field} embedding sync failed:`, (err as Error).message),
    );
    return result;
  });
}

export const workspaceMemoryService = {
  get: async (workspaceId: string) => {
    return prisma.workspaceMemory.findUnique({
      where: { workspaceId },
    });
  },

  upsert: async (workspaceId: string, data: Record<string, unknown>) => {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.workspaceMemory.findUnique({
        where: { workspaceId },
      });

      const existingDetails = (existing?.details ?? {}) as Record<string, unknown>;
      const merged = deepMerge(existingDetails, data);

      return tx.workspaceMemory.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          details: merged as any,
        },
        update: {
          details: merged as any,
        },
      });
    });
  },

  /** Deep-merge data into a specific category within the details blob. */
  upsertCategory: async (workspaceId: string, category: MemoryCategory, data: Record<string, unknown>) => {
    const result = await workspaceMemoryService.upsert(workspaceId, { [category]: data });
    const content = JSON.stringify(data).slice(0, 2000);
    await upsertEmbedding(workspaceId, category, 'latest', content).catch((err) =>
      console.warn('[WorkspaceMemory] Embedding sync failed:', (err as Error).message),
    );
    return result;
  },

  /** Return a single category from the details blob, or null. */
  getCategory: async (workspaceId: string, category: MemoryCategory) => {
    const record = await prisma.workspaceMemory.findUnique({ where: { workspaceId } });
    if (!record) return null;
    const details = (record.details ?? {}) as Record<string, unknown>;
    return (details[category] as Record<string, unknown> | undefined) ?? null;
  },

  /** Append an error pattern, deduplicating by pattern string. Cap at 10. */
  appendError: async (workspaceId: string, error: ErrorPattern) => {
    return appendToArrayField<ErrorPattern>(
      workspaceId,
      'errors',
      error,
      (items) => {
        const idx = items.findIndex((e) => e.pattern === error.pattern);
        if (idx >= 0) {
          return items.map((e, i) =>
            i === idx
              ? { ...e, resolution: error.resolution, frequency: (e.frequency || 0) + 1, lastSeen: error.lastSeen }
              : e,
          );
        }
        return [...items, error];
      },
      (capped) => capped.map((e) => `${e.pattern}: ${e.resolution}`).join('\n'),
      'patterns',
    );
  },

  /** Append a decision record. Cap at 10. */
  appendDecision: async (workspaceId: string, decision: DecisionRecord) => {
    return appendToArrayField<DecisionRecord>(
      workspaceId,
      'decisions',
      decision,
      (items) => [...items, decision],
      (capped) => capped.map((d) => `${d.decision}: ${d.reason}`).join('\n'),
      'recent',
    );
  },
};
