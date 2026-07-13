import { redactSensitive } from "../security/piiGuard";

export function isPrettiMemoryEnabled(): boolean {
  const v = process.env.PRETTI_MEMORY_ENABLED?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return Boolean(process.env.PRETTI_MEMORY_API_KEY?.trim());
}

function pmBaseURL(): string {
  return process.env.PRETTI_MEMORY_BASE_URL || "http://localhost:8080";
}

function pmHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.PRETTI_MEMORY_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function pmPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${pmBaseURL()}${path}`, {
    method: "POST",
    headers: pmHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pretti-memory ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function pmPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${pmBaseURL()}${path}`, {
    method: "PATCH",
    headers: pmHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pretti-memory PATCH ${path} → ${res.status} ${await res.text()}`);
}

/** Container tag for this workspace (used for profile + workspace-specific ingest). */
export function workspaceContainerTag(workspaceId: string): string {
  const id = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const raw = `pf:ws:${id}`;
  if (raw.length <= 100) return raw;
  return raw.slice(0, 100);
}

/**
 * User-level container tag — spans ALL workspaces for this user.
 * Used for cross-project retrieval so knowledge from past projects is accessible in new ones.
 */
export function userContainerTag(userId: string): string {
  const id = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const raw = `pf:user:${id}`;
  if (raw.length <= 100) return raw;
  return raw.slice(0, 100);
}

/**
 * Returns the retrieval tag: user-level if userId provided (cross-project), else workspace-level.
 * Retrieval should always be cross-project when possible — workspace tag only as fallback.
 */
export function retrievalTag(userId: string | undefined, workspaceId: string): string {
  return userId ? userContainerTag(userId) : workspaceContainerTag(workspaceId);
}

function formatProfileLines(
  staticLines: string[] | undefined,
  dynamicLines: string[] | undefined,
): string {
  const st = Array.isArray(staticLines) ? staticLines.filter(Boolean) : [];
  const dy = Array.isArray(dynamicLines) ? dynamicLines.filter(Boolean) : [];
  return [
    st.length ? `Static profile:\n${st.join("\n")}` : "",
    dy.length ? `Dynamic profile:\n${dy.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function searchResultToLine(r: unknown): string {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const obj = r as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content.slice(0, 600);
    if (typeof obj.memory === "string") return obj.memory;
    if (typeof obj.chunk === "string") return obj.chunk.slice(0, 600);
  }
  try {
    return JSON.stringify(r).slice(0, 800);
  } catch {
    return String(r).slice(0, 800);
  }
}

/** In-process cache: container tags already initialized this worker's lifetime. */
const initializedContainerTags = new Set<string>();

/**
 * Sets entityContext on a workspace container tag so pretti-memory extracts AI Agents-relevant facts.
 * Idempotent — in-process Set prevents redundant API calls within a single worker.
 */
export async function ensureContainerTagContext(
  workspaceId: string,
  framework: string,
): Promise<void> {
  if (!isPrettiMemoryEnabled()) return;
  const tag = workspaceContainerTag(workspaceId);
  if (initializedContainerTags.has(tag)) return;
  const entityContext =
    `AI Agents AI coding agent workspace. Framework: ${framework}. ` +
    `Extract as memories: npm/pip packages installed, architecture decisions, ` +
    `frontend and backend port assignments, environment variable names required, ` +
    `common errors and their exact fixes, file structure conventions, ` +
    `user preferences about libraries or patterns, deployment configurations. ` +
    `Do NOT extract: raw code file contents, verbose shell output, ` +
    `tool call argument blobs, system nudge messages, repeated error scaffolding.`;
  try {
    await pmPatch(`/v3/spaces/${encodeURIComponent(tag)}/settings`, { entityContext });
    initializedContainerTags.add(tag);
    console.log(`[pretti-memory] entityContext set containerTag=${tag}`);
  } catch (err) {
    console.warn("[pretti-memory] ensureContainerTagContext failed:", (err as Error).message);
  }
}

/**
 * Fetch profile + search memories for `q`. Returns formatted context block or null.
 */
export async function fetchProfileContextBlock(
  workspaceId: string,
  userId: string,
  q: string,
  framework?: string,
  todoTitle?: string,
): Promise<string | null> {
  if (!isPrettiMemoryEnabled() || !q.trim()) return null;
  const containerTag = userContainerTag(userId);

  const enrichedQ = todoTitle
    ? `${q} ${todoTitle} packages setup common pitfalls ${framework ?? ""}`.slice(0, 4000)
    : q.slice(0, 4000);

  try {
    const profile = await pmPost<{
      profile: { static?: string[]; dynamic?: string[] };
      searchResults: { results: unknown[] };
    }>("/v3/profile", { containerTag, q: enrichedQ, threshold: 0.50 });

    const p = profile.profile;
    const staticPart = formatProfileLines(p?.static, p?.dynamic);
    let results: unknown[] = profile.searchResults?.results ?? [];

    if (results.length === 0 && (!p?.static?.length) && (!p?.dynamic?.length)) {
      try {
        const broadProfile = await pmPost<{
          profile: { static?: string[]; dynamic?: string[] };
          searchResults: { results: unknown[] };
        }>("/v3/profile", { containerTag, q: todoTitle ?? q.slice(0, 500), threshold: 0.35 });
        const broadResults = broadProfile.searchResults?.results ?? [];
        if (broadResults.length > 0) {
          results = broadResults;
          console.log(`[pretti-memory] fetchProfileContextBlock: broad fallback hits=${broadResults.length}`);
        }
      } catch {
        // non-fatal
      }
    }

    const memPart =
      results.length > 0 ? `Relevant memories:\n${results.map(searchResultToLine).join("\n")}` : "";
    const hintsPart =
      results.length > 3
        ? `Predictive hints:\n${results.slice(0, 3).map(searchResultToLine).join("\n")}`
        : "";

    const out = [staticPart, memPart, hintsPart].filter(Boolean).join("\n\n");
    const result = out.trim() || null;
    console.log(
      `[pretti-memory] fetchProfileContextBlock: staticLines=${p?.static?.length ?? 0} dynamicLines=${p?.dynamic?.length ?? 0} memHits=${results.length} hasContext=${!!result}`,
    );
    return result;
  } catch (err) {
    console.warn("[pretti-memory] fetchProfileContextBlock failed:", (err as Error).message);
    return null;
  }
}

export function latestUserMessageContent(
  dbMessages: Array<{ role: string; content?: string }>,
): string | undefined {
  for (let i = dbMessages.length - 1; i >= 0; i--) {
    const m = dbMessages[i];
    if (m.role === "user" && m.content?.trim()) return m.content.trim();
  }
  return undefined;
}

export function buildPrettiMemoryProfileQuery(
  todoTitle: string,
  todoDescription: string | undefined,
  framework: string,
  latestUserContent: string | undefined,
): string {
  const task = todoDescription ? `${todoTitle}: ${todoDescription}` : todoTitle;
  const parts = [
    task,
    `Framework: ${framework}`,
    latestUserContent ? `Latest user message: ${latestUserContent}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * Search pretti-memory for a past fix matching the given error snippet.
 */
export async function fetchErrorFixHint(
  workspaceId: string,
  userId: string,
  errorSnippet: string,
  framework: string,
): Promise<string | null> {
  if (!isPrettiMemoryEnabled() || !errorSnippet.trim()) return null;
  const q = `${errorSnippet.slice(0, 300)} fix solution ${framework}`;
  const workspaceTag = workspaceContainerTag(workspaceId);
  const containerTag = userContainerTag(userId);
  try {
    let res = await pmPost<{ results: unknown[] }>("/v3/memories/search", {
      q,
      containerTag,
      customId: workspaceTag,
      limit: 2,
      threshold: 0.50,
      rerank: true,
    });
    let results = res?.results ?? [];

    if (results.length === 0) {
      res = await pmPost<{ results: unknown[] }>("/v3/memories/search", {
        q,
        containerTag,
        limit: 2,
        threshold: 0.40,
        rerank: false,
      });
      results = res?.results ?? [];
    }

    console.log(`[pretti-memory] fetchErrorFixHint: hits=${results.length}`);
    if (results.length === 0) return null;
    return results.map(searchResultToLine).join("\n");
  } catch (err) {
    console.warn("[pretti-memory] fetchErrorFixHint failed:", (err as Error).message);
    return null;
  }
}

/**
 * Targeted search for memories relevant to what the agent is doing mid-wave.
 */
export async function fetchMidWaveContext(
  workspaceId: string,
  userId: string,
  todoTitle: string,
  latestContent: string | undefined,
  framework: string,
): Promise<string | null> {
  if (!isPrettiMemoryEnabled()) return null;

  const primaryQ = todoTitle.slice(0, 300);
  const cleanContent = latestContent
    ? latestContent.replace(/##.*$/ms, "").replace(/\*\*[^*]+\*\*:?\s*/g, "").trim().slice(0, 150)
    : "";
  const fallbackQ = [todoTitle, cleanContent, framework].filter(Boolean).join(" ").slice(0, 500);
  const containerTag = userContainerTag(userId);

  try {
    let res = await pmPost<{ results: unknown[] }>("/v3/memories/search", {
      q: primaryQ,
      containerTag,
      limit: 3,
      threshold: 0.50,
      rerank: true,
    });
    let results = res?.results ?? [];

    if (results.length === 0) {
      res = await pmPost<{ results: unknown[] }>("/v3/memories/search", {
        q: fallbackQ,
        containerTag,
        limit: 3,
        threshold: 0.35,
        rerank: false,
      });
      results = res?.results ?? [];
    }

    if (results.length === 0) {
      res = await pmPost<{ results: unknown[] }>("/v3/memories/search", {
        q: primaryQ,
        containerTag,
        limit: 3,
        threshold: 0.25,
        rerank: false,
      });
      results = res?.results ?? [];
    }

    console.log(`[pretti-memory] fetchMidWaveContext: hits=${results.length} q="${primaryQ.slice(0, 50)}"`);
    if (results.length === 0) return null;
    return results.map(searchResultToLine).join("\n");
  } catch (err) {
    console.warn("[pretti-memory] fetchMidWaveContext failed:", (err as Error).message);
    return null;
  }
}

const INGEST_MAX_CHARS = 40_000;

export function formatTranscriptForIngest(
  messages: Array<{ role: string; content?: string; toolName?: string }>,
  tailNote?: string,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const snippet = (m.content ?? "").slice(0, 600);
      lines.push(`tool(${m.toolName ?? "?"}): ${redactSensitive(snippet)}`);
      continue;
    }
    if (m.role === "assistant" || m.role === "user") {
      lines.push(`${m.role}: ${redactSensitive(m.content ?? "")}`);
    }
  }
  if (tailNote?.trim()) lines.push(`assistant: ${redactSensitive(tailNote.trim())}`);
  let body = lines.join("\n");
  if (body.length > INGEST_MAX_CHARS) body = body.slice(-INGEST_MAX_CHARS);
  return body;
}

/**
 * Builds a structured summary header followed by the truncated conversation transcript.
 */
export function formatStructuredTodoSummary(opts: {
  workspaceId: string;
  framework: string;
  todoTitle: string;
  todoDescription?: string;
  finalSummary: string;
  modifiedFiles: string[];
  ports?: { frontend?: number; backend?: number };
  messages: Array<{ role: string; content?: string; toolName?: string }>;
}): string {
  const header = [
    `FRAMEWORK: ${opts.framework}`,
    `TASK: ${opts.todoTitle}`,
    opts.todoDescription ? `DESCRIPTION: ${opts.todoDescription.slice(0, 300)}` : "",
    `STATUS: completed`,
    `SUMMARY: ${opts.finalSummary.slice(0, 500)}`,
    opts.modifiedFiles.length
      ? `FILES_MODIFIED:\n${opts.modifiedFiles.slice(0, 20).map((f) => `- ${f}`).join("\n")}`
      : "",
    opts.ports?.frontend ? `FRONTEND_PORT: ${opts.ports.frontend}` : "",
    opts.ports?.backend ? `BACKEND_PORT: ${opts.ports.backend}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const transcript = formatTranscriptForIngest(opts.messages);
  const maxTranscript = Math.max(0, 100_000 - header.length - 20);
  const truncatedTranscript =
    transcript.length > maxTranscript ? transcript.slice(-maxTranscript) : transcript;

  return `${header}\n\nCONVERSATION:\n${truncatedTranscript}`;
}

async function pmAddDocument(payload: Record<string, unknown>): Promise<void> {
  await pmPost("/v3/documents", payload);
}

/**
 * Ingest a completed todo into pretti-memory immediately after it finishes.
 */
export async function ingestTodoCompletion(opts: {
  workspaceId: string;
  userId?: string;
  todoId: string;
  todoTitle: string;
  todoDescription?: string;
  framework: string;
  finalSummary: string;
  modifiedFiles: string[];
  ports?: { frontend?: number; backend?: number };
  messages: Array<{ role: string; content?: string; toolName?: string }>;
}): Promise<void> {
  if (!isPrettiMemoryEnabled()) return;
  const wsTag = workspaceContainerTag(opts.workspaceId);
  const content = formatStructuredTodoSummary(opts);
  const entityContext =
    `AI Agents AI coding agent workspace. Framework: ${opts.framework}. ` +
    `Extract as memories: npm/pip packages installed, architecture decisions, ` +
    `frontend and backend port assignments, environment variable names required, ` +
    `common errors and their exact fixes, file structure conventions, ` +
    `user preferences about libraries or patterns, deployment configurations. ` +
    `Do NOT extract: raw code file contents, verbose shell output, ` +
    `tool call argument blobs, system nudge messages, repeated error scaffolding.`;
  const basePayload = {
    content: content.slice(0, 100_000),
    taskType: "memory",
    entityContext,
    metadata: {
      source: "ai-agents-agent",
      workspaceId: opts.workspaceId,
      framework: opts.framework,
      todoTitle: opts.todoTitle.slice(0, 64),
      success: true,
    },
  };
  try {
    const todoCustomId = `todo:${wsTag}:${opts.todoId.slice(0, 20)}`;
    await pmAddDocument({ ...basePayload, containerTag: wsTag, customId: todoCustomId });
    if (opts.userId) {
      await pmAddDocument({
        ...basePayload,
        containerTag: userContainerTag(opts.userId),
        customId: `user:${todoCustomId}`,
      });
    }
    console.log(
      `[pretti-memory] ingestTodoCompletion ok todoId=${opts.todoId.slice(0, 12)}… dualIngest=${!!opts.userId}`,
    );
  } catch (err) {
    console.warn("[pretti-memory] ingestTodoCompletion failed:", (err as Error).message);
  }
}

/**
 * Ingest wave-level task knowledge immediately after a wave completes.
 */
export async function ingestWaveCompletion(opts: {
  workspaceId: string;
  userId?: string;
  todoTitle: string;
  framework: string;
  summary: string;
  filesChanged: string[];
  errorFixed?: string;
  decision?: string;
  waveIndex?: number;
}): Promise<void> {
  if (!isPrettiMemoryEnabled()) return;
  const wsTag = workspaceContainerTag(opts.workspaceId);
  const wsShort = opts.workspaceId.slice(0, 12);

  const lines = [
    `Task: ${opts.todoTitle}`,
    `Framework: ${opts.framework}`,
    `Done: ${opts.summary.slice(0, 400)}`,
    opts.filesChanged.length ? `Files: ${opts.filesChanged.slice(0, 8).join(", ")}` : "",
    opts.errorFixed ? `Fixed error: ${opts.errorFixed.slice(0, 200)}` : "",
    opts.decision ? `Decision: ${opts.decision.slice(0, 200)}` : "",
  ].filter(Boolean);

  const content = redactSensitive(lines.join("\n"));
  const customId = `wave:${wsTag}:${opts.todoTitle.slice(0, 40).replace(/\s+/g, "_")}`;
  const basePayload = {
    content,
    taskType: "memory",
    customId,
    metadata: {
      source: "ai-agents-wave",
      framework: opts.framework,
      workspaceId: opts.workspaceId,
      todoTitle: opts.todoTitle.slice(0, 64),
      waveIndex: opts.waveIndex ?? 0,
    },
  };

  try {
    await pmAddDocument({ ...basePayload, containerTag: wsTag });
    if (opts.userId) {
      await pmAddDocument({
        ...basePayload,
        containerTag: userContainerTag(opts.userId),
        customId: `user:${customId}`,
      });
    }
    console.log(
      `[pretti-memory] ingestWaveCompletion ok title="${opts.todoTitle.slice(0, 40)}" workspace=${wsShort}… dualIngest=${!!opts.userId}`,
    );
  } catch (err) {
    console.warn("[pretti-memory] ingestWaveCompletion failed:", (err as Error).message);
  }
}

/**
 * Ingest a full run transcript into pretti-memory (legacy path — kept for non-todo runs).
 */
export async function ingestAgentTranscript(workspaceId: string, content: string): Promise<void> {
  if (!isPrettiMemoryEnabled() || !content.trim()) return;
  const containerTag = workspaceContainerTag(workspaceId);
  try {
    await pmAddDocument({
      content: redactSensitive(content.slice(0, 100_000)),
      containerTag,
      customId: containerTag,
      metadata: { source: "ai-agents-agent", workspaceId },
    });
    console.log(
      `[pretti-memory] add ok workspace=${workspaceId.slice(0, 12)}… containerTagLen=${containerTag.length}`,
    );
  } catch (err) {
    console.warn("[pretti-memory] add failed:", (err as Error).message);
  }
}

/**
 * Create tightly structured fact memories directly (immediately searchable, bypasses extraction).
 */
export async function createRunFactMemories(opts: {
  workspaceId: string;
  userId?: string;
  framework: string;
  frontendPort?: number;
  backendPort?: number;
  modifiedFiles: string[];
  todoTitle?: string;
  runSummary?: string;
}): Promise<void> {
  if (!isPrettiMemoryEnabled()) return;
  const wsTag = workspaceContainerTag(opts.workspaceId);
  const wsShort = opts.workspaceId.slice(0, 12);

  const lines: string[] = [];
  if (opts.todoTitle) lines.push(`Task completed: ${opts.todoTitle}`);
  if (opts.runSummary) lines.push(`Outcome: ${opts.runSummary.slice(0, 300)}`);
  if (opts.frontendPort)
    lines.push(`Workspace ${wsShort} (${opts.framework}): frontend runs on port ${opts.frontendPort}.`);
  if (opts.backendPort)
    lines.push(`Workspace ${wsShort}: backend API runs on port ${opts.backendPort}.`);
  if (opts.modifiedFiles.length > 0)
    lines.push(`Workspace ${wsShort} key files: ${opts.modifiedFiles.slice(0, 20).join(", ")}.`);

  if (lines.length === 0) return;
  const basePayload = {
    content: redactSensitive(lines.join("\n")),
    taskType: "memory",
    metadata: {
      source: "ai-agents-facts",
      framework: opts.framework,
      workspaceId: opts.workspaceId,
    },
  };
  try {
    await pmAddDocument({ ...basePayload, containerTag: wsTag, customId: `facts:${wsTag}` });
    if (opts.userId) {
      await pmAddDocument({
        ...basePayload,
        containerTag: userContainerTag(opts.userId),
        customId: `user:facts:${wsTag}`,
      });
    }
    console.log(
      `[pretti-memory] createRunFactMemories ok count=${lines.length} workspace=${wsShort}… dualIngest=${!!opts.userId}`,
    );
  } catch (err) {
    console.warn("[pretti-memory] createRunFactMemories failed:", (err as Error).message);
  }
}
