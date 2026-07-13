"use client";

import React from "react";
import { useUser, useAuth } from "@/lib/auth-client";
import {
  Server, AlertCircle, Loader2, Search, RefreshCw,
  ArrowLeft, ExternalLink, Clock, Download,
  List, BarChart2, FileText, Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Sidebar from "@/components/Sidebar";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const DEPLOY_SERVICE_URL = process.env.NEXT_PUBLIC_DEPLOY_URL || "";

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  name: string;
  status: string;
  sandboxId: string | null;
  databaseUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeploymentRecord {
  id: string;
  workspaceId: string;
  type: "FRONTEND" | "BACKEND";
  status: "QUEUED" | "BUILDING" | "DEPLOYING" | "SUCCESS" | "FAILED";
  previewUrl: string | null;
  cloudfrontUrl: string | null;
  createdAt: string;
  updatedAt: string;
  config?: { error?: string; screenshotUrl?: string } | null;
  jobId?: string | null;
}

interface ServerEntry {
  workspaceId: string;
  workspaceName: string;
  deployment: DeploymentRecord;
}

interface AnalyticsData {
  visitors: number;
  page_views: number;
  api_requests: number;
  bounce_rate: number;
  timeseries: { day: string; page_views: number; api_requests: number; visitors: number }[];
  failing_requests: { path: string; status: number; type: string; hits: number }[];
}

interface LogItem {
  timestamp: string;
  project_id: string;
  type: "frontend" | "backend";
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  country: string;
  message?: string;
}

interface DeploymentLogRow {
  key: string;
  timestamp: string;
  text: string;
  isError: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function serverStatus(dep: DeploymentRecord): "running" | "building" | "closed" {
  if (dep.status === "SUCCESS") return "running";
  if (dep.status === "FAILED") return "closed";
  return "building";
}

function statusDot(s: ReturnType<typeof serverStatus>) {
  if (s === "running") return "bg-emerald-500";
  if (s === "building") return "bg-amber-400 animate-pulse";
  return "bg-red-500/60";
}

function statusLabel(s: ReturnType<typeof serverStatus>) {
  if (s === "running") return <span className="text-emerald-400">running</span>;
  if (s === "building") return <span className="text-amber-400">building</span>;
  return <span className="text-red-400/70">closed</span>;
}

function liveUrl(dep: DeploymentRecord) {
  return dep.previewUrl || (dep.cloudfrontUrl ? `https://${dep.cloudfrontUrl}` : null);
}


function formatDuration(createdAt: string, updatedAt: string) {
  const ms = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (!isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function timeAgo(s: string) {
  const ms = Date.now() - new Date(s).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

let _logKey = 0;
function nextLogKey() { return String(++_logKey); }

// ── Summary Bar ───────────────────────────────────────────────────────────────

function SummaryBar({ entries }: { entries: ServerEntry[] }) {
  const total = entries.length;
  const frontends = entries.filter(e => e.deployment.type === "FRONTEND").length;
  const backends = entries.filter(e => e.deployment.type === "BACKEND").length;
  const building = entries.filter(e => serverStatus(e.deployment) === "building").length;

  return (
    <div className="flex items-center gap-4 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.015] shrink-0">
      {[
        { label: "All", value: total, color: "text-white/70" },
        { label: "Frontend", value: frontends, color: "text-blue-400" },
        { label: "Backend", value: backends, color: "text-violet-400" },
        { label: "Building", value: building, color: "text-amber-400" },
      ].map(({ label, value, color }) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className="text-[11px] text-white/35">{label}:</span>
          <span className={cn("text-[12px] font-semibold tabular-nums", color)}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Server Row ────────────────────────────────────────────────────────────────

function ServerRow({
  entry, selected, onClick,
}: {
  entry: ServerEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const dep = entry.deployment;
  const st = serverStatus(dep);
  const url = liveUrl(dep);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 border-b border-white/[0.05] transition-colors",
        selected
          ? "bg-white/[0.06] border-l-2 border-l-[#FF15DC]"
          : "hover:bg-white/[0.03] border-l-2 border-l-transparent"
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className={cn("w-2 h-2 rounded-full shrink-0 mt-1.5", statusDot(st))} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[12px] font-semibold text-white/85 truncate">
              {entry.workspaceName}
            </span>
            <span className={cn(
              "text-[9px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0",
              dep.type === "FRONTEND"
                ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                : "bg-violet-500/10 border-violet-500/20 text-violet-400"
            )}>
              {dep.type}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            {statusLabel(st)}
            {url && (
              <>
                <span className="text-white/20">·</span>
                <span className="text-white/35 truncate">{url.replace(/^https?:\/\//, "")}</span>
              </>
            )}
          </div>
        </div>
        <span className="text-[10px] text-white/25 shrink-0 mt-0.5">{timeAgo(dep.createdAt)}</span>
      </div>
    </button>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ workspaceId }: { workspaceId: string }) {
  const { getToken } = useAuth();
  const [period, setPeriod] = React.useState<"24h" | "7d" | "30d">("7d");
  const [data, setData] = React.useState<AnalyticsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const token = await getToken();
        const r = await fetch(`${API_URL}/api/workspaces/${workspaceId}/analytics?period=${period}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await r.text();
        let d: Record<string, unknown>;
        try { d = JSON.parse(text) as Record<string, unknown>; } catch { d = { error: `Server error (${r.status})` }; }
        if (!cancelled) {
          if (!r.ok || d.error) setError((d.error as string) || `No analytics data (${r.status})`);
          else setData(d as unknown as AnalyticsData);
        }
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error)?.message || "Failed to fetch");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [workspaceId, period, getToken]);

  const trend = (ts: AnalyticsData["timeseries"], key: "visitors" | "page_views" | "api_requests") => {
    if (!ts || ts.length < 2) return null;
    const half = Math.floor(ts.length / 2);
    const prev = ts.slice(0, half).reduce((s, d) => s + d[key], 0);
    const curr = ts.slice(half).reduce((s, d) => s + d[key], 0);
    if (prev === 0) return curr > 0 ? 100 : null;
    return Math.round(((curr - prev) / prev) * 100);
  };

  return (
    <div className="p-4 space-y-4">
      {/* Period picker */}
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-white/40">Traffic overview</p>
        <div className="flex items-center gap-0.5 p-1 rounded-lg bg-white/[0.05] border border-white/[0.08]">
          {(["24h", "7d", "30d"] as const).map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                "px-3 py-1 rounded-md text-[11px] font-semibold transition-colors",
                period === p ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-5 h-5 animate-spin text-white/30" />
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <BarChart2 className="w-8 h-8 text-white/10" />
          <p className="text-[13px] text-white/40">Traffic analytics not available</p>
          <p className="text-[11px] text-white/20">Analytics will appear once traffic is recorded for this deployment.</p>
        </div>
      )}

      {!loading && data && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-2">
            {([
              { label: "Visitors", value: data.visitors, key: "visitors" as const },
              { label: "Page Views", value: data.page_views, key: "page_views" as const },
              { label: "API Requests", value: data.api_requests, key: "api_requests" as const },
              { label: "Bandwidth", value: null, key: null },
            ]).map(({ label, value, key }) => {
              const t = key ? trend(data.timeseries, key) : null;
              return (
                <div key={label} className="rounded-xl border border-white/[0.08] bg-[#111] p-3">
                  <p className="text-[10px] text-white/40 uppercase tracking-wide mb-1">{label}</p>
                  <div className="flex items-end gap-1.5">
                    <p className="text-[22px] font-bold text-white leading-none">
                      {value !== null ? value.toLocaleString() : "—"}
                    </p>
                    {t !== null && (
                      <span className={cn(
                        "mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-white",
                        t >= 0 ? "bg-emerald-500" : "bg-red-500"
                      )}>
                        {t >= 0 ? "+" : ""}{t}%
                      </span>
                    )}
                    {value === null && (
                      <span className="mb-0.5 text-[10px] text-white/25">coming soon</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Failing requests */}
          {data.failing_requests.length > 0 && (
            <div className="rounded-xl border border-white/[0.08] bg-[#111] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.07] flex items-center justify-between">
                <span className="text-[12px] font-medium text-white">Failing Requests</span>
                <span className="text-[10px] text-white/30 uppercase tracking-wider">Hits</span>
              </div>
              {data.failing_requests.map((req, i) => (
                <div key={i} className="px-4 py-2.5 flex items-center gap-3 border-b border-white/[0.05] last:border-0">
                  <span className={cn("w-3 h-3 rounded-sm shrink-0", req.status >= 500 ? "bg-red-500/80" : "bg-amber-500/80")} />
                  <span className="text-[12px] font-mono text-white/60 flex-1 truncate">{req.path || "/"}</span>
                  <span className="text-[11px] text-white/30 shrink-0 capitalize">{req.type}</span>
                  <span className="text-[12px] text-white/50 tabular-nums shrink-0">{req.hits}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Logs Tab ──────────────────────────────────────────────────────────────────

function LogsTab({ workspaceId }: { workspaceId: string }) {
  const { getToken } = useAuth();
  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const latestTs = logs[0]?.timestamp;

  const fetchLogs = React.useCallback((before?: string) => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50" });
    if (before) params.set("before", before);
    getToken()
      .then(token => fetch(`${API_URL}/api/workspaces/${workspaceId}/request-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      }))
      .then(r => r.json())
      .then((d: { error?: string; items?: LogItem[]; next_cursor?: string }) => {
        if (d.error) { setError(d.error); return; }
        setLogs(prev => before ? [...prev, ...(d.items ?? [])] : (d.items ?? []));
        setCursor(d.next_cursor ?? null);
      })
      .catch((e: unknown) => setError((e as Error)?.message || "Failed to fetch"))
      .finally(() => setLoading(false));
  }, [workspaceId, getToken]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // Poll for new entries every 5s
  React.useEffect(() => {
    if (!latestTs) return;
    const id = setInterval(() => {
      getToken()
        .then(token => fetch(
          `${API_URL}/api/workspaces/${workspaceId}/request-logs?limit=50&after=${encodeURIComponent(latestTs)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        ))
        .then(r => r.json())
        .then(d => { if (d.items?.length) setLogs(prev => [...d.items.reverse(), ...prev]); })
        .catch(() => {});
    }, 5_000);
    return () => clearInterval(id);
  }, [workspaceId, latestTs, getToken]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(l =>
      l.path?.toLowerCase().includes(q) ||
      l.method?.toLowerCase().includes(q) ||
      String(l.status).includes(q) ||
      l.message?.toLowerCase().includes(q)
    );
  }, [logs, search]);

  const downloadCSV = () => {
    const headers = ["Time", "Method", "Status", "Type", "Path", "Latency(ms)", "Country"];
    const rows = filtered.map(l =>
      [l.timestamp, l.method, l.status, l.type, l.path || "/", l.latency_ms, l.country || ""].join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `logs-${workspaceId}.csv`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
          <input
            type="text"
            placeholder="Search logs"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-8 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-8 pr-3 text-[12px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-colors"
          />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-white/50 shrink-0">
          <span className="relative flex w-1.5 h-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-emerald-500" />
          </span>
          Live
        </div>
        <button
          onClick={() => fetchLogs()}
          className="p-1.5 rounded-md hover:bg-white/5 text-white/40 transition-colors shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={downloadCSV}
          disabled={filtered.length === 0}
          className="p-1.5 rounded-md hover:bg-white/5 text-white/40 transition-colors shrink-0 disabled:opacity-30"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[130px_80px_1fr_80px] px-4 py-2 border-b border-white/[0.05] text-[10px] font-semibold uppercase tracking-wider text-white/30 shrink-0">
        <span>Time</span>
        <span>Status</span>
        <span>Path</span>
        <span className="text-right">Latency</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
        {loading && logs.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-4 h-4 animate-spin text-white/30" />
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <List className="w-5 h-5 text-white/15" />
            <p className="text-[12px] text-white/30">Request logs not available</p>
            <p className="text-[11px] text-white/20">Logs will appear once requests are recorded for this deployment.</p>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <List className="w-5 h-5 text-white/15" />
            <p className="text-[12px] text-white/30">{search ? "No results" : "No requests yet"}</p>
          </div>
        )}
        {filtered.map((log, i) => {
          const is5xx = log.status >= 500;
          const is4xx = log.status >= 400;
          const d = new Date(log.timestamp);
          const timeStr = `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}.${String(d.getSeconds()).padStart(2, "0")}`;
          return (
            <div
              key={i}
              className="grid grid-cols-[130px_80px_1fr_80px] px-4 py-2.5 border-b border-white/[0.04] text-[11px] hover:bg-white/[0.02] transition-colors"
            >
              <span className="font-mono text-white/35 truncate">{timeStr}</span>
              <span className="font-mono">
                <span className="text-white/40">{log.method} </span>
                <span className={cn("font-semibold", is5xx ? "text-red-400" : is4xx ? "text-amber-400" : "text-emerald-400")}>
                  {log.status}
                </span>
              </span>
              <span className="text-white/50 truncate">{log.path || "/"}</span>
              <span className={cn(
                "text-right font-mono",
                log.latency_ms > 1000 ? "text-red-400" : log.latency_ms > 500 ? "text-amber-400" : "text-white/35"
              )}>
                {log.latency_ms}ms
              </span>
            </div>
          );
        })}
        {cursor && (
          <div className="flex justify-center py-3 border-t border-white/5">
            <button
              type="button"
              onClick={() => fetchLogs(cursor)}
              className="text-[11px] text-white/40 hover:text-white/70 transition-colors"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Deployment Logs Tab ───────────────────────────────────────────────────────

function DeploymentLogsTab({ workspaceId }: { workspaceId: string }) {
  const { getToken } = useAuth();
  const [deployments, setDeployments] = React.useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedDep, setSelectedDep] = React.useState<DeploymentRecord | null>(null);
  const [logRows, setLogRows] = React.useState<DeploymentLogRow[]>([]);
  const [logsLoading, setLogsLoading] = React.useState(false);
  const [logsError, setLogsError] = React.useState<string | null>(null);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [logSearch, setLogSearch] = React.useState("");
  const liveRef = React.useRef<EventSource | null>(null);
  const logsEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    getToken()
      .then(token => fetch(`${API_URL}/api/workspaces/${workspaceId}/deployments`, {
        headers: { Authorization: `Bearer ${token}` },
      }))
      .then(r => r.json())
      .then(d => { if (!d.success) throw new Error(d.error); setDeployments(d.deployments ?? []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [workspaceId, getToken]);

  // Auto-scroll logs to bottom
  React.useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logRows]);

  const closeLive = React.useCallback(() => {
    liveRef.current?.close();
    liveRef.current = null;
    setIsStreaming(false);
  }, []);

  React.useEffect(() => () => closeLive(), [closeLive]);

  const openDep = React.useCallback(async (dep: DeploymentRecord) => {
    closeLive();
    setSelectedDep(dep);
    setLogRows([]);
    setLogsError(null);
    setLogSearch("");
    setLogsLoading(true);

    const parseRows = (raw: unknown): DeploymentLogRow[] => {
      const toRow = (v: unknown): DeploymentLogRow | null => {
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          const msg = typeof o.message === "string" ? o.message.trim() : "";
          const err = typeof o.error === "string" ? o.error.trim() : "";
          const ts = typeof o.timestamp === "string" ? o.timestamp : new Date().toISOString();
          const type = typeof o.type === "string" ? o.type : "";
          if (err) return { key: nextLogKey(), timestamp: ts, text: err, isError: true };
          if (msg) return { key: nextLogKey(), timestamp: ts, text: msg, isError: type === "error" };
        }
        const s = typeof v === "string" ? v.replace(/^data:\s*/i, "").trim() : "";
        if (!s) return null;
        try {
          const p = JSON.parse(s) as { message?: string; error?: string; timestamp?: string };
          const ts = p.timestamp ?? new Date().toISOString();
          if (p.error?.trim()) return { key: nextLogKey(), timestamp: ts, text: p.error.trim(), isError: true };
          if (p.message?.trim()) return { key: nextLogKey(), timestamp: ts, text: p.message.trim(), isError: false };
          return null;
        } catch {
          return { key: nextLogKey(), timestamp: new Date().toISOString(), text: s, isError: /error/i.test(s) };
        }
      };
      if (Array.isArray(raw)) return raw.map(toRow).filter(Boolean) as DeploymentLogRow[];
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (r.logs) return parseRows(r.logs);
        if (r.data) return parseRows(r.data);
      }
      return [];
    };

    try {
      const ageMs = Date.now() - new Date(dep.createdAt).getTime();
      const useLive = Boolean(DEPLOY_SERVICE_URL) && ageMs < 10 * 60_000;

      if (useLive) {
        const src = new EventSource(`${DEPLOY_SERVICE_URL.replace(/\/$/, "")}/logs/${dep.id}`);
        liveRef.current = src;
        src.onopen = () => { setLogsLoading(false); setIsStreaming(true); };
        src.onmessage = e => {
          const rows = parseRows([e.data]);
          if (rows.length) setLogRows(prev => [...prev, ...rows]);
        };
        src.onerror = () => { setIsStreaming(false); closeLive(); setLogsLoading(false); };
        return;
      }

      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/deployments/${dep.id}/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed to load logs");
      setLogRows(parseRows(data.logs));
    } catch (e: unknown) {
      setLogsError((e as Error)?.message || "Failed to load logs");
    } finally {
      if (!liveRef.current) setLogsLoading(false);
    }
  }, [closeLive, getToken]);

  const filteredLogs = React.useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return q ? logRows.filter(r => r.text.toLowerCase().includes(q)) : logRows;
  }, [logRows, logSearch]);

  // ── Deployment list ──
  if (!selectedDep) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-4 h-4 animate-spin text-white/30" />
          </div>
        )}
        {!loading && error && (
          <div className="mx-4 mt-3 flex items-center gap-2 p-3 rounded-xl border border-red-500/20 bg-red-500/[0.08]">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-[12px] text-red-300">{error}</p>
          </div>
        )}
        {!loading && !error && deployments.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <FileText className="w-5 h-5 text-white/15" />
            <p className="text-[12px] text-white/30">No deployments yet</p>
          </div>
        )}
        {deployments.map((dep, i) => {
          const st = serverStatus(dep);
          const url = liveUrl(dep);
          return (
            <button
              key={dep.id}
              type="button"
              onClick={() => openDep(dep)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]",
                i !== deployments.length - 1 && "border-b border-white/[0.05]"
              )}
            >
              <span className={cn("w-2 h-2 rounded-full shrink-0", statusDot(st))} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[12px] font-semibold text-white/80">
                    {dep.status === "SUCCESS" ? "Ready" : dep.status === "FAILED" ? "Failed" : "Building"}
                  </span>
                  <span className={cn(
                    "text-[9px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0",
                    dep.type === "FRONTEND"
                      ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                      : "bg-violet-500/10 border-violet-500/20 text-violet-400"
                  )}>
                    {dep.type}
                  </span>
                </div>
                {url && <p className="text-[11px] text-white/35 truncate">{url.replace(/^https?:\/\//, "")}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-[11px] text-white/30">{timeAgo(dep.createdAt)}</p>
                <p className="text-[10px] text-white/20">{formatDuration(dep.createdAt, dep.updatedAt)}</p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  // ── Log detail ──
  const dep = selectedDep;
  const url = liveUrl(dep);
  return (
    <div className="flex flex-col h-full">
      {/* Detail header */}
      <div className="shrink-0 border-b border-white/[0.07]">
        {/* Preview image */}
        <div className="relative h-[100px] bg-[#111]">
          {dep.status === "FAILED" ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-400/50" />
              <span className="text-[12px] text-red-400/50">Build failed</span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={(dep.config as { screenshotUrl?: string })?.screenshotUrl ?? "/demo_bg.jpg"}
              alt="Preview"
              className="absolute inset-0 w-full h-full object-cover opacity-60"
              onError={e => { (e.target as HTMLImageElement).src = "/demo_bg.jpg"; }}
            />
          )}
        </div>
        {/* Meta */}
        <div className="px-4 py-3 grid grid-cols-3 gap-3">
          <div>
            <p className="text-[10px] text-white/30 mb-0.5">Status</p>
            <div className="flex items-center gap-1.5">
              <span className={cn("w-1.5 h-1.5 rounded-full", statusDot(serverStatus(dep)))} />
              <span className="text-[11px] text-white/70">
                {dep.status === "SUCCESS" ? "Ready" : dep.status === "FAILED" ? "Failed" : "Building"}
              </span>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-white/30 mb-0.5">Duration</p>
            <div className="flex items-center gap-1 text-[11px] text-white/70">
              <Clock className="w-3 h-3 text-white/30" />
              {formatDuration(dep.createdAt, dep.updatedAt)}
            </div>
          </div>
          <div>
            <p className="text-[10px] text-white/30 mb-0.5">Created</p>
            <p className="text-[11px] text-white/70">{timeAgo(dep.createdAt)}</p>
          </div>
        </div>
        {url && (
          <div className="px-4 pb-3">
            <a
              href={url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF15DC] hover:bg-[#FF15DC]/90 text-white text-[11px] font-semibold transition-colors"
            >
              Visit <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>

      {/* Logs toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { closeLive(); setSelectedDep(null); setLogRows([]); }}
            className="w-6 h-6 flex items-center justify-center rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[12px] font-semibold text-white/60">Build Log</span>
          <span className="text-[11px] text-white/30">{logRows.length} lines</span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={logSearch}
            onChange={e => setLogSearch(e.target.value)}
            placeholder="Find"
            className="h-7 w-36 rounded-lg pl-7 pr-3 text-[11px] bg-transparent border border-white/[0.10] text-white/70 placeholder:text-white/25 outline-none focus:border-white/25"
          />
        </div>
      </div>

      {/* Log rows */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 font-mono">
        {/* Column headers */}
        <div className="grid grid-cols-[100px_80px_1fr] px-4 py-2 border-b border-white/[0.05] text-[10px] font-semibold uppercase tracking-wider text-white/30 sticky top-0 bg-[#1c1c1c]">
          <span>Time</span>
          <span>Status</span>
          <span>Message</span>
        </div>

        {logsLoading && (
          <div className="flex items-center gap-2 px-4 py-4 text-white/35 text-[12px]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading logs…
          </div>
        )}
        {!logsLoading && logsError && (
          <div className="mx-4 my-3 flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/[0.08]">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-[11px] text-red-300">{logsError}</p>
          </div>
        )}
        {!logsLoading && !logsError && filteredLogs.length === 0 && !isStreaming && (
          <p className="px-4 py-4 text-[12px] text-white/25">{logSearch ? "No matches." : "No logs yet."}</p>
        )}

        {filteredLogs.map(row => (
          <div
            key={row.key}
            className={cn(
              "grid grid-cols-[100px_80px_1fr] px-4 py-2.5 border-b border-white/[0.04] text-[11px] hover:bg-white/[0.02]",
              row.isError && "bg-red-500/[0.05]"
            )}
          >
            <span className="text-white/30 tabular-nums">
              {new Date(row.timestamp).toLocaleTimeString()}
            </span>
            <span>
              <span className="text-white/40">LOG </span>
              <span className={row.isError ? "text-red-400" : "text-emerald-400"}>
                {row.isError ? "ERR" : "OK"}
              </span>
            </span>
            <span className={cn("break-all leading-relaxed", row.isError ? "text-red-300" : "text-white/55")}>
              {row.text}
            </span>
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-center gap-2 px-4 py-3 text-white/25 text-[11px] italic">
            <Loader2 className="w-3 h-3 animate-spin" /> Waiting…
          </div>
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// ── Server Detail ─────────────────────────────────────────────────────────────

type DetailTab = "overview" | "logs" | "deployments";

function ServerDetail({ entry }: { entry: ServerEntry }) {
  const [tab, setTab] = React.useState<DetailTab>("overview");
  const dep = entry.deployment;
  const url = liveUrl(dep);
  const st = serverStatus(dep);

  return (
    <div className="flex flex-col h-full">
      {/* Detail header */}
      <div className="shrink-0 px-5 py-3.5 border-b border-white/[0.07]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-[15px] font-semibold text-white truncate">{entry.workspaceName}</p>
              <span className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0",
                dep.type === "FRONTEND"
                  ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                  : "bg-violet-500/10 border-violet-500/20 text-violet-400"
              )}>
                {dep.type}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span className={cn("w-1.5 h-1.5 rounded-full", statusDot(st))} />
              {statusLabel(st)}
              {url && (
                <>
                  <span className="text-white/20">·</span>
                  <span className="text-white/40 truncate text-[11px]">{url.replace(/^https?:\/\//, "")}</span>
                </>
              )}
            </div>
          </div>
          {url && (
            <a
              href={url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF15DC] hover:bg-[#FF15DC]/90 text-white text-[11px] font-semibold transition-colors shrink-0"
            >
              Visit <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b border-white/[0.07] shrink-0">
        {([
          { id: "overview" as const, label: "Overview", icon: BarChart2 },
          { id: "logs" as const, label: "Logs", icon: List },
          { id: "deployments" as const, label: "Deployment Logs", icon: FileText },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-3 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap",
              tab === id
                ? "border-[#FF15DC] text-white"
                : "border-transparent text-white/40 hover:text-white/70"
            )}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "overview" && (
          <div className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
            <OverviewTab workspaceId={entry.workspaceId} />
          </div>
        )}
        {tab === "logs" && <LogsTab workspaceId={entry.workspaceId} />}
        {tab === "deployments" && <DeploymentLogsTab workspaceId={entry.workspaceId} />}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ServersPage() {
  const { user } = useUser();
  const { getToken } = useAuth();

  const [entries, setEntries] = React.useState<ServerEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ServerEntry | null>(null);
  const [search, setSearch] = React.useState("");

  const load = React.useCallback(async () => {
    if (!user?.id) return;
    setIsLoading(true);
    setFetchError(null);
    try {
      const token = await getToken();

      // 1. Get all workspaces
      const wsRes = await fetch(`${API_URL}/api/workspaces/${user.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const wsData = await wsRes.json();
      if (!wsRes.ok) throw new Error(wsData?.error || "Failed to load workspaces");
      const workspaces: WorkspaceRow[] = Array.isArray(wsData) ? wsData : [];

      // 2. Fetch deployments for all workspaces in parallel
      const depResults = await Promise.allSettled(
        workspaces.map(ws =>
          fetch(`${API_URL}/api/workspaces/${ws.id}/deployments`, {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then(r => r.json())
            .then(d => ({ workspaceId: ws.id, workspaceName: ws.name, deployments: d.deployments ?? [] }))
        )
      );

      // 3. Flatten into server entries sorted by createdAt desc
      const flat: ServerEntry[] = depResults.flatMap(r => {
        if (r.status !== "fulfilled") return [];
        return (r.value.deployments as DeploymentRecord[]).map(dep => ({
          workspaceId: r.value.workspaceId,
          workspaceName: r.value.workspaceName,
          deployment: dep,
        }));
      });

      flat.sort((a, b) =>
        new Date(b.deployment.createdAt).getTime() - new Date(a.deployment.createdAt).getTime()
      );

      setEntries(flat);
    } catch (e: unknown) {
      setFetchError((e as Error)?.message || "Failed to load servers");
    } finally {
      setIsLoading(false);
    }
  }, [user, getToken]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { void load(); }, [load]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(e => e.workspaceName.toLowerCase().includes(q));
  }, [entries, search]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#1c1c1c] text-white font-sans">
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Top header */}
        <div className="shrink-0 h-[52px] px-5 flex items-center justify-between border-b border-white/[0.07]">
          <div className="flex items-center gap-3">
            <Server className="w-4 h-4 text-white/40" />
            <h1 className="text-[15px] font-semibold text-white">Servers</h1>
          </div>
          <button
            onClick={load}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] text-white/50 hover:text-white text-[12px] transition-all disabled:opacity-40"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">

          {/* Left panel */}
          <div className="w-[300px] shrink-0 flex flex-col border-r border-white/[0.07] overflow-hidden">

            {/* Summary bar */}
            {!isLoading && entries.length > 0 && <SummaryBar entries={entries} />}

            {/* Search */}
            <div className="px-3 py-2.5 border-b border-white/[0.06] shrink-0">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search servers..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full h-8 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-8 pr-3 text-[12px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/20 transition-colors"
                />
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
              {isLoading && (
                <div className="space-y-0">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="px-4 py-3.5 border-b border-white/[0.05] animate-pulse">
                      <div className="flex items-start gap-2.5">
                        <div className="w-2 h-2 rounded-full bg-white/10 shrink-0 mt-1.5" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-2.5 bg-white/[0.06] rounded w-3/5" />
                          <div className="h-2 bg-white/[0.04] rounded w-2/5" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!isLoading && fetchError && (
                <div className="m-3 flex items-start gap-2 p-3 rounded-xl border border-red-500/20 bg-red-500/[0.08]">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
                  <p className="text-[12px] text-red-300">{fetchError}</p>
                </div>
              )}

              {!isLoading && !fetchError && filtered.length === 0 && (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <Rocket className="w-5 h-5 text-white/15" />
                  <p className="text-[12px] text-white/30">
                    {search ? "No matches" : "No servers deployed yet"}
                  </p>
                </div>
              )}

              {!isLoading && filtered.map(entry => (
                <ServerRow
                  key={`${entry.workspaceId}-${entry.deployment.id}`}
                  entry={entry}
                  selected={selected?.deployment.id === entry.deployment.id}
                  onClick={() => setSelected(entry)}
                />
              ))}
            </div>
          </div>

          {/* Right panel */}
          <div className="flex-1 overflow-hidden">
            {!selected ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <Server className="w-8 h-8 text-white/10" />
                <p className="text-[13px] text-white/30">Select a server to view details</p>
              </div>
            ) : (
              <ServerDetail key={selected.deployment.id} entry={selected} />
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
