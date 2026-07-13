"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  LogOut, RefreshCw, Loader, Plus, Minus, Users, CreditCard,
  TrendingDown, Zap, Search, Key, ChevronUp, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface UserCredit {
  id: string;
  clerkId: string;
  email: string | null;
  name: string | null;
  image: string | null;
  createdAt: string;
  credits: number;
  reservedCredits: number;
  availableCredits: number;
  usedCredits: number;
  usagePercent: number;
}

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

type SortKey = "name" | "credits" | "used" | "usage" | "available";

export default function AdminCreditsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [users, setUsers] = useState<UserCredit[]>([]);
  const [loading, setLoading] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("usage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Per-row adjust
  const [adjustAmounts, setAdjustAmounts] = useState<Record<string, number>>({});
  const [adjustingRow, setAdjustingRow] = useState<string | null>(null);

  // Bulk allocate
  const [bulkAmount, setBulkAmount] = useState(5000);
  const [bulkLoading, setBulkLoading] = useState(false);

  // Conditional allocate
  const [condThreshold, setCondThreshold] = useState(70);
  const [condCredits, setCondCredits] = useState(5000);
  const [condPreview, setCondPreview] = useState<number | null>(null);
  const [condLoading, setCondLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("admin_token");
    if (token) { setAdminToken(token); setIsAuthenticated(true); fetchUsers(token); }
  }, []);

  const hdrs = useCallback((token?: string) => ({
    "Content-Type": "application/json",
    "x-admin-token": token || adminToken,
  }), [adminToken]);

  const fetchUsers = async (token?: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/credits/admin/users`, { headers: hdrs(token) });
      if (res.ok) {
        const data: UserCredit[] = await res.json();
        setUsers(data);
      } else {
        toast.error("Failed to fetch users");
      }
    } catch { toast.error("Connection error"); }
    finally { setLoading(false); }
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
        fetchUsers(data.token);
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
    setUsers([]);
  };

  const getAdjustAmount = (clerkId: string) => adjustAmounts[clerkId] ?? 1000;

  const adjustCredits = async (clerkId: string, delta: number) => {
    if (delta === 0) return;
    setAdjustingRow(clerkId);
    try {
      const res = await fetch(`${API_URL}/api/credits/admin/users/${clerkId}/adjust`, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ delta }),
      });
      if (res.ok) {
        toast.success(`${delta > 0 ? "+" : ""}${delta.toLocaleString()} credits applied`);
        fetchUsers();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to adjust");
      }
    } catch { toast.error("Error"); }
    finally { setAdjustingRow(null); }
  };

  const allocateAll = async () => {
    if (!bulkAmount || isNaN(bulkAmount)) { toast.error("Enter a valid amount"); return; }
    if (!confirm(`${bulkAmount > 0 ? "Add" : "Remove"} ${Math.abs(bulkAmount).toLocaleString()} credits ${bulkAmount > 0 ? "to" : "from"} all ${users.length} users?`)) return;
    setBulkLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/credits/admin/allocate-all`, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ credits: bulkAmount }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Applied to ${data.affected} users`);
        fetchUsers();
      } else {
        toast.error("Failed to allocate");
      }
    } catch { toast.error("Error"); }
    finally { setBulkLoading(false); }
  };

  const computeCondPreview = () => {
    const count = users.filter((u) => u.usagePercent >= condThreshold).length;
    setCondPreview(count);
    return count;
  };

  const applyConditional = async () => {
    const count = computeCondPreview();
    if (count === 0) { toast.error("No users match this condition"); return; }
    if (!confirm(`Add ${condCredits.toLocaleString()} credits to ${count} user${count !== 1 ? "s" : ""} who used ≥${condThreshold}%?`)) return;
    setCondLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/credits/admin/conditional-allocate`, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ usageThresholdPercent: condThreshold, creditsToAdd: condCredits }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Allocated to ${data.affected} users`);
        setCondPreview(null);
        fetchUsers();
      } else {
        toast.error("Failed to apply");
      }
    } catch { toast.error("Error"); }
    finally { setCondLoading(false); }
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); }
    else { setSortKey(key); setSortDir("desc"); }
  };

  const filteredUsers = users
    .filter((u) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return u.email?.toLowerCase().includes(s) || u.name?.toLowerCase().includes(s);
    })
    .sort((a, b) => {
      let av = 0, bv = 0;
      if (sortKey === "name") { av = (a.name || a.email || "").toLowerCase().charCodeAt(0); bv = (b.name || b.email || "").toLowerCase().charCodeAt(0); }
      else if (sortKey === "credits") { av = a.credits; bv = b.credits; }
      else if (sortKey === "used") { av = a.usedCredits; bv = b.usedCredits; }
      else if (sortKey === "usage") { av = a.usagePercent; bv = b.usagePercent; }
      else if (sortKey === "available") { av = a.availableCredits; bv = b.availableCredits; }
      return sortDir === "asc" ? av - bv : bv - av;
    });

  const totalCredits = users.reduce((s, u) => s + u.credits, 0);
  const totalUsed = users.reduce((s, u) => s + u.usedCredits, 0);
  const avgCredits = users.length ? Math.round(totalCredits / users.length) : 0;

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (
      sortDir === "asc" ? <ChevronUp size={10} className="text-white/60" /> : <ChevronDown size={10} className="text-white/60" />
    ) : (
      <ChevronDown size={10} className="text-white/15" />
    );

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
            <p className="text-[13px] text-white/35 mb-8">Sign in to manage credits</p>
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
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-colors">
              <Key size={11} /> Demo Keys
            </Link>
            <Link href="/admin/credits"
              className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg bg-white/[0.08] text-white transition-colors">
              <CreditCard size={11} /> Credits
            </Link>
          </nav>
        </div>
        <button onClick={handleLogout} className="flex items-center gap-1.5 text-[12px] text-white/40 hover:text-white/80 transition-colors">
          <LogOut size={13} /> Logout
        </button>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4">

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total users",    value: users.length,               icon: <Users size={13} className="text-white/30" /> },
            { label: "Credits in sys", value: totalCredits.toLocaleString(), icon: <CreditCard size={13} className="text-white/30" /> },
            { label: "Avg per user",   value: avgCredits.toLocaleString(),  icon: <Zap size={13} className="text-white/30" /> },
            { label: "Total consumed", value: totalUsed.toLocaleString(),   icon: <TrendingDown size={13} className="text-white/30" /> },
          ].map((s) => (
            <div key={s.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3.5">
              <div className="flex items-center gap-1.5 mb-1">{s.icon}<p className="text-[11px] text-white/35">{s.label}</p></div>
              <p className="text-[22px] font-bold tracking-tight">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Main bento */}
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-3">

          {/* Left panel */}
          <div className="flex flex-col gap-2.5">

            {/* Allocate all */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col gap-3">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Allocate all</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={bulkAmount}
                  onChange={(e) => setBulkAmount(parseInt(e.target.value) || 0)}
                  placeholder="Credits"
                  className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-white outline-none focus:border-white/20 transition-all text-center"
                />
              </div>
              <p className="text-[10px] text-white/25 -mt-1">Use negative to deduct</p>
              <button
                onClick={allocateAll}
                disabled={bulkLoading || !bulkAmount}
                className="w-full flex items-center justify-center gap-1.5 bg-white text-[#0d0d0e] text-[12px] font-semibold py-2.5 rounded-lg hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-30"
              >
                {bulkLoading ? <Loader size={12} className="animate-spin" /> : <><Zap size={12} /> Apply to all</>}
              </button>
            </div>

            {/* Conditional allocate */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex flex-col gap-3">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Conditional</p>
              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-[10px] text-white/25 mb-1 block">If used ≥ % of credits</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min="0" max="100"
                      value={condThreshold}
                      onChange={(e) => { setCondThreshold(Math.min(100, Math.max(0, parseInt(e.target.value) || 0))); setCondPreview(null); }}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-white outline-none focus:border-white/20 transition-all text-center"
                    />
                    <span className="text-[12px] text-white/40 shrink-0">%</span>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-white/25 mb-1 block">Give them credits</label>
                  <input
                    type="number"
                    value={condCredits}
                    onChange={(e) => setCondCredits(parseInt(e.target.value) || 0)}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[12px] text-white outline-none focus:border-white/20 transition-all text-center"
                  />
                </div>
              </div>

              {/* Quick threshold presets */}
              <div className="flex gap-1.5 flex-wrap">
                {[50, 70, 90].map((v) => (
                  <button key={v} onClick={() => { setCondThreshold(v); setCondPreview(null); }}
                    className={`text-[10px] px-2 py-1 rounded-md border transition-all font-medium ${condThreshold === v ? "border-white/20 bg-white/[0.08] text-white" : "border-white/[0.08] text-white/30 hover:text-white/60"}`}>
                    {v}%
                  </button>
                ))}
              </div>

              {condPreview !== null && (
                <p className="text-[11px] text-white/50 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-center">
                  {condPreview === 0 ? "No users match" : <><span className="text-white font-semibold">{condPreview}</span> user{condPreview !== 1 ? "s" : ""} qualify</>}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={computeCondPreview}
                  className="flex-1 text-[12px] py-2 rounded-lg border border-white/[0.08] text-white/50 hover:text-white/80 hover:bg-white/[0.04] transition-all font-medium"
                >
                  Preview
                </button>
                <button
                  onClick={applyConditional}
                  disabled={condLoading || !condCredits}
                  className="flex-1 text-[12px] py-2 rounded-lg bg-white text-[#0d0d0e] font-semibold hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-30 flex items-center justify-center gap-1"
                >
                  {condLoading ? <Loader size={11} className="animate-spin" /> : "Apply"}
                </button>
              </div>
            </div>

            {/* Refresh */}
            <button
              onClick={() => fetchUsers()}
              disabled={loading}
              className="flex items-center justify-center gap-1.5 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-white/40 hover:text-white/80 text-[12px] py-2.5 rounded-xl transition-all disabled:opacity-30"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>

          {/* Users table */}
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden flex flex-col">

            {/* Table toolbar */}
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-3">
              <div className="flex-1 flex items-center gap-2 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
                <Search size={11} className="text-white/25 shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or email…"
                  className="flex-1 bg-transparent text-[12px] text-white placeholder:text-white/20 outline-none"
                />
              </div>
              <p className="text-[11px] text-white/20 shrink-0">{filteredUsers.length} users</p>
            </div>

            {filteredUsers.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-white/20">
                {loading ? <Loader size={16} className="animate-spin mx-auto" /> : "No users"}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/[0.04]">
                      <th className="px-4 py-2.5 text-left text-[11px] font-medium text-white/30 min-w-[180px]">
                        <button onClick={() => handleSort("name")} className="flex items-center gap-1 hover:text-white/60 transition-colors">
                          User <SortIcon k="name" />
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-medium text-white/30">
                        <button onClick={() => handleSort("credits")} className="flex items-center gap-1 ml-auto hover:text-white/60 transition-colors">
                          Balance <SortIcon k="credits" />
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-medium text-white/30 hidden sm:table-cell">
                        <button onClick={() => handleSort("used")} className="flex items-center gap-1 ml-auto hover:text-white/60 transition-colors">
                          Used <SortIcon k="used" />
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-medium text-white/30 min-w-[120px]">
                        <button onClick={() => handleSort("usage")} className="flex items-center gap-1 hover:text-white/60 transition-colors">
                          Usage <SortIcon k="usage" />
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-medium text-white/30 hidden md:table-cell">
                        <button onClick={() => handleSort("available")} className="flex items-center gap-1 ml-auto hover:text-white/60 transition-colors">
                          Available <SortIcon k="available" />
                        </button>
                      </th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-medium text-white/30 min-w-[180px]">Adjust</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const amount = getAdjustAmount(u.clerkId);
                      const isAdjusting = adjustingRow === u.clerkId;
                      const usageColor =
                        u.usagePercent >= 90 ? "bg-red-500" :
                        u.usagePercent >= 70 ? "bg-amber-400" :
                        u.usagePercent >= 40 ? "bg-blue-400" :
                        "bg-emerald-500";

                      return (
                        <tr key={u.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              {u.image ? (
                                <img src={u.image} className="w-6 h-6 rounded-full opacity-70 shrink-0" />
                              ) : (
                                <div className="w-6 h-6 rounded-full bg-white/[0.06] shrink-0 flex items-center justify-center text-[9px] text-white/30 font-semibold">
                                  {(u.name || u.email || "?")[0].toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0">
                                {u.name && <p className="text-[12px] text-white/80 truncate">{u.name}</p>}
                                <p className="text-[11px] text-white/30 truncate">{u.email || u.clerkId.slice(0, 20)}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right">
                            <span className="text-[12px] font-mono text-white/70">{u.credits.toLocaleString()}</span>
                          </td>
                          <td className="px-3 py-3 text-right hidden sm:table-cell">
                            <span className="text-[12px] font-mono text-white/40">{u.usedCredits.toLocaleString()}</span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden min-w-[60px]">
                                <div
                                  className={`h-full rounded-full transition-all ${usageColor}`}
                                  style={{ width: `${Math.min(100, u.usagePercent)}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono text-white/40 w-10 text-right shrink-0">
                                {u.usagePercent.toFixed(1)}%
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right hidden md:table-cell">
                            <span className={`text-[12px] font-mono ${u.availableCredits < 1000 ? "text-red-400/70" : "text-white/50"}`}>
                              {u.availableCredits.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => adjustCredits(u.clerkId, -amount)}
                                disabled={isAdjusting}
                                className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400/70 hover:text-red-400 transition-all disabled:opacity-30"
                              >
                                <Minus size={10} />
                              </button>
                              <input
                                type="number"
                                min="1"
                                value={amount}
                                onChange={(e) => setAdjustAmounts((prev) => ({
                                  ...prev,
                                  [u.clerkId]: Math.max(1, parseInt(e.target.value) || 1),
                                }))}
                                className="w-[68px] bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-[11px] text-white text-center outline-none focus:border-white/20 transition-all font-mono"
                              />
                              <button
                                onClick={() => adjustCredits(u.clerkId, amount)}
                                disabled={isAdjusting}
                                className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 transition-all disabled:opacity-30"
                              >
                                {isAdjusting ? <Loader size={10} className="animate-spin" /> : <Plus size={10} />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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
