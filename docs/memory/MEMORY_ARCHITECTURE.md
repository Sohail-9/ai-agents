# PrettiFlow Memory Architecture — 10x Proposal

## Current State (What We Have)

| Layer | Implementation | Limitation |
|-------|---------------|------------|
| System prompt | Static framework-specific text (~500 lines) | Never updated with what agent actually built |
| prettiflowMd | Generated once at setup, stored in DB | Static — never evolves as codebase changes |
| Message history | Last 50 messages, hard-trimmed at 70k tokens | No summarization — middle context is lost entirely |
| Workspace memory | Flat JSON blob (ports only) | No structured categories, no semantic data |
| Agent runs | Last 3 run summaries as markdown | No error pattern learning, no cross-run insights |

**Key gaps**: No summarization. No semantic retrieval. No error learning. No codebase awareness persistence. No tiered memory. Everything-or-nothing context.

---

## Industry Research Summary

| System | Key Memory Innovation |
|--------|----------------------|
| **Claude Code** | File-based tiered memory: `CLAUDE.md` (project), `memory/` directory (user, feedback, project, reference types). Loaded into every conversation. Index file (`MEMORY.md`) stays under 200 lines. |
| **Devin** | 10M+ token context ingestion. Planner/Critic loop with persistent to-do lists spanning hours/days. Devin Search/Wiki for codebase understanding. |
| **MemGPT/Letta** | OS-inspired tiered memory: main context = RAM, archival storage = disk. Automatic page-in/page-out. Self-editing memory with explicit read/write tools. |
| **Mem0** | Hybrid storage: Postgres for long-term facts, vector DB for semantic search. Memory types: semantic, episodic, procedural. TTL-based expiration by category. |
| **LangChain/LangGraph** | Conversation summary memory, entity memory, knowledge graph memory. Configurable memory backends. |
| **AWS AgentCore** | Three-tier: hot (prompt window), warm (RAG-indexed facts), cold (compressed archives). Multi-strategy retrieval: semantic + keyword + temporal. |

**Common patterns across leaders:**
1. **Tiered memory** — not everything in the prompt, retrieve what's relevant
2. **Summarization** — compress old context instead of dropping it
3. **Structured memory types** — separate facts, preferences, errors, procedures
4. **Self-updating context** — agent writes back what it learned
5. **Error pattern learning** — avoid repeating the same mistakes

---

## Proposed Architecture: 3-Tier Adaptive Memory

```
                    +---------------------------+
                    |      System Prompt         |
                    |  (framework + rules)       |
                    +---------------------------+
                              |
                    +---------------------------+
                    |    HOT: Active Context     |  <-- always in prompt
                    |  - Current task/todo       |
                    |  - Working ports/config    |
                    |  - Active error context    |
                    |  - Codebase snapshot       |
                    +---------------------------+
                              |
                    +---------------------------+
                    |   WARM: Session Memory     |  <-- summarized, injected selectively
                    |  - Run summaries           |
                    |  - Conversation digests    |
                    |  - Error patterns          |
                    |  - File change history     |
                    +---------------------------+
                              |
                    +---------------------------+
                    |   COLD: Persistent Facts   |  <-- stored in DB, queried on demand
                    |  - Project architecture    |
                    |  - Known patterns/prefs    |
                    |  - Historical decisions    |
                    |  - Dependency map          |
                    +---------------------------+
```

---

## Implementation Plan

### Phase 1: Conversation Summarization (Highest Impact, Lowest Risk)

**Problem**: When context exceeds 70k tokens, we drop everything except first 2 + last 50 messages. The middle — which often contains critical debugging context, architectural decisions, and error resolutions — is lost forever.

**Solution**: Before trimming, summarize the messages being dropped into a digest.

```typescript
// backend/src/memory/conversationSummarizer.ts

interface ConversationDigest {
  summary: string;           // 200-400 token summary of dropped messages
  keyDecisions: string[];    // architectural choices made
  resolvedErrors: string[];  // errors that were fixed (learn from them)
  filesModified: string[];   // files touched in this segment
}

// Called when tokenCount > TOKEN_LIMIT * 0.7
// Summarizes messages[2...-50] into a digest
// Digest is injected as a system message after the original system prompt
```

**Where it plugs in**: `agentRunner.ts:807` — replace the hard trim with summarize-then-trim.

```
BEFORE: [system, user1, ...DROPPED..., last50]
AFTER:  [system, digest_of_dropped, user1, last50]
```

**Token budget**: ~500 tokens for the digest. Net savings: thousands of tokens of raw messages compressed to a focused summary.

---

### Phase 2: Structured Memory Categories

**Problem**: WorkspaceMemory is a flat JSON blob. Everything is dumped as key-value pairs. No way to distinguish between ephemeral config (ports) and persistent knowledge (architecture decisions).

**Solution**: Categorize memory into typed slots with different lifetimes and priorities.

```prisma
// Updated schema
model WorkspaceMemory {
  id          String   @id @default(cuid())
  workspaceId String
  category    MemoryCategory
  key         String
  value       Json
  confidence  Float    @default(1.0)
  expiresAt   DateTime?
  updatedAt   DateTime @updatedAt
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, category, key])
  @@index([workspaceId, category])
}

enum MemoryCategory {
  CONFIG       // ports, env vars, framework version — high churn, always fresh
  ARCHITECTURE // project structure, key files, patterns — stable, high value
  ERROR        // error patterns and resolutions — prevents repeat failures
  PREFERENCE   // user preferences, coding style — stable
  DECISION     // why choices were made — useful for future reasoning
}
```

**Memory rendering priority** (when building the memory block for the prompt):
1. **CONFIG** — always included (small, critical)
2. **ERROR** — always included (prevents rework)
3. **ARCHITECTURE** — included, compressed if large
4. **DECISION** — included only if relevant to current task
5. **PREFERENCE** — included, small footprint

**Token budget per category**:
- CONFIG: 200 tokens max
- ERROR: 500 tokens max (last 5 patterns)
- ARCHITECTURE: 800 tokens max
- DECISION: 300 tokens max
- PREFERENCE: 200 tokens max
- **Total memory block: ~2000 tokens** (vs current: variable/unbounded)

---

### Phase 3: Error Pattern Learning

**Problem**: If the agent hits a "port 3000 already in use" error, fixes it, and then hits the same error next run — it starts from scratch. No cross-run error learning.

**Solution**: Extract error-resolution pairs from completed runs and store them as ERROR memories.

```typescript
// backend/src/memory/errorExtractor.ts

interface ErrorPattern {
  pattern: string;      // e.g., "EADDRINUSE", "Module not found", "CORS"
  resolution: string;   // what fixed it
  frequency: number;    // how often this error occurs
  lastSeen: Date;
}

// Called at end of each agent run in agentWorker.ts
// Scans tool call results for error patterns
// Upserts into WorkspaceMemory with category=ERROR
```

**Injection format** (in the memory block):
```markdown
### Known Error Patterns
- EADDRINUSE on port 3000: Kill existing process with `lsof -ti:3000 | xargs kill`
- Prisma client not generated: Run `npx prisma generate` after schema changes
```

---

### Phase 4: Living prettiflowMd (Self-Updating Project Context)

**Problem**: `prettiflowMd` is generated once during workspace setup and never updated. After 10 agent runs, the project looks nothing like the original description.

**Solution**: After each successful run, have the agent update the project context with what it actually built.

```typescript
// backend/src/memory/projectContextUpdater.ts

// Called at end of successful agent run
// Reads current prettiflowMd from DB
// Reads the list of modified files from the run
// Generates an updated prettiflowMd that reflects current state
// Stores back to workspace.prettiflowMd
```

**Implementation**: Add a lightweight LLM call at the end of successful runs:

```
Given the current project description:
{current prettiflowMd}

And the changes made in this run:
- Modified files: {modifiedFiles}
- Run summary: {summary}

Update the project description to reflect the current state.
Keep it concise (under 500 words). Focus on:
- What the project actually does now
- Key technical decisions made
- File structure highlights
```

**Where it plugs in**: `agentWorker.ts:145` — after coregit snapshot, before AGENT_DONE.

---

### Phase 5: Smart Context Retrieval (Future)

**Problem**: With many runs, memory grows. Can't inject everything into the prompt.

**Solution**: Before each run, score memories by relevance to the current task.

```typescript
// backend/src/memory/memoryRetriever.ts

interface RetrievalContext {
  currentTask: string;       // todo title + description
  framework: string;
  recentErrors: string[];    // from this run so far
}

// Scores each memory entry by relevance to current task
// Uses keyword matching (no vector DB needed for v1)
// Returns top-K memories within token budget
```

**Scoring heuristic (no ML needed)**:
- Keyword overlap between task description and memory key/value
- Recency boost (newer memories score higher)
- Category boost (CONFIG and ERROR always high)
- Frequency boost (errors that recur get priority)

---

## Migration Strategy

All phases are **additive** — no breaking changes to existing code.

| Phase | Effort | Impact | Dependencies |
|-------|--------|--------|-------------|
| Phase 1: Summarization | 2-3 days | High — preserves lost context | None |
| Phase 2: Structured memory | 2-3 days | High — organized knowledge | Schema migration |
| Phase 3: Error learning | 1-2 days | High — prevents repeat failures | Phase 2 |
| Phase 4: Living prettiflowMd | 1-2 days | Medium — keeps context fresh | None |
| Phase 5: Smart retrieval | 3-4 days | Medium — scales memory | Phase 2 |

**Recommended order**: Phase 1 → Phase 4 → Phase 2 → Phase 3 → Phase 5

Phase 1 and Phase 4 are independent and can start immediately with zero schema changes. They deliver the most value for the least risk.

---

## File Structure

```
backend/src/memory/
  buildMemoryBlock.ts          # EXISTS — enhance to render categorized memory
  conversationSummarizer.ts    # NEW — Phase 1
  errorExtractor.ts            # NEW — Phase 3
  projectContextUpdater.ts     # NEW — Phase 4
  memoryRetriever.ts           # NEW — Phase 5
  types.ts                     # NEW — shared memory types
```

---

## What Makes This 10x

| Current | Proposed | Improvement |
|---------|----------|-------------|
| Hard truncation at 70k tokens | Summarize-then-trim | Middle context preserved instead of lost |
| Flat JSON blob (ports only) | 5 typed memory categories with TTL | Structured knowledge that grows smarter |
| No error learning | Error-resolution pattern database | Same mistake never happens twice |
| Static prettiflowMd | Self-updating project context | Context stays accurate across runs |
| Everything-or-nothing context | Relevance-scored retrieval | Right context for the right task |
| ~120 tokens of memory | ~2000 tokens of high-value memory | 16x more useful context in fewer tokens |

The core insight from industry research: **the best memory systems don't just store more — they store smarter**. Devin wins with massive context windows. MemGPT wins with OS-style paging. Mem0 wins with typed memory + TTL. We can combine the best of each within PrettiFlow's existing architecture without adding any new infrastructure (no vector DB, no Redis changes, no new services).
