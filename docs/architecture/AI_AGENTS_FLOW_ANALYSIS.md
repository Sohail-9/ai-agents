# AI Agents Query → AI Agents.md Flow Analysis

## Context

This document maps the complete code path from a user query to the `AI Agents.md` file inside the E2B sandbox, and how that file is read before every agent loop iteration.

---

## Key Files

| File | Role |
|------|------|
| `backend/src/ws/WSManager.ts` | Entry point — handles `USER_REQUEST` WS event |
| `backend/src/brain/ai.ts` | `AIBrain.processPrompt()` — orchestrates LLM calls |
| `backend/src/brain/prompts.ts` | `INTENT_SYSTEM_PROMPT` + `CONTEXT_BUILDER_PROMPT` |
| `backend/src/brain/providers/qwen.ts` | `analyzeIntent()` + `buildContext()` LLM calls |
| `backend/src/context/contextBuilder.ts` | Last-resort fallback — no LLM |
| `backend/src/workers/setupWorker.ts` | BullMQ worker — builds and writes AI Agents.md |
| `backend/src/sandbox/sandboxManager.ts` | `openAndInit()` — `sandbox.files.write(...)` |
| `backend/src/brain/planningUtils.ts` | `parseTodosFromContext()` + `buildUpdateContext()` |
| `backend/src/workers/agentWorker.ts` | Runs `runOrchestrator()` per agent job |
| `backend/src/brain/agentRunner.ts` | Main agent loop — instructs agent to read AI Agents.md |
| `backend/src/brain/systemPrompt.ts` | System prompt construction — AI Agents.md read instructions |
| `backend/src/brain/agents/orchestratorRunner.ts` | Calls `runAgent()` |

---

## Phase 1: Query → TOON Plan String

### 1. WebSocket receives `USER_REQUEST`
`WSManager.ts:728`

For a **new workspace** (no sandbox yet):
- `WSManager.ts:870` calls `ai.processPrompt(message, userId, imageRefs)`
- Result stored as `cachedAiResponse: { contextContent, contextPayload }`
- `WSManager.ts:911` enqueues **`workspace-setup`** BullMQ job with this cached response

### 2. `ai.processPrompt()` → LLM Call 1
`ai.ts:83-87` → `qwen.analyzeIntent(prompt, userId, images)`

- Model: `qwen-turbo` (or `qwen-vl-max` if images present)
- System prompt: `INTENT_SYSTEM_PROMPT` (`prompts.ts:1-75`)
- Response format: `{ type: "json_object" }`, temperature: 0.2
- Returns either:
  - `{ fullIntent: false, questions: [...] }` — vague query, needs clarification
  - `{ fullIntent: true, contextPayload: {...}, contextContent: "<TOON string>" }` — clear query

### 3. Validation + fallback LLM Call 2
`ai.ts:93-98`

If `contextContent` is missing or does not contain both `"TYPE"` and `"TODOS"` strings:
- Calls `qwen.buildContext(prompt, undefined, userId)` (`prompts.ts:77-end` — `CONTEXT_BUILDER_PROMPT`)
- Returns raw TOON text

If both LLM calls fail: `ContextBuilder.build()` (`contextBuilder.ts:27-46`) returns simple markdown template (last resort, rare).

---

## Phase 2: TOON Plan → AI Agents.md in Sandbox

### 4. setupWorker picks up the job
`setupWorker.ts:116-133` — `processSetupJob()`

**Fast path** (`setupWorker.ts:180-181`): `cachedAiResponse.contextContent` present → used directly as `aiAgentsMd`, no new LLM call.

**Slow path** (`setupWorker.ts:183-208`): no cache → calls `ai.processPrompt()` again.

### 5. Write AI Agents.md to sandbox
`setupWorker.ts:228-235` calls `SandboxManager.openAndInit({ aiAgentsMd, ... })`

Inside `sandboxManager.ts`:
- Line 62-119: Creates or connects to E2B sandbox via `Sandbox.create()` / `Sandbox.connect()`
- **Line 128**: `sandbox.files.write("/workspace/AI Agents.md", input.aiAgentsMd)`
- Line 158: `await Promise.all(fileWrites)` — write executed here

### 6. Persist to DB + parse todos
`setupWorker.ts:260-265`:
- `workspaceService.updateAI Agents(workspaceId, aiAgentsMd)` → saves to DB
- `parseTodosFromContext(aiAgentsMd)` (`planningUtils.ts:43-186`) → parses `TODOS` section
- `todoService.createTodosWithDeps(workspaceId, todos, 1)` → saves todos to DB
- Enqueues **`agent-run`** BullMQ job

---

## Phase 3: AI Agents.md Read Before Every Loop

### 7. Agent job → orchestrator → agentRunner
`agentWorker.ts:226` → `runOrchestrator(agentCtx, multiAgent, emit)` → `orchestratorRunner.ts` → `runAgent(agentCtx)`

### 8. System prompt construction
`agentRunner.ts:1001-1005`:
```ts
const baseSystemPrompt =
  overrideSystemPrompt ??
  (planMode
    ? getPlanModePrompt({ framework, idea, workspaceConfig })
    : getSystemPrompt({ framework, templateId, idea, workspaceConfig }));
```

System prompt locations that instruct reading AI Agents.md:
- `systemPrompt.ts:380-381` (prebuilt Next.js path): `"Start by reading /workspace/AI Agents.md"`
- `systemPrompt.ts:441-442` (fallback path): `"First, check if AI Agents.md exists..."`
- `systemPrompt.ts:555-556` (plan mode): `"cat /workspace/AI Agents.md if it exists"`
- `systemPrompt.ts:290` (SHARED_RULES, all paths): `"AI Agents.md contains everything you need"`

### 9. Wave task message — per-loop injection
`agentRunner.ts:733-734` inside `buildInitialWaveMessage()`, injected at line 1402-1406:
```
"- Knowledge Base: Read /workspace/AI Agents.md ONCE for the full spec. Then go straight to writing code"
```
This fires **at the start of every wave** (outer loop iteration).

### 10. Agent reads AI Agents.md via tool call
The agent issues a `read_file` tool call targeting `/workspace/AI Agents.md` in the sandbox.

**AI Agents.md content is NEVER injected into the prompt.** The agent reads it from the sandbox filesystem each time it starts a new wave.

---

## Loop Structure

```
Outer wave loop: while (totalIterations < 120)       agentRunner.ts:1211
  ↓ pick next ready todo wave (1 todo per wave)       agentRunner.ts:1249
  ↓ buildInitialWaveMessage() → injects AI Agents.md read instruction
  ↓
  Inner iteration loop: for (0..20)                   agentRunner.ts:1421
    ↓ call LLM with current message history
    ↓ handle tool calls (read_file, write_file, run_command, ...)
    ↓ break on FINAL ANSWER
```

---

## Existing Workspace Update Flow

For a workspace **with an existing sandbox**:
- `WSManager.ts:980` → `handleUpdateIntent()`
- `buildUpdateContext(workspace)` (`planningUtils.ts:189-208`) reads `aiAgentsMd` **from DB** (not sandbox)
- This is passed to `ai.planUpdate()` for re-planning
- Updated todos created in DB
- New `agent-run` job enqueued
- Agent reads `/workspace/AI Agents.md` from sandbox as normal

---

## TOON Format (AI Agents.md)

```
TYPE READY

CONTEXT
SUMMARY: one-line description
GOAL: desired outcome

TECH
FRONTEND: Next.js
BACKEND: Express
DATABASE_REQUIRED: false

FEATURES
- item

TODOS
[1] TITLE: short action
    DESC: implementation detail with concrete files/modules
    DEPS: []

[2] TITLE: ...
    DESC: ...
    DEPS: [1]
```

`parseTodosFromContext()` (`planningUtils.ts:43-186`) finds the `TODOS` section and parses `[N] TITLE:` + `DESC:` + `DEPS:` fields. Max 4 todos returned.

---

## Flow Diagram

```
User query
    │
    ▼
WSManager USER_REQUEST (WSManager.ts:728)
    │
    ├─ New workspace ──────────────────────────────────────────────
    │   ai.processPrompt() (ai.ts:83)
    │   └── qwen.analyzeIntent() → TOON plan string
    │       └── fallback: qwen.buildContext()
    │           └── last resort: ContextBuilder.build()
    │
    │   enqueue workspace-setup job (BullMQ)
    │
    │   setupWorker.ts:processSetupJob()
    │   └── SandboxManager.openAndInit()
    │       └── sandbox.files.write("/workspace/AI Agents.md") (sandboxManager.ts:128)
    │   └── workspaceService.updateAI Agents() → saves to DB
    │   └── parseTodosFromContext() → DB todos
    │
    │   enqueue agent-run job (BullMQ)
    │
    ├─ Existing workspace ─────────────────────────────────────────
    │   handleUpdateIntent() (WSManager.ts:2234)
    │   └── buildUpdateContext() reads aiAgentsMd from DB
    │   └── ai.planUpdate() → new todos
    │   └── enqueue agent-run job (BullMQ)
    │
    ▼
agentWorker.ts → runOrchestrator() → runAgent() (agentRunner.ts)
    │
    ├─ Build system prompt: getSystemPrompt() (systemPrompt.ts)
    │   └── includes "read /workspace/AI Agents.md" instructions
    │
    └─ Wave loop (max 120 iterations)
        └─ buildInitialWaveMessage() → "Read /workspace/AI Agents.md ONCE"
        └─ Inner loop (max 20 iterations per wave)
            └─ Agent issues read_file("/workspace/AI Agents.md") tool call
            └─ Agent implements todo based on spec
```
