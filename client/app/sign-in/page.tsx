"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

const steps = [
  "Sign up your account",
  "Set up your workspace",
  "Deploy your app",
];

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("password", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      setError("Invalid email or password, or your email isn't verified.");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  function google() {
    // Service owns the Google identity; we bridge it into a NextAuth session.
    // Same-origin proxy (/pf-auth → auth service): the whole OAuth chain stays on
    // this app's origin, so redirectTo can be a same-site relative path.
    window.location.href = `/pf-auth/google?redirectTo=/auth/oauth-landing`;
  }

  function github() {
    toast.info("GitHub sign-in is coming soon.");
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
            Welcome Back
          </h2>
          <p className="mt-2.5 max-w-[320px] text-sm leading-relaxed text-white/80 xl:text-base">
            Log in to pick up right where you left off.
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
          <header className="text-center">
            <h1 className="text-2xl font-semibold leading-tight text-white">
              Log In to Account
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-white/80">
              Enter your details to access your account.
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
                <img src="/icons/google-color.svg" alt="" className="size-[18px]" />
                Google
              </button>
              <button
                type="button"
                onClick={github}
                className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-white/20 py-3 text-sm font-medium text-white transition-colors hover:bg-white/5"
              >
                <img src="/icons/github-white.svg" alt="" className="size-[18px]" />
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
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-white">Email</span>
                  <input
                    type="email"
                    required
                    placeholder="eg. johnfrans@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-[10px] bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-white/70"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-white">Password</span>
                  <div className="flex items-center gap-2 rounded-[10px] bg-white/10 px-4 py-3">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/70"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="cursor-pointer text-white/70 transition-colors hover:text-white"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <Eye className="size-[18px]" />
                      ) : (
                        <EyeOff className="size-[18px]" />
                      )}
                    </button>
                  </div>
                  <Link
                    href="/reset-password"
                    className="mt-1 cursor-pointer self-end text-sm font-semibold text-white/70 hover:text-white"
                  >
                    Forgot Password?
                  </Link>
                </label>
              </div>

              {error && <p className="-mt-3 text-xs text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="cursor-pointer rounded-[10px] bg-white py-3 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Signing in…" : "Log in"}
              </button>

              <p className="text-center text-sm text-white/70">
                Don&apos;t have an account?{" "}
                <Link
                  href="/sign-up"
                  className="cursor-pointer font-semibold text-white hover:underline"
                >
                  Sign Up
                </Link>
              </p>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
