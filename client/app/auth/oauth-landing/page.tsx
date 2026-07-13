"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";

// Google bridge landing (§5.2). The service has completed Google OAuth and set
// its pf_session cookie (first-party, via the same-origin /pf-auth proxy). We
// exchange that cookie for tokens via /refresh, then establish a NextAuth
// session through the `bridge` credentials provider.
export default function Page() {
  const [error, setError] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const r = await fetch(`/pf-auth/refresh`, {
          method: "POST",
          credentials: "include", // sends pf_session (first-party, same-origin)
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!r.ok) throw new Error("refresh_failed");
        const { accessToken, refreshToken } = await r.json();
        await signIn("bridge", {
          accessToken,
          refreshToken,
          redirect: true,
          callbackUrl: "/",
        });
      } catch {
        setError(true);
      }
    })();
  }, []);

  return (
    <div className="flex h-screen items-center justify-center text-white">
      {error ? (
        <div className="text-center">
          <p className="mb-2">Google sign-in failed.</p>
          <a href="/sign-in" className="underline">
            Back to sign in
          </a>
        </div>
      ) : (
        <p className="text-white/60">Completing sign-in…</p>
      )}
    </div>
  );
}
