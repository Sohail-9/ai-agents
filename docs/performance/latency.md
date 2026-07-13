# Latency Analysis: 10-15s Agent Startup Delay

## Flow Overview
```
Client (USER_REQUEST)
  ↓
WSManager.handleMessage()
  ↓ (Parse event)
handleUpdateIntent() OR handleGitHubImportUpdate()
  ↓ (AI calls + DB reads)
agentQueue.add("agent-run", {...})
  ↓ (BullMQ enqueue)
EventRelay broadcasts REQUEST_ACCEPTED
  ↓
agentWorker processes job
  ↓
runAgent() inside E2B sandbox
  ↓
AGENT_STARTED event
```

## Identified Latency Sources

### 1. **Pre-Queue Blocking (WSManager → agentQueue.add)**
**Lines: WSManager.ts:2134-2229**

#### Plan Mode Path:
```
classifyPlanIntent(message)  [AI CALL: ~2-5s]
├─ LLM inference to classify "conversational" vs "planning"
├─ No streaming
└─ Full serialization overhead

If conversational:
  ├─ retrieveRelevantFileContext() [SANDBOX CALL: ~2-3s]
  │  └─ Reading 1-3 files from sandbox filesystem
  └─ answerConversationalQuery() [AI CALL: ~2-5s]
     └─ LLM inference to answer from context
     
Total for conversational path: 6-13s before AGENT_STARTED
```

#### Non-Plan Mode Path:
```
ai.planUpdate(message, updateContext)  [AI CALL: ~3-7s]
├─ LLM inference to generate TODO plan
└─ Includes workspace context (prettiflowMd, env context)

parseTodosFromContext()  [SYNC: ~100ms]

todoService.createTodosWithDeps()  [DB: ~500ms-1s]
└─ Bulk insert + dependency wiring

todoService.listAllTodos()  [DB: ~200-500ms]

broadcastToWorkspace()  [ASYNC, non-blocking]

Total before agentQueue.add: 4-9s
```

**ISSUE:** Both paths call AI **synchronously** in the WebSocket handler, blocking the queue.add() until AI responds.

---

### 2. **Queue Processing Delay (BullMQ)**
**Lines: agentWorker.ts:86-120**

```
agentQueue.add() [SYNC: should be instant]
  ↓
Worker picks up job from Redis
  ↓
processAgentJob starts
  ├─ emit("AGENT_STARTED") [Published immediately]
  │  └─ RedisConnection.publish → EventRelay → broadcast
  │
  ├─ agentRunService.create() [DB: ~100-200ms, fire-and-forget]
  │
  ├─ resolveProvider() [DB: ~100ms]
  │
  ├─ redisConnection.del(`abort:${workspaceId}`) [REDIS: ~10ms]
  │
  └─ buildRedisAbortSignal() [SYNC: ~1ms]

runOrchestrator() / runAgent() starts
```

**ISSUE:** Worker concurrency is `WORKER_CONCURRENCY=50`. If many jobs are queued:
- Job may wait in Redis queue for available worker slot
- Network latency between worker and Redis (~1-5ms per roundtrip, but batched)

**Metrics to measure:**
- Job queue depth at moment of submission
- Worker saturation (50/50 slots filled?)
- Redis latency (PING roundtrip)

---

### 3. **Agent Initialization in E2B Sandbox (runOrchestrator)**
**Lines: agentWorker.ts:150+, agentRunner.ts:500+**

```
runOrchestrator(agentCtx)
  ├─ Initialize sandbox if needed [~1-3s]
  │  └─ E2B Sandbox.create() or attach to existing
  │
  ├─ Load system prompt [SYNC: ~10ms]
  │  └─ getSystemPrompt(framework, ...)
  │
  ├─ retrieveRelevantMemory() [DB + embedding: ~1-2s]
  │  └─ Query embedding index for relevant past errors/context
  │
  ├─ buildMemoryBlock() [LLM CALL: ~2-3s]
  │  └─ Summarize retrieved memory with Qwen LLM
  │
  ├─ First LLM call (getModelConfigForAgent + LLM init) [~2-5s]
  │  ├─ Resolve provider (ANTHROPIC, OPENAI, GEMINI, QWEN, GROQ)
  │  ├─ Load API keys
  │  └─ Make first message.create() call
  │
  └─ Loop starts (message #1, max 20 iterations)
```

**ISSUE:** Chain of initialization + first LLM call adds 6-13s **after** AGENT_STARTED is emitted. This is on the hot path.

---

### 4. **Provider Resolution & API Key Loading**
**Lines: agentRunner.ts:97-200, brain/modelSelector.ts**

```
resolveLLMConfig({userId, workspaceId, provider, ...})
  ├─ Check user's custom API key [DB: ~100ms]
  │  └─ userApiKeyService.getKey(userId, provider)
  │
  ├─ If none, use env API key [SYNC: ~1ms]
  │  └─ getEnvKey(provider)
  │
  ├─ Validate key (ping? or just use) [VARIES]
  │
  └─ Initialize client [SYNC: ~10ms]
     └─ new Anthropic({apiKey, ...})

Total: 100-500ms per resolve
```

**ISSUE:** If custom keys require DB lookup during every resolve, and database is slow or far away (network latency).

---

### 5. **First LLM Call Initialization**
**Lines: agentRunner.ts:560-620 (approximate)**

```typescript
// First call to LLM
const response = await client.messages.create({
  model: getModel(provider),
  max_tokens: 4096,
  messages: [{role: "user", content: systemPrompt + userMessage}],
  tools: TOOL_SCHEMAS,  // 50+ tools
  ...
});
```

**Per Provider Time:**
- **ANTHROPIC:** Model load + inference: ~3-7s (Opus/Sonnet slower)
- **OPENAI:** API latency + model inference: ~2-4s
- **QWEN/DashScope:** HTTP roundtrip + inference: ~3-6s (variable)
- **GROQ:** ~1-2s (fastest)
- **GEMINI:** ~2-4s

**ISSUE:** Tool schema serialization for 50+ tools adds 100-500ms overhead.

---

## Measurement Checklist

Add timestamps to identify real bottleneck:

```typescript
// WSManager.handleUpdateIntent() — line 2134
const t1 = Date.now();

if (planMode) {
  console.log(`[T] classifyPlanIntent START`);
  const intent = await classifyPlanIntent(message);
  console.log(`[T] classifyPlanIntent END: ${Date.now() - t1}ms`);
  
  if (intent === "conversational") {
    console.log(`[T] retrieveFileContext START`);
    const ctx = await this.retrieveRelevantFileContext(...);
    console.log(`[T] retrieveFileContext END: ${Date.now() - t1}ms`);
    
    console.log(`[T] answerQuery START`);
    const ans = await answerConversationalQuery(...);
    console.log(`[T] answerQuery END: ${Date.now() - t1}ms`);
  }
} else {
  console.log(`[T] planUpdate START`);
  const plan = await ai.planUpdate(...);
  console.log(`[T] planUpdate END: ${Date.now() - t1}ms`);
}

console.log(`[T] agentQueue.add START`);
await agentQueue.add(...);
console.log(`[T] agentQueue.add END: ${Date.now() - t1}ms`);
```

```typescript
// agentWorker.ts — line 86
const tWorkerStart = Date.now();

async function processAgentJob(job) {
  console.log(`[W] Job ${job.id} received at worker: ${Date.now() - tWorkerStart}ms`);
  
  emit("AGENT_EVENT", {eventType: "AGENT_STARTED", ...});
  const tAgentStarted = Date.now();
  console.log(`[W] AGENT_STARTED emitted at: ${tAgentStarted - tWorkerStart}ms`);
  
  await Promise.all([...]);
  console.log(`[W] Provider resolved at: ${Date.now() - tAgentStarted}ms`);
  
  const orchestratorStart = Date.now();
  await runOrchestrator(agentCtx);
  console.log(`[W] runOrchestrator finished at: ${Date.now() - orchestratorStart}ms`);
}
```

```typescript
// agentRunner.ts — runAgent() entry, line ~300
export async function runAgent(ctx: AgentRunnerContext) {
  const tStart = Date.now();
  
  console.log(`[R] runAgent START`);
  
  const modelConfig = await getModelConfigForAgent({...});
  console.log(`[R] getModelConfig: ${Date.now() - tStart}ms`);
  
  // Memory retrieval
  const relevantMemory = await retrieveRelevantMemory(...);
  console.log(`[R] retrieveMemory: ${Date.now() - tStart}ms`);
  
  const memoryBlock = await buildMemoryBlock(...);
  console.log(`[R] buildMemoryBlock: ${Date.now() - tStart}ms`);
  
  // First LLM call
  console.log(`[R] First LLM call START`);
  const response = await createLLMCall(...);
  console.log(`[R] First LLM call END: ${Date.now() - tStart}ms`);
}
```

---

## Quick Wins (Estimated Improvement)

| Fix | Latency Saved | Complexity | Risk |
|-----|---------------|-----------|------|
| **Move AI calls to background queue** (handleUpdateIntent → fire-and-forget) | 5-10s | Medium | Medium - loses early validation |
| **Cache classifyPlanIntent results** (same message within 60s) | 2-5s | Low | Low - rare collisions |
| **Parallel AI + DB calls** (ai.planUpdate + todoService.listAllTodos in parallel) | 500ms-1s | Low | Low |
| **Pre-warm LLM clients** (initialize before job received) | 2-4s | Medium | High - connection pooling complexity |
| **Use faster model for plan classification** (Haiku instead of Sonnet) | 1-2s | Low | Low |
| **Reduce tool schema size** (send only relevant tools per context, not 50+) | 200-500ms | Medium | Medium - requires tool filtering logic |
| **Move memory retrieval to async** (emit tools before memory built) | 1-2s | Medium | Medium - loses initial context |
| **Sandbox pre-warming** (keep idle sandbox warm between requests) | 1-3s | High | High - cost + complexity |

---

## Recommended Next Steps

1. **Add instrument timestamps** (copy blocks above) and run 10 requests
2. **Identify which phase is the slowest** (likely AI calls in handleUpdateIntent or first LLM inference)
3. **Profile API latency** via `curl -w '@curl-format.txt'` to check network round-trip time
4. **Check worker queue depth** via `redis-cli LLEN bull:agent-run:wait`
5. **Measure per-provider latency** (try GROQ vs ANTHROPIC)

Then prioritize fixes based on measured data.
