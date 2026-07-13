"use client";

import { useEffect, useState, useCallback } from "react";
import { useUser, useAuth } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { GlassButton } from "@/components/ui/glass-button";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

type PlanId = "FREE" | "STANDARD" | "PRO";
type Billing = "monthly" | "annual";

interface PlanDef {
  id: PlanId;
  name: string;
  description: string;
  price: number;
  credits: number;
  creditLabel: string;
  features: string[];
  highlight: boolean;
  planEnvKey?: string;
}

const PLANS: PlanDef[] = [
  {
    id: "FREE",
    name: "",
    description: "Get started for free",
    price: 0,
    credits: 2000,
    creditLabel: "2,000 credits",
    features: [
      "2,000 credits",
      "Basic formatting",
      "Community access",
    ],
    highlight: false,
  },
  {
    id: "STANDARD",
    name: "Standard",
    description: "Perfect for getting Started",
    price: 24.99,
    credits: 10000,
    creditLabel: "10,000 credits",
    features: [
      "Core autonomous system building",
      "Community support",
      "Manual credit top-ups available",
      "Github export",
    ],
    highlight: true,
    planEnvKey: "STANDARD",
  },
  {
    id: "PRO",
    name: "Pro",
    description: "For Power Users",
    price: 59.99,
    credits: 50000,
    creditLabel: "50,000 credits",
    features: [
      "Faster AI execution priority",
      "Parallel builds (up to 3)",
      "Export & deploy support",
      "Basic analytics dashboard",
      "Email + chat support",
      "Manual credit top-ups available",
      "Github export",
    ],
    highlight: false,
    planEnvKey: "PRO",
  },
];

export default function PricingPage() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();

  const [billing, setBilling] = useState<Billing>("monthly");
  const [currentPlan, setCurrentPlan] = useState<PlanId | null>(null);
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [proExpanded, setProExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(
    () => `usr_${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  );

  const authFetch = useCallback(async (url: string, opts?: RequestInit) => {
    const token = await getToken();
    return fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(opts?.headers ?? {}),
      },
    });
  }, [getToken]);

  useEffect(() => {
    if (isLoaded && !user) router.push("/sign-in");
  }, [isLoaded, user, router]);

  useEffect(() => {
    if (!user) return;
    authFetch(`${BACKEND_URL}/api/user/credits`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.plan) setCurrentPlan(d.plan as PlanId); })
      .catch(() => { });
  }, [user, authFetch]);

  const handleGetStarted = async (plan: PlanDef) => {
    if (plan.id === "FREE" || !plan.planEnvKey) return;
    if (currentPlan === plan.id) return;
    setLoadingPlan(plan.id);
    setError(null);
    try {
      const planId =
        plan.id === "STANDARD"
          ? process.env.NEXT_PUBLIC_PLAN_STANDARD
          : process.env.NEXT_PUBLIC_PLAN_PRO;

      const res = await authFetch(`${BACKEND_URL}/api/payments`, {
        method: "POST",
        body: JSON.stringify({
          paymentPlan: plan.id,
          idempotencyKey,
          provider: "dodo",
          planId,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed to initiate payment"); return; }
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
      else setError("No checkout URL received");
    } catch (e: any) {
      setError(e?.message || "An error occurred. Please try again.");
    } finally {
      setLoadingPlan(null);
    }
  };

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#1C1C1C" }}>
        <Loader2 className="w-7 h-7 animate-spin text-[#FF15DC]" />
      </div>
    );
  }
  if (!user) return null;

  const isAnnual = billing === "annual";

  return (
    <div className="min-h-screen" style={{ background: "#1C1C1C" }}>

      {/* Error toast */}
      {error && (
        <div className="fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 text-[13px]">
          {error}
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col items-center px-6 pt-8 pb-10">

        {/* Heading */}
        <h1 className="text-[36px] font-bold text-white text-center tracking-tight mb-2">
          Simple Transparent Pricing
        </h1>
        <p className="text-[16px] text-white/45 text-center mb-7">
          Choose What&apos;s best for you
        </p>

        {/* Monthly / Annual toggle */}
        <div className="flex items-center gap-4 mb-8">
          <span className="text-[15px] font-medium" style={{ color: billing === "monthly" ? "white" : "rgba(255,255,255,0.4)" }}>
            Monthly
          </span>

          <button
            onClick={() => setBilling((b) => b === "monthly" ? "annual" : "monthly")}
            className="relative cursor-pointer"
            style={{
              width: 64,
              height: 32,
              borderRadius: 999,
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 3,
                left: isAnnual ? 35 : 3,
                width: 26,
                height: 26,
                borderRadius: 999,
                background: "#ffffff",
                transition: "left 0.22s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
          </button>

          <span className="text-[15px] font-medium" style={{ color: billing === "annual" ? "white" : "rgba(255,255,255,0.4)" }}>
            Annual
          </span>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-3 gap-5 w-full max-w-[1080px] items-end">
          {PLANS.map((plan) => {
            const isCurrent = currentPlan === plan.id;
            const isLoading = loadingPlan === plan.id;

            return (
              <div
                key={plan.id}
                className="relative flex flex-col rounded-2xl transition-all"
                style={{
                  background: "#252525",
                  border: plan.highlight
                    ? "1.5px solid #FF15DC"
                    : "1px solid rgba(255,255,255,0.1)",
                  boxShadow: plan.highlight
                    ? "0 0 24px rgba(255,21,220,0.10)"
                    : "none",
                  padding: plan.highlight ? "28px 26px 40px" : plan.id === "PRO" ? "22px 22px 22px" : "22px 22px 26px",
                  marginTop: 0,
                  minHeight: plan.highlight ? 420 : 360,
                }}
              >
                {/* Plan name + description */}
                <h2 className="text-[22px] font-bold text-white mb-1">{plan.name}</h2>
                <p className="text-[13px] text-white/50 mb-5">{plan.description}</p>

                {/* Price */}
                <div className="flex items-baseline gap-2 mb-5">
                  <span className="text-[38px] font-bold text-white leading-none">
                    {plan.price === 0 ? "Free" : `$${plan.price}`}
                  </span>
                  {plan.price > 0 && (
                    <span className="text-[14px] text-white/45 font-normal">per month</span>
                  )}
                </div>

                {/* Credits selector (static display) */}
                <div
                  className="flex items-center justify-between px-4 py-3 rounded-xl mb-5"
                  style={{
                    background: "#1e1e1e",
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                >
                  <span className="text-[14px] text-white/80">{plan.creditLabel}</span>
                  <ChevronDown className="w-4 h-4 text-white/40" />
                </div>

                {/* What's included */}
                <p className="text-[13px] text-white/55 font-medium mb-2.5">What&apos;s included:</p>
                <ul className="mb-3 flex-1" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(plan.id === "PRO" && !proExpanded ? plan.features.slice(0, 1) : plan.features).map((f) => (
                    <li key={f} className="flex items-center gap-2.5">
                      <Check className="w-[14px] h-[14px] shrink-0 text-[#FF15DC]" />
                      <span className="text-[13px] text-white/72">{f}</span>
                    </li>
                  ))}
                </ul>
                {plan.id === "PRO" && (
                  <button
                    onClick={() => setProExpanded((v) => !v)}
                    className="text-[12.5px] font-medium text-white/40 hover:text-white/70 transition-colors cursor-pointer text-left mb-4"
                  >
                    {proExpanded ? "Less ↑" : "More... ↓"}
                  </button>
                )}

                {/* CTA button */}
                {isAnnual ? (
                  <div
                    className="w-full py-3 rounded-xl text-center text-[14px] font-semibold"
                    style={{ background: "rgba(255,21,220,0.08)", color: "#FF15DC", border: "1px solid rgba(255,21,220,0.25)" }}
                  >
                    Coming Soon
                  </div>
                ) : isCurrent ? (
                  <GlassButton size="md" disabled className="w-full pointer-events-none opacity-60">
                    Current Plan
                  </GlassButton>
                ) : plan.id === "FREE" ? (
                  <div
                    className="w-full py-3 rounded-xl text-center text-[14px] font-semibold"
                    style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)", cursor: "default" }}
                  >
                    Free Forever
                  </div>
                ) : (
                  <button
                    onClick={() => handleGetStarted(plan)}
                    disabled={isLoading}
                    className="w-full py-3 rounded-xl text-[14px] font-semibold text-white flex items-center justify-center gap-2 cursor-pointer transition-opacity hover:opacity-90 disabled:opacity-50"
                    style={{
                      background: "#e010c8",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.28), inset 1px 0 0 rgba(255,255,255,0.10), inset -1px 0 0 rgba(255,255,255,0.10)",
                    }}
                  >
                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Get Started"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Annual coming soon banner */}
        {isAnnual && (
          <div
            className="mt-8 px-6 py-3 rounded-xl text-[14px] text-white/60 border border-white/[0.08]"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            Annual billing is coming soon. Stay tuned for discounts!
          </div>
        )}

      </div>
    </div>
  );
}
