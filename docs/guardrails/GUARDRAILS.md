# Guardrails Implementation

Guardrails are centralized safety checks for agent tool execution. All tool calls pass through **4 sequential guard layers** protecting against:
- Duplicate/runaway execution
- Unsafe/destructive commands
- Secrets leakage (PII, API keys, credentials)
- Development environment collisions

**Key Finding:** Zero bypass detected ✅ — all 14 tools flow through single `executeSkill()` entry point.

## Location & Architecture

**Guard Modules**: `backend/src/guardrails/` & `backend/src/security/`

| Module | File | Purpose |
|--------|------|---------|
| **Tool Execution Guard** | `toolExecutionGuard.ts` | Deduplication + rate limiting (Redis-backed) |
| **Pre-Tool AI Judge** | `preToolJudge.ts` | LLM semantic validation for risky tools |
| **Dev Server Registry** | `devServerRegistry.ts` | Port collision prevention (Redis-backed) |
| **PII/Secret Redaction** | `piiGuard.ts` | Scrub secrets from LLM/DB/WebSocket |

**Integration point**: `backend/src/skills/index.ts:executeSkill()` (lines 419-451) — **universal entry point for all tool calls**

**Guard Chain Order:**
1. Deduplication + Rate Limit
2. AI Judge (semantic validation)
3. Semantic Guards (env write, localhost, dev server)
4. PII Redaction (at persistence/broadcast points)

---

## Guard Layer 1: Deduplication + Rate Limiting

**File**: `backend/src/guardrails/toolExecutionGuard.ts`

**Purpose**: Block duplicate tool calls and prevent tool storms.

**Storage**: Redis (distributed state across workers).

### Deduplication Policies

Per-tool TTL windows. Only identical (workspaceId, toolName, args) within window are deduplicated:

| Tool | TTL | Max Allowed | Reason |
|------|-----|-------------|--------|
| `check_health` | 5s | 6 | Allow retries during startup |
| `web_search` | 120s | 2 | Don't repeat same search |
| `read_file` | 10s | 2 | Same read pointless within 10s |
| `search_code` | 10s | 2 | Same search pointless within 10s |
| `execute_shell` | 15s | 2 | Allow one retry on risky commands |
| `edit_file` | 30s | 5 | Allow multiple writes to same file (semantic loops caught separately) |
| `provision_database` | 300s | 1 | Idempotent but run only once |
| (default) | 5s | 3 | Catch-all |

**Redis keys**:
- Dedup: `guardrail:dedup:{workspaceId}:{toolName}:{argsHash}`
- Rate: `guardrail:rate:{workspaceId}`

### Rate Limiting

Global per-workspace cap:
- **Window**: 60 seconds (rolling)
- **Limit**: 60 calls/minute
- Complex apps use 50+ calls/wave; this allows breathing room

---

## Guard Layer 2: Pre-Tool AI Judge

**File**: `backend/src/guardrails/preToolJudge.ts`

**Purpose**: LLM-based semantic safety check for high-risk operations.

**When invoked**: Only for tools matching `shouldJudge()` (not on every call):
- `provision_database` → always judge
- `execute_shell` → judge if command matches destructive pattern
- `edit_file` → judge if overwriting file >2000 chars

**Risky shell patterns** (triggers judge):
```
rm -r              # recursive delete
curl | bash        # pipe to shell
wget | bash        # pipe to shell
dd of=...          # disk write
mkfs               # format filesystem
shutdown           # shutdown
reboot             # reboot
chmod 777          # world-writable
kill -9 -1         # kill all
```

**Judge LLM**:
- Primary: GPT-4o-mini or Groq llama-3.1-8b
- Fallback: Fail open (ALLOW) if no API key
- Latency target: <500ms
- Max tokens: 30

**Verdict**: `ALLOW` or `BLOCK`
- Default on error: `ALLOW` (except `provision_database` → `BLOCK`)
- Context: current goal + recent actions + rules

---

## Guard Layer 3: Semantic Guards

**File**: `backend/src/guardrails/toolExecutionGuard.ts` (lines 156–218)

### checkEnvWriteGuard
**Tool**: `edit_file` → `.env*` files
**Action**: BLOCK direct writes; use `env_manager` tool instead
**Regex**: `/\.env(\.[^/]+)?$/`

### checkLocalhostGuard
**Tool**: `edit_file` → content with localhost/127.0.0.1
**Action**: BLOCK; use E2B sandbox URL format instead
**Example**: Use `https://<port>-<sandboxId>.e2b.app` not `localhost:3000`

### checkDevServerGuard
**Tool**: `execute_shell` → dev server commands (npm dev, next dev, npm start, etc.)
**Action**: BLOCK if port already started this run
**Port extraction**: Looks for `--port N`, `-p N`, or `:N`

---

## Guard Layer 4: PII/Secret Redaction

**File**: `backend/src/security/piiGuard.ts`

**Purpose**: Remove sensitive data from runtime outputs before storing in DB, sending to LLM, or broadcasting to frontend.

**Protection Scope**: Dynamic content only (user messages, tool outputs, agent replies). Static system prompts excluded.

### Patterns Protected

| Category | Pattern | Example |
|----------|---------|---------|
| **API Keys** | OpenAI | `sk-...` (48-char legacy), `sk-proj-...` (new) |
| | Anthropic | `sk-ant-...` |
| | Google/GCP | `AIza[35 chars]` |
| | AWS Access ID | `AKIA[16 chars]` |
| | AWS Secret | `aws_secret=...` (40 chars base64) |
| | Generic Bearer | `Bearer [20+ chars]` |
| **Cryptographic** | Private Keys | `-----BEGIN RSA/EC/OPENSSH PRIVATE KEY-----...-----END...-----` |
| | Certificates | `-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----` |
| **Credentials** | Env assignments | `token=`, `api_key=`, `password=`, `secret=` (generic patterns) |
| **Connection URLs** | Postgres | `postgres://[user:pass@]host:port/db` |
| | MySQL | `mysql://[credentials]host/db` |
| | MongoDB | `mongodb://[credentials]host/db` |
| | Redis | `redis://[credentials]host:port` |
| **PII** | Email | `user@domain.com` |

### Redaction Flow

```
Tool Output/User Message
  ↓
[3 Integration Points]
  ├─ messageService.createMessage() → database
  ├─ buildOpenAIMessages() → LLM
  └─ WSManager.broadcastToWorkspace() → frontend
  ↓
redactSensitive(text)
  ├─ Check for 9 quick triggers (sk-, Bearer, postgres://, etc.)
  └─ If match: apply 15 SECRET_PATTERNS regexes
  ↓
Replace matches with "[REDACTED]"
  ↓
Send to destination
```

**Performance**: ~1-5ms per message (90% of messages skip regex scan via fast-exit triggers).

### Implementation Points

**Database (messageService.ts)**:
```typescript
const safeContent = redactSensitive(content);
const safeToolCalls = redactSensitiveJson(toolCalls);
```

**LLM Prompt (agentRunner.ts)**:
```typescript
const messages = buildOpenAIMessages().map(msg => ({
  ...msg,
  content: redactSensitive(msg.content)
}));
```

**WebSocket (WSManager.ts)**:
```typescript
const payload = JSON.stringify(event);
const sanitized = selectiveRedact(payload, 
  ['content', 'output', 'error', 'message', 'stack', 'env']
);
broadcast(sanitized);
```

---

## Dev Server Registry

**File**: `backend/src/guardrails/devServerRegistry.ts`

**Purpose**: Track which ports have dev servers running (24h TTL in Redis).

**Functions**:
- `registerPort(workspaceId, port)` — Add port to registry
- `isPortRegistered(workspaceId, port)` — Check if running
- `loadRegisteredPorts(workspaceId)` — Get all running ports
- `clearPorts(workspaceId)` — Clear registry

**Redis key**: `devserver:ports:{workspaceId}`

---

## Integration Flow

**Entry**: `backend/src/skills/index.ts` → `executeToolCall()`

```
Tool call arrives
  ↓
Guard 1: checkToolGuard()
  ├─ Rate limit check
  └─ Dedup check
  ↓
Guard 2: judgeToolAction() [if shouldJudge() → true]
  └─ LLM safety verdict
  ↓
Guard 3: Semantic guards (if applicable)
  ├─ checkEnvWriteGuard()
  ├─ checkLocalhostGuard()
  └─ checkDevServerGuard()
  ↓
Tool executes (or returns blocked error)
```

---

## Error Messages

All guardrail blocks return structured errors:

```
[Guardrail] {reason}
```

Example:
```
[Guardrail] Duplicate call to "web_search" blocked (3 identical calls within 120s window). You already attempted this — analyze the previous result and try a different approach.
```

---

## Testing & Debugging

**Logs** (console):
- `[ToolGuard]` — Dedup/rate limit events
- `[PreToolJudge]` — Judge verdicts
- `[DevServerRegistry]` — Port tracking

**Redis fallback**: All guards fail open (allow) on Redis connectivity issues, except `provision_database` which blocks on judge failure (safety-first).

---

## Recent Additions

- **Latency optimization** (b7ddef9): Reduced agent iteration limits; guardrails unchanged
- **Sequential execution** (a62942b): Strict ordering for tasks; guardrails still per-call independent

---

## Guard Function Reference

| Function | File | Signature | Blocks | Latency |
|----------|------|-----------|--------|---------|
| `checkToolGuard()` | toolExecutionGuard.ts | `(workspaceId, toolName, args): GuardResult` | Rate/Dedup | 50ms |
| `resetToolDedup()` | toolExecutionGuard.ts | `(workspaceId, toolName, args): void` | N/A | <1ms |
| `checkEnvWriteGuard()` | toolExecutionGuard.ts | `(toolName, args): GuardResult` | .env write | <1ms |
| `checkLocalhostGuard()` | toolExecutionGuard.ts | `(toolName, args): GuardResult` | localhost | <1ms |
| `checkDevServerGuard()` | toolExecutionGuard.ts | `(toolName, args, runCtx): GuardResult` | port collision | <1ms |
| `judgeToolAction()` | preToolJudge.ts | `(goal, toolName, args, recentActions): JudgeResult` | Risky cmds | 400ms |
| `shouldJudge()` | preToolJudge.ts | `(toolName, args): boolean` | N/A | <1ms |
| `redactSensitive()` | piiGuard.ts | `(text): string` | N/A (redacts) | 1-5ms |
| `redactSensitiveJson()` | piiGuard.ts | `(raw): string` | N/A (redacts) | 1-5ms |
| `registerPort()` | devServerRegistry.ts | `(workspaceId, port): void` | N/A | <1ms |
| `isPortRegistered()` | devServerRegistry.ts | `(workspaceId, port): boolean` | N/A | <1ms |
| `loadRegisteredPorts()` | devServerRegistry.ts | `(workspaceId): Set<number>` | N/A | <1ms |
| `clearPorts()` | devServerRegistry.ts | `(workspaceId): void` | N/A | <1ms |

---

## Recommended Fixes (P0)

### Fix 1: Add env_manager to Judged Tools (5 min)

**Issue**: `env_manager` tool with `action="set_vars"` can write environment variables without AI judgment.

**Risk**: Agent could set production database URLs or API keys without semantic validation.

**Fix Location**: `backend/src/guardrails/preToolJudge.ts` line 22-25

```typescript
export const JUDGED_TOOLS = new Set([
  "execute_shell",
  "provision_database",
  "env_manager",  // ← ADD THIS
]);
```

---

### Fix 2: Expand WebSocket Redaction Fields (2 min)

**Issue**: Tool output fields (stdout, stderr, data) not redacted in WebSocket broadcasts.

**Risk**: Frontend receives unredacted command output with secrets.

**Fix Location**: `backend/src/ws/WSManager.ts` — `selectiveRedact()` call

```typescript
const sanitized = selectiveRedact(payload, [
  'content', 'output', 'error', 'message', 'stack', 'env',
  'stdout',    // ← ADD
  'stderr',    // ← ADD
  'data'       // ← ADD
]);
```

---

### Fix 3: Replace Base64 Hash with SHA-256 (10 min)

**Issue**: Dedup hash uses truncated base64 (0-64 chars), collision risk at scale.

**Risk**: Identical args with same hash could incorrectly collide; legitimate retries blocked.

**Fix Location**: `backend/src/guardrails/toolExecutionGuard.ts` line 55-64

```typescript
import crypto from 'crypto';

function hashArgs(args: unknown): string {
  const normalized = JSON.stringify(args, Object.keys(args as object).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```

---

## Verification Checklist

- [x] All tool calls routed through `executeSkill()`
- [x] 4 sequential guard layers applied
- [x] PII redaction at 3 checkpoints (DB, LLM, WS)
- [x] 9 secret pattern types detected
- [x] Dedup + rate limit Redis-backed (distributed)
- [x] Dev server port registry persisted
- [ ] P0 fixes implemented (see above)
- [ ] WebSocket fields expanded to include stdout/stderr/data
- [ ] Hash function upgraded to SHA-256

---

## Configuration

- **Rate limit cap**: `RATE_LIMIT_MAX_CALLS` = 60 calls/min
- **Rate window**: `RATE_LIMIT_WINDOW_SECONDS` = 60s
- **Judge model**: Groq `llama-3.1-8b-instant` or OpenAI `gpt-4o-mini`
- **Judge latency target**: <500ms (fallback to ALLOW on timeout)
- **Dedup threshold**: Per-tool, see Guard Layer 1 table
- **Dev server TTL**: 86400s (24h)
- **PII fast-exit triggers**: 9 common substrings skip full regex (90% perf gain)

---

## Performance Impact

**Measured latency overhead per 50-tool-call run:**
- Dedup check: ~50ms (Redis INCR)
- Rate limit: ~50ms (Redis INCR/EXPIRE)
- AI Judge: ~400ms (only risky tools, 40% of calls)
- Semantic guards: <1ms (regex on args only)
- PII redaction: ~1-5ms per message (cached for LLM)

**Total**: ~5-6 seconds overhead per build (~5-6% latency cost)
**Acceptable for**: Irreversible operations (database, file overwrites, shell commands)

---

## Related Documents

See architect-generated analysis for deep dives:
- `GUARDRAIL_ARCHITECTURE_ANALYSIS.md` — 43KB technical reference
- `GUARDRAIL_FLOW_DIAGRAM.md` — 14KB Mermaid diagrams (10 flows)
- `GUARDRAIL_RISKS_EXECUTIVE_SUMMARY.md` — 13KB risk assessment & P0 fixes
- `GUARDRAIL_ANALYSIS_INDEX.md` — 16KB navigation & quick reference
