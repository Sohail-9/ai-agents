"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-client";
import { KeyRound, Plus, Copy, Check, X, FlaskConical, Send, Loader2, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import Link from "next/link";
import PageShell from "@/components/PageShell";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const PG_MODELS = [
  { id: "anthropic/opus-4.8", name: "Claude Opus 4.8", icon: "/icons/claude.png" },
  { id: "anthropic/opus-4.7", name: "Claude Opus 4.7", icon: "/icons/claude.png" },
  { id: "anthropic/opus-4.6", name: "Claude Opus 4.6", icon: "/icons/claude.png" },
  { id: "anthropic/sonnet-5", name: "Claude Sonnet 5", icon: "/icons/claude.png" },
  { id: "anthropic/sonnet-4.6", name: "Claude Sonnet 4.6", icon: "/icons/claude.png" },
  { id: "openai/gpt-5.5", name: "GPT-5.5", icon: "/icons/openai.svg" },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", icon: "/icons/openai.svg" },
];
// Image-based icon for the model dropdown (Dropdown renders icon as a component).
const modelIcon = (src: string) => function ModelIcon() {
  return <img src={src} alt="" className="w-[15px] h-[15px] object-contain shrink-0" />;
};

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  last4: string;
  status: "ACTIVE" | "REVOKED";
  lastUsedAt: string | null;
  createdAt: string;
}

function fmtDate(s: string | null): string {
  if (!s) return "Never";
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function KeysPage() {
  const { getToken } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Playground ──
  const [pgOpen, setPgOpen] = useState(false);
  const [pgKey, setPgKey] = useState("");
  const [pgModel, setPgModel] = useState(PG_MODELS[0].id);
  const [pgPrompt, setPgPrompt] = useState("");
  const [pgRunning, setPgRunning] = useState(false);
  const [pgResult, setPgResult] = useState<{ content: string; cost?: number; tokensIn?: number; tokensOut?: number } | null>(null);
  const [pgError, setPgError] = useState<string | null>(null);

  const runPlayground = async () => {
    if (!pgKey.trim() || !pgPrompt.trim() || pgRunning) return;
    setPgRunning(true);
    setPgResult(null);
    setPgError(null);
    try {
      const r = await fetch(`${API_URL}/api/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pgKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: pgModel, messages: [{ role: "user", content: pgPrompt.trim() }] }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = d?.error?.message ?? d?.error ?? `Request failed (${r.status})`;
        setPgError(r.status === 402 ? "Out of credits — top up to use the API." : String(msg));
        return;
      }
      setPgResult({
        content: d?.choices?.[0]?.message?.content ?? "(empty response)",
        cost: d?.usage?.cost,
        tokensIn: d?.usage?.prompt_tokens,
        tokensOut: d?.usage?.completion_tokens,
      });
    } catch {
      setPgError("Network error — could not reach the endpoint.");
    } finally {
      setPgRunning(false);
    }
  };

  const authFetch = useCallback(async (url: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  }, [getToken]);

  const load = useCallback(() => {
    setLoading(true);
    authFetch(`${API_URL}/api/v1/keys`)
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d) => setKeys(d.keys ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const r = await authFetch(`${API_URL}/api/v1/keys`, { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      const d = await r.json();
      if (r.ok && d.key) { setNewKey(d.key); setPgKey(d.key); load(); }
    } finally { setCreating(false); }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this key? Apps using it will stop working immediately.")) return;
    await authFetch(`${API_URL}/api/v1/keys/${id}`, { method: "DELETE" });
    load();
  };

  const closeModal = () => { setModalOpen(false); setName(""); setNewKey(null); setCopied(false); };

  return (
    <PageShell>
      <div className="flex-1 flex min-w-0 overflow-hidden">
      <main className="flex-1 overflow-y-auto scrollbar-subtle min-w-0" style={{ background: "#1C1C1C" }}>
        <div className="px-10 md:px-16 pt-10 pb-16">

          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-[38px] font-bold text-white tracking-tight leading-none">API Keys</h1>
            <div className="flex items-center gap-2">
              {keys.length > 0 && !pgOpen && (
                <GlassButton size="sm" onClick={() => setPgOpen(true)}>
                  <FlaskConical className="w-4 h-4" />
                  Playground
                </GlassButton>
              )}
              <GlassButton size="sm" onClick={() => setModalOpen(true)}>
                <Plus className="w-4 h-4" />
                Create key
              </GlassButton>
            </div>
          </div>
          <Link
            href="/dashboard/keys/docs"
            className="inline-block text-[14px] mb-8 cursor-pointer transition-colors hover:opacity-80"
            style={{ color: "#FF8CEC" }}
          >
            How to use? →
          </Link>

          {/* Table / empty state */}
          {loading ? (
            <p className="text-[14px] text-white/25 py-8">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-14 h-14 rounded-full flex items-center justify-center mb-4" style={{ background: "rgba(255,255,255,0.05)" }}>
                <KeyRound className="w-6 h-6 text-white/40" />
              </div>
              <p className="text-[15px] text-white/70 font-medium">No keys yet.</p>
              <p className="text-[13px] text-white/40 mt-1">Create your first key to start calling the router.</p>
            </div>
          ) : (
            <div>
              <div className="grid text-[13px] text-white/35 font-normal pb-2" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr 0.8fr 0.8fr" }}>
                <span>Name</span><span>Key</span><span>Created</span><span>Last used</span><span>Status</span><span className="text-right">Actions</span>
              </div>
              {keys.map((k) => {
                const revoked = k.status === "REVOKED";
                return (
                  <div key={k.id} className="grid items-center py-[14px]" style={{ gridTemplateColumns: "1.2fr 1.4fr 1fr 1fr 0.8fr 0.8fr", borderTop: "1px solid rgba(255,255,255,0.07)", opacity: revoked ? 0.45 : 1 }}>
                    <span className="text-[14px] text-white/85 truncate pr-3">{k.name}</span>
                    <span className="text-[13px] text-white/55 font-mono truncate pr-3">{k.keyPrefix}{k.last4}</span>
                    <span className="text-[14px] text-white/60">{fmtDate(k.createdAt)}</span>
                    <span className="text-[14px] text-white/60">{fmtDate(k.lastUsedAt)}</span>
                    <span>
                      <span className="text-[11px] font-semibold px-2 py-[3px] rounded-full" style={revoked ? { color: "#f87171", border: "1px solid rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.08)" } : { color: "#34d399", border: "1px solid rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.08)" }}>
                        {revoked ? "Revoked" : "Active"}
                      </span>
                    </span>
                    <span className="text-right">
                      {!revoked && (
                        <button onClick={() => revoke(k.id)} className="text-[13px] font-medium cursor-pointer hover:opacity-75 transition-opacity" style={{ color: "#f87171" }}>Revoke</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Playground side panel */}
      <AnimatePresence>
        {pgOpen && (
          <motion.aside
            key="playground"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 420, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: "spring", damping: 30, stiffness: 260 }}
            className="shrink-0 h-full overflow-hidden"
            style={{ borderLeft: "1px solid rgba(255,255,255,0.08)", background: "#202020" }}
          >
            <div className="w-[420px] h-full flex flex-col">
              {/* Panel header */}
              <div className="flex items-center justify-between px-5 h-[60px] shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="flex items-center gap-2">
                  <FlaskConical className="w-4 h-4" style={{ color: "#FF15DC" }} />
                  <span className="text-[15px] font-semibold text-white">Playground</span>
                </div>
                <button onClick={() => setPgOpen(false)} className="text-white/40 hover:text-white cursor-pointer" title="Collapse">
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>

              {/* Panel body */}
              <div className="flex-1 overflow-y-auto scrollbar-subtle px-5 py-5 flex flex-col gap-4">
                {/* Key */}
                <div>
                  <label className="text-[12px] uppercase tracking-wide text-white/40 mb-1.5 block">API key</label>
                  <input
                    type="password" value={pgKey} onChange={(e) => setPgKey(e.target.value)}
                    placeholder="pk_…"
                    className="w-full rounded-[10px] px-3 py-2 text-[13px] text-white/85 font-mono outline-none"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                  />
                  <p className="text-[11.5px] text-white/30 mt-1">Paste a key — keys are shown only once at creation.</p>
                </div>

                {/* Model */}
                <div>
                  <label className="text-[12px] uppercase tracking-wide text-white/40 mb-1.5 block">Model</label>
                  <Dropdown
                    id="pg-model"
                    align="left"
                    className="w-full"
                    width={372}
                    activeItemId={pgModel}
                    onItemSelect={setPgModel}
                    items={PG_MODELS.map((m) => ({ id: m.id, label: m.name, icon: modelIcon(m.icon) }))}
                    trigger={
                      <div
                        className="flex items-center justify-between w-full rounded-[10px] px-3 py-2 text-[13.5px] text-white/85 cursor-pointer transition-colors hover:bg-white/[0.07]"
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                      >
                        <span className="flex items-center gap-2">
                          {(() => { const cur = PG_MODELS.find((m) => m.id === pgModel); return cur ? <img src={cur.icon} alt="" className="w-[15px] h-[15px] object-contain shrink-0" /> : null; })()}
                          {PG_MODELS.find((m) => m.id === pgModel)?.name ?? "Select model"}
                        </span>
                        <ChevronDown className="w-4 h-4 text-white/40 shrink-0" />
                      </div>
                    }
                  />
                </div>

                {/* Prompt */}
                <div>
                  <label className="text-[12px] uppercase tracking-wide text-white/40 mb-1.5 block">Prompt</label>
                  <textarea
                    value={pgPrompt} onChange={(e) => setPgPrompt(e.target.value)}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runPlayground(); }}
                    rows={4} placeholder="Ask something…"
                    className="w-full rounded-[10px] px-3 py-2.5 text-[13.5px] text-white/90 outline-none resize-none scrollbar-subtle"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                  />
                </div>

                <GlassButton size="sm" onClick={runPlayground} disabled={pgRunning || !pgKey.trim() || !pgPrompt.trim()}>
                  {pgRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {pgRunning ? "Sending…" : "Send"}
                </GlassButton>

                {/* Result */}
                {pgError && (
                  <div className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.35)", color: "#f87171" }}>
                    {pgError}
                  </div>
                )}
                {pgResult && (
                  <div>
                    <label className="text-[12px] uppercase tracking-wide text-white/40 mb-1.5 block">Response</label>
                    <div className="rounded-[10px] px-3.5 py-3 text-[13.5px] text-white/85 whitespace-pre-wrap leading-relaxed" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                      {pgResult.content}
                    </div>
                    {(pgResult.cost != null || pgResult.tokensIn != null) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11.5px] text-white/40 tabular-nums">
                        {pgResult.tokensIn != null && <span>in {pgResult.tokensIn.toLocaleString()}</span>}
                        {pgResult.tokensOut != null && <span>out {pgResult.tokensOut.toLocaleString()}</span>}
                        {pgResult.cost != null && <span style={{ color: "#FF8CEC" }}>${pgResult.cost.toFixed(6)}</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
      </div>

      {/* Create modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closeModal}>
          <div className="w-[460px] max-w-[92vw] rounded-[18px] p-6" style={{ background: "#252525", border: "1px solid rgba(255,255,255,0.1)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[20px] font-bold text-white">{newKey ? "Key created" : "Create API key"}</h2>
              <button onClick={closeModal} className="text-white/40 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>

            {!newKey ? (
              <>
                <label className="text-[13px] text-white/55 mb-1.5 block">Key name</label>
                <input
                  autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                  placeholder="e.g. Production server"
                  className="w-full rounded-[12px] px-3.5 py-2.5 text-[14px] text-white outline-none mb-5"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                />
                <div className="flex justify-end gap-2">
                  <GlassButton size="sm" onClick={closeModal}>Cancel</GlassButton>
                  <GlassButton size="sm" onClick={create} disabled={creating || !name.trim()}>{creating ? "Creating…" : "Create"}</GlassButton>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-[12px] px-3.5 py-2.5 mb-3 text-[12.5px]" style={{ background: "rgba(255,21,220,0.08)", border: "1px solid rgba(255,21,220,0.3)", color: "#FF8CEC" }}>
                  Copy now — this key is never shown again.
                </div>
                <div className="flex items-center gap-2 mb-5">
                  <input readOnly value={newKey} className="flex-1 rounded-[12px] px-3.5 py-2.5 text-[13px] text-white/85 font-mono outline-none" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }} />
                  <button
                    onClick={() => { navigator.clipboard.writeText(newKey); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    className="shrink-0 w-10 h-10 rounded-[12px] flex items-center justify-center cursor-pointer hover:bg-white/10 transition-colors"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
                  >
                    {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-white/60" />}
                  </button>
                </div>
                <div className="flex justify-end">
                  <GlassButton size="sm" onClick={closeModal}>Done</GlassButton>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </PageShell>
  );
}
