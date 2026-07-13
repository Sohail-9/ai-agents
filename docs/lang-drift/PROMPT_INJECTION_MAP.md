# AI Agents Prompt Injection Architecture Map

## Overview
This document maps the complete flow of prompt injection in the AI Agents backend, detailing where prompts are defined, how they flow through the system, and where they are injected at each stage of agent execution.

---

## 1. PROMPT DEFINITION FILES

### 1.1 Core Prompt Library
**File:** `/backend/src/brain/prompts.ts`

Contains 6 main prompt constants:

| Prompt Constant | Purpose | Used By |
|---|---|---|
| `INTENT_SYSTEM_PROMPT` | Analyzes user intent for project building | Intent Analysis Flow |
| `CONTEXT_BUILDER_PROMPT` | Converts request into TOON execution plan | Context Building Flow |
| `UPDATE_PLANNER_PROMPT` | Plans updates for existing codebase | Update/Follow-up Flow |
| `GITHUB_IMPORT_CONTEXT_PROMPT` | Analyzes imported GitHub repos | GitHub Import Initial |
| `GITHUB_IMPORT_UPDATE_PROMPT` | Plans updates for imported repos | GitHub Import Follow-up |
| `PROJECT_METADATA_PROMPT` | Generates project name & summary | Metadata Generation |

### 1.2 System Prompt Generator
**File:** `/backend/src/brain/systemPrompt.ts`

Exports 4 key functions:

```typescript
getSystemPrompt(config)           → System prompt for agent execution
getPlanModePrompt(config)         → System prompt for plan mode (read-only)
getGitHubImportPrompt(repoCtx)    → System prompt for GitHub imports
FOLLOWUP_MODE_RULES               → Rules appended for follow-up tasks
```

**Prompt Registry (Line 6-9):**
```
FRAMEWORK_TEMPLATES = {
  "Next.js": "ai-agents-node-next",
  "github-import": process.env.E2B_HYBRID_IMPORT_TEMPLATE_ID
}
```

---

## 2. AGENT EXECUTION FLOW

### 2.1 Main Agent Runner
**File:** `/backend/src/brain/agentRunner.ts`

#### System Prompt Injection (Lines 993-1016):

```
┌─────────────────────────────────────────┐
│ AgentRunnerContext                      │
│ - workspaceId, sandboxId, todoId        │
│ - framework, templateId, projectIdea    │
│ - provider, planMode, isFollowUp        │
└──────────────────────────────────────────┘
           ↓
    [planMode check]
           ↓
┌──────────────────────────────────────────┐
│ if planMode:                             │
│   → getPlanModePrompt() [READ-ONLY]      │
├──────────────────────────────────────────┤
│ else:                                    │
│   → getSystemPrompt() [EXECUTION]        │
├──────────────────────────────────────────┤
│ if isFollowUp (prior SUCCESS):           │
│   → append FOLLOWUP_MODE_RULES           │
└──────────────────────────────────────────┘
           ↓
    [buildMemoryBlock]
           ↓
┌──────────────────────────────────────────┐
│ systemPrompt = basePrompt                │
│             + memoryBlock                │
└──────────────────────────────────────────┘
```

**Key Line:** 996-997
```typescript
const baseSystemPrompt =
  overrideSystemPrompt ??
  (planMode
    ? getPlanModePrompt({ framework, idea: projectIdea })
    : getSystemPrompt({ framework, templateId, idea: projectIdea }));
```

**Follow-up Detection (Line 990):**
```typescript
const isFollowUp = !planMode && recentRuns.some(r => r.status === 'SUCCESS');
```

#### LLM Client Initialization (Lines 1054-1088):
- Resolves provider (OpenAI/Anthropic/Qwen/Groq)
- Creates LLM client
- Builds message arrays based on client type
  - **OpenAI clients:** `buildOpenAIMessages()` (Line 319)
  - **Anthropic clients:** `buildAnthropicMessages()` (Line 409)

#### Iteration Loop (Line 1100+):
```
MAX_ITERATIONS = 20
TOKEN_LIMIT = 100,000
```

---

### 2.2 Provider Integration

#### OpenAI Provider
**File:** `/backend/src/brain/providers/openai.ts`

**analyzeIntent()** (Line 67-132):
- Injects: `INTENT_SYSTEM_PROMPT`
- Returns: `IntentResult` (fullIntent + questions OR contextPayload)

**buildContext()** (Line 134-156):
- Injects: `CONTEXT_BUILDER_PROMPT` (normal) OR `GITHUB_IMPORT_CONTEXT_PROMPT` (github-import)
- Returns: TOON plan string

**planUpdate()** (Line 158-180):
- Injects: `UPDATE_PLANNER_PROMPT` (normal) OR `GITHUB_IMPORT_UPDATE_PROMPT` (github-import)
- Returns: Updated TOON plan

**generateProjectMetadata()** (Line 182+):
- Injects: `PROJECT_METADATA_PROMPT`
- Returns: { name, summary }

#### Anthropic Provider
**File:** `/backend/src/brain/providers/anthropic.ts`

Same methods as OpenAI, wrapping prompts in system messages for Anthropic format.

#### Groq Provider
**File:** `/backend/src/brain/providers/groq.ts`

Same methods as OpenAI (OpenAI-compatible API).

---

## 3. SUB-AGENT FLOWS

### 3.1 Orchestrator Runner
**File:** `/backend/src/brain/agents/orchestratorRunner.ts`

**Internal Prompts (Lines 147-395):**

| Prompt | Purpose | Injection Point |
|---|---|---|
| `CLASSIFIER_PROMPT` (L147) | Routes tasks to sub-agents | Line 212 |
| `RESEARCH_GOAL_PROMPT` (L261) | Generates research sub-task | Line 383 |
| `FILE_GOAL_PROMPT` (L317) | Generates file modification sub-task | Line 395 |

**Flow:**
```
Task Description (600 chars)
    ↓
classifyTaskIntent()
    ├→ CLASSIFIER_PROMPT → Intent type
    └→ generateSubGoal() → RESEARCH_GOAL_PROMPT OR FILE_GOAL_PROMPT
```

### 3.2 Researcher Agent
**File:** `/backend/src/brain/agents/researcherAgent.ts`

Executes deep research on a focused query. Tracks token usage in response.

### 3.3 File Agent
**File:** `/backend/src/brain/agents/fileAgent.ts`

Handles file reads, modifications, and writes within the sandbox.

### 3.4 Synthesis Node
**File:** `/backend/src/brain/agents/synthesisNode.ts`

Combines results from multiple agents into coherent output.

---

## 4. LOOP ITERATION & PROMPT REFRESH

### 4.1 Main Iteration Loop Pattern
**Location:** `agentRunner.ts` (Lines 1100+)

```typescript
for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  // 1. Emit current iteration state
  emit("ITERATION_START", `Wave ${iteration + 1}/${MAX_ITERATIONS}`)
  
  // 2. Smart Memory Retrieval
  if (iteration === 0) {
    systemPrompt = staticBlock + basePrompt  // Initial
  } else {
    const relevantMemory = await retrieveRelevantMemory(...)
    systemPrompt = basePrompt + relevantMemory  // Refreshed per iteration
  }
  
  // 3. LLM Invocation
  const response = await callLLM({
    systemPrompt,  // INJECTED HERE
    messages: [...prior messages + user input],
    tools: activeToolSchemas
  })
  
  // 4. Tool Execution
  for (const toolCall of response.tool_calls) {
    result = await executeSkill(toolCall)
    append({role: "tool", content: result})
  }
  
  // 5. Iteration Check
  if (response.finishReason === "stop") break
  if (estimateTokens(messages) > TOKEN_LIMIT) break
}
```

### 4.2 Prompt Injection Points Per Iteration

| Iteration Stage | Prompt Injected | Source |
|---|---|---|
| **Initial** | basePrompt + staticBlock | systemPrompt.ts + buildMemoryBlock() |
| **Per Loop** | basePrompt + freshMemory | systemPrompt.ts + memoryRetriever.ts |
| **After Tool** | None (message-only) | N/A |
| **Follow-up** | basePrompt + FOLLOWUP_MODE_RULES | systemPrompt.ts + FOLLOWUP_MODE_RULES |

---

## 5. MESSAGE ARCHITECTURE

### 5.1 OpenAI Message Format
**Builder:** `buildOpenAIMessages()` (Line 319-399)

```typescript
[
  { role: "system", content: systemPrompt },  // INJECTED
  { role: "user", content: userMessage },
  { role: "assistant", content: "...", tool_calls: [...] },
  { role: "tool", tool_call_id: "...", content: "result" },
  ...
]
```

### 5.2 Anthropic Message Format
**Builder:** `buildAnthropicMessages()` (Line 409-498)

```typescript
{
  system: systemPrompt,  // INJECTED
  messages: [
    { role: "user", content: "..." },
    { role: "assistant", content: [{type: "tool_use", id, name, input}] },
    { role: "user", content: [{type: "tool_result", tool_use_id, content}] },
    ...
  ]
}
```

---

## 6. CONTEXT BUILDING FLOW

### 6.1 Intent Analysis
```
User Input + Images
    ↓
provider.analyzeIntent()
    ├─ Injects: INTENT_SYSTEM_PROMPT
    ├─ Checks: fullIntent (T/F)
    └─ Returns: {fullIntent, questions} OR {fullIntent, contextPayload}
```

### 6.2 Context Generation
```
User Answers + Framework Choice
    ↓
provider.buildContext()
    ├─ Injects: CONTEXT_BUILDER_PROMPT (or GITHUB_IMPORT_CONTEXT_PROMPT)
    ├─ Format: TOON (TYPE READY/UPDATE/IMPORT)
    └─ Stores: AI Agents.md in workspace
```

### 6.3 Follow-up Planning
```
Existing AI Agents.md + New User Request
    ↓
provider.planUpdate()
    ├─ Injects: UPDATE_PLANNER_PROMPT (or GITHUB_IMPORT_UPDATE_PROMPT)
    ├─ Format: TOON (TYPE UPDATE/IMPORT_UPDATE)
    └─ Returns: New TODOs to execute
```

---

## 7. PLAN MODE (READ-ONLY)

### 7.1 Plan Mode Prompt
**Location:** `systemPrompt.ts` (Line 277-324)

```typescript
getPlanModePrompt(config) → Returns specialized prompt with:
  - Restricted tool schemas (PLAN_MODE_TOOLS)
  - Exploration phase (MAX 15 tool calls)
  - Question phase (submit_plan_questions)
  - Plan writing phase (edit plan.md only)
```

### 7.2 Tool Restriction (Line 1036-1045)
```typescript
const PLAN_MODE_TOOLS = [
  "read_file",
  "search_code",
  "execute_shell",    // read-only
  "edit_file",        // restricted to plan.md
  "submit_plan_questions"
];
```

---

## 8. MEMORY INJECTION

### 8.1 Static Memory Block
**Builder:** `buildMemoryBlock()` (imported from `/backend/src/memory/buildMemoryBlock.ts`)

```
Called once at start of run
    ↓
Includes: Recent runs + workspace memory context
    ↓
Appended to: baseSystemPrompt
    ↓
Size: Logged in console
```

### 8.2 Dynamic Memory Retrieval
**Retriever:** `retrieveRelevantMemory()` (imported from `/backend/src/memory/memoryRetriever.ts`)

```
Called per iteration (after first)
    ↓
Queries: Supermemory agent for relevant context
    ↓
Appended to: baseSystemPrompt for that iteration
    ↓
Updates: systemPrompt variable
```

### 8.3 Supermemory Integration
**File:** `/backend/src/memory/supermemoryAgent.ts`

Key functions:
- `buildSupermemoryProfileQuery()` — Query builder
- `fetchProfileContextBlock()` — Fetches user profile memory
- `fetchMidWaveContext()` — Fetches in-run hints
- `fetchErrorFixHint()` — Error-specific guidance
- `fetchPredictiveHints()` — Proactive suggestions
- `createRunFactMemories()` — Stores new facts discovered in run
- `ingestTodoCompletion()` — Learns from completed tasks

---

## 9. GUARDRAILS & RULE INJECTION

### 9.1 Guardrail Files
- **preToolJudge.ts:** Pre-execution tool validation
- **toolExecutionGuard.ts:** Runtime execution guard
- **devServerRegistry.ts:** Dev server state management

### 9.2 FOLLOWUP_MODE_RULES
**Location:** `systemPrompt.ts` (Line 591-616)

Injected when `isFollowUp === true`:
```
Rules for:
- File editing (edit vs overwrite)
- Targeted edit pattern
- Minimal reading/searching
- Bias toward writing
```

---

## 10. PROVIDER RESOLUTION

### 10.1 Provider Selection Flow
**Location:** `/backend/src/services/providerResolver.ts`

```
Priority: Azure > User DB > Environment

Resolved Provider → createLLMClient()
    ↓
Returns: {kind, client, meta: {provider, source}}
```

### 10.2 Model Selection
**Location:** `/backend/src/brain/modelSelector.ts`

```
getModelConfigForAgent(provider, tier, usage)
    ↓
Returns: {model, maxTokens, costMultiplier}
```

---

## 11. PROMPT FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ USER INPUT                                                      │
│ (Idea + Framework Choice)                                      │
└────────────────────────────┬──────────────────────────────────┘
                             ↓
            ┌────────────────────────────────┐
            │ INTENT ANALYSIS                │
            │ Prompt: INTENT_SYSTEM_PROMPT   │
            │ Provider: OpenAI/Groq/Anthropic│
            └────────────────────────────────┘
                             ↓
            ┌─────────────────────────────────────┐
            │ CONTEXT BUILDING                    │
            │ Prompt: CONTEXT_BUILDER_PROMPT      │
            │ Output: TOON plan (AI Agents.md)   │
            └─────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ MAIN AGENT EXECUTION LOOP                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Iteration 0:                                                  │
│    systemPrompt = getSystemPrompt() + buildMemoryBlock()      │
│                                                                 │
│  Iteration 1...N:                                              │
│    systemPrompt = getSystemPrompt() + retrieveRelevantMemory()│
│                                                                 │
│  Message Array:                                                │
│    [{role: "system", content: systemPrompt},                  │
│     {role: "user", content: userMessage},                     │
│     ... prior messages ...]                                    │
│                                                                 │
│  LLM Call:                                                      │
│    response = llm.chat.completions.create({                   │
│      system: systemPrompt,  ← INJECTED HERE                   │
│      messages,                                                 │
│      tools: activeToolSchemas                                 │
│    })                                                          │
│                                                                 │
│  Tool Execution:                                               │
│    for toolCall in response.tool_calls:                       │
│      result = executeSkill(toolCall)                          │
│      append({role: "tool", content: result})                  │
│                                                                 │
│  Continue until: finishReason="stop" OR tokens > 100k         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                             ↓
            ┌────────────────────────────────┐
            │ FOLLOW-UP (if isFollowUp)      │
            │ Append: FOLLOWUP_MODE_RULES    │
            │ Prompt: UPDATE_PLANNER_PROMPT  │
            └────────────────────────────────┘
```

---

## 12. FILE LOCATION REFERENCE TABLE

| Flow Stage | File | Key Function | Line(s) |
|---|---|---|---|
| **Prompt Definitions** | `prompts.ts` | Prompt constants | 1-291 |
| **System Prompt Generator** | `systemPrompt.ts` | getSystemPrompt, getPlanModePrompt | 250-325 |
| **Main Agent** | `agentRunner.ts` | runAgentForTodo | 993-1200+ |
| **Intent Analysis** | `providers/openai.ts` | analyzeIntent | 67-132 |
| **Context Building** | `providers/openai.ts` | buildContext | 134-156 |
| **Update Planning** | `providers/openai.ts` | planUpdate | 158-180 |
| **Message Building (OpenAI)** | `agentRunner.ts` | buildOpenAIMessages | 319-399 |
| **Message Building (Anthropic)** | `agentRunner.ts` | buildAnthropicMessages | 409-498 |
| **Orchestrator** | `agents/orchestratorRunner.ts` | classifyTaskIntent | 147-395 |
| **Memory Retrieval** | `memory/memoryRetriever.ts` | retrieveRelevantMemory | - |
| **Memory Building** | `memory/buildMemoryBlock.ts` | buildMemoryBlock | - |
| **Provider Resolution** | `services/providerResolver.ts` | resolveProvider | - |
| **Context Builder (Sync)** | `context/contextBuilder.ts` | build | 27-46 |

---

## 13. PROMPT INJECTION CHECKLIST

### Initial Setup Injection
- [ ] `INTENT_SYSTEM_PROMPT` injected in `analyzeIntent()`
- [ ] `CONTEXT_BUILDER_PROMPT` injected in `buildContext()`
- [ ] System prompt built in `getSystemPrompt()` or `getPlanModePrompt()`
- [ ] Memory block built and injected

### Per-Iteration Injection
- [ ] `systemPrompt` variable refreshed with new memory
- [ ] Message array built with `buildOpenAIMessages()` or `buildAnthropicMessages()`
- [ ] LLM invoked with system prompt as first message

### Follow-up Injection
- [ ] `isFollowUp` detected from prior runs
- [ ] `FOLLOWUP_MODE_RULES` appended to base prompt
- [ ] `UPDATE_PLANNER_PROMPT` used if planning updates

### Plan Mode Injection
- [ ] `planMode` flag checked early
- [ ] `getPlanModePrompt()` called instead of `getSystemPrompt()`
- [ ] Tool schemas restricted to `PLAN_MODE_TOOLS`
- [ ] Exploration phase limited to 15 calls

---

## 14. DEBUGGING PROMPT FLOW

### Enable Logging
```typescript
console.log(`[AgentRunner] systemPrompt injected (${systemPrompt.length} chars)`);
console.log(`[AgentRunner] Memory block injected (${staticBlock.length} chars)`);
console.log(`[AgentRunner] Iteration ${iteration}: tokens=${estimateTokens(messages)}`);
```

### Trace Prompt Changes
1. Check `agentRunner.ts:1016` for initial systemPrompt assembly
2. Check per-iteration loop for memory refresh
3. Inspect message array before LLM call
4. Verify provider handles system prompts correctly

### Common Issues
- **Empty systemPrompt:** Check memory block builder
- **Prompt truncation:** Check TOKEN_LIMIT (100k)
- **Wrong prompt injected:** Verify framework/templateId passed to getSystemPrompt
- **Follow-up rules missing:** Verify isFollowUp detection logic

---

## 15. SUMMARY OF INJECTION POINTS

| Injection Point | Source | Trigger | Impact |
|---|---|---|---|
| `analyzeIntent()` | INTENT_SYSTEM_PROMPT | User submits idea | Determines fullIntent |
| `buildContext()` | CONTEXT_BUILDER_PROMPT | Intent fullIntent=true | Generates TOON plan |
| `getSystemPrompt()` | systemPrompt.ts | runAgentForTodo start | Controls agent behavior |
| `getPlanModePrompt()` | systemPrompt.ts | planMode=true | Restricts to read-only |
| Memory block | buildMemoryBlock() | Initial iteration | Contextualizes with history |
| Relevant memory | retrieveRelevantMemory() | Per iteration | Updates context dynamically |
| FOLLOWUP_MODE_RULES | systemPrompt.ts | isFollowUp=true | Enforces surgical edits |
| Message system role | buildOpenAIMessages() | Before LLM call | Communicates instructions |
| Sub-agent prompts | orchestratorRunner.ts | Task classification | Routes to sub-agents |

---

## 16. NEXT STEPS FOR ENHANCEMENT

1. **Centralized Prompt Registry** — Move all prompts to injectable config
2. **Dynamic Prompt Selection** — Route prompts based on task type
3. **Prompt Versioning** — Track prompt changes per run
4. **A/B Testing Framework** — Compare prompt variants
5. **Audit Trail** — Log all injected prompts for debugging
6. **Prompt Composition** — Build prompts from modular blocks
7. **Language Detection** — Auto-select prompts per language guardrails
