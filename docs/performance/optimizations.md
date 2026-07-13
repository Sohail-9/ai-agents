# AI Agents Latency Analysis & Optimization Recommendations

**Date**: 2026-05-07  
**Issue**: 10+ second delay when users send requests and agent starts working  
**Scope**: Request → Workspace Setup → Agent Initialization → First LLM Call

---

## Executive Summary

Analysis reveals **5 major sequential bottlenecks** accounting for ~15-20 seconds of user-facing latency:

1. **E2B Sandbox Creation** (3-8s) - Blocking operations with no parallelization
2. **AI Analysis + Context Building** (1-2s) - Sequential LLM calls
3. **Service Restart & Health Checks** (10-15s) - Hardcoded waits on sandbox resume
4. **Agent Initialization Serialization** (2-3s) - Sequential memory + LLM client setup
5. **Image Processing** (0.5-2s) - No caching between AI calls

---

## Critical Path Analysis

### Current Flow (Sequential)
```
USER_REQUEST (frontend)
    ↓
WebSocket → WSManager.handleMessage() [<50ms]
    ↓
ai.processPrompt() [1-2s] ← AI Intent Detection
    ↓
setupQueue.add() [<10ms]
    ↓
SetupWorker picks job [queue latency: 100-500ms]
    ↓
AI re-run for context [1-2s] ← DUPLICATE
    ↓
SandboxManager.openAndInit() [5-10s] ← **BLOCKING**
    ├─ Sandbox.create() [3-8s]
    ├─ Service health check [1-3s]
    └─ File writes [<500ms]
    ↓
setupQueue → agentQueue chaining [<10ms]
    ↓
AgentRunner initialization [2-3s]
    ├─ LLM client creation [0.5-1s]
    ├─ Memory retrieval [1-1.5s]
    └─ Message loading from DB [0.5s]
    ↓
First LLM call [3-5s] ← User sees activity

Total: **15-25 seconds** before first meaningful agent output
```

---

## Identified Bottlenecks

### 1. **E2B Sandbox Creation** (CRITICAL - 5-10s)
**File**: `backend/src/sandbox/sandboxManager.ts` (lines 128-134)

```typescript
// Current: blocking, single operation
sandbox = await Sandbox.create(templateId, { ... });
```

**Issues**:
- No way to parallelize E2B sandbox creation with other work
- High variance: pre-built templates fast (2-3s), base template slow (8-10s)
- Health checks are sequential, not concurrent

**Impact**: ~6-8 seconds user-facing latency

---

### 2. **Duplicate AI Analysis** (MODERATE - 1-2s)
**Files**:
- `backend/src/ws/WSManager.ts` (line 606 + 558)
- `backend/src/workers/setupWorker.ts` (line 79)

```typescript
// WSManager
const aiResponse = await ai.processPrompt(e.payload.message, ctx.userId, imageRefs);

// SetupWorker (redundant)
const aiResponse = await ai.processPrompt(...);
```

**Issues**:
- AI is called in WSManager to check intent clarity
- Same call repeated in setupWorker
- Results are NOT cached between calls
- Images must be fetched twice from bucket

**Impact**: ~1-2 seconds wasted on duplicate computation

---

### 3. **Service Restart & Hardcoded Wait** (MODERATE - 10s on resume)
**File**: `backend/src/sandbox/sandboxManager.ts` (lines 99-101)

```typescript
// After restarting services, hard wait for initialization
console.log(`[SandboxManager] Services restarted. Waiting 10s for initialization...`);
await new Promise(r => setTimeout(r, 10_000)); // ← Hardcoded 10s
```

**Issues**:
- Unconditional 10-second wait every time a paused sandbox is resumed
- No adaptive backoff or health check loop
- Blocks the entire setup pipeline
- Service startup is faster (2-3s) but we wait 10s regardless

**Impact**: ~8-10 seconds unnecessary latency on resume

---

### 4. **Sequential Agent Runner Initialization** (MODERATE - 2-3s)
**File**: `backend/src/brain/agentRunner.ts` (lines 699-779)

```typescript
// Sequential operations that could be parallel
const [recentRuns, workspaceMemory] = await Promise.all([...]);
// ↑ Good parallelization here

// But later:
const llmWrapper = await createLLMClient({...});  // 0.5-1s
const memoryBlock = await retrieveRelevantMemory(...); // 1-1.5s
const prismaMessages = await messageService.getByWorkspace(...); // 0.5s
```

**Issues**:
- Memory retrieval happens after initial message load (dependency chain)
- LLM client creation blocks memory retrieval
- Token estimation before request could start earlier

**Impact**: ~1-2 seconds of serialization

---

### 5. **Image Processing** (MINOR - 0.5-2s)
**File**: `backend/src/ws/WSManager.ts` (lines 97-117)

```typescript
// Images fetched independently in multiple places
const imageRefs = await this.loadImageRefs(imageIds, imageRefCache);
// Also fetched in SetupWorker again
```

**Issues**:
- Per-request cache exists but doesn't survive queue serialization
- Images must be re-fetched from bucket in SetupWorker
- Decoding to base64 happens per-fetch

**Impact**: ~0.5-1 second per image

---

## Vague/Inefficient Flows

### A. **Intent Clarity Detection (Removed but Worth Noting)**
- Previously blocked setup on vague intents
- Now deferred to inside sandbox
- Trade: faster initial setup, slightly slower overall for vague queries
- ✅ **This is a good optimization already done**

### B. **Database Provisioning Flow**
**File**: `backend/src/ws/WSManager.ts` (lines 722-741)

```typescript
// Currently: User confirms database → provision → setup
if (e.payload.confirmed) {
    const provisioned = await provisionWorkspaceDatabase({...});
    databaseName = provisioned.databaseName;
    databaseUrl = provisioned.databaseUrl;
}
// Then: pass to setupQueue
```

**Issues**:
- Database provisioning blocks on user confirmation
- Could be started in background while sandbox initializes
- No parallel database + sandbox setup

**Impact**: ~2-5 seconds (user-visible wait)

---

### C. **Service Health Checks**
**File**: `backend/src/sandbox/sandboxManager.ts` (lines 74-118)

```typescript
// Current: serial checks
const svcCheck = await sandbox.commands.run(
    `ss -tlpn | grep -E ':3000|:8000' | head -5`
);
if (!servicesAlive) {
    // restart
    await sandbox.commands.run(`cd /workspace/frontend && ...`);
    await sandbox.commands.run(`cd /workspace/backend && ...`);
    await new Promise(r => setTimeout(r, 10_000)); // ← waste time
    const verifyCheck = await sandbox.commands.run(...); // ← serial
}
```

**Issues**:
- Service start commands run sequentially (could be parallel)
- Verification is serial, not concurrent startup
- No exponential backoff with early success detection

---

## Optimization Roadmap

### **PRIORITY 1: Quick Wins (2-4 seconds savings)**

#### 1.1 **Replace Hardcoded Wait with Adaptive Health Check Loop**
**File**: `backend/src/sandbox/sandboxManager.ts`

```typescript
// Instead of:
await new Promise(r => setTimeout(r, 10_000));

// Do:
async function waitForServices(sandbox: Sandbox, maxWait = 15_000): Promise<boolean> {
  const start = Date.now();
  const ports = ['3000', '8000'];
  
  while (Date.now() - start < maxWait) {
    const check = await sandbox.commands.run(
      `ss -tlpn | grep -E ':${ports.join('|:')}'`
    );
    if (check.exitCode === 0 && check.stdout.trim()) {
      return true; // Services alive
    }
    await new Promise(r => setTimeout(r, 500)); // Quick retry
  }
  return false;
}

// Usage:
const servicesReady = await waitForServices(sandbox, 5000);
if (!servicesReady) {
  console.warn("[SandboxManager] Services not responding after 5s; continuing anyway");
}
```

**Expected Saving**: 7-10 seconds on resume  
**Effort**: 1-2 hours  
**Risk**: Low

---

#### 1.2 **Parallelize Service Restart Commands**
**File**: `backend/src/sandbox/sandboxManager.ts`

```typescript
// Instead of:
await sandbox.commands.run(`cd /workspace/frontend && nohup npm run dev ...`);
await sandbox.commands.run(`cd /workspace/backend && nohup npm run dev ...`);

// Do:
await Promise.all([
  sandbox.commands.run(`cd /workspace/frontend && nohup npm run dev ...`),
  sandbox.commands.run(`cd /workspace/backend && nohup npm run dev ...`),
]);
```

**Expected Saving**: 2-3 seconds  
**Effort**: 30 minutes  
**Risk**: Low

---

#### 1.3 **Cache AI Results Between WSManager and SetupWorker**
**Files**: `backend/src/ws/WSManager.ts`, `backend/src/workers/setupWorker.ts`

```typescript
// WSManager: cache the aiResponse in Redis with short TTL
const cacheKey = `ai-intent:${workspace.id}:${Hash(message)}`;
const cached = await redis.get(cacheKey);
if (!cached) {
  aiResponse = await ai.processPrompt(...);
  await redis.setex(cacheKey, 30, JSON.stringify(aiResponse)); // 30s TTL
}

// SetupWorker: retrieve from cache before re-computing
const cachedAI = await redis.get(`ai-intent:${workspaceId}:${Hash(idea)}`);
if (cachedAI) {
  const aiResponse = JSON.parse(cachedAI);
  // Use cached response instead of calling AI again
}
```

**Expected Saving**: 1-2 seconds  
**Effort**: 2 hours  
**Risk**: Medium (cache invalidation edge cases)

---

### **PRIORITY 2: Medium Effort (3-6 seconds savings)**

#### 2.1 **Parallel Sandbox + Database Provisioning**
**File**: `backend/src/ws/WSManager.ts` (CONFIRMATION_RESPONSE handler)

```typescript
// Current: sequential
if (e.payload.confirmed) {
  const provisioned = await provisionWorkspaceDatabase({...});
  // Then pass to setupQueue
}

// Optimized: parallel where possible
if (e.payload.confirmed) {
  // Start provisioning but don't wait
  const provisionPromise = provisionWorkspaceDatabase({...});
  
  // Queue the setup job immediately with placeholder
  const setupJob = await setupQueue.add("workspace-setup", {
    ...setupPayload,
    databaseUrl: null, // Will be filled by provisioning
  });
  
  // In background, wait for provisioning and update the job
  provisionPromise.then(async (provisioned) => {
    await setupQueue.updateData(setupJob.id, {
      ...setupPayload,
      databaseUrl: provisioned.databaseUrl,
    });
  }).catch(err => console.error("Database provisioning failed:", err));
}
```

**Expected Saving**: 2-4 seconds  
**Effort**: 3-4 hours  
**Risk**: Medium (job data updates need careful handling)

---

#### 2.2 **Parallelize Agent Initialization Steps**
**File**: `backend/src/brain/agentRunner.ts` (lines 699-779)

```typescript
// Current: sequential LLM client + memory retrieval
llmWrapper = await createLLMClient({...});
const memoryBlock = await retrieveRelevantMemory(...);

// Optimized: parallel where safe
const [llmWrapper, memoryBlock] = await Promise.all([
  createLLMClient({...}),
  // Delay memory retrieval slightly or fetch in background
  Promise.resolve().then(() => retrieveRelevantMemory(...))
]);
```

**Expected Saving**: 0.5-1 second  
**Effort**: 1-2 hours  
**Risk**: Low

---

### **PRIORITY 3: High Effort, High Impact (5-8 seconds savings)**

#### 3.1 **Pre-create Sandbox Before Setup Queue Processing**
**File**: `backend/src/ws/WSManager.ts` (USER_REQUEST handler)

Instead of waiting for setupWorker to create the sandbox, start it immediately:

```typescript
// In WSManager, before enqueueing setupQueue:
if (workspace && !workspace.sandboxId) {
  // Start sandbox creation in background (fire-and-forget)
  SandboxManager.getInstance().openAndInit({
    framework: wsConfig.framework || ctx.framework,
    aiAgentsMd: null, // Will update later
  }).then(async (result) => {
    // Update workspace with sandboxId immediately
    await workspaceService.updateSandboxId(ctx.workspaceId!, result.sandboxId);
    // Emit event to frontend so UI can show sandbox ready
    publishWsEvent(ctx.workspaceId!, { type: "SANDBOX_READY", sandboxId: result.sandboxId });
  }).catch(err => console.error("Background sandbox creation failed:", err));

  // Queue the setup job normally; it can check if sandbox already exists
  const setupJob = await setupQueue.add("workspace-setup", setupPayload);
}
```

**Expected Saving**: 3-5 seconds (by making E2B creation non-blocking)  
**Effort**: 4-6 hours  
**Risk**: Medium (race conditions between background + queue operations)

---

#### 3.2 **Implement Sandbox Template Warm Pool**
**File**: `backend/src/sandbox/sandboxManager.ts`

```typescript
// Maintain a small pool of pre-created sandboxes for each template
class SandboxPool {
  private pools = new Map<string, Sandbox[]>();
  private poolSize = 2; // Keep 2 warm per template

  async acquire(templateId: string): Promise<Sandbox> {
    let pool = this.pools.get(templateId) || [];
    if (pool.length > 0) {
      return pool.pop()!; // Return pre-created
    }
    // If pool empty, create on-demand
    return await Sandbox.create(templateId, {...});
  }

  async release(templateId: string, sandbox: Sandbox) {
    let pool = this.pools.get(templateId) || [];
    if (pool.length < this.poolSize) {
      pool.push(sandbox);
    }
  }

  startWarmUp() {
    // Background task: keep pool warm
    setInterval(async () => {
      const templates = ["ai-agents-node-next", "base"];
      for (const tId of templates) {
        const pool = this.pools.get(tId) || [];
        while (pool.length < this.poolSize) {
          Sandbox.create(tId, {...}).then(sb => pool.push(sb));
        }
      }
    }, 30_000); // Warm every 30s
  }
}
```

**Expected Saving**: 3-8 seconds (depending on pool hit rate)  
**Effort**: 6-8 hours  
**Risk**: High (pool management complexity, resource overhead)

---

## Summary Table

| Optimization | Savings | Effort | Risk | Priority |
|---|---|---|---|---|
| Adaptive health check loop | 7-10s | 1-2h | Low | **P1** |
| Parallel service restart | 2-3s | 30min | Low | **P1** |
| Cache AI results | 1-2s | 2h | Med | **P1** |
| Parallel DB + setup | 2-4s | 3-4h | Med | **P2** |
| Parallel agent init | 0.5-1s | 1-2h | Low | **P2** |
| Pre-create sandbox | 3-5s | 4-6h | Med | **P3** |
| Sandbox warm pool | 3-8s | 6-8h | High | **P3** |
| **Total Potential** | **~19-33s** | **18-30h** | - | - |

---

## Recommended Implementation Order

### **Phase 1: Quick Wins (Week 1)**
1. ✅ Replace hardcoded 10s wait with adaptive loop (`1.1`)
2. ✅ Parallelize service restart commands (`1.2`)
3. ✅ Cache AI results in Redis (`1.3`)

**Expected Result**: 8-15 seconds saved

### **Phase 2: Medium Effort (Week 2-3)**
4. ✅ Parallelize agent initialization (`2.2`)
5. ✅ Parallel DB + setup provisioning (`2.1`)

**Expected Result**: Additional 2-5 seconds saved

### **Phase 3: High Impact (Week 4+)**
6. ✅ Pre-create sandbox before queue (`3.1`)
7. ✅ Implement sandbox warm pool (`3.2`) — *optional, high complexity*

**Expected Result**: Additional 3-8 seconds saved

---

## Monitoring & Metrics

Add instrumentation to track:

```typescript
// In setupWorker.ts
const timings = {
  queueWait: job.processedOn - job.timestamp,
  aiAnalysis: Date.now() - aiStartTime,
  sandboxCreation: Date.now() - sandboxStartTime,
  totalSetup: Date.now() - setupStartTime,
};

emit("SETUP_TIMINGS", { timings });
console.log(`[SetupWorker] Timings: ${JSON.stringify(timings)}`);

// In agentRunner.ts
const llmStartTime = Date.now();
// ... agent work ...
emit("AGENT_TIMINGS", {
  initTime: llmStartTime - startTime,
  firstLLMCall: Date.now() - llmStartTime,
  totalRuntime: Date.now() - startTime,
});
```

Add to dashboards:
- **Setup latency (p50, p95, p99)**
- **Sandbox creation time by template**
- **Service startup time**
- **Agent initialization time**
- **Time to first agent message**

---

## Notes & Caveats

- **E2B is the hard constraint**: Sandbox creation can't be made significantly faster without architectural changes (different template, lighter sandbox)
- **Queue latency is hidden**: Even with optimizations, BullMQ queue processing adds 100-500ms (invisible to frontend but real)
- **First LLM call is unavoidable**: 3-5 seconds for first Claude/Qwen response is expected
- **Paradox of resumption**: Resume with service restart (10s wait) is slower than new sandbox (5s create) on paused workspaces — consider alternative: keep sandboxes warm or allow longer timeouts

---

## Appendix: Code Locations

- **Setup orchestration**: `backend/src/workers/setupWorker.ts`
- **Sandbox management**: `backend/src/sandbox/sandboxManager.ts`
- **WebSocket handler**: `backend/src/ws/WSManager.ts`
- **Agent runner**: `backend/src/brain/agentRunner.ts`
- **Queue config**: `backend/src/queue/queues.ts`
- **AI service**: `backend/src/brain/ai.ts`
