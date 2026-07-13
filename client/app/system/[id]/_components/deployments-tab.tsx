"use client";

import * as React from "react";
import { useAuth } from "@/lib/auth-client";
import {
  AlertCircle, ArrowLeft, Clock, ExternalLink, Globe, GitBranch,
  GitCommitHorizontal, Loader2, Rocket, Search, Copy, Server,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const DEPLOY_SERVICE_URL = process.env.NEXT_PUBLIC_DEPLOY_URL || "";

// ── DEMO MODE ─────────────────────────────────────────────────────────────────
// Set to false to remove the demo deployment and use only real backend data.
const DEMO_MODE = false;

const DEMO_DEPLOYMENT: DeploymentRecord = {
  id: "demo-deploy-001",
  workspaceId: "demo",
  jobId: "job-demo-abc123",
  type: "FRONTEND",
  cloudfrontUrl: "d1abc23def456.cloudfront.net",
  previewUrl: "https://demo.ai-agents.com",
  createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
  status: "SUCCESS",
  config: null,
};

const DEMO_LOGS: Array<{ text: string; isError: boolean; delay: number }> = [
  { text: "Initializing build environment...", isError: false, delay: 0 },
  { text: "Cloning repository from source...", isError: false, delay: 120 },
  { text: "Repository cloned in 1.2s", isError: false, delay: 280 },
  { text: "Installing dependencies with pnpm...", isError: false, delay: 400 },
  { text: "Packages: +342 added", isError: false, delay: 950 },
  { text: "Running type-check...", isError: false, delay: 1100 },
  { text: "Type-check passed", isError: false, delay: 1800 },
  { text: "Running next build...", isError: false, delay: 1950 },
  { text: "  ▲ Next.js 14.2.3", isError: false, delay: 2100 },
  { text: "  - Environments: .env.production", isError: false, delay: 2200 },
  { text: "  Creating an optimized production build...", isError: false, delay: 2350 },
  { text: "  ✓ Compiled successfully", isError: false, delay: 3400 },
  { text: "  ✓ Linting and checking validity of types", isError: false, delay: 3600 },
  { text: "  ✓ Collecting page data", isError: false, delay: 3900 },
  { text: "  ✓ Generating static pages (12/12)", isError: false, delay: 4200 },
  { text: "  ✓ Finalizing page optimization", isError: false, delay: 4500 },
  { text: "Build output: 2.3 MB (gzip: 612 KB)", isError: false, delay: 4700 },
  { text: "Uploading assets to S3 bucket...", isError: false, delay: 4900 },
  { text: "Uploaded 87 files to s3://ai-agents-deployments/demo-deploy-001/", isError: false, delay: 5600 },
  { text: "Invalidating CloudFront distribution...", isError: false, delay: 5800 },
  { text: "CloudFront invalidation created: I2XABCDEF123456", isError: false, delay: 6200 },
  { text: "Setting DNS records...", isError: false, delay: 6400 },
  { text: "✓ Deployment live at https://demo.ai-agents.com", isError: false, delay: 6800 },
  { text: "Job demo-deploy-001 completed successfully in 3m 12s", isError: false, delay: 7000 },
];

interface DeploymentRecord {
  id: string;
  workspaceId?: string;
  jobId?: string | null;
  type?: string | null;
  cloudfrontUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  config?: { error?: string; screenshotUrl?: string } | null;
}

interface DeploymentLogRow {
  key: string;
  timestamp: string;
  text: string;
  isError: boolean;
}

interface DeploymentsTabProps {
  workspaceId: string;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatLogTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function formatDuration(createdAt: string, updatedAt: string) {
  const start = new Date(createdAt).getTime();
  const end = new Date(updatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "-";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusBadgeClass(status: string) {
  if (status === "SUCCESS") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/25";
  if (status === "FAILED") return "bg-red-500/15 text-red-400 border-red-500/25";
  if (status === "DEPLOYING" || status === "BUILDING") return "bg-blue-500/15 text-blue-400 border-blue-500/25";
  return "bg-amber-500/15 text-amber-400 border-amber-500/25";
}

export function DeploymentsTab({ workspaceId }: DeploymentsTabProps) {
  const { getToken } = useAuth();
  const [deployments, setDeployments] = React.useState<DeploymentRecord[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [logRows, setLogRows] = React.useState<DeploymentLogRow[]>([]);
  const [isLogsLoading, setIsLogsLoading] = React.useState(false);
  const [logsError, setLogsError] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [visibleUrls, setVisibleUrls] = React.useState<Record<string, boolean>>({});

  const liveSourceRef = React.useRef<EventSource | null>(null);
  const logKeyRef = React.useRef(0);
  const streamEndedRef = React.useRef(false);
  const logsContainerRef = React.useRef<HTMLDivElement>(null);

  const nextKey = React.useCallback(() => String(++logKeyRef.current), []);

  const selectedDeployment = React.useMemo(
    () => deployments.find(d => d.id === selectedId) ?? null,
    [deployments, selectedId]
  );

  const filteredLogs = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return q ? logRows.filter(r => r.text.toLowerCase().includes(q)) : logRows;
  }, [logRows, searchQuery]);

  const closeLive = React.useCallback(() => {
    liveSourceRef.current?.close();
    liveSourceRef.current = null;
    setIsStreaming(false);
  }, []);

  const isUrlVisible = React.useCallback((k: string) => visibleUrls[k] ?? true, [visibleUrls]);
  const toggleUrl = React.useCallback((k: string) => {
    setVisibleUrls(prev => ({ ...prev, [k]: !(prev[k] ?? true) }));
  }, []);

  const fetchDeployments = React.useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/deployments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.success) { setError(data?.error || "Failed to fetch deployments"); return; }
      const real: DeploymentRecord[] = Array.isArray(data.deployments) ? data.deployments : [];
      setDeployments(DEMO_MODE ? [DEMO_DEPLOYMENT, ...real] : real);
    } catch (e: any) {
      setError(e?.message || "Failed to fetch deployments");
      if (DEMO_MODE) setDeployments([DEMO_DEPLOYMENT]);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  const demoTimersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  const fetchLogs = React.useCallback(async (deploymentId: string) => {
    setSelectedId(deploymentId);
    setIsLogsLoading(true);
    setLogsError(null);
    setSearchQuery("");
    closeLive();

    // Clear any existing demo timers
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];

    // Demo: stream simulated logs with staggered delays
    if (DEMO_MODE && deploymentId === DEMO_DEPLOYMENT.id) {
      setLogRows([]);
      setIsLogsLoading(false);
      setIsStreaming(true);
      const base = Date.now();
      DEMO_LOGS.forEach(({ text, isError, delay }) => {
        const t = setTimeout(() => {
          setLogRows(prev => [...prev, {
            key: nextKey(),
            timestamp: new Date(base + delay).toISOString(),
            text,
            isError,
          }]);
        }, delay);
        demoTimersRef.current.push(t);
      });
      const endTimer = setTimeout(() => setIsStreaming(false), DEMO_LOGS[DEMO_LOGS.length - 1].delay + 200);
      demoTimersRef.current.push(endTimer);
      return;
    }

    const toRows = (logs: unknown): DeploymentLogRow[] => {
      const mapEntry = (value: unknown): DeploymentLogRow | null => {
        if (value && typeof value === "object") {
          const obj = value as Record<string, unknown>;
          const message = typeof obj.message === "string" ? obj.message.trim() : "";
          const error = typeof obj.error === "string" ? obj.error.trim() : "";
          const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
          const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();
          if (error) return { key: nextKey(), timestamp, text: error, isError: true };
          if (message) return { key: nextKey(), timestamp, text: message, isError: type === "error" };
        }
        const raw = typeof value === "string" ? value : String(value ?? "");
        const stripped = raw.replace(/^data:\s*/i, "").trim();
        try {
          const parsed = JSON.parse(stripped) as { message?: string; error?: string; timestamp?: string };
          const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
          if (typeof parsed.error === "string" && parsed.error.trim()) return { key: nextKey(), timestamp: ts, text: parsed.error.trim(), isError: true };
          if (typeof parsed.message === "string" && parsed.message.trim()) return { key: nextKey(), timestamp: ts, text: parsed.message.trim(), isError: false };
          return null;
        } catch {
          if (!stripped) return null;
          return { key: nextKey(), timestamp: new Date().toISOString(), text: stripped, isError: /error/i.test(stripped) };
        }
      };

      let entries: Array<[string, unknown]> = [];
      if (typeof logs === "string") {
        entries = logs.split("\n").map((l, i) => [String(i + 1), l.trim()] as [string, unknown]).filter(([, v]) => v);
      } else if (Array.isArray(logs)) {
        entries = logs.map((v, i) => [String(i + 1), v] as [string, unknown]);
      } else if (logs && typeof logs === "object") {
        const rec = logs as Record<string, unknown>;
        if (rec.logs !== undefined) return toRows(rec.logs);
        if (rec.data !== undefined) return toRows(rec.data);
        entries = Object.entries(rec).sort(([a], [b]) => Number(a) - Number(b));
      } else {
        return [];
      }
      return entries.map(([, v]) => mapEntry(v)).filter((r): r is DeploymentLogRow => Boolean(r));
    };

    try {
      const dep = deployments.find(d => d.id === deploymentId);
      const ageMs = dep?.createdAt ? Date.now() - new Date(dep.createdAt).getTime() : Infinity;
      const useLive = Boolean(DEPLOY_SERVICE_URL) && ageMs < 10 * 60 * 1000;

      if (useLive) {
        setLogRows([]);
        const source = new EventSource(`${DEPLOY_SERVICE_URL.replace(/\/$/, "")}/logs/${deploymentId}`);
        liveSourceRef.current = source;
        streamEndedRef.current = false;
        source.onopen = () => { setIsLogsLoading(false); setIsStreaming(true); };
        source.onmessage = (e) => {
          const next = toRows([e.data]);
          if (next.length) setLogRows(prev => [...prev, ...next]);
          try {
            const parsed = JSON.parse(e.data.replace(/^data:\s*/i, "").trim());
            if (parsed?.source === "system" && typeof parsed?.message === "string" && parsed.message.startsWith("Job ")) {
              streamEndedRef.current = true;
            }
          } catch { }
        };
        source.onerror = () => {
          if (!streamEndedRef.current) setLogsError("Live log stream disconnected");
          setIsLogsLoading(false);
          setIsStreaming(false);
          closeLive();
        };
        return;
      }

      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/deployments/${deploymentId}/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.success) { setLogsError(data?.error || "Failed to fetch logs"); setLogRows([]); return; }
      setLogRows(toRows(data.logs));
    } catch (e: any) {
      setLogsError(e?.message || "Failed to fetch logs");
      setLogRows([]);
    } finally {
      if (!liveSourceRef.current) setIsLogsLoading(false);
    }
  }, [closeLive, deployments, nextKey]);

  React.useEffect(() => { setIsLoading(true); fetchDeployments(); }, [fetchDeployments]);
  React.useEffect(() => {
    const id = window.setInterval(fetchDeployments, 8000);
    return () => window.clearInterval(id);
  }, [fetchDeployments]);
  React.useEffect(() => () => {
    closeLive();
    demoTimersRef.current.forEach(clearTimeout);
  }, [closeLive]);
  React.useEffect(() => {
    const el = logsContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logRows]);

  const back = () => {
    closeLive();
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];
    setSelectedId(null);
    setLogRows([]);
    setLogsError(null);
    setIsStreaming(false);
  };

  // ── Deployment list view ────────────────────────────────────────────────────
  if (!selectedId) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
        {isLoading && (
          <div className="flex flex-col">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b border-white/[0.05] animate-pulse">
                <div className="w-2 h-2 rounded-full bg-white/10 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 bg-white/[0.06] rounded w-2/5" />
                  <div className="h-2 bg-white/[0.04] rounded w-1/4" />
                </div>
                <div className="h-2 bg-white/[0.05] rounded w-16" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && error && (
          <div className="m-4 flex items-start gap-2.5 p-3 rounded-xl border border-red-500/20 bg-red-500/[0.08]">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
            <p className="text-[12px] text-red-300">{error}</p>
          </div>
        )}

        {!isLoading && !error && deployments.length === 0 && (
          <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-center">
            <div className="w-10 h-10 rounded-xl bg-brand-pink/10 border border-brand-pink/20 flex items-center justify-center">
              <Rocket className="w-4 h-4 text-brand-pink/70" />
            </div>
            <p className="text-[13px] font-semibold text-white/70">No deployments yet</p>
            <p className="text-[11px] text-white/30 max-w-[200px] leading-relaxed">
              Deploy your project to see build logs and live URLs here.
            </p>
          </div>
        )}

        {!isLoading && !error && deployments.length > 0 && (
          <div className="flex flex-col">
            {deployments.map((dep, i) => {
              const isFailed = dep.status === "FAILED";
              const isSuccess = dep.status === "SUCCESS";
              const liveUrl = dep.cloudfrontUrl || dep.previewUrl || null;

              return (
                <button
                  key={dep.id}
                  type="button"
                  onClick={() => fetchLogs(dep.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]",
                    i !== deployments.length - 1 && "border-b border-white/[0.05]"
                  )}
                >
                  {/* Status dot */}
                  <span className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    isSuccess ? "bg-emerald-500" : isFailed ? "bg-red-500" : "bg-amber-500 animate-pulse"
                  )} />

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] font-semibold text-white/80 truncate">
                        {isSuccess ? "Ready" : isFailed ? "Failed" : "Building"}
                      </span>
                      {dep.type && (
                        <span className="text-[9px] font-medium text-white/30 border border-white/[0.08] px-1.5 py-0.5 rounded-full">
                          {dep.type}
                        </span>
                      )}
                    </div>
                    {liveUrl && (
                      <p className="text-[11px] text-white/35 truncate">{liveUrl.replace(/^https?:\/\//, "")}</p>
                    )}
                  </div>

                  {/* Time */}
                  <div className="text-right shrink-0">
                    <p className="text-[11px] text-white/30">{formatDate(dep.createdAt)}</p>
                    <p className="text-[10px] text-white/20 mt-0.5">{formatDuration(dep.createdAt, dep.updatedAt)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Detail view ─────────────────────────────────────────────────────────────
  const dep = selectedDeployment;
  const isSuccess = dep?.status === "SUCCESS";
  const isFailed = dep?.status === "FAILED";
  const liveUrl = dep?.previewUrl || (dep?.cloudfrontUrl ? `https://${dep.cloudfrontUrl}` : null);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 flex flex-col">

      {/* ── Info card ── */}
      <div className="border-b border-white/[0.07]">
        {/* Card body: image + meta */}
        <div className="flex gap-0">
          {/* Preview image */}
          <div className="w-[38%] shrink-0 border-r border-white/[0.06]">
            <div className="relative h-full min-h-[160px] bg-[#111]">
              {isFailed ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <AlertCircle className="w-7 h-7 text-red-400/50" />
                  <p className="text-[11px] text-red-400/50 font-medium">Build failed</p>
                </div>
              ) : (
                <img
                  src={dep?.config?.screenshotUrl ?? "/demo_bg.jpg"}
                  alt="Site preview"
                  className="absolute inset-0 w-full h-full object-cover opacity-70"
                  onError={(e) => { (e.target as HTMLImageElement).src = "/demo_bg.jpg"; }}
                />
              )}
            </div>
          </div>

          {/* Meta */}
          <div className="flex-1 min-w-0 p-4 space-y-4">
            {/* Top row: 4 columns */}
            <div className="grid grid-cols-4 gap-3">
              <div>
                <p className="text-[10px] text-white/35 mb-1">Created</p>
                <p className="text-[11px] text-white/75">{dep ? formatDate(dep.createdAt) : "—"}</p>
              </div>
              <div>
                <p className="text-[10px] text-white/35 mb-1">Status</p>
                <div className="flex items-center gap-1.5">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", isSuccess ? "bg-emerald-500" : isFailed ? "bg-red-500" : "bg-amber-400 animate-pulse")} />
                  <span className="text-[11px] text-white/75">{isSuccess ? "Ready" : isFailed ? "Failed" : "Building"}</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] text-white/35 mb-1">Duration</p>
                <div className="flex items-center gap-1 text-[11px] text-white/75">
                  <Clock className="w-3 h-3 text-white/30 shrink-0" />
                  {dep ? formatDuration(dep.createdAt, dep.updatedAt) : "—"}
                </div>
              </div>
              <div>
                <p className="text-[10px] text-white/35 mb-1">Environment</p>
                <div className="flex items-center gap-1.5">
                  <Server className="w-3 h-3 text-white/30 shrink-0" />
                  <span className="text-[11px] text-white/75">Production</span>
                  {isSuccess && <span className="text-[9px] font-semibold text-white bg-brand-pink px-1.5 py-0.5 rounded-full leading-none">Current</span>}
                </div>
              </div>
            </div>

            {/* Visit button */}
            {liveUrl && (
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-pink hover:bg-brand-pink/90 text-white text-[11px] font-semibold transition-colors self-start"
              >
                Visit <ExternalLink className="w-3 h-3" />
              </a>
            )}

            {/* Domains */}
            <div>
              <p className="text-[10px] text-white/35 mb-1.5">Domains</p>
              <div className="space-y-1">
                {dep?.previewUrl ? (
                  <>
                    <a href={dep.previewUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[11px] text-white/65 hover:text-white/90 transition-colors truncate">
                      <Globe className="w-3 h-3 text-white/30 shrink-0" />
                      <span className="truncate">{dep.previewUrl.replace(/^https?:\/\//, "")}</span>
                    </a>
                    {dep.cloudfrontUrl && (
                      <a href={`https://${dep.cloudfrontUrl}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/70 transition-colors truncate">
                        <GitBranch className="w-3 h-3 text-white/20 shrink-0" />
                        <span className="truncate">{dep.cloudfrontUrl}</span>
                      </a>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-white/25">No domains assigned</p>
                )}
              </div>
            </div>

            {/* Source */}
            <div>
              <p className="text-[10px] text-white/35 mb-1.5">Source</p>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                  <GitBranch className="w-3 h-3 text-white/25 shrink-0" />
                  <span>{dep?.type === "BACKEND" ? "backend" : "main"}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                  <GitCommitHorizontal className="w-3 h-3 text-white/25 shrink-0" />
                  <span className="font-mono">{dep?.id.slice(0, 7)}</span>
                  <span className="text-white/30">latest deploy</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Deployment Checks bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] bg-white/[0.015] shrink-0">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={back}
            className="w-6 h-6 flex items-center justify-center rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <span className="text-[12px] font-semibold text-white/70">Deployment Checks</span>
        </div>
        <Clock className="w-3.5 h-3.5 text-white/25" />
      </div>

      {/* ── Logs ── */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Logs toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2 text-[12px] text-white/50">
            <button
              type="button"
              onClick={() => { const text = filteredLogs.map(r => r.text).join("\n"); navigator.clipboard.writeText(text); }}
              className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.06] hover:text-white/80 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <span className="font-medium text-white/60">{logRows.length} lines</span>
            {isStreaming && (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400 ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Find in logs"
              className="h-7 w-44 rounded-lg pl-7 pr-3 text-[11px] bg-transparent border border-white/[0.12] text-white/70 placeholder:text-white/25 outline-none focus:border-white/25 transition-colors"
            />
          </div>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[160px_100px_1fr] px-4 py-2 border-b border-white/[0.05] shrink-0">
          <span className="text-[11px] font-semibold text-white/35">Time</span>
          <span className="text-[11px] font-semibold text-white/35">Status</span>
          <span className="text-[11px] font-semibold text-white/35">Messages</span>
        </div>

        {/* Log rows */}
        <div ref={logsContainerRef} className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 font-mono">
          {isLogsLoading && (
            <div className="flex items-center gap-2 px-4 py-4 text-white/35 text-[12px]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading logs…
            </div>
          )}
          {!isLogsLoading && logsError && (
            <div className="mx-4 my-3 flex items-start gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/[0.08]">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
              <p className="text-[11px] text-red-300">{logsError}</p>
            </div>
          )}
          {!isLogsLoading && !logsError && filteredLogs.length === 0 && (
            <p className="px-4 py-4 text-[12px] text-white/25">{searchQuery ? "No lines match." : "No logs yet."}</p>
          )}
          {!isLogsLoading && !logsError && filteredLogs.map(row => (
            <div
              key={row.key}
              className={cn(
                "grid grid-cols-[160px_100px_1fr] px-4 py-3 border-b border-white/[0.04] text-[11px] hover:bg-white/[0.02]",
                row.isError ? "bg-red-500/[0.06]" : ""
              )}
            >
              <span className="text-white/30 tabular-nums">{formatLogTimestamp(row.timestamp)}</span>
              <span>
                {row.isError
                  ? <><span className="text-white/50">LOG</span> <span className="text-red-400">ERR</span></>
                  : <><span className="text-white/50">LOG</span> <span className="text-emerald-400">OK</span></>
                }
              </span>
              <span className={cn("break-all leading-relaxed", row.isError ? "text-red-300" : "text-white/55")}>{row.text}</span>
            </div>
          ))}
          {isStreaming && (
            <div className="flex items-center gap-2 px-4 py-3 text-white/25 text-[11px] italic">
              <Loader2 className="w-3 h-3 animate-spin" /> Waiting for logs…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
