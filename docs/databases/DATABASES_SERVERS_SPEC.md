# Databases & Servers Pages — Implementation Spec

## Overview

Two pages to replace the existing "Coming Soon" screens:
- `/databases` — per-workspace database dashboard (Neon-style analytics UI, Azure PostgreSQL backend)
- `/deployments` — servers dashboard showing all deployed frontend/backend services

---

## 1. `/databases` — Database Dashboard

### Stack
- Frontend: `client/app/databases/page.tsx`
- Backend service: `backend/src/services/workspaceDatabaseExplorerService.ts` (add `getStats`)
- Backend route: `backend/src/routes/workspaces.ts` (add `GET /:id/database/stats`)

### Layout
Uses `PageShell` (sidebar included). Full-width scrollable content area.

---

### Header
```
[Database icon]  Databases  [6]                          [Refresh]
```
- Count badge shows number of workspaces with a database
- Refresh re-fetches workspace list + clears cached stats

---

### Data Loading
1. Fetch all workspaces: `GET /api/workspaces/${user.id}`
2. Filter: only workspaces where `databaseUrl !== null`
3. For each — lazy fetch stats: `GET /api/workspaces/:id/database/stats`
4. For each — already have tables from: `GET /api/workspaces/:id/database/meta`

---

### Card Layout (one per workspace with a DB)

```
┌──────────────────────────────────────────────────────────────────┐
│  [DB icon]  workspace-name                  [Connected] [Open →] │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   [Storage]    [Connections]    [Cache Hit]    [Tables]          │
│   SVG meter     SVG meter       SVG meter      SVG meter         │
│   0.03/0.5 GB   2/100           98.5%          8                 │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  postgresql://****:****@ai-agents-db.postgres...  [copy] [eye]  │
├──────────────────────────────────────────────────────────────────┤
│  Tables:  [users]  [workspaces]  [messages]  [requests]  ...     │
├──────────────────────────────────────────────────────────────────┤
│  Provider: Azure PostgreSQL       Created: Jun 9   Updated: ...  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Arc Meters (Neon-style SVG)

4 meters in a row inside each card. Each meter is a circular SVG ring with:
- Background track: `rgba(255,255,255,0.06)`
- Colored arc: fills based on `value / max` ratio
- Center: current value (large) + unit (small)
- Label: below the circle

| Meter | PostgreSQL Source | Default Max | Arc Color |
|---|---|---|---|
| **Storage** | `pg_database_size(current_database())` converted to GB | 0.5 GB | Blue `#3b82f6` |
| **Connections** | Active connections from `pg_stat_activity` WHERE state != 'idle' | `max_connections` pg setting | Violet `#8b5cf6` |
| **Cache Hit** | `blks_hit / (blks_hit + blks_read) * 100` from `pg_stat_database` | 100% | Emerald `#10b981` |
| **Tables** | `count(*)` from `information_schema.tables` WHERE schema = 'public' | 50 (visual only) | Amber `#f59e0b` |

SVG pattern (same as sidebar credit ring):
```tsx
<svg width="80" height="80" viewBox="0 0 80 80" style={{ transform: 'rotate(-90deg)' }}>
  <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
  <circle cx="40" cy="40" r="32" fill="none" stroke={color}
    strokeWidth="5" strokeLinecap="round"
    strokeDasharray={2 * Math.PI * 32}
    strokeDashoffset={2 * Math.PI * 32 * (1 - clampedPct)} />
</svg>
```

---

### New Backend: `getStats(workspaceId)`

Added to `workspaceDatabaseExplorerService` using existing `withWorkspacePool` pattern.

Queries (run in parallel via `Promise.all`):
```sql
-- Storage
SELECT pg_database_size(current_database()) AS size_bytes;

-- Connections
SELECT count(*) AS active_connections
FROM pg_stat_activity
WHERE datname = current_database() AND state != 'idle';

SELECT setting::int AS max_connections
FROM pg_settings WHERE name = 'max_connections';

-- Cache hit ratio
SELECT
  CASE WHEN blks_hit + blks_read = 0 THEN 100
       ELSE round(blks_hit::numeric * 100 / (blks_hit + blks_read), 1)
  END AS cache_hit_ratio
FROM pg_stat_database WHERE datname = current_database();

-- Tables + rows
SELECT
  count(*)::int AS table_count,
  COALESCE(sum(n_live_tup), 0)::bigint AS total_rows
FROM pg_stat_user_tables;
```

Response shape:
```json
{
  "sizeBytes": 31457280,
  "sizeGB": 0.03,
  "maxSizeGB": 0.5,
  "activeConnections": 2,
  "maxConnections": 100,
  "cacheHitRatio": 98.5,
  "tableCount": 8,
  "totalRows": 4231
}
```

`maxSizeGB` reads from env `DB_MAX_SIZE_GB`, defaults to `0.5`.

---

### New Backend Route

```
GET /api/workspaces/:id/database/stats
```

Added to `backend/src/routes/workspaces.ts`.

Returns the `getStats` result. Returns `404` if workspace not found or has no database.

---

### Empty State

Centered, full-height:
```
[Database icon]
No databases yet
Databases are provisioned automatically when your project requests one.
[Start a project]  →  links to /
```

---

---

## 2. `/deployments` — Servers Dashboard

### Stack
- Frontend: `client/app/deployments/page.tsx`
- No new backend routes — uses existing endpoints only

### Existing Endpoints Used
| Endpoint | Used for |
|---|---|
| `GET /api/workspaces/${user.id}` | Workspace list (includes last SUCCESS deployment per workspace) |
| `GET /api/workspaces/:id/deployments` | All deployments for selected server |
| `GET /api/workspaces/deployments/:id/logs` | Build logs for a deployment |
| `GET /api/workspaces/:id/analytics?period=X` | Overview metrics |
| `GET /api/workspaces/:id/request-logs` | Live request logs |

---

### Layout

Uses `<Sidebar />` directly (same pattern as analytics page). Full-height flex row:

```
[Sidebar] | [Left Panel 320px] | [Right Panel flex-1]
```

---

### Left Panel

#### Summary Bar (top)
```
All: 8    Frontend: 4    Backend: 3    Building: 1
```
Counts derived from flattened deployment list across all workspaces.

#### Search
```
[Search servers...]
```
Filters list by workspace name (client-side).

#### Server List

One row per deployment record, sorted by `createdAt` desc.
A fullstack workspace appears as 2 rows (FRONTEND + BACKEND).

```
[dot] workspace-name                       2h ago
      FRONTEND  •  running
      app.ai-agents.com

[dot] workspace-name                       2h ago
      BACKEND   •  running
      api.ai-agents.com

[dot] shop-app                             5m ago
      FRONTEND  •  building
      —

[dot] old-project                          3d ago
      FRONTEND  •  closed
      —
```

Row states:
- Default: `hover:bg-white/[0.04]`
- Selected: `bg-white/[0.06]` + `border-l-2 border-brand-pink`

Status dot colors:
- `running` → `bg-emerald-500`
- `building` → `bg-amber-400 animate-pulse`
- `closed` → `bg-red-500/60`

Status mapping from deployment record:
| Deployment Status | Server Status |
|---|---|
| `SUCCESS` | running |
| `QUEUED` / `BUILDING` / `DEPLOYING` | building |
| `FAILED` | closed |
| Workspace `ARCHIVED` | closed |

---

### Right Panel

#### Nothing selected
```
          [Server icon]
    Select a server to view details
```
Centered, dimmed.

---

#### Server selected

**Detail Header:**
```
workspace-name
FRONTEND  •  running            [Visit app.ai-agents.com ↗]
```

**Tab bar:** `Overview` | `Logs` | `Deployment Logs`

---

#### Tab 1 — Overview

Period picker: `24h / 7d / 30d` (top right)

4 stat cards:
```
┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│ Visitors  │ │Page Views │ │API Reqs   │ │Bandwidth  │
│   1,240   │ │   3,812   │ │   9,004   │ │    —      │
│  +12%     │ │   +8%     │ │  +21%     │ │  n/a      │
└───────────┘ └───────────┘ └───────────┘ └───────────┘
```

Bandwidth cell shows `—` with tooltip: "Bandwidth tracking coming soon"

Trend badges: green `+X%` / red `-X%` comparing first half vs second half of timeseries.

Below stats: **Failing Requests** table
```
[red]  /api/v1/webhooks    500   backend   12 hits
[amber] /api/v1/users/me   401   backend   47 hits
```

Data source: `GET /api/workspaces/:id/analytics?period=X`

Auto-refreshes every 30s.

---

#### Tab 2 — Logs

Toolbar:
```
[type filter: all/frontend/backend]  [layout toggle]  [search...]  [Live ●]  [refresh]  [download CSV]
```

Column headers:
```
Time          Status    Host          Request     Messages          Latency/Country
```

Log rows (same rendering as `system/[id]/analytics` logs tab):
```
Jun 9 14:32   GET 200   app.prett..   /dashboard  [Backend] Req..   42ms  US
Jun 9 14:31   POST 201  api.prett..   /api/users  [Backend] Req..   118ms GB
```

- Status: method + code (emerald=2xx, amber=4xx, red=5xx)
- Polls `GET /api/workspaces/:id/request-logs` every 5s for new entries
- Load more pagination via `before` cursor

---

#### Tab 3 — Deployment Logs

**Sub-view A — Deployment list** (default):

```
●  SUCCESS   FRONTEND   Jun 9 14:30   3m 12s   [Visit ↗]
✕  FAILED    BACKEND    Jun 8 09:11   1m 04s
●  SUCCESS   FRONTEND   Jun 7 18:44   2m 58s
```

Click a row → Sub-view B

**Sub-view B — Build log detail:**

```
[← Deployments]

[preview screenshot / failed placeholder]

Created: Jun 9 14:30     Status: Ready        Duration: 3m 12s
URL: app.ai-agents.com  Environment: Prod    Type: FRONTEND

─── Build Log ──────────────────────────────────────
Time        Status   Messages
14:30:01    LOG OK   Cloning repository from source...
14:30:04    LOG OK   Installing dependencies with pnpm...
14:31:12    LOG OK   Running next build...
14:33:02    LOG OK   Deployment live at https://app...
```

Uses exact same log rendering from `DeploymentsTab` component.
Live SSE stream for recent deployments (< 10 min old), DB logs for older ones.

---

### Empty State (no deployments anywhere)

```
[Rocket icon]
No servers deployed yet
Deploy a project to see your servers here.
[Go to projects]  →  links to /
```

---

---

## Files Changed

| File | Change |
|---|---|
| `backend/src/services/workspaceDatabaseExplorerService.ts` | Add `getStats(workspaceId)` method |
| `backend/src/routes/workspaces.ts` | Add `GET /:id/database/stats` route |
| `client/app/databases/page.tsx` | Full rewrite (was "Coming Soon") |
| `client/app/deployments/page.tsx` | Full rewrite (was "Coming Soon") |

No new dependencies required. All UI uses existing patterns (SVG rings, Tailwind, Lucide icons, Framer Motion, Chart.js already installed).

---

## Notes

- **Bandwidth**: Not tracked by the current analytics pipeline (ClickHouse). Shown as `—` with "coming soon" tooltip. Can be added later by logging response content-length in the infra layer.
- **SSH access**: Deferred. Will be added as a 4th tab on the server detail once an SSH credentials endpoint is built.
- **DB max size**: Controlled by env var `DB_MAX_SIZE_GB` (default `0.5`). Can be changed per-deployment tier later.
- **Stats caching**: DB stats are fetched once on card load. Manual refresh re-fetches. No auto-poll (stats don't change fast enough to warrant it).
- **Deployment flattening**: On page load, fetch all workspaces, then for each workspace fetch its deployments. Flatten into a single list sorted by `createdAt` desc. This means N+1 fetches on load — acceptable for now, can be optimized with a `/api/deployments/all` aggregate endpoint later.
