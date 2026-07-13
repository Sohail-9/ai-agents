# Support Agent — Complete Technical Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Models](#3-data-models)
4. [Backend — API Routes](#4-backend--api-routes)
5. [Backend — Service Layer](#5-backend--service-layer)
6. [Backend — Agent Brain](#6-backend--agent-brain)
7. [Backend — Worker & Queue](#7-backend--worker--queue)
8. [Backend — Real-time Streaming](#8-backend--real-time-streaming)
9. [Backend — Escalation Email](#9-backend--escalation-email)
10. [Frontend — Pages](#10-frontend--pages)
11. [Frontend — Components](#11-frontend--components)
12. [WebSocket Event Protocol](#12-websocket-event-protocol)
13. [Environment Variables](#13-environment-variables)
14. [Implementation Guide](#14-implementation-guide)
15. [Testing Guide](#15-testing-guide)
16. [Known Limitations & Edge Cases](#16-known-limitations--edge-cases)

---

## 1. Overview

AI Agents's support agent is an AI-powered customer support system that lets users file support cases and receive autonomous responses from an LLM-backed agent. The agent has tools to inspect the user's workspaces, retrieve request history, search an internal knowledge base, and either resolve cases or escalate them to the human team.

**Key capabilities:**
- Create a support case tied to a workspace or account-level issue
- Real-time streaming responses (token-by-token) via WebSocket
- Tool use: workspace lookup, request details, sandbox logs, docs search
- Auto-resolve or auto-escalate with email notification
- Manual escalation and close by the user
- Thumbs up/down feedback per case

---

## 2. Architecture

```
Client Browser
    │
    ├── REST (HTTPS)
    │     └─ POST /api/support/cases             ← create case
    │     └─ POST /api/support/cases/:id/messages ← send message
    │     └─ GET  /api/support/cases/:id          ← load history
    │     └─ POST /api/support/cases/:id/escalate ← manual escalate
    │     └─ POST /api/support/cases/:id/close    ← close
    │     └─ POST /api/support/cases/:id/rate     ← feedback
    │
    └── WebSocket (WS)
          └─ /ws  (AUTH with caseId as workspaceId)
                  ↑ events: SUPPORT_AGENT_TOKEN, TOOL_CALL, DONE ...

Express API Server
    │
    ├── routes/support.ts  ← validates JWT, owns HTTP handlers
    ├── services/supportCaseService.ts  ← DB read/write
    ├── services/escalationService.ts   ← SMTP email
    └── queue/queues.ts  ← enqueues job to supportQueue (BullMQ → Redis)

Redis (Upstash)
    ├── BullMQ Queue: support-queue
    └── Pub/Sub Channel: ws-events:{caseId}

Support Worker (PM2 process)
    ├── workers/supportWorker.ts    ← BullMQ consumer
    ├── brain/supportAgent.ts       ← LLM loop + tool dispatch
    └── publishWsEvent(caseId, evt) → Redis pub/sub

Event Relay (co-located with API)
    └── queue/eventRelay.ts  ← subscribes ws-events:* → broadcasts to WS clients

PostgreSQL (Neon)
    ├── SupportCase
    └── SupportMessage
```

**Flow summary:**
1. User sends message → API creates/appends `SupportMessage`, enqueues BullMQ job
2. Worker picks up job → `SupportAgent.processMessage()` runs LLM loop
3. Each token/tool event → `publishWsEvent` → Redis pub/sub
4. EventRelay receives → pushes to open WebSocket for that caseId
5. Client accumulates tokens → renders streaming UI
6. On `SUPPORT_AGENT_DONE` client refetches full case from REST

---

## 3. Data Models

**Location:** `backend/prisma/schema.prisma`

### SupportCase

```prisma
model SupportCase {
  id             String        @id @default(cuid())
  caseNumber     Int           @default(autoincrement())
  userId         String
  title          String?
  status         CaseStatus    @default(OPEN)
  priority       CasePriority  @default(MEDIUM)
  workspaceId    String?
  escalatedAt    DateTime?
  escalationNote String?
  emailSentAt    DateTime?
  resolvedAt     DateTime?
  resolution     String?
  userRating     Int?          // 1 or -1
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  user      User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace?     @relation(fields: [workspaceId], references: [id], onDelete: SetNull)
  messages  SupportMessage[]

  @@index([userId])
  @@index([status])
  @@index([workspaceId])
}
```

### SupportMessage

```prisma
model SupportMessage {
  id        String      @id @default(cuid())
  caseId    String
  role      MessageRole  // USER | AGENT | SYSTEM
  content   String
  toolCalls Json?
  createdAt DateTime    @default(now())

  case SupportCase @relation(fields: [caseId], references: [id], onDelete: Cascade)

  @@index([caseId])
}
```

### Enums

```prisma
enum CaseStatus   { OPEN  RESOLVED  ESCALATED  CLOSED }
enum CasePriority { LOW  MEDIUM  HIGH  URGENT }
enum MessageRole  { USER  AGENT  SYSTEM }
```

---

## 4. Backend — API Routes

**File:** `backend/src/routes/support.ts`  
**Mount point:** `/api/support`  
All routes require Bearer JWT (verified via Clerk middleware).

| Method | Path | Description | Body / Params |
|--------|------|-------------|---------------|
| `POST` | `/cases` | Create new support case | `{ message: string, workspaceId?: string }` |
| `GET` | `/cases/count` | Count OPEN + ESCALATED (nav badge) | — |
| `GET` | `/cases` | List user's cases | `?status=OPEN\|RESOLVED\|ESCALATED\|CLOSED` |
| `GET` | `/cases/:caseId` | Full case with all messages | — |
| `POST` | `/cases/:caseId/messages` | Add user message + trigger agent | `{ message: string }` |
| `POST` | `/cases/:caseId/escalate` | Manual escalation | — |
| `POST` | `/cases/:caseId/close` | Close case | — |
| `POST` | `/cases/:caseId/rate` | Submit rating | `{ rating: 1 \| -1 }` |

**Authorization pattern:** every route fetches the case and verifies `case.userId === req.userId`. Returns `403` on mismatch.

**Create case flow:**
```
POST /cases
  → supportCaseService.createCase(userId, message, workspaceId)
  → supportQueue.add('process', { caseId, userId })
  → returns { id, caseNumber, status: 'OPEN', messages: [...] }
```

**Add message flow:**
```
POST /cases/:caseId/messages
  → supportCaseService.addMessage(caseId, 'USER', content)
  → supportQueue.add('process', { caseId, userId })
  → returns { id } (the new message id)
```

---

## 5. Backend — Service Layer

**File:** `backend/src/services/supportCaseService.ts`

All methods are async, use Prisma, and throw on auth failure.

```typescript
// Create case + first user message
createCase(userId: string, initialMessage: string, workspaceId?: string): Promise<SupportCase>

// List cases for user (includes message count)
getCasesByUser(userId: string, status?: CaseStatus): Promise<SupportCase[]>

// Get single case — throws 403 if userId mismatch
getCaseById(caseId: string, userId: string): Promise<SupportCase>

// Append any message role to case
addMessage(caseId: string, role: MessageRole, content: string, toolCalls?: unknown): Promise<SupportMessage>

// Update status (+ optional resolution / escalation extras)
updateStatus(caseId: string, status: CaseStatus, extras?: {
  resolution?: string
  escalationNote?: string
  resolvedAt?: Date
  escalatedAt?: Date
}): Promise<SupportCase>

// User feedback
rateCase(caseId: string, rating: 1 | -1): Promise<void>

// Close — shorthand for updateStatus CLOSED
closeCase(caseId: string): Promise<void>

// For nav badge
getOpenCaseCount(userId: string): Promise<number>

// Track escalation email was sent
markEmailSent(caseId: string): Promise<void>
```

---

## 6. Backend — Agent Brain

**File:** `backend/src/brain/supportAgent.ts`

### LLM Configuration

Three providers tried in order:

1. **Azure OpenAI** — primary  
   Env: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`  
   Supports both `/openai/deployments/{deployment}/chat/completions` and legacy Azure endpoints.

2. **OpenAI** — fallback  
   Env: `OPENAI_API_KEY`

3. **Groq** — final fallback  
   Env: `GROQ_API_KEY`, `GROQ_BASE_URL`

### Tool Definitions

The agent has 8 tools (OpenAI function-calling format):

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `getUserWorkspaces` | List all workspaces for the authenticated user | none |
| `getWorkspaceDetails` | Get workspace info + recent requests/messages | `workspaceId: string` |
| `getRequestDetails` | Get a specific code generation request | `requestId: string` |
| `getSandboxLogs` | Fetch E2B sandbox execution logs | `workspaceId: string` |
| `searchDocs` | Search internal knowledge base | `query: string` |
| `resolveCase` | Mark case RESOLVED | `resolutionSummary: string` |
| `escalateCase` | Escalate to human team (triggers email) | `issue: string, possibleSolution: string, priority: LOW\|MEDIUM\|HIGH\|URGENT` |
| `reopenCase` | Reopen a RESOLVED case | `reason: string` |

### Knowledge Base (`searchDocs`)

Hardcoded embedded knowledge covering:
- Billing & credits
- E2B sandbox system
- GitHub integration
- Deployment process
- Database provisioning
- Code generation pipeline
- Credit purchase flow

Returns relevant section(s) as plain text.

### System Prompt

```
You are the AI Agents AI support engineer. Your job is to diagnose and 
resolve issues with AI Agents workspaces, code generation, and the platform.

Rules:
- Never use emojis
- Never use markdown headers (##, ###)
- Never use nested bullet lists
- Never offer "Would you like me to..." menus
- Answer with data from tools, not assumptions
- After 3 turns without resolution, proactively offer escalation
- When issue is fixed, call resolveCase() with a summary
- Keep responses to 2-4 concise paragraphs
- Use plain workspace names, not IDs
```

### Processing Loop

```typescript
async processMessage(caseId: string, emit: EmitFn): Promise<void>
```

1. Load case + all messages from DB (for full conversation history)
2. Load user context (workspaces, recent activity)
3. Emit `SUPPORT_AGENT_START`
4. Run streaming LLM call with tool definitions
5. **Token loop:** accumulate streaming delta tokens, emit `SUPPORT_AGENT_TOKEN` per token
6. **Tool loop (max 8 rounds):**
   - Parse `tool_calls` from `finish_reason: "tool_calls"`
   - Emit `SUPPORT_AGENT_TOOL_CALL { toolName, status: 'calling' }`
   - Dispatch tool (DB queries, knowledge search, status mutations)
   - Truncate result to 12,000 chars
   - Emit `SUPPORT_AGENT_TOOL_CALL { toolName, status: 'done' }`
   - Feed result back into next LLM call
7. Save final AGENT response to DB via `supportCaseService.addMessage`
8. Emit `SUPPORT_AGENT_DONE`

If any error occurs: emit `SUPPORT_AGENT_ERROR`, save SYSTEM error message to DB.

---

## 7. Backend — Worker & Queue

**Worker file:** `backend/src/workers/supportWorker.ts`  
**Queue file:** `backend/src/queue/queues.ts`

### Queue Configuration

```typescript
// Queue name: 'support-queue'
{
  attempts: 2,
  backoff: { type: 'exponential', delay: 500 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 200 },
}
```

### Worker Configuration

```typescript
new SupportWorker({
  concurrency: parseInt(process.env.SUPPORT_WORKER_CONCURRENCY || '10'),
  queue: 'support-queue',
})
```

### Job Payload

```typescript
{
  caseId: string,
  userId: string,
}
```

### Worker Process

```typescript
// In backend/ecosystem.config.cjs, support worker runs as:
{ name: 'support-worker', env: { WORKER_KIND: 'support' } }

// Or run locally:
WORKER_KIND=support npm run worker
```

The worker subscribes to `support-queue` and for each job calls:
```typescript
await supportAgent.processMessage(job.data.caseId, emitFn)
```

Where `emitFn` calls `publishWsEvent(caseId, event)`.

---

## 8. Backend — Real-time Streaming

**File:** `backend/src/queue/eventRelay.ts`

### Publish (from worker)

```typescript
publishWsEvent(caseId: string, event: {type: string, payload: unknown})
  → redis.publish(`ws-events:${caseId}`, JSON.stringify(event))
```

### Relay (co-located with API)

```typescript
// EventRelay subscribes to pattern: ws-events:*
// On message, extracts caseId from channel name
// Finds all connected WebSocket clients authenticated for that caseId
// Calls ws.send(JSON.stringify(event)) for each
```

### Client WebSocket Auth

Client sends on connect:
```json
{
  "type": "AUTH",
  "payload": { "workspaceId": "<caseId>" },
  "meta": { "requestId": "<uuid>", "token": "<clerk-jwt>" }
}
```

The `workspaceId` field is reused for `caseId` — the server indexes the client connection by this value.

---

## 9. Backend — Escalation Email

**File:** `backend/src/services/escalationService.ts`

### Trigger Points

1. **Agent auto-escalation:** agent calls `escalateCase()` tool → worker calls `sendEscalationEmail()`
2. **User manual escalation:** `POST /cases/:caseId/escalate` → route calls `sendEscalationEmail()`

### Email Payload

```typescript
interface EscalationPayload {
  caseId: string
  caseNumber: number
  userId: string
  userEmail: string
  userName?: string
  workspaceName?: string
  userQuery: string          // first user message in the case
  agentDiagnosis: string     // from escalateCase() tool args
  possibleSolution: string   // from escalateCase() tool args
  priority: CasePriority
  chatHistory: { role: string, content: string }[]
}
```

### Email Content

- **Subject:** `[SUPPORT] #${caseNumber} - ${priority} - ${userEmail}`
- **Recipients:** `SUPPORT_ADMIN_EMAILS` env var (comma-separated)
- **HTML template:** case header, user info card, workspace, original query, agent diagnosis, possible fix, full chat transcript, CTA link to case in dashboard

### SMTP Configuration

```
SMTP_HOST=smtp.gmail.com  (or any SMTP)
SMTP_PORT=587
SMTP_USER=support@ai-agents.com
SMTP_PASS=<app-password>
SMTP_FROM="AI Agents Support <support@ai-agents.com>"
SUPPORT_ADMIN_EMAILS=amit@ai-agents.com,shyam@ai-agents.com
```

---

## 10. Frontend — Pages

### `client/app/support/page.tsx` — Case List

- Fetches `GET /api/support/cases` with optional status filter
- Filter tabs: All, Open, Resolved, Escalated, Closed
- Renders `<CaseCard>` per case
- Empty state with link to create new case
- Loading skeleton (3 placeholder cards)
- Error state

### `client/app/support/new/page.tsx` — Create Case

- Hero section explaining the AI support agent
- Optional workspace picker (dropdown chip in input bar)
- Textarea input (same `SupportChatInput` component)
- On submit: `POST /api/support/cases` → redirect to `/support/{newCaseId}`
- Shows loading spinner while creating

### `client/app/support/[caseId]/page.tsx` — Case Detail

**State:**
```typescript
supportCase: SupportCase | null      // loaded from REST
agentRunning: boolean                // true while WS streaming
streamingText: string                // accumulated token stream
activeToolCalls: ToolCall[]          // { id, toolName, status }
agentStartTimeRef: Ref<number>       // Date.now() at AGENT_START
input: string                        // textarea value
sending: boolean                     // POST in flight
agentError: string | null            // shown inline
confirmMode: null | 'escalate' | 'close'
userScrolledUp: boolean              // suppress auto-scroll
showScrollBtn: boolean               // show scroll CTA
```

**Streaming render (two phases):**

| Phase | Condition | Renders |
|-------|-----------|---------|
| Thinking | `agentRunning && !streamingText` | `<AgentThinkingState>` with cycling labels |
| Streaming | `agentRunning && streamingText` | Avatar + `<AgentMarkdown>` + cursor |
| Done | `!agentRunning` | Historical `<ChatMessage>` from refetched case |

**Auto-scroll logic:**
- Tracks `userScrolledUp` via scroll event
- If user has scrolled up: shows `showScrollBtn`, stops auto-scroll
- `scrollIntoView({ behavior: 'smooth' })` on new messages when near bottom

---

## 11. Frontend — Components

**All located in `client/components/support/`**

### `ChatMessage.tsx`

```typescript
interface ChatMessageProps {
  role: 'USER' | 'AGENT' | 'SYSTEM'
  content: string
  isStreaming?: boolean
  onRate?: (rating: 1 | -1) => Promise<void>
  children?: React.ReactNode    // e.g. ToolCallPills above message
}
```

**Exported:**
- `ChatMessage` — main component
- `AgentMarkdown` — markdown renderer (also used in page.tsx for live streaming)

**`AgentMarkdown` parsing:**
- ` ```lang ... ``` ` → `<pre>` code block with monospace
- `# / ## / ###` → bold `<p>` (headers suppressed)
- `- / * / +` lists → `<ul>` with `list-disc`
- ` **bold** ` → `<strong>`
- ` *italic* ` → `<em>`
- ` `code` ` → `<code>` with pink brand color
- Paragraphs → `<p>` with `leading-[1.75]`

### `AgentThinkingState.tsx`

```typescript
interface AgentThinkingStateProps {
  activeToolCalls: { id: string, toolName: string, status: 'calling' | 'done' }[]
  startTime: number    // Date.now() at SUPPORT_AGENT_START
}
```

- Cycles through: Thinking → Analyzing → Working → Investigating → Processing (every 3s)
- Animated gradient dot
- Elapsed timer (starts at 0, ticks per second)
- Animated tool call pills
- Shimmer progress bar using `@keyframes shimmer`
- Framer-motion enter/exit transitions

### `ToolCallPill.tsx`

```typescript
interface ToolCallPillProps {
  toolName: string    // must match TOOL_LABELS keys
  status: 'calling' | 'done'
}
```

Tool label and icon map:
```
getUserWorkspaces    → Folder       "Checking your workspaces"
getWorkspaceDetails  → Code         "Reading workspace details"
getRequestDetails    → Terminal     "Looking up request"
getSandboxLogs       → Terminal     "Fetching sandbox logs"
searchDocs           → BookOpen     "Searching documentation"
resolveCase          → CheckCircle2 "Marking as resolved"
escalateCase         → AlertTriangle "Escalating to support team"
reopenCase           → RotateCcw   "Reopening case"
```

### `SupportChatInput.tsx`

```typescript
interface SupportChatInputProps {
  workspaces?: Workspace[]           // only on /support/new
  selectedWorkspaceId?: string       // only on /support/new
  onWorkspaceChange?: (id: string) => void
  onSend: (message: string) => void
  disabled?: boolean
  isStreaming?: boolean
  onStop?: () => void
  value: string
  onChange: (value: string) => void
  placeholder?: string
}
```

- Enter → send, Shift+Enter → newline
- Auto-resize textarea: min 84px, max 180px
- Disabled + opacity-40 when `disabled || isStreaming`
- Placeholder changes to "Agent is responding..." when streaming
- Stop button replaces Send when `isStreaming && onStop` provided

### `CaseStatusBadge.tsx`

```
OPEN       → amber  bg-amber-500/15   text-amber-400
RESOLVED   → green  bg-emerald-500/15 text-emerald-400
ESCALATED  → red    bg-red-500/15     text-red-400
CLOSED     → gray   bg-white/5        text-white/40
```

### `CaseCard.tsx`

Link card used on `/support` list page. Shows case #, title, first message preview (truncated), status badge, relative timestamp, message count.

---

## 12. WebSocket Event Protocol

All events follow:
```json
{
  "type": "EVENT_TYPE",
  "payload": { ... }
}
```

### Client → Server

```json
// Authentication (must be first message after connect)
{
  "type": "AUTH",
  "payload": { "workspaceId": "<caseId>" },
  "meta": { "requestId": "<uuid>", "token": "<clerk-jwt>" }
}
```

### Server → Client (support events)

| Event Type | Payload | Action |
|-----------|---------|--------|
| `SUPPORT_AGENT_START` | `{ caseId }` | Set `agentRunning=true`, clear `streamingText`, reset `activeToolCalls` |
| `SUPPORT_AGENT_TOKEN` | `{ caseId, token }` | Append `token` to `streamingText` |
| `SUPPORT_AGENT_TOOL_CALL` | `{ caseId, toolName, status: 'calling'\|'done' }` | Add pill or update pill status |
| `SUPPORT_AGENT_DONE` | `{ caseId }` | Set `agentRunning=false`, refetch case from REST, clear streaming state |
| `SUPPORT_AGENT_ERROR` | `{ caseId }` | Show inline error, refetch case |
| `SUPPORT_CASE_STATUS` | `{ caseId, status }` | Update `supportCase.status` in local state |

---

## 13. Environment Variables

### Backend (`backend/.env`)

```bash
# LLM — Primary (Azure OpenAI)
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-02-01

# LLM — Fallbacks
OPENAI_API_KEY=
GROQ_API_KEY=
GROQ_BASE_URL=https://api.groq.com/openai/v1

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=support@ai-agents.com
SMTP_PASS=
SMTP_FROM="AI Agents Support <support@ai-agents.com>"
SUPPORT_ADMIN_EMAILS=amit@ai-agents.com,shyam@ai-agents.com

# Links
FRONTEND_URL=https://app.ai-agents.com

# Queue
REDIS_URL=redis://...
SUPPORT_WORKER_CONCURRENCY=10
```

---

## 14. Implementation Guide

### Adding a New Agent Tool

1. **Define the tool** in `backend/src/brain/supportAgent.ts` in the `tools` array:
```typescript
{
  type: 'function',
  function: {
    name: 'myNewTool',
    description: 'What this tool does',
    parameters: {
      type: 'object',
      properties: {
        myParam: { type: 'string', description: '...' }
      },
      required: ['myParam']
    }
  }
}
```

2. **Handle the tool call** in the `dispatchTool(name, args)` method:
```typescript
case 'myNewTool': {
  const result = await doSomething(args.myParam)
  return JSON.stringify(result)
}
```

3. **Add a UI pill** in `client/components/support/ToolCallPill.tsx`:
```typescript
const TOOL_LABELS = {
  // ...existing
  myNewTool: 'Doing the thing',
}
const TOOL_ICONS = {
  // ...existing
  myNewTool: Sparkles,  // any Lucide icon
}
```

### Adding a New API Endpoint

1. Add route handler in `backend/src/routes/support.ts`
2. Add service method in `backend/src/services/supportCaseService.ts`
3. If it changes status, emit `SUPPORT_CASE_STATUS` via `publishWsEvent`
4. Add corresponding client fetch in `client/app/support/[caseId]/page.tsx`

### Changing the System Prompt

Edit the `SYSTEM_PROMPT` constant in `backend/src/brain/supportAgent.ts`.  
Keep constraints:
- No emojis (agent tends to add them without this rule)
- No markdown headers (they render poorly in plain chat UI)
- Max 4 paragraphs (prevents wall-of-text responses)

### Adding to the Knowledge Base

Edit the `KNOWLEDGE_BASE` map in the `searchDocs` tool handler in `supportAgent.ts`. Keys are topic names, values are plain text sections. The tool does keyword matching — more specific keys = better retrieval.

### Modifying the Email Template

Edit `sendEscalationEmail` in `backend/src/services/escalationService.ts`. The HTML template is inline in the function. Update the `htmlBody` variable.

---

## 15. Testing Guide

### Local Setup

```bash
# 1. Start dependencies
docker-compose up -d   # PostgreSQL + Redis

# 2. Run migrations
cd backend && npm run db:migrate

# 3. Start all services
cd ../ && npm run dev  # starts API + support-worker + Next.js
```

### Manual End-to-End Test

**Test: Create case and receive response**
1. Navigate to `http://localhost:3000/support/new`
2. Type a question (e.g., "My workspace is stuck generating code")
3. Optionally select a workspace
4. Click Send
5. Should redirect to `/support/{caseId}`
6. **Expected:** Thinking phase appears (cycling label, shimmer bar)
7. **Expected:** Text streams in token-by-token
8. **Expected:** No layout snap when streaming completes
9. **Expected:** Rating buttons appear after response

**Test: Tool call visibility**
1. Ask "What workspaces do I have?"
2. **Expected:** "Checking your workspaces" pill appears during tool call
3. **Expected:** Pill shows green check when done
4. **Expected:** Response includes actual workspace names

**Test: Manual escalation**
1. Open any case
2. Click "Escalate" button in header
3. Confirm in the inline confirmation bar
4. **Expected:** Status badge changes to ESCALATED
5. **Expected:** Escalation email sent to `SUPPORT_ADMIN_EMAILS`
6. **Expected:** Input disabled (can still type, just status changed)

**Test: Close case**
1. Open any case
2. Click "Close" → Confirm
3. **Expected:** Banner at bottom: lock icon + "This case is closed."
4. **Expected:** Chat input hidden

**Test: Auto-scroll behavior**
1. Create a case with many messages
2. Scroll up manually
3. Send a new message
4. **Expected:** Scroll button appears (chevron down, bottom right)
5. **Expected:** Auto-scroll paused
6. Click scroll button
7. **Expected:** Scrolls to bottom, button disappears

**Test: Streaming layout stability**
1. Ask a question that produces a long markdown response (lists, code blocks)
2. Watch while streaming
3. **Expected:** No visible "snap" or height collapse when streaming finishes
4. **Expected:** AgentMarkdown structure is identical during and after stream

**Test: Reconnect on disconnect**
1. Open case detail
2. Open DevTools → Network → disable network
3. Wait 4+ seconds
4. Re-enable network
5. **Expected:** WebSocket reconnects (3s retry), streaming resumes if agent was mid-response

### WebSocket Event Testing (manual)

Using `wscat` or browser DevTools WebSocket inspector:

```bash
wscat -c ws://localhost:8000/ws
# Send:
{"type":"AUTH","payload":{"workspaceId":"<caseId>"},"meta":{"requestId":"test","token":"<clerk-token>"}}
```

Then trigger a message via REST. You should see:
```json
{"type":"SUPPORT_AGENT_START","payload":{"caseId":"..."}}
{"type":"SUPPORT_AGENT_TOKEN","payload":{"caseId":"...","token":"Hello"}}
{"type":"SUPPORT_AGENT_TOKEN","payload":{"caseId":"...","token":" there"}}
...
{"type":"SUPPORT_AGENT_DONE","payload":{"caseId":"..."}}
```

### Unit Testing Key Functions

```typescript
// Test: supportCaseService.createCase
// Verify: case created, message saved, returns full case object

// Test: supportCaseService.getCaseById
// Verify: throws 403 when userId mismatch

// Test: escalationService.sendEscalationEmail
// Use a test SMTP (Ethereal / Mailtrap) — set SMTP_USER/PASS in test env

// Test: SupportAgent tool dispatch
// Mock Prisma calls, verify each tool returns expected JSON
```

### Load Testing

Support worker concurrency is 10 by default (`SUPPORT_WORKER_CONCURRENCY`). For load testing:
- Create multiple cases simultaneously
- Worker processes up to 10 in parallel
- Redis pub/sub handles fan-out to multiple browser clients
- Monitor with BullMQ dashboard (add `bull-board` package) or Redis `MONITOR` command

---

## 16. Known Limitations & Edge Cases

### LLM Context Window

The agent loads the **full conversation history** on every run. Long cases (30+ messages) approach context limits. Mitigation: implement message summarization (the `backend/src/memory/` module has patterns for this — adapt for support cases).

### Tool Result Truncation

Tool results are truncated to **12,000 characters**. This can silently hide data from the LLM (e.g., very long sandbox logs). The agent may give incomplete answers if crucial info was cut.

### WebSocket Auth Reuse

The WebSocket uses `workspaceId` field to index support case connections — this is a semantic reuse of the workspace connection logic. If the WS server changes auth behavior for workspace events, support streaming will be affected.

### `workspaceName` Prop

`SupportChatInput` on the case detail page previously received a `workspaceName` prop that doesn't exist in the component interface. This was a pre-existing silent TypeScript error (now fixed — prop removed).

### Single Worker per Case

BullMQ doesn't deduplicate jobs by caseId. If a user sends two messages rapidly, two jobs are enqueued. Both will run `SupportAgent.processMessage()`, producing two concurrent agent responses on the same case. The second job will load stale history (missing the first job's response). Mitigation: add a per-case mutex or check `agentRunning` flag before enqueuing.

### No Stop Mechanism

The `SupportChatInput` supports an `onStop` prop and renders a Stop button when `isStreaming && onStop` is provided — but `onStop` is never wired up in the case detail page. There is no way to cancel an in-flight LLM call. The agent will run to completion even if the user navigates away.

### Escalation Email on Every Manual Trigger

If a user clicks Escalate repeatedly (before status updates), multiple emails can be sent. The `emailSentAt` field is set after the first send, but the route doesn't check this before sending. Add a guard: `if (case.emailSentAt) return` before calling `sendEscalationEmail`.

### `getSandboxLogs` Tool Is a Stub

The tool currently returns a hardcoded message directing users to the UI instead of fetching real logs. This should be wired to the actual E2B sandbox log fetcher in `backend/src/sandbox/`.
