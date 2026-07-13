# Supermemory Integration Guide

Complete re-implementation of Supermemory integration for per-workspace agent context and transcript ingestion.

## Setup

### Environment Variables

```bash
SUPERMEMORY_API_KEY=<your-api-key>
SUPERMEMORY_ENABLED=true  # Set to false, 0, or off to disable
```

## Core Functions

### Initialization & Configuration

- **`isSupermemoryEnabled()`** — Check if Supermemory is enabled (requires API key + enabled flag)
- **`ensureOrgSettings()`** — Set org-wide filter prompt (call once at startup)
- **`ensureContainerTagContext(workspaceId, framework)`** — Initialize workspace context (idempotent)

### Container Tags

- **`workspaceContainerTag(workspaceId)`** — Tag for workspace-specific memories
- **`userContainerTag(userId)`** — Tag for cross-workspace user memories
- **`retrievalTag(userId, workspaceId)`** — Choose retrieval scope (user→cross-project, workspace→local)

### Profile & Context Retrieval

- **`fetchProfileContextBlock(workspaceTag, q, framework?, userId?)`**
  - Fetch workspace profile + framework patterns
  - Returns formatted context block or null
  - Runs in parallel with other retrieval at wave start (no latency cost)

- **`fetchPredictiveHints(workspaceId, todoTitle, framework, userId?)`**
  - Packages, setup steps, pitfalls for upcoming task
  - Threshold: 0.68 (wider net)

- **`fetchMidWaveContext(workspaceId, todoTitle, latestContent?, framework, userId?)`**
  - Memories relevant during task execution
  - Threshold: 0.65 (widest net)

- **`fetchErrorFixHint(workspaceId, errorSnippet, framework, userId?)`**
  - Past solutions for error scenarios
  - Threshold: 0.72 (high confidence)

### Transcript Ingestion

- **`formatTranscriptForIngest(messages, tailNote?)`** — Format conversation for Supermemory ingest
- **`formatStructuredTodoSummary(opts)`** — Structured header + truncated transcript
- **`ingestTodoCompletion(opts)`**
  - Ingest completed todo (dual container tag if userId)
  - Fire-and-forget safe
  - Includes workspace + user-level memory

- **`ingestAgentTranscript(workspaceId, content)`** — Legacy ingestion path

### Fact Memories

- **`createRunFactMemories(opts)`**
  - Port assignments, file inventory
  - High-signal, low-noise facts
  - Called at run end

## Usage Pattern

### At Wave Start

```typescript
const [profile, hints] = await Promise.all([
  fetchProfileContextBlock(wsTag, query, framework, userId),
  fetchPredictiveHints(wsId, todoTitle, framework, userId),
]);

const context = [profile, hints].filter(Boolean).join("\n\n");
// Include `context` in agent prompt
```

### During Wave (Iteration 1-2)

```typescript
const midContext = await fetchMidWaveContext(wsId, todoTitle, latestUserMsg, framework, userId);
if (midContext) {
  // Inject into next LLM call
}
```

### On Error

```typescript
if (shellError) {
  const fix = await fetchErrorFixHint(wsId, errorSnippet, framework, userId);
  if (fix) {
    // Surface fix hint before retry
  }
}
```

### At Completion

```typescript
// Ingest completed work
await ingestTodoCompletion({
  workspaceId,
  userId,
  todoId,
  todoTitle,
  todoDescription,
  framework,
  finalSummary,
  modifiedFiles,
  ports: { frontend, backend },
  messages,
});

// Store fact memories
await createRunFactMemories({
  workspaceId,
  userId,
  framework,
  frontendPort,
  backendPort,
  modifiedFiles,
});
```

## Container Tag Scoping

- **Workspace tag** (`pf:ws:*`) — Workspace-specific facts, decisions, architecture
- **User tag** (`pf:user:*`) — Cross-project patterns, error solutions, framework preferences
- **Retrieval priority** — User tag if available (cross-project knowledge), else workspace tag

## Search Thresholds

| Scenario | Threshold | Reason |
|----------|-----------|--------|
| Profile + static facts | 0.65 | Broad retrieval |
| Predictive hints | 0.68 | Slightly narrower |
| Mid-wave context | 0.65 | Broader (execution-time) |
| Error fixes | 0.72 | High confidence required |

## Content Filters

### Indexed

- npm/pip packages, architecture decisions, ports, env var names
- Error messages + exact fixes, file structure, user preferences
- Deployment configs, framework choices

### Ignored

- Raw code file contents, verbose shell output
- Tool call argument blobs, system nudge messages
- Repeated error scaffolding

## Implementation Details

- **Singleton client** — `getClient()` reuses instance across requests
- **Idempotent context** — In-process Set prevents redundant API calls
- **Fire-and-forget ingestion** — Errors logged, not thrown
- **Dual ingestion** — Workspace + user tags when userId provided
- **Transcript truncation** — Last 40KB for ingest, last N chars for structured summary
