/**
 * Updates aiAgentsMd (project context) after each successful run.
 * Returns the updated markdown string, or null on failure
 * (caller keeps existing aiAgentsMd unchanged).
 */
export async function updateProjectContext(
  currentMd: string,
  runSummary: string,
  modifiedFiles: string[],
  llmCall: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<string | null> {
  if (!currentMd && !runSummary) return null;

  const systemPrompt = `You are a technical writer updating a project description. Given the current project description and a summary of changes made in a recent coding session, produce an updated description.

Rules:
- Keep under 500 words
- Focus on what the project actually does NOW
- Include key technical decisions and stack choices
- Mention important file structure changes
- Do NOT include session timestamps or run IDs
- Preserve any existing information that is still accurate
- Write in present tense`;

  const userContent = `CURRENT PROJECT DESCRIPTION:
${currentMd || '(no existing description)'}

CHANGES IN THIS RUN:
${runSummary || '(no summary)'}

FILES MODIFIED:
${modifiedFiles.length > 0 ? modifiedFiles.join('\n') : '(none)'}`;

  try {
    const updated = await llmCall(systemPrompt, userContent);
    if (!updated || updated.length < 20) return null;
    return updated.trim();
  } catch (err) {
    console.warn('[ProjectContextUpdater] Failed to update aiAgentsMd:', (err as Error).message);
    return null;
  }
}
