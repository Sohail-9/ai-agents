"use client";

// Clerk-compatible client auth shim backed by NextAuth.
//
// Migration seam: the ~28 files that imported { useAuth, useUser, useClerk }
// from "@clerk/nextjs" change ONLY their import to "@/lib/auth-client". The
// hook shapes below mirror the subset of Clerk's API the app actually used:
//   useAuth()  -> { getToken, isSignedIn, isLoaded, signOut, userId }
//   useUser()  -> { user, isSignedIn, isLoaded }   (Clerk-ish user object)
//   useClerk() -> { signOut }
//
// The service access token is refreshed transparently in the NextAuth `jwt`
// callback; useSession re-reads the rotated token, so call sites need no
// per-call refresh logic.

import { useCallback, useMemo } from "react";
import { useSession, signOut as nextSignOut } from "next-auth/react";

// Revoke the service session (POST /logout via same-origin /pf-auth proxy), then
// clear the NextAuth session. Service revocation is best-effort — never block
// local sign-out on it.
async function revokeAndSignOut(accessToken?: string) {
  try {
    await fetch(`/pf-auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
  } catch {
    // ignore — clear the local session regardless
  }
  await nextSignOut({ callbackUrl: "/sign-in" });
}

type SessionUser = { id: string; name?: string | null; email?: string | null; image?: string | null };

// Clerk-shaped user adapter over the NextAuth session user.
function adaptUser(sessionUser: SessionUser | undefined) {
  if (!sessionUser) return null;
  const name = sessionUser.name ?? "";
  const [firstName, ...rest] = name.split(" ").filter(Boolean);
  const lastName = rest.join(" ") || null;
  const email = sessionUser.email ?? null;
  return {
    id: sessionUser.id,
    firstName: firstName ?? null,
    lastName,
    fullName: name || null,
    username: email ? email.split("@")[0] : null,
    imageUrl: sessionUser.image ?? "",
    primaryEmailAddress: email ? { emailAddress: email } : null,
    emailAddresses: email ? [{ emailAddress: email }] : [],
  };
}

// IMPORTANT — referential stability.
// Clerk's useAuth/useUser returned stable getToken/user refs across renders.
// ~46 useEffect call sites list getToken/user in their dependency arrays. If
// these hooks rebuild those refs every render, every one of those effects
// re-fires every render — and effects that setState then loop, hammering the
// backend. So getToken/user/signOut MUST be memoized and only change identity
// when the underlying token / user / error actually changes.
export function useAuth() {
  const { data, status } = useSession();
  const isLoaded = status !== "loading";
  const isSignedIn = status === "authenticated";
  const accessToken = data?.accessToken ?? null;
  const error = data?.error;
  const userId = data?.user?.id ?? null;

  // Synchronous current access token (rotated by the jwt callback). Handy for
  // non-fetch consumers like the WebSocket AUTH handshake.
  const getToken = useCallback(async (): Promise<string | null> => {
    if (error === "RefreshError") {
      // Refresh failed server-side — force a clean re-login.
      await nextSignOut({ callbackUrl: "/sign-in" });
      return null;
    }
    return accessToken;
  }, [accessToken, error]);

  const signOut = useCallback(
    () => revokeAndSignOut(accessToken ?? undefined),
    [accessToken],
  );

  return useMemo(
    () => ({ isLoaded, isSignedIn, userId, accessToken, getToken, signOut }),
    [isLoaded, isSignedIn, userId, accessToken, getToken, signOut],
  );
}

export function useUser() {
  const { data, status } = useSession();
  const isLoaded = status !== "loading";
  const isSignedIn = status === "authenticated";
  // adaptUser builds a fresh object — memoize on the source user so `user`
  // identity is stable until the session user actually changes.
  const user = useMemo(
    () => adaptUser(data?.user as SessionUser | undefined),
    [data?.user],
  );

  return useMemo(
    () => ({ isLoaded, isSignedIn, user }),
    [isLoaded, isSignedIn, user],
  );
}

export function useClerk() {
  const { data } = useSession();
  const accessToken = data?.accessToken ?? null;
  const signOut = useCallback(
    () => revokeAndSignOut(accessToken ?? undefined),
    [accessToken],
  );
  return useMemo(() => ({ signOut }), [signOut]);
}
