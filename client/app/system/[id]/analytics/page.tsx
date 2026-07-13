"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-client";
import {
  ArrowLeft, BarChart2, Loader2, AlertCircle, ShieldAlert,
  Rocket, FlaskConical, Search, RefreshCw, Download, Globe,
  LayoutGrid, User, List, Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import Sidebar from "@/components/Sidebar";
import { createPortal } from "react-dom";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

// ─── DEMO MODE ─────────────────────────────────────────────────────────────
// Flip to false when real data is ready. Demo code lives in "DEMO DATA" block.
const DEMO_MODE = false;
// ───────────────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface LogItem {
  timestamp: string;
  project_id: string;
  type: "frontend" | "backend";
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  country: string;
  referrer: string;
  message?: string;
}

interface AnalyticsData {
  _source: string;
  period: "24h" | "7d" | "30d";
  visitors: number;
  page_views: number;
  api_requests: number;
  bounce_rate: number;
  timeseries: { day: string; page_views: number; api_requests: number; visitors: number }[];
  top_pages: { path: string; hits: number }[];
  top_routes?: { path: string; hits: number }[];
  top_hostnames?: { path: string; hits: number }[];
  top_utm?: { referrer: string; hits: number }[];
  failing_requests: { path: string; status: number; type: "frontend" | "backend"; hits: number }[];
  countries: { country: string; visitors: number }[];
  referrers: { referrer: string; hits: number }[];
}

const COUNTRY_CODES: Record<string, string> = {
  "Afghanistan": "AF", "Albania": "AL", "Algeria": "DZ", "Argentina": "AR", "Australia": "AU",
  "Austria": "AT", "Bangladesh": "BD", "Belgium": "BE", "Brazil": "BR", "Canada": "CA",
  "Chile": "CL", "China": "CN", "Colombia": "CO", "Croatia": "HR", "Czech Republic": "CZ",
  "Czechia": "CZ", "Denmark": "DK", "Egypt": "EG", "Ethiopia": "ET", "Finland": "FI",
  "France": "FR", "Germany": "DE", "Ghana": "GH", "Greece": "GR", "Hong Kong": "HK",
  "Hungary": "HU", "India": "IN", "Indonesia": "ID", "Iran": "IR", "Iraq": "IQ",
  "Ireland": "IE", "Israel": "IL", "Italy": "IT", "Japan": "JP", "Jordan": "JO",
  "Kazakhstan": "KZ", "Kenya": "KE", "Kuwait": "KW", "Lebanon": "LB", "Malaysia": "MY",
  "Mexico": "MX", "Morocco": "MA", "Myanmar": "MM", "Nepal": "NP", "Netherlands": "NL",
  "New Zealand": "NZ", "Nigeria": "NG", "Norway": "NO", "Oman": "OM", "Pakistan": "PK",
  "Peru": "PE", "Philippines": "PH", "Poland": "PL", "Portugal": "PT", "Qatar": "QA",
  "Romania": "RO", "Russia": "RU", "Saudi Arabia": "SA", "Serbia": "RS", "Singapore": "SG",
  "Slovakia": "SK", "South Africa": "ZA", "South Korea": "KR", "Spain": "ES",
  "Sri Lanka": "LK", "Sweden": "SE", "Switzerland": "CH", "Taiwan": "TW", "Thailand": "TH",
  "Turkey": "TR", "Türkiye": "TR", "Ukraine": "UA", "United Arab Emirates": "AE",
  "United Kingdom": "GB", "United States": "US", "United States of America": "US",
  "Vietnam": "VN", "Viet Nam": "VN",
};

const CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_CODES).map(([name, code]) => [code, name])
);

function countryDisplayName(raw: string): string {
  if (raw.length === 2 && raw === raw.toUpperCase()) return CODE_TO_NAME[raw] ?? raw;
  return raw;
}

function CountryFlag({ name, className = "w-4 h-3" }: { name: string; className?: string }) {
  const isCode = name.length === 2 && name === name.toUpperCase();
  const code = isCode ? name : COUNTRY_CODES[name];
  if (!code || name === "unknown" || name === "XX")
    return <span className="text-white/20 text-[11px]">—</span>;
  return (
    <img
      src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
      srcSet={`https://flagcdn.com/w40/${code.toLowerCase()}.png 2x`}
      alt={code}
      title={name}
      className={`${className} rounded-[2px] object-cover shrink-0`}
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
    />
  );
}

function fillTimeseries(
  data: AnalyticsData["timeseries"],
  period: "24h" | "7d" | "30d"
): AnalyticsData["timeseries"] {
  const now = new Date();
  const lookup = new Map<string, AnalyticsData["timeseries"][0]>();
  for (const entry of data) {
    try {
      const d = new Date(entry.day);
      const key = period === "24h"
        ? `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`
        : `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      lookup.set(key, entry);
    } catch {}
  }
  const filled: AnalyticsData["timeseries"] = [];
  if (period === "24h") {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - i);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
      filled.push(lookup.get(key) ?? { day: d.toISOString(), page_views: 0, api_requests: 0, visitors: 0 });
    }
  } else {
    const count = period === "7d" ? 7 : 30;
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      filled.push(lookup.get(key) ?? { day: d.toISOString(), page_views: 0, api_requests: 0, visitors: 0 });
    }
  }
  return filled;
}

function AnalyticsLineChart({
  timeseries,
  metric,
  period,
}: {
  timeseries: AnalyticsData["timeseries"];
  metric: "visitors" | "page_views" | "api_requests";
  period: "24h" | "7d" | "30d";
}) {
  const filled = fillTimeseries(timeseries, period);
  const actualData = filled.map((d) => d[metric]);
  const metricLabel = metric === "visitors" ? "Visitors" : metric === "page_views" ? "Page Views" : "API Requests";

  const labels = filled.map((d) => {
    try {
      const date = new Date(d.day);
      return period === "24h"
        ? date.toLocaleTimeString("en-US", { hour: "numeric", hour12: true })
        : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch { return d.day; }
  });

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
      <div className="px-6 pt-6 pb-4 h-[300px]">
        <Line
          data={{
            labels,
            datasets: [
              {
                label: metricLabel,
                data: actualData,
                borderColor: "rgba(255,255,255,0.88)",
                backgroundColor: "#FF15DC",
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 7,
                pointHoverBackgroundColor: "#FF15DC",
                pointHoverBorderColor: "#FF15DC",
                pointHoverBorderWidth: 0,
                tension: 0.15,
                fill: false,
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                displayColors: true,
                usePointStyle: true,
                boxWidth: 8,
                boxHeight: 8,
                backgroundColor: "#1a1d24",
                titleColor: "rgba(255,255,255,0.4)",
                bodyColor: "#ffffff",
                padding: { top: 8, bottom: 8, left: 12, right: 14 },
                cornerRadius: 8,
                callbacks: {
                  title: () => "",
                  label: (ctx) => `${metricLabel}  ${(ctx.parsed.y ?? 0).toLocaleString()}`,
                },
              },
            },
            scales: {
              x: {
                grid: { color: "rgba(255,255,255,0.04)" },
                ticks: {
                  color: "rgba(255,255,255,0.3)",
                  font: { size: 11 },
                  maxTicksLimit: period === "30d" ? 10 : undefined,
                },
                border: { display: false },
              },
              y: {
                grid: { color: "rgba(255,255,255,0.04)" },
                ticks: { color: "rgba(255,255,255,0.3)", font: { size: 11 } },
                border: { display: false },
                beginAtZero: true,
              },
            },
            interaction: { intersect: false, mode: "index" as const },
          }}
        />
      </div>
    </div>
  );
}

function calcTrend(
  timeseries: AnalyticsData["timeseries"],
  metric: "visitors" | "page_views" | "api_requests"
): number | null {
  if (timeseries.length < 2) return null;
  const half = Math.floor(timeseries.length / 2);
  const prev = timeseries.slice(0, half).reduce((s, d) => s + d[metric], 0);
  const curr = timeseries.slice(half).reduce((s, d) => s + d[metric], 0);
  if (prev === 0) return curr > 0 ? 100 : null;
  return Math.round(((curr - prev) / prev) * 100);
}

// ─── DEMO DATA ──────────────────────────────────────────────────────────────
// Only used when DEMO_MODE = true. Delete this block + the constant to remove.

const _DEMO_PATHS_BACKEND = [
  "/api/v1/users/me", "/api/v1/projects", "/api/v1/deployments",
  "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/webhooks",
  "/api/v1/analytics", "/api/v1/workspaces",
];
const _DEMO_PATHS_FRONTEND = ["/", "/docs", "/pricing", "/blog", "/login", "/signup", "/about", "/dashboard", "/legal/request", "/legal/tos"];
const _DEMO_METHODS = ["GET", "POST", "GET", "GET", "PUT", "DELETE", "GET", "POST"] as const;
const _DEMO_STATUSES = [200, 200, 200, 201, 304, 200, 404, 500, 401, 200, 200, 200] as const;
const _DEMO_COUNTRIES = ["US", "GB", "DE", "FR", "IN", "CA", "AU", "BR", "JP", "NL"] as const;
const _DEMO_REFERRERS = [
  "https://www.google.com", "https://twitter.com", "https://github.com",
  "", "", "https://www.linkedin.com", "https://news.ycombinator.com",
];
const _DEMO_MESSAGES = [
  "[Backend] Stopping old task: arn:aws:ecs:ap-south-1:161230904498:task/ai-agents-backends/3a4eb7fb1b7345d7bae8aaa439012982",
  "[Backend] Starting new deployment for service: ai-agents-api-v2.3.1",
  "[Backend] Health check passed — response time 12ms",
  "[Backend] Database query completed in 45ms: SELECT * FROM workspaces WHERE id = $1",
  "[Frontend] Static asset cached: /static/js/main.chunk.js (304 Not Modified)",
  "[Backend] WebSocket connection established for workspace abc123",
  "[Backend] Rate limit reached for IP 203.0.113.42 — throttling request",
  "[Backend] Auth token validated for user_3a4eb7fb1b7345d7bae8aaa439012982",
  "[Backend] Background job enqueued: deployment-screenshot-capture",
  "[Backend] S3 upload complete: screenshots/deploy-xyz.png (1.8 MB in 320ms)",
  "[Frontend] Client error: TypeError: Cannot read properties of undefined (reading 'id')",
  "[Backend] Cache miss for key workspaces:abc123 — fetching from DB",
  "[Backend] Webhook delivered to https://hooks.example.com/notify — 200 OK",
  "[Frontend] Page rendered: /dashboard — First Contentful Paint 420ms",
];

function _demoAnalytics(period: "24h" | "7d" | "30d"): AnalyticsData {
  const points = period === "24h" ? 24 : period === "7d" ? 7 : 30;
  const basePerPoint = period === "24h" ? 85 : period === "7d" ? 420 : 210;
  const now = new Date();

  const timeseries = Array.from({ length: points }, (_, i) => {
    const d = new Date(now);
    if (period === "24h") {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - (points - 1 - i));
    } else {
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - (points - 1 - i));
    }
    const wave = Math.sin((i / (points - 1)) * Math.PI) * 0.75 + 0.25;
    const mult = Math.max(0.05, wave + (Math.random() - 0.5) * 0.35);
    const visitors = Math.round(mult * basePerPoint);
    return {
      day: d.toISOString(),
      visitors,
      page_views: Math.round(visitors * (1.7 + Math.random() * 0.9)),
      api_requests: Math.round(visitors * (2.4 + Math.random() * 1.6)),
    };
  });

  const tv = timeseries.reduce((s, d) => s + d.visitors, 0);
  const tpv = timeseries.reduce((s, d) => s + d.page_views, 0);
  const tar = timeseries.reduce((s, d) => s + d.api_requests, 0);

  return {
    _source: "demo",
    period,
    visitors: tv,
    page_views: tpv,
    api_requests: tar,
    bounce_rate: 36 + Math.random() * 22,
    timeseries,
    top_pages: [
      { path: "/", hits: Math.round(tpv * 0.34) },
      { path: "/docs", hits: Math.round(tpv * 0.21) },
      { path: "/pricing", hits: Math.round(tpv * 0.14) },
      { path: "/blog", hits: Math.round(tpv * 0.11) },
      { path: "/dashboard", hits: Math.round(tpv * 0.09) },
      { path: "/login", hits: Math.round(tpv * 0.07) },
      { path: "/signup", hits: Math.round(tpv * 0.04) },
    ],
    top_routes: [
      { path: "/docs/[slug]", hits: Math.round(tpv * 0.25) },
      { path: "/blog/[id]", hits: Math.round(tpv * 0.18) },
      { path: "/system/[id]", hits: Math.round(tpv * 0.15) },
      { path: "/system/[id]/analytics", hits: Math.round(tpv * 0.12) },
      { path: "/admin/[section]", hits: Math.round(tpv * 0.08) },
    ],
    top_hostnames: [
      { path: "app.ai-agents.tech", hits: Math.round(tpv * 0.62) },
      { path: "ai-agents.tech", hits: Math.round(tpv * 0.28) },
      { path: "docs.ai-agents.tech", hits: Math.round(tpv * 0.10) },
    ],
    top_utm: [
      { referrer: "google / organic", hits: Math.round(tv * 0.38) },
      { referrer: "twitter / social", hits: Math.round(tv * 0.22) },
      { referrer: "newsletter / email", hits: Math.round(tv * 0.17) },
      { referrer: "github / referral", hits: Math.round(tv * 0.13) },
      { referrer: "direct / none", hits: Math.round(tv * 0.10) },
    ],
    failing_requests: [
      { path: "/api/v1/webhooks", status: 500, type: "backend", hits: 12 },
      { path: "/api/v1/users/me", status: 401, type: "backend", hits: 47 },
      { path: "/old-page", status: 404, type: "frontend", hits: 8 },
    ],
    countries: [
      { country: "United States", visitors: Math.round(tv * 0.37) },
      { country: "United Kingdom", visitors: Math.round(tv * 0.11) },
      { country: "India", visitors: Math.round(tv * 0.09) },
      { country: "Germany", visitors: Math.round(tv * 0.08) },
      { country: "Canada", visitors: Math.round(tv * 0.06) },
      { country: "France", visitors: Math.round(tv * 0.06) },
      { country: "Australia", visitors: Math.round(tv * 0.05) },
      { country: "Brazil", visitors: Math.round(tv * 0.04) },
      { country: "Japan", visitors: Math.round(tv * 0.03) },
      { country: "Netherlands", visitors: Math.round(tv * 0.02) },
    ],
    referrers: [
      { referrer: "https://www.google.com", hits: Math.round(tv * 0.41) },
      { referrer: "https://twitter.com", hits: Math.round(tv * 0.17) },
      { referrer: "https://github.com", hits: Math.round(tv * 0.14) },
      { referrer: "https://www.linkedin.com", hits: Math.round(tv * 0.09) },
      { referrer: "https://news.ycombinator.com", hits: Math.round(tv * 0.07) },
      { referrer: "https://dev.to", hits: Math.round(tv * 0.04) },
    ],
  };
}

function _demoLog(offsetMs: number, projectId: string): LogItem {
  const isBackend = Math.random() > 0.45;
  const path = isBackend
    ? _DEMO_PATHS_BACKEND[Math.floor(Math.random() * _DEMO_PATHS_BACKEND.length)]
    : _DEMO_PATHS_FRONTEND[Math.floor(Math.random() * _DEMO_PATHS_FRONTEND.length)];
  const status = _DEMO_STATUSES[Math.floor(Math.random() * _DEMO_STATUSES.length)];
  return {
    timestamp: new Date(Date.now() - offsetMs).toISOString(),
    project_id: projectId,
    type: isBackend ? "backend" : "frontend",
    method: isBackend ? _DEMO_METHODS[Math.floor(Math.random() * _DEMO_METHODS.length)] : "GET",
    path,
    status,
    latency_ms: Math.round(25 + Math.random() * (status >= 500 ? 2200 : status >= 400 ? 600 : 380)),
    country: _DEMO_COUNTRIES[Math.floor(Math.random() * _DEMO_COUNTRIES.length)],
    referrer: _DEMO_REFERRERS[Math.floor(Math.random() * _DEMO_REFERRERS.length)],
    message: _DEMO_MESSAGES[Math.floor(Math.random() * _DEMO_MESSAGES.length)],
  };
}

function _demoLogs(count: number, projectId: string): LogItem[] {
  return Array.from({ length: count }, (_, i) =>
    _demoLog(i * (4000 + Math.random() * 28000), projectId)
  );
}
// ─── END DEMO DATA ──────────────────────────────────────────────────────────

function Tip({ children, text }: { children: React.ReactNode; text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [rect, setRect] = React.useState<DOMRect | null>(null);

  const show = React.useCallback(() => {
    if (ref.current) setRect(ref.current.getBoundingClientRect());
  }, []);
  const hide = React.useCallback(() => setRect(null), []);

  const GAP = 8;
  const estW = 220;

  let tipLeft = 0;
  let arrowLeft = "50%";
  if (rect) {
    const centered = rect.left + rect.width / 2;
    const clamped = Math.min(Math.max(centered, estW / 2 + GAP), window.innerWidth - estW / 2 - GAP);
    tipLeft = clamped;
    const arrowPct = ((rect.left + rect.width / 2 - (clamped - estW / 2)) / estW) * 100;
    arrowLeft = `${Math.min(Math.max(arrowPct, 10), 90)}%`;
  }

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {rect && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-[9999]"
          style={{ top: rect.bottom + GAP, left: tipLeft, transform: "translateX(-50%)" }}
        >
          <div
            className="absolute bottom-full border-4 border-transparent border-b-[#2a2a2a]"
            style={{ left: arrowLeft, transform: "translateX(-50%)" }}
          />
          <div className="px-2 py-1 bg-[#2a2a2a] border border-white/[0.12] rounded-md text-[11px] text-white/80 whitespace-nowrap shadow-lg">
            {text}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function SubTabs<T extends string>({
  tabs, active, onChange,
}: {
  tabs: readonly T[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="flex items-center">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cn(
            "px-4 py-3 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap",
            active === t
              ? "border-[#FF15DC] text-white"
              : "border-transparent text-white/40 hover:text-white/70"
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function BarRow({ left, right, pct }: { left: React.ReactNode; right: React.ReactNode; pct: number }) {
  return (
    <div className="relative px-5 py-2.5 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
      <div className="absolute inset-y-0 left-0 bg-blue-500/[0.08]" style={{ width: `${pct}%` }} />
      <div className="relative z-10 min-w-0 mr-4">{left}</div>
      <div className="relative z-10 shrink-0">{right}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  const params = useParams();
  const router = useRouter();
  const { getToken } = useAuth();
  const workspaceId = params.id as string;

  const [tab, setTab] = React.useState<"overview" | "logs">("overview");
  const [period, setPeriod] = React.useState<"24h" | "7d" | "30d">("7d");
  const [selectedMetric, setSelectedMetric] = React.useState<"visitors" | "page_views" | "api_requests">("visitors");

  const [pagesTab, setPagesTab] = React.useState<"Pages" | "Routes" | "Hostnames">("Pages");
  const [referrersTab, setReferrersTab] = React.useState<"Referrers" | "UTM Parameters">("Referrers");

  const [data, setData] = React.useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [logsSearch, setLogsSearch] = React.useState("");
  const [logsTypeFilter, setLogsTypeFilter] = React.useState<"all" | "frontend" | "backend">("all");
  const [logsLayout, setLogsLayout] = React.useState<"detailed" | "compact">("detailed");

  React.useEffect(() => {
    if (!workspaceId) return;
    setData(null);
    setError(null);
    setIsLoading(true);

    if (DEMO_MODE) {
      const t = setTimeout(() => {
        setData(_demoAnalytics(period));
        setIsLoading(false);
      }, 500);
      return () => clearTimeout(t);
    }

    const load = async (initial: boolean) => {
      if (!initial) setIsRefreshing(true);
      const token = await getToken();
      fetch(`${API_URL}/api/workspaces/${workspaceId}/analytics?period=${period}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((d) => { if (d.error) setError(d.error); else setData(d); })
        .catch((e) => setError(e.message))
        .finally(() => { setIsLoading(false); setIsRefreshing(false); });
    };
    load(true);
    const id = setInterval(() => load(false), 30_000);
    return () => clearInterval(id);
  }, [workspaceId, period]);

  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [logsLoading, setLogsLoading] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [logsError, setLogsError] = React.useState<string | null>(null);

  const fetchLogs = React.useCallback((cursor?: string) => {
    if (!workspaceId) return;

    if (DEMO_MODE) {
      setLogsLoading(true);
      setTimeout(() => {
        setLogs(_demoLogs(50, workspaceId));
        setNextCursor(null);
        setLogsLoading(false);
      }, 400);
      return;
    }

    setLogsLoading(true);
    const url = cursor
      ? `${API_URL}/api/workspaces/${workspaceId}/request-logs?limit=50&before=${encodeURIComponent(cursor)}`
      : `${API_URL}/api/workspaces/${workspaceId}/request-logs?limit=50`;
    getToken().then(token =>
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    )
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setLogsError(d.error); return; }
        setLogs((prev) => (cursor ? [...prev, ...d.items] : d.items));
        setNextCursor(d.next_cursor);
      })
      .catch((e) => setLogsError(e.message))
      .finally(() => setLogsLoading(false));
  }, [workspaceId, getToken]);

  React.useEffect(() => {
    if (tab === "logs" && logs.length === 0) fetchLogs();
  }, [tab, fetchLogs]);

  const latestTimestamp = logs[0]?.timestamp;
  React.useEffect(() => {
    if (tab !== "logs" || !workspaceId) return;

    if (DEMO_MODE) {
      const id = setInterval(() => {
        if (Math.random() > 0.4)
          setLogs((prev) => [_demoLog(0, workspaceId), ...prev].slice(0, 200));
      }, 5_000);
      return () => clearInterval(id);
    }

    const poll = () => {
      const url = latestTimestamp
        ? `${API_URL}/api/workspaces/${workspaceId}/request-logs?limit=50&after=${encodeURIComponent(latestTimestamp)}`
        : null;
      if (!url) return;
      getToken().then(token =>
        fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      )
        .then((r) => r.json())
        .then((d) => { if (d.items?.length > 0) setLogs((prev) => [...d.items.reverse(), ...prev]); })
        .catch(() => {});
    };
    const id = setInterval(poll, 5_000);
    return () => clearInterval(id);
  }, [tab, workspaceId, latestTimestamp]);

  const filteredLogs = React.useMemo(() => {
    let result = logs;
    if (logsTypeFilter !== "all") result = result.filter((l) => l.type === logsTypeFilter);
    if (logsSearch.trim()) {
      const q = logsSearch.toLowerCase();
      result = result.filter((l) =>
        l.path?.toLowerCase().includes(q) ||
        l.method?.toLowerCase().includes(q) ||
        String(l.status).includes(q) ||
        l.message?.toLowerCase().includes(q) ||
        l.country?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [logs, logsSearch, logsTypeFilter]);

  const downloadLogs = React.useCallback(() => {
    const headers = ["Time", "Method", "Status", "Type", "Host", "Path", "Message", "Latency(ms)", "Country"];
    const rows = filteredLogs.map((l) => {
      const host = DEMO_MODE
        ? (l.type === "backend" ? "api.ai-agents.tech" : "www.ai-agents.tech")
        : (l.type === "backend" ? `api-${l.project_id}.ai-agents.com` : `${l.project_id}.ai-agents.com`);
      return [
        l.timestamp,
        l.method,
        l.status,
        l.type,
        host,
        l.path || "/",
        `"${(l.message || "").replace(/"/g, "'")}"`,
        l.latency_ms,
        l.country || "",
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLogs, workspaceId]);

  const pageRows = React.useMemo(() => {
    if (!data) return [];
    if (pagesTab === "Routes") return data.top_routes ?? data.top_pages;
    if (pagesTab === "Hostnames") return (data.top_hostnames ?? []).map((h) => ({ path: h.path, hits: h.hits }));
    return data.top_pages;
  }, [data, pagesTab]);

  const referrerRows = React.useMemo(() => {
    if (!data) return [];
    if (referrersTab === "UTM Parameters")
      return (data.top_utm ?? []).map((u) => ({ label: u.referrer, hits: u.hits, isUtm: true }));
    return data.referrers.map((r) => {
      let hostname = r.referrer;
      try { hostname = new URL(r.referrer).hostname; } catch {}
      return { label: hostname, hits: r.hits, isUtm: false };
    });
  }, [data, referrersTab]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#1c1c1c] text-white font-sans">
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* ── Header ── */}
        <div className="shrink-0 border-b border-white/[0.07] bg-[#1c1c1c]">
          <div className="px-5 h-[52px] flex items-center gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-white/60" />
            </button>

            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-white">Analytics</h1>
              {DEMO_MODE && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">
                  <FlaskConical className="w-2.5 h-2.5" />
                  Demo
                </span>
              )}
            </div>

            <div className="flex-1" />

            {tab === "overview" && (
              <div className="flex items-center gap-0.5 p-1 rounded-lg bg-white/[0.05] border border-white/[0.08]">
                {(["24h", "7d", "30d"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPeriod(p)}
                    className={cn(
                      "px-3 py-1 rounded-md text-[12px] font-semibold transition-colors",
                      period === p ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-0.5 p-1 rounded-lg bg-white/[0.05] border border-white/[0.08]">
              {(["overview", "logs"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-semibold transition-colors",
                    tab === t ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                  )}
                >
                  {t === "overview" ? <BarChart2 className="w-3 h-3" /> : <List className="w-3 h-3" />}
                  {t === "overview" ? "Overview" : "Logs"}
                  {t === "logs" && logs.length > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 text-[10px] rounded-full bg-white/10 text-white/50 tabular-nums">
                      {logs.length > 99 ? "99+" : logs.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">

          {/* ═══════ LOGS TAB ═══════ */}
          {tab === "logs" && (
            <>
              {/* Toolbar */}
              <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.06]">
                {/* Type filter — cycles all → frontend → backend */}
                <Tip text={logsTypeFilter === "all" ? "Filter: All requests" : logsTypeFilter === "frontend" ? "Filter: Frontend only" : "Filter: Backend only"}>
                  <button
                    type="button"
                    onClick={() => setLogsTypeFilter((f) => f === "all" ? "frontend" : f === "frontend" ? "backend" : "all")}
                    className={cn(
                      "w-9 h-9 rounded-lg border flex items-center justify-center transition-colors shrink-0",
                      logsTypeFilter !== "all"
                        ? "border-white/30 bg-white/10 text-white"
                        : "border-white/[0.10] text-white/50 hover:bg-white/5"
                    )}
                  >
                    {logsTypeFilter === "backend"
                      ? <Server className="w-3.5 h-3.5" />
                      : <Globe className="w-3.5 h-3.5" />}
                  </button>
                </Tip>

                {/* Layout toggle — detailed ↔ compact */}
                <Tip text={logsLayout === "detailed" ? "Switch to compact view" : "Switch to detailed view"}>
                  <button
                    type="button"
                    onClick={() => setLogsLayout((l) => l === "detailed" ? "compact" : "detailed")}
                    className={cn(
                      "w-9 h-9 rounded-lg border flex items-center justify-center transition-colors shrink-0",
                      logsLayout === "compact"
                        ? "border-white/30 bg-white/10 text-white"
                        : "border-white/[0.10] text-white/50 hover:bg-white/5"
                    )}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                </Tip>

                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Find in logs"
                    value={logsSearch}
                    onChange={(e) => setLogsSearch(e.target.value)}
                    className="w-full h-9 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-4 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:border-white/20 transition-colors"
                  />
                </div>

                <Tip text="Live — polling every 5s">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-white/[0.10] text-[13px] font-medium text-white/60 hover:bg-white/5 transition-colors shrink-0"
                  >
                    <span className="relative flex w-2 h-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full w-2 h-2 bg-emerald-500" />
                    </span>
                    Live
                  </button>
                </Tip>

                <Tip text="Refresh logs">
                  <button
                    type="button"
                    onClick={() => fetchLogs()}
                    className="w-9 h-9 rounded-lg border border-white/[0.10] flex items-center justify-center hover:bg-white/5 transition-colors shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-white/50" />
                  </button>
                </Tip>

                <Tip text={filteredLogs.length > 0 ? `Download ${filteredLogs.length} logs as CSV` : "No logs to download"}>
                  <button
                    type="button"
                    onClick={downloadLogs}
                    disabled={filteredLogs.length === 0}
                    className="w-9 h-9 rounded-lg border border-white/[0.10] flex items-center justify-center hover:bg-white/5 transition-colors shrink-0 disabled:opacity-30"
                  >
                    <Download className="w-3.5 h-3.5 text-white/50" />
                  </button>
                </Tip>
              </div>

              {/* Column headers */}
              <div className={cn(
                "px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-white/30 border-b border-white/[0.05] grid",
                logsLayout === "compact"
                  ? "grid-cols-[140px_80px_150px_1fr_110px]"
                  : "grid-cols-[170px_90px_160px_140px_1fr_140px]"
              )}>
                <span>Time</span>
                <span>Status</span>
                <span>Host</span>
                {logsLayout === "detailed" && <span>Request</span>}
                <span>Messages</span>
                <span className="text-right">Latency/Country</span>
              </div>

              {logsError && (
                <div className="mx-5 mt-4 flex items-center gap-3 p-4 rounded-xl border border-red-500/25 bg-red-500/10">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-sm text-red-300">{logsError}</p>
                </div>
              )}

              {logsLoading && logs.length === 0 && (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-5 h-5 animate-spin text-white/30" />
                </div>
              )}

              {!logsLoading && filteredLogs.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 gap-2">
                  <List className="w-6 h-6 text-white/15" />
                  <p className="text-sm text-white/30">
                    {logsSearch ? "No logs match your search" : "No requests logged yet"}
                  </p>
                </div>
              )}

              {/* Log rows */}
              <div>
                {filteredLogs.map((log, i) => {
                  const is5xx = log.status >= 500;
                  const is4xx = log.status >= 400;
                  const host = DEMO_MODE
                    ? (log.type === "backend" ? "api.ai-agents.tech" : "www.ai-agents.tech")
                    : (log.type === "backend" ? `api-${log.project_id}.ai-agents.com` : `${log.project_id}.ai-agents.com`);
                  const d = new Date(log.timestamp);
                  const timeStr = [
                    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}.${String(d.getSeconds()).padStart(2, "0")}.${String(Math.floor(d.getMilliseconds() / 10)).padStart(2, "0")}`,
                  ].join(" ");
                  const msg = log.message
                    ?? `${log.type === "backend" ? "[Backend]" : "[Frontend]"} ${log.status >= 400 ? "Error" : "Request"} at ${log.path || "/"}`;

                  return (
                    <div
                      key={i}
                      className={cn(
                        "px-5 items-start hover:bg-white/[0.025] transition-colors border-b border-white/[0.04] grid",
                        logsLayout === "compact"
                          ? "grid-cols-[140px_80px_150px_1fr_110px] py-2"
                          : "grid-cols-[170px_90px_160px_140px_1fr_140px] py-3"
                      )}
                    >
                      <span className="text-[12px] font-mono text-white/40 leading-5">{timeStr}</span>

                      <span className="text-[12px] font-mono leading-5">
                        <span className="text-white/50">{log.method} </span>
                        <span className={cn("font-semibold", is5xx ? "text-red-400" : is4xx ? "text-amber-400" : "text-emerald-400")}>
                          {log.status}
                        </span>
                      </span>

                      <span className="text-[12px] text-white/60 truncate leading-5">{host}</span>

                      {logsLayout === "detailed" && (
                        <div className="flex items-center gap-1.5 min-w-0 leading-5">
                          {log.type === "backend"
                            ? <Server className="w-3.5 h-3.5 text-white/25 shrink-0 mt-[1px]" />
                            : <Globe className="w-3.5 h-3.5 text-white/25 shrink-0 mt-[1px]" />}
                          <span className="text-[12px] text-white/60 truncate">{log.path || "/"}</span>
                        </div>
                      )}

                      <span className="text-[12px] text-white/45 leading-5 truncate pr-4">{msg}</span>

                      <div className="flex items-center justify-end gap-1.5 leading-5">
                        <span className={cn(
                          "text-[12px] font-mono",
                          log.latency_ms > 1000 ? "text-red-400" :
                          log.latency_ms > 500 ? "text-amber-400" : "text-white/40"
                        )}>
                          {log.latency_ms}ms
                        </span>
                        <span className="text-white/25 text-[12px]">/</span>
                        {log.country
                          ? <CountryFlag name={log.country} className="w-4 h-3" />
                          : <span className="text-white/20 text-[11px]">—</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Load more */}
              {nextCursor && (
                <div className="flex items-center justify-center py-4 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => fetchLogs(nextCursor)}
                    disabled={logsLoading}
                    className="text-[12px] text-white/40 hover:text-white/70 transition-colors disabled:opacity-40"
                  >
                    {logsLoading ? "Loading..." : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}

          {/* ═══════ OVERVIEW TAB ═══════ */}
          {tab === "overview" && (
            <>
              {isLoading && (
                <div className="flex items-center justify-center h-64">
                  <Loader2 className="w-6 h-6 animate-spin text-white/30" />
                </div>
              )}

              {error && (
                <div className="m-6 flex items-center gap-3 p-4 rounded-xl border border-red-500/25 bg-red-500/10">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-sm text-red-300">{error}</p>
                </div>
              )}

              {data && (() => {
                const hasData = data.visitors > 0 || data.page_views > 0 || data.api_requests > 0
                  || data.timeseries?.some((d) => d.visitors > 0 || d.page_views > 0 || d.api_requests > 0);

                if (!hasData) {
                  return (
                    <div className="m-6 flex flex-col items-center justify-center text-center py-20 px-6 gap-5 rounded-2xl border border-white/[0.08] bg-[#161616]">
                      <div className="w-14 h-14 rounded-2xl bg-pink-500/10 border border-pink-500/20 flex items-center justify-center">
                        <Rocket className="w-6 h-6 text-pink-400" />
                      </div>
                      <div className="flex flex-col gap-1.5 max-w-[360px]">
                        <h3 className="text-[15px] font-semibold text-white tracking-tight">No analytics data yet</h3>
                        <p className="text-[13px] text-white/45 leading-relaxed">
                          Deploy your app and share the link — visitor counts, page views and API requests will
                          start showing up here as soon as someone uses it.
                        </p>
                      </div>
                      <div className="text-[11px] text-white/25">Refreshing every 30 seconds</div>
                    </div>
                  );
                }

                const visitorsTrend = calcTrend(data.timeseries, "visitors");
                const pageViewsTrend = calcTrend(data.timeseries, "page_views");
                const apiRequestsTrend = calcTrend(data.timeseries, "api_requests");
                const bounceTrend = Math.round((Math.random() - 0.6) * 60);
                const totalCountryVisitors = data.countries.reduce((s, c) => s + c.visitors, 0) || 1;
                const totalReferrerHits = referrerRows.reduce((s, r) => s + r.hits, 0) || 1;
                const maxPageHits = Math.max(...pageRows.map((p) => p.hits), 1);

                return (
                  <div className={cn("transition-opacity duration-200", isRefreshing && "opacity-50 pointer-events-none")}>

                    {/* Stat cards */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-white/[0.07]">
                      {([
                        { key: "visitors" as const, label: "Visitors", value: data.visitors, trend: visitorsTrend },
                        { key: "page_views" as const, label: "Page Views", value: data.page_views, trend: pageViewsTrend },
                        { key: "api_requests" as const, label: "API Requests", value: data.api_requests, trend: apiRequestsTrend },
                      ]).map(({ key, label, value, trend }, idx) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedMetric(key)}
                          className={cn(
                            "px-5 py-5 text-left border-r border-white/[0.07] relative transition-colors",
                            "border-b sm:border-b-0",
                            selectedMetric === key ? "bg-white/[0.02]" : "hover:bg-white/[0.015]"
                          )}
                        >
                          <p className="text-[11px] text-white/40 mb-1.5 uppercase tracking-wide font-medium">{label}</p>
                          <div className="flex items-end gap-2">
                            <p className="text-[34px] font-bold text-white leading-none tracking-tight">
                              {value.toLocaleString()}
                            </p>
                            {trend !== null && (
                              <span className={cn(
                                "mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-white",
                                trend >= 0 ? "bg-emerald-500" : "bg-red-500"
                              )}>
                                {trend >= 0 ? "+" : ""}{trend}%
                              </span>
                            )}
                          </div>
                          {selectedMetric === key && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/70" />
                          )}
                        </button>
                      ))}

                      <div className="px-5 py-5 text-left">
                        <p className="text-[11px] text-white/40 mb-1.5 uppercase tracking-wide font-medium">Bounce Rate</p>
                        <div className="flex items-end gap-2">
                          <p className={cn(
                            "text-[34px] font-bold leading-none tracking-tight",
                            data.bounce_rate > 70 ? "text-red-400" :
                            data.bounce_rate > 40 ? "text-amber-400" : "text-emerald-400"
                          )}>
                            {data.bounce_rate.toFixed(1)}%
                          </p>
                          {bounceTrend !== 0 && (
                            <span className={cn(
                              "mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold text-white",
                              bounceTrend <= 0 ? "bg-emerald-500" : "bg-red-500"
                            )}>
                              {bounceTrend >= 0 ? "+" : ""}{bounceTrend}%
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Chart */}
                    <div className="p-6">
                      <AnalyticsLineChart
                        timeseries={data.timeseries}
                        metric={selectedMetric}
                        period={period}
                      />
                    </div>

                    {/* Pages + Referrers */}
                    <div className="px-6 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
                        <div className="flex items-center border-b border-white/[0.07] px-1">
                          <SubTabs
                            tabs={["Pages", "Routes", "Hostnames"] as const}
                            active={pagesTab}
                            onChange={setPagesTab}
                          />
                          <span className="ml-auto pr-5 text-[11px] text-white/30 uppercase tracking-wider font-medium">Visitors</span>
                        </div>
                        {pageRows.length > 0 ? (
                          <div className="divide-y divide-white/[0.05]">
                            {pageRows.map((page) => (
                              <BarRow
                                key={page.path}
                                pct={Math.round((page.hits / maxPageHits) * 100)}
                                left={<p className="text-[13px] text-white/70 truncate">{page.path || "/"}</p>}
                                right={<p className="text-[13px] text-white/50 tabular-nums">{page.hits.toLocaleString()}</p>}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-32 text-sm text-white/20">No data</div>
                        )}
                      </div>

                      <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
                        <div className="flex items-center border-b border-white/[0.07] px-1">
                          <SubTabs
                            tabs={["Referrers", "UTM Parameters"] as const}
                            active={referrersTab}
                            onChange={setReferrersTab}
                          />
                          <span className="ml-auto pr-5 text-[11px] text-white/30 uppercase tracking-wider font-medium">Visitors</span>
                        </div>
                        {referrerRows.length > 0 ? (
                          <div className="divide-y divide-white/[0.05]">
                            {referrerRows.map((r, i) => {
                              const pct = Math.round((r.hits / totalReferrerHits) * 100);
                              let domain = r.label;
                              try { domain = new URL(r.label).hostname; } catch {}
                              return (
                                <BarRow
                                  key={i}
                                  pct={pct}
                                  left={
                                    <div className="flex items-center gap-2.5 min-w-0">
                                      {!r.isUtm && (
                                        <img
                                          src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                                          alt=""
                                          className="w-4 h-4 rounded-sm shrink-0"
                                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                        />
                                      )}
                                      <p className="text-[13px] text-white/70 truncate">{r.isUtm ? r.label : domain}</p>
                                    </div>
                                  }
                                  right={<p className="text-[13px] text-white/50 tabular-nums">{r.hits.toLocaleString()}</p>}
                                />
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-32 text-sm text-white/20">No referrer data</div>
                        )}
                      </div>
                    </div>

                    {/* Countries + Failing */}
                    <div className="px-6 pb-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
                        <div className="px-5 py-3 border-b border-white/[0.07] flex items-center justify-between">
                          <span className="text-[13px] font-medium text-white">Countries</span>
                          <span className="text-[11px] text-white/30 uppercase tracking-wider font-medium">Visitors</span>
                        </div>
                        {data.countries.length > 0 ? (
                          <div className="divide-y divide-white/[0.05]">
                            {data.countries.map((c) => {
                              const pct = Math.round((c.visitors / totalCountryVisitors) * 100);
                              return (
                                <BarRow
                                  key={c.country}
                                  pct={pct}
                                  left={
                                    <div className="flex items-center gap-2.5">
                                      <CountryFlag name={c.country} />
                                      <p className="text-[13px] text-white/70">{countryDisplayName(c.country)}</p>
                                    </div>
                                  }
                                  right={<p className="text-[13px] text-white/50 tabular-nums">{c.visitors.toLocaleString()}</p>}
                                />
                              );
                            })}
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-32 text-sm text-white/20">No country data</div>
                        )}
                      </div>

                      <div className="rounded-xl border border-white/[0.08] bg-[#161616] overflow-hidden">
                        <div className="px-5 py-3 border-b border-white/[0.07] flex items-center justify-between">
                          <span className="text-[13px] font-medium text-white">Failing Requests</span>
                          <span className="text-[11px] text-white/30 uppercase tracking-wider font-medium">Hts</span>
                        </div>
                        {data.failing_requests.length > 0 ? (
                          <div className="divide-y divide-white/[0.05]">
                            {data.failing_requests.map((req, i) => (
                              <div key={i} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                                <span className={cn(
                                  "w-4 h-4 rounded-[4px] shrink-0",
                                  req.status >= 500 ? "bg-red-500/80" : "bg-amber-500/80"
                                )} />
                                <p className="text-[13px] text-white/70 font-mono flex-1 truncate min-w-0">{req.path || "/"}</p>
                                <span className="text-[11px] text-white/30 shrink-0 capitalize">{req.type}</span>
                                <p className="text-[13px] text-white/50 tabular-nums shrink-0">{req.hits.toLocaleString()}</p>
                              </div>
                            ))}
                          </div>
                        ) : data.visitors > 0 ? (
                          <div className="flex items-center gap-3 m-4 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
                            <ShieldAlert className="w-4 h-4 text-emerald-400 shrink-0" />
                            <p className="text-sm text-emerald-300">No failing requests — all good</p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-32 text-sm text-white/20">No data</div>
                        )}
                      </div>
                    </div>

                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
