# PrettiFlow Prompt Injection Quick Reference

## File Locations Map

```
backend/src/
├── brain/
│   ├── prompts.ts                 ← ALL PROMPT DEFINITIONS
│   │   ├── INTENT_SYSTEM_PROMPT
│   │   ├── CONTEXT_BUILDER_PROMPT
│   │   ├── UPDATE_PLANNER_PROMPT
│   │   ├── GITHUB_IMPORT_CONTEXT_PROMPT
│   │   ├── GITHUB_IMPORT_UPDATE_PROMPT
│   │   └── PROJECT_METADATA_PROMPT
│   │
│   ├── systemPrompt.ts            ← SYSTEM PROMPT GENERATION
│   │   ├── getSystemPrompt()      → Returns base + rules for execution
│   │   ├── getPlanModePrompt()    → Returns restricted prompt (read-only)
│   │   ├── getGitHubImportPrompt()→ Returns GitHub import-specific prompt
│   │   ├── FOLLOWUP_MODE_RULES    → Appended for follow-up tasks
│   │   └── FRAMEWORK_TEMPLATES    → Maps framework to template ID
│   │
│   ├── agentRunner.ts             ← MAIN EXECUTION LOOP
│   │   ├── runAgentForTodo()      → Main loop (Lines 960-1200+)
│   │   │   ├── Line 993-1003: baseSystemPrompt assembly
│   │   │   ├── Line 1006-1016: Final systemPrompt with memory
│   │   │   ├── Line 1036-1045: Tool schema filtering (plan mode)
│   │   │   └── Line 1100+: Main iteration loop
│   │   │
│   │   ├── buildOpenAIMessages()  → OpenAI format (system role)
│   │   └── buildAnthropicMessages() → Anthropic format (system param)
│   │
│   ├── providers/
│   │   ├── openai.ts              ← OpenAI INJECTION POINTS
│   │   │   ├── analyzeIntent()    → Injects INTENT_SYSTEM_PROMPT
│   │   │   ├── buildContext()     → Injects CONTEXT_BUILDER_PROMPT
│   │   │   └── planUpdate()       → Injects UPDATE_PLANNER_PROMPT
│   │   │
│   │   ├── anthropic.ts           ← Anthropic (same structure)
│   │   └── groq.ts                ← Groq (same structure)
│   │
│   └── agents/
│       ├── orchestratorRunner.ts  ← SUB-AGENT PROMPTS
│       │   ├── CLASSIFIER_PROMPT      (Line 147)
│       │   ├── RESEARCH_GOAL_PROMPT   (Line 261)
│       │   └── FILE_GOAL_PROMPT       (Line 317)
│       │
│       ├── researcherAgent.ts
│       ├── fileAgent.ts
│       └── synthesisNode.ts
│
├── memory/
│   ├── buildMemoryBlock.ts        ← STATIC MEMORY INJECTION
│   ├── memoryRetriever.ts         ← DYNAMIC MEMORY PER ITERATION
│   ├── supermemoryAgent.ts        ← Supermemory queries
│   └── conversationSummarizer.ts
│
├── context/
│   └── contextBuilder.ts          ← BUILDS Prettiflow.md
│
└── services/
    └── providerResolver.ts        ← PROVIDER SELECTION
```

---

## Prompt Flow Chain

### PHASE 1: Intent & Context
```
USER INPUT
  ↓
analyzeIntent() [providers/openai.ts:67]
  Injects: INTENT_SYSTEM_PROMPT
  ↓
  ├─ fullIntent = false → Ask questions
  └─ fullIntent = true → Continue to Phase 2

buildContext() [providers/openai.ts:134]
  Injects: CONTEXT_BUILDER_PROMPT
  Output: TOON plan → Prettiflow.md
```

### PHASE 2: Agent Execution
```
runAgentForTodo() [agentRunner.ts:960]
  
  Line 993-1003: Build baseSystemPrompt
    if planMode:
      → getPlanModePrompt() [systemPrompt.ts:277]
    else:
      → getSystemPrompt() [systemPrompt.ts:250]
  
  Line 1006-1016: Add memory
    → buildMemoryBlock() + systemPrompt
    OR
    → staticBlock + systemPrompt

  Line 1036-1045: Restrict tools (if plan mode)
    activeToolSchemas = [read_file, search_code, execute_shell, edit_file, submit_plan_questions]

  Line 1100+: Iteration Loop
    FOR iteration 0 to 20:
      1. Emit iteration start
      2. If iteration > 0: Refresh memory
      3. Build message array with systemPrompt
      4. Call LLM with injected systemPrompt
      5. Execute tools, append tool result
      6. Continue if response.finishReason !== "stop"

  Message Array Structure:
    [{role: "system", content: systemPrompt},    ← INJECTED
     {role: "user", content: userMessage},
     {role: "assistant", content: "...", tool_calls: [...]},
     {role: "tool", tool_call_id: "...", content: result},
     ...]
```

### PHASE 3: Follow-up (if applicable)
```
isFollowUp = recentRuns.some(r => r.status === 'SUCCESS')
  if true:
    → Append FOLLOWUP_MODE_RULES to baseSystemPrompt
    → Load persisted ports
    → Enforce surgical edits (edit_file replace, not overwrite)

planUpdate() [providers/openai.ts:158]
  Injects: UPDATE_PLANNER_PROMPT
  Output: New TODOs (TYPE UPDATE)
```

---

## Prompt Injection Sequence

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: PROMPT SELECTION                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  if overrideSystemPrompt:                                  │
│    → use it                                                │
│  elif planMode:                                            │
│    → getPlanModePrompt() + framework + idea               │
│  else:                                                     │
│    → getSystemPrompt() + framework + templateId + idea    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: RULE INJECTION                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  if isFollowUp (prior SUCCESS):                            │
│    basePrompt += FOLLOWUP_MODE_RULES                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: MEMORY INJECTION                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  staticBlock = buildMemoryBlock(recentRuns, workspace)     │
│                                                             │
│  if staticBlock:                                           │
│    systemPrompt = basePrompt + staticBlock                 │
│  else:                                                     │
│    systemPrompt = basePrompt                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 4: PROVIDER SETUP                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  createLLMClient({provider, userId, workspaceId})          │
│    → resolveProvider() → priority: Azure > User > Env      │
│    → Returns: OpenAI OR Anthropic client                   │
│                                                             │
│  if OpenAI:                                                │
│    activeToolSchemas = TOOL_SCHEMAS                        │
│  elif Anthropic:                                           │
│    activeToolSchemas = TOOL_SCHEMAS.map(convertToAnthro)  │
│                                                             │
│  if planMode:                                              │
│    activeToolSchemas = filter(PLAN_MODE_TOOLS)             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 5: ITERATION LOOP                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  FOR iteration in 0..MAX_ITERATIONS:                       │
│                                                             │
│    a) Memory Refresh (if iteration > 0):                   │
│       newMemory = retrieveRelevantMemory(task, context)   │
│       systemPrompt = basePrompt + newMemory                │
│                                                             │
│    b) Message Building:                                    │
│       messages = []                                        │
│       messages.push({role: "system", content: systemPrompt})
│       messages.push({role: "user", content: userMsg})      │
│       messages.push(...priorMessages)                      │
│                                                             │
│    c) LLM Call:                                            │
│       response = llm.chat.completions.create({             │
│         system: systemPrompt,   ← INJECTED HERE            │
│         messages,                                          │
│         tools: activeToolSchemas,                          │
│         max_tokens: ...                                    │
│       })                                                   │
│                                                             │
│    d) Tool Execution:                                      │
│       for call in response.tool_calls:                     │
│         result = executeSkill(call)                        │
│         messages.push({                                    │
│           role: "tool",                                    │
│           tool_call_id: call.id,                           │
│           content: result                                  │
│         })                                                 │
│                                                             │
│    e) Continue Check:                                      │
│       if response.finishReason === "stop": BREAK           │
│       if tokenCount > TOKEN_LIMIT: BREAK                   │
│       if iteration >= MAX_ITERATIONS: BREAK                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Prompt Injection by Provider

### OpenAI / Groq
```typescript
// analyzeIntent injection
await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: INTENT_SYSTEM_PROMPT },  ← INJECTED
    { role: "user", content: userMessage }
  ],
  response_format: { type: "json_object" }
})

// buildContext injection
await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: CONTEXT_BUILDER_PROMPT },  ← INJECTED
    { role: "user", content: userMessage }
  ]
})

// Main agent iteration
await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: systemPrompt },  ← INJECTED
    { role: "user", content: userMessage },
    ... prior messages ...
  ],
  tools: activeToolSchemas
})
```

### Anthropic
```typescript
// System message separated from messages
const { system, messages } = buildAnthropicMessages(dbMessages)

await client.messages.create({
  system: systemPrompt,  ← INJECTED (separate param)
  messages,
  tools: activeAnthropicTools
})
```

---

## Memory Injection Timeline

```
INITIALIZATION (Once per run)
├─ Load: recentRuns, workspaceMemory
├─ Build: staticMemoryInput
└─ Generate: staticBlock = buildMemoryBlock(staticMemoryInput)
    └─ Append to: systemPrompt (Line 1016)

ITERATION 0 (First loop)
├─ Use: staticBlock (already in systemPrompt)
└─ No refresh

ITERATION 1..N (Subsequent loops)
├─ Fetch: retrieveRelevantMemory(task, priorContext)
├─ Refresh: systemPrompt = basePrompt + newMemory
└─ Inject into message array
```

---

## Tool Schema Filtering (Plan Mode)

```
PLAN_MODE_TOOLS = [
  "read_file",                    ← Read existing files
  "search_code",                  ← Find code patterns
  "execute_shell",                ← Run read-only commands
  "edit_file",                    ← Write to plan.md ONLY
  "submit_plan_questions"         ← Ask user questions
]

activeToolSchemas = if planMode
  ? TOOL_SCHEMAS.filter(t => PLAN_MODE_TOOLS.includes(t.name))
  : TOOL_SCHEMAS.filter(t => t.name !== "submit_plan_questions")
```

---

## Frame Detection & Template Selection

```
Framework: "Next.js"
  ↓
hasTemplate("Next.js") → true
  ↓
getSystemPrompt({
  framework: "Next.js",
  templateId: "prettiflow-node-next",
  idea: projectIdea
})
  ↓
Returns: PREBUILT_NEXTJS_PROMPT + PROJECT_GOAL

For other frameworks:
  → Returns: FALLBACK_PROMPT (generic)
```

---

## Debugging Commands

### View System Prompt
```typescript
// Add in agentRunner.ts:1016
console.log("=== SYSTEM PROMPT ===");
console.log(systemPrompt);
console.log("=== END SYSTEM PROMPT ===");
```

### View Message Array Before LLM Call
```typescript
// Before llm call
console.log("=== MESSAGES ===");
console.log(JSON.stringify(messages, null, 2));
console.log("=== END MESSAGES ===");
```

### Track Memory Refresh
```typescript
// In iteration loop
console.log(`[Iteration ${iteration}] Memory refresh:`, {
  hasNewMemory: !!newMemory,
  memoryLength: newMemory?.length ?? 0,
  totalPromptLength: systemPrompt.length
});
```

### Monitor Token Usage
```typescript
// Before/after LLM call
const tokens = estimateTokens(messages);
console.log(`[Iteration ${iteration}] Token usage: ${tokens}/${TOKEN_LIMIT}`);
```

---

## Common Prompt Modifications

### Add Custom Rules to All Agents
```typescript
// systemPrompt.ts
const CUSTOM_RULES = `
## Custom Rules
- Rule 1
- Rule 2
`;

export function getSystemPrompt(config) {
  const base = config.planMode ? ... : ...;
  return base + "\n\n" + CUSTOM_RULES;
}
```

### Override System Prompt Per Workspace
```typescript
// agentRunner.ts:993-994
const baseSystemPrompt = 
  workspaceOverrides?.[workspaceId] ??  // Check overrides
  overrideSystemPrompt ??
  (planMode ? getPlanModePrompt(...) : getSystemPrompt(...));
```

### Add Dynamic Context to Prompts
```typescript
// systemPrompt.ts:250
export function getSystemPrompt(config) {
  const base = ... ;
  const dynamicContext = `
## Detected Stack
- Framework: ${config.framework}
- Template: ${config.templateId || 'none'}
- Goal: ${config.idea}
  `;
  return base + dynamicContext;
}
```

---

## Summary Table

| What | Where | How | When |
|---|---|---|---|
| **Define prompts** | `prompts.ts` | Export constants | Build-time |
| **Generate system prompt** | `systemPrompt.ts` | getSystemPrompt() | Run start |
| **Inject intent prompt** | `providers/openai.ts:85` | analyzeIntent() | Idea submission |
| **Inject context prompt** | `providers/openai.ts:144` | buildContext() | After intent |
| **Inject system prompt** | `agentRunner.ts:1016` | buildOpenAIMessages() | Each iteration |
| **Refresh memory** | `agentRunner.ts:1100+` | retrieveRelevantMemory() | Per iteration (after 0) |
| **Append follow-up rules** | `agentRunner.ts:1001-1003` | Conditional append | If isFollowUp |
| **Restrict plan tools** | `agentRunner.ts:1043-1045` | Filter TOOL_SCHEMAS | If planMode |
