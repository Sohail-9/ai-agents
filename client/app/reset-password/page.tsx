"use client";

import { useState } from "react";
import Link from "next/link";

const AUTH_URL = "/pf-auth"; // same-origin proxy → auth service

export default function Page() {
  const [step, setStep] = useState<"request" | "reset" | "done">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await fetch(`${AUTH_URL}/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Always 200 (no account enumeration) — advance regardless.
      setStep("reset");
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const resp = await fetch(`${AUTH_URL}/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, password }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.error?.message ?? "Invalid or expired code");
      }
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  }

  const field =
    "rounded-md border border-white/10 bg-black/20 px-3 py-2 text-white outline-none";

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/5 p-8">
        {step === "request" && (
          <form onSubmit={requestCode} className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold text-white">Reset password</h1>
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-white px-3 py-2 font-medium text-black disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset code"}
            </button>
            <Link href="/sign-in" className="text-center text-sm text-white/60">
              Back to sign in
            </Link>
          </form>
        )}

        {step === "reset" && (
          <form onSubmit={submitReset} className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold text-white">Enter code</h1>
            <p className="text-sm text-white/60">
              If an account exists for {email}, a 6-digit code was sent.
            </p>
            <input
              required
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={field}
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="New password (min 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-white px-3 py-2 font-medium text-black disabled:opacity-50"
            >
              {loading ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="text-center text-white">
            <h1 className="mb-2 text-xl font-semibold">Password reset</h1>
            <Link href="/sign-in" className="underline">
              Sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
