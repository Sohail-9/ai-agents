# Multi-Agent System — Implementation Plan

## Overview

Add a **detachable, flag-controlled multi-agent system** alongside the existing single-agent path. When the client enables the flag the main agent can delegate work to two specialist sub-agents (Researcher and File Agent). When the flag is off the system behaves exactly as today.

---

## Current Architecture (relevant parts)

```
Client (WS)  →  WSManager  →  BullMQ (agent-run)  →  agentWorker  →  agentRunner (single loop)
                                                                         ↕ tools: shell, file, search, web…
```

Key files:
- `backend/src/brain/agentRunner.ts` — the entire agent loop (~1600 lines)
- `backend/src/skills/index.ts` — tool registry
- `backend/src/ws/WSManager.ts` — WebSocket event routing
- `backend/src/ws/protocol.ts` — event type definitions
- `backend/src/queue/jobTypes.ts` — BullMQ job payloads
- `backend/src/workers/agentWorker.ts` — processes agent-run jobs

---

## Target Architecture

```
Client (WS, multiAgent: true)
  →  WSManager
  →  BullMQ (agent-run, multiAgent: true)
  →  agentWorker
  →  orchestratorRunner          ← thin wrapper / router
       │
       ├─ [single-agent path]    ← existing agentRunner, unchanged
       │
       └─ [multi-agent path]
            │
            ├── ResearcherAgent  ─────────────── (parallel)
            │     tools: web_search              │
            │     returns: structured report     │
            │                                    ▼
            ├── FileAgent        ─────────── Promise.all()
            │     tools: read_file,              │
            │            search_code,            │
            │            execute_shell (r/o)     │
            │     returns: structured report     │
            │                                    ▼
            └── SynthesisNode  ◄─── joins both reports
                  • merges Researcher + File reports into
                    a single structured context block
                  • injects as a system-role "AGENT CONTEXT"
                    message into MainAgent's conversation
                  • emits SYNTHESIS_READY to WS clients
                       │
                       ▼
                  MainAgent (executor)
                    • receives pre-built context, no delegation tool
                    • tools: shell, edit_file, todo_manager,
                              env_manager, check_health, context_save
                    • runs existing runAgent() loop to completion
```

Sub-agents are **in-process async functions** (not separate BullMQ jobs). They share the same E2B sandbox connection and Prisma client. **Both sub-agents run concurrently via `Promise.all()`**. The SynthesisNode joins their outputs before the MainAgent ever starts, so the MainAgent receives a fully assembled context block and executes without needing to delegate mid-run.

---

## Feature Flag Flow

```
1. Client UI toggle → localStorage flag "multiAgentEnabled"
2. Sent in AGENT_RUN WebSocket payload:  { ..., multiAgent: true }
3. WSManager passes flag into BullMQ job payload (AgentRunJobData)
4. agentWorker reads flag → calls orchestratorRunner
5. orchestratorRunner branches:
   • flag = false  → existing runAgent() (zero changes to existing path)
   • flag = true   → new runMultiAgent()
```

No existing code paths are touched when the flag is false.

---

## File & Folder Changes

### New files
```
backend/src/brain/agents/
  subAgentTypes.ts        ← shared types (SubAgentContext, SubAgentResult, SubAgentPlan)
  researcherAgent.ts      ← Researcher sub-agent (web_search only)
  fileAgent.ts            ← File Explorer sub-agent (read-only sandbox)
  synthesisNode.ts        ← joins both reports into one context block (explicit join node)
  orchestratorRunner.ts   ← parallel launch → join → prepend context → runAgent()
```

### Modified files
```
backend/src/ws/protocol.ts           ← add SUBAGENT_START, SUBAGENT_STREAM_CHUNK,
                                        SUBAGENT_DONE, SYNTHESIS_READY events
backend/src/queue/jobTypes.ts        ← add multiAgent?: boolean to AgentRunJobData
backend/src/workers/agentWorker.ts   ← call orchestratorRunner instead of runAgent directly
frontend/src/app/system/[id]/...     ← flag toggle in UI + new WS event handlers
```

### NOT modified
```
backend/src/skills/index.ts          ← no changes; no new tools needed
backend/src/brain/agentRunner.ts     ← not touched at all
```

---

## Detailed Implementation Steps

### Step 1 — Sub-agent type definitions
**File:** `backend/src/brain/agents/subAgentTypes.ts`

```ts
export interface SubAgentContext {
  workspaceId: string;
  sandboxId: string;
  signal: AbortSignal;
  emit: (event: string, data: unknown) => void;   // forwards to WS clients
  llmClient: UnifiedLLMClient;
}

export interface SubAgentResult {
  agent: 'researcher' | 'file';
  task: string;
  report: string;   // markdown, consumed by SynthesisNode
  tokensUsed: number;
  durationMs: number;
}

export interface SubAgentPlan {
  researchTask: string;   // derived from user message before agents start
  fileTask: string;
}
```

No `DelegateCall` type needed — tasks are planned upfront, not on-demand.

---

### Step 2 — ResearcherAgent
**File:** `backend/src/brain/agents/researcherAgent.ts`

- Receives `task: string` and `SubAgentContext`
- Has **only** `web_search` in its tool list
- Runs a stripped-down LLM loop (MAX_ITERATIONS = 10)
- System prompt: "You are a research specialist. Gather information via web search and return a concise structured markdown report. Do not write code. Do not access files. When done output RESEARCH_COMPLETE followed by your report."
- Streams chunks via `emit(SUBAGENT_STREAM_CHUNK, { agent: 'researcher', chunk })`
- Resolves to `SubAgentResult`

---

### Step 3 — FileAgent
**File:** `backend/src/brain/agents/fileAgent.ts`

- Receives `task: string` and `SubAgentContext`
- Tools: `read_file`, `search_code`, read-only `execute_shell` (whitelist: `ls`, `find`, `cat`, `grep`, `head`, `tail`, `wc`, `tree`, `stat`, `file`, `pwd`)
- Runs a stripped-down LLM loop (MAX_ITERATIONS = 15)
- System prompt: "You are a file exploration specialist. Explore the sandbox file system and return a structured report of relevant files and code patterns. Do not modify files. When done output FILE_COMPLETE followed by your report."
- Streams chunks via `emit(SUBAGENT_STREAM_CHUNK, { agent: 'file', chunk })`
- Resolves to `SubAgentResult`

---

### Step 4 — SynthesisNode
**File:** `backend/src/brain/agents/synthesisNode.ts`

This is the **explicit join point**. Called after `Promise.all()` resolves with both sub-agent results.

```ts
export async function synthesizeReports(
  researcher: SubAgentResult,
  file: SubAgentResult,
  userMessage: string,
  llmClient: UnifiedLLMClient,
): Promise<string>
```

- Makes a **single LLM call** (no tool loop) with a fixed synthesis prompt
- Prompt instructs: merge both reports into one `AGENT CONTEXT` block, resolve contradictions, surface only what is relevant to the user's original message, cap at 3000 tokens
- Returns the synthesized context string
- This string is prepended as a `system`-role message into `ctx.messages` before MainAgent starts

Emits `SYNTHESIS_READY { summary: first100chars }` to WS clients so the frontend can show "Context ready, starting main agent…"

---

### Step 5 — orchestratorRunner
**File:** `backend/src/brain/agents/orchestratorRunner.ts`

```ts
export async function runOrchestrator(ctx: AgentRunnerContext, multiAgent: boolean) {
  if (!multiAgent) {
    return runAgent(ctx);   // existing path, zero changes
  }
  return runMultiAgent(ctx);
}
```

`runMultiAgent(ctx)`:

```
1. planSubAgentTasks(ctx.userMessage, ctx.llmClient)
     → one LLM call → returns SubAgentPlan { researchTask, fileTask }

2. emit SUBAGENT_START { agent: 'researcher', task: researchTask }
   emit SUBAGENT_START { agent: 'file',       task: fileTask }

3. [researcherResult, fileResult] = await Promise.all([
     runResearcherAgent(researchTask, subCtx),
     runFileAgent(fileTask, subCtx),
   ])
   // both stream SUBAGENT_STREAM_CHUNK independently during this await
   // emit SUBAGENT_DONE for each as they finish

4. contextBlock = await synthesizeReports(researcherResult, fileResult, userMessage, llmClient)
   emit SYNTHESIS_READY

5. Prepend contextBlock as system message into ctx.messages

6. Strip web_search, read_file, search_code from ctx.tools
   (MainAgent has no research/file tools — synthesis already handled them)

7. return runAgent(ctx)   // existing agent loop, unmodified
```

Why `runAgent()` as the inner loop: the 1600-line agent runner is not duplicated. The multi-agent path is entirely pre-processing — by the time `runAgent()` is called the context is already enriched.

---

### Step 6 — WebSocket protocol additions
**File:** `backend/src/ws/protocol.ts`

```ts
// Server → Client
SUBAGENT_START        = 'SUBAGENT_START',         // { agent: string, task: string }
SUBAGENT_STREAM_CHUNK = 'SUBAGENT_STREAM_CHUNK',  // { agent: string, chunk: string }
SUBAGENT_DONE         = 'SUBAGENT_DONE',          // { agent: string, durationMs: number }
SYNTHESIS_READY       = 'SYNTHESIS_READY',        // { summary: string }
```

`SUBAGENT_DONE` fires per-agent as each resolves (not after both). `SYNTHESIS_READY` fires once both are done and the join is complete. This lets the frontend show accurate per-agent progress.

---

### Step 7 — Job payload & worker update
**File:** `backend/src/queue/jobTypes.ts`

```ts
export interface AgentRunJobData {
  // ...existing fields...
  multiAgent?: boolean;   // NEW — defaults to false
}
```

**File:** `backend/src/workers/agentWorker.ts`

```ts
// Replace:
await runAgent(ctx);
// With:
await runOrchestrator(ctx, job.data.multiAgent ?? false);
```

---

### Step 8 — No skill registry changes needed

The `delegate_to_agent` tool is **removed from the design**. Sub-agents are launched by `orchestratorRunner` directly, not by the main agent calling a tool. The skill registry requires no new entries.

The only tool-list change is stripping `web_search`, `read_file`, `search_code` from `ctx.tools` inside `runMultiAgent()` before `runAgent()` is called — this is a local array filter, not a registry change.

---

### Step 9 — Frontend flag toggle
**Location:** System page header or settings panel

- A toggle switch labelled "Multi-Agent Mode"
- Persisted in `localStorage` under key `pf_multiAgent`
- Read in `use-system-websocket.ts` when constructing the AGENT_RUN payload
- New WS event handlers: `SUBAGENT_START`, `SUBAGENT_STREAM_CHUNK`, `SUBAGENT_DONE`, `SYNTHESIS_READY`
- UI: two parallel progress bars/badges (one per agent) that complete independently, then a "Synthesizing…" state before the main stream begins

---

## Data Flow (multi-agent path, step by step)

```
1.  User sends message, multiAgent = true
2.  WSManager → BullMQ job { ..., multiAgent: true }
3.  agentWorker → orchestratorRunner(ctx, true)
4.  orchestratorRunner derives sub-tasks from the user's message
      (one research task + one file-exploration task, both derived upfront)

5.  PARALLEL PHASE — both sub-agents start simultaneously:
      Promise.all([
        runResearcherAgent(researchTask, subCtx),   ← emits SUBAGENT_START { agent: 'researcher' }
        runFileAgent(fileTask, subCtx),             ← emits SUBAGENT_START { agent: 'file' }
      ])
      Each streams SUBAGENT_STREAM_CHUNK to WS clients independently.
      Each resolves to a SubAgentResult when done.

6.  JOIN / SYNTHESIS PHASE (SynthesisNode):
      a. Awaits Promise.all() — both results in hand
      b. Calls synthesizeReports(researcherResult, fileResult, userMessage)
           → one LLM call with a fixed synthesis prompt
           → produces a single "AGENT CONTEXT" block (≤ 3000 tokens)
      c. Emits SYNTHESIS_READY { summary } to WS clients
      d. Prepends the context block as a system-role message
         into ctx.messages before MainAgent starts

7.  EXECUTION PHASE — MainAgent runs via existing runAgent():
      • receives pre-built context, no delegation tool needed
      • tools: execute_shell, edit_file, todo_manager,
               env_manager, check_health, context_save
      • streams AGENT_STREAM_CHUNK as normal
      • eventually emits FINAL ANSWER (existing flow, unchanged)
```

---

## What Does NOT Change

- `runAgent()` internals — not touched
- Existing tool implementations
- BullMQ queue names and worker concurrency
- WebSocket AUTH and existing event types
- Database schema (no new tables needed)
- Plan mode path
- Sandbox management

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sub-agent token cost | Sub-agents can use a cheaper model via `SUBAGENT_MODEL` env var; synthesis is one call |
| One sub-agent hangs, blocks Promise.all | Each sub-agent has its own 90 s timeout; `Promise.allSettled()` fallback if one fails — the synthesis node handles a missing report gracefully |
| Synthesis output too large for context | SynthesisNode is instructed to cap at 3000 tokens; hard-truncate before prepending |
| Sub-agent task derivation is wrong | `planSubAgentTasks()` is a cheap upfront LLM call; worst case both sub-agents do unnecessary work but MainAgent still runs correctly |
| `Promise.all` race — FileAgent reads files that are not yet created | FileAgent is read-only exploration of existing files; creation happens in MainAgent after synthesis, so there is no write/read race |
| Multi-agent flag accidentally on in prod | Flag defaults to false everywhere; must be explicitly set client-side per session |

---

## Implementation Order

1. `subAgentTypes.ts` — types only, no logic
2. `researcherAgent.ts` — stripped LLM loop, web_search only
3. `fileAgent.ts` — stripped LLM loop, read-only tools
4. `synthesisNode.ts` — single LLM call, joins two reports → context block  ← **explicit join node**
5. `orchestratorRunner.ts` — plan tasks → `Promise.all()` → synthesize → prepend → `runAgent()`
6. `protocol.ts` — four new WS event constants
7. `jobTypes.ts` + `agentWorker.ts` — wire `multiAgent` flag through
8. Frontend toggle + event handlers for parallel progress UI

Each step is independently testable and mergeable. No changes to `agentRunner.ts` or `skills/index.ts` at any step.

---

## Open Questions (decide before coding)

1. **Should sub-agents share the same LLM provider/model as the main agent, or use a fixed cheaper model?**
   Recommendation: use the same provider but allow overriding model via env var `SUBAGENT_MODEL`.

2. **Should sub-agent messages be persisted to the Message table?**
   Recommendation: no — they are ephemeral; only the final report (as a tool result) is persisted as part of the main conversation.

3. **Should the main agent keep web_search and file tools too, or are they exclusively delegated?**
   Recommendation: remove them from main agent's list when multi-agent is on, to force delegation and avoid the main agent doing its own ad-hoc research that bypasses the structured report pattern.

4. **What is the max number of delegations per run?**
   Recommendation: 4 (2 researcher + 2 file), to cap token usage.
