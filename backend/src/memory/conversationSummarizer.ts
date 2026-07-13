interface DbMessage {
  role: string;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ConversationDigest {
  summary: string;
  keyDecisions: string[];
  resolvedErrors: string[];
  filesModified: string[];
}

/**
 * Summarizes an array of dropped messages into a compact digest.
 * Uses a lightweight LLM call. Returns null on failure so the caller
 * can fall back to the current hard-trim behavior.
 */
export async function summarizeDroppedMessages(
  messages: DbMessage[],
  llmCall: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<ConversationDigest | null> {
  if (messages.length === 0) return null;

  // Build a condensed transcript from the dropped messages
  const transcript = messages
    .map((m) => {
      const content = m.content.slice(0, 300);
      if (m.role === 'tool') return `<tool_output name="${m.toolName || 'unknown'}">${m.content.slice(0, 200)}</tool_output>`;
      if (m.role === 'assistant' && m.toolCalls) return `<assistant_tool_call>${m.toolCalls.slice(0, 200)}</assistant_tool_call>`;
      return `<${m.role}>${content}</${m.role}>`;
    })
    .join('\n');

  // Cap input to ~4000 tokens worth of text
  const cappedTranscript = transcript.slice(0, 16000);

  const systemPrompt = `You are a conversation summarizer. Given a transcript of an AI coding session, produce a JSON object with these fields:
- "summary": a 200-400 token summary of what happened
- "keyDecisions": array of strings listing architectural/design choices made
- "resolvedErrors": array of strings listing errors that were encountered and fixed
- "filesModified": array of file paths that were created or edited

Return ONLY valid JSON. No markdown fences.`;

  try {
    const raw = await llmCall(systemPrompt, cappedTranscript);
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      summary: String(parsed.summary || '').slice(0, 2000),
      keyDecisions: Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions.map(String).slice(0, 20) : [],
      resolvedErrors: Array.isArray(parsed.resolvedErrors) ? parsed.resolvedErrors.map(String).slice(0, 20) : [],
      filesModified: Array.isArray(parsed.filesModified) ? parsed.filesModified.map(String).slice(0, 50) : [],
    };
  } catch (err) {
    console.warn('[ConversationSummarizer] Failed to summarize dropped messages:', (err as Error).message);
    return null;
  }
}

/** Formats a ConversationDigest into a system-injected message. */
export function formatDigestAsMessage(digest: ConversationDigest): DbMessage {
  const parts: string[] = [
    '--- CONVERSATION SUMMARY (earlier messages were trimmed) ---',
    digest.summary,
  ];

  if (digest.keyDecisions.length > 0) {
    parts.push(`Key decisions: ${digest.keyDecisions.join('; ')}`);
  }
  if (digest.resolvedErrors.length > 0) {
    parts.push(`Resolved errors: ${digest.resolvedErrors.join('; ')}`);
  }
  if (digest.filesModified.length > 0) {
    parts.push(`Files modified: ${digest.filesModified.join(', ')}`);
  }
  parts.push('--- END SUMMARY ---');

  return {
    role: 'system',
    content: parts.join('\n'),
  };
}
