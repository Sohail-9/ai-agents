# Authentication Architecture — Clerk Integration

This document describes **how authentication currently works** in PrettiFlow, end to end,
across the Next.js client and the Express backend. It is a reference of the *current state*
(Clerk-based), not a migration plan.

---

## 1. High-Level Overview

PrettiFlow uses **Clerk** as the identity provider. Clerk owns the entire login surface:
sign-in, sign-up, session management, and JWT issuance. The application never sees or stores
passwords.

```
┌──────────────┐   1. login UI        ┌─────────┐
│  Next.js     │ ───────────────────► │  Clerk  │
│  client      │ ◄─────────────────── │ (cloud) │
│              │   2. session + JWT   └────┬────┘
│              │                           │
│              │   3. Bearer <JWT>         │ 5. webhook
│              │ ──────────────┐           │ user.created/updated
└──────────────┘               ▼           ▼
                         ┌──────────────────────────┐
                         │   Express backend        │
                         │   - verify JWT (Clerk)   │
                         │   - sync users → Postgres│
                         └──────────────────────────┘
```

Three independent flows:
1. **Client-side session/UI** — Clerk React SDK manages login + session in the browser.
2. **API request auth** — client attaches Clerk JWT as `Bearer` token; backend verifies it.
3. **User data sync** — Clerk webhook pushes user create/update events into Postgres.

Key identifier: **Clerk user id** (`user_xxx`, the JWT `sub` claim). It is the de-facto
primary key for user-owned data across the schema — foreign keys reference `User.clerkId`,
not `User.id`.

---

## 2. Client (Next.js) — `client/`

### 2.1 ClerkProvider (root)
`client/app/layout.tsx:29` — the whole app is wrapped in `<ClerkProvider>`. This makes Clerk
session state and hooks (`useAuth`, `useUser`, `useClerk`) available everywhere.

```tsx
// client/app/layout.tsx
<ClerkProvider>
  <html ...>
    <body>...</body>
  </html>
</ClerkProvider>
```

### 2.2 Route protection — middleware
`client/proxy.ts` (Next.js middleware file) protects every route except the auth pages.

```ts
// client/proxy.ts
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()      // redirects unauthenticated users to sign-in
  }
  return NextResponse.next()
})
```

`config.matcher` runs the middleware on all app routes and all `/api`/`/trpc` routes, skipping
Next internals and static assets.

> Note: the file is named `proxy.ts`. Clerk middleware behaves as Next.js middleware
> regardless of name as long as it is at the conventional middleware location.

### 2.3 Sign-in / Sign-up pages
Clerk prebuilt components, no custom logic:
- `client/app/sign-in/[[...sign-in]]/page.tsx` → `<SignIn />`
- `client/app/sign-up/[[...sign-up]]/page.tsx` → `<SignUp />`

### 2.4 Getting a token for API calls
Every authenticated API call follows the same pattern: grab a fresh JWT from Clerk, then send
it as a `Bearer` header.

```ts
// pattern used across pages/hooks/components
const { getToken } = useAuth();
const token = await getToken();
fetch(`${API_URL}/...`, {
  headers: { Authorization: `Bearer ${token}` },
});
```

Representative locations:
- `client/app/page.tsx:30,115` — main page.
- `client/app/settings/page.tsx:44,54` — wraps it in an `authFetch()` helper.
- `client/hooks/use-workspace-manager.ts:13,30` — workspace fetch/create.
- `client/hooks/use-demo-access.ts` — demo-access guard.
- Plus databases, deployments, payments, support, system pages, and shared components.

There is **no central API client** — the `getToken()` → `Authorization` pattern is repeated at
each call site (or via small local helpers like `authFetch`).

### 2.5 User identity in UI
`useUser()` supplies the user object (name, email, avatar). `useClerk().openUserProfile()` opens
Clerk's account UI (used in settings). `components/posthog-provider.tsx` uses `useUser()` to
identify users in analytics.

### 2.6 Client env vars
`client/.env`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...            # ⚠️ see security note §6
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/
```

Dependencies: `@clerk/nextjs@^7.3.7`, `@clerk/backend@^3.4.12` (`client/package.json`).

---

## 3. Server (Express) — `backend/`

### 3.1 Auth middleware
`backend/src/middleware/requireAuth.ts` — the single chokepoint that authenticates API requests.

```ts
export async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.slice(7);

  // (a) Service-to-service JWT (infra callbacks)
  const infraSecret = process.env.INFRA_JWT_SECRET;
  if (infraSecret) {
    try {
      jwt.verify(token, infraSecret);
      res.locals.userId = "infra-service";
      return next();
    } catch { /* fall through to Clerk */ }
  }

  // (b) Clerk JWT
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    res.locals.userId = payload.sub;   // Clerk user id ("user_xxx")
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
```

Two token types accepted:
- **Infra/service token** — symmetric JWT signed with `INFRA_JWT_SECRET`. Used by internal
  infrastructure callbacks. On success `userId = "infra-service"`.
- **Clerk user JWT** — verified via `@clerk/backend`'s `verifyToken` using `CLERK_SECRET_KEY`.
  On success the user id is taken from the `sub` claim.

The authenticated user id is exposed downstream as **`res.locals.userId`**.

### 3.2 Where the middleware is applied
`backend/src/routes/index.ts:20-25` — applied globally to all `/api` routes, with three explicit
bypasses:

```ts
router.use((req, res, next) => {
  if (req.path === "/github/callback") return next();          // GitHub OAuth browser redirect
  if (req.path.startsWith("/demo-access/admin")) return next(); // admin: x-admin-token
  if (req.path.startsWith("/credits/admin")) return next();     // admin: x-admin-token
  return requireAuth(req, res, next);
});
```

Everything else (`/workspaces`, `/github`, `/keys`, `/user`, `/inspector`, `/sandbox`,
`/payments`, `/support`, …) requires a valid token. Route handlers read the caller via
`res.locals.userId`.

> Note: the Clerk **webhook** route (`/api/webhooks/clerk`) is mounted separately and is *not*
> behind `requireAuth` — it authenticates via Svix signature instead (§3.4).

### 3.3 Server env vars
- `CLERK_SECRET_KEY` — used by `requireAuth.ts:26` for JWT verification.
- `CLERK_WEBHOOK_SECRET` — used by `webhooks.ts:9` for webhook signature verification.
- `INFRA_JWT_SECRET` — symmetric secret for internal service tokens.

Loaded via `dotenv` in `backend/src/env.ts`.

### 3.4 User sync webhook
`backend/src/routes/webhooks.ts` — `POST /api/webhooks/clerk`. Clerk calls this whenever a user
is created or updated. Signature is verified with **Svix** before any processing.

```ts
router.post("/clerk", raw({ type: "application/json" }), async (req, res) => {
  // 1. verify svix signature with CLERK_WEBHOOK_SECRET
  const wh = new Webhook(WEBHOOK_SECRET);
  evt = wh.verify(payload.toString(), { "svix-id": ..., "svix-timestamp": ..., "svix-signature": ... });

  // 2. on user.created / user.updated → upsert into Postgres
  if (eventType === "user.created" || eventType === "user.updated") {
    await userService.createOrUpdateUser({
      clerkId: id,                                   // evt.data.id
      email: evt.data.email_addresses?.[0]?.email_address,
      name: `${first_name} ${last_name}`.trim(),
      image: evt.data.image_url,
    });
  }
});
```

Only `user.created` and `user.updated` are handled. There is **no `user.deleted` handler**, so
deletions in Clerk are not currently propagated to Postgres.

### 3.5 User persistence
`backend/src/services/userService.ts`:
- `createOrUpdateUser({ clerkId, email, name, image })` — looks up by `clerkId`; updates if found,
  otherwise creates the `User` **and** a default `UserCredits` row in one transaction (note:
  `UserCredits.userId` is set to the `clerkId`).
- `getUser(clerkId)` — fetch by `clerkId`.

### 3.6 Data model
`backend/prisma/schema.prisma`:

```prisma
model User {
  id        String  @id @default(cuid())   // internal id — NOT used as the FK target
  clerkId   String  @unique                // Clerk user id ("user_xxx")
  email     String? @unique
  name      String?
  image     String?
  ...
  workspaces Workspace[]
  ...
}

model Workspace {
  ...
  userId String
  user   User @relation(fields: [userId], references: [clerkId], onDelete: Cascade)
  //                                       ^^^^^^^^^^^^^^^^^^^^^ FK targets clerkId, not id
}
```

**Critical detail:** related models (`Workspace`, and by the same convention `Request`,
`Database`, `CreditLedger`, `UserCredits`, `Payment`, `SupportCase`, `DemoKey`, `GithubAccount`)
key off **`clerkId`**, not the internal `User.id`. The Clerk id is the effective foreign key
throughout the schema. Any future change of identity provider must account for this — the Clerk
id string is embedded in user-owned rows everywhere.

---

## 4. WebSocket Authentication — `backend/src/ws/`

WebSocket auth is **weaker** than HTTP auth and works differently.

Client side (`client/app/system/[id]/_hooks/use-system-websocket.ts:163`):
```ts
socket.send(JSON.stringify({
  type: "AUTH",
  payload: { workspaceId: systemId, userId: userId || undefined, provider: provider || undefined },
  meta: { requestId: crypto.randomUUID() },
}));
```

Server side (`backend/src/ws/WSManager.ts:526`):
```ts
case "AUTH": {
  const userId = auth.payload?.userId ?? ctx.userId;   // taken from payload, NOT verified
  if (userId) {
    const accessStatus = await demoAccessService.getAccessStatus(userId);
    if (!accessStatus.hasAccess) { /* close 1008 DEMO_ACCESS_DENIED */ }
  }
  // store userId/workspaceId/provider on the socket context, reply AUTH_OK
}
```

Key points:
- The `userId` is taken **directly from the client-sent payload** — the WS layer does **not**
  re-verify a Clerk JWT. It trusts that the client already authenticated over HTTP.
- The only gate is a `demoAccessService.getAccessStatus(userId)` check (demo access), not identity
  verification.
- One client (`client/app/support/[caseId]/page.tsx:109-120`) does include a real `token` in
  `meta`, but the server's `AUTH` handler does not verify it.

This is the main asymmetry in the system: HTTP requests are cryptographically authenticated;
WebSocket connections are authenticated by trust of a client-supplied `userId`.

---

## 5. Request Lifecycle (end to end)

1. User opens the app → `proxy.ts` middleware redirects to Clerk `<SignIn/>` if no session.
2. User logs in via Clerk → browser holds a Clerk session.
3. (First login) Clerk fires `user.created` → `POST /api/webhooks/clerk` → Svix verified →
   `userService.createOrUpdateUser` upserts `User` + `UserCredits` in Postgres.
4. Client makes an API call: `getToken()` → `Authorization: Bearer <jwt>`.
5. Backend `requireAuth` verifies the JWT (`verifyToken` + `CLERK_SECRET_KEY`) → sets
   `res.locals.userId = payload.sub`.
6. Route handler uses `res.locals.userId` to scope all data (workspaces, etc.) via `clerkId` FKs.
7. For live agent updates: client opens WS → sends `AUTH` with `userId` → server checks demo
   access → streams events for that workspace.

---

## 6. Security Notes (current state)

- ⚠️ **`CLERK_SECRET_KEY` is present in `client/.env`.** The secret key belongs only on the
  server. Although it is not `NEXT_PUBLIC_`-prefixed (so it is not bundled into browser code),
  it should not live in the client project at all. Recommend rotating it and removing it from
  the client.
- **WebSocket identity is unverified** (§4) — `userId` is trusted from the client payload. A
  client could send an arbitrary `userId`; the only barrier is the demo-access check.
- **No `user.deleted` webhook handling** — deleted Clerk users remain in Postgres.
- **Infra token grants full API access** as `userId = "infra-service"` — anyone holding
  `INFRA_JWT_SECRET` can call any authenticated route.

---

## 7. File Reference Index

| Concern | File | Key lines |
|---|---|---|
| Client provider | `client/app/layout.tsx` | 29 |
| Client route protection | `client/proxy.ts` | 4–11 |
| Sign-in page | `client/app/sign-in/[[...sign-in]]/page.tsx` | — |
| Sign-up page | `client/app/sign-up/[[...sign-up]]/page.tsx` | — |
| Token → API pattern | `client/app/page.tsx`, `client/hooks/use-workspace-manager.ts` | 115 / 30 |
| Client WS auth | `client/app/system/[id]/_hooks/use-system-websocket.ts` | 163 |
| Backend auth middleware | `backend/src/middleware/requireAuth.ts` | 5–33 |
| Middleware wiring + bypasses | `backend/src/routes/index.ts` | 20–25 |
| Clerk webhook | `backend/src/routes/webhooks.ts` | 8–64 |
| User service | `backend/src/services/userService.ts` | 5–65 |
| User/Workspace schema | `backend/prisma/schema.prisma` | 13–32, 67 |
| Backend WS auth | `backend/src/ws/WSManager.ts` | 526–597 |
</content>
</invoke>
