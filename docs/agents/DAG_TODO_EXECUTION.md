# DAG-Based Todo Execution

**Status**: Design spec — not yet implemented
**Branch**: development

---

## Problem

The current todo execution model is strictly sequential. Todos are picked by lowest `order` value and executed one at a time:

```
Todo 1 → complete → Todo 2 → complete → Todo 3 → complete → Todo 4
```

This means two completely independent tasks — like "build frontend components" and "set up backend routes" — run back-to-back even though they could be worked on together. The agent wastes context and time doing things serially that have no dependency on each other.

---

## Solution: DAG Wave Execution

Model todos as a directed acyclic graph. Each todo declares which other todos must complete before it can start. Todos with no unsatisfied dependencies form a **wave** and are handed to the agent together. When the wave completes, the next wave is computed and executed.

```
Wave 1 (independent):   [Todo 1] + [Todo 2]  → run together
Wave 2 (depends on 1+2): [Todo 3]            → runs after wave 1
Wave 3 (depends on 3):   [Todo 4]            → runs after wave 2
```

The agent still runs in a single process against the shared E2B sandbox. "Together" means the agent receives all wave todos as a combined task in one agentic pass — it naturally works through them while avoiding file conflicts.

---

## Architecture

### 1. Schema Change

Add `dependencies` to the `Todo` model as a native Postgres string array:

```prisma
model Todo {
  id           String     @id @default(cuid())
  workspaceId  String
  title        String
  description  String
  status       TodoStatus @default(pending)
  order        Int
  dependencies String[]   @default([])   // IDs of todos that must complete first
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  workspace    Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, order])
}
```

A native `String[]` column stores the dependency IDs directly on each todo row. No join table is needed at this scale.

---

### 2. TOON Format Extension

The planner outputs a `DEPS` line for each todo declaring its dependencies by order number:

```
TODOS
[1] TITLE: Set up backend API routes
    DESC: Create Express routes for /users and /posts in /workspace/backend/src/routes
    DEPS: []

[2] TITLE: Build frontend components
    DESC: Create UserList and PostList components in /workspace/frontend/src/components
    DEPS: []

[3] TITLE: Wire frontend to backend
    DESC: Connect components to the API using NEXT_PUBLIC_API_URL
    DEPS: [1, 2]

[4] TITLE: Health check and verify
    DESC: Confirm both servers respond and UI loads data correctly
    DEPS: [3]
```

`DEPS: []` means no dependencies — eligible for wave 1.
`DEPS: [1, 2]` means this todo cannot start until todos 1 and 2 are both complete.

Rules the planner must follow:
- Only add a dependency when the work genuinely cannot start without the other todo being done
- Never create circular dependencies
- Default to no dependencies unless there is a clear sequencing requirement
- Frontend and backend work with no shared files are always independent

---

### 3. Dependency Resolution on Creation

TOON uses order numbers (`[1]`, `[2]`) as references. After todos are created in the DB, their actual CUID IDs must be wired in.

**Creation flow:**

```
Step 1: Parse TOON → [{ title, desc, order, depsOrders: [1,2] }, ...]
Step 2: Create all Todo DB rows → [{ id: "cuid_a", order: 1 }, { id: "cuid_b", order: 2 }, ...]
Step 3: Build map: orderToId = { 1: "cuid_a", 2: "cuid_b", ... }
Step 4: For each todo with depsOrders: update dependencies = depsOrders.map(n => orderToId[n])
```

This two-phase creation keeps TOON simple (human-readable order numbers) while the DB stores the stable CUID references.

---

### 4. `todoService` — New Methods

**`getReadyTodos(workspaceId)`**

Returns all `pending` todos whose every dependency is `completed`. This replaces the current `getCurrentTodo`.

```typescript
getReadyTodos: async (workspaceId: string) => {
  const allTodos = await prisma.todo.findMany({ where: { workspaceId } });
  const completedIds = new Set(
    allTodos.filter(t => t.status === 'completed').map(t => t.id)
  );
  return allTodos.filter(t =>
    t.status === 'pending' &&
    (t.dependencies as string[]).every(depId => completedIds.has(depId))
  );
};
```

**`createTodo`** — add optional `dependencies` parameter:

```typescript
createTodo: async (data: {
  workspaceId: string;
  title: string;
  description: string;
  order: number;
  dependencies?: string[];
})
```

---

### 5. AgentRunner — Wave Execution Loop

**Current outer loop:**
```typescript
while (totalIterations < MAX_TOTAL_ITERATIONS) {
  const todo = await todoService.getCurrentTodo(workspaceId);   // 1 todo
  if (!todo) break;
  // run 20-iteration inner loop for this single todo
}
```

**New outer loop:**
```typescript
while (totalIterations < MAX_TOTAL_ITERATIONS) {
  const readyTodos = await todoService.getReadyTodos(workspaceId);  // N todos
  if (readyTodos.length === 0) break;
  // inject all ready todos as combined task
  // run inner loop — agent handles all of them
  // outer loop re-evaluates when all are marked complete
}
```

**Combined task injection:**

When multiple todos are ready, they are injected as a single user message:

```
## Your Tasks (2 ready — independent, you can work on them together)

### Task 1 — Set up backend API routes
Create Express routes for /users and /posts in /workspace/backend/src/routes.
Mark complete with: FINAL ANSWER TASK=<id> when done.

### Task 2 — Build frontend components
Create UserList and PostList components in /workspace/frontend/src/components.
Mark complete with: FINAL ANSWER TASK=<id> when done.
```

**FINAL ANSWER format for waves:**

Single todo (current):
```
FINAL ANSWER FRONTEND=3000 BACKEND=8000
Summary of what was built.
```

Wave with multiple todos — the agent marks each one individually:
```
FINAL ANSWER TASK=cuid_abc FRONTEND=3000
UserList and PostList components created with Tailwind styling.

FINAL ANSWER TASK=cuid_def BACKEND=8000
GET /users and GET /posts routes implemented with Prisma.
```

The inner loop tracks which tasks in the current wave have been completed and only exits when all are marked done (or max iterations reached).

---

### 6. Prompt Changes

**`CONTEXT_BUILDER_PROMPT`** — add DEPS to format spec:

```
TODOS
[1] TITLE: short action
    DESC: implementation detail with concrete files and validation
    DEPS: []

[2] TITLE: short action
    DESC: implementation detail
    DEPS: [1]

Dependency rules:
- DEPS lists the order numbers of todos that must complete before this one can start
- Use DEPS: [] for todos that can start immediately
- Only add a dependency when work genuinely cannot start without the other todo being done
- Frontend and backend work on separate files are always independent (DEPS: [])
- Never create circular dependencies
```

**`UPDATE_PLANNER_PROMPT`** — same DEPS syntax addition.

---

### 7. Parser Changes

`parseTodosFromContext` in both `WSManager.ts` and `setupWorker.ts` needs to:

1. Parse the `DEPS: [1, 2]` line after each todo's DESC
2. Store it as `depsOrders: number[]` temporarily
3. After all todos are DB-created, resolve order numbers to CUID IDs
4. Batch-update the `dependencies` field

```typescript
// Parsed intermediate structure
interface ParsedTodo {
  title: string;
  description: string;
  order: number;
  depsOrders: number[];   // from DEPS: [1, 2]
}

// After DB creation
async function createTodosWithDeps(
  workspaceId: string,
  parsed: ParsedTodo[]
): Promise<void> {
  // Phase 1: create all todos
  const created = await Promise.all(
    parsed.map((t, i) => todoService.createTodo({
      workspaceId,
      title: t.title,
      description: t.description,
      order: i + 1,
    }))
  );

  // Phase 2: build order → id map
  const orderToId = Object.fromEntries(
    created.map((todo, i) => [parsed[i].order, todo.id])
  );

  // Phase 3: update dependencies where needed
  const withDeps = created.filter((_, i) => parsed[i].depsOrders.length > 0);
  await Promise.all(
    withDeps.map((todo, i) => {
      const idx = created.indexOf(todo);
      const depIds = parsed[idx].depsOrders
        .map(n => orderToId[n])
        .filter(Boolean);
      return prisma.todo.update({
        where: { id: todo.id },
        data: { dependencies: depIds },
      });
    })
  );
}
```

---

## Execution Example

**User prompt:** "Build a todo app with a React frontend and Express backend"

**Planner output:**
```
[1] TITLE: Build Express backend API
    DESC: Create /api/todos CRUD routes with in-memory store
    DEPS: []

[2] TITLE: Build React frontend UI
    DESC: Create TodoList, TodoItem, AddTodo components with Tailwind
    DEPS: []

[3] TITLE: Connect frontend to backend
    DESC: Add NEXT_PUBLIC_API_URL, create API client, wire components to /api/todos
    DEPS: [1, 2]
```

**Execution:**

```
Wave 1: getReadyTodos → [Todo 1, Todo 2]  (both have DEPS: [])
  Agent receives combined task for Todo 1 + Todo 2
  Agent builds backend routes AND frontend components in one pass
  Both marked complete via FINAL ANSWER TASK=...

Wave 2: getReadyTodos → [Todo 3]  (deps [1,2] now complete)
  Agent receives single task for Todo 3
  Agent wires frontend to backend
  Marked complete

Wave 3: getReadyTodos → []  (no more pending todos)
  Loop exits → AGENT_DONE
```

---

## What Does NOT Change

- The E2B sandbox is still single-process — no concurrent file writes
- The agent still uses the same tool set (edit_file, execute_shell, etc.)
- The BullMQ job structure stays the same — one `agent-run` job per workspace run
- Abort/stop signal handling is unchanged
- Memory, multi-agent (researcher + file), and plan mode are all unaffected

---

## Migration

```sql
-- Prisma migration generates this automatically
ALTER TABLE "Todo" ADD COLUMN "dependencies" TEXT[] NOT NULL DEFAULT '{}';
```

No data migration needed — all existing todos get `dependencies = []` which is correct (they were all independent by assumption).

---

## Files to Modify

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | Add `dependencies String[] @default([])` to Todo |
| `backend/src/services/todoService.ts` | Add `getReadyTodos()`, extend `createTodo` with `dependencies?` |
| `backend/src/brain/agentRunner.ts` | Replace `getCurrentTodo` with wave loop using `getReadyTodos` |
| `backend/src/brain/prompts.ts` | Add DEPS syntax to CONTEXT_BUILDER_PROMPT and UPDATE_PLANNER_PROMPT |
| `backend/src/brain/systemPrompt.ts` | Update agent output instructions for multi-task FINAL ANSWER format |
| `backend/src/ws/WSManager.ts` | Update `parseTodosFromContext` to parse DEPS, two-phase creation |
| `backend/src/workers/setupWorker.ts` | Same parser fix as WSManager |

---

## Open Questions

1. **Max wave size** — should there be a cap on how many todos can be in one wave? A wave of 5 independent todos creates a very large combined task prompt. Suggested cap: 3 per wave.

2. **Partial wave failure** — if the agent completes 2 of 3 wave todos before hitting max iterations, the 3rd gets force-marked complete. Should the incomplete todo be retried in a new wave or permanently failed?

3. **Dependency validation** — should the parser reject a TOON plan with circular dependencies, or just silently fall back to sequential execution?

4. **Frontend display** — the todo panel should visually show dependency relationships (e.g., a lock icon on todos waiting for deps, wave grouping). That is a frontend change not covered here.

---

## Design Review — System Design & AI Architecture Critique

### What's Good

**The core concept is right.** Wave-based DAG execution is the correct mental model for this problem. Sequential execution of independent tasks is a genuine waste of agent context and time, and the wave abstraction maps cleanly to topological sort levels.

**Schema choice is sound.** `String[]` on the Todo row is correct — a join table would be over-engineering for a max of 4-5 todos per workspace. The two-phase creation (create all → resolve IDs) is the right approach.

**"What does not change" section is valuable.** Explicitly calling out the E2B single-process constraint grounds the design and prevents scope creep into actual parallel sandbox execution.

---

### Critical Problems

#### 1. The LLM doesn't know its own todo CUIDs

The `FINAL ANSWER TASK=cuid_abc` format is broken before it starts.

The agent runs inside the LLM loop. It has no way to know the DB-assigned CUID of a todo. You'd have to inject the actual IDs into the task prompt, which means the agent would need to reproduce a string like `FINAL ANSWER TASK=cm9x2k4p70001ab3c9def1gh2` exactly. LLMs will hallucinate this or truncate it.

**Fix:** Use the order number. `FINAL ANSWER TASK=1` is reliable because order numbers are small, predictable integers the agent can see in the task prompt. The runner maps it back to the DB ID.

---

#### 2. MAX_ITERATIONS doesn't scale with wave size

Currently: `MAX_ITERATIONS = 20` per todo. With a wave of 3 independent todos, the agent needs up to 60 iterations total but the inner loop still caps at 20. Two of the three todos get force-marked complete as "timed out."

This is a **blocking design gap** — not an open question. The iteration budget must be defined before implementation.

**Fix:** `waveIterationBudget = MAX_ITERATIONS_PER_TODO * readyTodos.length` with a ceiling (e.g. 50 total).

---

#### 3. The inner loop break condition is undefined for waves

Currently the inner loop does:
```typescript
if (finalAnswerDetected) {
  todoCompleted = true;
  break;
}
```

With multiple todos in a wave, the loop must detect `FINAL ANSWER TASK=N` for each one. The `break` condition should be "all todos in this wave are completed," not "any FINAL ANSWER seen." The current `todoCompleted` boolean needs to become a `Set<number>` of completed wave order numbers.

This is a substantive agentRunner rewrite, not a small change. The doc understates it.

---

#### 4. Circular dependency causes a silent infinite loop

If the parser generates a circular dependency (A depends on B, B depends on A), `getReadyTodos` returns an empty array but there are still pending todos. The outer loop sees `readyTodos.length === 0` and breaks, silently marking the run as complete when nothing was done.

This must be caught at parse time with a cycle detection check (DFS on the dependency graph) before any todos are created in the DB.

---

#### 5. In-progress todos break on retry

When the agentWorker retries a failed job, all wave todos are already `in_progress` (marked before the crash). `getReadyTodos` only returns `pending` todos. The retry sees no ready todos and exits immediately.

**Fix:** On job start, reset any `in_progress` todos for this workspace back to `pending` before the wave loop begins.

---

### Design Gaps

#### 6. `getReadyTodos` fetches all todos to filter in-memory

```typescript
const allTodos = await prisma.todo.findMany({ where: { workspaceId } });
```

Works for 4-5 todos. At 50+ todos across long-running workspaces with many update runs it becomes a full table scan per outer loop iteration. Acceptable now, but noted as a known limitation.

#### 7. `blocked` status is missing from the schema

The doc proposes a `dependencies` field but keeps the status enum as `pending | in_progress | completed`. A todo waiting for its dependencies is visually indistinguishable from a todo that is ready to run. The UI cannot show "this is blocked until todo 2 finishes."

**Proposed addition:**
```prisma
enum TodoStatus {
  pending      // ready to run — no unsatisfied deps
  blocked      // has unmet dependencies — not yet ready
  in_progress
  completed
}
```

When todos are created with deps, set their initial status to `blocked`. Transition to `pending` when all deps complete. `getReadyTodos` then simply queries `status = pending` — no in-memory filtering needed. This also fixes the performance gap in point 6.

#### 8. `order` field meaning becomes ambiguous

Currently `order` determines execution sequence. With DAGs, execution order is determined by the dependency graph, not the `order` integer. The doc does not address this conflict.

The `order` field should be explicitly redefined as **display order only** — consistent UI rendering — and no code should use it for execution sequencing.

#### 9. TOON format is already fragile — DEPS makes it worse

SYSTEM_ANALYSIS.md already flags TOON parsing as fragile. Adding a new `DEPS` line increases the surface area for malformed output. The parser handles `DEPS: [1, 2]` but not:

- `DEPS:[]` (no space)
- `DEPS: 1, 2` (no brackets)
- `DEPS: none` (LLM words it differently)
- Missing DEPS line entirely (LLM forgets it)

All of these must default to `DEPS: []` (independent). The parser must be tolerant, not strict.

---

### What's Missing from the Doc

| Gap | Why It Matters |
|---|---|
| Cycle detection at parse time | Without it a circular dep silently kills a run |
| `blocked` TodoStatus | Required for correct UI state and efficient DB query |
| Wave iteration budget formula | Blocking gap — implementation cannot proceed without this |
| `order` field redefined as display-only | Creates implementation confusion otherwise |
| Tolerant DEPS parsing rules | Fragile LLM output is a known issue — parser must be defensive |
| Retry behavior for in-progress wave todos | Existing retry logic breaks with the new model |

---

### Verdict

The concept and architecture are correct. The wave model, schema choice, two-phase creation, and single-agent-per-wave approach are all sound decisions.

But there are **3 blocking gaps** that must be resolved before any code is written:

1. **FINAL ANSWER TASK format** — use order number, not CUID
2. **Wave iteration budget** — define the formula explicitly
3. **Circular dependency detection** — required at parse time, before DB creation

And **1 schema addition** that will prevent a class of bugs downstream:

4. **`blocked` TodoStatus** — makes `getReadyTodos` both simpler and correct

Resolve these in the doc first, then the spec is implementation-ready.
