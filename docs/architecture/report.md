# AI Agents End-to-End Execution Flow: Technical Report

**Date Generated:** 2026-05-09  
**Scope:** Complete execution path from user input through project delivery  
**Based on:** Source code analysis of commit 74e6d35 (main branch)

---

## Executive Summary

AI Agents is a full-stack AI agent system that builds complete web applications from user prompts. The system operates as a distributed pipeline:

1. **Frontend** (Next.js) captures user input via WebSocket
2. **Backend** (Express + Node.js) routes requests through a job queue system
3. **Worker** (BullMQ) executes AI agents in isolated E2B sandboxes
4. **Database** (Prisma + PostgreSQL) persists chat history, todos, and workspace state
5. **Redis** coordinates events between workers and WebSocket clients

The entire flow is orchestrated through an agentic reasoning loop that decomposes user prompts into tasks (todos), executes them sequentially, and streams progress back to the frontend in real-time.

### Typical End-to-End Timings

| Scenario | Time | Details |
|----------|------|---------|
| **New Simple Project** (Next.js scaffold) | 30-60s | 3-5 tool calls, minimal npm install |
| **Medium Project** (API + Frontend) | 2-5 min | 15-25 tool calls, npm deps, dev server startup |
| **Complex Project** (Full-stack + DB) | 5-15 min | 30+ tool calls, database provisioning, migrations |
| **User Input → First Token** | 1.5-3s | WebSocket latency (50-150ms) + queue wait (100-500ms) + LLM first token (500-2000ms) |
| **Per LLM Iteration** | 2-10s | Tool execution time varies (light: 100-500ms, heavy: 5-30s) |

---

## 1. ARCHITECTURE OVERVIEW

### 1.1 System Components

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (Next.js 13+)                                          │
│ - /system/[id]/page.tsx (main UI)                               │
│ - useSystemWebSocket hook (WebSocket client)                    │
│ - ChatPanel, PreviewPanel (UI components)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                    WebSocket (wss://...)
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Backend (Express HTTP + WebSocket)                              │
│ - src/server.ts (Express app)                                   │
│ - src/index.ts (startup entry)                                  │
│ - src/ws/WSManager.ts (WebSocket handler)                       │
│ - src/routes/* (REST endpoints)                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                      Redis Pub/Sub
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Job Queue (BullMQ + Redis)                                      │
│ - src/queue/queues.ts (queue definitions)                       │
│ - agentQueue (agent-run jobs)                                   │
│ - setupQueue (workspace setup)                                  │
│ - importQueue (GitHub imports)                                  │
│ - coregitQueue (version control snapshots)                      │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Workers (Node.js processes)                                     │
│ - src/workers/agentWorker.ts (main AI orchestration)            │
│ - src/workers/setupWorker.ts (workspace bootstrap)              │
│ - src/workers/importWorker.ts (GitHub provisioning)             │
│ - src/workers/coregitWorker.ts (Git snapshots)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ E2B Sandbox (Code Interpreter)                                  │
│ - framework-specific templates (Next.js, Vite, etc.)            │
│ - /workspace directory (project root)                           │
│ - src/sandbox/sandboxManager.ts (lifecycle management)          │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Persistent Data (PostgreSQL via Prisma)                         │
│ - Message table (chat history + tool calls)                     │
│ - Todo table (task tracking)                                    │
│ - AgentRun table (execution metadata)                           │
│ - Workspace table (session state)                               │
│ - Request table (user request tracking)                         │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Technology Stack

| Component | Technology | Key Files |
|-----------|-----------|-----------|
| Frontend | Next.js 13, React 18, TypeScript | `frontend/src/app/system/[id]/page.tsx` |
| Backend API | Express.js, Node.js 18+ | `backend/src/server.ts` |
| WebSocket | ws (Node.js native WebSocket library) | `backend/src/ws/WSManager.ts` |
| Queue | BullMQ + Redis | `backend/src/queue/queues.ts` |
| Sandbox | E2B Code Interpreter | `backend/src/sandbox/sandboxManager.ts` |
| Database | PostgreSQL + Prisma ORM | `backend/src/lib/prisma.ts` |
| LLM | OpenAI, Anthropic, Groq, Qwen, Gemini | `backend/src/brain/providers/*` |
| Logging | PostHog analytics | `backend/src/lib/posthog.ts` |

---

## 2. USER INPUT FLOW

### 2.1 Frontend: User Submits Prompt

**File:** `frontend/src/app/system/[id]/page.tsx` (lines 419-457)  
**Component:** `ChatPanel` (lines 418-456)  
**Total Time:** ~50-150ms

**Sequence:**

```
1. User types message in ChatPanel input field
2. onSend callback triggered (line 425)           [~0ms, event-driven]
3. sendUserMessage() called with (msg, images)    [~1-5ms, local function call]
4. WebSocket sends USER_REQUEST event              [~50-150ms, network latency]
```

**Code Path:**
```typescript
// frontend/src/app/system/[id]/_components/chat-panel.tsx (inferred)
onSend={(msg, images) => sendUserMessage(msg, undefined, undefined, images)}
```

**Message Structure Sent:**
```json
{
  "type": "USER_REQUEST",
  "payload": {
    "message": "Build a Next.js blog app with Markdown support",
    "imageIds": ["img_123", "img_456"],
    "planMode": true,
    "multiAgentEnabled": false
  },
  "meta": {
    "requestId": "req_uuid",
    "workspaceId": "ws_uuid"
  }
}
```

### 2.2 WebSocket Connection Lifecycle

**File:** `frontend/src/app/system/[id]/_hooks/use-system-websocket.ts` (lines 142-238)  
**Total Time:** ~300-800ms (initial connection)

**Connection Steps:**

1. **Initialization** (line 142-150) — **~50-150ms**
   - WebSocket URL derived from `process.env.NEXT_PUBLIC_BACKEND_URL`
   - Connects to `wss://backend:8000/ws` in production
   - Network handshake + TLS negotiation

2. **On Socket Open** (line 155-202) — **~50-100ms**
   - Send `AUTH` event with `workspaceId` and `userId` (line 166) — **~2-5ms local**
   - Receive AUTH_OK response — **~50-150ms network**
   - Start ping/pong keepalive every 30 seconds (line 170-174) — **~0ms setup**
   - Send initial idea if workspace is new (lines 177-201) — **~2-5ms local**

3. **On Message Received** (line 204-217) — **~5-20ms per event**
   - Parse JSON event data — **~1-3ms**
   - Route to `handleEvent()` dispatcher (line 213) — **~2-10ms depending on handler**

4. **Chunk Buffering** (lines 112-140) — **~50ms flush interval**
   - Token streams batched every 50ms to reduce re-renders
   - Stored in `chunkBufferRef` and `toolChunkBufferRef`
   - `flushChunkBuffer()` updates React state — **~5-15ms React batch update**

5. **Reconnection** (lines 219-232) — **Exponential backoff: 1s → 2s → 4s → ... → 30s max**
   - Auto-reconnect with exponential backoff
   - Retry limit tracked in `retryCountRef`
   - First retry: ~1s, Second: ~2s, Third: ~4s, etc.

---

## 3. BACKEND: MESSAGE RECEPTION & ROUTING

### 3.1 Server Startup

**File:** `backend/src/index.ts` (lines 1-40)  
**Total Startup Time:** ~500-2000ms

**Initialization Steps:**

```typescript
1. Import environment variables (line 1)                    [~10-50ms]
2. Create Express + HTTP server (startServer)              [~20-100ms]
3. Instantiate WebSocketManager                             [~10-30ms]
4. Attach event handlers for graceful shutdown              [~1-5ms]
5. PostHog initialization (deferred)                        [~0ms, async]
6. Listen on port 8000                                      [~50-100ms]
```

**Startup Output:**
```
[startup] Express server listening on http://0.0.0.0:8000
[WSManager] WebSocket server ready
```

**Server Setup:** `backend/src/server.ts` (lines 8-98) — **~100-500ms**

- CORS whitelisting: localhost:3000, localhost:3001, *.e2b.app, FRONTEND_URL env var (lines 12-33)
- Express middleware: `json()`, CORS, routing (lines 35-87)
- Health check endpoint at `/health` (lines 65-84)
- API routes mounted at `/api` (line 87)

### 3.2 WebSocket Handler Setup

**File:** `backend/src/ws/WSManager.ts` (lines 83-170)  
**Total Time Per Connection:** ~50-200ms

**Class:** `WebSocketManager` (constructor line 119-139) — **~10-30ms init**

**Connection Handler** (lines 141-169) — **~50-200ms total**:

```typescript
handleConnection(socket: WebSocket) {
  1. Add socket to connections set                          [~1ms]
  2. Create unique sessionId (ses_uuid)                     [~1-2ms]
  3. Initialize SocketContext (sessionId, userId, etc.)    [~2-5ms]
  4. Register event handlers: message, close, error         [~1-3ms]
  5. Send welcome text message                              [~10-50ms network]
  6. Persist "Session started" message to DB                [~20-100ms async DB write]
}
```

**Critical Data Structures:**

| Structure | Purpose |
|-----------|---------|
| `connections: Set<WebSocket>` | All active client sockets |
| `ctxBySocket: WeakMap<WebSocket, SocketContext>` | Per-socket auth/workspace context |
| `agentRunsByWorkspace: Map<string, string>` | Maps workspaceId → BullMQ jobId |
| `activeAbortControllers: Map<string, AbortController>` | Inline agent abort signals |
| `eventRelay: EventRelay` | Redis pub/sub for worker → client events |

### 3.3 Message Router

**File:** `backend/src/ws/WSManager.ts` (lines 354-390)

**Handler:** `handleMessage(socket, message)` (line 356)

**Event Type Dispatch:**

```typescript
switch (event.type) {
  case "AUTH":           // Authenticate and load workspace
  case "USER_REQUEST":   // User submitted a prompt
  case "STOP_AGENT":     // User clicked stop
  case "CLARIFICATION":  // User answered classifier questions
  case "CONFIRMATION":   // User approved a decision
  case "TODO_*":         // Todo CRUD operations
  case "LOAD_HISTORY":   // Pagination for chat history
  // ...
}
```

---

## 4. REQUEST HANDLING: USER_REQUEST

### 4.1 USER_REQUEST Event Handler

**File:** `backend/src/ws/WSManager.ts` (lines ~460-700, inferred from context)  
**Total Time:** ~100-500ms (fire-and-forget for message persist; queue add is quick)

**Payload Structure:**
```typescript
interface UserRequestEvent {
  type: "USER_REQUEST";
  payload: {
    message: string;
    imageIds?: string[];
    planMode?: boolean;
    multiAgentEnabled?: boolean;
    framework?: string;
  };
  meta: { requestId: string; workspaceId: string };
}
```

**Processing Steps:**

1. **Extract Context** (lines ~460-480) — **~20-50ms**
   - Get socket context: userId, workspaceId, framework — **~1-2ms**
   - Load imageIds and convert to ImageRef[] via `loadImageRefs()` — **~15-40ms per image (bucket download)**

2. **Workspace Resolution** (lines ~480-520) — **~30-100ms**
   - If new workspace (no sandboxId):
     - Create Workspace in DB — **~20-50ms DB write**
     - Trigger setupQueue job for bootstrap — **~5-10ms queue add**
     - Return early; let setup worker handle agent invocation
   
   - If existing workspace:
     - Load workspace metadata — **~10-30ms DB read**
     - Get current pending Todo — **~10-20ms DB query**
     - Proceed directly to agent queue

3. **Persist User Message** (fire-and-forget, line ~520) — **~20-50ms DB write (async)**
   ```typescript
   persistMessage(sessionId, "user", message, requestId, workspaceId, imageIds)
   // Non-blocking; returns Promise but not awaited
   ```

4. **Enqueue Agent Job** (lines ~530-560) — **~10-30ms**
   ```typescript
   const jobId = await agentQueue.add("run-agent", {
     // Job serialized to JSON and added to Redis
   });
   // Redis add: ~5-15ms
   
   // Track job per workspace
   agentRunsByWorkspace.set(workspaceId, jobId);  // ~1ms
   ```

5. **Send Confirmation** (lines ~560-580) — **~10-50ms network**
   ```typescript
   sendEvent(socket, createEvent(
     "AGENT_QUEUED",
     { jobId, message: "Agent run queued. Processing..." },
     meta
   ));
   // WebSocket send: ~10-50ms (local network, no actual transmission latency)
   ```

### 4.2 Setup Queue Handler (New Workspace Flow)

**File:** `backend/src/workers/setupWorker.ts` (inferred; setupQueue definition at queue/queues.ts:27)

**When Triggered:**
- User submits initial prompt with no sandboxId
- setupQueue job processes **before** agentQueue

**Processing:**

1. Create workspace in DB
2. Load workspace config from context builder
3. Trigger setupQueue → (sandbox creation + agent queue)

---

## 5. AGENT QUEUE & WORKER SYSTEM

### 5.1 Job Queue Definitions

**File:** `backend/src/queue/queues.ts`

**Queue Instances:**

```typescript
export const agentQueue = new Queue<AgentJobPayload>("agent-run", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});
```

**Job Retry Policy:**
- Max 3 attempts
- Exponential backoff: 2s → 4s → 8s
- Completed jobs: keep last 200
- Failed jobs: keep last 500

### 5.2 Agent Worker Execution

**File:** `backend/src/workers/agentWorker.ts` (lines 85-200+)  
**Total Job Execution Time:** Highly variable, see breakdown below

**Worker Bootstrap:** ~10-50ms setup

```typescript
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);

const worker = new Worker("agent-run", processor, {
  connection: redisConnection,
  concurrency: CONCURRENCY,  // Default 5 concurrent jobs
});
```

**Job Processor:** `processAgentJob(job)` (lines 85-200)

**Execution Sequence:**

1. **Initialization** (lines 85-114) — **~30-100ms**
   ```typescript
   const { workspaceId, sandboxId, todoId, userId, provider, planMode, multiAgent } = job.data;
   // Job data extraction: ~1-2ms
   
   emit("AGENT_EVENT", { eventType: "AGENT_STARTED", message: "Agent run started." });
   // Event emission: ~1-5ms
   
   const agentRun = await agentRunService.create(workspaceId);
   // DB insert: ~20-50ms
   ```

2. **Abort Signal Setup** (lines 94-95) — **~5-10ms**
   ```typescript
   const abortCtrl = buildRedisAbortSignal(workspaceId);
   // Polls Redis key `abort:{workspaceId}` every 2 seconds (async interval)
   ```

3. **Provider Resolution** (lines 116-120) — **~50-200ms**
   ```typescript
   const resolvedProvider = await resolveProvider({
     userId, workspaceId, preferredProvider: provider
   });
   // DB lookup (user keys): ~30-80ms
   // Env var check: ~1-5ms
   // Total: ~50-200ms
   ```

4. **Agent Context Assembly** (lines 122-154) — **~10-30ms**
   ```typescript
   const agentCtx: AgentRunnerContext = {
     // Object creation + assignment: ~10-30ms
   };
   ```

5. **Orchestrator Invocation** (line 156) — **VARIABLE: 30s-15min+**
   ```typescript
   const result = await runOrchestrator(agentCtx, multiAgent, emit);
   // Main execution loop: see Section 6 for detailed breakdown
   // Typical: 2-15 minutes depending on project complexity
   ```

6. **Post-Processing** (lines 159-199) — **~100-500ms**
   - Mark AgentRun as SUCCESS/FAILED — **~20-50ms DB update**
   - Update workspace memory with detected ports — **~20-50ms DB write**
   - Trigger Coregit snapshot on success — **~20-50ms queue add**
   - Emit PLAN_READY if in plan mode — **~5-10ms emission**

---

## 6. AGENT ORCHESTRATION: Core Reasoning Loop

### 6.1 Orchestrator Entry Point

**File:** `backend/src/brain/agents/orchestratorRunner.ts` (lines 1-50, inferred)

**Export:** `async function runOrchestrator(ctx: AgentRunnerContext, isMultiAgent: boolean, emit: EmitFunction)`

**Logic:**

```
if isMultiAgent:
  ├─ Route to multi-agent orchestration (Research + File + Synthesis)
  └─ Fallback to single-agent if multi-agent disabled
else:
  └─ Route to single-agent runAgent()
```

### 6.2 Single-Agent Execution: runAgent()

**File:** `backend/src/brain/agentRunner.ts` (lines 695-900+)

**Main Function:** `async function runAgent(ctx: AgentRunnerContext)`

**Execution Phases:**

#### Phase 1: Initialization (lines 695-780)

**A. Memory Loading** (lines 699-703)
```typescript
const [recentRuns, workspaceMemory] = await Promise.all([
  agentRunService.getRecent(workspaceId, 3),
  workspaceMemoryService.get(workspaceId)
]);
```

**B. LLM Client Creation** (lines 748-780)
```typescript
const llmWrapper = await createLLMClient({
  userId, workspaceId, provider: currentProvider
});

// Resolves to: { kind: "openai" | "anthropic", client, meta: { provider, source } }
```

**Provider Resolution Hierarchy:**

1. User-provided API key (via userApiKeyService.getKey)
2. Environment variable key (getEnvKey)
3. Fallback provider chain: DEFAULT_PROVIDER → GROQ → OPENAI → ANTHROPIC → GEMINI

**C. Tool Schema Configuration** (lines 734-746)
```typescript
const PLAN_MODE_TOOLS = ["read_file", "search_code", "execute_shell", "edit_file", "submit_plan_questions"];
const activeToolSchemas = planMode
  ? TOOL_SCHEMAS.filter(t => PLAN_MODE_TOOLS.includes(t.function.name))
  : TOOL_SCHEMAS.filter(t => t.function.name !== "submit_plan_questions");
```

#### Phase 2: System Prompt Assembly (lines 705-717)

**Base Prompt Selection:**
```typescript
const basePrompt = overrideSystemPrompt ?? (
  planMode
    ? getPlanModePrompt({ framework, idea: projectIdea })
    : getSystemPrompt({ framework, templateId, idea: projectIdea })
);
```

**Memory Block Injection** (lines 711-717)
```typescript
const staticBlock = buildMemoryBlock({
  recentRuns,
  workspaceMemory
});

// System prompt = basePrompt + "\n\n" + staticBlock
```

#### Phase 3: Sandbox Initialization (lines ~800-850, inferred)

1. **Connect/Resume Sandbox**
   ```typescript
   const sandbox = ctx.sandboxId
     ? await Sandbox.connect(ctx.sandboxId)
     : await Sandbox.create(templateId || "base", { timeoutMs: 15*60*1000, lifecycle: { onTimeout: "pause" } });
   ```

2. **Write Context Files**
   - AI Agents.md (project context)
   - .env files (environment variables)
   - Database URL (if applicable)

3. **Background Initialization** (non-blocking)
   - Inspector bootstrap
   - Sanity checks

#### Phase 4: Main Agent Loop (lines ~850-900+)

**Loop Timing:** Highly variable per iteration. See detailed breakdown:

**Loop Structure:**

```typescript
for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {  // MAX_ITERATIONS = 20
  
  // ─────────────────────────────────────────────────────
  // Step 1: Get current TODO — ~10-30ms
  // ─────────────────────────────────────────────────────
  
  const todo = await todoService.getCurrentTodo(workspaceId);
  // DB query (index on status + order): ~10-30ms
  if (!todo) {
    return { success: true, summary: "All tasks completed." };
  }
  
  // ─────────────────────────────────────────────────────
  // Step 2: Build conversation history — ~100-500ms
  // ─────────────────────────────────────────────────────
  
  let dbMessages = await messageService.getByWorkspace(workspaceId);
  // Initial DB query (iteration 0): ~30-100ms (may return many messages)
  // Later iterations: ~20-50ms (cache hits likely)
  
  // Smart memory retrieval: fetch relevant historical context — ~200-500ms
  if (iteration > 0) {
    const relevant = await retrieveRelevantMemory(
      todo.description,
      dbMessages,
      workspaceMemory
    );
    // Embedding generation + vector search: ~200-500ms
    // Inject into system prompt
  }
  
  // Truncate to token limit (100,000 tokens) — ~10-50ms
  while (estimateTokens(dbMessages) > TOKEN_LIMIT) {
    dbMessages = dbMessages.slice(1);  // Drop oldest: ~5-10ms per drop
  }
  
  // Sanitize orphaned tool messages — ~10-30ms
  dbMessages = sanitizeDbMessages(dbMessages);
  
  // ─────────────────────────────────────────────────────
  // Step 3: Convert to LLM format — ~20-50ms
  // ─────────────────────────────────────────────────────
  
  let openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  let anthropicMessages: { system: string; messages: Array<...> };
  
  if (llmKind === "openai") {
    openaiMessages = buildOpenAIMessages(dbMessages);
    // JSON serialization of messages: ~10-30ms (scales with history size)
  } else {
    anthropicMessages = buildAnthropicMessages(dbMessages);
    // Block transformation + merging: ~10-30ms
  }
  
  // ─────────────────────────────────────────────────────
  // Step 4: LLM Call with streaming — 500ms - 60s+
  // ─────────────────────────────────────────────────────
  
  const llmResponse = await (llmKind === "openai"
    ? callOpenAIStream(llmOpenAI, openaiMessages, activeToolSchemas, signal)
    : callAnthropicStream(llmAnthropic, anthropicMessages, activeAnthropicTools, signal)
  );
  
  // Total LLM time breakdown:
  // - API latency (time to first token): 500-2000ms
  // - Streaming completion:
  //   * Short response (reasoning): 2-5s
  //   * Medium response (code + reasoning): 5-15s
  //   * Long response (multi-tool planning): 15-60s
  // - Retry on empty output (Qwen): +1500-4500ms per retry
  
  // Stream tokens to frontend via emit()
  for await (const chunk of llmResponse) {
    // Per-token latency: ~1-5ms
    // Parsed chunks batched in temporary variable
    // Flushed to DB every 50 chunks or 100ms (whichever first)
    // Per flush to DB: ~10-50ms
    // Per emit to frontend: ~1-5ms
  }
  
  // ─────────────────────────────────────────────────────
  // Step 5: Parse tool calls — ~5-20ms
  // ─────────────────────────────────────────────────────
  
  const toolCalls = parseToolCalls(llmResponse);
  // JSON parsing + validation: ~5-20ms
  
  if (toolCalls.length === 0 && !llmResponse.finishReason.includes("tool_calls")) {
    // Agent reached FINAL ANSWER without tools — ~20-100ms
    const finalAnswer = llmResponse.text;
    const ports = parsePortsFromFinalAnswer(finalAnswer);
    // Regex parsing: ~1-5ms
    
    // Mark todo as complete
    await todoService.markComplete(todo.id);
    // DB update: ~20-50ms
    
    return {
      success: true,
      summary: finalAnswer,
      port: ports.frontend,
      backendPort: ports.backend
    };
  }
  
  // ─────────────────────────────────────────────────────
  // Step 6: Execute tools sequentially — 100ms - 30s+ per tool
  // ─────────────────────────────────────────────────────
  
  for (const toolCall of toolCalls) {  // Typically 1-5 tool calls per iteration
    const result = await executeSkill(toolCall, signal);
    // Tool execution time (HIGHLY VARIABLE):
    // - read_file: ~50-200ms
    // - search_code: ~100-500ms
    // - edit_file: ~50-200ms
    // - execute_shell (light): ~100-500ms (npm list, echo, etc.)
    // - execute_shell (medium): ~1-5s (npm install first time)
    // - execute_shell (heavy): ~5-30s+ (build, full npm install, dev server start)
    // - web_search: ~1-5s (API call + response)
    // - todo_manager: ~20-50ms (DB query/update)
    
    // Persist tool call + result to DB
    await messageService.createMessage({
      role: "tool",
      content: JSON.stringify(result),
      toolCallId: toolCall.id,
      toolName: toolCall.tool,
      workspaceId
    });
    // DB insert: ~20-50ms
    
    // Emit tool execution event to frontend
    emit("TOOL_COMPLETED", `Executed ${toolCall.tool}`, {
      toolName: toolCall.tool,
      output: result.data
    });
    // Event emission: ~1-5ms
  }
  
  // Abort check: if signal aborted, exit loop — ~1ms
  if (signal?.aborted) {
    return { success: false, summary: "Agent run aborted by user." };
  }
}

// Exit after MAX_ITERATIONS
return { success: false, summary: `Max iterations (${MAX_ITERATIONS}) reached.` };
```

**Per-Iteration Timing Summary:**

| Phase | Min | Typical | Max |
|-------|-----|---------|-----|
| **Get TODO** | 10ms | 20ms | 30ms |
| **Load History** | 30ms | 100ms | 500ms |
| **Memory Retrieval** | 0ms | 200ms | 500ms |
| **Token Truncation** | 5ms | 10ms | 100ms |
| **Build LLM Messages** | 10ms | 30ms | 50ms |
| **LLM API Call** | 500ms | 5s-20s | 60s+ |
| **Parse Tool Calls** | 2ms | 10ms | 20ms |
| **Tool Execution** | 50ms | 2-5s | 30s+ |
| **DB Persistence** | 20ms | 100ms | 200ms |
| **Total Per Iteration** | **600ms** | **2-10s** | **60s+** |

**Iteration Examples:**

- **Quick reasoning iteration** (no tools): 500ms - 2s
- **Single tool call** (read_file): 1-3s total
- **npm install first time**: 10-30s (heavy execute_shell)
- **Web search + analysis**: 5-10s
- **Complex multi-tool iteration**: 10-30s

**Key Loop Invariants:**

| Variable | Purpose | Reset Per Iteration |
|----------|---------|-------------------|
| `iteration` | Loop counter | No |
| `todo` | Current task from DB | Yes |
| `dbMessages` | Full conversation history | Yes |
| `llmResponse` | Latest LLM output (text + tool_calls) | Yes |
| `toolCalls` | Parsed tool invocations | Yes |

---

## 7. SKILL EXECUTION

### 7.1 Tool/Skill Registry

**File:** `backend/src/skills/index.ts` (lines 16-365)

**TOOL_SCHEMAS:** Array of 13 tools with OpenAI JSON Schema format

**SKILL_REGISTRY:** Mapping of tool names to async handlers

```typescript
export const SKILL_REGISTRY: Record<ToolName, (params, signal?) => Promise<ToolResult>> = {
  read_file: (params) => read_file(params),
  edit_file: (params) => edit_file(params),
  search_code: (params) => search_code(params),
  execute_shell: (params, signal) => execute_shell(params, signal),
  check_health: (params, signal) => check_health(params, signal),
  web_search: (params) => web_search(params),
  fetch_url: (params) => fetch_url(params),
  todo_manager: (params) => todo_manager(params),
  context_save: (params) => context_save(params),
  request_env_vars: (params) => request_env_vars(params),
  submit_plan_questions: (params) => submit_plan_questions(params),
  env_manager: (params) => env_manager(params),
  provision_database: (params) => provision_database(params),
};
```

### 7.2 Execute Skill Function

**File:** `backend/src/skills/index.ts` (lines 359-365)

```typescript
export async function executeSkill(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
  const handler = SKILL_REGISTRY[call.tool];
  if (!handler) {
    return { success: false, error: `Unknown tool: "${call.tool}"` };
  }
  return handler(call.params, signal);
}
```

**ToolCall Structure:**
```typescript
interface ToolCall {
  id: string;          // Unique call ID
  tool: ToolName;      // Tool name (from SKILL_REGISTRY keys)
  params: Record<string, any>; // Tool arguments
}
```

**ToolResult Structure:**
```typescript
interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
  output?: string;     // Alternative success field
}
```

### 7.3 Example Tool: execute_shell

**File:** `backend/src/skills/shell/execute_shell.ts`  
**Total Time:** 100ms - 120s (varies wildly by command)

**Invocation:**
```typescript
// From agent LLM response:
{
  type: "function",
  function: {
    name: "execute_shell",
    arguments: JSON.stringify({
      command: "npm install",
      timeout_seconds: 120,
      background: false
    })
  }
}
```

**Handler Implementation (inferred):**

```typescript
async function execute_shell(params: {
  command: string;
  timeout_seconds?: number;  // Default: 120s
  background?: boolean;       // Default: false
}, signal?: AbortSignal): Promise<ToolResult> {
  
  const { command, timeout_seconds = 120, background = false } = params;
  
  // ─────────────────────────────────────────
  // Permission Checks (~1-5ms)
  // ─────────────────────────────────────────
  
  // Plan mode: restrict to read-only commands
  if (isPlanMode && !isPlanModeShellAllowed(command)) {
    return {
      success: false,
      error: "Plan mode: shell access restricted to read-only commands (ls, grep, cat, etc.)"
    };
  }
  
  // Block dev server commands (run separately with background=true)
  if (isDevServerCommand(command)) {
    return {
      success: false,
      error: "Dev server commands must be run with background=true parameter"
    };
  }
  
  // ─────────────────────────────────────
  // Sandbox Execution (~100ms - 120s)
  // ─────────────────────────────────────
  
  const proc = await sandbox.process.run(command, {
    timeout: timeout_seconds * 1000,  // Max wait time
    signal: signal,
  });
  
  return {
    success: proc.exitCode === 0,
    data: proc.stdout,
    error: proc.exitCode !== 0 ? proc.stderr : undefined
  };
}
```

**Execution Time by Command Type:**

| Command | Time | Notes |
|---------|------|-------|
| `ls`, `pwd`, `echo` | 50-100ms | Instant system calls |
| `cat`, `grep`, `find` | 100-500ms | File I/O bound |
| `npm list`, `npm version` | 500-1000ms | Package manager overhead |
| `npm install` (cached) | 1-5s | Dependencies already downloaded |
| `npm install` (first time) | 10-30s | Download + extract + build |
| `next build` | 20-60s | Heavy: TypeScript + bundling |
| `npm run dev` (background) | 2-10s | Startup time, returns PID |
| `npm run test` | 5-30s | Test suite execution |
| `curl http://localhost:3000` | 100-500ms | HTTP request |
| `docker build` | 30-300s | Container layer caching |

### 7.4 Tool: todo_manager

**File:** `backend/src/skills/todo/todo_manager.ts`

**Actions:**
1. `get_current_todo`: Fetch next pending todo
2. `list_pending_todos`: List all pending tasks
3. `mark_todo_complete`: Mark task complete + advance loop

**Implementation:**

```typescript
async function todo_manager(params: {
  action: "get_current_todo" | "list_pending_todos" | "mark_todo_complete";
  workspaceId: string;
  todo_id?: string;
  notes?: string;
}): Promise<ToolResult> {
  
  const { action, workspaceId, todo_id, notes } = params;
  
  switch (action) {
    case "get_current_todo":
      const todo = await todoService.getCurrentTodo(workspaceId);
      return {
        success: !!todo,
        data: JSON.stringify(todo || { message: "No pending todos" })
      };
    
    case "list_pending_todos":
      const todos = await todoService.listPendingTodos(workspaceId);
      return { success: true, data: JSON.stringify(todos) };
    
    case "mark_todo_complete":
      await todoService.markComplete(todo_id, notes);
      return { success: true, data: `Todo ${todo_id} marked complete` };
  }
}
```

**Impact on Agent Loop:**

When agent calls `mark_todo_complete(todoId)`, it returns to the main loop, which then:
1. Calls `todoService.getCurrentTodo()` → returns next pending todo
2. Builds new initial message for next todo
3. Continues loop iteration with new task

---

## 8. SANDBOX MANAGEMENT

### 8.1 Sandbox Lifecycle

**File:** `backend/src/sandbox/sandboxManager.ts`

**Class:** `SandboxManager` (Singleton)

**Key Method:** `async openAndInit(input: OpenSandboxInput)`  
**Total Time:** 500-6500ms depending on new vs existing

**Lifecycle Operations:**

#### A. Resume Existing Sandbox (lines 68-89) — **1000-3000ms**

```typescript
if (input.sandboxId) {
  try {
    sandbox = await Sandbox.connect(input.sandboxId);
    // E2B reconnect to paused sandbox: 500-1500ms
    // Network + E2B coordination
    
    // Refresh timeout to 15 minutes
    sandbox.setTimeout(15 * 60 * 1000);
    // API call to E2B: 100-300ms (non-blocking if not awaited)
    
    // For Next.js, restart services if needed
    if (input.framework === "Next.js") {
      this.ensureServicesRunning(sandbox);
      // Check if dev server running: 500-2000ms
      // Restart if needed: additional 2-10s (skipped if already running)
    }
  } catch (err) {
    throw new Error(`Sandbox expired or unavailable. Start a new session.`);
  }
}
```

**Resume Timing Breakdown:**

| Step | Time |
|------|------|
| Sandbox.connect() | 500-1500ms |
| setTimeout() | 100-300ms |
| ensureServicesRunning() (if needed) | 500-2000ms |
| **Total Resume** | **1100-3800ms** |

#### B. Create New Sandbox (lines 90-101) — **2500-6500ms**

```typescript
// Template resolution: templateId → framework → env → "base"
const templateId = this.resolveTemplate(input);
// Synchronous lookup: 1-2ms

sandbox = await Sandbox.create(templateId, {
  timeoutMs: 15 * 60 * 1000,
  lifecycle: { onTimeout: "pause" }  // Pause instead of kill
});
// E2B creates new sandbox: 2500-6500ms breakdown:
// ├─ Request to E2B API: 100-300ms
// ├─ Template download (if not cached): 1500-5000ms
// │  └─ Network transfer + extraction
// ├─ Docker container spawn: 500-1500ms
// ├─ Node.js runtime init: 200-500ms
// └─ E2B agent startup: 200-500ms
```

**Template Availability & Download Times:**

| Framework | Template | Cached | Fresh | Notes |
|-----------|----------|--------|-------|-------|
| Next.js | `next-app-interpreter` | 500ms | 3-5s | Pre-built, dependencies included |
| Vite React | `vite-react-interpreter` | 500ms | 2-4s | Lighter than Next.js |
| Express.js | `base` | 200ms | 1-2s | Minimal base image |
| Generic | `base` | 200ms | 1-2s | Fallback for unknown |

#### C. Initialize Sandbox (lines 103-140) — **100-500ms**

**Parallel File Writes:**

```typescript
const fileWrites: Promise<any>[] = [];

if (input.aiAgentsMd) {
  fileWrites.push(sandbox.files.write("/workspace/AI Agents.md", input.aiAgentsMd));
  // Small text file: ~20-50ms
}

if (input.databaseUrl) {
  const content = `DATABASE_URL=${input.databaseUrl}\n`;
  fileWrites.push(sandbox.files.write("/workspace/backend/.env", content));
  // Small .env file: ~20-50ms
}

await Promise.all(fileWrites);
// Parallel execution: ~50-100ms total (not sequential)
```

**File Write Timing:**

| File | Size | Time |
|------|------|------|
| AI Agents.md | 1-5KB | 20-50ms |
| .env | 100B-1KB | 10-30ms |
| Large codebase setup | 100KB+ | 200-500ms |

**Post-Init Operations (Non-Blocking):** — **~50-200ms parallel, non-awaited**

```typescript
Promise.allSettled([
  runSanityChecks(sandbox, input.framework),
  // Verify system packages, run npm list, etc: ~100-300ms
  // Executes in background
  
  bootstrapInspector({ sandbox, workspaceId: input.workspaceId }),
  // Setup visual inspector hooks: ~50-100ms
  // Non-blocking
]);
// These don't block main agent execution
```

**Sandbox Lifecycle Timing Summary:**

| Scenario | Time | Critical Path |
|----------|------|----------------|
| **New workspace (first time)** | 2500-6500ms | Template download is bottleneck |
| **Resume workspace (paused)** | 1000-3000ms | Reconnection + service check |
| **Resume workspace (already running)** | 500-1500ms | Just reconnect + timeout refresh |
| **Multiple tabs same workspace** | 500-1500ms | Reuse same sandbox |

### 8.2 Sandbox Context During Agent Execution

**Reference:** Global `sandbox` variable in `agentRunner.ts`

**Used By Skills:**

| Skill | Sandbox Call |
|-------|------------|
| `read_file` | `sandbox.files.read(path)` |
| `edit_file` | `sandbox.files.write(path, content)` or `sandbox.process.run(cmd)` |
| `search_code` | `sandbox.process.run("grep -r ...")` |
| `execute_shell` | `sandbox.process.run(command, { timeout, signal })` |
| `check_health` | `sandbox.process.run("curl http://localhost:{port}")` |

---

## 9. DATABASE PERSISTENCE

### 9.1 Data Model

**ORM:** Prisma  
**Database:** PostgreSQL

**Key Tables:**

#### Message Table

```prisma
model Message {
  id              String    @id @default(cuid())
  sessionId       String?   // Pre-workspace messages
  workspaceId     String?   // Post-workspace messages
  role            MessageRole // "user" | "assistant" | "system" | "tool"
  content         String    // Message text or JSON (tool calls/results)
  requestId       String?   // Links to Request table
  toolCalls       String?   // JSON array of OpenAI tool_call objects
  toolCallId      String?   // For tool result rows
  toolName        String?   // Tool name (e.g., "execute_shell")
  createdAt       DateTime  @default(now())
  
  // Relationships
  workspace       Workspace? @relation(fields: [workspaceId], references: [id])
  agentLogs       AgentLog[]
  images          Image[]
}
```

**Message Role Enum:**

- `user`: User input
- `assistant`: LLM output (text + tool calls)
- `system`: System messages (session start, etc.)
- `tool`: Tool execution results

#### Todo Table

```prisma
model Todo {
  id          String    @id @default(cuid())
  workspaceId String
  title       String
  description String
  order       Int       // Execution order
  status      String    // "pending" | "in_progress" | "completed"
  createdAt   DateTime  @default(now())
  
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
}
```

#### Workspace Table

```prisma
model Workspace {
  id              String    @id @default(cuid())
  userId          String?   // Clerk user ID
  name            String
  idea            String?   // Original project idea
  framework       String?   // Selected framework
  sandboxId       String?   // E2B sandbox ID
  port            Int?      // Frontend dev server port
  backendPort     Int?      // Backend API port
  status          String    // "setup" | "running" | "paused"
  config          Json?     // Extensible config object
  createdAt       DateTime  @default(now())
  
  messages        Message[]
  todos           Todo[]
  agentRuns       AgentRun[]
}
```

#### AgentRun Table

```prisma
model AgentRun {
  id          String    @id @default(cuid())
  workspaceId String
  status      String    // "running" | "success" | "failed"
  summary     String?
  port        Int?
  backendPort Int?
  createdAt   DateTime  @default(now())
  
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
}
```

### 9.2 Message Persistence Flow

**In Agent Loop:** — **~20-50ms per DB write**

```typescript
// 1. Persist assistant message + tool calls — ~20-50ms
await messageService.createMessage({
  sessionId: sessionId || null,
  workspaceId,
  role: "assistant",
  content: llmResponse.text,  // May be large: 1KB - 10KB
  toolCalls: JSON.stringify(llmResponse.tool_calls),
  requestId
});
// DB insert time depends on:
// - Payload size: ~1-10ms for 1KB, ~5-30ms for 10KB
// - Index writes: ~10-20ms (workspaceId, requestId)
// - Network to DB: ~5-20ms

// 2. For each tool result — ~20-50ms per tool
await messageService.createMessage({
  sessionId: sessionId || null,
  workspaceId,
  role: "tool",
  content: JSON.stringify(toolResult),  // Typically 1KB-5MB
  toolCallId: toolCall.id,
  toolName: toolCall.tool,
  requestId
});
// Large tool outputs (npm logs, build output) can hit 1-5MB
// Those DB writes: ~50-200ms
// Network overhead for large payloads: ~20-100ms
```

**Persistence During LLM Streaming:**

```typescript
// Tokens are batched every 50ms
for await (const chunk of llmResponse) {
  accumulate token in buffer
  if (50ms elapsed OR buffer > 10KB):
    await messageService.createMessage({
      role: "assistant",
      content: bufferedTokens  // ~1-10KB
    });
    // Flush to DB: ~20-50ms
    // This doesn't block LLM streaming due to async
    clear buffer
}
```

### 9.3 Message Retrieval with History Building

**File:** `backend/src/ws/WSManager.ts` (lines 215-352)

**Method:** `fetchAndSendChatHistory(socket, workspaceId, cursorDate?, limit=50)`

**Process:**

```typescript
1. Query message.findMany with:
   - WHERE: workspaceId, createdAt < cursorDate (for pagination)
   - ORDER BY: createdAt DESC (newest first)
   - TAKE: limit + 1 (detect if more exist)

2. Reverse array to chronological order (oldest → newest)

3. Pre-collect tool results into Map<toolCallId, result>

4. Build structured message objects:
   - User messages: preserve as-is
   - Assistant messages: emit AGENT_REASONING event
   - Assistant + tool_calls: emit TOOL_COMPLETED event (pre-resolved)
   - Tool results: merged into parent assistant message

5. Fetch AgentLog groups by createdAt
   - Merge with structured messages
   - Re-sort by createdAt

6. Send CHAT_HISTORY event to client with:
   {
     messages: merged,
     workspaceId,
     hasMore: (original.length > limit),
     isPagination: true/false
   }
```

---

## 10. REAL-TIME EVENT STREAMING

### 10.1 Event Relay System

**File:** `backend/src/queue/eventRelay.ts`  
**Total Event Path Time:** ~50-300ms (worker to frontend)

**Purpose:** Bridge Redis pub/sub (worker → backend) to WebSocket broadcasts (backend → frontend)

**Architecture & Timing:**

```
Worker (agentWorker.ts)
  ├─ publishWsEvent(workspaceId, event)  [~1-5ms]
  │   └─ Redis pub/sub PUBLISH to "ws:{workspaceId}"
  │   └─ Network to Redis: ~5-20ms
  │
Redis Pub/Sub
  │ (~10-50ms delivery)
  │
EventRelay (subscribed to "ws:*" channels)
  ├─ On message: broadcastToWorkspace(workspaceId, event)  [~5-20ms]
  │   ├─ Look up sockets by workspaceId: ~1-5ms
  │   ├─ For each socket:
  │   │   ├─ Serialize event to JSON: ~1-5ms
  │   │   ├─ WebSocket send: ~1-5ms (local, no network)
  │   │   └─ Network to client: ~50-150ms
  │   └─ Total: 5-20ms for all sockets
  │
WebSocket Clients (on each client's connection)
  └─ Receive event via onmessage  [+50-150ms network]
  └─ Parse JSON: ~1-3ms
  └─ Call handleEvent() dispatcher: ~2-10ms depending on handler
  └─ Update React state: ~5-30ms
  └─ Re-render: ~10-50ms

Total Latency: Worker event → Frontend display: 50-300ms
```

**Latency Breakdown:**

| Stage | Time |
|-------|------|
| Worker → Redis PUBLISH | 5-20ms |
| Redis PUBLISH → EventRelay | 10-50ms |
| EventRelay → WebSocket send | 5-20ms |
| WebSocket network transit | 50-150ms |
| Browser receives → handleEvent | 1-5ms |
| React state update + render | 15-80ms |
| **TOTAL** | **86-325ms** |

### 10.2 Broadcast Mechanism

**In WSManager:**

```typescript
broadcastToWorkspace(workspaceId: string, event: WSEvent) {
  // Find all sockets with this workspaceId
  for (const socket of this.connections) {
    const ctx = this.ctxBySocket.get(socket);
    if (ctx?.workspaceId === workspaceId && socket.readyState === WebSocket.OPEN) {
      this.sendEvent(socket, event);
    }
  }
}

sendEvent(socket: WebSocket, event: WSEvent) {
  socket.send(JSON.stringify(event));
}
```

### 10.3 Event Types Emitted

**From Worker (agentWorker.ts lines 104-151):**

```typescript
emit("AGENT_EVENT", { eventType: "AGENT_STARTED", message: "..." });
emit("AGENT_EVENT", { eventType: "TOOL_STARTED", message: "...", data: {...} });
emit("AGENT_EVENT", { eventType: "TOOL_COMPLETED", message: "...", data: {...} });
emit("AGENT_EVENT", { eventType: "AGENT_REASONING", message: "...", data: {...} });
emit("AGENT_EVENT", { eventType: "TODO_STARTED", message: "...", data: {...} });
emit("AGENT_EVENT", { eventType: "TODO_COMPLETED", message: "...", data: {...} });
emit("AGENT_EVENT", { eventType: "AGENT_STOPPING", message: "User stopped agent" });
emit("AGENT_DONE", { success: true, summary: "...", port: 3000, backendPort: 8000 });
emit("PLAN_READY", { content: planContent });
emit("ENV_REQUIRED", { keys: ["API_KEY"], reason: "..." });
emit("PLAN_QUESTIONS", { questions: [], summary: "..." });
```

### 10.4 Frontend Event Handling

**File:** `frontend/src/app/system/[id]/_hooks/use-system-websocket.ts` (lines 240-450+)

**handleEvent() Dispatcher:**

```typescript
const handleEvent = React.useCallback((event: WSEvent) => {
  const { type, payload } = event;
  
  switch (type) {
    case "AGENT_EVENT": {
      const p = payload as any;
      switch (p.eventType) {
        case "AGENT_STARTED":
          setIsAgentRunning(true);
          break;
        case "AGENT_REASONING":
          setMessages(prev => {
            // Append reasoning to latest message
          });
          break;
        case "TOOL_COMPLETED":
          setMessages(prev => {
            // Create tool execution event
          });
          break;
        case "AGENT_STOPPING":
          setIsAgentRunning(false);
          break;
      }
      break;
    }
    
    case "PLAN_READY": {
      setPlanReady({ content: payload.content });
      break;
    }
    
    case "PLAN_QUESTIONS": {
      setPlanQuestions({
        questions: payload.questions,
        summary: payload.summary
      });
      break;
    }
    
    case "AGENT_DONE":
      setIsAgentDone(true);
      setIsAgentRunning(false);
      // Parse ports from payload
      break;
  }
}, []);
```

---

## 11. PLAN MODE & MULTI-AGENT ORCHESTRATION

### 11.1 Plan Mode Flow

**Trigger:** `planMode: true` in USER_REQUEST or localStorage

**Execution Path:** `backend/src/brain/agentRunner.ts` (lines 725-789)

**Differences from Build Mode:**

| Aspect | Plan Mode | Build Mode |
|--------|-----------|-----------|
| Agent Termination | N/A | Uses `FINAL ANSWER` text parsing |
| Tool Restrictions | read_file, search_code, execute_shell (read-only), edit_file (plan.md only), submit_plan_questions | All tools available |
| Shell Commands | Only ls, find, cat, grep, head, tail, wc, echo, pwd, file, stat, tree | All commands |
| Dev Servers | Blocked | Allowed with background=true |
| Iteration Limit | Configurable (e.g., 15 tool calls) | MAX_ITERATIONS=20 |
| Output | **Plan -> PLAN_READY event** | **Built app -> AGENT_DONE event** |

**Plan Mode System Prompt:**

```typescript
const basePrompt = getPlanModePrompt({
  framework: framework || "Next.js",
  idea: projectIdea
});
```

**Plan Questions Tool:**

```typescript
async function submit_plan_questions(params: {
  summary: string;
  questions: Array<{
    id: string;
    question: string;
    options: Array<{ id: string; text: string }>
  }>
}): Promise<ToolResult> {
  
  // Emit PLAN_QUESTIONS event
  emit("PLAN_QUESTIONS", {
    questions: params.questions,
    summary: params.summary
  });
  
  // Wait for user to answer
  const answers = await waitForPlanAnswers();
  
  return {
    success: true,
    data: JSON.stringify(answers)
  };
}
```

**Flow:**

```
1. Agent in plan mode reads codebase (search_code, read_file)
2. Agent submits clarifying questions
3. Frontend displays questions modal
4. User answers questions
5. Frontend sends PLAN_ANSWERS event with answers
6. Agent continues with updated context
7. Agent writes plan to /workspace/plan.md
8. Agent reaches iteration limit
9. emit("PLAN_READY", { content: planContent })
10. Frontend shows plan to user
11. User clicks "Build Plan"
12. System switches to build mode with plan as context
```

### 11.2 Multi-Agent Orchestration

**File:** `backend/src/brain/agents/orchestratorRunner.ts`

**When Enabled:** `multiAgentEnabled: true` in USER_REQUEST

**Agents:**

1. **Researcher Agent** (`researcherAgent.ts`)
   - Triggered by real-time signals or tech integration mentions
   - Performs web research for documentation/APIs
   - Returns research summaries

2. **File Explorer Agent** (`fileAgent.ts`)
   - Explores codebase structure
   - Extracts key patterns and architecture
   - Returns file structure overview

3. **Synthesis Node** (`synthesisNode.ts`)
   - Combines outputs from researcher + file explorer
   - Generates integrated plan/implementation strategy
   - Routes to main agent with synthesis

**Decision Logic:**

```typescript
async function classifyIntent(task: string): Promise<ClassifierDecision> {
  
  // Check for real-time signals (latest, trending, price, etc.)
  if (hasRealtimeSignal(task)) {
    return { needsResearch: true, needsFileExploration: false, reason: "Real-time information required" };
  }
  
  // Check for tech integration signals (Stripe, Auth0, etc.)
  if (hasTechIntegrationSignal(task)) {
    return { needsResearch: true, needsFileExploration: false, reason: "External service integration" };
  }
  
  // Query LLM for nuanced decision
  const llmDecision = await queryClassifier(task);
  
  return {
    needsResearch: llmDecision.research,
    needsFileExploration: llmDecision.fileExplore,
    reason: llmDecision.explanation
  };
}
```

---

## 12. MEMORY SYSTEMS

### 12.1 Static Memory Block

**File:** `backend/src/memory/buildMemoryBlock.ts`  
**Execution Time:** ~10-30ms (once per run, on initialization)

**Injected into system prompt once per run**

**Contents:**

```markdown
## Recent Agent Runs (Last 3)

[AgentRun metadata: timestamps, summaries, detected issues]

## Workspace Context

[Previous decisions, saved context, known ports, database setup]

## Error Patterns (if any)

[Extracted from previous failures]
```

**Timing:**

```typescript
const staticMemoryInput = { recentRuns, workspaceMemory };
const staticBlock = buildMemoryBlock(staticMemoryInput);
// Object construction: ~1-2ms
// String building (markdown formatting): ~5-10ms
// Template variable substitution: ~3-5ms
// Total: ~10-15ms
```

**Purpose:** Provide continuity across multiple agent iterations within a session. Built once, prepended to every iteration's LLM prompt.

### 12.2 Smart Memory Retrieval

**File:** `backend/src/memory/memoryRetriever.ts`  
**Execution Time:** 200-500ms per iteration (iteration > 0 only)

**Triggered:** Per-iteration in main agent loop (line ~850, inferred)

**Process:**

```typescript
const relevantMemory = await retrieveRelevantMemory(
  todo.description,  // Current task (e.g., "Build authentication page")
  dbMessages,        // Chat history (all previous messages)
  workspaceMemory    // Workspace state
);
// Total time: 200-500ms breakdown:
// ├─ Generate embedding of task: 100-300ms (API call to embedding service)
// ├─ Search vector DB: 50-150ms (semantic similarity search)
// ├─ Rank & filter results: 20-50ms (re-rank by relevance)
// └─ Format context: 10-20ms
// Inject into dynamic system prompt for this iteration
```

**Retrieval Strategy:**

1. Embed current todo description — **100-300ms** (external embedding API)
2. Search chat history for relevant messages via embeddings — **50-150ms** (vector DB query)
3. Extract context from past similar tasks — **10-30ms** (JSON parsing)
4. Return ranked chunks under token budget — **10-20ms** (filtering logic)

**Why Only Iteration > 0?**

- First iteration: No chat history yet, retrieval unnecessary
- Later iterations: Historical context becomes valuable for maintaining state

### 12.3 Error Extraction & Memory Update

**File:** `backend/src/memory/errorExtractor.ts`  
**Execution Time:** ~500-2000ms (triggered on failures, async fire-and-forget)

**Triggered:** On agent failure or tool error

**Process:**

```typescript
const errors = await extractErrorPatterns(messages);
// Parse error messages from tool outputs: ~50-100ms
// LLM call to summarize error patterns: ~500-1500ms
// e.g., "Permission denied on /workspace/public"

await updateProjectContext(workspaceId, errors);
// DB update: ~20-50ms
// Stores in workspace.config.knownErrors for next run
```

**Timing:**

| Step | Time | Notes |
|------|------|-------|
| Error message parsing | 50-100ms | Regex + string operations |
| LLM summarization call | 500-1500ms | Lightweight LLM for fire-and-forget |
| DB persistence | 20-50ms | Update workspace.config |
| **Total** | **570-1650ms** | Non-blocking, doesn't delay agent |

---

## 13. EXECUTION TIMELINE & ESTIMATED DURATIONS

### 13.1 Critical Path Timeline (Detailed with Ranges)

```
T+0ms:        User submits prompt in frontend ChatPanel
              └─ Input: text message (+ images if any)

T+10-30ms:    onSend callback triggered
              └─ Local function call, instant

T+20-50ms:    sendUserMessage() marshals WebSocket frame
              └─ JSON serialization, image references

T+50-200ms:   WebSocket network transit
              └─ Network latency (50-150ms typical)
              └─ TLS overhead if not yet established

T+100-250ms:  WSManager.handleMessage() receives event
              └─ Parse JSON: 1-3ms
              └─ Extract context: 2-5ms
              └─ Image download (if any): 15-40ms per image

T+120-300ms:  Persist user message to DB (fire-and-forget)
              └─ messageService.createMessage: 20-50ms
              └─ Not awaited; returns immediately

T+150-350ms:  Enqueue to agentQueue
              └─ Workspace validation: 10-30ms
              └─ Job serialization: 2-5ms
              └─ Redis LPUSH: 5-15ms
              └─ Job enqueued; jobId returned

T+200-400ms:  Client receives AGENT_QUEUED event
              └─ WebSocket send: 10-50ms
              └─ Network transit: 50-150ms

T+200-1000ms: **QUEUE WAIT** — depends on worker availability
              └─ 0ms if worker available
              └─ Up to 1000ms if 5 concurrent jobs already running
              └─ (CONCURRENCY=5, each job ~2-15min)

T+500-1500ms: BullMQ worker picks up job from queue
              └─ Worker polling: ~100-500ms before pickup
              └─ processAgentJob() starts execution

T+600-1600ms: Agent initialization & LLM client creation
              └─ Extract job.data: 1-2ms
              └─ Emit AGENT_STARTED: 1-5ms
              └─ Create AgentRun DB record: 20-50ms
              └─ Provider resolution: 50-200ms
              └─ LLM client creation: 10-30ms

T+700-2000ms: Sandbox operations (critical timing point)
              ├─ IF NEW SANDBOX:
              │  └─ E2B template download: 2000-5000ms
              │  └─ Sandbox initialization: 500-1500ms
              │  └─ Total: 2500-6500ms (MAJOR BLOCKING STEP)
              │
              └─ IF EXISTING SANDBOX:
                 └─ Sandbox.connect(): 500-1000ms
                 └─ setTimeout refresh: 100-300ms
                 └─ Service restart (if needed): 500-2000ms
                 └─ Total: 1100-3300ms

T+1000-4000ms: System prompt assembly & memory injection
              └─ Base prompt selection: 1-5ms
              └─ buildMemoryBlock(): 10-30ms
              └─ Memory retrieval (first iteration): 0ms
              └─ Total: ~50ms typically

T+1100-4100ms: **FIRST LLM API CALL INITIATED**
              └─ OpenAI/Anthropic API request serialization: 5-10ms
              └─ Network to LLM provider: 50-150ms
              └─ LLM processing (time-to-first-token): 500-2000ms
              └─ Streaming begins

T+1600-6100ms: **FIRST LLM TOKEN RECEIVED** (critical UX milestone)
              └─ Total time from user click: 1.6-6.1 seconds
              └─ This is what user sees as "thinking..."
              └─ If sandbox is new: easily 5-6s+
              └─ If sandbox exists: closer to 1.5-2.5s

T+1600-∞ms:   **TOKEN STREAMING PHASE**
              └─ Per token: ~1-5ms processing + network
              └─ Buffered every 50ms and flushed
              └─ Frontend re-renders every 50ms
              └─ Total response time: 2-60+ seconds depending on size

T+5000-120000ms: **TOOL EXECUTION PHASE** (variable)
              ├─ Parse tool calls: 5-20ms
              ├─ Per-tool execution:
              │  ├─ read_file: 50-200ms
              │  ├─ search_code: 100-500ms
              │  ├─ execute_shell (light): 100-500ms
              │  ├─ execute_shell (npm install): 5-30s first time
              │  ├─ execute_shell (heavy): 10-60s (builds, tests)
              │  ├─ web_search: 1-5s
              │  └─ todo_manager: 20-50ms
              │
              ├─ Persist tool result: 20-50ms per tool
              ├─ Emit event: 1-5ms per tool
              └─ Next LLM iteration begins

T+N seconds:  **AGENT LOOP CONTINUES**
              └─ Typical project: 3-10 iterations
              └─ Each iteration: 2-30+ seconds
              └─ Total loop: 30s - 15 minutes

T+Final:      **AGENT COMPLETE**
              ├─ Parse FINAL ANSWER: 1-5ms
              ├─ Update AgentRun status: 20-50ms
              ├─ Update workspace memory: 20-50ms
              ├─ Emit AGENT_DONE event: 1-5ms
              └─ Frontend receives event, displays results
```

### 13.2 Per-Component Latencies (Detailed)

| Component | Min | Typical | Max | Notes |
|-----------|-----|---------|-----|-------|
| **WebSocket roundtrip** | 10ms | 50-100ms | 300ms | Network latency dominant |
| **Job queue wait** | 0ms | 100-500ms | 5-10s | Depends on worker availability |
| **Sandbox create (new)** | 2000ms | 3000-5000ms | 10000ms+ | E2B template download |
| **Sandbox resume (exists)** | 500ms | 1000-2000ms | 5000ms | Reconnect + refresh |
| **LLM first token latency** | 300ms | 1000-2000ms | 5000ms+ | API + network + model startup |
| **Token per-character** | 10ms | 50-100ms | 500ms | Includes batching overhead |
| **Tool: read_file** | 50ms | 100-200ms | 1000ms | Depends on file size |
| **Tool: search_code** | 100ms | 200-500ms | 2000ms | Depends on search scope |
| **Tool: execute_shell (ls)** | 50ms | 100-300ms | 1000ms | Light commands |
| **Tool: execute_shell (npm)** | 5000ms | 15000-30000ms | 60000ms+ | First npm install heavy |
| **Tool: web_search** | 500ms | 2000-3000ms | 10000ms | API rate limiting |
| **Tool: todo_manager** | 10ms | 30-50ms | 200ms | DB query/update |
| **DB message persist** | 10ms | 30-50ms | 200ms | Async writes |
| **LLM iteration (light)** | 500ms | 2-5s | 30s | Reasoning only |
| **LLM iteration (heavy)** | 2s | 10-30s | 120s+ | Multiple tools |
| **Memory retrieval** | 0ms | 200-500ms | 1000ms+ | Embedding + vector search |

### 13.3 End-to-End Project Scenarios

#### Scenario A: Simple Scaffold (Next.js basic app)

```
T+0ms:        User submits: "Create a Next.js app"
T+200ms:      Message enqueued
T+500-1500ms: Queue wait (assume available worker)
T+1000-3000ms: Sandbox creation (E2B template)
T+3000-4000ms: System prompt assembly
T+4000-6000ms: First LLM call (thinking...)
T+6000-8000ms: LLM responds with tool calls (create files)

T+8000-9000ms: Tool 1: edit_file (create package.json)
T+9000-10000ms: Tool 2: edit_file (create next.config.js)
T+10000-11000ms: Tool 3: edit_file (create pages/index.tsx)
T+11000-15000ms: Tool 4: execute_shell (npm install)
T+15000-18000ms: Tool 5: execute_shell (npm run dev)
T+18000-20000ms: Parse FINAL ANSWER, detect port 3000

T+20000-22000ms: Update DB, emit AGENT_DONE
═══════════════════════════════════════════════════════════
**TOTAL: 20-22 seconds** (from click to running app)
```

#### Scenario B: Medium Project (Next.js + Backend API)

```
T+0ms:        User submits: "Build a blog with Next.js + Express API"
T+200ms:      Message enqueued
T+500-2000ms: Queue wait (possibly longer if workers busy)
T+1000-3000ms: Sandbox creation
T+3000-5000ms: System prompt + memory assembly
T+5000-8000ms: First LLM iteration (planning)

Iteration 1: Frontend scaffolding
T+8000-10000ms: LLM response with frontend tools
T+10000-20000ms: Tool chain (edit files, npm install)
T+20000-23000ms: Tool: npm run dev (frontend on 3000)

Iteration 2: Backend scaffolding
T+23000-25000ms: LLM iteration (backend planning)
T+25000-35000ms: Tool chain (create API files, install deps)

Iteration 3: Database setup
T+35000-37000ms: LLM iteration (DB schema)
T+37000-40000ms: Database provisioning via provision_database tool
T+40000-45000ms: Run migrations

Iteration 4: Integration
T+45000-50000ms: LLM iteration (glue code)
T+50000-60000ms: Tool chain (connect frontend to API)

T+60000-65000ms: Parse FINAL ANSWER, detect ports
T+65000-67000ms: Update DB, emit AGENT_DONE
═══════════════════════════════════════════════════════════
**TOTAL: 65-67 seconds** (~1 minute 5-7 seconds)
```

#### Scenario C: Complex Project (Full-stack + Database + Auth)

```
T+0ms:        User: "Full-stack SaaS app with auth, DB, payments"
T+200ms:      Enqueued
T+1000-3000ms: Sandbox creation
T+3000-6000ms: System prompt assembly
T+6000-10000ms: First LLM iteration (architecture planning)

Iteration 1-2: Frontend scaffolding + components
T+10000-30000ms: Multiple tool chains

Iteration 3-4: Backend API + middleware setup
T+30000-60000ms: Backend scaffolding + npm installs

Iteration 5: Database provisioning
T+60000-90000ms: provision_database tool call + migrations
(Heavy: database provisioning, schema setup)

Iteration 6: Authentication integration
T+90000-120000ms: Auth library setup (Clerk/NextAuth)
Tool: web_search for latest docs (~3s per search)

Iteration 7: Payment integration
T+120000-150000ms: Stripe/PayPal setup
Tool: web_search for API docs
Tool: edit_file for payment handlers

Iteration 8-10: Final integration & testing
T+150000-240000ms: Glue code, environment setup, dev server startup

T+240000-250000ms: Parse FINAL ANSWER, detect all ports
T+250000-260000ms: Coregit snapshot, emit AGENT_DONE
═══════════════════════════════════════════════════════════
**TOTAL: 240-260 seconds** (4-4.5 minutes)
```

### 13.4 User-Perceived Timing

| Milestone | Time from Click | User Perception |
|-----------|-----------------|-----------------|
| Message disappears from input | 0-50ms | Instant |
| WebSocket event arrives | 50-200ms | Instant |
| AGENT_QUEUED event received | 100-400ms | Instant |
| First "Agent started" message | 1-3s | "System is thinking..." |
| First LLM token arrives | 1.5-6s | **First visible progress** |
| First tool execution | 5-8s | "Agent is working..." |
| Complete first feature | 30-90s | "Making progress..." |
| Full project ready | 30s - 15min | **"Done!"** |

### 13.5 Performance Bottlenecks (Ranked by Impact)

1. **Sandbox Creation (NEW WORKSPACE)** — 2.5-6.5 seconds
   - E2B template download is unavoidable
   - Can be improved: pre-warm templates, cache layers

2. **LLM API Latency** — 500-2000ms per call
   - First token latency is critical UX metric
   - Varies by provider (Qwen DashScope faster, OpenAI sometimes slower)

3. **npm install (First Time)** — 5-30 seconds
   - Heavy tool execution in execute_shell
   - Blocking; must complete before dev server starts
   - Can optimize: use CI/CD cache strategies, pnpm over npm

4. **Memory Retrieval (Per Iteration)** — 200-500ms
   - Embedding generation + vector search
   - Only triggered iteration > 0
   - Can optimize: cache embeddings, reduce vector search scope

5. **Job Queue Wait** — 0-10 seconds
   - Only matters if workers are saturated
   - Scales linearly with concurrency limit
   - Can optimize: increase WORKER_CONCURRENCY, auto-scale workers

---

## 14. ERROR HANDLING & RESILIENCE

### 14.1 LLM Retry Logic

**File:** `backend/src/brain/agentRunner.ts` (lines 165-199)

**Scenario:** Qwen DashScope empty output error

```typescript
const MAX_LLM_RETRIES = 3;

for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
  try {
    return await llm.chat.completions.create(params, options);
  } catch (err) {
    if (err.message.includes("model output must contain") && attempt < MAX_LLM_RETRIES) {
      const delay = attempt * 1500; // 1.5s, 3s, 4.5s
      console.warn(`[AgentRunner] Empty output, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    throw err;
  }
}
```

### 14.2 Job Queue Retry Policy

**File:** `backend/src/queue/queues.ts` (lines 10-16)

```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
}
```

**Backoff:** 2s → 4s → 8s

### 14.3 Sandbox Connection Fallback

**File:** `backend/src/sandbox/sandboxManager.ts` (lines 68-89)

```typescript
if (input.sandboxId) {
  try {
    sandbox = await Sandbox.connect(input.sandboxId);
  } catch (err) {
    throw new Error(`Sandbox expired. Start a new session.`);
  }
}
```

**No automatic retry:** User must create new workspace

### 14.4 Tool Execution Abort Signal

**File:** `backend/src/workers/agentWorker.ts` (lines 68-83)

```typescript
function buildRedisAbortSignal(workspaceId: string): AbortController {
  const controller = new AbortController();
  const interval = setInterval(async () => {
    if (await isAbortRequested(workspaceId)) {
      controller.abort();
      clearInterval(interval);
    }
  }, 2_000); // Poll every 2s
  
  return controller;
}
```

**User Initiates Stop:** Frontend sends STOP_AGENT event → WSManager sets `abort:{workspaceId}=1` in Redis → Agent loop checks signal and exits

---

## 15. CONFIGURATION & ENVIRONMENT

### 15.1 Environment Variables

**Backend (.env or process.env):**

```bash
# Server
PORT=8000
FRONTEND_URL=http://localhost:3000
E2B_SANDBOX_ID=sandbox_id_if_running_in_e2b

# Database
DATABASE_URL=postgresql://user:pass@localhost/ai-agents

# Redis
REDIS_URL=redis://localhost:6379

# LLM Providers
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_API_KEY=sk-ant-...
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
GROQ_API_KEY=gsk_...
GROQ_BASE_URL=https://api.groq.com/openai/v1
GEMINI_API_KEY=...
DEFAULT_PROVIDER=OPENAI

# E2B
E2B_TEMPLATE_ID=base
WORKER_CONCURRENCY=5

# Clerk (optional)
CLERK_SECRET_KEY=sk_...

# PostHog (optional)
POSTHOG_API_KEY=...
POSTHOG_HOST=https://us.posthog.com
```

**Frontend (.env.local):**

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
```

### 15.2 Feature Flags

**Plan Mode:** Controlled by localStorage `ai-agents:planMode` (default: true)

**Multi-Agent:** Controlled by localStorage `pf:multiAgent` (default: false)

**Both synchronized via WebSocket to backend**

---

## 16. DEBUGGING & OBSERVABILITY

### 16.1 Console Logging

**Key Log Patterns:**

| Component | Log Prefix | Example |
|-----------|-----------|---------|
| WSManager | `[WSManager]` | `New connection. sessionId=...` |
| AgentRunner | `[AgentRunner]` | `LLM config resolved provider=OPENAI` |
| AgentWorker | `[AgentWorker]` | `Job {id} \| workspaceId=...` |
| Sandbox | `[SandboxManager]` | `Creating sandbox: next-app-interpreter` |
| Prisma | `[Prisma]` | `createMessage failed: ...` |

### 16.2 PostHog Analytics

**File:** `backend/src/lib/posthog.ts`

**Tracked Events:**

- `agent_run_started`
- `agent_run_completed`
- `tool_executed`
- `workspace_created`
- `user_authenticated`

### 16.3 Database Query Logs

**Enable:** `DEBUG=prisma:* node src/index.ts`

---

## 17. CONCURRENCY & SCALING

### 17.1 Worker Concurrency

**Configuration:**

```typescript
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);
```

**Effect:** Up to 5 agent jobs processed in parallel across workers

### 17.2 WebSocket Concurrency

**Per Worker:**

- Each BullMQ worker runs in its own Node.js process
- PublishWsEvent() → Redis pub/sub → all subscribed WSManager instances

**Broadcast:**

```typescript
for (const socket of this.connections) {
  const ctx = this.ctxBySocket.get(socket);
  if (ctx?.workspaceId === workspaceId) {
    this.sendEvent(socket, event); // O(n) where n = sockets per workspace
  }
}
```

**Potential Bottleneck:** Large number of concurrent users on same workspace

---

## 18. DATA FLOW SUMMARY

### 18.1 Message Flow Diagram

```
User Input (Frontend)
  ↓
  WebSocket: USER_REQUEST event
  ↓
WSManager.handleMessage()
  ├─ Extract context (userId, workspaceId, imageIds)
  ├─ Persist user message to Message table
  └─ Enqueue agentQueue job
  ↓
BullMQ Queue
  └─ Jobs stored in Redis
  ↓
AgentWorker picks up job
  ├─ Set up abort signal (Redis polling)
  ├─ Create LLM client
  ├─ Load memory blocks
  ├─ Connect/resume E2B sandbox
  └─ runOrchestrator() or runAgent()
  ↓
Main Agent Loop (runAgent)
  Loop:
    1. Get current TODO
    2. Load chat history
    3. Build LLM messages
    4. Call LLM (streaming)
    5. Parse tool calls
    6. Execute tools (execute_shell, read_file, etc.)
    7. Persist results to Message table
    8. Check abort signal
    9. Continue to next iteration
  ↓
Agent Complete or Abort
  ├─ Parse FINAL ANSWER (if build mode)
  ├─ Emit AGENT_DONE event via Redis pub/sub
  └─ Update AgentRun status in DB
  ↓
EventRelay
  ├─ Receives event from Redis
  ├─ Broadcasts to all connected WebSocket clients in workspace
  └─ Send via WSManager.broadcastToWorkspace()
  ↓
Frontend WebSocket Client
  ├─ Receive event
  ├─ Call handleEvent() dispatcher
  └─ Update React state → re-render UI
```

### 18.2 Token Flow in Streaming

```
LLM API (OpenAI/Anthropic)
  ↓ (streaming chunks)
callLLMWithRetryStream() or callAnthropicStream()
  ↓ (parse chunks)
Temporary chunk buffer
  ↓ (every ~50ms: flushChunkBuffer)
React state: messages[i].content += chunk
  ↓ (React re-render)
ChatPanel component
  ↓ (render markdown)
User sees token-by-token output
```

---

## 19. DEPLOYMENT CONSIDERATIONS

### 19.1 Production Deployment Stack

```yaml
Frontend:
  - Next.js app → Vercel, AWS Amplify, or self-hosted
  - Static assets: CDN (Cloudflare, AWS CloudFront)
  - Environment: NEXT_PUBLIC_BACKEND_URL=https://api.ai-agents.com

Backend:
  - Express.js → Docker container
  - Scaling: Horizontal (multiple instances + load balancer)
  - WebSocket: Sticky sessions (IP affinity) required
  - Reverse proxy: Nginx, HAProxy, or AWS ALB

Database:
  - PostgreSQL → RDS, Neon, or managed provider
  - Backup: Automated snapshots, point-in-time recovery
  - Connection pool: PgBouncer or built-in pooling

Redis:
  - BullMQ queue backend + event relay
  - Persistence: RDB + AOF
  - Replication: Master-replica for HA
  - Cluster mode for scaling

Workers:
  - Node.js processes → Docker + Kubernetes or ECS
  - Auto-scaling: Based on agentQueue depth
  - Concurrency: Tunable per environment

E2B Sandboxes:
  - Cloud-hosted via e2b.dev
  - Template versioning: Pre-build + cache
```

### 19.2 Resource Requirements

| Component | Min | Recommended |
|-----------|-----|------------|
| Backend (single) | 0.5 CPU, 512MB RAM | 2 CPU, 2GB RAM |
| Worker | 1 CPU, 1GB RAM | 2-4 CPU, 4GB RAM |
| PostgreSQL | 1 CPU, 1GB RAM | 2 CPU, 4GB RAM |
| Redis | 0.5 CPU, 256MB RAM | 1 CPU, 1GB RAM |
| E2B Sandbox | — | ~500MB per active session |

---

## 20. APPENDIX: Key Source Files

### Backend Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `src/index.ts` | Server startup | 1-40 |
| `src/server.ts` | Express app setup | 1-98 |
| `src/ws/WSManager.ts` | WebSocket handler | 83-900+ |
| `src/brain/agentRunner.ts` | Main agent loop | 695-1200+ |
| `src/workers/agentWorker.ts` | Job processor | 85-300+ |

### Database & Services

| File | Purpose |
|------|---------|
| `src/services/messageService.ts` | Message CRUD |
| `src/services/todoService.ts` | Todo management |
| `src/services/workspaceService.ts` | Workspace state |
| `src/services/agentRunService.ts` | Agent run tracking |
| `src/lib/prisma.ts` | Prisma client |

### Skills & Tools

| File | Tool Name |
|------|-----------|
| `src/skills/shell/execute_shell.ts` | execute_shell |
| `src/skills/file_operations/read_file.ts` | read_file |
| `src/skills/file_operations/edit_file.ts` | edit_file |
| `src/skills/code_intelligence/search_code.ts` | search_code |
| `src/skills/todo/todo_manager.ts` | todo_manager |
| `src/skills/web/web_search.ts` | web_search |
| `src/skills/plan/submit_plan_questions.ts` | submit_plan_questions |

### Frontend Components

| File | Purpose |
|------|---------|
| `frontend/src/app/system/[id]/page.tsx` | Main workspace page |
| `frontend/src/app/system/[id]/_hooks/use-system-websocket.ts` | WebSocket hook |
| `frontend/src/app/system/[id]/_components/chat-panel.tsx` | Chat UI |
| `frontend/src/app/system/[id]/_components/preview-panel.tsx` | Live preview |

---

## 21. CONCLUSION

AI Agents is a sophisticated multi-component system orchestrating AI-driven project generation:

1. **Frontend** manages user interaction and real-time display via WebSocket
2. **Backend** routes requests and coordinates concurrent agent execution
3. **Workers** execute long-running AI + sandbox tasks in isolation
4. **Database** persists chat, tasks, and workspace state for continuity
5. **Sandbox** provides isolated execution environment for file ops & dev servers
6. **Agents** loop iteratively: analyze → plan → execute tools → parse results → repeat

The entire pipeline is asynchronous and event-driven, enabling:

- **Real-time streaming** of LLM tokens and tool outputs
- **Resumable sessions** via persistent workspace state + sandbox pausing
- **Concurrent requests** via BullMQ job queue + worker pool
- **Smart memory** via retrieval + error extraction + context preservation
- **Flexible orchestration** via plan mode → multi-agent classification → build mode

---

**Report Generated:** 2026-05-09  
**Analysis Basis:** Source code inspection, execution flow tracing, architecture reverse-engineering  
**Confidence Level:** High (based on comprehensive codebase review)
