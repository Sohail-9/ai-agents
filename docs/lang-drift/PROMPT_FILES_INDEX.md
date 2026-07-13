# AI Agents Prompt Injection Files Index

Complete reference of all files involved in prompt definition and injection with specific line numbers.

---

## 1. PRIMARY PROMPT FILES

### 1.1 Core Prompt Definitions
**File:** `backend/src/brain/prompts.ts`

| Line(s) | Constant | Type | Used By |
|---|---|---|---|
| 1-75 | `INTENT_SYSTEM_PROMPT` | System Prompt | Intent analysis in all providers |
| 77-167 | `CONTEXT_BUILDER_PROMPT` | System Prompt | Context building (normal mode) |
| 169-216 | `UPDATE_PLANNER_PROMPT` | System Prompt | Follow-up planning (normal mode) |
| 218-260 | `GITHUB_IMPORT_CONTEXT_PROMPT` | System Prompt | Context building (GitHub import) |
| 262-287 | `GITHUB_IMPORT_UPDATE_PROMPT` | System Prompt | Follow-up planning (GitHub import) |
| 289 | `PROJECT_METADATA_PROMPT` | System Prompt | Metadata generation |
| 291 | `COMMIT_MESSAGE_PROMPT` | System Prompt | Git commit generation |

**Key Rules in Prompts:**
- INTENT_SYSTEM_PROMPT:
  - Lines 3-8: Critical rules for intent detection
  - Lines 9-16: Handling vague vs clear queries
  - Lines 61-73: TODO granularity rules
  - Lines 74-75: PRIMARY ROUTE RULE

- CONTEXT_BUILDER_PROMPT:
  - Lines 106-166: Comprehensive todo rules (DEPS, granularity, localStorage, styling)
  - Lines 137-166: Environment and styling rules

---

### 1.2 System Prompt Generator & Manager
**File:** `backend/src/brain/systemPrompt.ts`

| Line(s) | Content | Purpose |
|---|---|---|
| 6-9 | `FRAMEWORK_TEMPLATES` | Maps framework to template ID |
| 11 | `hasTemplate()` | Boolean check for template availability |
| 15 | `getTemplateId()` | Retrieves template ID for framework |
| 20 | `SKILLS_BLOCK` | Generates skills markdown from metadata |
| 23-97 | `SHARED_RULES` | Common rules for all templates |
| 100-180 | `PREBUILT_NEXTJS_PROMPT` | Next.js pre-built template prompt |
| 183-236 | `FALLBACK_PROMPT` | Generic fallback for unknown frameworks |
| 240-244 | `SystemPromptConfig` | Interface for config |
| 250-265 | `getSystemPrompt()` | **MAIN FUNCTION** - Returns system prompt |
| 267-271 | `PlanModePromptConfig` | Interface for plan config |
| 277-325 | `getPlanModePrompt()` | Returns read-only plan mode prompt |
| 327-528 | `getGitHubImportPrompt()` | GitHub import-specific prompt |
| 530-584 | `INTENT_DETECTION_PROMPT` | Intent detection schema |
| 591-616 | `FOLLOWUP_MODE_RULES` | Rules appended for follow-up tasks |

**Critical Functions:**
- Line 250: `getSystemPrompt(config)` — Main entry point
  - Line 259: Template check logic
  - Returns either PREBUILT_NEXTJS_PROMPT or FALLBACK_PROMPT

- Line 277: `getPlanModePrompt(config)` — Plan mode prompt
  - Lines 290-325: Detailed workflow with phases
  - Restricts tools to read-only set

---

## 2. AGENT EXECUTION FILES

### 2.1 Main Agent Runner
**File:** `backend/src/brain/agentRunner.ts`

| Line(s) | Function/Variable | Purpose | Injection Type |
|---|---|---|---|
| 4 | Import `getSystemPrompt`, `getPlanModePrompt` | Imports prompt generators | Setup |
| 76-91 | `AgentRunnerContext` | Context interface passed to runner | Setup |
| 150-202 | `createLLMClient()` | Creates OpenAI or Anthropic client | Setup |
| 249-268 | `estimateTokens()` | Token estimation function | Utility |
| 270-273 | `truncateOutput()` | Output truncation (6000 chars) | Utility |
| 319-399 | `buildOpenAIMessages()` | **OPENAI MESSAGE BUILDER** | OpenAI Format |
| 409-498 | `buildAnthropicMessages()` | **ANTHROPIC MESSAGE BUILDER** | Anthropic Format |
| 960-1200+ | `runAgentForTodo()` | **MAIN AGENT LOOP** | Core Logic |

**System Prompt Injection Points:**

| Line(s) | Code | Context |
|---|---|---|
| 993-997 | `baseSystemPrompt = overrideSystemPrompt ?? (planMode ? getPlanModePrompt(...) : getSystemPrompt(...))` | Initial prompt selection |
| 1001-1003 | `const basePrompt = isFollowUp ? baseSystemPrompt + FOLLOWUP_MODE_RULES : baseSystemPrompt` | Append follow-up rules |
| 1016 | `let systemPrompt = staticBlock ? basePrompt + staticBlock : basePrompt` | Initial systemPrompt assembly |
| 1043-1045 | `activeToolSchemas = planMode ? TOOL_SCHEMAS.filter(...) : TOOL_SCHEMAS.filter(...)` | Restrict tools |
| 1100+ | Loop iteration | Per-iteration memory refresh |

**Key Variables:**
- Line 41: `MAX_ITERATIONS = 20`
- Line 42: `TOKEN_LIMIT = 100_000`
- Line 209: `MAX_LLM_RETRIES = 3`

**Detection Logic:**
- Line 990: `isFollowUp = !planMode && recentRuns.some(r => r.status === 'SUCCESS')`

**Message Building (OpenAI):**
- Line 350: System message with `redactSensitive()`
- Line 352: Tool calls converted to OpenAI format

**Message Building (Anthropic):**
- Line 418: System message extracted separately
- Line 439: User messages without images
- Line 459: Tool use blocks created

---

### 2.2 Orchestrator (Sub-Agent Coordinator)
**File:** `backend/src/brain/agents/orchestratorRunner.ts`

| Line(s) | Prompt/Function | Purpose |
|---|---|---|
| 147-210 | `CLASSIFIER_PROMPT` | Task intent classifier |
| 200 | `classifyTaskIntent()` | Calls classifier |
| 212 | Prompt injection with `replace("{TASK}", ...)` | Task replacement |
| 261-315 | `RESEARCH_GOAL_PROMPT` | Research sub-task prompt |
| 317-355 | `FILE_GOAL_PROMPT` | File modification sub-task prompt |
| 358 | `makeRequest()` | Generic request wrapper |
| 383 | `makeRequest(RESEARCH_GOAL_PROMPT)` | Inject research prompt |
| 395 | `makeRequest(FILE_GOAL_PROMPT)` | Inject file prompt |

**Prompt Injection Pattern:**
```typescript
const prompt = CLASSIFIER_PROMPT.replace("{TASK}", taskDescription.slice(0, 600));
const response = await llm.chat.completions.create({
  messages: [{ role: "user", content: prompt }],
  ...
});
```

---

### 2.3 Researcher Agent
**File:** `backend/src/brain/agents/researcherAgent.ts`

- Focused research execution
- No custom prompts (uses generic system prompt)
- Tracks `promptTokens` in response (Line 172)

### 2.4 File Agent
**File:** `backend/src/brain/agents/fileAgent.ts`

- File read/write operations
- Uses framework sandbox context
- No custom prompts

### 2.5 Synthesis Node
**File:** `backend/src/brain/agents/synthesisNode.ts`

- Combines results from multiple agents
- Aggregation logic
- No custom prompts

---

## 3. LLM PROVIDER FILES

### 3.1 OpenAI Provider
**File:** `backend/src/brain/providers/openai.ts`

| Line(s) | Method | Prompt Injected | Injection Point |
|---|---|---|---|
| 6 | Import `INTENT_SYSTEM_PROMPT`, `CONTEXT_BUILDER_PROMPT` | Direct import | Top of file |
| 38 | `getClient()` | N/A | Client setup |
| 67-132 | `analyzeIntent()` | INTENT_SYSTEM_PROMPT | Line 85 |
| 85 | `{ role: "system", content: INTENT_SYSTEM_PROMPT }` | **INTENT INJECTION** | Initial intent detection |
| 110 | Qwen fallback `{ role: "system", content: INTENT_SYSTEM_PROMPT }` | **FALLBACK INJECTION** | If OpenAI fails |
| 134-156 | `buildContext()` | CONTEXT_BUILDER_PROMPT OR GITHUB_IMPORT_CONTEXT_PROMPT | Line 140, 144 |
| 140 | `const systemPrompt = mode === 'github-import' ? GITHUB_IMPORT_CONTEXT_PROMPT : CONTEXT_BUILDER_PROMPT` | **MODE-BASED SELECTION** | Context building |
| 144 | `{ role: "system", content: systemPrompt }` | **CONTEXT INJECTION** | Message array |
| 158-180 | `planUpdate()` | UPDATE_PLANNER_PROMPT OR GITHUB_IMPORT_UPDATE_PROMPT | Line 164, 168 |
| 164 | Mode-based selection like buildContext | **MODE-BASED SELECTION** | Update planning |
| 168 | `{ role: "system", content: systemPrompt }` | **UPDATE INJECTION** | Message array |
| 182+ | `generateProjectMetadata()` | PROJECT_METADATA_PROMPT | Line 189, 202+ |

**Key Patterns:**
- Fallback to Qwen if OpenAI fails (Line 98-122)
- Image support in user content (Lines 72-80)
- JSON response format for intent (Line 88)
- Error handling with fallback prompts

---

### 3.2 Anthropic Provider
**File:** `backend/src/brain/providers/anthropic.ts`

| Line(s) | Method | Prompt Injected | Format |
|---|---|---|---|
| 5 | Import `INTENT_SYSTEM_PROMPT`, `CONTEXT_BUILDER_PROMPT` | Direct import | Top of file |
| 60-85 | `analyzeIntent()` | INTENT_SYSTEM_PROMPT | System param |
| 65 | `system: INTENT_SYSTEM_PROMPT` | **INTENT INJECTION** | Anthropic format |
| 93-115 | `buildContext()` | CONTEXT_BUILDER_PROMPT OR GITHUB_IMPORT_CONTEXT_PROMPT | System param |
| 94-98 | Mode-based selection | **MODE-BASED SELECTION** | Context building |
| 105 | `system: systemPrompt` | **CONTEXT INJECTION** | Anthropic format |
| 117+ | `planUpdate()` | UPDATE_PLANNER_PROMPT OR GITHUB_IMPORT_UPDATE_PROMPT | System param |

**Key Differences from OpenAI:**
- System message as separate `system` parameter (not in messages array)
- Image support in messages array as `image` blocks
- Tool results as `tool_result` blocks in messages

---

### 3.3 Groq Provider
**File:** `backend/src/brain/providers/groq.ts`

| Line(s) | Method | Notes |
|---|---|---|
| 5 | Import `INTENT_SYSTEM_PROMPT`, `CONTEXT_BUILDER_PROMPT` | Same as OpenAI |
| 53 | `INTENT_SYSTEM_PROMPT` injection | Same pattern |
| 88 | `CONTEXT_BUILDER_PROMPT` injection | Mode-based like OpenAI |
| 116 | `UPDATE_PLANNER_PROMPT` injection | Same as OpenAI |

**Note:** Groq uses OpenAI-compatible API, so injection pattern identical to OpenAI provider.

---

## 4. MEMORY INJECTION FILES

### 4.1 Memory Block Builder
**File:** `backend/src/memory/buildMemoryBlock.ts`

- Purpose: Builds static memory block from recent runs and workspace memory
- Called at: `agentRunner.ts:1006`
- Appended to: systemPrompt (Line 1016 of agentRunner.ts)

### 4.2 Memory Retriever
**File:** `backend/src/memory/memoryRetriever.ts`

- Purpose: Dynamically retrieves relevant context per iteration
- Called at: Main iteration loop (agentRunner.ts:1100+)
- Refreshes: systemPrompt per iteration

### 4.3 Supermemory Agent
**File:** `backend/src/memory/supermemoryAgent.ts`

| Function | Purpose | Integration |
|---|---|---|
| `buildSupermemoryProfileQuery()` | Builds query from context | Memory retrieval |
| `fetchProfileContextBlock()` | Fetches user profile memory | User context |
| `fetchMidWaveContext()` | Mid-run context hints | Iteration-based |
| `fetchErrorFixHint()` | Error-specific guidance | Error recovery |
| `fetchPredictiveHints()` | Proactive suggestions | Optimization |
| `createRunFactMemories()` | Stores discovered facts | Learning |
| `isSupermemoryEnabled()` | Feature flag check | Conditional |

### 4.4 Conversation Summarizer
**File:** `backend/src/memory/conversationSummarizer.ts`

- `summarizeDroppedMessages()` — Summarizes trimmed messages
- `formatDigestAsMessage()` — Formats summary as message

---

## 5. CONTEXT & SETUP FILES

### 5.1 Context Builder (Sync)
**File:** `backend/src/context/contextBuilder.ts`

| Line(s) | Content | Purpose |
|---|---|---|
| 27-46 | `build(input: PollAnswers)` | Creates AI Agents.md template |
| 29-44 | String building | Project metadata formatting |

---

## 6. PROVIDER RESOLUTION FILES

### 6.1 Provider Resolver
**File:** `backend/src/services/providerResolver.ts`

- Resolves provider priority: Azure > User DB > Environment
- Called at: `agentRunner.ts:111-148`
- Returns: Provider name + API key + source

---

## 7. GUARDRAIL FILES

### 7.1 Pre-Tool Judge
**File:** `backend/src/guardrails/preToolJudge.ts`

- Validates tool calls before execution
- Prevents unsafe operations

### 7.2 Tool Execution Guard
**File:** `backend/src/guardrails/toolExecutionGuard.ts`

- Runtime execution guard
- Validates tool parameters

### 7.3 Dev Server Registry
**File:** `backend/src/guardrails/devServerRegistry.ts`

- Tracks dev server state
- Prevents multiple starts

---

## 8. TYPE & INTERFACE FILES

### 8.1 Brain Types
**File:** `backend/src/brain/types.ts`

| Type | Used By | Purpose |
|---|---|---|
| `AIProvider` | All providers | Interface for provider implementations |
| `IntentResult` | Intent analysis | Result of intent classification |
| `ImageRef` | Multimodal input | Image reference in prompts |

### 8.2 Agent Sub-Types
**File:** `backend/src/brain/agents/subAgentTypes.ts`

- Type definitions for sub-agents
- Task orchestration types

---

## 9. CONFIGURATION FILES

### 9.1 Tier Configuration
**File:** `backend/src/brain/tiers.ts`

- Defines Azure config access
- Called at: `createLLMClient()` (Line 164)

### 9.2 Model Selector
**File:** `backend/src/brain/modelSelector.ts`

- Selects model based on provider/tier
- Returns: ModelConfig {model, maxTokens, costMultiplier}

---

## 10. ENVIRONMENT FILES

### 10.1 Environment Setup
**File:** `backend/src/env.ts`

- Loads all environment variables
- Imported by providers

---

## 11. QUICK LOCATION TABLE

| What to Find | File | Lines | Function |
|---|---|---|---|
| All prompt text | `prompts.ts` | 1-291 | Constants |
| System prompt generation | `systemPrompt.ts` | 250, 277 | getSystemPrompt, getPlanModePrompt |
| Prompt injection (OpenAI) | `agentRunner.ts` + `providers/openai.ts` | 319-399, 67-180 | buildOpenAIMessages, analyzeIntent/buildContext |
| Prompt injection (Anthropic) | `agentRunner.ts` + `providers/anthropic.ts` | 409-498, 60-115 | buildAnthropicMessages, analyzeIntent/buildContext |
| Main agent loop | `agentRunner.ts` | 960-1200+ | runAgentForTodo |
| System prompt assembly | `agentRunner.ts` | 993-1016 | runAgentForTodo |
| Tool schema filtering | `agentRunner.ts` | 1036-1045 | runAgentForTodo |
| Message building (OpenAI) | `agentRunner.ts` | 319-399 | buildOpenAIMessages |
| Message building (Anthropic) | `agentRunner.ts` | 409-498 | buildAnthropicMessages |
| Token estimation | `agentRunner.ts` | 249-268 | estimateTokens |
| Memory injection | `agentRunner.ts` | 1006-1016 | runAgentForTodo |
| Sub-agent prompts | `orchestratorRunner.ts` | 147-395 | classifyTaskIntent, generateSubGoal |
| Provider setup | `agentRunner.ts` | 150-202 | createLLMClient |
| Intent analysis | `providers/openai.ts` | 67-132 | analyzeIntent |
| Context building | `providers/openai.ts` | 134-156 | buildContext |
| Plan updating | `providers/openai.ts` | 158-180 | planUpdate |
| Follow-up rules | `systemPrompt.ts` | 591-616 | FOLLOWUP_MODE_RULES |
| Plan mode rules | `systemPrompt.ts` | 277-325 | getPlanModePrompt |

---

## 12. INJECTION SEQUENCE BY FILE

### File A: prompts.ts
1. Define all prompt constants (1-291)
2. Exported for use in systemPrompt.ts and providers

### File B: systemPrompt.ts
1. Import prompt constants from prompts.ts
2. Generate system prompts using getSystemPrompt() or getPlanModePrompt()
3. Append FOLLOWUP_MODE_RULES if needed
4. Export final prompt text

### File C: agentRunner.ts
1. Import getSystemPrompt/getPlanModePrompt from systemPrompt.ts
2. Detect planMode and isFollowUp at start
3. Call getSystemPrompt() or getPlanModePrompt() (Line 996-997)
4. Build systemPrompt with memory (Line 1016)
5. Filter tool schemas if planMode (Line 1043-1045)
6. In iteration loop:
   - Refresh memory per iteration
   - Build message array with systemPrompt
   - Call LLM with injected systemPrompt
   - Execute tools and continue

### File D: providers/*.ts
1. Import prompt constants from prompts.ts
2. In analyzeIntent():
   - Inject INTENT_SYSTEM_PROMPT (Line 85/65/53)
3. In buildContext():
   - Select mode-based prompt (Line 140/94/88)
   - Inject selected prompt (Line 144/105)
4. In planUpdate():
   - Select mode-based prompt (Line 164)
   - Inject selected prompt (Line 168)

---

## 13. DEBUGGING CHECKLIST

- [ ] Check prompts.ts for prompt text
- [ ] Check systemPrompt.ts for generation logic
- [ ] Check agentRunner.ts:996-997 for initial selection
- [ ] Check agentRunner.ts:1016 for assembly with memory
- [ ] Check agentRunner.ts:319-399 (OpenAI) or 409-498 (Anthropic) for message building
- [ ] Check providers/openai.ts (or anthropic/groq) for injection points
- [ ] Check memory/buildMemoryBlock.ts for memory building
- [ ] Check memory/memoryRetriever.ts for per-iteration refresh
- [ ] Check agentRunner.ts:1100+ for iteration loop

---

## 14. PROMPT MODIFICATION GUIDE

To modify a prompt:

1. **Edit constant in prompts.ts** (lines 1-291)
   - Find the constant name (e.g., INTENT_SYSTEM_PROMPT)
   - Edit the string content
   - Line numbers will shift if content added/removed

2. **Add new prompt:**
   - Add constant to prompts.ts
   - Export it
   - Import in systemPrompt.ts or providers
   - Use in appropriate function

3. **Modify system prompt generation:**
   - Edit systemPrompt.ts functions
   - Check both PREBUILT_NEXTJS_PROMPT (Line 100-180) and FALLBACK_PROMPT (Line 183-236)
   - Test with both template and fallback scenarios

4. **Add provider-specific logic:**
   - Edit providers/openai.ts, anthropic.ts, or groq.ts
   - Modify analyzeIntent, buildContext, or planUpdate
   - Ensure all three providers are updated consistently

5. **Modify agent behavior:**
   - Edit systemPrompt.ts SHARED_RULES (Line 23-97)
   - This applies to all agents regardless of provider

6. **Add memory context:**
   - Modify buildMemoryBlock.ts to change static memory
   - Modify memoryRetriever.ts to change dynamic memory refresh
   - These affect systemPrompt composition

---

## 15. LINE NUMBER REFERENCE (Updated)

Correct as of analysis snapshot. Line numbers may shift with code changes.

**Critical Files by Line Count:**
- `agentRunner.ts`: ~1400+ lines (core agent logic)
- `systemPrompt.ts`: ~617 lines (prompt generation)
- `prompts.ts`: ~292 lines (prompt definitions)
- `orchestratorRunner.ts`: ~400+ lines (sub-agent routing)
- `providers/openai.ts`: ~250+ lines (OpenAI integration)
- `providers/anthropic.ts`: ~200+ lines (Anthropic integration)
