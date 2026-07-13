# RCA — Backend Request Storm After Clerk → PrettiFlow Auth Migration

**Status:** Root cause confirmed.
**Symptom:** After the Clerk → custom-auth migration (PR #112), the Express backend is
flooded with API requests and the server slows to a crawl.
**Scope:** Client-side only. The backend `requireAuth` swap is fine; the auth service is fine.
The bug is in the **client auth state layer** (`client/lib/auth-client.ts`, `client/lib/auth-fetch.ts`,
`client/auth.ts`, `client/app/layout.tsx`) and the ~46 `useEffect` call sites that depend on it.

---

## 1. One-line root cause

The Clerk → NextAuth migration **replaced stable hook references with un-memoized ones**.
`useAuth().getToken` and `useUser().user` are now rebuilt on **every render**. ~46 data-fetching
`useEffect`s list those values in their dependency arrays, so the effects re-fire on every
render — and several of them call `setState`, which causes the next render, which re-fires the
effect again. That is a **self-perpetuating refetch loop** against the backend. Multiply by every
mounted component (Sidebar, SystemHeader, pages, hooks) and the backend melts.

> Under Clerk this never happened: `@clerk/nextjs` returned **referentially stable** `getToken`
> and `user` across renders, so these exact dependency arrays were stable. The migration shim
> dropped that guarantee. The dependency arrays didn't change — the thing they depend on did.

---

## 2. The mechanism, step by step

### 2.1 The shim returns fresh references every render

`client/lib/auth-client.ts` has **no `useMemo`/`useCallback`** anywhere (verified).

```ts
// useAuth() — a NEW object, with a NEW getToken closure, every render
export function useAuth() {
  const { data, status } = useSession();
  return {
    ...
    getToken: async () => { ... return data?.accessToken ?? null; },   // new fn each render
    signOut: () => revokeAndSignOut(data?.accessToken),                // new fn each render
  };
}

// useUser() — adaptUser() builds a NEW object literal every render
export function useUser() {
  const { data, status } = useSession();
  return { ..., user: adaptUser(data?.user) };   // never referentially equal to last render
}
```

So `getToken` (by identity) and `user` (by identity) change on **every single render**, even when
the token and the user are unchanged.

### 2.2 ~46 effects depend on those unstable references

```
46 useEffect sites across the client list getToken / user / authFetch in their deps
```

Representative confirmed offenders:

| File | Effect deps | Backend route it hammers |
|---|---|---|
| `hooks/use-workspace-manager.ts:48` | `[user?.id, isUserLoaded, getToken]` | `GET /api/workspaces/:id` |
| `hooks/use-demo-access.ts:45` | `[user, isLoaded]` | `GET /api/demo-access/status` |
| `components/Sidebar.tsx:91,104,128` | `[user?.id, ..., getToken]` | sidebar workspace fetches |
| `components/system/SystemHeader.tsx:98,158,181,223,242` | `[..., getToken]` | header/workspace fetches |
| `app/databases/page.tsx:136` | `[user, getToken]` | databases list |
| `app/deployments/page.tsx:234,366,385,543,626,987` | `[..., getToken]` | deployments/metrics |
| `app/(payment)/pricing/page.tsx:114` | `[user, authFetch]` | billing/credits |
| `components/GitHubConnectButton.tsx:27` | `[isLoaded, user?.id, getToken]` | github status |

### 2.3 The loop closes — why it's a *storm*, not just a double-fetch

`hooks/use-workspace-manager.ts` is the clearest case:

```ts
React.useEffect(() => {
  if (!isUserLoaded || !user?.id) return;
  setSystemsLoading(true);          // (1) state change → guarantees a re-render
  getToken().then(token => fetch(`${API_URL}/api/workspaces/${user.id}`, ...))
    .then(...).then(setSystems)     // (2) more state changes → more re-renders
    .finally(() => setSystemsLoading(false));
}, [user?.id, isUserLoaded, getToken]);   // (3) getToken is a NEW ref after the re-render
```

- (1) `setSystemsLoading(true)` forces a commit/render.
- (3) the render produces a **new `getToken`** → React sees deps changed → **re-runs the effect**.
- back to (1). Infinite loop firing `GET /api/workspaces/:id` as fast as the event loop allows.

`useDemoAccess` is the same shape with `user` (a fresh object each render) as the dep, calling
`GET /api/demo-access/status` in a loop. Both hooks mount on authenticated pages → two infinite
backend loops per page load, before counting Sidebar/SystemHeader/etc.

Effects that don't `setState` synchronously still re-fire on every *other* re-render and on every
NextAuth session refetch (see §3), so they add steady excess load even when not strictly infinite.

---

## 3. Secondary amplifiers (make the storm worse / cause refresh failures)

### 3.1 `useAuthFetch` identity churns on session change — `client/lib/auth-fetch.ts`

```ts
return useCallback(async (url, init) => { ... }, [data, update]);
```

`data` from `useSession()` gets a new reference on every session refetch and every token
rotation. So `authFetch` identity changes, and the ~10 effects with `[authFetch]` deps
(support, pricing, etc.) re-run each time. It should close over a **token ref**, not `data`.

### 3.2 401 thundering herd + refresh-token rotation race — `client/lib/auth-fetch.ts` + `client/auth.ts`

```ts
if (res.status === 401) {
  const refreshed = await update();   // every concurrent 401 calls this independently
  ...
}
```

When the 15-min access token expires, **every in-flight request 401s at once**. Each one calls
`update()` → each triggers NextAuth's `jwt` callback → each `POST /api/auth/refresh`.
Per `auth-api.md`, **refresh rotates the refresh token (single-use)**. Concurrent refreshes race:
the first rotation invalidates the token the others are using → those refreshes return 401 →
`error: "RefreshError"` → forced `signOut()` → redirect to `/sign-in` → user re-logs → another
burst of effect-loop fetches. No single-flight guard exists on the refresh path.

### 3.3 `SessionProvider` is untuned — `client/app/layout.tsx`

```tsx
<SessionProvider>   // no refetchOnWindowFocus / refetchInterval props
```

NextAuth defaults `refetchOnWindowFocus: true`. Every tab focus → `/api/auth/session` →
new `data` reference → cascades into §2 (effects re-fire) and §3.1 (authFetch re-created).
Each focus event nudges the loops.

### 3.4 Baseline polling (pre-existing, compounds the load)

Not caused by the migration, but it stacks on top: `deployments-tab.tsx:295` (8s),
`analytics/page.tsx` (5s + 30s), `deployments/page.tsx:374`, `SystemHeader.tsx` job polls.
On their own they're fine; under the storm they add fixed pressure.

### 3.5 Not the cause — WebSocket hook (cleared)

`app/system/[id]/_hooks/use-system-websocket.ts` is correct: it reads the token from
`accessTokenRef` (`:58-59`) and its `connect` deps are `[systemId, enabled, initialIdea,
framework, provider]` — **token is deliberately excluded**, so token rotation does not reconnect
the socket. This matches the earlier websocket-race fix. WS is not contributing to the storm.

---

## 4. Why it passed review

- The 46 dependency arrays were **never edited** in the migration — they already listed
  `getToken`/`user`. They were correct under Clerk. The regression is invisible in the diff
  because the broken thing is the *reference stability of the dependency*, not the dep list.
- The migration doc (`auth-update.md` §6) explicitly recommended **Option A (thin context)** and
  warned that NextAuth adds "a second, redundant session layer." The team shipped the NextAuth
  path (Option B) anyway. NextAuth's `useSession` re-render + new-`data`-ref behavior is exactly
  the redundant layer the doc warned about, and it's what trips the un-memoized shim.

---

## 5. Fixes (ordered by impact)

### Fix 1 — restore reference stability in the shim (kills the loops; ~0 call-site changes) **[P0]**

`client/lib/auth-client.ts` — memoize so identities only change when the token/user actually changes:

```ts
import { useMemo, useCallback } from "react";

export function useAuth() {
  const { data, status } = useSession();
  const accessToken = data?.accessToken ?? null;
  const error = data?.error;

  const getToken = useCallback(async () => {
    if (error === "RefreshError") { await nextSignOut({ callbackUrl: "/sign-in" }); return null; }
    return accessToken;
  }, [accessToken, error]);

  const signOut = useCallback(() => revokeAndSignOut(accessToken ?? undefined), [accessToken]);

  return useMemo(() => ({
    isLoaded: status !== "loading",
    isSignedIn: status === "authenticated",
    userId: data?.user?.id ?? null,
    accessToken,
    getToken,
    signOut,
  }), [status, data?.user?.id, accessToken, getToken, signOut]);
}

export function useUser() {
  const { data, status } = useSession();
  const user = useMemo(() => adaptUser(data?.user as SessionUser | undefined), [data?.user]);
  return useMemo(() => ({
    isLoaded: status !== "loading",
    isSignedIn: status === "authenticated",
    user,
  }), [status, user]);
}
```

This restores the Clerk guarantee: `getToken`/`user` are stable across renders, so the 46
effects stop re-firing. This alone stops the server-melt.

### Fix 2 — make `useAuthFetch` stable **[P1]** — `client/lib/auth-fetch.ts`

Hold the token in a ref updated by an effect; close `useCallback` over the ref, not `data`:

```ts
const tokenRef = useRef<string | undefined>(undefined);
useEffect(() => { tokenRef.current = data?.accessToken; }, [data?.accessToken]);
return useCallback(async (url, init = {}) => { /* read tokenRef.current */ }, [update]);
```

### Fix 3 — single-flight the refresh (stops the 401 herd + rotation race) **[P1]**

Gate refresh behind one module-level in-flight promise so concurrent 401s share one
`/api/auth/refresh` instead of racing the single-use refresh token:

```ts
let refreshInFlight: Promise<Session | null> | null = null;
function refreshOnce(update: () => Promise<Session | null>) {
  if (!refreshInFlight) refreshInFlight = update().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
// in authFetch: const refreshed = await refreshOnce(update);
```

### Fix 4 — tune `SessionProvider` **[P2]** — `client/app/layout.tsx`

```tsx
<SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
```

Stops focus-driven session refetches from nudging the effects.

### Fix 5 — defensive guard (optional) — drop function refs from deps where the effect is
fire-once. e.g. `use-demo-access` should depend on `[user?.id, isLoaded]`, not `[user, isLoaded]`;
`use-workspace-manager` can use `[user?.id, isUserLoaded]` (getToken is stable after Fix 1, but
this is belt-and-braces).

---

## 6. Verification

1. Apply Fix 1. Open DevTools → Network on an authenticated page.
2. `GET /api/workspaces/:id` and `GET /api/demo-access/status` should each fire **once** on load
   (not in a loop). Backend request rate drops to baseline.
3. Let the access token expire (or force a 401); confirm exactly **one** `/api/auth/refresh`
   fires (Fix 3), not one per in-flight request, and no spurious sign-out.
4. Focus/blur the tab repeatedly — no burst of backend calls (Fix 4).
5. Backend CPU/load returns to normal under a single logged-in user.

---

## 7. Summary table

| # | Issue | File | Severity | Fix |
|---|---|---|---|---|
| 1 | `useAuth`/`useUser` rebuild refs every render → 46 effects loop | `lib/auth-client.ts` | **P0 (root)** | memoize (Fix 1) |
| 2 | `useAuthFetch` identity churns on session change | `lib/auth-fetch.ts` | P1 | token ref (Fix 2) |
| 3 | 401 herd → concurrent refresh → rotation race → forced re-login | `lib/auth-fetch.ts`, `auth.ts` | P1 | single-flight (Fix 3) |
| 4 | `SessionProvider` untuned, focus refetch | `app/layout.tsx` | P2 | props (Fix 4) |
| 5 | Baseline polling stacks on storm | various | P3 | unchanged once 1–4 land |
| — | WS hook | `use-system-websocket.ts` | OK | none (already correct) |
</content>
</invoke>
