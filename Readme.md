# AI Agents

<p align="center">
  <img width="100%" alt="AI Agents Banner" src="docs/images/banner.png" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-ISC-blue.svg" alt="ISC License" /></a>
  <img src="https://img.shields.io/badge/Language-TypeScript-007acc?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Client-Next.js%2016-black?logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/Backend-Express-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Database-PostgreSQL-336791?logo=postgresql&logoColor=white" alt="Database" />
  <img src="https://img.shields.io/badge/Sandbox-E2B-ff5722?logo=e2b&logoColor=white" alt="E2B" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Task_Queue-BullMQ-ff0000?style=flat-square" alt="BullMQ" />
  <img src="https://img.shields.io/badge/Real--Time-WebSockets%20%26%20Redis-007acc?style=flat-square" alt="WebSockets" />
  <img src="https://img.shields.io/badge/Auth-Clerk-6C47FF?logo=clerk&logoColor=white" alt="Clerk" />
  <img src="https://img.shields.io/badge/Safety-4_Layer_Guardrails-brightgreen?style=flat-square" alt="Safety" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Anthropic_Claude-supported-d4a574?style=flat-square" alt="Anthropic" />
  <img src="https://img.shields.io/badge/OpenAI-supported-412991?style=flat-square&logo=openai" alt="OpenAI" />
  <img src="https://img.shields.io/badge/Google_Gemini-supported-4285F4?style=flat-square&logo=google" alt="Gemini" />
  <img src="https://img.shields.io/badge/Groq-supported-f5f5f5?style=flat-square&logoColor=black" alt="Groq" />
  <img src="https://img.shields.io/badge/Qwen-supported-5c2d91?style=flat-square" alt="Qwen" />
</p>

<p align="center"><em>An AI-powered software engineer that scaffolds, builds, edits, and provisions full-stack projects inside secure, isolated E2B sandboxes.</em></p>

---

## Overview

**AI Agents** is an open-source, monorepo software development assistant designed to handle end-to-end full-stack tasks. By integrating a multi-model routing layer with secure, containerized runtime sandboxes (E2B), it allows AI agents to write code, install packages, run tests, spin up PostgreSQL/pgvector databases, and edit layouts.

Supported by a robust backend queuing system (BullMQ + Upstash Redis) and real-time streaming (WebSockets), the interface gives developers full visibility into the agent's thought process, shell execution, and live sandbox environment.

---

## How It Works (Request Lifecycle)

Every code-generation request flows through a distributed architecture designed for reliability, scalability, and safety:

```mermaid
flowchart TD
    %% Request flow
    Client[Next.js App Client] -->|Submit Request| API[Express API Server]
    API -->|Enqueue Agent Job| Redis[(Redis / Upstash)]
    Redis -->|Process Job| Worker[BullMQ Worker Process]
    Worker -->|Run Agent Loop| Brain[Agent Runner Orchestrator]
    Brain -->|Call Tool Execution| Skills[Skills Layer: File, Shell, DB]
    Skills -->|Run Command| Sandbox[E2B Code Sandbox]
    Sandbox -.->|Stream Logs / Output| WS[WebSocket Server]
    WS -->|Live Updates| Client
    Brain -->|Persist State| PostgreSQL[(PostgreSQL / Prisma)]

    style Client fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style PostgreSQL fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style Sandbox fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style WS fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
```

1. **Submit**: The frontend client submits a prompt to the Express REST API.
2. **Queue**: The API verifies the Clerk JWT and enqueues a new BullMQ job in Redis.
3. **De-queue**: A dedicated agent worker process picks up the job.
4. **Orchestrate**: The `agentRunner` orchestrates a multi-turn LLM agent loop (routing via Anthropic, OpenAI, Gemini, etc.).
5. **Execute**: The agent calls specialized tools inside an isolated E2B Sandbox.
6. **Stream**: Sandbox outputs and agent thoughts stream back to the client via WebSockets.
7. **Persist**: All state changes are written to PostgreSQL via Prisma.

---

## Features

- ⚡ **Workspace Sandboxing** - Isolated, persistent E2B Code Interpreter environments with code execution, shell access, and port-forwarding support.
- 🔄 **Multi-Model LLM Routing** - Pluggable model adapter supporting Anthropic Claude (primary), OpenAI GPTs, Groq, Gemini, and Qwen.
- 📊 **Robust Job Queue** - Powered by BullMQ and Redis for crash-resilient task processing and split-worker scaling.
- 🛡️ **4-Layer Safety Guardrails** - Hard deduplication, semantic safety checks, PII redaction, and real-time AI judge validations.
- 🛠️ **Full-Stack Skill Layer** - Out-of-the-box tools for file system edits, shell execution, database provisioning, project architecture mapping, and frontend layouts.
- 👥 **Real-Time Workspace Sync** - Redis pub/sub bridges worker outputs to WS sockets for instant UI updates.
- 💳 **Usage & Billing Engine** - Automatic token counting, credit tracking, and credit ledger normalization across LLM providers.

---

## Directory Structure

| Path | Purpose |
|------|---------|
| `backend/src/brain/` | LLM orchestration, prompt construction, model selectors, and multi-agent loops. |
| `backend/src/workers/` | BullMQ workers split by processes (`agent`, `setup`, `import`, `reaper`, `prewarm`, etc.). |
| `backend/src/skills/` | Tool implementations (file operations, shell execution, database provisioning, code analysis). |
| `backend/src/sandbox/` | E2B sandbox lifecycle manager: prewarming, normalization, and cleanups. |
| `backend/src/memory/` | Conversation summarizers and project-wide context retrievers. |
| `backend/src/guardrails/` | 4-layer security validation engine. |
| `backend/src/services/` | Data access layer (PostgreSQL databases, users, workspaces, messages, billing). |
| `client/app/` | Next.js App Router workspace, dashboard, setting panels, and auth pages. |
| `client/components/` | Reusable React 19 UI components. |
| `client/contexts/` | Global state handlers (Workspace, WebSocket connection, Authentication). |

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose (for local PG/Redis)
- API Keys:
  - **E2B API Key** (Required for code sandbox execution)
  - **Clerk Auth Keys** (Required for user authentication)
  - **Anthropic API Key** (Default primary model provider)

---

### Step 1: Install Dependencies
From the repository root, install monorepo workspace dependencies:
```bash
npm install
```

---

### Step 2: Configure Environment Variables
Copy the `.env.example` configurations and populate them:

**Backend (`backend/.env`):**
```bash
# Sandboxing
E2B_API_KEY=your-e2b-api-key

# LLM Providers (Pick at least one, Anthropic is primary)
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
GEMINI_API_KEY=your-gemini-key

# Clerk Auth Config
AUTH_SERVICE_URL=https://auth.ai-agents.com
AUTH_ISSUER=https://auth.ai-agents.com
AUTH_AUDIENCE=ai-agents

# DB & Redis (Defaults pointing to Docker are in docker-compose)
DATABASE_URL="postgresql://username:password@localhost:5432/ai-agents"
REDIS_URL="redis://localhost:6379"
```

**Client (`client/.env`):**
Configure Next.js public variables, including your Clerk publishable keys and Backend URL.

---

### Step 3: Run Database & Redis (Docker)
Start the PostgreSQL (with pgvector) and Redis instances locally:
```bash
docker-compose up -d
```

Generate the Prisma Client and run migrations:
```bash
npm run generate
```

---

### Step 4: Run Development Services
Start the Express API Server, the workers, and the Next.js Client concurrently:
```bash
npm run dev
```
- **Backend API**: Running on `http://localhost:8000`
- **Next.js Client**: Running on `http://localhost:3000`

---

## Worker Process Isolation

In production workloads, BullMQ workers run in separate PM2 processes to avoid blocking the main event loops. Configure which queues a process handles using the `WORKER_KIND` environment variable:

```bash
WORKER_KIND=agent        # Subscribes to the agent task queue
WORKER_KIND=setup        # Handles container setup / sandbox preparation
WORKER_KIND=import       # Syncs repository directories
WORKER_KIND=github-sync  # Syncs repositories with remote GitHub accounts
WORKER_KIND=all          # Default for development; runs all workers in one process
```

To run a specific worker:
```bash
# From within the backend directory
WORKER_KIND=agent npm run worker
```

---

## Testing & Benchmarks

The project comes with targeted backend testing scripts:

```bash
npm run test:sandbox-lifecycle  # Verify E2B container connectivity and setup
npm run test:sandbox-prewarm    # Benchmark prewarmed sandboxes pool
npm run test:agent-lock         # Test concurrency locks on task resources
npm run test:plan-dependency    # Verify file-edit relationship maps
npm run bench:queue             # Run BullMQ throughput benchmarks
```

---

## Deployment

- **Backend**: Deployed via PM2 to handle process lifecycle. Look at `backend/ecosystem.config.cjs` for layout details.
- **Client**: Next.js client is optimized for deployment on Vercel.

---

## License

This project is licensed under the ISC License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with 🔥 Passion in San Francisco
</p>
