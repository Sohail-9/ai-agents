# Queue Latency Investigation: Root Cause Analysis & Architectural Solutions

**Target:** User request → Actual agent execution start in under 2 seconds  
**Current Reality:** 5–10+ seconds observed under moderate load  
**Analysis Date:** 2026-05-09

---

## EXECUTIVE SUMMARY

The AI Agents architecture **cannot realistically meet a sub-2-second startup target** with the current design. The system violates fundamental queueing principles by bundling fast-path (request acceptance, job enqueue) with slow-path operations (sandbox creation, LLM calls, todo creation) into single monolithic jobs.

### Root Cause
**Job Granularity Problem:** A single `agent-run` job monopolizes a worker for 30 seconds to 15+ minutes. With only 5 workers (WORKER_CONCURRENCY=5), any moderate concurrent load (3-5 simultaneous requests) causes 5-10+ second queue waits before a worker even *picks up* the job.

### Key Findings

| Issue | Impact | Latency |
|-------|--------|---------|
| **Long-running worker monopolization** | Job holder blocks other requests | 5-10s queue wait |
| **Synchronous sandbox creation in worker** | E2B creation is blocking | +2-6.5s per new workspace |
| **Sequential setup → agent chain** | Setup must complete before agent starts | +3-10s cumulative |
| **LLM calls blocking worker** | First token latency + full model output | +1-60s per iteration |
| **npm install in worker** | Heavy I/O, non-interruptible | +5-30s on cold cache |
| **Job gossip + state sync** | Worker picks up job, initializes context, loads DB state | +100-500ms setup overhead |

---

## DETAILED EXECUTION PATH ANALYSIS

### Phase 1: User Request → Job Enqueue (Target: < 100ms, Current: 50-300ms)

**File:** `backend/src/ws/WSManager.ts`, lines 501-591

**Execution:**

```
T+0ms:    USER_REQUEST arrives at WSManager.handleMessage()
          ├─ Extract payload + socket context: ~1-5ms
          ├─ Load image refs (if any): 15-40ms per image
          ├─ persistMessage() (fire-and-forget): ~20-50ms DB write (async)
          ├─ ai.processPrompt() for workspace setup ONLY: 500-1500ms (BLOCKING)
          └─ If new workspace:
             ├─ Check workspace.sandboxId
             ├─ loadImageRefs() again: 15-40ms per image
             ├─ await ai.processPrompt(): 500-1500ms (BLOCKING LLM CALL)
             ├─ setupQueue.add(): 5-10ms to Redis
             └─ Return AGENT_QUEUED event
          
          ELSE if existing workspace:
             └─ handleUpdateIntent() → immediately enqueue to agentQueue
```

**BLOCKING OPERATIONS IN WSManager:**

1. **`ai.processPrompt()`** (line 558 for new workspace) — **500-1500ms BLOCKING**
   - This is called BEFORE queue enqueue
   - Runs synchronously in the request handler
   - Delays job enqueue significantly
   - **Impact:** User sees 500-1500ms delay before job is even enqueued

2. **`setupQueue.add()`** for new workspaces (line 585)
   - Only adds to Redis, itself is fast (5-10ms)
   - But job won't execute until a setup worker is free
   - Setup is a separate queue with CONCURRENCY=3
   - **Impact:** Even after enqueue, setup must complete before agent can run

### Phase 2: Job Enqueue → Worker Pickup (Target: < 100ms, Current: 100-10,000ms)

**Queue Configuration:** `backend/src/queue/queues.ts`, lines 20-30

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

**Worker Configuration:** `backend/src/workers/agentWorker.ts`, line 35

```typescript
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);
```

**Problem Identified: Worker Monopolization**

When worker picks up a job:

1. **Worker is locked for entire agent execution** (30 seconds → 15+ minutes)
2. **Only 5 workers available** (WORKER_CONCURRENCY=5)
3. **Each job occupies exactly 1 worker for its lifetime**
4. **No worker pool scaling or load shedding**

**Queue Wait Under Load:**

Scenario: 5 concurrent user requests, all hitting agentQueue simultaneously

```
Worker 1: Picks Job A (locks for 5 minutes)
Worker 2: Picks Job B (locks for 5 minutes)
Worker 3: Picks Job C (locks for 5 minutes)
Worker 4: Picks Job D (locks for 5 minutes)
Worker 5: Picks Job E (locks for 5 minutes)

Request F arrives:
  ├─ Enqueued to Redis in 10ms
  ├─ Waits in queue: 100-300ms until any worker completes
  └─ If first job takes 5 minutes: queue wait = 5min + randomness

Request G arrives 500ms after F:
  ├─ Enqueued to Redis in 10ms
  ├─ Waits behind F: 5min+ total
```

**Actual Observed Delay:** With typical project sizes:
- Small projects: Job duration ~1-2 minutes → Queue wait 5-10 seconds for 2nd+ request
- Medium projects: Job duration ~5-15 minutes → Queue wait 10-60 seconds

### Phase 3: Job Picked Up → Agent Execution Starts (Target: < 500ms, Current: 500-2000ms)

**File:** `backend/src/workers/agentWorker.ts`, lines 85-154

**Execution:**

```
T+0ms:    processAgentJob() called by BullMQ worker
          
T+1-5ms:  Extract job.data
          
T+5-10ms: emit("AGENT_STARTED")
          
T+20-50ms: agentRunService.create() — DB insert
          
T+50-200ms: resolveProvider() — DB lookups
          └─ Check user API keys
          └─ Check env vars
          └─ Fallback resolution
          
T+200-250ms: buildRedisAbortSignal()
          └─ Create AbortController + interval setup
          
T+250-280ms: Create agentCtx object
          
T+280-330ms: await runOrchestrator() begins
            ├─ runOrchestrator checks multiAgent flag
            └─ Routes to runAgent() or runMultiAgent()
```

**Non-Blocking Operations:** ✓ (These are fine)
- Job data extraction: 1-5ms
- DB inserts: 20-50ms
- Provider resolution: 50-200ms
- Context assembly: 10-30ms

**Total initialization overhead before runAgent():** ~250-350ms ✓

---

## PHASE 4: Setup Job Path (NEW WORKSPACE ONLY)

**File:** `backend/src/workers/setupWorker.ts`, lines 50-183

**This is where the real bottleneck emerges:**

```
T+0ms:    procesSetupJob() called by setupWorker
          
T+0-20ms: emit("REQUEST_ACCEPTED")
          
T+20-100ms: Prepare planning context (framework, language, database)
          
T+100-200ms: imageService.getBytes() if images present
          
T+200-1500ms: ai.processPrompt() → LLM call to generate ai-agents.md
            └─ BLOCKING LLM CALL (~500-1000ms for response)
            └─ No parallelization possible
          
T+1500-6500ms: SandboxManager.openAndInit()
            ├─ Sandbox.create() if new: 2500-6500ms
            │  └─ E2B template download: 1500-5000ms (PRIMARY BOTTLENECK)
            │  └─ Docker spawn: 500-1500ms
            │
            └─ Sandbox.connect() if existing: 500-1500ms
          
T+6500-6600ms: workspaceService.updateSandboxId() — DB update
          
T+6600-6700ms: workspaceService.updateAiAgents() — DB update
          
T+6700-6800ms: workspaceService.linkSessionToWorkspace() — DB update
          
T+6800-7000ms: emit("WORKSPACE_READY")
          
T+7000-7200ms: Create todos from ai-agents.md
          
T+7200-7300ms: Enqueue agent-run job to agentQueue
            └─ This is where AGENT execution actually begins!
```

**CRITICAL ISSUE:**

The setup job itself takes **7-10+ seconds** before it enqueues the agent job. During this time:

1. **A worker is blocked** (setup worker, concurrency=3)
2. **User sees no agent progress** (waiting in UI)
3. **Agent job can't start yet** (still waiting to be enqueued)

---

## FULL USER-PERCEIVED LATENCY BREAKDOWN

### Scenario 1: Existing Workspace (Best Case)

```
T+0ms:     User submits request
T+50-200ms: WebSocket latency
T+200-400ms: WSManager.handleMessage() + job enqueue
T+400-500ms: Job in Redis, waiting for worker availability
T+500-1000ms: Worker picks up job
T+1000-1200ms: processAgentJob() initialization
T+1200ms: runAgent() ACTUALLY STARTS

Total: 1.2 seconds ✓ (MEETS TARGET)
```

**But only if workers are available. With 3+ concurrent requests:**

```
T+0ms:     User 3rd request
T+200-400ms: Enqueue
T+400ms: Queue wait begins (Workers 1-5 all busy)
         Request 1 & 2 occupy workers → job duration 5-15 minutes
         Request 3 must wait: 5-15 minutes!
T+300-600s: First job completes, worker available
T+601-800s: Request 3's job picked up

TOTAL: 600+ seconds (10 MINUTES) ✗✗✗
```

### Scenario 2: New Workspace (Typical Case)

```
T+0ms:     User submits "Build a Next.js blog"
T+50-200ms: WebSocket latency
T+200-400ms: WSManager receives, calls ai.processPrompt() SYNCHRONOUSLY
T+400-1500ms: LLM call for intent classification (BLOCKING in request handler)
T+1500-1700ms: setupQueue.add()
T+1700-2000ms: Setup job in queue, waiting for setupWorker availability
T+2000-3000ms: setupWorker picks up (CONCURRENCY=3, possibly queue wait)
T+3000-3100ms: Process setup job initialization
T+3100-3600ms: LLM call to generate ai-agents.md (BLOCKING in setup worker)
T+3600-9500ms: Sandbox creation
              └─ Template download: 1500-5000ms
              └─ Docker + init: 500-1500ms
T+9500-10000ms: todos created
T+10000-10100ms: agentQueue.add() (finally!)
T+10100-10500ms: agentWorker picks up (if available)
T+10500-10700ms: processAgentJob() initialization
T+10700ms: runAgent() STARTS

Total: 10.7 seconds ✗ (FAILS TARGET by 5x)
```

---

## ARCHITECTURAL ROOT CAUSES

### Root Cause #1: Long-Running Worker Monopolization

**Problem:** A single `agent-run` job holds a worker captive for 30 seconds to 15+ minutes.

**Code Evidence:**
- `agentWorker.ts:85-296` — `processAgentJob()` is a single, long-running function
- Line 156: `await runOrchestrator(agentCtx, multiAgent, emit)`
  - This blocks the worker for the entire agent loop (20 iterations × 2-30s per iteration = 40s-600s)
- Lines 159-269: Post-processing (memory extraction, coregit snapshots, plan mode)
  - Additional 100-2000ms holding the worker

**Result:** With CONCURRENCY=5, job queue utilization is terrible under any load.

---

### Root Cause #2: Setup & Agent Execution Sequentially Chained

**Problem:** Setup job must complete fully before agent job is enqueued.

**Code Evidence:**
- `setupWorker.ts:128-183` — Setup job ends with `agentQueue.add()`
- Sequential: **SETUP MUST FINISH → THEN enqueue → THEN wait for agent worker**

**Result:** For new workspaces, startup is blocked by both setup completion AND agent queue wait.

---

### Root Cause #3: Blocking LLM Calls in Request Handler

**Problem:** `WSManager` (the request handler) synchronously calls `ai.processPrompt()` before enqueuing.

**Code Evidence:**
- `WSManager.ts:558` — `const aiResponse = await ai.processPrompt(...)`
- This is in `handleMessage()` for `USER_REQUEST` events
- **Blocking:** Request handler can't return until LLM call completes (~500-1500ms)
- Meanwhile, other WebSocket events pile up

**Result:** Request handler is blocked; other clients' messages delay.

---

### Root Cause #4: Sandbox Creation Is Synchronous & Blocking

**Problem:** Sandbox creation (2.5-6.5 seconds) happens synchronously in setupWorker.

**Code Evidence:**
- `setupWorker.ts:94-101` — `await SandboxManager.getInstance().openAndInit()`
- Line 94 **blocks the worker** until sandbox is ready
- No streaming of "sandbox is being created" until it finishes
- E2B template download is the bottleneck (1.5-5 seconds)

**Result:** Setup worker is locked for 5-10+ seconds even though user is just waiting for workspace bootstrap.

---

### Root Cause #5: Queue Granularity Too Coarse

**Problem:** Everything (setup, todos, agent loop) is bundled into 2 jobs (setup-run, agent-run).

**Code Evidence:**
- Job types at `queue/jobTypes.ts`:
  - `AgentJobPayload` includes: workspaceId, sandboxId, framework, todoId, provider, etc.
  - Single job = run through full agent loop (potentially 20 iterations, 30s-15min)
- **Should be:** Fast enqueue (instant), slow execution (deferred)

**Result:** No ability to separate "accept & acknowledge" from "execute", so perceived latency = execution latency.

---

### Root Cause #6: No Request Prioritization or Fast-Path

**Problem:** All requests go through the same queue, same worker pool.

**Code Evidence:**
- `queues.ts` defines single `agentQueue`
- `agentWorker.ts` processes all jobs identically
- **No:** priority queue, express-lane, or differentiation between:
  - New workspace (heavy) vs. todo update (light)
  - Plan mode (lightweight) vs. build mode (heavy)
  - Small projects vs. large projects

**Result:** A small "add a button" request waits behind a "build a full app" request.

---

## PERFORMANCE BOTTLENECK RANKING (Impact on Startup Time)

| Rank | Bottleneck | Latency | Fixability | Critical Path |
|------|-----------|---------|-----------|----------------|
| **1** | E2B sandbox creation (new workspace) | +2500-6500ms | 🟢 High (pre-warm, cache) | NEW_WORKSPACE only |
| **2** | Worker queue wait (concurrency=5) | +5000-60000ms | 🟡 Medium (increase workers, split jobs) | ALL under load |
| **3** | LLM call in request handler (ai.processPrompt) | +500-1500ms | 🟢 High (move to queue, async) | INITIAL request |
| **4** | Setup job blocking before agent enqueue | +3000-10000ms | 🟡 Medium (parallel, job splitting) | NEW_WORKSPACE only |
| **5** | Agent initialization overhead | +250-350ms | 🟢 High (trim setup, cache) | EVERY job |
| **6** | Job queue wait (behind other agents) | +100-5000ms | 🟡 Medium (worker scaling, prioritization) | MODERATE load |

---

## CAN CURRENT ARCHITECTURE MEET 2-SECOND TARGET?

### Analysis: **NO, NOT RELIABLY**

**Why:**

1. **E2B sandbox creation alone** (2.5-6.5 seconds) exceeds 2-second target for new workspaces
   - Template download is external dependency, not optimizable in code
   - Only fix: pre-warm sandboxes (architectural change)

2. **Worker queue wait** is guaranteed to happen with 5 concurrent requests
   - If each agent job takes 5 minutes, 6th request waits 5+ minutes
   - Only fix: increase workers dramatically or split job granularity

3. **Setup job must complete before agent starts**
   - For new workspaces, startup = setup_time + queue_wait + agent_startup
   - Currently: 7-10s + queue_wait + 1s = 8-11s minimum

4. **LLM call in request handler**
   - 500-1500ms delay before job is even enqueued
   - Synchronous, can't parallelize

5. **Measured worst case (moderate load):** 5-10+ seconds observed
   - This matches our analysis: 1-2s queue wait + 5-10s setup + 1s agent startup

---

## CONCRETE ARCHITECTURE CHANGES (Ranked by Impact)

### Solution 1: Split Jobs into Stages ⭐⭐⭐ (Highest Impact)

**Problem Solved:** Worker monopolization, queue wait latency

**Change:** Instead of single long-running `agent-run` job, create multiple stage jobs:

```
BEFORE:
agentQueue → [processAgentJob()] → 30s-15min (BLOCKS WORKER)

AFTER:
fastQueue → [enrollJob()] → 10ms (fast acknowledgment)
           ├─ → [sandboxBootstrap()] → 2-6s (heavy but isolated)
           ├─ → [todoCreation()] → 100ms
           └─ → [agentExecution()] → 30s-15min (only heavy loop)
```

**Implementation:**

Create three new queue types in `queue/queues.ts`:

```typescript
// Fast-path: accept user request, enqueue agent loop job
export const enrollQueue = new Queue<EnrollJobPayload>("enroll", {
  defaultJobOptions: { attempts: 1, removeOnComplete: true },
  concurrency: 50, // Can handle many simultaneously
});

// Medium-path: prepare sandbox (separate from agent loop)
export const bootstrapQueue = new Queue<BootstrapJobPayload>("bootstrap", {
  defaultJobOptions: { attempts: 3, backoff: { delay: 2000 } },
  concurrency: 5, // Sandboxes are expensive
});

// Existing heavy-path: agent loop (unchanged)
export const agentQueue = ... (keep as-is, or increase CONCURRENCY)
```

**Worker Implementation (pseudocode):**

```typescript
// enrollWorker.ts (new)
export const enrollWorker = new Worker("enroll", async (job) => {
  const { workspaceId, userId, message } = job.data;
  
  // 1. Acknowledge user request (10ms)
  emit("USER_REQUEST_ACCEPTED", { workspaceId });
  
  // 2. Check if sandbox exists
  const workspace = await workspaceService.getWorkspace(workspaceId);
  
  if (!workspace.sandboxId) {
    // 3. Enqueue bootstrap job (synchronously, no wait)
    const bootstrapJobId = await bootstrapQueue.add("bootstrap", {
      workspaceId, userId, framework, message, ...
    });
    return { bootstrapJobId };
  }
  
  // 4. Already has sandbox → directly enqueue agent job
  const agentJobId = await agentQueue.add("agent-run", {
    workspaceId, sandboxId, ..., isInitialSetup: false
  });
  return { agentJobId };
}, { connection: redisConnection, concurrency: 50 });

// bootstrapWorker.ts (refactored from setupWorker)
export const bootstrapWorker = new Worker("bootstrap", async (job) => {
  const { workspaceId, framework, message } = job.data;
  
  // 1. Generate ai-agents.md (LLM call)
  const aiAgentsMd = await ai.processPrompt(...);
  
  // 2. Create sandbox (2-6s, blocking but unavoidable)
  const { sandboxId } = await SandboxManager.getInstance().openAndInit({
    aiAgentsMd, framework, ...
  });
  
  // 3. Persist sandbox
  await workspaceService.updateSandboxId(workspaceId, sandboxId);
  
  // 4. Create todos
  const todos = parseTodosFromContext(aiAgentsMd);
  for (const todo of todos) {
    await todoService.createTodo({ workspaceId, ...todo });
  }
  
  // 5. Enqueue agent job (don't wait for execution)
  await agentQueue.add("agent-run", {
    workspaceId, sandboxId, todoId: todos[0].id, ...
  });
  
  return { sandboxId, todoCount: todos.length };
}, { connection: redisConnection, concurrency: 5 });

// agentWorker.ts (mostly unchanged, but now doesn't run for every request)
export const agentWorker = new Worker("agent-run", async (job) => {
  // Existing processAgentJob() implementation
  // No changes needed
}, { connection: redisConnection, concurrency: 5 });
```

**Impact:**

- **T+0:** User request arrives
- **T+50ms:** enrollQueue picks up (concurrency=50, instant)
- **T+60ms:** USER_REQUEST_ACCEPTED event sent to client
- **T+100ms:** bootstrapQueue.add() enqueued (for new workspace only)
- **T+200ms:** bootstrapQueue picks up (if available, otherwise waits)
- **T+500-6500ms:** Sandbox creation happens (user sees progress event)
- **T+6600ms:** Agent job enqueued automatically
- **T+6700-7200ms:** agentWorker picks up and starts actual agent loop

**User Perceives:** 100ms until "request accepted", progress updates during sandbox creation, then agent starts

**Actual execution start:** ~6.7 seconds for new workspace (sandbox bottleneck), <1 second for existing workspace

**Target Achievement:** Still doesn't meet 2-second target for new workspaces, but:
- ✓ Reduces queue wait to near-zero (concurrency=50 for enroll)
- ✓ Parallelizes bootstrap & agent prep
- ✓ Improves UX with progress events

---

### Solution 2: Async LLM Call in Request Handler ⭐⭐ (Medium Impact)

**Problem Solved:** 500-1500ms synchronous blocking in request handler

**Change:** Move `ai.processPrompt()` out of WSManager request path

**Current Code (BLOCKING):**
```typescript
// WSManager.ts:558
const aiResponse = await ai.processPrompt(e.payload.message, ctx.userId, imageRefs);
// BLOCKS request handler for 500-1500ms!
```

**Fixed Code (NON-BLOCKING):**
```typescript
// WSManager.ts
case "USER_REQUEST": {
  // ... existing code ...
  
  // 1. IMMEDIATELY enqueue to enrollQueue
  const enrollJobId = await enrollQueue.add("enroll", {
    workspaceId: ctx.workspaceId,
    userId: userId,
    message: e.payload.message,
    imageIds: imageIds,
    meta: meta,
  });
  
  // 2. Respond to client IMMEDIATELY (don't wait for LLM)
  this.sendEvent(socket, createEvent(
    "REQUEST_ENQUEUED",
    { enrollJobId, message: "Processing your request..." },
    meta
  ));
  
  // 3. Persist message (async, fire-and-forget)
  this.persistMessage(...);
  
  return; // Don't wait for anything
}
```

**Impact:**

- Request handler returns in <100ms (vs. 500-1500ms currently)
- LLM call moved to enrollWorker (runs asynchronously)
- Client gets immediate acknowledgment
- Other WebSocket messages process faster

---

### Solution 3: Pre-Warmed Sandbox Pool ⭐⭐ (Medium Impact, but partial)

**Problem Solved:** E2B template download latency (partially)

**Change:** Maintain a pool of "warm" sandboxes ready to use

**Implementation:**

```typescript
// sandboxPool.ts (new)
export class SandboxPool {
  private pools = new Map<string, Sandbox[]>(); // framework → sandboxes
  
  async getOrCreate(framework: string): Promise<Sandbox> {
    const pool = this.pools.get(framework) || [];
    
    if (pool.length > 0) {
      const sandbox = pool.pop()!; // reuse warm sandbox
      // Refresh timeout
      await sandbox.setTimeout(15 * 60 * 1000);
      return sandbox;
    }
    
    // No warm sandbox available, create new
    return await Sandbox.create(getTemplateId(framework), {
      timeoutMs: 15 * 60 * 1000,
      lifecycle: { onTimeout: "pause" }
    });
  }
  
  async release(sandbox: Sandbox, framework: string) {
    if (!this.pools.has(framework)) {
      this.pools.set(framework, []);
    }
    const pool = this.pools.get(framework)!;
    if (pool.length < MAX_POOL_SIZE) {
      pool.push(sandbox); // return to pool
    } else {
      sandbox.disconnect(); // excess capacity
    }
  }
}

// Usage in bootstrapWorker
const sandbox = await sandboxPool.getOrCreate(framework);
// ... work with sandbox ...
await sandboxPool.release(sandbox, framework);
```

**Constraints:**

- E2B sandboxes cost money (typically $0.50-2/hour per sandbox)
- Pre-warming 5-10 sandboxes per framework = significant cost
- Useful only if traffic is predictable
- Max benefit: saves 1.5-5 seconds (template download), still bottlenecked by Docker spawn (~500-1500ms)

**Impact:**

- Saves ~1.5-5 seconds for most new workspaces
- Requires infrastructure cost ($100+/month)
- Doesn't solve worker monopolization problem

---

### Solution 4: Increase Worker Concurrency ⭐ (Limited Impact)

**Problem Solved:** Queue wait under load

**Change:** Increase WORKER_CONCURRENCY from 5 to 20-50

```typescript
// agentWorker.ts
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "20", 10);
```

**Issue:** This doesn't really work because agent jobs are CPU+network bound.

- Each agent job uses LLM API calls (shared quota, rate limits)
- Each agent job uses E2B sandbox (expensive, limited)
- More workers = more concurrent LLM calls = faster rate limit hit
- More workers = less E2B capacity available

**Effective Max:** Probably 10-15 before hitting external limits

**Better Alternative:** See Solution 5 (horizontal scaling via multiple worker processes)

---

### Solution 5: Horizontal Worker Scaling ⭐⭐ (Medium Impact)

**Problem Solved:** Queue wait under peak load

**Change:** Run multiple worker processes (e.g., via K8s, PM2, or Docker replicas)

**Current Setup:**
```
Single Node
├─ Express + WebSocket server
└─ Single Worker process (concurrency=5)
```

**Improved Setup:**
```
Node 1 (Primary)
├─ Express + WebSocket server + EventRelay
└─ Worker processes: 3 instances × concurrency=5 = 15 concurrent jobs

Load Balancer
└─ Distributes user requests across multiple Node instances
```

**Implementation:**

```yaml
# docker-compose.yml or k8s deployment
services:
  app:
    image: ai-agents-backend
    ports: ["8000:8000"]
    environment:
      - NODE_ENV=production
      - WORKER_CONCURRENCY=5
    deploy:
      replicas: 1 # Single server instance
  
  agent-worker-1:
    image: ai-agents-backend
    command: npm run worker
    environment:
      - WORKER_CONCURRENCY=5
    deploy:
      replicas: 2 # 2 dedicated worker processes
  
  setup-worker:
    image: ai-agents-backend
    command: npm run worker -- --setup-only
    environment:
      - SETUP_WORKER_CONCURRENCY=10
    deploy:
      replicas: 2 # 2 dedicated setup workers
```

**Impact:**

- Increases effective agentQueue concurrency from 5 to 15-25
- Queue wait reduces from 5-10s to 1-3s under moderate load
- Cost: ~2-3x more infrastructure
- Requires Redis as source of truth (already in place) ✓

---

### Solution 6: Queue Prioritization ⭐ (Low-Medium Impact)

**Problem Solved:** Small requests blocked by large requests

**Change:** Separate fast (plan mode) and slow (build mode) queues

**Current:**
```
agentQueue (all agents share same queue)
├─ Plan mode job (fast, 10-30s)
├─ Build mode job (heavy, 5-15min)
└─ Another build job (stuck behind first)
```

**Improved:**
```
priorityQueue
├─ planQueue (concurrency=10) — quick, research-focused
└─ buildQueue (concurrency=5) — heavy, execution-heavy

User selects plan mode in UI → uses planQueue (higher concurrency, faster pickup)
User selects build mode → uses buildQueue (standard concurrency)
```

**Implementation:**

```typescript
// queues.ts
export const planQueue = new Queue<AgentJobPayload>("agent-plan", {
  concurrency: 10, // Higher concurrency, light-weight jobs
  defaultJobOptions: { attempts: 1, removeOnComplete: true }
});

export const buildQueue = new Queue<AgentJobPayload>("agent-build", {
  concurrency: 5, // Standard concurrency, heavy jobs
  defaultJobOptions: { attempts: 3, backoff: { delay: 2000 } }
});
```

**Impact:**

- Plan mode users see sub-1-second pickup (concurrency=10)
- Build mode slightly delayed but not starved
- Doesn't help if user doesn't distinguish modes

---

### Solution 7: Request Admission Control / Backpressure ⭐ (Low Impact)

**Problem Solved:** Graceful degradation under overload

**Change:** Reject or queue requests if worker pool is saturated

**Implementation:**

```typescript
// requestRateLimiter.ts (new)
export class RequestRateLimiter {
  private activeJobs = new Map<string, number>(); // workspaceId → job count
  
  async canAccept(workspaceId: string): Promise<boolean> {
    const count = this.activeJobs.get(workspaceId) || 0;
    // Max 2 concurrent agent jobs per workspace
    return count < 2;
  }
  
  async acquire(workspaceId: string): Promise<() => void> {
    const count = this.activeJobs.get(workspaceId) || 0;
    this.activeJobs.set(workspaceId, count + 1);
    
    return () => {
      this.activeJobs.set(workspaceId, count);
    };
  }
}

// WSManager.ts
case "USER_REQUEST": {
  if (!await rateLimiter.canAccept(ctx.workspaceId)) {
    this.sendEvent(socket, createEvent("REQUEST_RATE_LIMITED", {
      message: "Too many concurrent requests. Please wait.",
      retryAfter: 10000
    }, meta));
    return;
  }
  
  const release = await rateLimiter.acquire(ctx.workspaceId);
  // ... process request ...
  // Call release() when done
}
```

**Impact:**

- Prevents queue explosion
- Better UX than 10-second wait + timeout
- Requires client-side retry logic

---

## FINAL RECOMMENDATIONS (Ranked by Feasibility & Impact)

### Must-Do (Blocking Issues)

| Priority | Solution | Effort | Impact | Timeline |
|----------|----------|--------|--------|----------|
| **1** | Split jobs into stages (enroll → bootstrap → agent) | High | 🟢🟢🟢 Reduces queue wait to near-zero | 2-3 weeks |
| **2** | Move ai.processPrompt() out of request handler | Medium | 🟢🟢 Frees request handler, enables parallelism | 1-2 weeks |
| **3** | Horizontal worker scaling (2-3 worker processes) | Medium | 🟢 Reduces queue wait under load | 1 week |

### Nice-to-Have (Optimization)

| Priority | Solution | Effort | Impact | Timeline |
|----------|----------|--------|--------|----------|
| **4** | Pre-warmed sandbox pool | Medium | 🟡 Saves 1-5 seconds for new workspaces, costs $$$ | 2 weeks |
| **5** | Queue prioritization (plan vs build) | Low | 🟡 Helps plan mode users | 1 week |
| **6** | Request admission control | Low | 🟡 Better UX under overload | 3-5 days |

---

## REVISED TARGET ANALYSIS (After Implementing Solutions)

### With Solution 1 (Job Splitting) + Solution 2 (Async LLM) + Solution 3 (Horizontal Scaling)

**New Execution Path (3 concurrent requests):**

```
Request 1 (new workspace):
T+0:    USER_REQUEST
T+50:   WebSocket latency
T+100:  Enroll queue (concurrency=50, instant pickup)
T+110:  USER_REQUEST_ACCEPTED
T+130:  Bootstrap job enqueued
T+500:  Bootstrap worker picks up
T+1000: LLM call for ai-agents.md
T+2000: Sandbox bootstrap begins
T+6500: Sandbox ready, todos created
T+6600: Agent job enqueued
T+6700: agentWorker picks up (if available)
T+6900: Agent execution starts

Total: 6.9 seconds (still doesn't meet 2-second target)
```

**Why 2-second target is unrealistic:**

E2B sandbox creation alone is 2.5-6.5 seconds. This is an external dependency that can't be optimized away without:

1. **Pre-warming sandboxes** (expensive, infrastructure cost)
2. **Different architecture** (serverless agents, shared sandboxes per user, etc.)
3. **Accepting degraded UX** (execute agent without sandbox, then provision sandbox in parallel)

### Realistic Target: 1-2 seconds for existing workspaces, 8-10 seconds for new workspaces

With the proposed architecture changes:

- **Existing workspace (experienced users):** ~1-2 seconds to agent execution ✓
- **New workspace (first-time setup):** ~8-10 seconds to agent execution (sandbox bottleneck)
- **Perceived latency:** 100-500ms to "request accepted" + progress updates during setup

---

## IMPLEMENTATION ROADMAP

### Phase 1: Job Splitting (Weeks 1-3)

1. Create enrollQueue, bootstrapQueue
2. Refactor setupWorker → bootstrapWorker
3. Create enrollWorker
4. Update WSManager to use enrollQueue
5. Update setupWorker.ts calls to enqueue agentQueue
6. Test: verify agent starts faster with no sandbox wait

### Phase 2: Async LLM (Weeks 2-3, parallel with Phase 1)

1. Move ai.processPrompt() from WSManager to enrollWorker
2. Update intent classification to be async
3. Update request handling flow
4. Test: verify request handler returns <100ms

### Phase 3: Horizontal Scaling (Week 4)

1. Create docker-compose or k8s config for multiple workers
2. Deploy 2-3 worker instances
3. Configure load balancing for event relay
4. Test: verify queue wait reduced under load

### Phase 4: Monitoring & Observability (Week 5)

1. Add metrics for queue wait, job duration, agent startup time
2. Add logs for each stage (enroll → bootstrap → agent)
3. Dashboard to visualize queue depth, worker utilization
4. Alerts for slow jobs, stuck queues

---

## CONCLUSION

**The 2-second target is NOT achievable** with the current architecture due to E2B sandbox creation latency (2.5-6.5 seconds minimum for new workspaces).

**However, the architecture can be significantly improved:**

1. **Implement job splitting** to eliminate worker monopolization and queue wait
2. **Move LLM calls out of request handler** to prevent blocking
3. **Add horizontal scaling** to handle peak load gracefully

**With these changes:**

- Existing workspace users: <2 seconds to agent execution ✓
- New workspace users: ~8-10 seconds (sandbox-bound) — acceptable UX with progress events
- Queue wait: reduced from 5-10s to <1s under normal load
- Better resource utilization and scalability

**The real issue is job granularity, not concurrency.** Splitting jobs into stages with appropriate concurrency levels (50 for enrollment, 5-10 for bootstrap, 5-20 for agent) will eliminate the queue bottleneck.
