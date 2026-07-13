# Authentication Plan — Clerk → AI Agents Auth Service + NextAuth

**Goal:** remove Clerk and authenticate through the **AI Agents custom auth service**
(`https://auth.ai-agents.com`, API in [`auth-api.md`](./auth-api.md)), using **NextAuth v5
(Auth.js)** in the Next.js client purely as the **session layer**.

**Division of responsibility (the core idea):**

| Layer                  | Owner                   | Responsibility                                                                                                                                                                                      |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity authority** | AI Agents auth service | Credentials check, password, OTP, email verify, Google OAuth, **mints RS256 access + refresh tokens**, owns the canonical user record. The _source of truth_.                                       |
| **Session layer**      | NextAuth (client)       | Wraps the service. Holds the service's tokens inside an encrypted httpOnly session cookie, exposes `useSession()`/`auth()`, handles silent refresh, route gating. **Mints no identity of its own.** |
| **Resource authority** | Express backend         | Verifies the _service's_ access token via JWKS (`res.locals.userId = sub`). Unchanged contract.                                                                                                     |

NextAuth never issues its own identity tokens. Every login decision is delegated to the auth
service via its API; NextAuth only stores the result and manages the browser session around it.

Companion docs:

- Current Clerk state: [`CLERK_AUTH.md`](./CLERK_AUTH.md)
- Auth service API: [`auth-api.md`](./auth-api.md)
- Alternative (no-NextAuth) migration: [`auth-update.md`](./auth-update.md) — read §6 there for why
  NextAuth is optional. **This doc is the chosen NextAuth path.**

---

## 1. Architecture

```
                          ┌───────────────────────────────────┐
                          │   AI Agents Auth Service          │
                          │   https://auth.ai-agents.com      │
                          │   - password / OTP / email verify  │
   (3) /signin,/refresh   │   - Google OAuth                   │
   ┌─────────────────────►│   - mints RS256 access + refresh   │◄── source of truth
   │                      │   - /.well-known/jwks.json         │
   │                      └───────────────┬───────────────────┘
   │                                      │ (5) JWKS public keys
   │  ┌──────────────────────┐            ▼
   │  │  Next.js client      │   ┌────────────────────────────┐
   └──┤  NextAuth v5         │   │   Express backend          │
      │  - Credentials prov. │   │   - requireAuth verifies   │
      │  - encrypted session │   │     service token via JWKS │
      │    cookie holds      │   │   - res.locals.userId=sub  │
      │    {access,refresh}  │   │   - lazy-provision User    │
      │  - jwt cb refreshes  │──►│  (4) Bearer <access token> │
      └──────────────────────┘   └────────────────────────────┘
```

Two tokens exist, do not confuse them:

1. **Service access token** (RS256 JWT, ~15 min) — what the **backend verifies**. NextAuth stores
   it; the backend never sees the NextAuth cookie.
2. **NextAuth session token** — encrypted JWE in the `authjs.session-token` httpOnly cookie. Only
   the Next app reads it. It is a _container_ for token #1 + the refresh token, not an identity the
   backend trusts.

---

## 2. Why NextAuth here (and its limits)

NextAuth is **not** providing identity — the service does. NextAuth buys three things:

- **Tokens out of browser JS.** The service access/refresh tokens live in an encrypted httpOnly
  cookie, not in `localStorage` or React memory. Mitigates XSS token theft.
- **Standard session ergonomics.** `auth()` (server), `useSession()` (client), `middleware`
  route gating, `signIn`/`signOut`.
- **One refresh home.** The `jwt` callback refreshes the service token centrally.

Accepted cost (vs. the thin-context approach in `auth-update.md` §6 Option A):

- The service already does sessions/refresh, so there is **partial overlap** — NextAuth's session
  expiry must be kept ≥ the service refresh-token lifetime, and refresh is implemented twice
  conceptually (once in the service, once mirrored in the `jwt` callback). Managed, not eliminated.
- Client API calls need the access token. We expose it on the session (see §5.3) so the existing
  `getToken()` shape survives. If a stricter "token never reaches browser JS" posture is required,
  route calls through Next server actions instead (§5.4) — more churn.

---

## 3. Open Decisions (assumptions in bold)

1. **Separate service vs merged** → **Separate** deployable at `https://auth.ai-agents.com`. Backend
   verifies via JWKS. (Same as `auth-update.md` §2.)
2. **Shared Postgres `User` table** → **Separate DBs.** Backend lazily provisions its local `User`
   from token claims / `GET /me` (§4.2).
3. **Existing prod users** → **assume small/dev, re-register acceptable.** Else do the email-match
   `clerkId` rewrite in [`auth-update.md`](./auth-update.md) §5.
4. **`clerkId` column** → **reuse as-is**, now holds the auth-service UUID. Zero schema/FK churn
   (`auth-update.md` §3.4 Option A). Rename to `authUserId` later as an isolated PR.
5. **Token exposure** → **access token exposed on NextAuth session** so client `fetch` keeps
   working (§5.3). Switch to server-action proxying (§5.4) only if a security rule forbids it.
6. **NextAuth version** → **v5 (Auth.js)**, App Router native (client is Next 16 / React 19).

---

## 4. Backend Changes (`backend/`)

The backend does **not** care that NextAuth exists — it verifies the service's RS256 token. These
changes are identical to [`auth-update.md`](./auth-update.md) §3; summarized here, see that doc for
full code.

### 4.1 `src/middleware/requireAuth.ts` — swap verify

- Replace `@clerk/backend` `verifyToken(secretKey)` with JWKS RS256 verify (`jose`
  `createRemoteJWKSet` + `jwtVerify`).
- **Enforce `issuer` + `audience`** in the `jwtVerify` options — the auth service signs and itself
  verifies both (`jwt.service.ts:86` `verifyAccessToken`). Backend must match the **access-token**
  audience, **not** the OAuth/CLI-state audience (`jwt.service.ts:129` `verifyOAuthState` uses a
  distinct audience). Pinning the access-token audience prevents a CLI-state token replaying as a
  resource access token. Verified claims: signature, expiry, issuer, audience.
- Keep the `INFRA_JWT_SECRET` branch untouched.
- **Preserve `res.locals.userId = payload.sub`** → all 37 downstream read sites untouched.
- Dual-accept window: try service token first, Clerk fallback second; delete Clerk branch at cutover.
- `cd backend && npm i jose`.

### 4.2 User provisioning — replace the Clerk webhook

The service emits no `user.created` webhook. Provision lazily on first authenticated request:

- Add `userService.provisionUser({ authUserId, email, name, image })` — `prisma.user.upsert` on
  the `clerkId` column, **seeding `UserCredits` in the same transaction** (preserve current
  `createOrUpdateUser` credit semantics).
- Call it from a thin `loadUser` middleware after `requireAuth`. The access token carries only
  `sub` (userId) + `sessionId` — **no email/name claims** (service `req.auth = {userId, sessionId}`).
  So provisioning always needs one `GET https://auth.ai-agents.com/api/auth/me` call (returns
  `{ user: { id, email, firstName, lastName, ... } }`), cached on first provision.
- Delete `POST /api/webhooks/clerk` (keep `webhooks.ts` only for non-Clerk webhooks).

### 4.3 WebSocket hardening — `src/ws/WSManager.ts`

Currently trusts client-sent `userId` unverified (`CLERK_AUTH.md` §4). Client now sends the
**service access token** in the `AUTH` event; server verifies it with the same JWKS and derives
`userId` from `sub`. Stop trusting `payload.userId`.

### 4.4 Backend env

| Action                | Var                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add                   | `AUTH_JWKS_URL=https://auth.ai-agents.com/.well-known/jwks.json`, `AUTH_ISSUER` (**required** — service enforces it), `AUTH_AUDIENCE` (**required** — must be the _access-token_ audience, not the OAuth/CLI-state one), `AUTH_SERVICE_URL=https://auth.ai-agents.com` |
| Remove (post-cutover) | `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`                                                                                                                                                                                                                               |
| Keep                  | `INFRA_JWT_SECRET`                                                                                                                                                                                                                                                       |

---

## 5. Client Changes (`client/`) — NextAuth integration

### 5.1 Install + base config

```bash
cd client && npm i next-auth@beta   # Auth.js v5
```

`client/auth.ts` (root config):

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

const AUTH = process.env.AUTH_SERVICE_URL!; // https://auth.ai-agents.com
const SKEW = 30_000; // refresh 30s before expiry

async function refresh(refreshToken: string) {
  const r = await fetch(`${AUTH}/api/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) throw new Error("refresh_failed");
  return r.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 }, // ≥ service refresh-token TTL
  pages: { signIn: "/sign-in" },
  providers: [
    // (A) password — delegates the credential check to the service
    Credentials({
      id: "password",
      credentials: { email: {}, password: {} },
      async authorize(c) {
        const r = await fetch(`${AUTH}/api/auth/signin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: c.email, password: c.password }),
        });
        if (!r.ok) return null; // 401 invalid / 403 unverified → NextAuth error
        const d = await r.json(); // { userId, accessToken, refreshToken, ... }
        return {
          id: d.userId,
          accessToken: d.accessToken,
          refreshToken: d.refreshToken,
          // accessToken exp parsed from JWT, or assume ~15m:
          accessTokenExpires: Date.now() + 15 * 60 * 1000,
        };
      },
    }),
    // (B) google-bridge — trusts tokens already minted by the service (see §5.2)
    Credentials({
      id: "bridge",
      credentials: { accessToken: {}, refreshToken: {} },
      async authorize(c) {
        const me = await fetch(`${AUTH}/api/auth/me`, {
          headers: { Authorization: `Bearer ${c.accessToken}` },
        });
        if (!me.ok) return null; // reject forged tokens
        const { user } = await me.json();
        return {
          id: user.id,
          accessToken: c.accessToken as string,
          refreshToken: c.refreshToken as string,
          accessTokenExpires: Date.now() + 15 * 60 * 1000,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // first sign-in: copy tokens into the JWE
        return {
          ...token,
          sub: user.id,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: user.accessTokenExpires,
        };
      }
      if (Date.now() < (token.accessTokenExpires as number) - SKEW)
        return token;
      try {
        // expired → rotate via the service
        const t = await refresh(token.refreshToken as string);
        return {
          ...token,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessTokenExpires: Date.now() + 15 * 60 * 1000,
        };
      } catch {
        return { ...token, error: "RefreshError" }; // surfaces → force re-login
      }
    },
    async session({ session, token }) {
      session.user.id = token.sub!;
      (session as any).accessToken = token.accessToken; // exposed for client fetch (§5.3)
      (session as any).error = token.error;
      return session;
    },
  },
});
```

`client/app/api/auth/[...nextauth]/route.ts`:

```ts
export { GET, POST } from "@/auth";
```

`client/middleware.ts` (replaces Clerk gating in `proxy.ts`):

```ts
export { auth as middleware } from "@/auth";
// matcher: protect everything except /sign-in, /sign-up, /verify, /reset, /api/auth, static
```

### 5.2 Google OAuth — one identity source (the service's)

Do **not** add NextAuth's own Google provider — that would be a second identity source. Bridge the
service's Google flow into a NextAuth session:

1. "Continue with Google" button → browser navigates to
   `GET https://auth.ai-agents.com/api/auth/google?redirectTo=/auth/oauth-landing`.
2. Service completes Google, sets its `pf_session` httpOnly cookie, redirects to the client
   `/auth/oauth-landing`.
3. `/auth/oauth-landing` (client) calls `POST {AUTH}/api/auth/refresh` with `credentials:"include"`
   (sends `pf_session`) → gets `{ accessToken, refreshToken }`.
4. Calls `signIn("bridge", { accessToken, refreshToken, redirect: true, callbackUrl: "/" })` → the
   `bridge` provider validates via `/me` and establishes the NextAuth session.

This keeps the service as the sole identity authority while NextAuth still owns the resulting
session. (Cross-site cookie note in §5.6.)

### 5.3 Token access for API calls — keep the `getToken()` shape

Replace the Clerk hook with one that yields the service access token from the NextAuth session, so
the **124 existing `getToken()` call sites change only their import**:

```ts
// client/lib/auth-client.ts
import { useSession } from "next-auth/react";
export function useAuth() {
  const { data, update } = useSession();
  return {
    user: data?.user,
    getToken: async () => {
      if ((data as any)?.error === "RefreshError") {
        /* redirect /sign-in */
      }
      return (data as any)?.accessToken as string | undefined; // refreshed by jwt cb
    },
  };
}
```

The `jwt` callback refreshes transparently; `useSession` re-reads the rotated token. No per-call
refresh code at the 124 sites.

### 5.4 Central fetch wrapper (do regardless)

Introduce `authFetch()` once (settings page already has a local version):

1. attach `Authorization: Bearer <session accessToken>`,
2. on `401`, call `update()` to force a session/token refresh, retry once,
3. on persistent failure → `signOut()` + redirect `/sign-in`.

> Stricter posture (token never in browser JS): skip §5.3 exposure, make `authFetch` a Next **route
> handler / server action** that reads `auth()` server-side and injects the Bearer. Costs rewiring
> the 124 fetches to hit the proxy route. Default plan keeps client fetch.

### 5.5 Remove Clerk + build pages

- `app/layout.tsx:29` — drop `<ClerkProvider>`; add `<SessionProvider>` (from `next-auth/react`).
- Delete `proxy.ts` Clerk middleware → `middleware.ts` (§5.1).
- Delete Clerk `app/sign-in/[[...sign-in]]`, `app/sign-up/[[...sign-up]]`; build real pages:

| Page / flow             | Action                                                                         |
| ----------------------- | ------------------------------------------------------------------------------ |
| Sign in                 | form → `signIn("password", { email, password })`                               |
| Sign up                 | `POST {AUTH}/api/auth/signup` → "verify email" screen (no session yet)         |
| Email verify landing    | service redirects back with `?verified=`                                       |
| Forgot / reset password | `POST {AUTH}/api/auth/forgot-password` then `/reset-password`                  |
| Google                  | §5.2 bridge                                                                    |
| Sessions / devices      | `GET {AUTH}/api/auth/sessions`, `DELETE …/:id` (new feature)                   |
| Profile                 | `GET/PATCH/DELETE {AUTH}/api/auth/me`                                          |
| Logout                  | `signOut()` **and** `POST {AUTH}/api/auth/logout` (revoke service session too) |

- `components/posthog-provider.tsx` — `useUser()` → `useSession()`.
- Swap the 76 `useUser/useAuth/useClerk` imports for the new `useAuth` (§5.3).
- Remove `@clerk/nextjs`, `@clerk/backend` from `client/package.json`; remove all
  `NEXT_PUBLIC_CLERK_*` and `CLERK_SECRET_KEY` from `client/.env` (rotate the secret regardless —
  `CLERK_AUTH.md` §6).

### 5.6 WebSocket client

`app/system/[id]/_hooks/use-system-websocket.ts:163` — send the **session access token** in the
`AUTH` event (not raw `userId`), matching the hardened server (§4.3).

### 5.7 Cookies / CORS (separate-origin)

- **NextAuth session cookie** is same-origin to the Next app — no cross-site issue.
- **Service `pf_session` cookie** is only needed for the Google bridge (§5.2 step 3). For the
  browser to send it cross-site to `auth.ai-agents.com`:
  - service CORS allows the client origin with `credentials: true`;
  - the landing fetch uses `credentials: "include"`;
  - `pf_session` set with `SameSite=None; Secure` and a parent domain (`.ai-agents.com`) shared by
    client and auth — **or** proxy `/api/auth/*` through the Next app so it is same-origin.
- Set `AUTH_SECRET` (NextAuth JWE key) in `client/.env`. Add `AUTH_SERVICE_URL`.

### 5.8 Client env

| Action | Var                                                                                         |
| ------ | ------------------------------------------------------------------------------------------- |
| Add    | `AUTH_SECRET`, `AUTH_SERVICE_URL=https://auth.ai-agents.com`, `NEXTAUTH_URL` (prod origin) |
| Remove | `NEXT_PUBLIC_CLERK_*`, `CLERK_SECRET_KEY`                                                   |

---

## 6. Phased Rollout

**Phase 0 — Prep.** Confirm §3 decisions. Auth service reachable (`AUTH_JWKS_URL` resolves from
backend). Back up Postgres.

**Phase 1 — Backend dual-accept (no client change).** `jose` JWKS verify as first branch in
`requireAuth`, Clerk fallback second. Add `provisionUser` + `loadUser`. Verify a service-minted
token authenticates an API call and provisions a `User` + `UserCredits`.

**Phase 2 — NextAuth + pages.** Add `auth.ts`, route handler, `middleware.ts`, `SessionProvider`.
Build sign-in/up/verify/reset pages + password `authorize`. Swap `getToken()`/`useUser` sites to
the new hook; route fetches through `authFetch`.

**Phase 3 — Google bridge (§5.2)** and **WS hardening (§4.3 / §5.6).**

**Phase 4 — User migration** (only if real prod users; `auth-update.md` §5).

**Phase 5 — Cutover & cleanup.** Remove Clerk fallback from `requireAuth`; delete Clerk webhook;
remove `@clerk/*` deps and all `CLERK_*` env; rotate the leaked `CLERK_SECRET_KEY`.

---

## 7. Risk / Verification Checklist

- [ ] `res.locals.userId` contract unchanged → 37 backend read sites untouched.
- [ ] `clerkId` column reused → 60 refs + FKs untouched (now holds auth-service UUID).
- [ ] First login provisions `User` **and** `UserCredits`.
- [ ] NextAuth `session.maxAge` ≥ service refresh-token TTL (else session dies while refresh valid).
- [ ] `jwt` callback refreshes before expiry; refresh failure → `error` surfaces → forced re-login.
- [ ] Backend verifies the **service** access token, never the NextAuth cookie.
- [ ] Backend `jwtVerify` enforces **issuer + audience**, pinned to the _access-token_ audience (not the OAuth/CLI-state audience) so a state token can't replay as an access token.
- [ ] Provisioning calls `GET /me` for email/name (access token has no email/name claims, only `sub` + `sessionId`).
- [ ] Exactly **one** Google identity source (service's `/api/auth/google`, not NextAuth's provider).
- [ ] Google bridge: `pf_session` reaches the auth service cross-site (CORS + `SameSite=None` or proxy).
- [ ] `signOut()` also calls `POST /api/auth/logout` so the service session is revoked.
- [ ] WS rejects forged `userId` (token verified server-side via JWKS).
- [ ] All `@clerk/*` imports gone; `CLERK_SECRET_KEY` removed from `client/.env` and rotated.

---

## 8. Effort Summary

| Area                 | Files                                                    | Effort  | Notes                                       |
| -------------------- | -------------------------------------------------------- | ------- | ------------------------------------------- |
| Backend verify swap  | 1 (`requireAuth.ts`)                                     | Low     | JWKS verify; contract preserved             |
| Backend provisioning | 2 (`userService`, `loadUser`)                            | Medium  | replaces webhook                            |
| Backend WS           | 1 (`WSManager.ts`)                                       | Low     | verify token, security win                  |
| NextAuth config      | new `auth.ts`, route, `middleware.ts`, `SessionProvider` | Medium  | Credentials + bridge + refresh callback     |
| Auth pages/flows     | ~6 pages                                                 | High    | real UI to build                            |
| Hook/fetch swap      | 31 files / 124 + 76 sites                                | Medium  | mechanical if `useAuth` mirrors Clerk shape |
| Google bridge        | landing page + provider                                  | Medium  | one identity source                         |
| User migration       | script                                                   | Low–Med | only if prod users                          |

**Critical path:** the client auth pages + NextAuth wiring (Phase 2–3). Backend is small because
`res.locals.userId` and the `clerkId` column are stable seams. The NextAuth-specific risk is the
**double session lifetime / refresh** — keep §7's maxAge and refresh checks green.
