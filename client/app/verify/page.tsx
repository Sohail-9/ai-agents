"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

// Landing the auth service redirects to after a verification-link click
// (GET /api/auth/verify → ?verified=1 on success, ?verified=0 on failure).
function VerifyResult() {
  const params = useSearchParams();
  const ok = params.get("verified") === "1";
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/5 p-8 text-center text-white">
        <h1 className="mb-2 text-xl font-semibold">
          {ok ? "Email verified" : "Verification failed"}
        </h1>
        <p className="mb-4 text-sm text-white/60">
          {ok
            ? "Your email is verified. You can sign in now."
            : "This link is invalid or expired. Try signing up again."}
        </p>
        <Link href="/sign-in" className="underline">
          {ok ? "Sign in" : "Back to sign in"}
        </Link>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <VerifyResult />
    </Suspense>
  );
}
