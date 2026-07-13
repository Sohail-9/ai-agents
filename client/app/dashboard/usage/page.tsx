"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-client";
import Link from "next/link";
import { CreditCard } from "lucide-react";
import PageShell from "@/components/PageShell";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface Summary { balanceUsd: number; totalSpent: number; totalRequests: number; promptTokens: number; completionTokens: number; totalTokens: number; models: { id: string; displayName: string }[]; }
interface Record { id: string; createdAt: string; modelId: string; promptTokens: number; completionTokens: number; cost: number; status: string; keyPrefix: string; }

function relTime(s: string): string {
  const diff = Date.now() - new Date(s).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}
const fmtCost = (n: number) => `$${n.toFixed(6)}`;
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
// Adaptive: tiny sub-cent spend shows full precision instead of rounding to $0.00.
const fmtSpend = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`);
// Compact token count: <1K shown in full, then K, then M. Trailing .0 stripped.
const trim = (s: string) => s.replace(/\.0$/, "");
const fmtTokens = (n: number) => {
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}K`;
  return n.toLocaleString();
};

export default function UsagePage() {
  const { getToken } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [records, setRecords] = useState<Record[]>([]);
  const [keys, setKeys] = useState<{ id: string; keyPrefix: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [model, setModel] = useState("");
  const [keyId, setKeyId] = useState("");
  const [days, setDays] = useState("7");
  const limit = 25;

  const authFetch = useCallback(async (url: string) => {
    const token = await getToken();
    return fetch(url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  }, [getToken]);

  useEffect(() => {
    authFetch(`${API_URL}/api/v1/usage/summary`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setSummary(d)).catch(() => {});
    authFetch(`${API_URL}/api/v1/keys`).then((r) => (r.ok ? r.json() : { keys: [] })).then((d) => setKeys(d.keys ?? [])).catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    const q = new URLSearchParams({ page: String(page), limit: String(limit), days });
    if (model) q.set("model", model);
    if (keyId) q.set("keyId", keyId);
    authFetch(`${API_URL}/api/v1/usage?${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setRecords(d.records ?? []); setTotal(d.total ?? 0); } })
      .catch(() => {});
  }, [authFetch, page, model, keyId, days]);

  const selectStyle = "rounded-[10px] px-3 py-1.5 text-[13px] text-white/80 outline-none cursor-pointer";
  const selectInline = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" };
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <PageShell>
      <main className="flex-1 overflow-y-auto scrollbar-subtle" style={{ background: "#1C1C1C" }}>
        <div className="px-10 md:px-16 pt-10 pb-16">

          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-[38px] font-bold text-white tracking-tight leading-none mb-2">Usage &amp; Credits</h1>
              <p className="text-[14px] text-white/45">Router spend, per request.</p>
            </div>
            <Link href="/pricing"><GlassButton size="sm"><CreditCard className="w-4 h-4" />Buy credits</GlassButton></Link>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-10">
            {[
              { label: "Balance", value: summary ? fmtUsd(summary.balanceUsd) : "—", accent: true },
              { label: "Total spent", value: summary ? fmtSpend(summary.totalSpent) : "—", title: summary ? fmtCost(summary.totalSpent) : undefined },
              { label: "Requests", value: summary ? summary.totalRequests.toLocaleString() : "—" },
              { label: "Total tokens", value: summary ? fmtTokens(summary.totalTokens) : "—", title: summary ? summary.totalTokens.toLocaleString() : undefined },
              { label: "Tokens in", value: summary ? fmtTokens(summary.promptTokens) : "—", title: summary ? summary.promptTokens.toLocaleString() : undefined },
              { label: "Tokens out", value: summary ? fmtTokens(summary.completionTokens) : "—", title: summary ? summary.completionTokens.toLocaleString() : undefined },
            ].map((c) => (
              <div key={c.label} className="rounded-[14px] p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <p className="text-[11.5px] uppercase tracking-wide text-white/40 mb-1.5">{c.label}</p>
                <p className="text-[19px] font-bold tracking-tight tabular-nums truncate" title={c.title ?? c.value} style={{ color: c.accent ? "#FF15DC" : "#fff" }}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <select className={selectStyle} style={selectInline} value={model} onChange={(e) => { setPage(1); setModel(e.target.value); }}>
              <option value="">All models</option>
              {summary?.models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
            <select className={selectStyle} style={selectInline} value={keyId} onChange={(e) => { setPage(1); setKeyId(e.target.value); }}>
              <option value="">All keys</option>
              {keys.map((k) => <option key={k.id} value={k.id}>{k.keyPrefix}</option>)}
            </select>
            <select className={selectStyle} style={selectInline} value={days} onChange={(e) => { setPage(1); setDays(e.target.value); }}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="0">All time</option>
            </select>
          </div>

          {/* Table */}
          <div className="grid text-[13px] text-white/35 font-normal pb-2" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr 1.2fr 1.2fr" }}>
            <span>Time</span><span>Model</span><span className="text-right">Tokens in</span><span className="text-right">Tokens out</span><span className="text-right">Cost</span><span className="text-right">Key</span>
          </div>
          {records.length === 0 ? (
            <p className="text-[14px] text-white/25 py-8">No usage in this range.</p>
          ) : (
            records.map((r) => (
              <div key={r.id} className="grid items-center py-[13px]" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr 1.2fr 1.2fr", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <span className="text-[14px] text-white/70" title={new Date(r.createdAt).toLocaleString()}>{relTime(r.createdAt)}</span>
                <span className="text-[14px] text-white/85 truncate pr-3">{r.modelId}</span>
                <span className="text-right text-[14px] text-white/60 tabular-nums" title={r.promptTokens.toLocaleString()}>{fmtTokens(r.promptTokens)}</span>
                <span className="text-right text-[14px] text-white/60 tabular-nums" title={r.completionTokens.toLocaleString()}>{fmtTokens(r.completionTokens)}</span>
                <span className="text-right text-[14px] font-medium tabular-nums" style={{ color: "#FF15DC" }}>{fmtCost(r.cost)}</span>
                <Link href="/dashboard/keys" className="text-right text-[13px] text-white/50 font-mono truncate hover:text-white/80 transition-colors">{r.keyPrefix}</Link>
              </div>
            ))
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-3 mt-6">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="text-[13px] text-white/60 disabled:opacity-30 cursor-pointer disabled:cursor-default hover:text-white">Prev</button>
              <span className="text-[13px] text-white/40">{page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="text-[13px] text-white/60 disabled:opacity-30 cursor-pointer disabled:cursor-default hover:text-white">Next</button>
            </div>
          )}
        </div>
      </main>
    </PageShell>
  );
}
