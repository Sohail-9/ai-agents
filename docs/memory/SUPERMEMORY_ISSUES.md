# Supermemory Cost & Query Optimization Issues

## Summary
Supermemory is making excessive API calls, causing high billing. Multiple redundant searches and missing caches compound the issue.

---

## Issues Found

### 1. **Redundant Searches in fetchProfileContextBlock** 🔴 HIGH COST
**Location**: `backend/src/memory/supermemoryAgent.ts:185-203`

**Problem**:
- Makes 2 parallel API calls per invocation:
  1. `client.profile()` - fetches profile + inherent search results
  2. `client.search.memories()` - separate search for predictive hints
  
- Both search the same container with overlapping results
- Profile endpoint likely includes search results already (needs verification with Supermemory docs)

**Cost Impact**: 
- 2 API calls per wave start × multiple waves per run = doubled cost

**Optimization**:
```typescript
// Option A: Remove hints search if profile already returns search results
// Option B: Combine into single profile call with better query
// Option C: Use profile results for both static + hints
```

**Priority**: HIGH - affects every task

---

### 2. **No Caching: fetchErrorFixHint** 🔴 HIGH COST
**Location**: `backend/src/brain/agentRunner.ts:2510-2516`

**Problem**:
- Called every time `execute_shell` fails (errorSnippet length > 20)
- No cache — identical errors trigger identical queries
- In retry loops, same error can be queried 10+ times per task

**Example Scenario**:
```
Iteration 1: npm install fails → fetchErrorFixHint("npm ERR!...")
Iteration 3: npm install fails again → fetchErrorFixHint("npm ERR!...")  ← DUPLICATE
Iteration 5: npm install fails again → fetchErrorFixHint("npm ERR!...")  ← DUPLICATE
```

**Cost Impact**: 
- 3-10x cost for tasks with repeated errors

**Optimization**:
```typescript
// Add error hint cache (same pattern as midWaveCache)
const errorHintCache = new Map<string, string | null>();
const hintCacheKey = hashErrorSnippet(result.error);
if (errorHintCache.has(hintCacheKey)) {
  hint = errorHintCache.get(hintCacheKey);
} else {
  hint = await fetchErrorFixHint(...);
  errorHintCache.set(hintCacheKey, hint);
}
```

**Priority**: CRITICAL - most repeated queries

---

### 3. **Weak Cache Key: fetchMidWaveContext** 🟡 MEDIUM COST
**Location**: `backend/src/brain/agentRunner.ts:1444`

**Problem**:
```typescript
const cacheKey = `${wave[0].title}:${latestContent?.slice(0, 50) ?? ""}`;
```

- Only caches by task title + first 50 chars of latest message
- `latestContent` changes frequently as agent converses
- Cache hits rare in long-running tasks

**Example**:
- Iteration 1: "Add auth[...first 50 chars]" → call supermemory
- Iteration 2: "Add auth[...different 50 chars]" → CACHE MISS, call again

**Cost Impact**: 
- Cache effectiveness ~20% when should be ~80%

**Optimization**:
```typescript
// Cache only by task title (content is same task)
const cacheKey = `${wave[0].title}`;

// Or: hash full content but cache even if content changes slightly
const cacheKey = `${wave[0].title}:${hashMessage(latestContent)}`;
// → Only recompute if fundamentally different (new debug info, new error)
```

**Priority**: MEDIUM - medium-impact optimization

---

### 4. **No Cross-Wave Cache: fetchProfileContextBlock** 🟡 MEDIUM COST
**Location**: `backend/src/brain/agentRunner.ts:1291-1303`

**Problem**:
```typescript
if (isSupermemoryEnabled() && userId) {
  const smRaw = await timeout(
    fetchProfileContextBlock(workspaceId, userId, q, ...)
  );
}
// Called EVERY WAVE
```

- Called fresh for each wave (no cache across waves)
- If workspace has 5 tasks (5 waves), calls 5 times with same workspace context
- Profile data (static framework info, port assignments) stable across waves

**Cost Impact**: 
- 1 profile × N waves = N unnecessary calls

**Optimization**:
```typescript
// Cache profile result at workspace scope (lasts entire run)
const profileCache = new Map<string, string | null>();
const profileKey = `${workspaceId}:${userId}`;

if (!profileCache.has(profileKey)) {
  profileCache.set(profileKey, await fetchProfileContextBlock(...));
}
const smRaw = profileCache.get(profileKey);
```

**Priority**: MEDIUM - affects multi-wave runs

---

### 5. **No Deduplication: Profile + Error Hint Searches** 🟡 MEDIUM COST
**Location**: `backend/src/memory/supermemoryAgent.ts` + `backend/src/brain/agentRunner.ts`

**Problem**:
- `fetchProfileContextBlock` includes "Relevant memories" (broad search)
- `fetchErrorFixHint` searches for same error context separately
- Both queries could return overlapping results

**Example**:
```
Profile search: "Add JWT packages frameworks error solutions"
Error hint search: "JWT error fix solution"
→ Same memory returned twice in different contexts
```

**Cost Impact**: 
- Redundant searches when error happens during task execution

**Optimization**:
- Share search results between profile and error hint
- Use error hint from profile "Relevant memories" if already fetched

**Priority**: LOW - minor overlap

---

### 6. **Query String Bloat in fetchProfileContextBlock** 🟡 LOW COST
**Location**: `backend/src/memory/supermemoryAgent.ts:192-201`

**Problem**:
```typescript
const hintsQ = todoTitle
  ? `${todoTitle} packages required setup steps common pitfalls ${framework ?? ""}`.slice(0, 500)
  : null;
```

- Boilerplate query string adds fixed tokens to every search
- "packages required setup steps common pitfalls" repeated every hint search
- Framework name included even when not relevant

**Cost Impact**: 
- Minimal (~5% overhead per query)

**Optimization**:
```typescript
// Pre-built hint query template
const HINT_QUERY_TEMPLATE = "packages setup pitfalls";
const hintsQ = todoTitle ? `${todoTitle} ${HINT_QUERY_TEMPLATE} ${framework}`.slice(0, 500) : null;
```

**Priority**: LOW - minor optimization

---

## Cost Calculation (Estimated)

Assuming Supermemory charges per API call:

**Baseline (single task, 5 iterations)**:
- Wave start: 1 profile × 2 searches = 2 calls
- Mid-wave iteration 1: 1 search = 1 call
- Error hints: 0-5 calls (depends on errors)
- **Total: 3-8 calls per task**

**With multiple waves (5 tasks)**:
- Wave start: 5 waves × 2 searches = 10 calls ← **redundant, could be 1 cached**
- Mid-wave: 5 calls (one per wave)
- Error hints: 10-50 calls (compounded if errors repeat) ← **no cache**
- **Total: 25-65 calls vs. optimal ~15 calls**

**Multiplier**: ~2-4x cost overhead

---

## Recommended Fix Priority

| Priority | Issue | Est. Savings | Effort |
|----------|-------|--------------|--------|
| CRITICAL | Error hint caching | 30-50% | 30min |
| HIGH | Remove redundant hint search | 20-30% | 1hr |
| MEDIUM | Better midWaveCache key | 10-15% | 20min |
| MEDIUM | Cross-wave profile cache | 10-15% | 20min |
| LOW | Query string optimization | 2-5% | 10min |

**Total Potential Savings**: 70-115% reduction (2-3x cost reduction)

---

## Implementation Roadmap

### Phase 1: Quick Wins (1-2 hours)
1. Add error hint cache (errorHintCache Map)
2. Fix mid-wave cache key (use task title only)
3. Build run-level profile cache

### Phase 2: Structural Changes (2-3 hours)
1. Investigate if profile() already includes search results
2. Remove redundant hint search if possible
3. Unify profile + error searches if overlapping

### Phase 3: Monitoring (ongoing)
1. Add metrics for:
   - Total supermemory API calls per run
   - Cache hit rate (midWaveCache, errorHintCache, profileCache)
   - Cost per call × total calls
2. Dashboard: "Supermemory API calls" counter
3. Alert: if calls > threshold per run

---

## Monitoring Code to Add

```typescript
// metrics/supermemoryMetrics.ts
export const supermemoryMetrics = {
  profileCalls: 0,
  midWaveCalls: 0,
  errorHintCalls: 0,
  midWaveCacheHits: 0,
  errorHintCacheHits: 0,
  profileCacheHits: 0,
};

// In agentRunner.ts
supermemoryMetrics.profileCalls++;
supermemoryMetrics.midWaveCacheHits++; // when cache hit

// End of run
console.log(`[Metrics] Supermemory: ${supermemoryMetrics.profileCalls} profile calls, ${supermemoryMetrics.midWaveCacheHits} mid-wave cache hits`);
```

---

## Questions for Product/Billing

1. Does `client.profile()` already include search results, or is it just static profile?
2. Does Supermemory charge per API call or per query/search?
3. Are profile calls cheaper than search calls?
4. What's the actual cost per call? (Needed for ROI calculation on optimizations)
