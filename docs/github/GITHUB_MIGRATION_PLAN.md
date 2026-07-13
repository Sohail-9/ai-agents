# Infra Migration Plan: Coregit → GitHub

## Background

AI Agents deployments start with `git clone $GIT_URL` in both
`fargate-entrypoint.sh` (frontend/backend build) and `runner-entrypoint.sh`
(persistent backend EC2 runner). Previously `GIT_URL` was a Coregit URL with
credentials embedded: `https://org:COREGIT_API_KEY@api.coregit.dev/org/repo.git`.

With the migration, `GIT_URL` is now a private GitHub URL. All changes in this
repo fall into three buckets:

| Bucket | Files affected |
|--------|---------------|
| A — Replace `COREGIT_TOKEN` with `GITHUB_TOKEN` | `deploy-ec2.sh` (lines 81, 113) |
| B — Pass `GITHUB_TOKEN` into Fargate task | `processor.ts`, `fargate-entrypoint.sh`, `runner-entrypoint.sh` |
| C — Prevent token leaking into deployed apps + logs | `deploy-frontend.sh`, `deploy-backend.sh`, `fargate-entrypoint.sh`, `runner-entrypoint.sh` |

**Nothing else changes.** AWS infra (ECS, Lambda, ALB, S3, CloudFront), BullMQ
architecture, ClickHouse analytics, and all build/package/upload scripts are
completely git-URL-agnostic.

---

## Change Inventory

### Change 1 — `scripts/deploy-ec2.sh`

**Why:** Lines 81 and 113 pass `COREGIT_TOKEN` as an env var to the orchestrator
Docker container. No such token exists anymore.

**Line 81** (`export` block):
```bash
# REMOVE:
export COREGIT_TOKEN="${COREGIT_TOKEN}"

# ADD:
export GITHUB_TOKEN="${GITHUB_TOKEN}"
```

**Line 113** (Docker Compose `environment:` section):
```yaml
# REMOVE:
- COREGIT_TOKEN=${COREGIT_TOKEN}

# ADD:
- GITHUB_TOKEN=${GITHUB_TOKEN}
```

---

### Change 2 — `src/worker/processor.ts`

**Why:** The orchestrator worker builds `environmentOverrides` for each Fargate
task. `GITHUB_TOKEN` is not currently forwarded, so the Fargate container has
no way to authenticate git clone against private GitHub repos.

**In the `environmentOverrides` array** (after the existing AWS_REGION entry):
```typescript
// ADD after existing entries:
{ name: 'GITHUB_TOKEN', value: process.env.GITHUB_TOKEN || '' },
```

**Also add to the `COREGIT_TOKEN`-equivalent block — there is no explicit block,
just remove the implicit assumption.** The `jobEnv` merge loop already filters
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` — that is fine as-is.

---

### Change 3 — `scripts/fargate-entrypoint.sh`

Two sub-changes:

#### 3a — Inject GitHub credentials before clone

Add **before** the `git clone` line (currently line 31):
```bash
# Authenticate git for private GitHub repos.
# Core backend embeds token in GIT_URL as x-access-token; this config
# ensures auth works even if a bare https://github.com/... URL is passed.
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global \
    url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf \
    "https://github.com/"
fi
```

#### 3b — Mask GIT_URL in log output

**Line 22** currently prints the full URL including any embedded token:
```bash
log "Building workspace=$WORKSPACE_ID project=$PROJECT_ID from $GIT_URL"
```

Replace with:
```bash
SAFE_GIT_URL=$(echo "$GIT_URL" | sed 's|https://[^@]*@|https://***@|g')
log "Building workspace=$WORKSPACE_ID project=$PROJECT_ID from $SAFE_GIT_URL"
```

---

### Change 4 — `scripts/runner-entrypoint.sh`

Same two sub-changes as the fargate entrypoint.

#### 4a — Inject GitHub credentials before clone

Add **before** the `git clone` line (currently line 17):
```bash
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global \
    url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf \
    "https://github.com/"
fi
```

#### 4b — Mask GIT_URL in log

**Line 16** (`log "Cloning $GIT_URL..."`):
```bash
# REMOVE:
log "Cloning $GIT_URL..."

# ADD:
SAFE_GIT_URL=$(echo "$GIT_URL" | sed 's|https://[^@]*@|https://***@|g')
log "Cloning $SAFE_GIT_URL..."
```

---

### Change 5 — `scripts/deploy-frontend.sh`

**Why:** Line 28 generates `.env.production` by dumping all env vars except a
blocklist. `GITHUB_TOKEN` (and future `GITHUB_APP_*` vars) pass through that
filter and would be **baked into the deployed Lambda's environment**, exposing
them to every Lambda invocation.

**Line 28** — add `GITHUB_` to the exclusion pattern:
```bash
# CURRENT:
env | grep -vE '^(AWS_|SST_|GIT_|WORKSPACE_|PROJECT_|ARTIFACT_|BACKEND_|DEPLOY_|DOMAIN|FRONTEND_DIR|USER_REPO_DIR|PATH|PWD|HOME|USER|SHELL|HOSTNAME|SHLVL|NEXT_PUBLIC_API_URL|NEXT_PUBLIC_BACKEND_URL|_)'

# REPLACE WITH:
env | grep -vE '^(AWS_|SST_|GIT_|GITHUB_|WORKSPACE_|PROJECT_|ARTIFACT_|BACKEND_|DEPLOY_|DOMAIN|FRONTEND_DIR|USER_REPO_DIR|PATH|PWD|HOME|USER|SHELL|HOSTNAME|SHLVL|NEXT_PUBLIC_API_URL|NEXT_PUBLIC_BACKEND_URL|_)'
```

---

### Change 6 — `scripts/deploy-backend.sh`

**Why:** Lines 32–33 build `USER_ENV_JSON` from all env vars except a blocklist.
`GITHUB_TOKEN` passes through and would be injected into every backend ECS
container's environment — it stays resident in the long-running container and
is visible in `DescribeTasks` API responses.

**Lines 32–33** — add `GITHUB_` to the exclusion pattern:
```bash
# CURRENT:
USER_ENV_JSON=$(env \
  | grep -vE '^(AWS_|SST_|GIT_|WORKSPACE_|PROJECT_|ARTIFACT_|BACKEND_|DEPLOY_|DOMAIN|FRONTEND_DIR|BACKEND_DIR|USER_REPO_DIR|PATH|PWD|HOME|USER|SHELL|HOSTNAME|SHLVL|ECS_|_)'

# REPLACE WITH:
USER_ENV_JSON=$(env \
  | grep -vE '^(AWS_|SST_|GIT_|GITHUB_|WORKSPACE_|PROJECT_|ARTIFACT_|BACKEND_|DEPLOY_|DOMAIN|FRONTEND_DIR|BACKEND_DIR|USER_REPO_DIR|PATH|PWD|HOME|USER|SHELL|HOSTNAME|SHLVL|ECS_|_)'
```

---

### Change 7 — `.env.example`

Add GitHub infra section and clarify existing `GITHUB_TOKEN`:

```bash
# --- REMOVE this comment (it's misleading): ---
# Github Integration
GITHUB_TOKEN=

# --- REPLACE WITH: ---

# GitHub — OAuth (existing user connection feature)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# GitHub — Infra (used by worker → Fargate → git clone for private workspace repos)
# Set to a GitHub App installation access token OR a PAT with repo scope.
# The core backend generates a fresh token per deploy and embeds it in GIT_URL;
# this var is the fallback for local dev / manual deploys.
GITHUB_TOKEN=

# GitHub App credentials (used by core backend to generate short-lived tokens)
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_WORKSPACE_ORG=
```

---

## Core Backend Changes (ai-agents-core/backend)

These are not infra-repo changes but must ship before or with the infra changes
to avoid broken deployments.

### Where to find the deploy trigger

Search for `POST` calls to the infra deploy endpoint in `ai-agents-core/backend`:
```
grep -r "infra\|INFRA_URL\|deploy-orchestrator\|/deploy" backend/src --include="*.ts"
```

### What to change

Wherever the core backend calls `POST <INFRA_URL>/deploy`, it must now pass an
authenticated GitHub URL instead of a Coregit URL.

**Two workspace cases:**

#### Case A — Workspace with `githubConnected = true` (AI Agents-managed repo)

```typescript
import { createAppAuth } from "@octokit/auth-app";

// Generate a short-lived (1hr) installation access token
const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  installationId: parseInt(process.env.GITHUB_APP_INSTALLATION_ID!),
});
const { token } = await auth({ type: "installation" });

const gitUrl = `https://x-access-token:${token}@github.com/${workspace.githubOwner}/${workspace.githubRepo}.git`;
```

#### Case B — GitHub-imported workspace (user's own repo, `githubConnected = false`)

```typescript
const account = await getGithubAccount(workspace.userId);
if (!account?.accessToken) throw new Error("GitHub account not connected");

const config = workspace.config as any;
const gitUrl = `https://x-access-token:${account.accessToken}@github.com/${config.owner}/${config.repo}.git`;
```

#### Case C — Non-GitHub workspace (no GitHub repo yet)

Block the deploy with a clear error:
```typescript
if (!workspace.githubConnected && workspace.config?.source !== "github") {
  return res.status(400).json({
    error: "Connect GitHub before deploying. Visit Settings → Connect GitHub.",
  });
}
```

### POST /deploy payload (final shape)

```typescript
await fetch(`${process.env.INFRA_URL}/deploy`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    githubUrl: gitUrl,          // authenticated GitHub clone URL
    workspaceId: workspace.id,
    projectId: workspace.id,
    type: deployType,           // "frontend" | "backend" | "fullstack"
    env: workspace.env ?? {},   // user-set env vars
  }),
});
```

---

## End-to-End Flow After Migration

```
User clicks Deploy
       ↓
core backend: resolve workspace
       ↓
githubConnected? ─── yes ──→ generate GitHub App token
       │                     construct: https://x-access-token:TOKEN@github.com/org/repo.git
       └─── no (imported) → use GithubAccount.accessToken
                             construct: https://x-access-token:TOKEN@github.com/owner/repo.git
       ↓
POST /deploy to infra with { githubUrl: authenticatedUrl, ... }
       ↓
processor.ts: enqueue BullMQ job
       ↓
processor.ts worker: RunTask → Fargate with environmentOverrides including GITHUB_TOKEN
       ↓
fargate-entrypoint.sh:
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  git clone --depth 1 "${GIT_URL}"   ← token auth from either URL or git config
  detect: frontend / backend / fullstack
       ↓
deploy-frontend.sh:
  env filter excludes GITHUB_*
  pnpm install → open-next build → Lambda deploy → callback

deploy-backend.sh:
  env filter excludes GITHUB_*
  ECS task with GIT_URL (no token in runner's env)
       ↓
runner-entrypoint.sh (inside backend ECS container):
  git config --global ... GITHUB_TOKEN (passed via GIT_URL or token var)
  git clone → pnpm install → npm start
       ↓
callback to core backend: { status: "success", url: "https://..." }
```

---

## What Does NOT Change

| Component | Reason unchanged |
|-----------|-----------------|
| `sst.config.ts` | CloudFront/Lambda infra — no git dependency |
| `docker-compose.yml` | Uses `env_file: .env`; picks up GITHUB_TOKEN automatically |
| `orchestrator.Dockerfile` | Just a Node runtime, no git auth needed |
| `deployer.Dockerfile` | Git is installed; auth comes from env at runtime |
| `runner.Dockerfile` | Git is installed; auth comes from GITHUB_TOKEN at runtime |
| `src/index.ts` | Generic `/deploy` endpoint; already accepts any URL |
| `src/worker/processor.ts` (core logic) | BullMQ/ECS orchestration unchanged; only one env var added |
| ClickHouse analytics | Completely unrelated to version control |
| ALB/ECS backend routing | No git dependency |
| CloudFront edge router | No git dependency |

---

## Rollout Order

1. **Deploy-ec2.sh** (if re-provisioning EC2) — or manually update running container's GITHUB_TOKEN env
2. **processor.ts** — add GITHUB_TOKEN to Fargate env overrides
3. **deploy-frontend.sh + deploy-backend.sh** — add GITHUB_ to filter (security, do first)
4. **fargate-entrypoint.sh + runner-entrypoint.sh** — add git auth + log masking
5. **Core backend** — update deploy trigger to construct authenticated GitHub URL
6. **Rebuild + push images**: `deployer.Dockerfile` → ECR, `runner.Dockerfile` → ECR

**Steps 3 and 4 are safe to deploy before the core backend sends GitHub URLs** —
they add auth capability and filter improvements. Nothing breaks for existing
Coregit deployments (GITHUB_TOKEN would just be empty/unused).

---

## Verification Checklist

- [ ] `POST /deploy` with valid `githubUrl` pointing to a private GitHub repo returns `202`
- [ ] Fargate task logs show `"Cloning https://***@..."` (masked, not raw token)
- [ ] Frontend Lambda deploys successfully; deployed app has no `GITHUB_TOKEN` in its env
- [ ] Backend ECS container deploys successfully; `DescribeTasks` env JSON has no `GITHUB_TOKEN`
- [ ] `/health` on orchestrator returns `{ status: "ok" }`
- [ ] `/logs/:jobId` SSE streams CloudWatch logs from Fargate task
- [ ] `deploy-callback` fires to core backend with `status: "success"` + URL
- [ ] `workspace.githubConnected=false` workspace returns 400 "Connect GitHub first" (core backend)

---

## Security Notes

- **Never log raw `GIT_URL`** when it contains embedded credentials. The `sed` masking
  in Changes 3b and 4b handles this. Ensure CloudWatch log retention is set
  appropriately even after masking.
- **Never pass `GITHUB_TOKEN` into deployed apps** (Lambda env or ECS backend env).
  Changes 5 and 6 enforce this. The token is only needed at build/clone time.
- **GitHub App tokens expire in 1 hour.** The core backend must generate a fresh
  token per deploy call — do not cache them.
- **`GITHUB_APP_PRIVATE_KEY` is extremely sensitive.** Store in AWS Secrets Manager
  or Parameter Store, not plaintext `.env` on EC2.
