# Supermemory Integration in AI Agents

## Overview

Supermemory is an optional, cloud-based memory system that provides per-workspace and cross-project context for AI Agents agents. It enables:

- **Profile + Recall**: Fetching static/dynamic profiles and relevant memories for task execution
- **Transcript Ingest**: Storing completed tasks and conversations for future retrieval
- **Error Fix Hints**: Surfacing known solutions after a task fails
- **Predictive Hints**: Pre-loading common packages, setup steps, and pitfalls before tasks start
- **Cross-Project Knowledge**: Reusing learnings across workspaces via user-level container tags

### Activation

Supermemory is **optional** and requires two environment variables:
- `SUPERMEMORY_API_KEY`: Valid API key for Supermemory service
- `SUPERMEMORY_ENABLED`: Set to any truthy value (not "0", "false", "off", "no")

If either is missing, supermemory gracefully disables and falls back to local vector memory.

---

## Architecture

### File Locations

| File | Purpose |
|------|---------|
| `/backend/src/memory/supermemoryAgent.ts` | Core supermemory client and API integration |
| `/backend/src/brain/agentRunner.ts` | Integration with agent execution loop |
| `/backend/src/workers/agentWorker.ts` | Memory ingest after task completion |

### Dual-Parameter Isolation: `customId` + `containerTag`

Supermemory uses **two parameters for nested isolation**:

#### 1. `customId` — Workspace Isolation Filter
```
Value: workspaceId (e.g., "abc-123-def")
Purpose: Workspace-level isolation & filtering at query time
Scope: Identifies which workspace a memory belongs to
Usage: Both ingest AND retrieval use this for filtering
```

**In Queries**:
```typescript
client.search.memories({
  containerTag: "pf:ws:abc123",  // scope boundary
  customId: "abc-123-def",        // workspace filter
  q: "query",
  limit: 3
})
```

Filters results to memories from workspace `abc-123-def` only.

#### 2. `containerTag` — Scope Boundary
```
Value: Either pf:ws:{workspaceId} OR pf:user:{userId}
Purpose: Determines WHERE memory is stored & retrieved
Scope: Workspace-level or user-level (cross-project)
```

**Workspace Scope** (`pf:ws:...`):
```
Format: pf:ws:{workspaceId}
Example: pf:ws:abc123
Access: Single workspace only
Content: Workspace-specific memories
```

**User Scope** (`pf:user:...`):
```
Format: pf:user:{userId}
Example: pf:user:alice_123
Access: ALL workspaces for that user
Content: Cross-project learnings, frameworks, patterns
```

---

## Data Ingest: Adding Memory to Supermemory

### Dual Ingest Pattern

Every memory is written **twice** with different scopes:

```
Memory: Todo Completion (e.g., JWT Auth)
│
├─ Write 1: WORKSPACE ISOLATION
│  ├─ containerTag: pf:ws:workspace-123
│  ├─ customId: workspace-123 (isolation)
│  └─ Result: Only this workspace can retrieve
│
└─ Write 2: USER-LEVEL (if userId present)
   ├─ containerTag: pf:user:alice
   ├─ customId: workspace-123 (workspace-scoped)
   └─ Result: Cross-project access, workspace-filtered
```

**Benefits**:
- Workspace isolation prevents data leakage between projects
- User-level reuse enables cross-project knowledge
- `customId` acts as filter even in user container

---

### 1. Configuration & Setup

#### Org-Wide Settings
Called once during startup:

```typescript
export async function ensureOrgSettings(): Promise<void>
```

Sets org-wide filter prompt so Supermemory indexes only AI Agents-relevant content.

**Skips**: raw code, verbose shell output, system messages, repeated errors

---

#### Workspace Container Context
Called on first run of a workspace:

```typescript
export async function ensureContainerTagContext(
  workspaceId: string,
  framework: string,
): Promise<void>
```

Sets `entityContext` on workspace container to guide extraction.

**Endpoint**: `PATCH /api.supermemory.ai/v3/containerTags/{tag}/settings`

**Cache**: In-process Set (`initializedContainerTags`) prevents redundant API calls within worker lifetime.

---

### 2. Todo Completion Ingest

After task completion, full transcript + metadata is ingested:

```typescript
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
}): Promise<void>
```

#### Data Format

**Header Section** (structured facts):
```
FRAMEWORK: Next.js
TASK: Add authentication
DESCRIPTION: Implement JWT-based auth
STATUS: completed
SUMMARY: Added login endpoint with JWT tokens
FILES_MODIFIED:
- src/pages/api/auth/login.ts
- src/lib/jwt.ts
FRONTEND_PORT: 3000
BACKEND_PORT: 8000
```

**Conversation Section** (redacted transcript):
```
CONVERSATION:
user: Add JWT auth to the API
assistant: I'll create a login endpoint with JWT token generation
tool(execute_shell): npm install jsonwebtoken
assistant: Authentication system implemented
...
```

#### Addition Pattern

**Code** (from supermemoryAgent.ts:432-442):
```typescript
// Write 1: Workspace isolation
await client.add({
  content: formatted_summary,
  containerTag: wsTag,           // pf:ws:{workspaceId}
  customId: opts.workspaceId,    // workspace isolation filter
  taskType: "memory",
  entityContext: <context>,
  metadata: { source: "ai-agents-agent", workspaceId, framework, success: true }
})

// Write 2: User-level (if userId present)
if (opts.userId) {
  await client.add({
    content: formatted_summary,
    containerTag: userContainerTag(opts.userId),  // pf:user:{userId}
    customId: opts.workspaceId,   // still workspace-scoped
    taskType: "memory",
    entityContext: <context>,
    metadata: { ... }
  })
}
```

**Result**:
- Workspace container: isolated, not accessible to other workspaces
- User container: cross-project, but `customId` filter enables workspace-level retrieval if needed

---

### 3. Fact Memory Creation

Structured facts for high-signal, low-noise memories:

```typescript
export async function createRunFactMemories(opts: {
  workspaceId: string;
  userId?: string;
  framework: string;
  frontendPort?: number;
  backendPort?: number;
  modifiedFiles: string[];
}): Promise<void>
```

**Content**:
```
Workspace abc123 (Next.js): frontend runs on port 3000.
Workspace abc123: backend API runs on port 8000.
Workspace abc123 key files: src/pages/index.tsx, src/api/auth.ts.
```

**Storage** (same dual ingest):
```typescript
await client.add({
  containerTag: wsTag,
  customId: opts.workspaceId,  // workspace isolation
  ...
})

if (opts.userId) {
  await client.add({
    containerTag: userContainerTag(opts.userId),
    customId: opts.workspaceId,  // workspace filter in user container
    ...
  })
}
```

---

## Data Retrieval: Fetching Memory

### Retrieval Pattern

All retrieval queries include **both parameters**:

```typescript
client.search.memories({
  containerTag: tag,           // scope: workspace OR user-level
  customId: workspaceId,       // filter: this workspace only
  q: query_string,
  limit: 3,
  threshold: 0.70,
  rerank: true
})
```

**Filtering Logic**:
- `containerTag` determines WHERE to search (workspace or user container)
- `customId` filters results to memories for THIS workspace only
- Together: scope + workspace isolation

---

### 1. Wave Start: Profile + Predictive Hints

Called at task execution start:

```typescript
export async function fetchProfileContextBlock(
  workspaceId: string,
  q: string,
  framework?: string,
  userId?: string,
  todoTitle?: string,
): Promise<string | null>
```

**Code** (from supermemoryAgent.ts:184-200):
```typescript
const [profile, hintsRaw] = await Promise.all([
  client.profile({
    containerTag: workspaceTag,      // pf:ws:{workspaceId}
    customId: workspaceId,           // workspace filter
    q: q.slice(0, 4000),
    threshold: 0.65,
  }),
  hintsQ ? client.search.memories({
    q: hintsQ,
    containerTag: workspaceTag,
    customId: workspaceId,           // workspace filter
    limit: 3,
    threshold: 0.70,
    rerank: true,
  }).catch(() => null) : Promise.resolve(null),
])
```

**Output**:
```
### Supermemory (profile + recall)
Static profile:
Next.js app uses port 3000
Database: PostgreSQL

Relevant memories:
[Workspace-filtered solutions]

Predictive hints:
[Packages, setup steps, pitfalls]
```

---

### 2. Mid-Wave Context (Iterations 1 & 2)

```typescript
export async function fetchMidWaveContext(
  workspaceId: string,
  todoTitle: string,
  latestContent: string | undefined,
  framework: string,
  userId?: string,
): Promise<string | null>
```

**Code** (from supermemoryAgent.ts:307-314):
```typescript
const res = await client.search.memories({
  q,
  containerTag: tag,               // pf:ws:{workspaceId}
  customId: workspaceId,           // workspace filter
  limit: 3,
  threshold: 0.70,
  rerank: true,
});
```

Injects fresh context on iterations 1-2 without latency cost.

---

### 3. Error Fix Hints

Called after failed shell command:

```typescript
export async function fetchErrorFixHint(
  workspaceId: string,
  errorSnippet: string,
  framework: string,
  userId?: string,
): Promise<string | null>
```

**Code** (from supermemoryAgent.ts:269-276):
```typescript
const res = await client.search.memories({
  q,
  containerTag: tag,               // pf:ws:{workspaceId}
  customId: workspaceId,           // workspace filter
  limit: 2,
  threshold: 0.72,
  rerank: true,
});
```

High threshold (0.72) for error fix precision.

---

## Integration in Agent Loop

### Setup Phase
1. **Org Settings**: `ensureOrgSettings()` (one-time on startup)
2. **Container Context**: `ensureContainerTagContext(workspaceId, framework)` (per workspace, first run)

### Wave Start
1. Refresh system prompt with profile + predictive hints
2. Inject into `<memory_context>` block

### Mid-Wave (Iteration 1-2)
1. Fetch via `fetchMidWaveContext()`
2. Inject as `<supermemory_context>` message

### On Error
1. Extract error snippet
2. Call `fetchErrorFixHint()`
3. Inject as `<supermemory_error_hint>` message

### Task Completion
1. Format summary + transcript
2. Call `ingestTodoCompletion()` (fire-and-forget, dual write)
3. Call `createRunFactMemories()` (fire-and-forget, dual write)

---

## Isolation Guarantees

### Workspace Isolation
- Memories in `pf:ws:workspace-123` with `customId: workspace-123` are **never accessible** to other workspaces
- Even with `userId`, retrieval uses `customId` filter to scope results

### User-Level Access (Cross-Project)
- Memories in `pf:user:alice` with `customId: workspace-123` are accessible across projects
- But filtered by `customId` to surface workspace-relevant context
- Example: JWT implementation from workspace-A is accessible in workspace-B with workspace filter intact

---

## Error Handling & Fallback

- **Client initialization fails**: Log warning, return `null`, continue without supermemory
- **API call fails**: Catch error, log warning, return `null` (non-critical)
- **No results**: Return `null`, agent continues with existing context
- **Timeout**: 1500ms per call; race() returns `null` if exceeded

All failures non-blocking — graceful degradation to local memory.

---

## Message Format & Redaction

### Transcript Formatting

```typescript
export function formatTranscriptForIngest(
  messages: Array<{ role: string; content?: string; toolName?: string }>,
  tailNote?: string,
): string
```

**Rules**:
- Skips system messages
- Tool results: first 600 chars
- User/assistant: full content
- All content: redacted via `redactSensitive()` (removes API keys, tokens, credentials)
- Total: capped at 40,000 chars (latest kept)

---

## Performance & Caching

### In-Process Cache
- **`initializedContainerTags` Set**: Tracks workspace container tags configured
- **Purpose**: Skip redundant `ensureContainerTagContext()` API calls
- **Scope**: Per worker instance

### Request Parallelization
- Profile + hints run in parallel at wave start
- No extra latency cost

### Timeouts
- Wave-start queries: 1500ms timeout per query
- Prevents slow supermemory from blocking agent loop

---

## Metadata Structure

### Ingest Metadata
```json
{
  "metadata": {
    "source": "ai-agents-agent" | "ai-agents-facts",
    "workspaceId": "workspace-uuid",
    "framework": "Next.js",
    "todoTitle": "Task title",
    "success": true
  }
}
```

### Entity Context (Extraction Guidance)
```
AI Agents AI coding agent workspace. Framework: {framework}.
Extract as memories:
  - npm/pip packages installed
  - architecture decisions
  - port assignments (frontend/backend)
  - environment variables
  - error fixes & solutions
  - file structures & conventions
  - user preferences for libraries/patterns
  - deployment configurations

Do NOT extract: raw code, shell output, tool args, system messages
```

---

## Logging & Debugging

All supermemory operations log with `[Supermemory]` prefix:

```
[Supermemory] fetchProfileContextBlock: staticLines=3 dynamicLines=2 memHits=1 hintsHits=0 hasContext=true
[Supermemory] fetchErrorFixHint: hits=1 threshold=0.72
[Supermemory] fetchMidWaveContext: hits=3 threshold=0.70
[Supermemory] ingestTodoCompletion ok todoId=abc123… dualIngest=true
[Supermemory] createRunFactMemories ok count=3 workspace=def456… dualIngest=true
[Supermemory] ensureContainerTagContext failed: {error}
```

---

## API Endpoints Reference

| Operation | Endpoint | Method | Auth |
|-----------|----------|--------|------|
| Fetch Profile | Supermemory SDK | Custom | N/A (internal) |
| Search Memories | Supermemory SDK | Custom | N/A (internal) |
| Add Memory | Supermemory SDK | Custom | N/A (internal) |
| Container Settings | `api.supermemory.ai/v3/containerTags/{tag}/settings` | PATCH | `SUPERMEMORY_API_KEY` |

---

## Example: JWT Auth Task

### Task Starts
```
Workspace: my-app (workspace-id: ws-abc-123)
User: alice@example.com (user-id: user-alice)
Task: "Add JWT authentication"
```

### Wave Start
```
fetchProfileContextBlock(
  workspaceId: "ws-abc-123",
  q: "Add JWT authentication\nFramework: Next.js\nLatest: Make it secure"
)

Search with:
  containerTag: pf:ws:ws-abc-123
  customId: ws-abc-123
```

**Returns** (workspace-isolated):
```
Static profile:
- App uses port 3000
- Backend on 8000

Relevant memories:
- Previous JWT implementation
- bcryptjs version compatibility
```

### Mid-Wave (Iteration 2)
```
fetchMidWaveContext(
  workspaceId: "ws-abc-123",
  q: "Add JWT authentication [agent working...] Next.js"
)

Search with:
  containerTag: pf:ws:ws-abc-123
  customId: ws-abc-123
```

**Returns**:
```
Common pitfalls:
- Use httpOnly cookies (not localStorage)
- Set proper CORS headers
- Refresh token rotation
```

### Task Completes
```
ingestTodoCompletion({
  workspaceId: "ws-abc-123",
  userId: "user-alice",
  todoTitle: "Add JWT authentication",
  finalSummary: "Implemented JWT-based login with httpOnly cookies",
  modifiedFiles: [...],
  framework: "Next.js"
})
```

**Writes**:
- Write 1: `containerTag: pf:ws:ws-abc-123`, `customId: ws-abc-123` → workspace-isolated
- Write 2: `containerTag: pf:user:user-alice`, `customId: ws-abc-123` → user-level, workspace-filtered

### Next Project (Workspace: workspace-xyz)
```
User alice starts new React + Express app
fetchProfileContextBlock(
  workspaceId: "workspace-xyz",
  userId: "user-alice"
)

Search with:
  containerTag: pf:user:user-alice  (cross-project)
  customId: workspace-xyz           (new workspace filter)
```

**Returns** (cross-project, but filtered):
- No JWT results (belongs to ws-abc-123, not workspace-xyz)
- Only memories tagged for workspace-xyz appear

**Note**: If same user works on same workspace again, `customId: ws-abc-123` filter returns JWT memories.

---

## Configuration & Deployment

### Required Environment Variables
```bash
SUPERMEMORY_API_KEY=sk_...
SUPERMEMORY_ENABLED=true
```

### Startup Checklist
- [ ] Environment variables set
- [ ] `ensureOrgSettings()` called once on first server startup
- [ ] Logs monitored for `[Supermemory]` entries
- [ ] Error handling verified (graceful degradation tested)

### Production Notes
- Supermemory calls are fire-and-forget (don't block agent)
- All API failures are caught and logged
- System continues without supermemory if service unavailable
- `customId` isolation prevents cross-workspace data leakage
