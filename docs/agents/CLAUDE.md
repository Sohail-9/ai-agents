# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Root (monorepo convenience scripts):**
```bash
npm run dev       # runs backend + worker + client concurrently
npm run build     # builds backend + client
npm run generate  # generates Prisma client
npm run lint      # lints client only
```

**Backend (`cd backend`):**
```bash
npm run dev                    # Express API server with tsx watch
npm run worker                 # all workers (set WORKER_KIND=agent|setup|import|github-sync|reaper|prewarm|billing|all)
npm run build                  # tsc + copy Prisma artifacts to dist/
npm run db:migrate             # run Prisma migrations
npm run db:generate            # regenerate Prisma client
```

**Client (`cd client`):**
```bash
npm run dev    # Next.js dev server
npm run build  # production bundle
npm run lint   # ESLint
```

**Targeted test scripts (backend):**
```bash
npm run test:agent-wave
npm run test:plan-dependency
npm run test:sandbox-lifecycle
npm run test:agent-lock
```

## Architecture

PrettiFlow is an AI-powered code assistant that scaffolds and edits full-stack projects inside E2B sandboxes. It's an npm workspaces monorepo with `backend/` (Node.js/Express) and `client/` (Next.js 16 + React 19).

### Request Lifecycle

1. Client submits prompt → Express REST API (`backend/src/routes/`)
2. API enqueues BullMQ job → Redis (Upstash)
3. Worker picks up job → `backend/src/workers/agentWorker.ts`
4. Agent orchestrator (`backend/src/brain/agentRunner.ts`) drives multi-turn LLM loop
5. Skills layer (`backend/src/skills/`) executes tools inside E2B sandbox
6. Results stream back to client via WebSocket (`backend/src/ws/`)
7. All state persisted to PostgreSQL via Prisma

### Key Directories

| Path | Purpose |
|------|---------|
| `backend/src/brain/` | LLM orchestration, prompt construction, multi-agent coordination |
| `backend/src/workers/` | BullMQ workers split by kind: `agent`, `setup`, `import`, `github-sync`, `reaper`, `prewarm`, `billing` |
| `backend/src/skills/` | Tool implementations — file ops, shell, code search, web search, DB provisioning, architect, plan, frontend-design, env |
| `backend/src/sandbox/` | E2B sandbox lifecycle: prewarm, reap, normalize |
| `backend/src/memory/` | Conversation summarization and workspace context retrieval |
| `backend/src/guardrails/` | 4-layer safety: deduplication, AI judge, semantic guards, PII redaction |
| `backend/src/services/` | Data access layer (user, workspace, message, request, todo, github, billing) |
| `backend/src/billing/` | Credit tracking and usage normalization across LLM providers |
| `backend/prisma/` | Prisma schema + migrations |
| `client/app/` | Next.js App Router pages (workspaces, databases, deployments, settings, auth) |
| `client/components/` | Shared React components |
| `client/contexts/` | Global React state (workspace, auth, websocket) |

### Worker Isolation

Workers run as separate PM2 processes (see `backend/ecosystem.config.cjs`). `WORKER_KIND` env var controls which queues a worker instance subscribes to. Default prod layout: 4 agent workers, 1 API, 1 each for setup/import/github-sync/reaper/prewarm/billing. This prevents long-running agent jobs from starving setup/import jobs.

### Multi-Model LLM

Supports Anthropic Claude (primary), OpenAI, Groq, Gemini, and Qwen (DashScope). Model routing is inside `backend/src/brain/`. Key env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `GOOGLE_GENAI_API_KEY`, `QWEN_API_KEY`.

### Database

PostgreSQL (Neon serverless) with pgvector. Key models: `User`, `Workspace`, `Request`, `Message`, `Todo`, `AgentRun`, `WorkspaceMemory`, `CreditLedger`, `ProjectMemo`, `Database`, `GithubAccount`.

Two DB connection strings in env: `DATABASE_URL` (standard) and `DATABASE_URL_DIRECT` (direct non-pooled, required for migrations).

### Auth

Clerk handles auth. JWT verified on every API request. Clerk webhooks sync user creation/deletion to PostgreSQL. Client env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`.

### Real-time

WebSocket server co-located with Express (`backend/src/ws/`). Redis pub/sub bridges worker processes to the WS server so agent progress from any worker process reaches the right client connection.

## Environment Setup

Copy `backend/.env.example` → `backend/.env`. Minimum for local dev: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY` (or another LLM key), `CLERK_SECRET_KEY`, `E2B_API_KEY`.

For local DB/Redis without cloud accounts: `docker-compose.yaml` at root provides PostgreSQL + Redis.

## Deployment

GitHub Actions (`.github/workflows/main.yml`) triggers on push to `development`. Backend deploys via PM2 on server; client deploys to Vercel with `vercel --prod --yes`.
