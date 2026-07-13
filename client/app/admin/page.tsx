"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Copy, LogOut, Trash2, Plus, RefreshCw, Loader, Download, CheckSquare, Square, Key, CreditCard } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface DemoKey {
  id: string;
  key: string;
  status: "UNCLAIMED" | "CLAIMED" | "REVOKED";
  createdAt: string;
  claimedBy?: string;
  claimedAt?: string;
}

interface Stats {
  totalKeys: number;
  unclaimedKeys: number;
  claimedKeys: number;
  revokedKeys: number;
  claimRate: number;
  lastKeyGeneratedAt?: string;
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const statusStyles: Record<DemoKey["status"], string> = {
  UNCLAIMED: "bg-amber-500/10 text-amber-400",
  CLAIMED:   "bg-emerald-500/10 text-emerald-400",
  REVOKED:   "bg-red-500/10 text-red-400",
};

export default function AdminPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [keys, setKeys]         = useState<DemoKey[]>([]);
  const [stats, setStats]       = useState<Stats | null>(null);
  const [bulkCount, setBulkCount] = useState(10);
  const [loading, setLoading]   = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter]     = useState<"ALL" | "UNCLAIMED" | "CLAIMED" | "REVOKED">("ALL");

  useEffect(() => {
    const token = localStorage.getItem("admin_token");
    if (token) { setAdminToken(token); setIsAuthenticated(true); refresh(token); }
  }, []);

  const hdrs = useCallback((token?: string) => ({
    "Content-Type": "application/json",
    "x-admin-token": token || adminToken,
  }), [adminToken]);

  const refresh = async (token?: string) => {
    await Promise.all([fetchKeys(token), fetchStats(token)]);
  };

  const fetchKeys = async (token?: string, activeFilter?: typeof filter) => {
    setLoading(true);
    try {
      const f = activeFilter ?? filter;
      const q = f !== "ALL" ? `?status=${f}` : "";
      const res = await fetch(`${API_URL}/api/demo-access/admin/list${q}`, { headers: hdrs(token) });
      if (res.ok) { setKeys(await res.json()); setSelected(new Set()); }
    } catch { toast.error("Failed to fetch keys"); }
    finally { setLoading(false); }
  };

  const fetchStats = async (token?: string) => {
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/stats`, { headers: hdrs(token) });
      if (res.ok) setStats(await res.json());
    } catch {}
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(""); setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem("admin_token", data.token);
        setAdminToken(data.token); setIsAuthenticated(true);
        setEmail(""); setPassword("");
        refresh(data.token);
      } else {
        const data = await res.json();
        setLoginError(data.error || "Invalid credentials");
      }
    } catch { setLoginError("Connection error"); }
    finally { setLoading(false); }
  };

  const handleLogout = () => {
    localStorage.removeItem("admin_token");
    setIsAuthenticated(false); setAdminToken("");
    setKeys([]); setStats(null); setSelected(new Set());
  };

  const generateKey = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/generate`, { method: "POST", headers: hdrs() });
      if (res.ok) { toast.success("Key generated"); refresh(); }
      else toast.error("Failed to generate key");
    } catch { toast.error("Error"); }
    finally { setLoading(false); }
  };

  const generateBulk = async () => {
    if (bulkCount < 1 || bulkCount > 1000) { toast.error("Count must be 1–1000"); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/generate-bulk`, {
        method: "POST", headers: hdrs(), body: JSON.stringify({ count: bulkCount }),
      });
      if (res.ok) { toast.success(`${bulkCount} keys generated`); refresh(); }
      else toast.error("Failed to generate keys");
    } catch { toast.error("Error"); }
    finally { setLoading(false); }
  };

  const deleteKey = async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/${id}`, { method: "DELETE", headers: hdrs() });
      if (res.ok) { setKeys((prev) => prev.filter((k) => k.id !== id)); fetchStats(); }
      else toast.error("Failed to delete");
    } catch { toast.error("Error"); }
  };

  const deleteSelected = async () => {
    if (!confirm(`Delete ${selected.size} key${selected.size > 1 ? "s" : ""}?`)) return;
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) =>
      fetch(`${API_URL}/api/demo-access/admin/${id}`, { method: "DELETE", headers: hdrs() })
    ));
    setKeys((prev) => prev.filter((k) => !selected.has(k.id)));
    setSelected(new Set());
    toast.success(`Deleted ${ids.length} key${ids.length > 1 ? "s" : ""}`);
    fetchStats();
  };

  const copySelected = () => {
    const text = keys.filter((k) => selected.has(k.id)).map((k) => k.key).join("\n");
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${selected.size} key${selected.size > 1 ? "s" : ""}`);
  };

  const downloadKeys = (source: DemoKey[], label: string) => {
    if (source.length === 0) { toast.error("Nothing to download"); return; }
    const text = source.map((k) => k.key).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `pf-keys-${label}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${source.length} keys`);
  };

  const downloadUnclaimed = async () => {
    try {
      const res = await fetch(`${API_URL}/api/demo-access/admin/list?status=UNCLAIMED`, { headers: hdrs() });
      if (!res.ok) { toast.error("Failed to fetch"); return; }
      downloadKeys(await res.json(), "unclaimed");
    } catch { toast.error("Download failed"); }
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(selected.size === keys.length ? new Set() : new Set(keys.map((k) => k.id)));
  };

  const allSelected = keys.length > 0 && selected.size === keys.length;
  const someSelected = selected.size > 0;

  // ── Login ──────────────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#0d0d0e] flex flex-col text-white">
        <div className="px-6 py-5">
          <img src="/logos/logoname_dark.svg" alt="AI Agents" className="h-[22px]" />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-4 pb-16">
          <div className="w-full max-w-[320px]">
            <h1 className="text-[22px] font-bold tracking-tight mb-1">Admin</h1>
            <p className="text-[13px] text-white/35 mb-8">Sign in to manage access keys</p>
            {loginError && <p className="text-[12px] text-red-400 mb-4">{loginError}</p>}
            <form onSubmit={handleLogin} className="flex flex-col gap-2.5">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" disabled={loading}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-[13px] text-white placeholder:text-white/20 outline-none focus:border-white/[0.18] transition-all disabled:opacity-40" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" disabled={loading}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-[13px] text-white placeholder:text-white/20 outline-none focus:border-white/[0.18] transition-all disabled:opacity-40" />
              <button type="submit" disabled={loading}
                className="w-full bg-white text-[#0d0d0e] text-[13px] font-semibold py-3 rounded-xl hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-30 flex items-center justify-center gap-2 mt-1">
                {loading ? <Loader size={13} className="animate-spin" /> : "Sign in"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0d0d0e] text-white">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-6">
          <img src="/logos/logoname_dark.svg" alt="AI Agents" className="h-[22px]" />
          <nav className="flex items-center gap-1">
            <Link href="/admin"
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg bg-white/[0.08] text-white transition-colors">
              <Key size={11} /> Demo Keys
            </Link>
            <Link href="/admin/credits"
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors">
              <CreditCard size={11} /> Credits
            </Link>
          </nav>
        </div>
        <button onClick={handleLogout} className="flex items-center gap-1.5 text-[12px] text-white/40 hover:text-white/80 transition-colors">
          <LogOut size={13} /> Logout
        </button>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4">

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total",      value: stats.totalKeys },
              { label: "Unclaimed",  value: stats.unclaimedKeys },
              { label: "Claimed",    value: stats.claimedKeys },
              { label: "Claim rate", value: `${(stats.claimRate * 100).toFixed(0)}%` },
            ].map((s) => (
              <div key={s.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
                <p className="text-[11px] text-white/35 mb-1">{s.label}</p>
                <p className="text-[22px] font-bold tracking-tight">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Bento: controls + table */}
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-3">

          {/* Left panel */}
          <div className="flex flex-col gap-2.5">

            {/* Generate */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col gap-2.5">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Generate</p>
              <button onClick={generateKey} disabled={loading}
                className="w-full flex items-center justify-center gap-1.5 bg-white text-[#0d0d0e] text-[12px] font-semibold py-2.5 rounded-lg hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-30">
                <Plus size={12} /> Single key
              </button>
              <div className="flex gap-2">
                <input type="number" value={bulkCount} min="1" max="1000"
                  onChange={(e) => setBulkCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-2 text-[12px] text-white outline-none focus:border-white/20 transition-all text-center" />
                <button onClick={generateBulk} disabled={loading}
                  className="shrink-0 flex items-center gap-1 bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] text-white/80 text-[12px] font-medium px-3 py-2 rounded-lg transition-all disabled:opacity-30">
                  <Plus size={11} /> Bulk
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col gap-2">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-0.5">Export</p>
              <button onClick={downloadUnclaimed}
                className="w-full flex items-center gap-2 text-[12px] text-white/50 hover:text-white/90 hover:bg-white/[0.05] px-2 py-2 rounded-lg transition-all">
                <Download size={12} /> Unclaimed keys (.txt)
              </button>
              {someSelected && (
                <button onClick={() => downloadKeys(keys.filter((k) => selected.has(k.id)), "selected")}
                  className="w-full flex items-center gap-2 text-[12px] text-white/50 hover:text-white/90 hover:bg-white/[0.05] px-2 py-2 rounded-lg transition-all">
                  <Download size={12} /> Selected ({selected.size})
                </button>
              )}
            </div>

            {/* Refresh */}
            <button onClick={() => refresh()} disabled={loading}
              className="flex items-center justify-center gap-1.5 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-white/40 hover:text-white/80 text-[12px] py-2.5 rounded-xl transition-all disabled:opacity-30">
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>

          {/* Keys table */}
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden flex flex-col">

            {/* Table header row */}
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-3">
              {/* Filter tabs */}
              <div className="flex items-center gap-1 flex-1">
                {(["ALL", "UNCLAIMED", "CLAIMED", "REVOKED"] as const).map((f) => (
                  <button key={f} onClick={() => { setFilter(f); fetchKeys(undefined, f); }}
                    className={`text-[11px] px-2.5 py-1 rounded-md transition-all font-medium ${filter === f ? "bg-white/[0.08] text-white" : "text-white/30 hover:text-white/60"}`}>
                    {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/20 shrink-0">{keys.length} keys</p>
            </div>

            {/* Bulk action bar */}
            {someSelected && (
              <div className="px-4 py-2 border-b border-white/[0.06] bg-white/[0.02] flex items-center gap-3">
                <span className="text-[11px] text-white/50 flex-1">{selected.size} selected</span>
                <button onClick={copySelected}
                  className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/90 hover:bg-white/[0.06] px-2 py-1 rounded-lg transition-all">
                  <Copy size={11} /> Copy
                </button>
                <button onClick={deleteSelected}
                  className="flex items-center gap-1 text-[11px] text-red-400/70 hover:text-red-400 hover:bg-red-500/[0.08] px-2 py-1 rounded-lg transition-all">
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            )}

            {keys.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-white/20">No keys</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/[0.04]">
                      <th className="px-4 py-2.5 w-8">
                        <button onClick={toggleAll} className="text-white/25 hover:text-white/70 transition-colors flex items-center">
                          {allSelected ? <CheckSquare size={13} className="text-white/60" /> : <Square size={13} />}
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-medium text-white/30">Key</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-medium text-white/30">Status</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-medium text-white/30 hidden sm:table-cell">Created</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-medium text-white/30 hidden md:table-cell">Claimed by</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}
                        className={`border-b border-white/[0.03] transition-colors ${selected.has(k.id) ? "bg-white/[0.04]" : "hover:bg-white/[0.02]"}`}>
                        <td className="px-4 py-2.5">
                          <button onClick={() => toggleRow(k.id)} className="text-white/25 hover:text-white/70 transition-colors flex items-center">
                            {selected.has(k.id)
                              ? <CheckSquare size={13} className="text-white/60" />
                              : <Square size={13} />}
                          </button>
                        </td>
                        <td className="px-3 py-2.5">
                          <code className="text-[11px] font-mono text-white/55">{k.key.slice(0, 24)}…</code>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full ${statusStyles[k.status]}`}>
                            {k.status.charAt(0) + k.status.slice(1).toLowerCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-white/30 hidden sm:table-cell">
                          {new Date(k.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2.5 hidden md:table-cell">
                          {k.claimedBy
                            ? <code className="text-[10px] font-mono text-white/30">{k.claimedBy.slice(0, 16)}…</code>
                            : <span className="text-[11px] text-white/15">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => { navigator.clipboard.writeText(k.key); toast.success("Copied"); }}
                              className="p-1.5 rounded-lg text-white/20 hover:text-white/70 hover:bg-white/[0.06] transition-all">
                              <Copy size={11} />
                            </button>
                            <button onClick={() => deleteKey(k.id)}
                              className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/[0.08] transition-all">
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
