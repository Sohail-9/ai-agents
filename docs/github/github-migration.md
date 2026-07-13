# Coregit → GitHub/Octokit Migration

## Overview

This migration replaces Coregit as the version-control backend with GitHub + Octokit.
The key architectural shift: **the database is the source of truth**. GitHub is an
optional, best-effort background mirror. Agent runs are never blocked or slowed by
GitHub availability.

### Two-Mode Operation

| Workspace state | Snapshot written to | GitHub push |
|---|---|---|
| `githubConnected = false` | DB only (always) | Never |
| `githubConnected = true` | DB first, then async | 30s after agent run |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENT RUN                                   │
│                                                                     │
│  User prompt → WSManager → agentQueue → agentWorker                │
│                                ↓                                    │
│                          runOrchestrator()                          │
│                                ↓                                    │
│               ┌────────────────┴────────────────┐                  │
│               │                                 │                  │
│       [EXISTING] coregit push            [NEW] DB snapshot         │
│    pushWorkspaceSnapshot()             prisma.snapshot.create()    │
│      fire-and-forget                     always runs               │
│               │                                 │                  │
│               ↓                                 ↓                  │
│          Coregit API                    Snapshot table              │
│      (during transition)            (permanent source of truth)    │
│                                                 │                  │
│                                    if githubConnected=true         │
│                                                 ↓                  │
│                                    githubSyncQueue.add()           │
│                                    jobId = github-sync:{workspaceId}│
│                                    delay = 30s (OPT-3 debounce)    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    GITHUB SYNC WORKER                               │
│                                                                     │
│  Fires 30s after last agent run for that workspace                 │
│                        ↓                                           │
│          Acquire Redis lock github-lock:{workspaceId}              │
│                        ↓                                           │
│       SELECT * FROM Snapshot WHERE workspaceId=X AND githubSha=NULL│
│                        ↓                                           │
│      Merge all files (latest write per path wins)    [OPT-3]      │
│                        ↓                                           │
│              pushCommit() via GitHub App Octokit                   │
│              ↳ uses cached headSha+treeSha if available [OPT-1]   │
│                        ↓                                           │
│         UPDATE Snapshot SET githubSha=<sha> WHERE id IN (...)      │
│         UPDATE Workspace SET githubHeadSha, githubTreeSha          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                   READ ROUTES  (coregit.ts)                        │
│                                                                     │
│  GET /:slug/commits        → prisma.snapshot.findMany()            │
│  GET /:slug/commits/:sha/tree   → Snapshot.files → buildTree()     │
│  GET /:slug/commits/:sha/files  → Snapshot.files → find by path    │
│  GET /:slug/commits/:sha/diff   → compare two Snapshots in-memory  │
│  GET /:slug/commits/:sha/diff-file → buildUnifiedPatch() from DB   │
│                                                                     │
│  All paths unchanged. Error shapes unchanged. Frontend sees nothing.│
└─────────────────────────────────────────────────────────────────────┘
```

---

## User Flow Diagrams

### Flow 1 — Agent Run (No GitHub Connected)

```mermaid
sequenceDiagram
    participant U as User
    participant WS as WSManager
    participant AQ as agentQueue
    participant AW as agentWorker
    participant DB as Postgres
    participant CG as Coregit API

    U->>WS: USER_REQUEST
    WS->>AQ: agentQueue.add()
    AQ->>AW: processAgentJob()
    AW->>AW: runOrchestrator()
    AW-->>U: AGENT_DONE (via WS pub/sub)

    Note over AW: githubConnected = false

    AW->>CG: pushWorkspaceSnapshot() [existing, fire-and-forget]
    AW->>AW: readSandboxFiles()
    AW->>DB: prisma.snapshot.create()
    Note over DB: Snapshot row saved<br/>files: [...], githubSha: null
```

### Flow 2 — Agent Run (GitHub Connected)

```mermaid
sequenceDiagram
    participant U as User
    participant AW as agentWorker
    participant DB as Postgres
    participant GSQ as githubSyncQueue
    participant GSW as githubSyncWorker
    participant GH as GitHub API

    AW->>AW: runOrchestrator()
    AW-->>U: AGENT_DONE

    Note over AW: githubConnected = true

    AW->>AW: readSandboxFiles() [shared util]
    AW->>DB: prisma.snapshot.create() [githubSha=null]
    AW->>GSQ: add(jobId=github-sync:{ws}, delay=30s)

    Note over GSQ: If another run fires within 30s,<br/>duplicate jobId is rejected.<br/>One job handles all.

    GSQ->>GSW: processSyncJob() [fires 30s later]
    GSW->>DB: SELECT snapshots WHERE githubSha IS NULL
    GSW->>GSW: Merge files (latest per path) [OPT-3]
    GSW->>GH: createTree() + createCommit() + updateRef()
    GSW->>DB: UPDATE Snapshot SET githubSha=<sha>
    GSW->>DB: UPDATE Workspace SET githubHeadSha, githubTreeSha
```

### Flow 3 — Connect GitHub (First Time)

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant API as POST /workspaces/:id/connect-github
    participant GCQ as githubConnectQueue
    participant GCW as githubConnectWorker
    participant GH as GitHub API
    participant DB as Postgres

    Note over U: User already connected GitHub<br/>via OAuth (/api/github/connect)

    U->>API: POST /workspaces/:id/connect-github<br/>Header: x-clerk-user-id
    API->>DB: getGithubAccount(clerkUserId)
    API->>GCQ: add(connect, payload, jobId=connect-github:{ws})
    API-->>U: 202 { jobId }

    U->>API: GET /workspaces/:id/connect-github/status?jobId=...
    API-->>U: { status: 'active', progress: 10 }

    GCQ->>GCW: processConnectJob()
    GCW->>GH: createRepo(org, repoName) [auto_init:true]
    GCW->>DB: UPDATE Workspace SET githubOwner, githubRepo
    GCW->>DB: SELECT ALL Snapshots for workspace
    GCW->>GH: createTree() × N  [parallel — OPT-2]
    GCW->>GH: createCommit() × N [sequential chain]
    GCW->>GH: updateRef() [single call]
    GCW->>DB: UPDATE Snapshot SET githubSha=<finalSha> [all]
    GCW->>DB: UPDATE Workspace SET githubConnected=true, headSha, treeSha

    U->>API: GET ...status?jobId=...
    API-->>U: { status: 'completed', progress: 100 }
```

### Flow 4 — OPT-1: Cached SHA (subsequent pushes)

```
First push to GitHub:
  getRef()        →  headSha
  getCommit()     →  treeSha
  createTree()
  createCommit()
  updateRef()
  ─────────────────────────────────────────
  SAVE: workspace.githubHeadSha = <newSha>
        workspace.githubTreeSha = <newTreeSha>

Subsequent pushes:
  [SKIP getRef]   ← headSha from DB cache
  [SKIP getCommit]← treeSha from DB cache
  createTree()
  createCommit()
  updateRef()
  UPDATE workspace shas again

  Savings: ~240ms per commit (2 API calls avoided)
```

### Flow 5 — Read Routes (frontend viewing history)

```
GET /api/coregit/{slug}/commits
  └─ resolveWorkspace(slug) → workspaceId
  └─ prisma.snapshot.findMany({ orderBy: createdAt desc })
  └─ map to { sha: id, message, author, timestamp, githubSha }
  └─ returns { commits: [...], nextCursor }

GET /api/coregit/{slug}/commits/{sha}/tree
  └─ prisma.snapshot.findUnique({ id: sha })
  └─ extract files[].path from JSON
  └─ buildTreeFromManifestPaths(paths)
  └─ returns { items: [...] }   ← tree-cached 5 min

GET /api/coregit/{slug}/commits/{sha}/files?path=src/app.ts
  └─ prisma.snapshot.findUnique({ id: sha })
  └─ files.find(f => f.path === path)
  └─ returns { path, content: base64, encoding, sha, size }

GET /api/coregit/{slug}/commits/{sha}/diff?base={baseSha}
  └─ fetch baseSnap + headSnap from DB
  └─ if both.githubSha set → octokit.repos.compareCommitsWithBasehead()
  └─ else → in-memory set diff (added/deleted/modified)
  └─ diff-cached 1 min

GET /api/coregit/{slug}/commits/{sha}/diff-file?base={b}&path={p}
  └─ extract content from both snapshots
  └─ buildUnifiedPatch(path, oldText, newText)   ← LCS algorithm
  └─ diff-file-cached 2 min
```

---

## New Files

| File | Role |
|------|------|
| `backend/src/utils/readSandboxFiles.ts` | Reads all workspace files from E2B sandbox. Used by both Coregit push (existing) and DB snapshot (new). |
| `backend/src/services/githubSyncService.ts` | Octokit wrappers: `getOctokit`, `createRepo`, `pushCommit` (OPT-1), `bulkPushHistory` (OPT-2). |
| `backend/src/workers/githubSyncWorker.ts` | Two BullMQ workers: `github-sync` (OPT-3 batch) + `github-connect` (initial bulk push). |

## Modified Files

| File | What changed |
|------|--------------|
| `backend/prisma/schema.prisma` | Added `Snapshot` model; added 5 fields to `Workspace`. |
| `backend/src/queue/jobTypes.ts` | Added `GitHubSyncPayload`, `GitHubConnectPayload`. |
| `backend/src/queue/queues.ts` | Added `githubSyncQueue`, `githubConnectQueue`. |
| `backend/src/services/coregitService.ts` | `pushWorkspaceSnapshot` now delegates file-reading to `readSandboxFiles`. Interface unchanged. |
| `backend/src/workers/agentWorker.ts` | After success: write Snapshot to DB, conditionally enqueue sync job. Coregit push still runs. |
| `backend/src/routes/coregit.ts` | All 4 read handlers rewritten to query `prisma.snapshot`. Route paths/error shapes unchanged. |
| `backend/src/routes/workspaces.ts` | Added `POST /:id/connect-github` + `GET /:id/connect-github/status`. |
| `backend/src/workers/index.ts` | Added `KIND=github-sync` that registers both github workers. |

---

## Environment Variables

```bash
# --- ADD these to .env ---
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_INSTALLATION_ID=789012
GITHUB_WORKSPACE_ORG=your-github-org

# --- KEEP (existing OAuth) ---
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# --- REMOVE after step 11 (Coregit cleanup) ---
# COREGIT_API_KEY=...
# COREGIT_ORG=...
```

**Note on `GITHUB_APP_PRIVATE_KEY`:** The full PEM with literal `\n` for newlines.
The service unescapes them: `.replace(/\\n/g, "\n")`.

---

## Manual Testing Guide

### Prerequisites

1. GitHub App created with permissions: `Contents: Read & Write`, `Metadata: Read`.
2. App installed on the org specified in `GITHUB_WORKSPACE_ORG`.
3. All env vars set.
4. Workers running (`npm run worker` or `WORKER_KIND=github-sync npm run worker`).
5. At least one workspace exists with a completed agent run.

---

### Test 1 — Isolation: workspace with no GitHub connection

**Goal:** Confirm snapshot is written to DB but no GitHub job is enqueued.

```bash
# 1. Pick a workspace that has githubConnected = false
SELECT id, name, "githubConnected" FROM "Workspace" WHERE "isDeleted" = false LIMIT 5;

# 2. Run an agent on that workspace via the app UI.

# 3. After AGENT_DONE, verify Snapshot was written:
SELECT id, "workspaceId", "commitMessage", "githubSha", "createdAt"
FROM "Snapshot"
WHERE "workspaceId" = '<your-workspace-id>'
ORDER BY "createdAt" DESC
LIMIT 3;
# Expected: 1+ rows, githubSha = NULL

# 4. Check BullMQ — confirm no github-sync job:
#    Open bull-board or run:
redis-cli KEYS "bull:github-sync:*"
# Expected: empty
```

**Expected logs from agentWorker:**
```
[AgentWorker] ▶ Job <id> | workspaceId=<ws>
[AgentWorker] ✅ Job <id> done. success=true
[AgentWorker] Snapshot <snapshotId> saved (142 files)
```

**Not expected:** Any `[GitHubSyncWorker]` log lines.

---

### Test 2 — Connect GitHub flow

**Goal:** Confirm repo is created, existing snapshots pushed, workspace marked connected.

```bash
# Step 1: Make sure user has completed GitHub OAuth
# (visit /settings in app, click "Connect GitHub")
# Verify:
SELECT "clerkUserId", username FROM "GithubAccount" WHERE "clerkUserId" = '<your-clerk-id>';

# Step 2: Call connect endpoint
curl -X POST http://localhost:8000/api/workspaces/<workspaceId>/connect-github \
  -H "x-clerk-user-id: <clerkUserId>" \
  -H "Content-Type: application/json"

# Expected response:
# {"jobId":"connect-github:<workspaceId>","status":"pending"}

# Step 3: Poll status
curl "http://localhost:8000/api/workspaces/<workspaceId>/connect-github/status?jobId=connect-github:<workspaceId>" \
  -H "x-clerk-user-id: <clerkUserId>"

# While running:  {"status":"active","progress":10,"failedReason":null}
# When done:      {"status":"completed","progress":100,"failedReason":null}

# Step 4: Verify DB state
SELECT "githubConnected", "githubOwner", "githubRepo", "githubHeadSha"
FROM "Workspace"
WHERE id = '<workspaceId>';
# Expected: githubConnected=true, githubOwner=<org>, githubRepo=<name>, githubHeadSha=<sha>

# Step 5: Verify snapshots got githubSha
SELECT id, "githubSha" FROM "Snapshot" WHERE "workspaceId" = '<workspaceId>';
# Expected: All rows have non-null githubSha

# Step 6: Verify on GitHub
# Visit https://github.com/<org>/<repoName>
# Should see commits matching agent run history
```

**Expected logs from githubConnectWorker:**
```
[GitHubSync] Repo created: <org>/<repoName>
[GitHubConnectWorker] ✅ Workspace <id> connected to <org>/<repoName>
```

---

### Test 3 — Ongoing sync after GitHub connected

**Goal:** Confirm agent runs auto-sync to GitHub 30 seconds after completion.

```bash
# 1. Use a workspace where githubConnected = true (from Test 2)

# 2. Run an agent via the app UI.

# 3. Immediately after AGENT_DONE, check Snapshot:
SELECT id, "githubSha" FROM "Snapshot"
WHERE "workspaceId" = '<ws>'
ORDER BY "createdAt" DESC LIMIT 1;
# Expected: githubSha = NULL (sync hasn't fired yet)

# 4. Wait 35 seconds (30s delay + processing time)

# 5. Re-check Snapshot:
SELECT id, "githubSha" FROM "Snapshot"
WHERE "workspaceId" = '<ws>'
ORDER BY "createdAt" DESC LIMIT 1;
# Expected: githubSha = <some sha>

# 6. Verify new commit on GitHub repo
```

**Expected logs from githubSyncWorker (after 30s):**
```
[GitHubSyncWorker] ✅ Synced 1 snapshot(s) → <sha> for workspace <ws>
```

---

### Test 4 — OPT-3: Batch multiple rapid agent runs

**Goal:** Confirm multiple agent runs within 30s window produce ONE GitHub commit.

```bash
# 1. Trigger 2-3 agent runs on the same workspace in quick succession
#    (use "Run again" in the UI before the first sync fires)

# 2. Wait 35 seconds

# 3. Check DB — multiple Snapshot rows, all with SAME githubSha:
SELECT id, "commitMessage", "githubSha" FROM "Snapshot"
WHERE "workspaceId" = '<ws>'
ORDER BY "createdAt" DESC LIMIT 5;
# Expected: 2-3 rows, all githubSha = same value

# 4. On GitHub, verify only 1 new commit appeared (not 2-3)
```

**Expected logs:**
```
[GitHubSyncWorker] ✅ Synced 3 snapshot(s) → <sha> for workspace <ws>
```

---

### Test 5 — Read routes return DB data

**Goal:** Confirm coregit routes serve from Snapshot table, not Coregit API.

```bash
# 1. With Coregit env vars unset (or API key invalid):
COREGIT_API_KEY=invalid COREGIT_ORG=invalid

# 2. Hit the commits route:
curl "http://localhost:8000/api/coregit/<workspaceName>/commits" \
  -H "x-clerk-user-id: <clerkUserId>"

# Expected: returns commits from DB snapshots (not a Coregit error)
# Response shape: { commits: [{ sha, message, author, timestamp, githubSha }], nextCursor }

# 3. Hit the tree route (use sha = snapshot ID from step 2):
curl "http://localhost:8000/api/coregit/<name>/commits/<snapshotId>/tree"
# Expected: { items: [ { name, path, type, children? } ] }

# 4. Hit the files route:
curl "http://localhost:8000/api/coregit/<name>/commits/<snapshotId>/files?path=src/index.ts"
# Expected: { path, content: "<base64>", encoding: "base64", sha, size }

# 5. Hit the diff-file route with two snapshot IDs:
curl "http://localhost:8000/api/coregit/<name>/commits/<headId>/diff-file?base=<baseId>&path=src/index.ts"
# Expected: { path, patch: "--- a/...\n+++ b/..." }
```

---

### Test 6 — No GitHub account → 403

```bash
curl -X POST http://localhost:8000/api/workspaces/<workspaceId>/connect-github \
  -H "x-clerk-user-id: <clerkId-with-no-github-account>"

# Expected: 403 { "error": "GitHub account not connected. Visit Settings to connect GitHub first." }
```

---

### Test 7 — OPT-1: SHA caching reduces API calls

```bash
# Run agent twice on a githubConnected workspace.
# After first sync, check workspace has githubHeadSha:
SELECT "githubHeadSha", "githubTreeSha" FROM "Workspace" WHERE id = '<ws>';
# Should be non-null after first sync.

# Second agent run + wait for sync.
# In GitHub App audit log (or Octokit debug mode),
# second push should only call: createTree, createCommit, updateRef.
# NOT: getRef, getCommit.
#
# Enable Octokit debug:
#   Set LOG_LEVEL=debug in env — Octokit logs each request.
```

---

## Log Reference

### agentWorker.ts

| Log | When |
|-----|------|
| `[AgentWorker] ▶ Job <id> \| workspaceId=<ws>` | Job picked up |
| `[AgentWorker] ✅ Job <id> done. success=true` | Agent run completed |
| `[AgentWorker] Snapshot <id> saved (<N> files)` | DB snapshot written successfully |
| `[AgentWorker] DB snapshot failed: <msg>` | Snapshot write error (non-fatal) |
| `[AgentWorker] Coregit snapshot failed: <msg>` | Legacy Coregit push error (non-fatal) |

### githubSyncWorker.ts — sync

| Log | When |
|-----|------|
| `[GitHubSyncWorker] Workspace <ws> locked, rescheduling` | Per-workspace Redis lock held by another sync |
| `[GitHubSyncWorker] ✅ Synced <N> snapshot(s) → <sha> for workspace <ws>` | Successful GitHub push |
| `[GitHubSyncWorker] Job <id> failed: <msg>` | Sync failed after all retries |

### githubSyncWorker.ts — connect

| Log | When |
|-----|------|
| `[GitHubSync] Repo created: <org>/<repo>` | New repo created on GitHub |
| `[GitHubSync] Repo already exists: <org>/<repo>` | 422 idempotency (safe) |
| `[GitHubConnectWorker] ✅ Workspace <id> connected to <org>/<repo>` | Full connect flow done |
| `[GitHubConnectWorker] Job <id> failed: <msg>` | Connect failed (no retry, user re-triggers) |

### githubSyncService.ts

| Log | When |
|-----|------|
| `[GitHubSync] pushCommit failed for workspace <ws>: <msg>` | GitHub API error on push (non-fatal) |
| `[GitHubSync] bulkPushHistory failed for workspace <ws>: <msg>` | Bulk push error during connect |
| `[GitHubSync] Workspace <ws> missing githubOwner/githubRepo` | Workspace not properly configured |

### coregitService.ts (legacy — still runs during transition)

| Log | When |
|-----|------|
| `[Coregit] Snapshotting "<repo>" from /workspace (sandbox=<id>)...` | Coregit push starting |
| `[Coregit] Committed snapshot for "<repo>" → <sha>` | Coregit push succeeded |
| `[Coregit] pushWorkspaceSnapshot failed for "<repo>": <msg>` | Coregit push failed (non-fatal) |
| `[Coregit] No readable files for slug "<repo>"` | Empty sandbox (non-fatal) |

---

## DB Schema Reference

### `Snapshot` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | `cuid` | Used as `sha` in all coregit routes |
| `workspaceId` | `String` | FK → Workspace |
| `agentRunId` | `String?` | Links to AgentRun for traceability |
| `files` | `Json` | `Array<{path: string, content: string}>` |
| `commitMessage` | `String` | From agent run commit message |
| `githubSha` | `String?` | Set after GitHub sync. `null` = not yet mirrored |
| `createdAt` | `DateTime` | Snapshot timestamp |

### `Workspace` new fields

| Column | Type | Notes |
|--------|------|-------|
| `githubConnected` | `Boolean` | `false` until connect-github job completes |
| `githubOwner` | `String?` | GitHub org (from `GITHUB_WORKSPACE_ORG`) |
| `githubRepo` | `String?` | Repo name: `{clerkId[:8]}-{workspaceName}` |
| `githubHeadSha` | `String?` | OPT-1: cached HEAD sha. Skip `getRef` on next push |
| `githubTreeSha` | `String?` | OPT-1: cached tree sha. Skip `getCommit` on next push |

---

## Troubleshooting

### "Snapshot not found" on coregit routes

The route uses Snapshot `id` as the `sha`. If you're mixing old Coregit SHA format
(hex strings) with new Snapshot IDs (cuid strings), the lookup will 404.
**Cause:** Frontend is caching old Coregit SHAs before migration.
**Fix:** Clear frontend commit history cache or hard-reload.

### Connect GitHub job stays "active" forever

1. Check worker is running: `WORKER_KIND=github-sync npm run worker`
2. Check `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` are set.
3. Check `GITHUB_WORKSPACE_ORG` is set and app is installed on that org.
4. Check BullMQ job status in bull-board for error details.

### `githubSha` stays null after agent run

1. Confirm `workspace.githubConnected = true` in DB.
2. Confirm `github-sync` worker is running.
3. Check Redis for delayed job: `redis-cli KEYS "bull:github-sync:delayed:*"`
4. Check `[GitHubSyncWorker]` logs for lock contention or push errors.

### GitHub API 422 on `createRepo`

Expected and handled — means repo already exists. `githubConnectWorker` continues normally.

### GitHub API 409 conflict on `updateRef`

Means headSha cache is stale (concurrent push, or workspace shafields got out of sync).
**Fix:** Clear `githubHeadSha` and `githubTreeSha` on the workspace — next push will
re-fetch from GitHub API.

```sql
UPDATE "Workspace"
SET "githubHeadSha" = NULL, "githubTreeSha" = NULL
WHERE id = '<workspaceId>';
```

### Rate limits (403/429)

`githubSyncWorker` retries with exponential backoff (5 attempts, starting at 2s).
Watch for `[GitHubSyncWorker] Job <id> failed: ...` after exhausting retries.
GitHub App default: 5000 req/hr per installation. At 5 API calls per commit,
that's ~1000 syncs/hr before hitting limits.

---

## Step 11 Checklist (Dead Code Deletion)

Run only after testing above passes in staging with `githubConnected = false` workspaces.

- [ ] Delete `backend/src/services/coregitService.ts`
- [ ] Delete `backend/src/services/coregitNamespace.ts`
- [ ] Delete `backend/src/workers/coregitWorker.ts`
- [ ] Remove `coregitService` + `coregitNamespace` imports from `workspaces.ts`
- [ ] Remove `coregitService` + `coregitNamespace` imports from `github.ts`
- [ ] Remove `coregitService` + `coregitNamespace` imports from `importWorker.ts`
- [ ] Remove `coregitService` imports from `setupWorker.ts` (if any)
- [ ] Remove `coregitQueue` from `queues.ts` and `closeQueues()`
- [ ] Remove `KIND=coregit` from `workers/index.ts`
- [ ] Remove `COREGIT_API_KEY` + `COREGIT_ORG` from `.env.example`
- [ ] Remove `getRepoInfo` call from `coregit.ts` `/:slug/info` route (or replace with GitHub URL)
- [ ] Remove remaining `coregitService`/`coregitNamespace` imports from `coregit.ts`
