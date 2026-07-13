# Skill System Architecture & Implementation

## Overview

AI Agents Agent uses a **persona-based skill routing system** to dynamically inject specialized knowledge into the LLM system prompt based on the task at hand. Rather than using generic coding knowledge for all tasks, skills allow the agent to adopt a specialized persona (architect, frontend-designer, backend engineer, etc.) that provides domain-specific guidance.

**Key principle:** Each task is intelligently routed to its best-matching skill, loading a specialized SKILL.md persona that augments (but never replaces) the base system prompt.

---

## Core Concepts

### 1. Skill (SKILL.md File)

A skill is a markdown file with YAML frontmatter and a persona body:

```yaml
---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces...
metadata: {}
---

[Persona guidance text]
```

**Location:** `backend/src/skills/{skill-name}/SKILL.md`

**Components:**
- **Frontmatter (`name`, `description`):** Metadata for discovery & classification
- **Body (content):** The persona—instructions, philosophy, guidelines the agent follows when this skill is active

**Examples:**
- `frontend-design/SKILL.md` — UI design philosophy, aesthetics, typography
- `architect/SKILL.md` — System design thinking, trade-offs, scalability
- `backend-skill/SKILL.md` — API design, server-side patterns
- `plan/SKILL.md` — Planning approach, architectural decisions (with plan-mode guardrail)

### 2. Skill Discovery

Dynamic scanning of `skills/*/SKILL.md` files:
- Parses frontmatter with gray-matter library
- Requires both `name` and `description` in YAML
- Caches results in memory (survives entire process)
- Logs all discovered skills on first call

**Code:** `skills/skillDiscovery.ts`

```ts
export async function discoverSkills(): Promise<SkillManifest[]>
```

Returns array of `SkillManifest` objects containing name, description, file path, and metadata.

### 3. Skill Routing (Classification)

Determines which skill best matches the current task using **two-tier fallback:**

**Tier 1: Groq Classifier (Semantic)**
- Fast LLM (llama-3.1-8b-instant)
- Understands task semantics
- ~500ms per call
- **Retry mechanism:** Auto-rotates through 5 API keys on failure

**Tier 2: Heuristic Fallback (Keywords)**
- Instant keyword matching
- Catches ~70% of tasks
- Used when Groq fails or unavailable
- Fallback to None if no match

**Code:** `brain/skillRouter.ts`

```ts
export async function selectSkillForTask(
  taskDescription: string,
  groqApiKey: string
): Promise<SkillManifest | null>
```

### 4. Persona Loading

Reads skill SKILL.md file, strips frontmatter, applies mode-specific wrapper:

**Code:** `skills/skillLoader.ts`

```ts
export async function loadSkillPersona(
  manifest: SkillManifest,
  planMode?: boolean
): Promise<string>
```

**Plan Mode Wrapper (Applied if planMode=true):**
```
<plan_mode_skill>
[persona content]

---
PLAN MODE CONSTRAINT:
You are in plan mode. Use this skill to STRUCTURE your planning,
not to implement. Focus on architectural decisions, component design,
data flow design, trade-off analysis.

DO NOT write code or use implementation tools.
</plan_mode_skill>
```

Wrapped persona prevents implementation while keeping planning guidance.

### 5. System Prompt Injection

Base system prompt + active skill persona = final system prompt:

```
Base prompt (700 tokens)
  ↓
+ Skill block (500-1000 tokens depending on skill)
  ↓
= Final system prompt (~1200-1700 tokens)
```

**Code:** `brain/systemPrompt.ts`

```ts
export function buildActiveSkillBlock(persona: string, skillName: string): string
```

---

## Architecture: Groq Key Rotation

Resilience through multiple API keys with round-robin rotation:

### Pool Management

**File:** `brain/groqPool.ts`

```ts
class GroqKeyPool {
  private keys: string[];
  private currentIndex: number = 0;
  
  getCurrentKey(): string
  rotateKey(): void
  getPoolSize(): number
}
```

**Initialization:**
- Loads from `GROQ_API_KEYS` (comma-separated) OR
- Loads from individual env vars: `GROQ_API_KEY`, `GROQ_API_KEY_2`, ..., `GROQ_API_KEY_5`

### Retry Logic

```
Attempt 1: Try key #1 → fails (rate limit)
  ↓ Rotate
Attempt 2: Try key #2 → fails (timeout)
  ↓ Rotate
Attempt 3: Try key #3 → success ✓
  ↓
Next task starts with key #4 (round-robin continues)
```

**All keys exhausted?** Fall back to heuristic matching.

**Quota calculation:** 5 keys × ~10k requests/day = ~50k requests/day. Never offline.

---

## Routing Decision Logic

**Condition: When to Route**

```ts
const shouldRoute = planMode || isComplexTask || waveIndex === 1
```

| Scenario | Wave | Mode | Small? | Route? | Reason |
|----------|------|------|--------|--------|--------|
| First query | 1 | Build | Yes | ✓ YES | Wave 1 deserves quality |
| First query | 1 | Build | No | ✓ YES | Wave 1 deserves quality |
| First query | 1 | Plan | Any | ✓ YES | Plan always routes |
| Follow-up | 2+ | Plan | Any | ✓ YES | Plan always routes |
| Follow-up tweak | 2+ | Build | Yes | ✗ NO | Skip latency on obvious tasks |
| Follow-up complex | 2+ | Build | No | ✓ YES | Complex deserves routing |

**Key principles:**
- **Wave 1 (first query)** = always route (sets tone for entire run)
- **Wave 2+ small** = skip routing (latency optimization)
- **Wave 2+ complex** = route (semantic understanding needed)
- **Plan mode** = always route with guardrail wrapper

---

## Integration Points

### 1. Agent Runner (`brain/agentRunner.ts`)

**Pool Initialization (at module load):**
```ts
(() => {
  const commaSeparated = process.env.GROQ_API_KEYS;
  if (commaSeparated) {
    initGroqPool(commaSeparated);
  } else {
    initGroqPool(); // Auto-detect individual env vars
  }
})();
```

**Routing Decision Block (before LLM call):**
```ts
const shouldRoute = planMode || isComplexTask || waveIndex === 1;

if (shouldRoute) {
  const manifest = await selectSkillForTask(taskDesc, groqKey);
  if (manifest) {
    const persona = await loadSkillPersona(manifest, planMode);
    const skillBlock = buildActiveSkillBlock(persona, manifest.name);
    systemPrompt = `${systemPrompt}${skillBlock}`;
  }
}
```

### 2. Skill Discovery in Build Mode

**Build mode only:** Skills menu block injected into base prompt for visibility.

```ts
if (allSkills.length > 0 && !planMode) {
  const skillsMenu = buildSkillsMenuBlock(allSkills);
  systemPrompt = `${systemPrompt}\n\n${skillsMenu}`;
}
```

Plan mode: No skills menu (plan focus, no implementation hints).

### 3. Tool Blocking

**Existing mechanism in agentRunner:**
```ts
const activeToolSchemas = planMode
  ? TOOL_SCHEMAS.filter(tool => !['edit_file', 'execute_shell'].includes(tool.name))
  : TOOL_SCHEMAS;
```

Plan mode + skill guardrail wrapper = double safety.

---

## Execution Flow: Full Example

### User Input: "Build a beautiful landing page" (Direct Build Mode)

```
1. User submits in build mode (not plan first)
   └─ Creates new agent run

2. SetupWorker creates 1 todo: "Build landing page UI"
   
3. AgentRunner Wave #1:
   ├─ waveIndex = 1
   ├─ taskDesc = "Build landing page UI"
   ├─ planMode = false
   ├─ groqKey = present
   ├─ Routing decision:
   │  └─ shouldRoute = (false OR false OR true) = TRUE (wave 1)
   │
   ├─ selectSkillForTask("Build landing page UI"):
   │  ├─ Pool size = 5 keys
   │  ├─ Attempt 1: Try key #1 → SUCCESS
   │  ├─ Groq response: "frontend-design"
   │  └─ Return SkillManifest
   │
   ├─ loadSkillPersona(frontend-design, planMode=false):
   │  ├─ Read SKILL.md content
   │  ├─ No wrapper (build mode)
   │  └─ Return full persona
   │
   └─ buildActiveSkillBlock(persona, "frontend-design"):
      └─ Inject into system prompt

4. System prompt sent to LLM:
   ├─ Base prompt (701 tokens)
   ├─ + Frontend-design skill (250 tokens)
   └─ = 951 tokens

5. Agent generates code:
   ├─ Full tool access
   ├─ Guided by frontend-design aesthetic philosophy
   └─ Output: Beautiful, distinctive landing page
```

### User Input: "Plan AI chatbot" (Plan Mode)

```
1. User submits in plan mode
   └─ Creates new agent run with planMode=true

2. AgentRunner Wave #1:
   ├─ waveIndex = 1
   ├─ taskDesc = "Plan AI chatbot"
   ├─ planMode = true
   ├─ Routing decision:
   │  └─ shouldRoute = (true OR * OR *) = TRUE (plan mode)
   │
   ├─ selectSkillForTask("Plan AI chatbot"):
   │  ├─ Groq: "architect" (matches design, scalability context)
   │  └─ Return SkillManifest
   │
   ├─ loadSkillPersona(architect, planMode=true):
   │  ├─ Read SKILL.md content
   │  ├─ Apply wrapper: <plan_mode_skill> + constraint
   │  └─ Return wrapped persona
   │
   └─ buildActiveSkillBlock(wrapped_persona, "architect"):
      └─ Inject into system prompt

3. System prompt sent to LLM:
   ├─ Base prompt (701 tokens)
   ├─ + <plan_mode_skill> wrapped architect persona
   ├─ + PLAN MODE CONSTRAINT ("Do NOT write code")
   └─ = 1050 tokens

4. Agent generates plan:
   ├─ Tool set filtered (no edit_file, execute_shell)
   ├─ Guardrail wrapper prevents implementation
   ├─ System prompt emphasis on planning
   └─ Output: Structured plan.md (decisions, trade-offs, phasing)
```

---

## Configuration

### Environment Variables

**Option 1: Comma-separated keys**
```bash
export GROQ_API_KEYS="gsk_key1,gsk_key2,gsk_key3,gsk_key4,gsk_key5"
```

**Option 2: Individual variables (recommended for .env)**
```bash
GROQ_API_KEY="gsk_key1"
GROQ_API_KEY_2="gsk_key2"
GROQ_API_KEY_3="gsk_key3"
GROQ_API_KEY_4="gsk_key4"
GROQ_API_KEY_5="gsk_key5"
```

Both formats auto-detected by groqPool.

### Creating New Skills

1. Create directory: `backend/src/skills/{skill-name}/`
2. Create SKILL.md with frontmatter:
   ```yaml
   ---
   name: my-skill
   description: What this skill does
   metadata:
     version: 1
   ---

   [Persona guidance]
   ```
3. Skill auto-discovered on next agent run
4. Add keywords to `skillRouter.ts` KEYWORD_MAP for heuristic fallback

---

## Debugging & Logging

### Pool Initialization Logs

```
[GROQ] Loading keys from individual env vars (GROQ_API_KEY, GROQ_API_KEY_2..5)
[GROQ]   ✓ Found GROQ_API_KEY (gsk_mY9CnbcY...)
[GROQ]   ✓ Found GROQ_API_KEY_2 (gsk_bkwHqgB...)
[GROQ]   ✗ GROQ_API_KEY_6 not found
[GROQ] Pool initialized with 5 keys total
```

**Problem:** Shows 0 keys → env vars not loaded

### Routing Decision Logs

```
[SKILL] ── routing decision ────────────────────────────────────────
[SKILL] groqKey present: YES
[SKILL] wave.length: 1
[SKILL] waveIndex: 1
[SKILL] taskDesc: "Build todo UI"
[SKILL] taskLength: 13 chars
[SKILL] isSmallTask: true
[SKILL] planMode: false
[SKILL] shouldRoute: true (planMode=false OR isComplexTask=false OR waveIndex=1=true)
[SKILL] → ROUTING (calling selectSkillForTask)
```

**Problem:** Shows "SKIP ROUTING" on wave 1 → check waveIndex

### Classification Attempt Logs

```
[SKILL] ── routing ─────────────────────────────────────────────
[SKILL] task: "Build todo UI"
[SKILL] Pool has 5 keys available
[SKILL] Attempt 1/5: Using key 1 (masked: gsk_mY9CnbcY...)
[SKILL] Creating OpenAI client with Groq endpoint...
[SKILL] Sending classification request to Groq...
[SKILL] ✓ Groq response received successfully
[SKILL] classifier result → "frontend-design"
[SKILL] ✓ Successfully matched skill: "frontend-design"
```

**Problem: Shows error**
```
[SKILL] ✗ Attempt 1 failed
[SKILL]   Error type: APIError
[SKILL]   Error message: 401 Unauthorized
[SKILL]   Error code: 401
```
→ Check API key is valid, not expired

### Injection Logs

```
[SKILL] ── loading ──────────────────────────────────────────────
[SKILL] loading persona: skills/frontend-design/SKILL.md (1.0kb) [plan mode]
[SKILL] ── injecting ────────────────────────────────────────────
[SKILL] system prompt: base(701 tokens) + skill_persona(250 tokens) = 951 tokens
[SKILL] ── active ───────────────────────────────────────────────
[SKILL] persona "frontend-design" active for this task
```

All three headers indicate successful injection.

---

## Performance Characteristics

| Operation | Latency | Notes |
|-----------|---------|-------|
| Skill discovery | ~50ms | Cached after first call |
| Persona loading | ~10ms | Memoized by skill name |
| Heuristic matching | <1ms | O(1) keyword lookup |
| Groq classification | ~500ms | Network call, 3s timeout |
| Key rotation retry | +500ms | Per failed key |
| System prompt injection | <5ms | String concatenation |

**Impact on agent latency:**
- Wave 1 (routes): +500ms (Groq call)
- Wave 2+ small (skip): No penalty
- Wave 2+ complex (routes): +500ms

---

## Files Overview

| File | Purpose |
|------|---------|
| `skills/types.ts` | TypeScript interfaces (SkillManifest, ActiveSkillContext) |
| `skills/skillDiscovery.ts` | Dynamic SKILL.md scanner |
| `skills/skillLoader.ts` | Persona reader + plan-mode wrapper |
| `skills/*/SKILL.md` | Individual skill definitions (8 total) |
| `brain/skillRouter.ts` | Groq classifier + heuristic fallback |
| `brain/groqPool.ts` | Key rotation manager |
| `brain/systemPrompt.ts` | Skill block builder functions |
| `brain/agentRunner.ts` | Integration point (pool init, routing decision, injection) |

---

## Safety & Guardrails

### Plan Mode Safety (Three Layers)

1. **Tool Blocking:** System filters edit_file, execute_shell in plan mode
2. **Persona Wrapper:** `<plan_mode_skill>` block adds "DO NOT write code" constraint
3. **System Prompt Emphasis:** Plan-mode rules prioritize planning over implementation

**Effect:** Even if a skill tries to implement, three layers prevent it.

### Fallback Chain

```
Tier 1: Groq classifier
  ↓ fails
Tier 2: Heuristic keyword match
  ↓ no match
Tier 3: Base prompt only (no skill)
  ↓ system still works
Agent runs, may be less specialized but never crashes
```

---

## Future Enhancements

1. **Multi-skill routing:** Allow multiple skills to be active simultaneously
2. **Skill composition:** Load multiple complementary skills (e.g., architect + frontend-design)
3. **Skill versioning:** Support multiple versions of same skill
4. **Custom keywords:** User-provided task-to-skill mappings
5. **Performance metrics:** Track classifier accuracy, latency per skill
6. **Skill feedback:** Agent output → improve classifier training

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| No routing logs | GROQ_API_KEY not set | Set env vars (GROQ_API_KEY or GROQ_API_KEYS) |
| Pool shows 0 keys | Env vars not loaded | Restart worker, check .env syntax |
| All keys exhausted | Rate limited across all keys | Wait for rate limit reset, add more keys |
| Wrong skill selected | Groq classifier semantic mismatch | Add keywords to heuristic map, adjust prompts |
| Plan mode executing code | Guardrail not applied | Check planMode flag, wrapper logged? |
| Persona not injected | selectSkillForTask returned null | Check Groq logs, fallback to heuristic? |

---

## References

- **Gray-matter:** YAML frontmatter parsing
- **OpenAI SDK:** Groq API client (compatible endpoint)
- **Groq API:** llama-3.1-8b-instant model (3s timeout)
- **System Prompt Design:** Token weight, instruction specificity, recency principles
