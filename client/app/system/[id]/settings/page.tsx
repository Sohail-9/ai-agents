"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-client";
import {
  ArrowLeft,
  Pencil,
  Search,
  Eye,
  EyeOff,
  MoreHorizontal,
  X,
  Trash2,
  Check,
  Loader2,
} from "lucide-react";
import Sidebar from "@/components/Sidebar";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface WorkspaceDetail {
  id: string;
  name: string;
  framework?: string;
  status?: string;
  sandboxId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messagesCount?: number;
  hasDatabase?: boolean;
  creditsUsed?: number;
  subdomain?: string;
}

interface EnvVar {
  key: string;
  frontend: boolean;
  backend: boolean;
  environment: string;
}


export default function SettingsPage() {
  const params = useParams();
  const router = useRouter();
  const { getToken } = useAuth();
  const workspaceId = params.id as string;

  const [workspace, setWorkspace] = React.useState<WorkspaceDetail | null>(null);
  const [isEditingName, setIsEditingName] = React.useState(false);
  const [nameValue, setNameValue] = React.useState("");
  const [isSavingName, setIsSavingName] = React.useState(false);

  const [envVars, setEnvVars] = React.useState<EnvVar[]>([]);
  const [envSearch, setEnvSearch] = React.useState("");
  const [envFilter, setEnvFilter] = React.useState<"All Environments" | "Frontend" | "Backend">("All Environments");

  const [showAddModal, setShowAddModal] = React.useState(false);
  const [newKey, setNewKey] = React.useState("");
  const [newValue, setNewValue] = React.useState("");
  const [newValueVisible, setNewValueVisible] = React.useState(false);
  const [newTarget, setNewTarget] = React.useState<"both" | "frontend" | "backend">("both");
  const [isSavingVar, setIsSavingVar] = React.useState(false);
  const [addError, setAddError] = React.useState("");

  const [menuOpenKey, setMenuOpenKey] = React.useState<string | null>(null);
  const [deleteConfirmKey, setDeleteConfirmKey] = React.useState<string | null>(null);
  const [deletingKey, setDeletingKey] = React.useState<string | null>(null);
  const [revealedValues, setRevealedValues] = React.useState<Record<string, string>>({});
  const [loadingReveal, setLoadingReveal] = React.useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [latestDeployUrl, setLatestDeployUrl] = React.useState<string | null | undefined>(undefined);

  // ── Load workspace + latest deploy URL ─────────────────────────────────────
  React.useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const [detailRes, deployRes] = await Promise.all([
          fetch(`${API_URL}/api/workspaces/detail/${workspaceId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`${API_URL}/api/workspaces/${workspaceId}/deployments`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        if (detailRes.ok) {
          const data = await detailRes.json();
          setWorkspace(data);
          setNameValue(data.name ?? "");
        }
        if (deployRes.ok) {
          const { deployments } = await deployRes.json();
          const latest = (deployments as any[])
            .filter((d) => d.status === "SUCCESS" && (d.type === "FRONTEND" || d.type === "FULLSTACK") && d.previewUrl)
            .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())[0];
          setLatestDeployUrl(latest?.previewUrl ?? null);
        } else {
          setLatestDeployUrl(null);
        }
      } catch {}
    }
    load();
  }, [workspaceId, getToken]);

  // ── Load env vars ───────────────────────────────────────────────────────────
  const loadEnvVars = React.useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/env`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setEnvVars(data.vars ?? []);
      }
    } catch {}
  }, [workspaceId, getToken]);

  React.useEffect(() => { loadEnvVars(); }, [loadEnvVars]);

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpenKey) return;
    const handler = () => setMenuOpenKey(null);
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpenKey]);

  // ── Rename ──────────────────────────────────────────────────────────────────
  const handleSaveName = React.useCallback(async () => {
    if (!nameValue.trim() || nameValue.trim() === workspace?.name) {
      setIsEditingName(false);
      setNameValue(workspace?.name ?? "");
      return;
    }
    setIsSavingName(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: nameValue.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setWorkspace((prev) => prev ? { ...prev, name: data.name } : prev);
        setNameValue(data.name);
      }
    } catch {}
    setIsSavingName(false);
    setIsEditingName(false);
  }, [nameValue, workspace?.name, workspaceId, getToken]);

  // ── Add env var ─────────────────────────────────────────────────────────────
  const handleAddVar = React.useCallback(async () => {
    setAddError("");
    if (!newKey.trim()) { setAddError("Key is required"); return; }
    if (!newValue) { setAddError("Value is required"); return; }
    setIsSavingVar(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/env`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: newKey.trim(), value: newValue, target: newTarget }),
      });
      if (!res.ok) {
        const err = await res.json();
        setAddError(err.error || "Failed to save");
        return;
      }
      await loadEnvVars();
      setShowAddModal(false);
      setNewKey("");
      setNewValue("");
      setNewTarget("both");
      setNewValueVisible(false);
    } catch {
      setAddError("Network error");
    } finally {
      setIsSavingVar(false);
    }
  }, [newKey, newValue, newTarget, workspaceId, getToken, loadEnvVars]);

  // ── Delete env var ──────────────────────────────────────────────────────────
  const handleDeleteVar = React.useCallback(async (key: string) => {
    setDeletingKey(key);
    setMenuOpenKey(null);
    try {
      const token = await getToken();
      await fetch(`${API_URL}/api/workspaces/${workspaceId}/env/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await loadEnvVars();
    } catch {}
    setDeletingKey(null);
  }, [workspaceId, getToken, loadEnvVars]);

  // ── Reveal env var value ────────────────────────────────────────────────────
  const handleToggleReveal = React.useCallback(async (key: string) => {
    if (revealedValues[key] !== undefined) {
      setRevealedValues((prev) => { const next = { ...prev }; delete next[key]; return next; });
      return;
    }
    setLoadingReveal((prev) => new Set(prev).add(key));
    try {
      const token = await getToken();
      const res = await fetch(
        `${API_URL}/api/workspaces/${workspaceId}/env/${encodeURIComponent(key)}/value`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const data = await res.json();
        setRevealedValues((prev) => ({ ...prev, [key]: data.value }));
      }
    } catch {}
    setLoadingReveal((prev) => { const next = new Set(prev); next.delete(key); return next; });
  }, [revealedValues, workspaceId, getToken]);

  // ── Copy revealed value ─────────────────────────────────────────────────────
  const handleCopyValue = React.useCallback((key: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    }).catch(() => {});
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const formatDate = (ws: WorkspaceDetail | null) => {
    if (!ws?.createdAt) return "—";
    try {
      const d = new Date(ws.createdAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch { return ws.createdAt; }
  };

  const filteredEnvVars = React.useMemo(() => {
    let list = envVars;
    if (envFilter !== "All Environments") {
      list = list.filter((v) => v.environment === envFilter);
    }
    if (envSearch.trim()) {
      const q = envSearch.toLowerCase();
      list = list.filter((v) => v.key.toLowerCase().includes(q));
    }
    return list;
  }, [envVars, envSearch, envFilter]);

  const envTargetLabel = (v: EnvVar) => v.environment;

  return (
    <div className="flex h-screen overflow-hidden bg-[#1c1c1c] text-white font-sans">
      <Sidebar defaultCollapsed={true} />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <div className="shrink-0 border-b border-white/[0.07] bg-[#1c1c1c]">
          <div className="px-5 h-[52px] flex items-center gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-white/60" />
            </button>
            <h1 className="text-[15px] font-semibold text-white">Project Settings</h1>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
          <div className="px-8 py-8 flex flex-col gap-8">

            {/* Page title */}
            <div>
              <h2 className="text-[22px] font-semibold text-white">Project Settings</h2>
              <p className="text-[13px] text-white/40 mt-1">Manage your project details and preferences</p>
            </div>

            {/* Overview card */}
            <div className="rounded-xl border border-white/[0.08] p-6">
              <h3 className="text-[13px] font-semibold text-white mb-5">Overview</h3>
              <div className="grid grid-cols-2 gap-x-20 gap-y-5">
                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Project Name</p>
                  {isEditingName ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={nameValue}
                        onChange={(e) => setNameValue(e.target.value)}
                        onBlur={handleSaveName}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveName();
                          if (e.key === "Escape") {
                            setIsEditingName(false);
                            setNameValue(workspace?.name ?? "");
                          }
                        }}
                        className="bg-transparent border-b border-white/30 focus:border-white/60 outline-none text-[13px] text-white py-0.5 flex-1"
                      />
                      {isSavingName && <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40 shrink-0" />}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-white">{workspace?.name ?? "—"}</span>
                      <button
                        onClick={() => setIsEditingName(true)}
                        className="text-white/30 hover:text-white/60 transition-colors"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">URL subdomain</p>
                  {latestDeployUrl === undefined ? (
                    <span className="text-[13px] text-white/30">Loading…</span>
                  ) : latestDeployUrl ? (
                    <a href={latestDeployUrl} target="_blank" rel="noreferrer" className="text-[13px] text-blue-400 hover:text-blue-300 truncate block max-w-xs transition-colors">
                      {latestDeployUrl}
                    </a>
                  ) : (
                    <span className="text-[13px] text-white/30">No latest deployment</span>
                  )}
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Tech Stack</p>
                  <span className="text-[13px] text-white">{workspace?.framework ?? "—"}</span>
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Created at</p>
                  <span className="text-[13px] text-white">{formatDate(workspace)}</span>
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Credits Used</p>
                  <span className="text-[13px] text-white">
                    {workspace?.creditsUsed !== undefined ? workspace.creditsUsed.toLocaleString() : "—"}
                  </span>
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Messages Count</p>
                  <span className="text-[13px] text-white">
                    {workspace?.messagesCount !== undefined ? workspace.messagesCount : "—"}
                  </span>
                </div>

                <div>
                  <p className="text-[12px] text-white/40 mb-1.5">Database Used</p>
                  <span className="text-[13px] text-white">
                    {workspace?.hasDatabase !== undefined ? (workspace.hasDatabase ? "Yes" : "No") : "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* Environment Variables */}
            <div>
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="text-[22px] font-semibold text-white">Enviornment Variables</h3>
                  <p className="text-[13px] text-white/40 mt-1">Store API keys, tokens, and config securely.</p>
                </div>
                <div className="flex items-center gap-2 mt-1 shrink-0">
                  <button
                    onClick={() => { setShowAddModal(true); setAddError(""); }}
                    className="px-4 py-2 rounded-lg bg-white text-[#1c1c1c] text-[13px] font-medium hover:bg-white/90 transition-colors whitespace-nowrap"
                  >
                    Add Enviornment Variable
                  </button>
                </div>
              </div>

              {/* Filters row */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search Variables"
                    value={envSearch}
                    onChange={(e) => setEnvSearch(e.target.value)}
                    className="w-full h-9 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-4 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:border-white/20 transition-colors"
                  />
                </div>
                {(["All Environments", "Frontend", "Backend"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setEnvFilter(opt)}
                    className={`flex items-center gap-1.5 h-9 px-3 border rounded-lg text-[13px] transition-colors whitespace-nowrap ${
                      envFilter === opt
                        ? "border-white/30 bg-white/10 text-white"
                        : "border-white/[0.08] bg-white/[0.04] text-white/60 hover:bg-white/[0.07]"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>

              {/* Env var list */}
              <div className="rounded-xl border border-white/[0.08]">
                {filteredEnvVars.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-[13px] text-white/30">
                    {envVars.length === 0 ? "No environment variables yet" : "No variables match your filter"}
                  </div>
                ) : (
                  filteredEnvVars.map((v) => (
                    <div
                      key={v.key}
                      className="flex items-center gap-4 px-5 py-3.5 border-b border-white/[0.06] last:border-0 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-white truncate block">{v.key}</span>
                        <span className="text-[11px] text-white/30">{envTargetLabel(v)}</span>
                      </div>
                      <div className="flex items-center gap-2 min-w-0">
                        {revealedValues[v.key] !== undefined ? (
                          <button
                            onClick={() => handleCopyValue(v.key, revealedValues[v.key])}
                            title="Click to copy"
                            className="group relative flex items-center gap-1.5 max-w-[220px] px-2 py-0.5 rounded-md hover:bg-white/5 transition-colors cursor-pointer"
                          >
                            <span className="text-[12px] text-white/60 font-mono truncate block max-w-[180px]">
                              {revealedValues[v.key]}
                            </span>
                            {copiedKey === v.key ? (
                              <span className="text-[10px] text-emerald-400 font-medium shrink-0 whitespace-nowrap">Copied!</span>
                            ) : (
                              <Check className="w-3 h-3 text-white/20 group-hover:text-white/50 transition-colors shrink-0 opacity-0 group-hover:opacity-100" />
                            )}
                          </button>
                        ) : (
                          <span className="flex items-center gap-[5px] shrink-0">
                            {Array.from({ length: 8 }).map((_, i) => (
                              <span key={i} className="w-[5px] h-[5px] rounded-full bg-white/25 shrink-0 inline-block" />
                            ))}
                          </span>
                        )}
                        <button
                          onClick={() => handleToggleReveal(v.key)}
                          className="p-1 rounded hover:bg-white/5 transition-colors text-white/30 hover:text-white/60"
                          title={revealedValues[v.key] !== undefined ? "Hide value" : "Reveal value"}
                        >
                          {loadingReveal.has(v.key)
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : revealedValues[v.key] !== undefined
                            ? <EyeOff className="w-3.5 h-3.5" />
                            : <Eye className="w-3.5 h-3.5" />
                          }
                        </button>
                      </div>
                      <div className="relative shrink-0">
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenKey(menuOpenKey === v.key ? null : v.key);
                          }}
                          className="p-1.5 rounded-md hover:bg-white/5 transition-colors text-white/30 hover:text-white/60"
                        >
                          {deletingKey === v.key
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <MoreHorizontal className="w-4 h-4" />
                          }
                        </button>
                        {menuOpenKey === v.key && (
                          <div
                            className="absolute right-0 top-full mt-1 w-36 rounded-xl bg-[#2A2A2D] border border-white/[0.08] shadow-2xl z-50 py-1"
                            onMouseDown={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
                          >
                            <button
                              onClick={() => { setMenuOpenKey(null); setDeleteConfirmKey(v.key); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-red-400 hover:bg-white/5 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Add Variable Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setShowAddModal(false)}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-[420px] rounded-2xl border border-white/[0.08] bg-[#1C1C1D] shadow-2xl p-5 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Add Environment Variable</span>
              <button onClick={() => setShowAddModal(false)} className="text-white/30 hover:text-white/70 transition-colors">
                <X size={15} />
              </button>
            </div>

            {/* Key */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-semibold">Key</label>
              <input
                autoFocus
                type="text"
                placeholder="e.g. NEXT_PUBLIC_API_URL"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="w-full h-9 bg-white/[0.05] border border-white/[0.10] rounded-lg px-3 text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/25 transition-colors font-mono"
              />
            </div>

            {/* Value */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-semibold">Value</label>
              <div className="relative">
                <input
                  type={newValueVisible ? "text" : "password"}
                  placeholder="••••••••••••"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  className="w-full h-9 bg-white/[0.05] border border-white/[0.10] rounded-lg pl-3 pr-10 text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/25 transition-colors font-mono"
                />
                <button
                  type="button"
                  onClick={() => setNewValueVisible((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
                >
                  {newValueVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Target */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-semibold">Environment</label>
              <div className="flex gap-2">
                {([
                  { value: "both", label: "Both" },
                  { value: "frontend", label: "Frontend" },
                  { value: "backend", label: "Backend" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setNewTarget(opt.value)}
                    className={`flex-1 flex items-center justify-center gap-1.5 h-9 rounded-lg border text-[12px] font-medium transition-all ${
                      newTarget === opt.value
                        ? "border-white/40 bg-white/10 text-white"
                        : "border-white/[0.08] text-white/50 hover:bg-white/5"
                    }`}
                  >
                    {newTarget === opt.value && <Check size={11} />}
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {addError && (
              <p className="text-[12px] text-red-400">{addError}</p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 h-9 rounded-lg border border-white/[0.10] text-[13px] text-white/60 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddVar}
                disabled={isSavingVar}
                className="flex-1 h-9 rounded-lg bg-white text-[#1c1c1c] text-[13px] font-semibold hover:bg-white/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSavingVar && <Loader2 size={13} className="animate-spin" />}
                {isSavingVar ? "Saving…" : "Save Variable"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setDeleteConfirmKey(null)}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-[360px] rounded-2xl border border-white/[0.08] bg-[#1C1C1D] shadow-2xl p-5 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Delete Variable</span>
              <button onClick={() => setDeleteConfirmKey(null)} className="text-white/30 hover:text-white/70 transition-colors">
                <X size={15} />
              </button>
            </div>
            <p className="text-[13px] text-white/50 leading-relaxed">
              Delete <span className="text-white font-mono font-semibold">{deleteConfirmKey}</span>? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirmKey(null)}
                className="flex-1 h-9 rounded-lg border border-white/[0.10] text-[13px] text-white/60 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const key = deleteConfirmKey;
                  setDeleteConfirmKey(null);
                  await handleDeleteVar(key);
                }}
                disabled={deletingKey === deleteConfirmKey}
                className="flex-1 h-9 rounded-lg bg-red-500/90 hover:bg-red-500 text-white text-[13px] font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deletingKey === deleteConfirmKey && <Loader2 size={13} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
