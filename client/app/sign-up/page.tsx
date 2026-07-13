"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

const steps = [
  "Sign up your account",
  "Set up your workspace",
  "Deploy your app",
];

export default function Page() {
  const [step, setStep] = useState<"form" | "verify">("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`/pf-auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, firstName, lastName }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        throw new Error(
          r.status === 409
            ? "An account with this email already exists."
            : err?.error?.message ?? "Sign up failed",
        );
      }
      // No session yet — the service emailed a verification link.
      setStep("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  function google() {
    // Service owns the Google identity; we bridge it into a NextAuth session.
    window.location.href = `/pf-auth/google?redirectTo=/auth/oauth-landing`;
  }

  function github() {
    toast.info("GitHub sign-up is coming soon.");
  }

  return (
    <div className="flex min-h-screen w-full bg-bg-main p-2.5 text-white lg:p-3.5">
      {/* ── Left panel ───────────────────────────────────────────────── */}
      <aside className="relative hidden w-[44%] max-w-[560px] shrink-0 overflow-hidden rounded-2xl bg-black lg:flex lg:flex-col">
        {/* Texture */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[length:440px_440px] bg-left-top opacity-[0.13]"
          style={{ backgroundImage: `url("/auth-panel-texture.png")` }}
        />
        {/* Pink glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 38% at 50% 16%, rgba(255,210,245,0.95) 0%, rgba(255,21,220,0.55) 28%, rgba(255,21,220,0.12) 52%, rgba(0,0,0,0) 70%), radial-gradient(90% 60% at 50% 30%, rgba(255,21,220,0.35) 0%, rgba(0,0,0,0) 60%)",
          }}
        />

        {/* Bottom content */}
        <div className="relative z-10 mt-auto flex flex-col items-center px-8 pb-8 text-center xl:px-10 xl:pb-10">
          <img
            src="/logos/logoname_dark.svg"
            alt="PrettiFlow"
            className="h-7 w-[120px]"
          />
          <h2 className="mt-6 text-[28px] font-medium leading-tight text-white xl:text-[32px]">
            Get Started with Us
          </h2>
          <p className="mt-2.5 max-w-[300px] text-sm leading-relaxed text-white/80 xl:text-base">
            Complete these easy steps to register your account.
          </p>

          {/* Steps */}
          <div className="mt-8 flex w-full max-w-[420px] items-start gap-2">
            {steps.map((label, i) => {
              const active = i === 0;
              return (
                <div
                  key={label}
                  className={`flex flex-1 flex-col justify-center gap-4 rounded-xl p-4 text-left backdrop-blur-[16px] ${
                    active
                      ? "border border-white/[0.24] bg-white"
                      : "bg-white/[0.12]"
                  }`}
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-xs font-medium leading-none text-white ${
                      active ? "bg-black" : "bg-white/[0.16]"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span
                    className={`text-sm leading-snug ${
                      active
                        ? "font-medium text-black"
                        : "font-normal text-white/80"
                    }`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {/* ── Right panel ──────────────────────────────────────────────── */}
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px]">
          {step === "form" ? (
            <>
              <header className="text-center">
                <h1 className="text-2xl font-medium leading-tight text-white">
                  Sign Up Account
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-white/80">
                  Enter your personal data to create your account.
                </p>
              </header>

              <div className="mt-7 flex flex-col gap-6">
                {/* OAuth */}
                <div className="flex gap-3.5">
                  <button
                    type="button"
                    onClick={google}
                    className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-white/20 py-3 text-sm font-medium text-white transition-colors hover:bg-white/5"
                  >
                    <img
                      src="/icons/google-color.svg"
                      alt=""
                      className="size-[18px]"
                    />
                    Google
                  </button>
                  <button
                    type="button"
                    onClick={github}
                    className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-white/20 py-3 text-sm font-medium text-white transition-colors hover:bg-white/5"
                  >
                    <img
                      src="/icons/github-white.svg"
                      alt=""
                      className="size-[18px]"
                    />
                    Github
                  </button>
                </div>

                {/* Divider */}
                <div className="flex items-center gap-3.5">
                  <span className="h-px flex-1 bg-white/20" />
                  <span className="text-xs text-white/70">Or</span>
                  <span className="h-px flex-1 bg-white/20" />
                </div>

                {/* Form */}
                <form onSubmit={submit} className="flex flex-col gap-6">
                  <div className="flex flex-col gap-[18px]">
                    <div className="flex gap-3.5">
                      <Field label="First Name">
                        <input
                          placeholder="eg. John"
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          className={inputCls}
                        />
                      </Field>
                      <Field label="Last Name">
                        <input
                          placeholder="eg. Francisco"
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          className={inputCls}
                        />
                      </Field>
                    </div>

                    <Field label="Email">
                      <input
                        type="email"
                        required
                        placeholder="eg. johnfrans@gmail.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={inputCls}
                      />
                    </Field>

                    <Field label="Password">
                      <div className="flex items-center gap-2 rounded-[10px] bg-white/10 px-4 py-3">
                        <input
                          type={showPassword ? "text" : "password"}
                          required
                          minLength={8}
                          placeholder="Enter your password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/70"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="cursor-pointer text-white/70 transition-colors hover:text-white"
                          aria-label={
                            showPassword ? "Hide password" : "Show password"
                          }
                        >
                          {showPassword ? (
                            <Eye className="size-[18px]" />
                          ) : (
                            <EyeOff className="size-[18px]" />
                          )}
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-white/70">
                        Must be at least 8 characters.
                      </p>
                    </Field>
                  </div>

                  {error && (
                    <p className="-mt-3 text-xs text-red-400">{error}</p>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="cursor-pointer rounded-[10px] bg-white py-3 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? "Creating…" : "Sign Up"}
                  </button>

                  <p className="text-center text-sm text-white/70">
                    Already have an account?{" "}
                    <Link
                      href="/sign-in"
                      className="cursor-pointer font-semibold text-white hover:underline"
                    >
                      Log in
                    </Link>
                  </p>
                </form>
              </div>
            </>
          ) : (
            <div className="text-center">
              <h1 className="text-2xl font-medium leading-tight text-white">
                Verify your email
              </h1>
              <p className="mt-2.5 text-sm leading-relaxed text-white/80">
                We sent a verification link to {email}. Click it to activate your
                account, then sign in.
              </p>
              <Link
                href="/sign-in"
                className="mt-5 inline-block cursor-pointer text-sm font-semibold text-white underline"
              >
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const inputCls =
  "w-full rounded-[10px] bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-white/70";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-1 flex-col gap-2">
      <span className="text-sm font-medium text-white">{label}</span>
      {children}
    </label>
  );
}
