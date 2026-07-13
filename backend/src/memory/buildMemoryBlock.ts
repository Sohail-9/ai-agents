import type { ErrorPattern, DecisionRecord, StructuredMemory } from './types';

interface AgentRunSummary {
  status: string;
  summary: string | null;
  port: number | null;
  backendPort: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

interface WorkspaceMemoryRecord {
  details: unknown;
}

interface BuildMemoryBlockInput {
  recentRuns: AgentRunSummary[];
  workspaceMemory: WorkspaceMemoryRecord | null;
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  // Conservative estimate: 1 token ~= 3 chars (English text averages ~1.3-4 chars/token)
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n...(truncated)';
}

function renderRecentRuns(runs: AgentRunSummary[]): string {
  if (runs.length === 0) return '';
  const lines = runs.map((run, i) => {
    const ports = [
      run.port ? `frontend=${run.port}` : null,
      run.backendPort ? `backend=${run.backendPort}` : null,
    ].filter(Boolean).join(', ');
    const portsStr = ports ? ` (ports: ${ports})` : '';
    const summary = run.summary ? ` — "${run.summary.slice(0, 120)}"` : '';
    return `- Run ${i + 1}: ${run.status}${summary}${portsStr}`;
  });
  return `### Recent Runs\n${lines.join('\n')}`;
}

function renderConfig(config: Record<string, unknown>): string {
  const lines: string[] = [];
  const knownPorts = config.knownPorts as Record<string, number> | undefined;
  if (knownPorts && typeof knownPorts === 'object') {
    const portEntries = Object.entries(knownPorts).map(([k, v]) => `${k}=${v}`).join(', ');
    if (portEntries) lines.push(`- Known ports: ${portEntries}`);
  }
  for (const [key, val] of Object.entries(config)) {
    if (key === 'knownPorts' || key === 'updatedAt') continue;
    lines.push(`- ${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
  }
  if (lines.length === 0) return '';
  return truncateToTokenBudget(`### Config\n${lines.join('\n')}`, 200);
}

function renderErrors(errors: ErrorPattern[]): string {
  if (errors.length === 0) return '';
  // Show last 5, most recent first
  const recent = errors.slice(-5).reverse();
  const lines = recent.map((e) =>
    `- \`${e.pattern}\`: ${e.resolution} (seen ${e.frequency}x, last: ${e.lastSeen.slice(0, 10)})`
  );
  return truncateToTokenBudget(`### Known Error Patterns\n${lines.join('\n')}`, 500);
}

function renderArchitecture(arch: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(arch)) {
    if (key === 'updatedAt') continue;
    lines.push(`- ${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
  }
  if (lines.length === 0) return '';
  return truncateToTokenBudget(`### Architecture\n${lines.join('\n')}`, 800);
}

function renderDecisions(decisions: DecisionRecord[]): string {
  if (decisions.length === 0) return '';
  const recent = decisions.slice(-5).reverse();
  const lines = recent.map((d) => `- ${d.decision}: ${d.reason}`);
  return truncateToTokenBudget(`### Recent Decisions\n${lines.join('\n')}`, 300);
}

function renderPreferences(prefs: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(prefs)) {
    if (key === 'updatedAt') continue;
    lines.push(`- ${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
  }
  if (lines.length === 0) return '';
  return truncateToTokenBudget(`### Preferences\n${lines.join('\n')}`, 200);
}

export function buildMemoryBlock({ recentRuns, workspaceMemory }: BuildMemoryBlockInput): string {
  const sections: string[] = [];

  // Recent runs (always rendered first)
  const runsBlock = renderRecentRuns(recentRuns);
  if (runsBlock) sections.push(runsBlock);

  // Parse structured memory from details blob
  const rawDetails = workspaceMemory?.details;
  const details = (rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
    ? rawDetails : {}) as StructuredMemory & Record<string, unknown>;

  // Priority order: config > errors > architecture > decisions > preferences
  const config = (details.config ?? {}) as Record<string, unknown>;
  // Backward compat: if there's no config category but there are top-level keys like knownPorts
  const hasLegacyKeys = !details.config && Object.keys(details).some((k) => !['errors', 'architecture', 'decisions', 'preferences'].includes(k));
  const configBlock = renderConfig(hasLegacyKeys ? details as Record<string, unknown> : config);
  if (configBlock) sections.push(configBlock);

  const errors = Array.isArray(details.errors)
    ? (details.errors as ErrorPattern[]).filter((e) => e && typeof e.pattern === 'string' && typeof e.resolution === 'string')
    : [];
  const errorsBlock = renderErrors(errors);
  if (errorsBlock) sections.push(errorsBlock);

  const arch = (details.architecture ?? {}) as Record<string, unknown>;
  const archBlock = renderArchitecture(arch);
  if (archBlock) sections.push(archBlock);

  const decisions = Array.isArray(details.decisions)
    ? (details.decisions as DecisionRecord[]).filter((d) => d && typeof d.decision === 'string' && typeof d.reason === 'string')
    : [];
  const decisionsBlock = renderDecisions(decisions);
  if (decisionsBlock) sections.push(decisionsBlock);

  const prefs = (details.preferences ?? {}) as Record<string, unknown>;
  const prefsBlock = renderPreferences(prefs);
  if (prefsBlock) sections.push(prefsBlock);

  if (sections.length === 0) return '';
  return `## Workspace Memory\n${sections.join('\n\n')}`;
}
