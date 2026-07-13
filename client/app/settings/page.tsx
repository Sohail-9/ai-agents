"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth, useUser } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, Crown, ArrowRight, KeyRound } from "lucide-react";
import PageShell from "@/components/PageShell";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const CREDIT_MAX = 10000;

interface CreditsData {
  credits: number;
  availableCredits: number;
  plan: "PRO" | "STANDARD" | "FREE";
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  agentRunId: string | null;
  createdAt: string;
}

function formatReason(reason: string): string {
  switch (reason) {
    case "agent_run": return "Agent Run";
    case "agent_run_capped": return "Agent Run";
    case "topup": return "Credit Top-up";
    case "manual_refund": return "Credit Refund";
    default: return reason.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export default function SettingsPage() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();

  const [credits, setCredits] = useState<CreditsData | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [showAll, setShowAll] = useState(false);

  const authFetch = useCallback(async (url: string) => {
    const token = await getToken();
    return fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  }, [getToken]);

  useEffect(() => {
    authFetch(`${API_URL}/api/user/credits`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setCredits(d); })
      .catch(() => {});
    authFetch(`${API_URL}/api/user/ledger?limit=50`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.entries) setLedger(d.entries); })
      .catch(() => {});
  }, [authFetch]);

  // Inline name edit against the auth service (PATCH /api/auth/me). Replaces
  // Clerk's hosted profile modal (openUserProfile) which no longer exists.
  const editProfile = useCallback(async () => {
    const current = user?.fullName || "";
    const next = typeof window !== "undefined" ? window.prompt("Your name", current) : null;
    if (next == null || next.trim() === current) return;
    const [firstName, ...rest] = next.trim().split(" ").filter(Boolean);
    const token = await getToken();
    await fetch(`/pf-auth/me`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: firstName ?? "", lastName: rest.join(" ") }),
    });
    if (typeof window !== "undefined") window.location.reload();
  }, [getToken, user?.fullName]);

  const available = credits?.availableCredits ?? 0;
  const pct = Math.round((available / CREDIT_MAX) * 100);
  const visibleLedger = showAll ? ledger : ledger.slice(0, 4);

  return (
    <PageShell>
      <main className="flex-1 overflow-y-auto scrollbar-subtle" style={{ background: "#1C1C1C" }}>
        <div className="px-10 md:px-16 pt-10 pb-16">

          {/* Page title */}
          <h1 className="text-[38px] font-bold text-white tracking-tight leading-none mb-2">Settings</h1>
          <p className="text-[14px] text-white/45 mb-8">Manage your account and view your credit usage.</p>

          {/* ── Profile ────────────────────────────────────────────── */}
          <div className="flex items-start gap-7 mb-8">

            {/* Avatar */}
            <div className="relative shrink-0">
              <div className="w-[90px] h-[90px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white/30 text-3xl font-medium">
                    {user?.firstName?.[0] ?? "?"}
                  </div>
                )}
              </div>
              <button
                onClick={editProfile}
                className="absolute bottom-0 right-0 w-[30px] h-[30px] rounded-full flex items-center justify-center cursor-pointer"
                style={{ background: "#252525", border: "1.5px solid rgba(255,255,255,0.14)" }}
              >
                <Pencil className="w-[13px] h-[13px] text-white/60" />
              </button>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 pt-1">
              <div className="mb-4">
                <p className="text-[14px] text-white/55 mb-[3px]">Name:</p>
                <p className="text-[19px] font-medium text-white/90 leading-tight">
                  {user?.fullName || user?.firstName || "—"}
                </p>
              </div>
              <div>
                <p className="text-[14px] text-white/55 mb-[3px]">Email:</p>
                <p className="text-[16px] text-white/75 leading-tight">
                  {user?.primaryEmailAddress?.emailAddress || "—"}
                </p>
              </div>
            </div>

            {/* Edit Profile */}
            <GlassButton size="sm" onClick={editProfile} className="shrink-0" style={{ marginTop: 4 }}>
              <Pencil className="w-3.5 h-3.5" />
              Edit Profile
            </GlassButton>
          </div>

          {/* Divider */}
          <div className="mb-7" style={{ height: 1, background: "rgba(255,255,255,0.09)" }} />

          {/* ── Security ────────────────────────────────────────────── */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <p className="text-[14px] text-white/55 mb-[3px]">Password:</p>
              <p className="text-[16px] text-white/75 leading-tight">
                Reset your password via a code sent to your email.
              </p>
            </div>
            <Link href="/reset-password">
              <GlassButton size="sm" className="shrink-0">
                <KeyRound className="w-3.5 h-3.5" />
                Reset Password
              </GlassButton>
            </Link>
          </div>

          {/* Divider */}
          <div className="mb-7" style={{ height: 1, background: "rgba(255,255,255,0.09)" }} />

          {/* ── Credits ─────────────────────────────────────────────── */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[26px] font-bold text-white tracking-tight">Credits</h2>

              {/* Plan badge */}
              {credits && (
                <button
                  onClick={() => router.push("/pricing")}
                  className="flex items-center gap-2 px-4 py-[7px] rounded-full text-[13.5px] font-semibold cursor-pointer hover:opacity-80 transition-opacity"
                  style={
                    credits.plan === "PRO"
                      ? { color: "#FF15DC", border: "1.5px solid #FF15DC", background: "transparent" }
                      : credits.plan === "STANDARD"
                      ? { color: "#a78bfa", border: "1.5px solid #a78bfa", background: "transparent" }
                      : { color: "rgba(255,255,255,0.45)", border: "1.5px solid rgba(255,255,255,0.18)", background: "transparent" }
                  }
                >
                  {credits.plan === "PRO" && (
                    <Crown className="w-4 h-4" style={{ fill: "#FF15DC", stroke: "none" }} />
                  )}
                  {credits.plan === "PRO" ? "Pro Plan" : credits.plan === "STANDARD" ? "Standard Plan" : "Free Plan"}
                  <span className="opacity-60 text-[12px]">Upgrade →</span>
                </button>
              )}
            </div>

            {/* Big number */}
            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-[36px] font-bold text-white leading-none tracking-tight">
                {available.toLocaleString()}
              </span>
              <span className="text-[16px] text-white/50 font-normal">credits</span>
            </div>

            {/* Progress bar */}
            <div
              className="w-full rounded-full mb-3"
              style={{ height: 9, background: "rgba(255,255,255,0.1)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, pct)}%`,
                  background: "linear-gradient(90deg, #FF15DC 0%, #FF6EE7 100%)",
                  transition: "width 0.7s ease",
                }}
              />
            </div>

            {/* Stats row */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/45">{pct}% remaining</span>
              <span className="text-[13px] text-white/40">
                {available.toLocaleString()}/{CREDIT_MAX.toLocaleString()}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div className="mb-8" style={{ height: 1, background: "rgba(255,255,255,0.09)" }} />

          {/* ── Credit Usage ─────────────────────────────────────────── */}
          <div>
            <h2 className="text-[26px] font-bold text-white tracking-tight mb-1">Credit Usage</h2>
            <p className="text-[13px] text-white/40 mb-6">A summary of How your Credits has been Used.</p>

            {/* Table header */}
            <div
              className="grid text-[13px] text-white/35 font-normal pb-2"
              style={{ gridTemplateColumns: "70px 200px 1fr 130px" }}
            >
              <span>S.no</span>
              <span>Date</span>
              <span>Activity</span>
              <span className="text-right">Credits Used</span>
            </div>

            {/* Rows */}
            {visibleLedger.length === 0 ? (
              <p className="text-[14px] text-white/25 py-8">No activity yet.</p>
            ) : (
              visibleLedger.map((entry, i) => (
                <div
                  key={entry.id}
                  className="grid items-center py-[14px]"
                  style={{
                    gridTemplateColumns: "70px 200px 1fr 130px",
                    borderTop: "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <span className="text-[14px] text-white/60">{i + 1}</span>
                  <span className="text-[14px] text-white/70">{formatDate(entry.createdAt)}</span>
                  <span className="text-[14px] text-white/85">{formatReason(entry.reason)}</span>
                  <span
                    className="text-right text-[14px] font-medium"
                    style={{ color: entry.delta < 0 ? "#FF15DC" : "#4ade80" }}
                  >
                    {entry.delta > 0 ? "+" : ""}{entry.delta.toLocaleString()}
                  </span>
                </div>
              ))
            )}

            {/* View All Activity */}
            {ledger.length > 4 && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="flex items-center gap-2 mt-7 text-[14px] font-semibold cursor-pointer hover:opacity-75 transition-opacity"
                style={{ color: "#FF15DC" }}
              >
                {showAll ? "Show Less" : "View All Activity"}
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>

        </div>
      </main>
    </PageShell>
  );
}
