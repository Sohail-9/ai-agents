"use client";

// Central authenticated fetch. Attaches the service access token, transparently
// refreshes via NextAuth on a 401 (retry once), and forces re-login on
// persistent failure. Use the `useAuthFetch` hook from components.

import { useCallback, useEffect, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import type { Session } from "next-auth";

export function useAuthFetch() {
  const { data, update } = useSession();

  // Hold the live token in a ref so the returned authFetch identity stays
  // stable across renders/session refetches. Depending on `data` directly
  // would rebuild authFetch on every session change, re-firing the ~10 effects
  // that list [authFetch] in their deps. (`update` is stable from next-auth.)
  const tokenRef = useRef<string | undefined>(data?.accessToken);
  useEffect(() => {
    tokenRef.current = data?.accessToken;
  }, [data?.accessToken]);

  return useCallback(
    async (url: string, init: RequestInit = {}): Promise<Response> => {
      const tokenOf = (s: Session | null | undefined) => s?.accessToken;

      const call = (token: string | undefined) =>
        fetch(url, {
          ...init,
          headers: {
            ...(init.headers || {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });

      let res = await call(tokenRef.current);
      if (res.status === 401) {
        // Force the jwt callback to rotate the token, then retry once.
        // Single-flighted so a burst of concurrent 401s shares one refresh
        // instead of racing the single-use (rotating) refresh token.
        const refreshed = await refreshOnce(update);
        const token = tokenOf(refreshed);
        if (refreshed?.error === "RefreshError" || !token) {
          await signOut({ callbackUrl: "/sign-in" });
          return res;
        }
        tokenRef.current = token;
        res = await call(token);
        if (res.status === 401) {
          await signOut({ callbackUrl: "/sign-in" });
        }
      }
      return res;
    },
    [update],
  );
}

// Module-level single-flight guard for token refresh. When the 15-min access
// token expires, every in-flight request 401s at once; without this each would
// call update() → its own POST /api/auth/refresh, and because the refresh token
// is single-use/rotating, all but the first rotation lose the race and fail
// with RefreshError → spurious forced sign-out. Coalesce them into one refresh.
let refreshInFlight: Promise<Session | null> | null = null;
function refreshOnce(
  update: () => Promise<Session | null>,
): Promise<Session | null> {
  if (!refreshInFlight) {
    refreshInFlight = Promise.resolve(update()).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
