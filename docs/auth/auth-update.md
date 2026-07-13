# Auth Migration Plan — Clerk → AI Agents Custom Auth Service

**Goal:** replace Clerk with the custom auth service described in [`auth-api.md`](./auth-api.md),
keeping the rest of the app (workspaces, credits, FKs, WS) working.

Companion docs:
- Current state: [`CLERK_AUTH.md`](./CLERK_AUTH.md)
- Target auth API: [`auth-api.md`](./auth-api.md)

---

## 0. TL;DR Recommendation

**Backend:** trivial conceptually — swap one verification function. Clerk JWT verify → custom
RS256 JWT verify via JWKS. Both are stateless token checks. The hard part is **user
provisioning** (no webhook in the new service) and the **`clerkId` field naming** (60 refs).

**Client:** this is where the work is — 31 files, 124 `getToken()` calls, 76 Clerk-hook calls.

**On NextAuth:** ⚠️ Read §6 before committing. The custom service *already* does everything
NextAuth does (sessions, OAuth, password, refresh, JWT issuance). NextAuth would add a **second,
redundant session layer**. It's only worth it as a **server-side token vault** (keeps the access
token out of browser JS). Two viable client options are laid out in §6 — pick one consciously.

---

## 1. Side-by-Side Comparison

| Concern | Clerk (current) | Custom service (target) | Migration impact |
|---|---|---|---|
| Login surface | Clerk hosted `<SignIn/>`/`<SignUp/>` | You build UI → `POST /api/auth/signin`,`/signup` | **Build login/signup/reset pages** |
| Token format | Clerk JWT | RS256 JWT (`accessToken`, ~15 min) | Low — both JWT |
| Token verify | `@clerk/backend verifyToken(secretKey)` | Verify via JWKS `/.well-known/jwks.json` | **Rewrite `requireAuth.ts`** |
| User id (`sub`) | `user_xxx` string | **UUID** | Stored in same column; format changes |
| Refresh | Clerk SDK, silent | `POST /api/auth/refresh`, rotates, `pf_session` httpOnly cookie | **Client must handle 401→refresh** |
| Sessions | opaque, Clerk-managed | First-class: `sessionId`, list/revoke endpoints | New feature surface (devices) |
| User → Postgres sync | Webhook `user.created/updated` → upsert | **No webhook** | **Replace with lazy provisioning** (§3.3) |
| OAuth | Clerk | `GET /api/auth/google` (web) + `/api/oauth/google/cli/*` (CLI) | Re-wire OAuth buttons |
| Email verify | Clerk | `GET /api/auth/verify?token` magic link | New flow |
| Password reset | Clerk | `forgot-password` (OTP) + `reset-password` | New flow |
| Profile | `useUser()` | `GET/PATCH/DELETE /api/auth/me` | Replace `useUser()` reads |
| Client SDK | `@clerk/nextjs` | none — raw fetch / NextAuth | Remove dep |

### Shape differences that bite
- **No webhook** in the new service → the current sync path (`webhooks.ts` →
  `userService.createOrUpdateUser`) has no trigger. Must provision users lazily on first
  authenticated request (or share the auth service's DB). See §3.3.
- **userId becomes a UUID** instead of `user_xxx`. The DB column (`clerkId`) holds the string
  either way, but **existing Clerk ids won't match new auth ids** → migration mapping needed for
  existing users (§5). Greenfield/dev: just reset.
- **Refresh is explicit.** Clerk refreshed silently; now the client must catch `401`, call
  `/api/auth/refresh`, retry. Central fetch wrapper makes this one place instead of 124.

---

## 2. Open Decisions (resolve before coding)

These materially change the plan. Stated assumptions used below in **bold**.

1. **Is the auth service a separate deployable, or merged into this Express backend?**
   `auth-api.md` base URL is `localhost:8000`; routes mount at `/api/auth`. The current backend
   also serves `/api`. → **Assumption: auth service is a SEPARATE service** at its own origin;
   AI Agents backend verifies its tokens via JWKS. (If merged, mount the auth router and skip
   CORS/cookie-domain work.)
2. **Do auth service and AI Agents share the same Postgres `User` table?**
   → **Assumption: separate DBs.** AI Agents keeps its own `User` table and lazily provisions
   from JWT claims / `GET /me`. (If shared, drop §3.3 provisioning and just read.)
3. **Existing production users to migrate, or greenfield?**
   → **Assumption: small/dev userbase, acceptable to re-register.** If real prod users exist, do
   the ID-mapping migration in §5.
4. **Cutover style:** big-bang vs dual-auth window. → **Assumption: dual-accept tokens during a
   short window** (backend accepts Clerk OR custom token), then remove Clerk.

> If any assumption is wrong, the affected section notes the alternative.

---

## 3. Backend Changes (`backend/`)

### 3.1 Token verification — `src/middleware/requireAuth.ts` (the core swap)
Replace Clerk verify with JWKS-based RS256 verify. Keep the infra-token branch untouched.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import jwt from "jsonwebtoken";

// cached across requests; jose handles key rotation + caching
const JWKS = createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL!)); // e.g. http://auth:8000/.well-known/jwks.json

export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.slice(7);

  // (a) infra service token — UNCHANGED
  const infraSecret = process.env.INFRA_JWT_SECRET;
  if (infraSecret) {
    try { jwt.verify(token, infraSecret); res.locals.userId = "infra-service"; return next(); }
    catch { /* fall through */ }
  }

  // (b) custom auth service access token (RS256 via JWKS)
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.AUTH_ISSUER,        // optional but recommended
      audience: process.env.AUTH_AUDIENCE,    // optional but recommended
    });
    res.locals.userId = payload.sub as string;  // now a UUID
    // OPTIONAL: lazy-provision (see §3.3)
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
```

- Add dep: `jose` (preferred for JWKS) — `cd backend && npm i jose`.
- New env: `AUTH_JWKS_URL`, optionally `AUTH_ISSUER`, `AUTH_AUDIENCE`.
- Remove `@clerk/backend` import + `CLERK_SECRET_KEY` usage.
- **Dual-auth window (recommended):** try custom verify first, then Clerk verify as fallback.
  Delete the Clerk branch after cutover.

> **`res.locals.userId` contract is preserved** → none of the **37** downstream read sites change.
> This is the leverage point: keep the contract, change only how the value is produced.

### 3.2 Remove the Clerk webhook — `src/routes/webhooks.ts`
The new service emits no `user.created` webhook. Options:
- **(A) Lazy provisioning (recommended, separate-DB assumption)** — delete the Clerk webhook;
  provision in `requireAuth` / a `loadUser` middleware (§3.3).
- **(B) Add a webhook to the auth service** — out of scope here; only if you control it and prefer
  push sync. Re-create the same Svix-style verified endpoint.
- Keep `webhooks.ts` only if other webhooks (Stripe etc.) live there.

### 3.3 User provisioning — `src/services/userService.ts`
Without a webhook, create the local `User` row on first authenticated request.

```ts
// new: idempotent provision from verified token claims (+ optional GET /me enrichment)
provisionUser: async ({ authUserId, email, name, image }) => {
  return prisma.user.upsert({
    where: { clerkId: authUserId },     // reuse existing unique column (see §3.4)
    update: { email, name, image },
    create: { clerkId: authUserId, email, name, image, creditAccount: { create: {} } },
  });
}
```

Call it from a thin `loadUser` middleware after `requireAuth` (or inside it). To get
`email/name`, either decode them from the JWT (if the auth service includes them as claims —
check the token) or call `GET /api/auth/me` once on first provision and cache.

> Keep the `User` + `UserCredits` transaction semantics from the current
> `createOrUpdateUser` so credits are still seeded on first login.

### 3.4 Schema — `prisma/schema.prisma` (the naming question)
The column `User.clerkId @unique` is the **effective FK target** for `Workspace`, `Request`,
`Database`, `CreditLedger`, `UserCredits`, `Payment`, `SupportCase`, `DemoKey`, `GithubAccount`
(`@relation(..., references: [clerkId])`), and is referenced **60 times** in `backend/src`.

Two paths:
- **(A) Reuse `clerkId` as-is (recommended for speed).** Store the new UUID in the existing
  `clerkId` column. **Zero schema migration, zero FK churn, no touching the 60 refs.** Cost:
  misleading name. Add a code comment that it now holds the auth-service user id.
- **(B) Rename `clerkId → authUserId`.** Cleaner, but a Prisma migration that renames the column
  **and every FK reference**, plus updating 60 source refs. Higher risk. Do this later as a pure
  rename PR if desired.

> Recommendation: **(A) now**, optional **(B)** as a follow-up cleanup. Decouples the risky
> rename from the behavioral migration.

### 3.5 WebSocket auth — `src/ws/WSManager.ts` (fix while here)
Current `AUTH` handler trusts `payload.userId` **without verifying** (CLERK_AUTH §4 / §6). Migrate
**and harden**:
- Client sends the **access token** in the `AUTH` event (the support page already sends a token in
  `meta`).
- Server verifies it with the **same JWKS** as `requireAuth`, derives `userId` from `sub` — stop
  trusting client-supplied `userId`.

```ts
case "AUTH": {
  const token = auth.payload?.token ?? auth.meta?.token;
  let userId: string | undefined;
  try { userId = (await jwtVerify(token, JWKS)).payload.sub as string; }
  catch { /* close 1008 AUTH_FAILED */ return; }
  // ...existing demo-access check + context store
}
```

### 3.6 Backend env changes
| Action | Var |
|---|---|
| Add | `AUTH_JWKS_URL`, `AUTH_ISSUER?`, `AUTH_AUDIENCE?`, `AUTH_SERVICE_URL` (for `GET /me`) |
| Remove (post-cutover) | `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` |
| Keep | `INFRA_JWT_SECRET` |

---

## 4. Client Changes (`client/`) — the bulk of the work

31 files, 124 `getToken()`, 76 `useUser/useAuth/useClerk`. Strategy: **build a thin auth layer
that exposes the SAME surface the code already uses** (`getToken()`, a user object) so call sites
barely change.

### 4.1 Remove Clerk shell
- `app/layout.tsx:29` — drop `<ClerkProvider>`, wrap in new `<AuthProvider>`.
- `proxy.ts` — replace `clerkMiddleware`/`auth.protect()` with custom middleware (§6) that checks
  the session cookie and redirects to `/sign-in`.
- Delete `app/sign-in/[[...sign-in]]`, `app/sign-up/[[...sign-up]]` Clerk pages; build real ones.
- `components/posthog-provider.tsx` — replace `useUser()` with new auth hook.
- Remove `@clerk/nextjs`, `@clerk/backend` from `client/package.json`.
- Remove all `NEXT_PUBLIC_CLERK_*` + `CLERK_SECRET_KEY` from `client/.env` (the secret key should
  never have been here — CLERK_AUTH §6).

### 4.2 New auth context (mirror Clerk's API to minimize churn)
Provide a hook with `getToken()` and `user`, so the 124 fetch sites and 76 hook sites need only an
import swap, not a rewrite:

```ts
// client/contexts/AuthContext.tsx
const { user, getToken, signIn, signOut } = useAuth();   // same shape callers expect
```

`getToken()` returns the in-memory access token, transparently calling `POST /api/auth/refresh`
(via `pf_session` cookie) when it's expired. **One refresh implementation, 124 beneficiaries.**

### 4.3 Central fetch wrapper (do this regardless)
Today every call site repeats `getToken()` + `Authorization`. Introduce `authFetch()` (the
settings page already has a local version) that:
1. attaches `Authorization: Bearer <accessToken>`,
2. on `401`, calls `/api/auth/refresh` once, retries,
3. on refresh failure, redirects to `/sign-in`.

This converts 124 ad-hoc calls into one wrapper and gives the refresh flow a single home.

### 4.4 New auth pages/flows to build
| Page/flow | Endpoint(s) |
|---|---|
| Sign in | `POST /api/auth/signin` → store `accessToken`, cookie set automatically |
| Sign up | `POST /api/auth/signup` → show "verify email" |
| Email verify landing | `GET /api/auth/verify?token` (service redirects back with `?verified=`) |
| Forgot password | `POST /api/auth/forgot-password` (OTP) |
| Reset password | `POST /api/auth/reset-password` |
| Google sign-in button | redirect to `GET /api/auth/google?redirectTo=/` |
| Profile / settings | `GET/PATCH /api/auth/me`, `DELETE /api/auth/me` |
| Sessions/devices UI (new) | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` |
| Logout | `POST /api/auth/logout` |

### 4.5 WebSocket client
`app/system/[id]/_hooks/use-system-websocket.ts:163` — send the **access token** in the `AUTH`
event (not raw `userId`), to match the hardened server (§3.5).

### 4.6 Cookies / CORS (separate-service assumption)
`pf_session` is httpOnly and set by the auth service. For the browser to send it:
- Auth-service CORS must allow the client origin with `credentials: true`.
- Client fetches to auth service use `credentials: "include"`.
- Cookie `SameSite`/domain must permit the client origin (shared parent domain in prod, or proxy
  `/api/auth/*` through the Next app so it's same-origin).

---

## 5. Existing-User Migration (only if real prod users)
Clerk ids (`user_xxx`) ≠ new auth UUIDs. All user-owned rows key on `clerkId` = Clerk id. Options:
- **Email-match backfill:** when a user first signs in via the new service, look up the local
  `User` by `email`; if found, **rewrite `clerkId` → new UUID** (and cascade is automatic since
  FKs reference the column value via the relation). Do this in `provisionUser`.
- **Bulk script:** export Clerk users, create them in the auth service, map old→new id by email,
  `UPDATE` the `clerkId` column. Run once, in a transaction, with a backup.
- **Greenfield:** skip — wipe/reset (assumed default).

> Whichever: back up Postgres first; the `clerkId` value is load-bearing across many tables.

---

## 6. The NextAuth Decision (read before choosing client approach)

You proposed **NextAuth + custom service**. Honest tradeoff:

**Why NextAuth is mostly redundant here:** the custom service already issues JWTs, manages
sessions, rotates refresh tokens, and does Google OAuth. NextAuth's core job *is* those things.
Stacking it creates **two session systems**: NextAuth mints its own session cookie/JWT, but your
**backend verifies the auth service's RS256 token via JWKS** — NextAuth's session token is not
that token. You'd end up storing the auth service's `accessToken`/`refreshToken` *inside* the
NextAuth session and refreshing manually in the `jwt` callback — fighting the framework.

**Option A — Thin custom auth context (recommended, simplest).**
React `AuthContext` + `authFetch` (§4.2–4.3) talking directly to the auth service. Access token in
memory, refresh via `pf_session` cookie. Least code, no redundant layer, matches existing
`getToken()` shape.
- ➖ Access token lives in JS memory (XSS-exposed if you have XSS — but it's short-lived, 15 min,
  and never in localStorage).

**Option B — NextAuth as a server-side token vault (use only if token-in-JS is unacceptable).**
NextAuth **Credentials provider** calls `POST /api/auth/signin` server-side, stores the auth
service's `accessToken`+`refreshToken` in NextAuth's **encrypted httpOnly cookie**, refreshes in
the `jwt` callback when expired. The browser JS never sees the access token; API calls go through
a Next route handler / server action that injects the Bearer header.
- ➕ Tokens never in browser JS.
- ➖ More moving parts, the 124 client fetches must route through the server, OAuth needs custom
  wiring (NextAuth's Google provider vs the service's `/api/auth/google` — pick one, don't run
  both), and you maintain refresh logic inside NextAuth.

**Recommendation:** **Option A** unless a security requirement forbids the access token touching
browser JS — then **Option B**. Do **not** use NextAuth's own Google provider *and* the service's
OAuth simultaneously; that's two identity sources for one user.

---

## 7. Phased Rollout

**Phase 0 — Prep**
- Confirm §2 decisions. Stand up auth service reachable from backend (`AUTH_JWKS_URL` resolves).
- Back up Postgres.

**Phase 1 — Backend dual-accept (no client change yet)**
- Add `jose` + JWKS verify to `requireAuth` as the **first** branch; keep Clerk as fallback.
- Add `provisionUser` + `loadUser` (lazy provisioning).
- Verify: a token minted by the auth service authenticates an API call and provisions a `User`.

**Phase 2 — Client auth layer**
- Build `AuthContext` (`getToken`/`user` parity) + `authFetch` with refresh.
- Build sign-in/up/verify/reset pages + Google button.
- Swap `proxy.ts` middleware and `layout.tsx` provider.
- Replace the 76 `useUser/useAuth/useClerk` imports with the new hook; point 124 fetches at
  `authFetch`.

**Phase 3 — WebSocket hardening**
- Client sends access token in `AUTH`; server verifies via JWKS (§3.5).

**Phase 4 — Migrate users (if applicable, §5).**

**Phase 5 — Cutover & cleanup**
- Remove Clerk fallback from `requireAuth`; delete Clerk webhook; remove `@clerk/*` deps and all
  `CLERK_*` env. Rotate the leaked `CLERK_SECRET_KEY` regardless.

---

## 8. Risk / Verification Checklist
- [ ] `res.locals.userId` contract unchanged → 37 read sites untouched.
- [ ] `clerkId` column reused (Option 3.4-A) → 60 refs + FKs untouched.
- [ ] First login provisions `User` **and** `UserCredits` (credits not silently lost).
- [ ] 401 → refresh → retry works in `authFetch`; refresh failure → `/sign-in`.
- [ ] `pf_session` cookie reaches the auth service cross-origin (CORS + `credentials`).
- [ ] WS rejects forged `userId` (token now verified server-side).
- [ ] Existing users (if migrated) keep their workspaces (email-match `clerkId` rewrite verified).
- [ ] All `@clerk/*` imports gone; `CLERK_SECRET_KEY` removed from `client/.env` and rotated.
- [ ] Google OAuth: exactly one identity source (service's, not NextAuth's too).

---

## 9. Effort Summary

| Area | Files | Effort | Notes |
|---|---|---|---|
| Backend verify swap | 1 (`requireAuth.ts`) | **Low** | JWKS verify; contract preserved |
| Backend provisioning | 2 (`userService`, new `loadUser`) | Medium | replaces webhook sync |
| Backend schema | 0 (Option A) / many (Option B) | Low / High | reuse vs rename `clerkId` |
| Backend WS | 1 (`WSManager.ts`) | Low | verify token, security win |
| Client provider/middleware/pages | ~8 + new pages | **High** | real auth UI to build |
| Client hook/fetch swap | 31 files / 124+76 sites | Medium | mechanical if context mirrors Clerk API |
| User migration | script | Low–Med | only if prod users |

**Critical path:** the client UI + auth context (Phase 2) is the real cost. The backend swap is
small because `res.locals.userId` and the `clerkId` column act as stable seams.
</content>
