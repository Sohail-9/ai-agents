# Hard Guardrails Implementation Plan

## Goal
Add language/framework enforcement to system prompt to prevent code drift (e.g., Python in TypeScript/Next.js workspace).

## Problem
Agent generates code in wrong languages/frameworks. No workspace stack validation in system prompt.

## Solution
Inject workspace-specific hard rules into system prompt dynamically.

---

## Implementation Files & Changes

### File 1: `backend/src/brain/systemPrompt.ts`

#### Change 1A (NEW): Add Helper Function
**Location:** After line 17 (after imports, before FRAMEWORK_TEMPLATES)

Create function:
```
buildWorkspaceStackGuardrails(workspaceConfig)
  Input: {language, framework, database, ...}
  Output: String with MANDATORY STACK RULES block
  
  Example output:
  "=== WORKSPACE STACK RULES (MANDATORY) ===
   This workspace is locked to:
   Language: TypeScript
   Framework: Next.js
   Database: None
   
   STRICT RULES:
   - ONLY generate TypeScript code
   - NEVER use Python/Flask/FastAPI/Django/Vue/Angular/etc
   - ONLY use Next.js conventions
   - Do NOT introduce alternative stacks
   - Any response violating these rules is invalid"
```

#### Change 1B (MODIFY): Update getSystemPrompt()
**Location:** Lines 250-265 (before return statement)

Current: Returns `projectContext + (PREBUILT_NEXTJS_PROMPT or FALLBACK_PROMPT)`

New: 
- Accept workspaceConfig param in function signature
- Build guardrails: `guardrails = buildWorkspaceStackGuardrails(workspaceConfig)`
- Return: `projectContext + guardrails + (PREBUILT_NEXTJS_PROMPT or FALLBACK_PROMPT)`

#### Change 1C (MODIFY): Update getPlanModePrompt()
**Location:** Lines 277-324 (before return statement)

Current: Returns plan-specific prompt

New:
- Accept workspaceConfig param in function signature
- Build guardrails: `guardrails = buildWorkspaceStackGuardrails(workspaceConfig)`
- Return: `guardrails + (plan prompt content)`

---

### File 2: `backend/src/brain/agentRunner.ts`

#### Change 2A (MODIFY): Extract & Pass Config
**Location:** Lines 967-979 (in runAgentForTodo() function)

Current destructuring:
```
const {
  workspaceId,
  sandboxId,
  framework,
  templateId,
  projectIdea,
  ...
} = ctx;
```

New:
- Fetch workspace config from DB/cache
- Extract: language, framework, database from workspace.config
- Build object: `workspaceConfig = {language, framework, database}`

#### Change 2B (MODIFY): Pass to Prompt Functions
**Location:** Lines 993-997 (where getSystemPrompt/getPlanModePrompt called)

Current:
```
getSystemPrompt({ framework, templateId, idea: projectIdea })
getPlanModePrompt({ framework, idea: projectIdea })
```

New:
```
getSystemPrompt({ framework, templateId, idea: projectIdea, workspaceConfig })
getPlanModePrompt({ framework, idea: projectIdea, workspaceConfig })
```

---

## Injection Points Covered

✅ Initial prompt creation (Line 993-997 in agentRunner.ts)
✅ Every iteration (systemPrompt rebuilt, guardrails included)
✅ Plan mode (getPlanModePrompt includes guardrails)
✅ Message array (systemPrompt with guardrails injected as system role)

---

## Files NOT Changed

- providers/*.ts (receive modified systemPrompt automatically)
- Message builders (buildOpenAIMessages, buildAnthropicMessages)
- Iteration loop (uses existing systemPrompt)
- Orchestrator, agents (inherit from main systemPrompt)

---

## Acceptance Criteria

Case 1: TypeScript/Next.js workspace
- Input: `pip install openai`
- Expected: Agent refuses, uses `npm install`

Case 2: Same config
- Input: `from flask import Flask`
- Expected: Agent refuses, uses Next.js instead

Case 3: Same config
- Input: `const app = express()`
- Expected: Agent refuses, uses Next.js API routes

---

## Summary Table

| File | Location | Change Type | Detail |
|---|---|---|---|
| systemPrompt.ts | After line 17 | ADD | Helper: buildWorkspaceStackGuardrails() |
| systemPrompt.ts | ~260-265 | MODIFY | getSystemPrompt() + guardrails |
| systemPrompt.ts | ~320-324 | MODIFY | getPlanModePrompt() + guardrails |
| agentRunner.ts | ~975 | MODIFY | Extract workspaceConfig from workspace |
| agentRunner.ts | ~996-997 | MODIFY | Pass workspaceConfig to prompt functions |
