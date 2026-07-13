import { findRelevantMemories } from './embeddingService';
import { buildMemoryBlock, truncateToTokenBudget } from './buildMemoryBlock';

interface RetrievalContext {
  currentTask: string;
  framework: string;
  recentErrors: string[];
}

interface MemoryBlockInput {
  recentRuns: Array<{
    status: string;
    summary: string | null;
    port: number | null;
    backendPort: number | null;
    startedAt: Date;
    completedAt: Date | null;
  }>;
  workspaceMemory: { details: unknown } | null;
}

/**
 * Retrieves relevant memories using vector similarity + static memory block.
 * Falls back to static buildMemoryBlock if vector search is unavailable.
 */
export async function retrieveRelevantMemory(
  workspaceId: string,
  context: RetrievalContext,
  staticInput: MemoryBlockInput,
  tokenBudget: number = 2000,
): Promise<string> {
  // Always build the static block as the foundation
  const staticBlock = buildMemoryBlock(staticInput);

  // Try vector search to augment with relevant memories
  try {
    const query = [
      context.currentTask,
      context.framework ? `Framework: ${context.framework}` : '',
      context.recentErrors.length > 0 ? `Recent errors: ${context.recentErrors.join(', ')}` : '',
    ].filter(Boolean).join('. ');

    if (!query.trim()) return staticBlock;

    const relevant = await findRelevantMemories(workspaceId, query, 5);

    // Similarity > 0.3 filtering is done in SQL by findRelevantMemories
    if (relevant.length === 0) return staticBlock;

    // Build the vector-retrieved section
    const vectorLines = relevant.map((r) =>
      `- [${r.category}/${r.key}] (relevance: ${(r.similarity * 100).toFixed(0)}%) ${r.content.slice(0, 200)}`
    );
    const vectorSection = `### Relevant Context\n${vectorLines.join('\n')}`;

    // Combine: static block + vector results, within token budget
    const combined = staticBlock
      ? `${staticBlock}\n\n${vectorSection}`
      : vectorSection;

    return truncateToTokenBudget(combined, tokenBudget);
  } catch (err) {
    console.warn('[MemoryRetriever] Vector search failed, using static block:', (err as Error).message);
    return staticBlock;
  }
}
