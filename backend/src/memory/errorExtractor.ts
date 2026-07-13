import type { ErrorPattern } from './types';

interface DbMessage {
  role: string;
  content: string;
  toolName?: string;
}

/**
 * Scans tool call results for error-resolution pairs.
 * Uses an LLM to extract patterns from shell output.
 * Returns an empty array on failure (fire-and-forget safe).
 */
export async function extractErrorPatterns(
  messages: DbMessage[],
  llmCall: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<ErrorPattern[]> {
  // Filter to tool-role messages (shell output) — cap at ~4000 tokens
  const toolMessages = messages
    .filter((m) => m.role === 'tool')
    .map((m) => `<tool_output name="${m.toolName || 'tool'}">${m.content.slice(0, 500)}</tool_output>`)
    .join('\n');

  if (!toolMessages || toolMessages.length < 50) return [];

  const cappedInput = toolMessages.slice(0, 16000);

  const systemPrompt = `You are an error pattern extractor. Given tool call outputs from a coding session, identify errors that were encountered AND resolved (the fix is visible in later output).

Return a JSON array of objects with these fields:
- "pattern": a short identifier for the error (e.g., "EADDRINUSE", "ModuleNotFoundError", "TypeScript TS2304")
- "resolution": a brief description of how it was fixed (e.g., "Kill existing process with lsof -ti:PORT | xargs kill")

Only include errors that were ACTUALLY RESOLVED in the session. Do not include errors that are still failing.
Return ONLY valid JSON array. No markdown fences. Return [] if no resolved errors found.`;

  try {
    const raw = await llmCall(systemPrompt, cappedInput);
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    const now = new Date().toISOString();
    return parsed
      .filter((e: any) => e.pattern && e.resolution)
      .slice(0, 20)
      .map((e: any) => ({
        pattern: String(e.pattern).slice(0, 200),
        resolution: String(e.resolution).slice(0, 500),
        frequency: 1,
        lastSeen: now,
      }));
  } catch (err) {
    console.warn('[ErrorExtractor] Failed to extract error patterns:', (err as Error).message);
    return [];
  }
}
