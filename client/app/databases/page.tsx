"use client";

import React from "react";
import { useUser, useAuth } from "@/lib/auth-client";
import { motion } from "framer-motion";
import {
  Database, RefreshCw, AlertCircle, Table2,
  Eye, EyeOff, ExternalLink, Loader2, Copy, Check,
} from "lucide-react";
import Link from "next/link";
import PageShell from "@/components/PageShell";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  maskedUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface DbMeta {
  hasDatabase: boolean;
  maskedUrl: string | null;
  tables: Array<{ name: string }>;
}

interface DbStats {
  sizeBytes: number;
  sizeGB: number;
  maxSizeGB: number;
  activeConnections: number;
  maxConnections: number;
  cacheHitRatio: number;
  tableCount: number;
  totalRows: number;
}

interface DbEntry {
  meta: DbMeta | null;
  stats: DbStats | null;
  loading: boolean;
  error: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatGB(gb: number) {
  if (gb < 0.001) return `${Math.round(gb * 1024 * 1024)} KB`;
  if (gb < 0.1) return `${(gb * 1024).toFixed(1)} MB`;
  return `${gb.toFixed(2)} GB`;
}

// ── Copy Button ───────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="p-1 rounded hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors shrink-0"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-emerald-400" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DatabasesPage() {
  const { user } = useUser();
  const { getToken } = useAuth();

  const [workspaces, setWorkspaces] = React.useState<WorkspaceRow[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<Record<string, DbEntry>>({});
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [showUrl, setShowUrl] = React.useState<Record<string, boolean>>({});
  const [tablesLoading, setTablesLoading] = React.useState<Record<string, boolean>>({});

  const fetchWorkspaces = React.useCallback(async () => {
    if (!user?.id) return;
    setIsLoading(true);
    setFetchError(null);
    setWorkspaces([]);
    setEntries({});
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };
      const res = await fetch(`${API_URL}/api/workspaces/databases`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch databases");

      const dbs: WorkspaceRow[] = data.databases ?? [];
      const initialEntries: Record<string, DbEntry> = {};
      for (const db of dbs) {
        initialEntries[db.id] = {
          meta: { hasDatabase: true, maskedUrl: db.maskedUrl, tables: [] },
          stats: null,
          loading: true,
          error: null,
        };
      }

      setWorkspaces(dbs);
      setEntries(initialEntries);

      dbs.forEach(async (db) => {
        try {
          const statsRes = await fetch(`${API_URL}/api/workspaces/${db.workspaceId}/database/stats`, { headers });
          const statsData = await statsRes.json();
          const stats: DbStats | null = statsRes.ok && statsData.success ? statsData : null;
          setEntries(prev => ({ ...prev, [db.id]: { ...prev[db.id], stats, loading: false } }));
        } catch {
          setEntries(prev => ({ ...prev, [db.id]: { ...prev[db.id], loading: false } }));
        }
      });
    } catch (e: unknown) {
      setFetchError((e as Error)?.message || "Failed to load databases");
    } finally {
      setIsLoading(false);
    }
  }, [user, getToken]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { void fetchWorkspaces(); }, [fetchWorkspaces]);

  // ── Aggregate totals ─────────────────────────────────────────────────────

  const loadedEntries = Object.values(entries).filter(e => !e.loading && e.stats);
  const allLoading = workspaces.length > 0 && loadedEntries.length === 0;

  const totals = React.useMemo(() => {
    const stats = loadedEntries.map(e => e.stats!);
    if (!stats.length) return null;
    return {
      sizeGB: stats.reduce((s, e) => s + e.sizeGB, 0),
      activeConnections: stats.reduce((s, e) => s + e.activeConnections, 0),
      maxConnections: stats.reduce((s, e) => s + e.maxConnections, 0),
      cacheHitRatio: Math.round((stats.reduce((s, e) => s + e.cacheHitRatio, 0) / stats.length) * 10) / 10,
      tableCount: stats.reduce((s, e) => s + e.tableCount, 0),
      totalRows: stats.reduce((s, e) => s + e.totalRows, 0),
    };
  }, [loadedEntries]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageShell>
      <main className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="shrink-0 h-[52px] px-6 flex items-center justify-between border-b border-white/[0.07]">
          <div className="flex items-center gap-3">
            <Database className="w-4 h-4 text-white/40" />
            <h1 className="text-[15px] font-semibold text-white">Databases</h1>
            {!isLoading && workspaces.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[11px] bg-white/[0.06] border border-white/[0.08] text-white/40">
                {workspaces.length}
              </span>
            )}
          </div>
          <button
            onClick={fetchWorkspaces}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] text-white/50 hover:text-white text-[12px] transition-all disabled:opacity-40"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">

          {isLoading && (
            <div className="flex items-center justify-center h-52">
              <Loader2 className="w-5 h-5 animate-spin text-white/30" />
            </div>
          )}

          {!isLoading && fetchError && (
            <div className="flex items-center gap-3 m-6 p-4 rounded-xl border border-red-500/25 bg-red-500/[0.08]">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <p className="text-[13px] text-red-300">{fetchError}</p>
            </div>
          )}

          {!isLoading && !fetchError && workspaces.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center gap-5 py-24 text-center"
            >
              <div className="w-14 h-14 rounded-2xl bg-blue-500/[0.08] border border-blue-500/[0.15] flex items-center justify-center">
                <Database className="w-6 h-6 text-blue-400/60" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-white/70">No databases yet</p>
                <p className="text-[12px] text-white/30 mt-1 max-w-[280px] leading-relaxed">
                  Databases are provisioned automatically when your project requests one.
                </p>
              </div>
              <Link
                href="/"
                className="px-4 py-2 rounded-xl bg-white/5 border border-white/[0.08] hover:bg-white/10 text-[13px] text-white/60 hover:text-white transition-all"
              >
                Start a project
              </Link>
            </motion.div>
          )}

          {!isLoading && !fetchError && workspaces.length > 0 && (
            <div className="px-6 py-6 space-y-6">

              {/* ── Aggregate summary (Neon-style) ── */}
              <div className="rounded-xl border border-white/[0.08] bg-[#161616] px-6 py-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                  {[
                    {
                      label: "Storage",
                      value: totals ? formatGB(totals.sizeGB) : "—",
                    },
                    {
                      label: "Connections",
                      value: totals ? `${totals.activeConnections} / ${totals.maxConnections}` : "—",
                    },
                    {
                      label: "Avg Cache Hit",
                      value: totals ? `${totals.cacheHitRatio} %` : "—",
                    },
                    {
                      label: "Tables",
                      value: totals ? String(totals.tableCount) : "—",
                    },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex flex-col gap-1">
                      <p className="text-[12px] text-white/40">{label}</p>
                      {allLoading ? (
                        <div className="h-7 w-24 rounded bg-white/[0.06] animate-pulse" />
                      ) : (
                        <p className="text-[24px] font-semibold text-white leading-none tracking-tight">
                          {value}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-[11px] text-white/20">
                  Usage across {workspaces.length} database{workspaces.length !== 1 ? "s" : ""} · stats from pg_stat_database · may be slightly delayed
                </p>
              </div>

              {/* ── Per-database table ── */}
              <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[2fr_1fr_1.5fr_1fr_0.6fr_0.8fr] gap-4 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                  {["Database", "Storage", "Connections", "Cache Hit", "Tables", "Status"].map(h => (
                    <span key={h} className="text-[10px] font-semibold uppercase tracking-wider text-white/25">{h}</span>
                  ))}
                </div>

                {/* Rows */}
                {workspaces.map((ws, i) => {
                  const entry = entries[ws.id];
                  const stats = entry?.stats ?? null;
                  const loading = entry?.loading ?? true;
                  const meta = entry?.meta ?? null;
                  const isExpanded = expandedId === ws.id;

                  return (
                    <motion.div
                      key={ws.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.04 }}
                    >
                      {/* Main row */}
                      <button
                        type="button"
                        onClick={async () => {
                          if (isExpanded) { setExpandedId(null); return; }
                          setExpandedId(ws.id);
                          // lazy-load tables if not yet fetched
                          if ((entries[ws.id]?.meta?.tables ?? []).length === 0) {
                            setTablesLoading(prev => ({ ...prev, [ws.id]: true }));
                            try {
                              const token = await getToken();
                              const r = await fetch(`${API_URL}/api/workspaces/${ws.workspaceId}/database/meta`, { headers: { Authorization: `Bearer ${token}` } });
                              const d = await r.json();
                              if (r.ok && d.success) {
                                setEntries(prev => ({ ...prev, [ws.id]: { ...prev[ws.id], meta: d } }));
                              }
                            } catch { /* ignore */ } finally {
                              setTablesLoading(prev => ({ ...prev, [ws.id]: false }));
                            }
                          }
                        }}
                        className="w-full grid grid-cols-[2fr_1fr_1.5fr_1fr_0.6fr_0.8fr] gap-4 px-4 py-3.5 border-b border-white/[0.05] hover:bg-white/[0.02] transition-colors text-left"
                      >
                        {/* Name */}
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-6 h-6 rounded-md bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                            <Database className="w-3 h-3 text-blue-400" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[13px] font-medium text-white truncate">{ws.workspaceName}</p>
                            <p className="text-[10px] text-white/25 truncate">Neon PostgreSQL</p>
                          </div>
                        </div>

                        {/* Storage */}
                        <span className="text-[13px] text-white/70 self-center tabular-nums">
                          {loading ? <span className="inline-block w-12 h-3 rounded bg-white/[0.06] animate-pulse" /> : stats ? formatGB(stats.sizeGB) : "—"}
                        </span>

                        {/* Connections */}
                        <span className="text-[13px] text-white/70 self-center tabular-nums">
                          {loading ? <span className="inline-block w-14 h-3 rounded bg-white/[0.06] animate-pulse" /> : stats ? `${stats.activeConnections} / ${stats.maxConnections}` : "—"}
                        </span>

                        {/* Cache Hit */}
                        <span className="text-[13px] text-white/70 self-center tabular-nums">
                          {loading ? <span className="inline-block w-10 h-3 rounded bg-white/[0.06] animate-pulse" /> : stats ? `${stats.cacheHitRatio}%` : "—"}
                        </span>

                        {/* Tables */}
                        <span className="text-[13px] text-white/70 self-center tabular-nums">
                          {loading ? <span className="inline-block w-6 h-3 rounded bg-white/[0.06] animate-pulse" /> : stats ? stats.tableCount : "—"}
                        </span>

                        {/* Status */}
                        <span className="self-center">
                          <span className={cn(
                            "inline-flex items-center gap-1.5 text-[11px] font-medium",
                            loading ? "text-white/30" : "text-emerald-400"
                          )}>
                            <span className={cn("w-1.5 h-1.5 rounded-full", loading ? "bg-white/20 animate-pulse" : "bg-emerald-500")} />
                            {loading ? "…" : "live"}
                          </span>
                        </span>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="px-4 py-4 border-b border-white/[0.05] bg-white/[0.015] space-y-3">
                          {/* Connection URL */}
                          {meta?.maskedUrl && (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-white/25 mb-1.5">Connection URL</p>
                              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                                <code className="flex-1 text-[11px] font-mono text-white/40 truncate">
                                  {showUrl[ws.id]
                                    ? meta.maskedUrl
                                    : meta.maskedUrl!.replace(/(?<=:\/\/)[^@]+(?=@)/, "****:****")}
                                </code>
                                <CopyButton value={meta.maskedUrl!} />
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowUrl(prev => ({ ...prev, [ws.id]: !showUrl[ws.id] })); }}
                                  className="p-1 rounded hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors"
                                >
                                  {showUrl[ws.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Tables */}
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-white/25 mb-1.5">
                              Tables{stats?.totalRows ? ` · ${stats.totalRows.toLocaleString()} rows` : ""}
                            </p>
                            {tablesLoading[ws.id] ? (
                              <div className="flex gap-1.5">
                                {[1,2,3].map(n => <span key={n} className="h-6 w-16 rounded-md bg-white/[0.04] animate-pulse" />)}
                              </div>
                            ) : (meta?.tables ?? []).length > 0 ? (
                              <div className="flex flex-wrap gap-1.5">
                                {meta!.tables.map(t => (
                                  <span
                                    key={t.name}
                                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-[11px] text-white/45"
                                  >
                                    <Table2 className="w-3 h-3 text-white/25" />
                                    {t.name}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[11px] text-white/25">No tables found</p>
                            )}
                          </div>

                          {/* Open link */}
                          <Link
                            href={`/system/${ws.workspaceId}`}
                            onClick={e => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] text-[11px] text-white/50 hover:text-white transition-all"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Open workspace
                          </Link>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </main>
    </PageShell>
  );
}
