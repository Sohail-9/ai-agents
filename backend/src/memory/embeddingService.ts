import OpenAI from 'openai';
import { prisma } from '../lib/prisma';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;

/** Validates and serializes an embedding array into a pgvector-safe string. */
function toSafeVectorString(embedding: number[]): string {
  if (!embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Invalid embedding: contains non-finite values');
  }
  return `[${embedding.join(',')}]`;
}

// Module-level cached client — avoids creating a new instance per call
let cachedClient: OpenAI | null | undefined;

function getOpenAIClient(): OpenAI | null {
  if (cachedClient !== undefined) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY || null;
  cachedClient = apiKey ? new OpenAI({ apiKey }) : null;
  return cachedClient;
}

/** Generate an embedding vector for the given text. Returns null if no API key. */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  const resp = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // cap input to ~2000 tokens
  });

  return resp.data[0].embedding;
}

/** Store or update an embedding for a memory entry. */
export async function upsertEmbedding(
  workspaceId: string,
  category: string,
  key: string,
  content: string,
): Promise<void> {
  const embedding = await generateEmbedding(content);
  if (!embedding) {
    console.warn('[EmbeddingService] No OpenAI key — skipping embedding for', category, key);
    return;
  }

  const vectorStr = toSafeVectorString(embedding);

  // Upsert the row via Prisma, then set the vector column via raw SQL
  const record = await prisma.memoryEmbedding.upsert({
    where: {
      workspaceId_category_key: { workspaceId, category, key },
    },
    create: { workspaceId, category, key, content },
    update: { content },
  });

  await prisma.$executeRawUnsafe(
    `UPDATE "MemoryEmbedding" SET "embedding" = $1::vector WHERE "id" = $2`,
    vectorStr,
    record.id,
  );
}

/** Find top-K most relevant memory entries for a given query. */
export async function findRelevantMemories(
  workspaceId: string,
  query: string,
  limit: number = 5,
): Promise<Array<{ category: string; key: string; content: string; similarity: number }>> {
  const embedding = await generateEmbedding(query);
  if (!embedding) return [];

  const vectorStr = toSafeVectorString(embedding);

  // Cosine similarity via pgvector (<=> returns distance, so 1 - distance = similarity)
  // Filter at SQL level: only return entries with similarity > 0.3
  const results = await prisma.$queryRawUnsafe<
    Array<{ category: string; key: string; content: string; similarity: number }>
  >(
    `SELECT "category", "key", "content",
            1 - ("embedding" <=> $1::vector) as "similarity"
     FROM "MemoryEmbedding"
     WHERE "workspaceId" = $2
       AND "embedding" IS NOT NULL
       AND 1 - ("embedding" <=> $1::vector) > 0.3
     ORDER BY "embedding" <=> $1::vector
     LIMIT $3`,
    vectorStr,
    workspaceId,
    limit,
  );

  return results;
}
