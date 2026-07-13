# PrettiFlow Routing System

OpenRouter-like internal LLM API gateway at `api.prettiflow.com/v1/chat`. Users
create API keys, consume PrettiFlow-deployed models (gpt-5.5, gpt-5.3, codex,
opus-4.8), pay per token from a prepaid $ balance. 1 credit = $1.

Status: **planned** (not yet implemented).

---

## 1. OpenRouter reference (how the original works)

| Piece | Behavior |
|---|---|
| Endpoint | `POST /api/v1/chat/completions`, OpenAI-compatible (`model`, `messages`, `stream`, `tools`). `Authorization: Bearer <key>`. |
| User API keys | Named keys, optional per-key $ cap, call completions. |
| Provisioning keys | Separate keys for programmatic key create/rotate (SaaS). Cannot call completions. |
| Credits | Prepaid $ balance. Provider returns token counts → compute cost → deduct. |
| Usage | `usage` object in response (prompt/completion/total tokens + cost). Streaming: usage in final chunk before `[DONE]`. History via `/api/v1/generation?id=`. |
| Routing | manual (pick model) / auto / fallback (provider error → next). |
| Billing | pass-through provider price + 5.5% platform fee. |

### Our scope vs OpenRouter (decided)

- **Platform-provided provider keys** — users only get a `sk-pf-…` key. No BYOK in v1.
- **Pass-through pricing, no markup** — cost = exact provider token cost in $.
- **Account balance only** — single shared $ wallet, no per-key spend caps in v1
  (`spendLimit` column kept nullable/unused for v2).
- Models = already-deployed: gpt-5.5, gpt-5.3, codex, opus-4.8.

---

## 2. Existing pieces to reuse (do not rebuild)

| Need | Already there | File |
|---|---|---|
| HTTP/routing | Express 5, router mount pattern | `backend/src/server.ts`, `routes/index.ts` |
| DB | Postgres + Prisma 7 | `backend/prisma/schema.prisma` |
| Provider SDKs | Anthropic, OpenAI/Azure, Qwen, Groq, Gemini | `backend/src/brain/providers/*` |
| Model→provider map | modelSelector | `backend/src/brain/modelSelector.ts` |
| Credits wallet | `UserCredits` + `CreditLedger` (idempotent, reserve/finalize) | `backend/src/billing/billingService.ts` |
| Payments (buy credits) | Dodo checkout | `backend/src/routes/payments.ts` |
| Proxy-before-auth pattern | authProxy mounted before global `requireAuth` | `backend/src/routes/authProxy.ts`, `server.ts:106-117` |
| Dashboard | Next.js client | `client/` |

Gaps to build: API-key auth (not JWT), model registry w/ $ pricing,
`/v1/chat/completions`, streaming, $-metering, usage log, key-mgmt UI.

---

## 3. Architecture

```
                          api.prettiflow.com
                                 │
              ┌──────────────────┴───────────────────┐
              │            nginx / ingress            │
              │  /v1/*  ──────────► backend /api/v1   │   (new rewrite)
              │  /api/* ──────────► backend /api      │   (existing)
              └──────────────────┬───────────────────┘
                                 │
   ┌─────────────────────────────────────────────────────────────┐
   │                    Express app (backend)                     │
   │                                                              │
   │  ── NEW: /api/v1 router (mounted BEFORE global requireAuth) ─│
   │   POST /v1/chat/completions                                  │
   │   GET  /v1/models                                            │
   │   GET  /v1/generation?id=                                    │
   │        │                                                     │
   │        ▼                                                     │
   │  [apiKeyAuth] ── sha256(key) → ApiKey row → userId           │
   │        │         status ACTIVE? balance>0?                   │
   │        ▼                                                     │
   │  [model resolve]  Model registry: id→provider+upstream+price │
   │        ▼                                                     │
   │  [provider call]  reuse brain/providers/* (stream)           │
   │        │  ┌─► Azure OpenAI (gpt-5.5/5.3/codex)               │
   │        │  ├─► Anthropic / Azure-Claude (opus-4.8)            │
   │        │  └─► Qwen/Groq/Gemini                               │
   │        ▼                                                     │
   │  [meter]  cost = in·price_in + out·price_out                 │
   │           atomic deduct UserCredits, CreditLedger(-cost),    │
   │           write UsageRecord                                  │
   │                                                              │
   │  ── existing /api routes (JWT requireAuth) — UNTOUCHED ──    │
   │   /api/v1/keys  (create/list/revoke — JWT auth)              │
   │   /api/v1/usage (dashboard aggregates)                       │
   └─────────────────────────────┬───────────────────────────────┘
                                  │
                       Postgres (Prisma)
            NEW: ApiKey, Model, UsageRecord
            REUSE: User, UserCredits, CreditLedger, Payment
```

**Two auth planes, isolated:**
- `/v1/chat/*` → API-key auth (new middleware), mounted *before* global
  `requireAuth` (same trick `authProxy` uses). Existing JWT chain untouched.
- Key management → existing JWT (dashboard user logged in).

---

## 4. Schema additions (additive migration, zero drops)

```prisma
enum ApiKeyStatus { ACTIVE REVOKED }

model ApiKey {
  id         String       @id @default(cuid())
  userId     String       // -> User.clerkId
  name       String
  keyPrefix  String       // "sk-pf-abc1…" shown in UI
  keyHash    String       @unique  // sha256(fullKey), full key never stored
  last4      String
  status     ApiKeyStatus @default(ACTIVE)
  spendLimit Decimal?     @db.Decimal(12,6)  // v2: optional per-key $ cap (unused v1)
  spent      Decimal      @default(0) @db.Decimal(12,6)
  lastUsedAt DateTime?
  createdAt  DateTime     @default(now())
  @@index([userId])
}

model Model {
  id               String   @id          // "openai/gpt-5.5", "anthropic/opus-4.8"
  displayName      String
  provider         String                // OPENAI | ANTHROPIC | QWEN | ...
  upstreamModel    String                // azure deployment / sdk model id
  inputPricePer1M  Decimal  @db.Decimal(12,6)   // $ per 1M input tokens
  outputPricePer1M Decimal  @db.Decimal(12,6)
  contextWindow    Int
  maxOutput        Int
  capabilities     String[]              // chat,tools,vision,thinking
  enabled          Boolean  @default(true)
}

model UsageRecord {
  id               String   @id @default(cuid())
  userId           String
  apiKeyId         String
  modelId          String
  requestId        String   @unique      // /v1/generation lookup + idempotency
  promptTokens     Int
  completionTokens Int
  cost             Decimal  @db.Decimal(12,6)
  status           String                // success | error
  latencyMs        Int
  createdAt        DateTime @default(now())
  @@index([userId, createdAt])
  @@index([apiKeyId])
}
```

**Wallet:** reuse `UserCredits.credits` as the $ wallet (1 credit = $1). Log
routing spend in existing `CreditLedger` with `reason="v1_routing"`, idempotency
key = `requestId`. No parallel wallet → existing agent billing untouched.

---

## 5. Request lifecycle — `/v1/chat/completions`

```
1. apiKeyAuth:  Bearer sk-pf-… → sha256 → ApiKey(keyHash)
                ACTIVE? → load userId → req.userId, req.apiKeyId
2. pre-check:   UserCredits.credits > MIN_BALANCE ?  (else 402)
3. resolve:     Model registry[body.model] → provider + upstreamModel + prices
                unknown/disabled model → 400/404
4. provider:    brain/providers[provider].chat(messages, stream)
                stream: true → SSE proxy, accumulate token counts
5. meter:       cost = (in/1e6·price_in) + (out/1e6·price_out)
                Postgres txn:
                  UPDATE UserCredits SET credits = credits - cost
                    WHERE userId=? AND credits >= cost RETURNING   ← guards negative
                  CreditLedger insert(delta=-cost, reason=v1_routing, requestId)
                  ApiKey.spent += cost
                  UsageRecord insert
6. respond:     OpenAI-shaped JSON + usage{prompt,completion,total,cost}
                stream: usage in final chunk before [DONE]
```

### Streaming + billing edge cases (sensitive)

- Token counts unknown until stream end → bill *after* stream completes.
- Client disconnects mid-stream → still bill received tokens (provider already
  charged us). Listen `req.on('close')`, finalize with partial counts.
- Balance hits 0 mid-stream → finish current request, block *next* at step 2.
- Idempotency: `UsageRecord.requestId` unique + `CreditLedger` unique → retry
  never double-charges.
- Atomic conditional decrement prevents negative balance under concurrency.

---

## 6. User flows

**Onboarding (dashboard, existing JWT):**
```
sign in → /dashboard/keys → "Buy credits" (existing payments) →
"Create API key" → name it → server gens sk-pf-<rand>, stores sha256 →
show full key ONCE → user copies
```

**Inference (their app):**
```
POST api.prettiflow.com/v1/chat/completions
  Authorization: Bearer sk-pf-…
  { "model":"anthropic/opus-4.8", "messages":[…], "stream":true }
→ SSE tokens → final usage{cost} → balance debited
```

**Tracking (dashboard):**
```
/dashboard/usage → balance, spend chart, per-key + per-model breakdown
  (reads UsageRecord aggregates)
```

**Admin:** seed `Model` rows w/ pricing; provider keys stay in env (already there).

---

## 7. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | API key | inference (stream + non-stream) |
| GET | `/v1/models` | API key | list enabled models + pricing |
| GET | `/v1/generation?id=` | API key | usage lookup by requestId |
| POST | `/api/v1/keys` | JWT | create key (returns full key once) |
| GET | `/api/v1/keys` | JWT | list keys (prefix+last4 only) |
| DELETE | `/api/v1/keys/:id` | JWT | revoke |
| GET | `/api/v1/usage` | JWT | dashboard aggregates |

---

## 8. Phased build (each phase independently shippable)

| Phase | Deliverable | Risk |
|---|---|---|
| 0 | Migration: ApiKey/Model/UsageRecord + seed models w/ pricing | none (additive) |
| 1 | Key mgmt endpoints (JWT) + dashboard UI (create/list/revoke) | low |
| 2 | `apiKeyAuth` middleware + `/v1/models` + non-streaming `/v1/chat/completions` (1 provider) | med |
| 3 | Streaming SSE; all providers wired | med |
| 4 | $-metering: atomic deduct, CreditLedger, UsageRecord, 402 guard, `/v1/generation` | **high — money path** |
| 5 | Rate limits + usage dashboard | low |
| 6 | Hardening: idempotency tests, abuse/rate limit, structured logs, load-test streaming | — |

### Nothing-breaks guardrails

- All additive — no existing route/table/middleware modified.
- `/v1` router mounted before `requireAuth`, own auth plane → JWT flows untouched.
- Migrations: add-only, no drops/renames.
- Feature flag `ROUTING_ENABLED` — dark-launch + instant kill switch.
- Reuse provider SDK clients + billing tables already in prod.

---

## 9. Deferred to v2

- BYOK (users supply own provider keys) — needs encrypted secret storage.
- Platform fee / markup config per model.
- Per-key spend caps (`spendLimit` column already present).
- Auto/fallback routing across providers.

---

## 10. Open items before Phase 0

Real per-1M-token $ prices (input + output) for each deployed model:
gpt-5.5, gpt-5.3, codex, opus-4.8. Needed to seed `Model` registry.
