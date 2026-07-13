"use client";

import * as React from "react";
import { useAuth } from "@/lib/auth-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock, AlertCircle, Folder, ChevronRight,
  Copy, Check, Code2, ChevronDown, GitCommit, Loader, RefreshCw, X, GitBranch, ExternalLink,
} from "lucide-react";

import { useUser } from "@/lib/auth-client";
import { getMaterialFileIcon, getMaterialFolderIcon } from "file-extension-icon-js";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Commit {
  sha: string;
  message: string;
  author_name?: string;
  author_email?: string;
  timestamp: number | string;
  parents?: string[];
  githubSha?: string | null;
}

interface FileNode {
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  isOpen?: boolean;
}

interface DiffEntry {
  path: string;
  patch: string;
  added?: number;
  removed?: number;
}

interface DiffStats { added: number; removed: number }
interface CommitStatsMap { [sha: string]: DiffStats }

interface HistoryTabProps {
  workspaceName: string;
  workspaceId?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(ts: number | string): string {
  const date = typeof ts === "string" ? new Date(ts) : new Date(ts * 1000);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

function shortSha(sha: string): string { return sha.slice(0, 7); }

function isTextFile(path: string): boolean {
  const filename = path.split("/").pop() || "";
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() || "" : "";
  return ["ts","tsx","js","jsx","py","java","cpp","c","cs","go","rs","php","rb",
    "sh","json","xml","html","css","scss","sql","md","yml","yaml","txt","csv",
    "env","gitignore","dockerfile","makefile","gradle","pom","package","lock",
    "yarn","toml","prisma","graphql","gql","vue","svelte",
  ].includes(ext) || !ext;
}

function parsePatchStats(patch: string): DiffStats {
  let added = 0, removed = 0;
  for (const line of (patch || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function normalizeDiffEntries(raw: any): DiffEntry[] {
  const files = raw?.files || raw?.changes || raw?.diffs || raw?.items || [];
  if (!Array.isArray(files)) {
    if (typeof raw?.patch === "string" && raw.patch.trim())
      return [{ path: "changes.patch", patch: raw.patch }];
    return [];
  }
  return files.map((f: any) => {
    const path = f?.path || f?.new_path || f?.newPath || f?.old_path || f?.oldPath || f?.file || f?.filename;
    if (!path) return null;
    const patch = (typeof f?.patch === "string" && f.patch)
      || (typeof f?.diff === "string" && f.diff)
      || (Array.isArray(f?.hunks) ? f.hunks.map((h: any) => typeof h === "string" ? h : h?.patch || h?.diff || "").filter(Boolean).join("\n") : "");
    const normalizedPatch = String(patch || "");
    const parsed = parsePatchStats(normalizedPatch);
    return {
      path: String(path),
      patch: normalizedPatch,
      added: Number.isFinite(f?.additions) ? f.additions : parsed.added,
      removed: Number.isFinite(f?.deletions) ? f.deletions : parsed.removed,
    };
  }).filter(Boolean) as DiffEntry[];
}

// ─── Syntax helpers ───────────────────────────────────────────────────────────

const KW_RE = /\b(import|export|const|let|var|function|class|return|if|else|from|new|type|interface|extends|implements|async|await|try|catch|finally|for|while|do|switch|case|break|continue|default|null|undefined|true|false|void|typeof|instanceof|in|of|this|super|static|public|private|protected|readonly|abstract|declare|enum|as|is)\b/;
const TOKEN_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*$)|\b(import|export|const|let|var|function|class|return|if|else|from|new|type|interface|extends|implements|async|await|try|catch|finally|for|while|do|switch|case|break|continue|default|null|undefined|true|false|void|typeof|instanceof|in|of|this|super|static|public|private|protected|readonly|abstract|declare|enum|as|is)\b|(\b\d+\.?\d*\b)/g;

function highlightLine(line: string): React.ReactNode {
  if (!line) return <>&nbsp;</>;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) nodes.push(<span key={last} className="text-[#d4d4d4]">{line.slice(last, m.index)}</span>);
    if (m[1]) nodes.push(<span key={m.index} className="text-[#ce9178]">{m[1]}</span>);       // string
    else if (m[2]) nodes.push(<span key={m.index} className="text-[#6a9955]">{m[2]}</span>);  // comment
    else if (m[3]) nodes.push(<span key={m.index} className="text-[#569cd6]">{m[3]}</span>);  // keyword
    else if (m[4]) nodes.push(<span key={m.index} className="text-[#b5cea8]">{m[4]}</span>);  // number
    last = m.index + m[0].length;
  }
  if (last < line.length) nodes.push(<span key={last} className="text-[#d4d4d4]">{line.slice(last)}</span>);
  return <>{nodes}</>;
}

// ─── CodeView ─────────────────────────────────────────────────────────────────

function CodeView({ content }: { content: string }) {
  const lines = (content || "").split("\n");
  return (
    <div className="font-mono text-[11.5px] leading-[1.65] py-2">
      {lines.map((line, idx) => (
        <div key={idx} className="flex items-stretch hover:bg-white/[0.015]">
          <span className="w-10 shrink-0 text-right pr-3.5 text-[#4a4a4a] select-none text-[11px]">{idx + 1}</span>
          <span className="flex-1 whitespace-pre-wrap break-all pr-4">{highlightLine(line)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── DiffPatchView ────────────────────────────────────────────────────────────

function DiffPatchView({ patch }: { patch: string }) {
  const lines = (patch || "").split("\n");
  let oldNo = 1, newNo = 1;
  return (
    <div className="font-mono text-[11.5px] leading-[1.65] py-2">
      {lines.map((line, idx) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const isFileMeta = line.startsWith("---") || line.startsWith("+++");
        const oldLabel = isAdd || isHunk || isFileMeta ? "" : String(oldNo);
        const newLabel = isDel || isHunk || isFileMeta ? "" : String(newNo);
        if (!isAdd && !isHunk && !isFileMeta) oldNo++;
        if (!isDel && !isHunk && !isFileMeta) newNo++;
        const code = isAdd || isDel ? line.slice(1) : line;
        return (
          <div
            key={`${idx}-${line.slice(0, 16)}`}
            className={cn(
              "flex items-stretch",
              isAdd && "bg-emerald-500/[0.12]",
              isDel && "bg-red-500/[0.12]",
              isHunk && "bg-blue-500/[0.10]",
            )}
          >
            <span className="w-9 shrink-0 text-right pr-3 text-[#4a4a4a] select-none text-[11px]">{oldLabel}</span>
            <span className="w-9 shrink-0 text-right pr-3 text-[#4a4a4a] select-none text-[11px]">{newLabel}</span>
            <span className={cn(
              "w-4 shrink-0 text-center select-none",
              isAdd ? "text-emerald-500" : isDel ? "text-red-500" : "text-transparent",
            )}>{isAdd ? "+" : isDel ? "−" : " "}</span>
            <span className={cn(
              "flex-1 pr-4 whitespace-pre-wrap break-all",
              isAdd && "text-emerald-200",
              isDel && "text-red-300",
              isHunk && "text-blue-300",
              isFileMeta && "text-yellow-300",
              !isAdd && !isDel && !isHunk && !isFileMeta && "",
            )}>
              {(!isAdd && !isDel && !isHunk && !isFileMeta) ? highlightLine(code) : (code || " ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── FileTreeNode ─────────────────────────────────────────────────────────────

function HistoryFileNode({
  node, depth, selectedFile, onSelect, isLoadingFile, diffStatsByPath,
}: {
  node: FileNode; depth: number; selectedFile: string | null;
  onSelect: (path: string) => void; isLoadingFile: boolean;
  diffStatsByPath?: Record<string, DiffStats>;
}) {
  const [isOpen, setIsOpen] = React.useState(!!node.isOpen);
  const isDir = node.type === "directory";
  const isSelected = selectedFile === node.path;
  const name = node.path.split("/").filter(Boolean).pop() || node.path || "root";
  const iconSrc = isDir ? getMaterialFolderIcon(name.toLowerCase(), isOpen) : getMaterialFileIcon(name);
  const stats = !isDir ? diffStatsByPath?.[node.path] : undefined;

  return (
    <div>
      <button
        onClick={() => isDir ? setIsOpen(o => !o) : onSelect(node.path)}
        disabled={isLoadingFile && isSelected}
        className={cn(
          "w-full flex items-center gap-1.5 py-[3px] pr-2 rounded text-left transition-colors cursor-pointer disabled:opacity-50 text-[12px]",
          isSelected
            ? "bg-brand-pink/10 text-white border border-brand-pink/20"
            : "text-gray-400 hover:bg-white/5 hover:text-white",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          <>
            <span className="text-gray-600 shrink-0">
              {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </span>
            <img src={iconSrc} alt="" className="w-3.5 h-3.5 shrink-0" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <img src={iconSrc} alt="" className="w-3.5 h-3.5 shrink-0" />
          </>
        )}
        <span className="truncate font-medium">{name}</span>
        {!isDir && stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="ml-auto text-[10px] font-mono shrink-0">
            {stats.added > 0 && <span className="text-emerald-400">+{stats.added}</span>}
            {stats.added > 0 && stats.removed > 0 && <span className="text-white/25 mx-1">/</span>}
            {stats.removed > 0 && <span className="text-red-400">-{stats.removed}</span>}
          </span>
        )}
      </button>
      {isDir && isOpen && node.children && node.children.length > 0 && (
        <div>
          {node.children.map(child => (
            <HistoryFileNode key={child.path} node={child} depth={depth + 1}
              selectedFile={selectedFile} onSelect={onSelect}
              isLoadingFile={isLoadingFile} diffStatsByPath={diffStatsByPath}
            />
          ))}
        </div>
      )}
      {isDir && isOpen && (!node.children || node.children.length === 0) && (
        <p className="text-[10px] text-white/20 italic" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
          Empty folder
        </p>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function HistoryTab({ workspaceName, workspaceId = null }: HistoryTabProps) {
  const { user } = useUser();
  const { getToken } = useAuth();
  const nsQuery = "";

  const [commits, setCommits] = React.useState<Commit[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [selectedCommit, setSelectedCommit] = React.useState<Commit | null>(null);
  const [fileTree, setFileTree] = React.useState<FileNode[]>([]);
  const [isLoadingTree, setIsLoadingTree] = React.useState(false);

  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
  const [fileContent, setFileContent] = React.useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const [diffByPath, setDiffByPath] = React.useState<Record<string, string>>({});
  const [diffStatsByPath, setDiffStatsByPath] = React.useState<Record<string, DiffStats>>({});
  const [commitTotals, setCommitTotals] = React.useState<DiffStats>({ added: 0, removed: 0 });
  const [commitStatsBySha, setCommitStatsBySha] = React.useState<CommitStatsMap>({});
  const [currentDiffBase, setCurrentDiffBase] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const isDiffView = !!(selectedFile && diffByPath[selectedFile] !== undefined);
  const treeCacheRef = React.useRef<Map<string, { tree: FileNode[]; diffByPath: Record<string, string>; diffBase: string | null }>>(new Map());
  const treeRequestRef = React.useRef<AbortController | null>(null);

  // Reset caches on workspace change
  React.useEffect(() => {
    treeCacheRef.current.clear();
    treeRequestRef.current?.abort();
    treeRequestRef.current = null;
    setDiffByPath({});
    setDiffStatsByPath({});
    setCommitTotals({ added: 0, removed: 0 });
    setCommitStatsBySha({});
    setCurrentDiffBase(null);
  }, [workspaceName]);

  // ── Fetch commits ────────────────────────────────────────────────────────

  const fetchCommits = React.useCallback(async () => {
    let cancelled = false;
    try {
      setLoading(true);
      setError(null);
      const token = await getToken();
      const authHeader = { Authorization: `Bearer ${token}` };
      const res = await fetch(`${API_URL}/api/coregit/${workspaceName}/commits?limit=50${nsQuery}`, { headers: authHeader });
      // 404 = repo doesn't exist yet (no commits); treat as empty, not an error
      if (res.status === 404) { if (!cancelled) setCommits([]); return; }
      if (!res.ok) throw new Error(`Failed to fetch commits (${res.status})`);
      const data = await res.json();
      if (cancelled) return;
      const raw: Commit[] = data.commits || [];
      // Derive synthetic parents from list position (commits ordered newest-first)
      const list = raw.map((c, i) => ({ ...c, parents: raw[i + 1] ? [raw[i + 1].sha] : [] }));
      setCommits(list);
      if (list.length > 0) loadFileTree(list[0]);

      // Prefetch stats for commit list (commits with a parent = can diff)
      const candidates = list.filter(c => c.parents?.[0]).slice(0, 20);
      for (const c of candidates) {
        const base = c.parents[0];
        fetch(`${API_URL}/api/coregit/${workspaceName}/commits/${c.sha}/diff?base=${encodeURIComponent(base)}${nsQuery}`, { headers: authHeader })
          .then(r => r.ok ? r.json() : null)
          .then(diffData => {
            if (!diffData || cancelled) return;
            const entries = normalizeDiffEntries(diffData);
            const totals = entries.reduce((acc, e) => ({
              added: acc.added + (e.added ?? parsePatchStats(e.patch || "").added),
              removed: acc.removed + (e.removed ?? parsePatchStats(e.patch || "").removed),
            }), { added: 0, removed: 0 });
            setCommitStatsBySha(prev => ({ ...prev, [c.sha]: totals }));
          })
          .catch(() => {});
      }
    } catch (err: any) {
      if (!cancelled) setError(err.message || "Failed to load commits");
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => { cancelled = true; };
  }, [workspaceName]);

  React.useEffect(() => { fetchCommits(); }, [fetchCommits]);

  React.useEffect(() => {
    const handleAgentDone = () => { setTimeout(fetchCommits, 1500); };
    window.addEventListener("pf:agent-done", handleAgentDone);
    return () => window.removeEventListener("pf:agent-done", handleAgentDone);
  }, [fetchCommits]);

  // ── Load file tree for a commit ───────────────────────────────────────────

  async function loadFileTree(commit: Commit) {
    setSelectedCommit(commit);
    setSelectedFile(null);
    setFileContent(null);
    setFileError(null);

    const cached = treeCacheRef.current.get(commit.sha);
    if (cached) {
      setDiffByPath(cached.diffByPath);
      const cachedStats = Object.entries(cached.diffByPath).reduce((acc, [p, patch]) => {
        acc[p] = parsePatchStats(patch); return acc;
      }, {} as Record<string, DiffStats>);
      setDiffStatsByPath(cachedStats);
      const totals = Object.values(cachedStats).reduce((acc, s) => ({
        added: acc.added + s.added, removed: acc.removed + s.removed,
      }), { added: 0, removed: 0 });
      setCommitTotals(totals);
      setCurrentDiffBase(cached.diffBase);
      setFileTree(cached.tree);
      setIsLoadingTree(false);
      return;
    }

    treeRequestRef.current?.abort();
    const controller = new AbortController();
    treeRequestRef.current = controller;
    setDiffByPath({});
    setDiffStatsByPath({});
    setCommitTotals(commitStatsBySha[commit.sha] || { added: 0, removed: 0 });
    setCurrentDiffBase(commit.parents?.[0] || null);
    setFileTree([]);
    setIsLoadingTree(true);

    try {
      const token = await getToken();
      const authHeader = { Authorization: `Bearer ${token}` };
      const parentSha = commit.parents?.[0];
      if (parentSha) {
        const diffRes = await fetch(
          `${API_URL}/api/coregit/${workspaceName}/commits/${commit.sha}/diff?base=${encodeURIComponent(parentSha)}${nsQuery}`,
          { signal: controller.signal, headers: authHeader },
        );
        if (diffRes.ok && diffRes.status !== 404) {
          const diffData = await diffRes.json();
          const entries = normalizeDiffEntries(diffData);
          if (entries.length > 0) {
            const diffMap = entries.reduce((acc, e) => { acc[e.path] = e.patch || ""; return acc; }, {} as Record<string, string>);
            const statsMap = entries.reduce((acc, e) => {
              acc[e.path] = { added: e.added ?? parsePatchStats(e.patch || "").added, removed: e.removed ?? parsePatchStats(e.patch || "").removed };
              return acc;
            }, {} as Record<string, DiffStats>);
            const totals = Object.values(statsMap).reduce((acc, s) => ({ added: acc.added + s.added, removed: acc.removed + s.removed }), { added: 0, removed: 0 });
            const items: FileNode[] = entries.map(e => ({ path: e.path, type: "file" as const }));
            setDiffByPath(diffMap);
            setDiffStatsByPath(statsMap);
            setCommitTotals(totals);
            setCommitStatsBySha(prev => ({ ...prev, [commit.sha]: totals }));
            setFileTree(items);
            treeCacheRef.current.set(commit.sha, { tree: items, diffByPath: diffMap, diffBase: parentSha });
            return;
          }
        }
      }
      // Fallback: full tree for root commits
      const treeRes = await fetch(`${API_URL}/api/coregit/${workspaceName}/commits/${commit.sha}/tree`, { signal: controller.signal, headers: authHeader });
      if (treeRes.status === 404) { setFileTree([]); return; }
      if (!treeRes.ok) throw new Error(`Tree fetch failed (${treeRes.status})`);
      const treeData = await treeRes.json();
      const items = treeData.items || [];
      treeCacheRef.current.set(commit.sha, { tree: items, diffByPath: {}, diffBase: parentSha || null });
      setFileTree(items);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setError(err.message || "Failed to load file tree");
    } finally {
      if (treeRequestRef.current === controller) {
        treeRequestRef.current = null;
        setIsLoadingTree(false);
      }
    }
  }

  // ── Load file content ────────────────────────────────────────────────────

  async function loadFileContent(filePath: string) {
    if (!selectedCommit) return;
    const normalizedPath = filePath.replace(/^a\//, "").replace(/^b\//, "");
    setSelectedFile(filePath);
    setFileContent(null);
    setFileError(null);

    if (diffByPath[filePath] !== undefined) {
      const inlinePatch = diffByPath[filePath];
      const isPlaceholder = inlinePatch.trim() === "// No textual diff available" || inlinePatch.includes("Detailed patch unavailable");
      if (inlinePatch && inlinePatch.trim() && !isPlaceholder) {
        setFileContent(inlinePatch);
        return;
      }
      const baseRef = currentDiffBase || selectedCommit.parents?.[0] || null;
      if (baseRef) {
        setIsLoadingFile(true);
        try {
          const params = new URLSearchParams({ base: baseRef, path: normalizedPath });
          const token = await getToken();
          const res = await fetch(`${API_URL}/api/coregit/${workspaceName}/commits/${selectedCommit.sha}/diff-file?${params}${nsQuery}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`Diff fetch failed (${res.status})`);
          const data = await res.json();
          const patch = data.patch || "";
          setFileContent(patch || "// Diff unavailable for this file");
          setDiffByPath(prev => ({ ...prev, [filePath]: patch }));
          const stats = parsePatchStats(patch);
          setDiffStatsByPath(prev => ({ ...prev, [filePath]: stats }));
          setCommitTotals(prev => ({
            added: prev.added - (diffStatsByPath[filePath]?.added || 0) + stats.added,
            removed: prev.removed - (diffStatsByPath[filePath]?.removed || 0) + stats.removed,
          }));
        } catch (err: any) {
          setFileError(err.message || "Failed to load file diff");
        } finally {
          setIsLoadingFile(false);
        }
        return;
      }
      setFileContent("// Diff unavailable for this file");
      return;
    }

    setIsLoadingFile(true);
    try {
      const params = new URLSearchParams({ path: normalizedPath });
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/coregit/${workspaceName}/commits/${selectedCommit.sha}/files?${params}${nsQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`File fetch failed (${res.status})`);
      const data = await res.json();
      const raw = data.content ?? data.text ?? data;
      const text = typeof raw === "string" ? raw : typeof raw === "object" ? JSON.stringify(raw, null, 2) : String(raw);
      setFileContent(text);
    } catch (err: any) {
      setFileError(err.message || "Failed to load file content");
    } finally {
      setIsLoadingFile(false);
    }
  }

  const handleCopy = async () => {
    if (!fileContent) return;
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeFileName = selectedFile ? selectedFile.split("/").filter(Boolean).pop() || selectedFile : null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#1e1e1e]">
      <div className="flex flex-1 overflow-hidden">

      {/* ── Col 1: Commits ─────────────────────────────────────────────── */}
      <div className="w-[165px] shrink-0 flex flex-col border-r border-white/[0.06] bg-[#1c1c1e] overflow-hidden">
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06] shrink-0">
          <span className="text-[11px] font-semibold text-white/50">Commits</span>
          <button onClick={() => fetchCommits()} disabled={loading}
            className="w-4 h-4 flex items-center justify-center text-white/25 hover:text-white/55 transition-colors cursor-pointer disabled:opacity-40"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-none">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <Loader className="w-4 h-4 animate-spin text-white/20" />
            </div>
          ) : error && commits.length === 0 ? (
            <div className="p-3 text-center">
              <AlertCircle className="w-4 h-4 text-red-400/60 mx-auto mb-1.5" />
              <p className="text-[10px] text-red-400/60 leading-snug">{error}</p>
            </div>
          ) : commits.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 gap-1.5">
              <Clock className="w-4 h-4 text-white/10" />
              <p className="text-[10px] text-white/25">No commits yet</p>
            </div>
          ) : (
            commits.map(commit => {
              // Parse conventional commit format
              const match = commit.message.match(/^([a-z]+)(?:\([^)]+\))?:\s*(.+)$/i);
              const type = match ? match[1].toLowerCase() : null;
              const subject = match ? match[2] : commit.message;

              let badgeColor = "bg-white/10 text-white/70";
              if (type === 'feat') badgeColor = "bg-emerald-500/20 text-emerald-400 border border-emerald-500/20";
              else if (type === 'fix') badgeColor = "bg-blue-500/20 text-blue-400 border border-blue-500/20";
              else if (type === 'chore') badgeColor = "bg-purple-500/20 text-purple-400 border border-purple-500/20";
              else if (type === 'refactor') badgeColor = "bg-amber-500/20 text-amber-400 border border-amber-500/20";
              else if (type === 'style') badgeColor = "bg-pink-500/20 text-pink-400 border border-pink-500/20";

              return (
                <button
                  key={commit.sha}
                  onClick={() => loadFileTree(commit)}
                  className={cn(
                    "w-full flex flex-col gap-1.5 px-3.5 py-3 text-left transition-colors border-b border-white/[0.04] group",
                    selectedCommit?.sha === commit.sha
                      ? "bg-white/[0.07]"
                      : "hover:bg-white/[0.04]",
                  )}
                >
                  <div className="flex items-start gap-2 w-full">
                    <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-brand-pink/50 group-hover:bg-brand-pink transition-colors shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] font-medium text-white/80 truncate leading-[1.35]">{subject}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pl-3.5 mt-0.5">
                    {type && (
                      <span className={cn("px-1.5 py-[1px] rounded text-[9px] font-semibold uppercase tracking-wider", badgeColor)}>
                        {type}
                      </span>
                    )}
                    <span className="text-[9.5px] text-white/30 truncate">
                      {formatTimeAgo(commit.timestamp)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Col 2: Explorer ──────────────────────────────────────────────── */}
      <div className="w-[175px] shrink-0 flex flex-col border-r border-white/[0.06] bg-[#1c1c1e] overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-white/[0.06] shrink-0">
          <span className="text-[10px] font-bold text-white/35 uppercase tracking-[0.12em]">Explorer</span>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5 scrollbar-none">
          {isLoadingTree ? (
            <div className="flex items-center justify-center h-20">
              <Loader className="w-4 h-4 animate-spin text-white/20" />
            </div>
          ) : !selectedCommit ? (
            <div className="flex items-center justify-center h-20">
              <p className="text-[10px] text-white/25 text-center px-3">Select a commit</p>
            </div>
          ) : fileTree.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-20 gap-1.5">
              <Folder className="w-4 h-4 text-white/10" />
              <p className="text-[10px] text-white/25">No files</p>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={selectedCommit.sha}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
              >
                {fileTree.map(node => (
                  <HistoryFileNode
                    key={node.path}
                    node={node}
                    depth={0}
                    selectedFile={selectedFile}
                    onSelect={loadFileContent}
                    isLoadingFile={isLoadingFile}
                    diffStatsByPath={diffStatsByPath}
                  />
                ))}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* ── Col 3: Code editor ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[#1e1e1e]">

        {/* Tab bar */}
        <div className="flex items-end bg-[#252527] border-b border-white/[0.06] shrink-0 min-h-[34px]">
          {activeFileName ? (
            <div className="flex items-center gap-1.5 px-3 py-[7px] bg-[#1e1e1e] border-r border-white/[0.06] border-t-[2px] border-t-brand-pink -mb-px">
              <img src={getMaterialFileIcon(activeFileName)} alt="" className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[11px] font-mono text-white/75 max-w-[110px] truncate">{activeFileName}</span>
              {isDiffView && (
                <span className="text-[9px] px-1 py-px rounded-sm bg-blue-500/15 text-blue-400 font-semibold uppercase tracking-wide">diff</span>
              )}
              <button
                onClick={() => { setSelectedFile(null); setFileContent(null); setFileError(null); }}
                className="w-3.5 h-3.5 flex items-center justify-center rounded text-white/25 hover:text-white/65 hover:bg-white/10 transition-colors ml-0.5"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ) : (
            <div className="px-3 py-[9px] text-[11px] text-white/20 italic select-none">
              {selectedCommit ? "Select a file" : "Select a commit"}
            </div>
          )}
          {/* Copy button in tab bar right side */}
          {activeFileName && fileContent && (
            <button
              onClick={handleCopy}
              disabled={isLoadingFile}
              className="ml-auto mr-2 mb-1.5 flex items-center gap-1 px-2 py-1 rounded text-[10px] text-white/30 hover:text-white/60 hover:bg-white/[0.05] transition-colors disabled:opacity-30"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/[0.08]">
          {!selectedFile ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2.5">
              <Code2 className="w-9 h-9 text-white/[0.04]" />
              <p className="text-[12px] text-white/20">
                {selectedCommit ? "Select a file to view" : "Select a commit, then a file"}
              </p>
            </div>
          ) : isLoadingFile ? (
            <div className="flex items-center justify-center h-full">
              <Loader className="w-5 h-5 animate-spin text-white/25" />
            </div>
          ) : fileError ? (
            <div className="p-6 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400/70 shrink-0 mt-px" />
              <p className="text-[11px] text-red-300/70">{fileError}</p>
            </div>
          ) : isDiffView ? (
            <DiffPatchView patch={fileContent || ""} />
          ) : isTextFile(selectedFile) ? (
            <CodeView content={fileContent || ""} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2.5">
              <Folder className="w-8 h-8 text-white/[0.05]" />
              <p className="text-[12px] text-white/25">Binary file — cannot preview</p>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
