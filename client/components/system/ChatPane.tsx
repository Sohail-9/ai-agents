"use client";

const IMAGE_API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

import React, { useState, useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Loader } from 'lucide-react';
import { getMaterialFileIcon } from 'file-extension-icon-js';
import SystemInputBar from '@/components/system/SystemInputBar';
import type { ChatMessage, PlanQuestionsData, TodoItem, SubAgentState } from '@/app/system/[id]/_types/system';
import { SubAgentPanel } from '@/app/system/[id]/_components/sub-agent-panel';

// ─── Inline markdown formatter ────────────────────────────────────────────────
function renderInline(text: string, baseKey: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[\s\S]*?\*\*|\*[\s\S]*?\*|\[([^\]]+)\]\(([^)]+)\)|(\/workspace\/[a-zA-Z0-9_.\-/]+))/g;
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`'))
      parts.push(<code key={`${baseKey}-${k++}`} className="bg-white/10 px-1 py-0.5 rounded text-brand-pink font-mono text-[11px]">{t.slice(1,-1)}</code>);
    else if (t.startsWith('**'))
      parts.push(<strong key={`${baseKey}-${k++}`} className="font-bold text-white">{t.slice(2,-2)}</strong>);
    else if (t.startsWith('*'))
      parts.push(<em key={`${baseKey}-${k++}`} className="italic opacity-80">{t.slice(1,-1)}</em>);
    else if (t.startsWith('['))
      parts.push(<a key={`${baseKey}-${k++}`} href={m[3]} className="text-brand-pink underline underline-offset-2" target="_blank" rel="noopener noreferrer">{m[2]}</a>);
    else if (t.startsWith('/workspace/'))
      parts.push(<span key={`${baseKey}-${k++}`} className="text-brand-pink font-medium">@{t.split('/').pop()}</span>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts.length === 1 ? parts[0] : <React.Fragment>{parts}</React.Fragment>;
}

// ─── Simple synchronous markdown renderer ────────────────────────────────────
function AgentMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0; let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      i++;
      nodes.push(<pre key={key++} className="bg-black/30 rounded-lg p-2.5 my-1.5 text-[11px] text-white/70 font-mono whitespace-pre-wrap overflow-x-auto">{codeLines.join('\n')}</pre>);
      continue;
    }

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      const lvl = hm[1].length;
      nodes.push(<p key={key++} className={`${lvl === 1 ? 'font-bold' : lvl === 2 ? 'font-semibold' : 'font-medium'} text-white mb-1`}>{renderInline(hm[2], `h${key}`)}</p>);
      i++; continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const txt = lines[i].replace(/^[-*+]\s+/, '');
        items.push(<li key={i} className="leading-relaxed">{renderInline(txt, `li${i}`)}</li>);
        i++;
      }
      nodes.push(<ul key={key++} className="list-disc pl-4 space-y-0.5 mb-1.5">{items}</ul>);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const txt = lines[i].replace(/^\d+\.\s+/, '');
        items.push(<li key={i} className="leading-relaxed">{renderInline(txt, `oli${i}`)}</li>);
        i++;
      }
      nodes.push(<ol key={key++} className="list-decimal pl-4 space-y-0.5 mb-1.5">{items}</ol>);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      nodes.push(<blockquote key={key++} className="border-l-2 border-white/20 pl-3 italic opacity-60 mb-1">{renderInline(line.slice(2), `bq${key}`)}</blockquote>);
      i++; continue;
    }

    // Empty line → spacing
    if (!line.trim()) { i++; continue; }

    // Paragraph
    nodes.push(<p key={key++} className="mb-1 leading-relaxed">{renderInline(line, `p${key}`)}</p>);
    i++;
  }

  return <div className="space-y-0.5">{nodes}</div>;
}

// ─── Plan Ready Card ──────────────────────────────────────────────────────────
function PlanReadyCard({ data, onBuild }: { data: { content: string; path: string }; onBuild: (msg: string) => void }) {
  const [notes, setNotes] = useState('');
  const [fullscreen, setFullscreen] = useState(false);

  const buildAndClose = () => onBuild(notes.trim() || 'Implement this plan');

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-4 mb-4 rounded-2xl overflow-hidden bg-[#1c1c1e] border border-white/8"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/8">
          <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          <span className="text-[12px] font-semibold text-white/80">Plan Ready</span>
          <span className="text-[10px] text-white/25 truncate ml-1">{data.path}</span>
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-white/55 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
            title="Fullscreen"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
          </button>
        </div>

        {/* Preview — limited height */}
        <div className="px-3.5 py-2.5 max-h-44 overflow-y-auto text-[12px] leading-relaxed text-white/50 scrollbar-none">
          <AgentMarkdown content={data.content} />
        </div>

        {/* Bottom action row */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-white/8">
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && buildAndClose()}
            placeholder="Add notes (optional)..."
            className="flex-1 bg-transparent text-[11.5px] text-white/70 placeholder:text-white/25 outline-none"
          />
          <button
            type="button"
            onClick={buildAndClose}
            className="px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-white/10 hover:bg-white/15 text-white/70 transition-all cursor-pointer shrink-0"
          >
            Build
          </button>
        </div>
      </motion.div>

      {/* Fullscreen modal */}
      <AnimatePresence>
        {fullscreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
            onClick={() => setFullscreen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-[#1c1c1e] border border-white/10 overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-5 py-3.5 border-b border-white/8 shrink-0">
                <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <span className="text-[13px] font-semibold text-white">Implementation Plan</span>
                <span className="text-[11px] text-white/30 ml-1">{data.path}</span>
                <button
                  type="button"
                  onClick={() => setFullscreen(false)}
                  className="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px] leading-relaxed text-white/65">
                <AgentMarkdown content={data.content} />
              </div>
              <div className="flex items-center gap-2 px-4 py-3 border-t border-white/8 shrink-0">
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (setFullscreen(false), buildAndClose())}
                  placeholder="Add notes (optional)..."
                  className="flex-1 bg-white/5 rounded-lg px-3 py-2 text-[12px] text-white/70 placeholder:text-white/25 outline-none border border-white/8 focus:border-white/15"
                />
                <button
                  type="button"
                  onClick={() => { setFullscreen(false); buildAndClose(); }}
                  className="px-4 py-2 rounded-lg text-[12.5px] font-semibold bg-white/10 hover:bg-white/15 text-white/70 transition-all cursor-pointer shrink-0"
                >
                  Build Plan
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

interface ChatPaneProps {
  viewMode: "chat" | "split" | "preview";
  wsMessages?: ChatMessage[];
  isAgentRunning?: boolean;
  onRealSubmit?: (text: string, images?: import('@/app/system/[id]/_types/system').ChatImage[]) => void;
  workspaceId?: string | null;
  onStop?: () => void;
  isPlanMode?: boolean;
  onPlanModeChange?: (v: boolean) => void;
  isMultiAgent?: boolean;
  onMultiAgentChange?: (v: boolean) => void;
  planQuestions?: PlanQuestionsData | null;
  onPlanAnswer?: (answers: Record<string, string>, questionsData?: PlanQuestionsData | null) => void;
  planReady?: { content: string; path: string } | null;
  onBuildPlan?: (msg: string) => void;
  isLoadingHistory?: boolean;
  hasMoreHistory?: boolean;
  onLoadMore?: () => void;
  todos?: TodoItem[];
  subAgentStates?: Record<string, SubAgentState>;
  subAgentIsLive?: boolean;
  wsRef?: MutableRefObject<WebSocket | null>;
  sandboxId?: string | null;
  sessionStats?: { files: number; linesAdded: number; linesRemoved: number };
  agentStartedAt?: number | null;
}

const StreamingCursor = () => null;

const TOOLTIP_MESSAGES = [
  "What do you wanna build today?",
  "Ready to craft something amazing?",
  "Let's turn ideas into reality.",
  "Need help with your code?",
  "I'm here to build with you.",
  "What's the next big feature?",
  "Let's write some beautiful code.",
  "How can I assist you today?"
];

// ─── Agent Status Logo ────────────────────────────────────────────────────────
const AgentStatusLogo = ({ isRunning }: { isRunning: boolean }) => {
  const [clicked, setClicked] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (isRunning) {
      setShowTooltip(false);
      setClicked(false);
    }
  }, [isRunning]);

  const handleClick = () => {
    if (isRunning) return;
    setClicked(true);
    setTimeout(() => setClicked(false), 400);
  };

  return (
    <div className="relative flex flex-col items-start justify-center pt-2 pb-4">
      <AnimatePresence>
        {showTooltip && !isRunning && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.95 }}
            className="absolute bottom-full mb-1 flex flex-col items-start z-20 pointer-events-none"
          >
            <div className="bg-[#1c1c1e] border border-white/10 shadow-xl rounded-xl px-3 py-2 backdrop-blur-xl w-max">
              <p className="text-[11.5px] font-semibold text-white/90 tracking-tight">{TOOLTIP_MESSAGES[messageIndex]}</p>
            </div>
            {/* Arrow */}
            <div className="w-2.5 h-2.5 bg-[#1c1c1e] border-b border-r border-white/10 rotate-45 -mt-1.5 ml-3" />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => { 
          if (!isRunning) {
            setMessageIndex(Math.floor(Math.random() * TOOLTIP_MESSAGES.length));
            setShowTooltip(true); 
          }
        }}
        onMouseLeave={() => setShowTooltip(false)}
        animate={clicked ? { scale: [1, 1.3, 0.85, 1.1, 1] } : { scale: 1 }}
        transition={{ duration: 0.4, ease: "easeInOut" }}
        className={`relative flex items-center justify-center transition-colors focus:outline-none ${
          !isRunning ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <img
          src="/logos/logo.svg"
          alt="Agent Status"
          className="w-7 h-7"
          style={isRunning ? { animation: "spin 3.8s linear infinite" } : undefined}
        />
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </motion.button>
    </div>
  );
};


// ─── Streaming Code Block (while file is being written) ─────────────────────
function StreamingCodeBlock({ path, content }: { path: string; content: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabled = useRef(true);
  const displayPath = path.replace(/^\/workspace\//, '');

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    isAutoScrollEnabled.current = scrollHeight - scrollTop - clientHeight < 30;
  };

  useEffect(() => {
    if (scrollRef.current && isAutoScrollEnabled.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content]);

  const lines = content ? content.split('\n') : [];
  const MAX_VISIBLE = 22;
  const displayLines = lines.slice(-MAX_VISIBLE);
  const startNo = Math.max(1, lines.length - MAX_VISIBLE + 1);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="w-full my-2 font-mono text-[11px]"
    >
      <div className="flex items-center gap-2 min-w-0 mb-0.5 px-0.5">
        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
        <span className="text-white font-semibold text-[12px] truncate">Writing({displayPath || 'file'})</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-hidden max-h-[220px]"
      >
        {!content ? (
          <div className="px-2 py-1 text-white/30 italic text-[10px]">Preparing...</div>
        ) : (
          displayLines.map((line, i) => (
            <div key={i} className="flex items-start px-2 py-[1.5px]">
              <span className="w-6 text-right text-white/20 select-none mr-2.5 shrink-0 tabular-nums leading-relaxed text-[9px]">{startNo + i}</span>
              <span className="w-3 shrink-0 select-none leading-relaxed text-emerald-400">+</span>
              <span className="break-all whitespace-pre-wrap leading-relaxed text-white/60">{line}</span>
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}

// ─── LCS diff for find/replace ────────────────────────────────────────────────
function lcsLineDiff(oldLines: string[], newLines: string[]): Array<{ type: '+' | '-' | '='; text: string }> {
  const m = oldLines.length, n = newLines.length;
  if (m === 0 && n === 0) return [];
  // Guard: if either side is huge skip LCS, fall back to naive
  if (m * n > 40000) {
    return [
      ...oldLines.map(text => ({ type: '-' as const, text })),
      ...newLines.map(text => ({ type: '+' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result: Array<{ type: '+' | '-' | '='; text: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: '=', text: oldLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: '+', text: newLines[j - 1] }); j--;
    } else {
      result.unshift({ type: '-', text: oldLines[i - 1] }); i--;
    }
  }
  return result;
}

// ─── Finished Code Block ─────────────────────────────────────────────────────
function FinishedCodeBlock({ path, content, find, replace, isSplit }: { path: string; content?: string; find?: string; replace?: string; isSplit?: boolean }) {
  const [copied, setCopied] = useState(false);
  const displayPath = path.replace(/^\/workspace\//, '');
  const hasFind = !!find;
  const hasReplace = !!replace;
  const hasContent = !!content;
  const verb = hasFind || hasReplace ? 'Update' : 'Create';

  type DiffRow = { lineNo: number; type: '+' | '-' | '='; text: string };
  const allRows: DiffRow[] = [];
  let lineNo = 1;
  if (hasFind || hasReplace) {
    const diffResult = lcsLineDiff((find || '').split('\n'), (replace || '').split('\n'));
    diffResult.forEach(d => allRows.push({ lineNo: lineNo++, type: d.type, text: d.text }));
  } else if (hasContent) {
    content!.split('\n').forEach(l => allRows.push({ lineNo: lineNo++, type: '+', text: l }));
  }

  const addedCount = allRows.filter(r => r.type === '+').length;
  const removedCount = allRows.filter(r => r.type === '-').length;
  let stat = '';
  if (addedCount > 0 && removedCount > 0) stat = `+${addedCount} −${removedCount} lines`;
  else if (addedCount > 0) stat = `Added ${addedCount} line${addedCount !== 1 ? 's' : ''}`;
  else if (removedCount > 0) stat = `Removed ${removedCount} line${removedCount !== 1 ? 's' : ''}`;

  const MAX_ROWS = 40;
  const rows = allRows.slice(0, MAX_ROWS);
  const extra = allRows.length - MAX_ROWS;

  const highlightLine = (line: string): React.ReactNode => {
    const regex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:import|from|as|export|default|class|if|else|return|const|let|var|function|true|false|null|undefined|new|typeof|async|await)\b|\b\d+\b|[a-zA-Z_]\w*)/g;
    const parts: React.ReactNode[] = [];
    let last = 0; let k = 0; let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      if (m.index > last) parts.push(<span key={k++} className="text-white/45">{line.slice(last, m.index)}</span>);
      const t = m[0];
      if (t.startsWith('"') || t.startsWith("'") || t.startsWith('`'))
        parts.push(<span key={k++} className="text-amber-300/80">{t}</span>);
      else if (/^(import|from|as|export|default|class|if|else|return|const|let|var|function|true|false|null|undefined|new|typeof|async|await)$/.test(t))
        parts.push(<span key={k++} className="text-brand-pink">{t}</span>);
      else if (/^\d+(\.\d+)?$/.test(t))
        parts.push(<span key={k++} className="text-orange-300/80">{t}</span>);
      else {
        const nc = line.charAt(regex.lastIndex);
        parts.push(<span key={k++} className={nc === '(' ? 'text-blue-300/80' : 'text-white/65'}>{t}</span>);
      }
      last = m.index + t.length;
    }
    if (last < line.length) parts.push(<span key={k++} className="text-white/45">{line.slice(last)}</span>);
    return parts.length ? <>{parts}</> : <span className="text-white/65">{line}</span>;
  };

  const copy = async () => {
    const text = hasContent ? content! : `${find || ''}\n---\n${replace || ''}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const c = isSplit;
  return (
    <div className={`w-full font-mono ${c ? 'my-1 text-[10px]' : 'my-2 text-[11px]'}`}>
      <div className="flex items-center gap-2 min-w-0 mb-0.5 px-0.5">
        <span className={`rounded-full bg-emerald-400 shrink-0 ${c ? 'w-1.5 h-1.5' : 'w-2 h-2'}`} />
        <span className={`text-white font-semibold truncate ${c ? 'text-[11px]' : 'text-[12px]'}`}>{verb}({displayPath})</span>
      </div>
      {stat && <div className={`font-medium text-white/40 pl-4 mb-1 ${c ? 'text-[10px]' : 'text-[12px]'}`}>└ {stat}</div>}
      <div className="overflow-hidden">
        {rows.map((row, i) => (
          <div
            key={i}
            className={`flex items-start ${c ? 'px-1.5 py-[1px]' : 'px-2 py-[1.5px]'} ${
              row.type === '+' ? 'bg-emerald-500/[0.13]' :
              row.type === '-' ? 'bg-red-500/[0.15]' : ''
            }`}
          >
            <span className={`text-right text-white/20 select-none shrink-0 tabular-nums leading-relaxed text-[9px] ${c ? 'w-5 mr-1.5' : 'w-6 mr-2.5'}`}>{row.lineNo}</span>
            <span className={`w-3 shrink-0 select-none leading-relaxed ${
              row.type === '+' ? 'text-emerald-400' :
              row.type === '-' ? 'text-red-400/80' : 'text-transparent'
            }`}>{row.type === '=' ? ' ' : row.type}</span>
            <span className="break-all whitespace-pre-wrap leading-relaxed">{highlightLine(row.text)}</span>
          </div>
        ))}
        {extra > 0 && (
          <div className="text-[10px] text-white/25 italic pl-10 py-1">... {extra} more lines</div>
        )}
      </div>
    </div>
  );
}

// ─── Parse toolArgsStream for write/edit_file ─────────────────────────────────
function parseStreamingArgs(stream: string): { path: string; content: string } {
  let path = '';
  let content = '';
  const pathMatch = stream.match(/"(?:path|file|filename)"\s*:\s*"([^"]*)"?/);
  if (pathMatch) path = pathMatch[1];

  function extractStringField(src: string, field: string): string | null {
    const m = src.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*)`));
    if (!m) return null;
    let raw = m[1];
    if (raw.endsWith('"}') || raw.endsWith('"\n}')) raw = raw.replace(/"\s*}$/, '');
    try { return JSON.parse(`"${raw.replace(/"$/, '')}"`); } catch {
      return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }

  // overwrite/append use "content"; replace operation uses "replace" field
  content = extractStringField(stream, 'content') ?? extractStringField(stream, 'replace') ?? '';
  return { path, content };
}

// ─── Shared artifact outer shell ─────────────────────────────────────────────
function ArtifactShell({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`w-full my-1.5 rounded-2xl bg-white/[0.04] border border-white/[0.08] p-1 ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div className="rounded-xl bg-black border border-white/[0.10] overflow-hidden">
        {children}
      </div>
    </div>
  );
}

// ─── Shell block ──────────────────────────────────────────────────────────────
function ShellBlock({ command, output, isRunning }: { command: string; output?: string; isRunning?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <ArtifactShell onClick={() => setOpen(v => !v)}>
      <div className="flex items-start justify-between px-3.5 pt-2.5 pb-2 select-none font-mono">
        <div className="flex flex-col gap-0 min-w-0">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">Execute</span>
          <span className="text-[10px] text-[#b8b89a] font-mono">└ $ {command}</span>
        </div>
        <ChevronDown
          size={14}
          className={`text-white/30 mt-1 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </div>
      {open && (output || isRunning) && (
        <div className="px-3.5 pb-2.5 pt-0 font-mono">
          <div className="border-t border-white/[0.06] pt-2">
            {output ? (
              <pre className="text-[10px] text-white/50 whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-none leading-relaxed">{output}</pre>
            ) : (
              <div className="flex items-center gap-1.5 text-[10px] text-white/30">
                <Loader className="w-2 h-2 animate-spin" />Running...
              </div>
            )}
          </div>
        </div>
      )}
    </ArtifactShell>
  );
}

// ─── File block ───────────────────────────────────────────────────────────────
function FileBlock({ action, filePath, isRunning }: { action: string; filePath: string; isRunning?: boolean }) {
  const displayPath = filePath.replace(/^\/workspace\//, '');
  const label = action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();
  return (
    <ArtifactShell>
      <div className="flex items-start justify-between px-3.5 pt-2.5 pb-2 select-none font-mono">
        <div className="flex flex-col gap-0 min-w-0">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">{label}</span>
          {displayPath ? (
            <span className="flex items-center gap-1 text-[10px] text-[#b8b89a] truncate">
              {isRunning && <Loader className="w-2 h-2 animate-spin shrink-0 text-white/30" />}
              └ {displayPath}
            </span>
          ) : isRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-white/30">
              <Loader className="w-2 h-2 animate-spin shrink-0" />Working...
            </span>
          ) : null}
        </div>
      </div>
    </ArtifactShell>
  );
}

// ─── Skill block ─────────────────────────────────────────────────────────────
function SkillBlock({ skillName }: { skillName: string }) {
  return (
    <ArtifactShell>
      <div className="px-3.5 pt-2.5 pb-2 font-mono">
        <div className="flex flex-col gap-0 min-w-0">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">Skill</span>
          <span className="text-[10px] text-[#b8b89a]">└ Agent used {skillName} skill</span>
        </div>
      </div>
    </ArtifactShell>
  );
}

// ─── Health block ────────────────────────────────────────────────────────────
function HealthBlock({ port, output, isRunning }: { port?: number; output?: string; isRunning?: boolean }) {
  const [buildOpen, setBuildOpen] = useState(false);
  type Status = 'ok' | 'fail' | 'partial' | 'loading';
  let status: Status = 'loading';
  let summary = '';
  let buildStatus: 'ok' | 'errors' | null = null;
  let buildErrors = '';

  if (output) {
    if (output.startsWith('HEALTH_OK')) { status = 'ok'; }
    else if (output.startsWith('HEALTH_FAIL')) { status = 'fail'; }
    else if (output.startsWith('HEALTH_PARTIAL')) { status = 'partial'; }
    summary = output.split('\n')[0].replace(/^HEALTH_(OK|FAIL|PARTIAL):\s*/, '');

    if (output.includes('BUILD_OK:')) {
      buildStatus = 'ok';
    } else if (output.includes('BUILD_ERRORS:')) {
      buildStatus = 'errors';
      const errStart = output.indexOf('BUILD_ERRORS:') + 'BUILD_ERRORS:'.length;
      const errEnd = output.indexOf('\n[action]:', errStart);
      buildErrors = (errEnd > -1 ? output.slice(errStart, errEnd) : output.slice(errStart)).trim();
    }
  }

  const dotColor = status === 'ok' ? 'bg-emerald-400' : status === 'fail' ? 'bg-red-400' : status === 'partial' ? 'bg-yellow-400' : 'bg-white/20';
  const textColor = status === 'ok' ? 'text-emerald-400' : status === 'fail' ? 'text-red-400' : status === 'partial' ? 'text-yellow-400' : 'text-white/30';

  return (
    <ArtifactShell onClick={buildStatus === 'errors' && buildErrors ? () => setBuildOpen(v => !v) : undefined}>
      <div className="flex items-center justify-between px-3.5 pt-2.5 pb-2 font-mono">
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">
            Check Health{port ? ` · port ${port}` : ''}
          </span>
          {isRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-white/30">
              <Loader className="w-2.5 h-2.5 animate-spin shrink-0" />Checking...
            </span>
          ) : summary ? (
            <span className={`text-[10px] ${textColor} truncate`}>└ {summary}</span>
          ) : null}
          {!isRunning && buildStatus === 'ok' && (
            <span className="text-[10px] text-emerald-400">└ Build · no errors</span>
          )}
          {!isRunning && buildStatus === 'errors' && (
            <span className="flex items-center gap-1 text-[10px] text-red-400">
              └ Build · errors found
              <ChevronDown size={10} className={`transition-transform duration-150 ${buildOpen ? 'rotate-180' : ''}`} />
            </span>
          )}
        </div>
        {!isRunning && output && (
          <span className={`w-2 h-2 rounded-full shrink-0 ml-2 ${buildStatus === 'errors' ? 'bg-red-400' : dotColor}`} />
        )}
        {isRunning && (
          <span className={`w-2 h-2 rounded-full shrink-0 ml-2 animate-pulse ${dotColor}`} />
        )}
      </div>
      {buildOpen && buildErrors && (
        <div className="px-3.5 pb-2.5 font-mono">
          <pre className="text-[9px] text-red-300/80 bg-red-500/5 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{buildErrors}</pre>
        </div>
      )}
    </ArtifactShell>
  );
}

// ─── Search block ─────────────────────────────────────────────────────────────
function SearchBlock({ kind, query, output, isRunning }: { kind: 'code' | 'web'; query?: string; output?: string; isRunning?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = kind === 'code' ? 'Search Code' : 'Web Search';
  const matchCount = output && output !== 'No matches found.'
    ? output.split('\n').filter(Boolean).length
    : null;
  const noMatches = output === 'No matches found.';

  return (
    <ArtifactShell onClick={output && !noMatches ? () => setOpen(v => !v) : undefined}>
      <div className="flex items-center justify-between px-3.5 pt-2.5 pb-2 font-mono">
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">{label}</span>
          {isRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-white/30">
              <Loader className="w-2 h-2 animate-spin shrink-0" />Searching...
            </span>
          ) : query ? (
            <span className="text-[10px] text-[#b8b89a] truncate">└ "{query}"</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {!isRunning && output && (
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${noMatches ? 'text-white/25 bg-white/5' : 'text-emerald-400/80 bg-emerald-500/10'}`}>
              {noMatches ? 'no matches' : `${matchCount} line${matchCount !== 1 ? 's' : ''}`}
            </span>
          )}
          {output && !noMatches && (
            <ChevronDown size={12} className={`text-white/30 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          )}
        </div>
      </div>
      {open && output && !noMatches && (
        <div className="px-3.5 pb-2.5 font-mono">
          <div className="border-t border-white/[0.06] pt-2">
            <pre className="text-[9.5px] text-white/45 whitespace-pre-wrap break-all max-h-48 overflow-y-auto scrollbar-none leading-relaxed">{output}</pre>
          </div>
        </div>
      )}
    </ArtifactShell>
  );
}

// ─── Plan Questions Artifact ──────────────────────────────────────────────────
function PlanQuestionsArtifact({
  questions,
  summary,
  onSubmit,
}: {
  questions: Array<{ id: string; question: string; options: Array<{ id: string; text: string }> }>;
  summary?: string;
  onSubmit?: (answers: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [hovered, setHovered] = useState<{ qId: string; optId: string } | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const allAnswered = questions.length > 0 && questions.every(q => selected[q.id]);

  const handleSubmit = () => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);
    onSubmit?.(selected);
  };

  return (
    <ArtifactShell>
      <div className="px-3.5 pt-2.5 pb-3 font-mono">
        <div className="flex flex-col gap-0 min-w-0 mb-2.5">
          <span className="text-[11px] font-bold text-[#e8e8c8] tracking-tight">Plan Questions</span>
          {summary && <span className="text-[10px] text-[#b8b89a]">└ {summary}</span>}
        </div>
        {questions.length > 0 && (
          <div className="border-t border-white/[0.06] pt-2.5 flex flex-col gap-3">
            {questions.map((q, qi) => (
              <div key={q.id} className="flex flex-col gap-1.5">
                <span className="text-[10.5px] text-white/70 font-semibold font-sans">{qi + 1}. {q.question}</span>
                <div className="flex flex-col gap-0.5 pl-1">
                  {q.options.map(opt => {
                    const isSelected = selected[q.id] === opt.id;
                    const isHovered = hovered?.qId === q.id && hovered?.optId === opt.id;
                    const showTick = isSelected || (isHovered && !submitted);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={submitted}
                        onClick={() => !submitted && setSelected(prev => ({ ...prev, [q.id]: opt.id }))}
                        onMouseEnter={() => !submitted && setHovered({ qId: q.id, optId: opt.id })}
                        onMouseLeave={() => setHovered(null)}
                        className={`flex items-center gap-2 px-1.5 py-1 rounded text-left transition-colors group ${
                          submitted ? 'cursor-default' : 'cursor-pointer'
                        } ${isSelected ? 'bg-brand-pink/10' : isHovered ? 'bg-white/5' : ''}`}
                      >
                        <span className={`text-[10px] font-mono shrink-0 whitespace-nowrap transition-colors ${
                          isSelected ? 'text-brand-pink' : isHovered ? 'text-white/50' : 'text-white/20'
                        }`}>
                          {showTick ? '[✓]' : '[ ]'}
                        </span>
                        <span className={`text-[10.5px] font-sans transition-colors ${
                          isSelected ? 'text-brand-pink' : isHovered ? 'text-white/70' : 'text-white/40'
                        }`}>{opt.text}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {onSubmit && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!allAnswered || submitted}
                className={`mt-1 w-full h-7 rounded text-[10.5px] font-semibold font-sans transition-all ${
                  submitted
                    ? 'bg-emerald-500/20 text-emerald-400 cursor-default'
                    : allAnswered
                    ? 'bg-white/10 hover:bg-white/15 text-white/70 cursor-pointer'
                    : 'bg-white/5 text-white/20 cursor-not-allowed'
                }`}
              >
                {submitted ? '✓ Submitted' : 'Submit'}
              </button>
            )}
          </div>
        )}
      </div>
    </ArtifactShell>
  );
}

// ─── Tool name helpers ────────────────────────────────────────────────────────
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'str_replace_editor', 'str_replace_based_edit_tool']);
const FILE_READ_TOOLS = new Set(['read_file', 'view_file', 'view', 'list_files', 'create_directory', 'move_file', 'copy_file', 'create_file', 'delete_file']);
const SHELL_TOOLS = new Set(['execute_shell', 'execute_command', 'run_terminal_cmd', 'bash', 'run_script', 'execute', 'computer_use']);

function getFilePathFromArgs(args?: Record<string, any>): string {
  if (!args) return '';
  return args.path || args.file_path || args.filename || args.filepath || args.target || '';
}

function getCommandFromArgs(toolName: string, args?: Record<string, any>): string {
  if (!args) return toolName;
  return args.command || args.cmd || args.script || toolName;
}

// ─── Single real message renderer ─────────────────────────────────────────────
const RealMessage = React.memo(function RealMessage({
  msg, isLast, isAgentRunning, isSplit, onPlanAnswer
}: {
  msg: ChatMessage; isLast: boolean; isAgentRunning?: boolean; isSplit?: boolean;
  onPlanAnswer?: (answers: Record<string, string>) => void;
}) {
  const isUser = msg.role === 'user';
  const isStreaming = isLast && isAgentRunning;
  const toolLower = msg.toolCall?.toLowerCase() || '';

  // ── User bubble ──
  if (isUser) {
    // Plan answers display — show Q·A pairs
    if (msg.eventType === 'PLAN_ANSWERS_DISPLAY') {
      const pairs: Array<{ q: string; a: string }> = msg.content
        .split('\n')
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      return (
        <div className="flex flex-col items-end">
          <div style={{ borderRadius: '15px', background: '#1e1e20', padding: '10px 14px' }} className="max-w-[85%] border border-white/8 text-[12px] space-y-1.5">
            {pairs.map((pair, i) => (
              <div key={i} className="leading-snug">
                <span className="text-white/40 italic">{pair.q}</span>
                <span className="text-white/25 mx-1">·</span>
                <span className="text-white/80 font-medium">{pair.a}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-end gap-1.5">
        {msg.images && msg.images.length > 0 && (
          <div className="flex gap-2 flex-wrap justify-end">
            {msg.images.map(img => (
              <a
                key={img.id}
                href={`${IMAGE_API_URL}/api/images/${img.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={`${IMAGE_API_URL}/api/images/${img.id}`}
                  alt={img.filename}
                  className="h-40 max-w-[280px] object-cover rounded-xl border border-white/10 hover:opacity-90 transition-opacity"
                />
              </a>
            ))}
          </div>
        )}
        {msg.content && (
          <div
            style={{ borderRadius: '15px', background: '#373737', padding: '10px 15px' }}
            className="max-w-[90%] text-white text-[12.5px] shadow-md font-sans"
          >
            <AgentMarkdown content={msg.content} />
          </div>
        )}
      </div>
    );
  }

  // ── write_file / edit_file — streaming ──
  if (msg.toolCall && FILE_WRITE_TOOLS.has(toolLower) && msg.eventType === 'TOOL_STARTED' && msg.toolArgsStream) {
    const { path, content } = parseStreamingArgs(msg.toolArgsStream);
    return (
      <div className="max-w-[540px] px-2">
        <StreamingCodeBlock path={path} content={content} />
      </div>
    );
  }

  // ── write_file / edit_file — completed ──
  if (msg.toolCall && FILE_WRITE_TOOLS.has(toolLower) && msg.eventType === 'TOOL_COMPLETED' && msg.toolArgs) {
    const p = getFilePathFromArgs(msg.toolArgs);
    return (
      <div className="max-w-[540px] w-full px-2 mb-3">
        <FinishedCodeBlock
          path={p}
          content={msg.toolArgs.content}
          find={msg.toolArgs.find || msg.toolArgs.old_str}
          replace={msg.toolArgs.replace || msg.toolArgs.new_str}
          isSplit={isSplit}
        />
      </div>
    );
  }

  // ── shell tools ──
  if (msg.toolCall && (SHELL_TOOLS.has(toolLower) || (
    !FILE_WRITE_TOOLS.has(toolLower) && !FILE_READ_TOOLS.has(toolLower) &&
    (toolLower.includes('execute') || toolLower.includes('shell') || toolLower.includes('command') || toolLower.includes('terminal') || toolLower.includes('bash'))
  ))) {
    const cmd = getCommandFromArgs(msg.toolCall, msg.toolArgs || msg.commandExecution ? { command: msg.commandExecution?.command } : undefined);
    const output = msg.commandExecution?.output;
    const running = msg.eventType === 'TOOL_STARTED' && isStreaming;
    return (
      <div className="px-2 max-w-[420px]">
        <ShellBlock command={cmd || msg.toolCall} output={output} isRunning={running} />
      </div>
    );
  }

  // ── search_code / web_search ──
  if (toolLower === 'search_code' || toolLower === 'web_search') {
    const running = msg.eventType === 'TOOL_STARTED' && isStreaming;
    return (
      <div className="px-2 max-w-[420px]">
        <SearchBlock
          kind={toolLower === 'web_search' ? 'web' : 'code'}
          query={msg.toolArgs?.query}
          output={msg.commandExecution?.output}
          isRunning={running}
        />
      </div>
    );
  }

  // ── check_health ──
  if (toolLower === 'check_health') {
    const running = msg.eventType === 'TOOL_STARTED' && isStreaming;
    return (
      <div className="px-2 max-w-[420px]">
        <HealthBlock
          port={msg.toolArgs?.port}
          output={msg.commandExecution?.output}
          isRunning={running}
        />
      </div>
    );
  }

  // ── read / generic file tools ──
  if (msg.toolCall && (FILE_READ_TOOLS.has(toolLower) || toolLower.includes('file') || toolLower.includes('read'))) {
    const fp = getFilePathFromArgs(msg.toolArgs);
    const running = msg.eventType === 'TOOL_STARTED' && isStreaming;
    return (
      <div className="px-2 max-w-[420px]">
        <FileBlock action={msg.toolCall.replace(/_/g, ' ')} filePath={fp || msg.toolCall} isRunning={running} />
      </div>
    );
  }

  // ── submit_plan_questions — interactive artifact ──
  if (msg.toolCall === 'submit_plan_questions') {
    return (
      <div className="px-2 max-w-[480px]">
        <PlanQuestionsArtifact
          questions={msg.toolArgs?.questions || []}
          summary={msg.toolArgs?.summary}
          onSubmit={onPlanAnswer}
        />
      </div>
    );
  }

  // ── Any other tool with toolCall ──
  if (msg.toolCall) {
    const running = msg.eventType === 'TOOL_STARTED' && isStreaming;
    return (
      <div className="px-2 max-w-[420px]">
        <FileBlock action={msg.toolCall.replace(/_/g, ' ')} filePath={getFilePathFromArgs(msg.toolArgs)} isRunning={running} />
      </div>
    );
  }

  // ── Historical sub-agent summary ──
  if (msg.eventType === 'SUB_AGENT_SUMMARY' && msg.subAgentSummary && msg.subAgentSummary.length > 0) {
    return (
      <div className="w-full">
        <div className="rounded-2xl border border-white/[0.07] bg-[#1c1c1e] overflow-hidden py-1">
          <SubAgentPanel agents={msg.subAgentSummary} />
        </div>
      </div>
    );
  }

  // ── Thinking/reasoning ──
  if (msg.eventType === 'AGENT_REASONING' || msg.eventType === 'LLM_THINKING') {
    const text = msg.thinking || msg.content;
    if (!text) return null;
    // If it has thinking field (true internal reasoning), show as plain italic
    // If it only has content (streamed agent text saved with AGENT_REASONING event), render markdown
    if (msg.thinking && !msg.content) {
      return (
        <div className="w-full px-4 py-1">
          <span className="text-[11px] text-white/60 italic leading-relaxed whitespace-pre-wrap">{text}</span>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start">
        <div className="max-w-[92%] bg-transparent text-white/75 w-full px-3 py-1.5 text-[12.5px] leading-relaxed font-sans">
          <AgentMarkdown content={text} />
        </div>
      </div>
    );
  }

  // ── Skill activated ──
  if (msg.eventType === 'SKILL_ACTIVATED') {
    const match = msg.content.match(/^Using (.+?) skill$/i);
    const skillName = match ? match[1] : msg.content;
    return (
      <div className="px-2 max-w-[420px]">
        <SkillBlock skillName={skillName} />
      </div>
    );
  }

  // ── Regular text message ──
  if (!msg.content) return null;
  // Suppress internal agent protocol messages
  if (
    /FINAL ANSWER/i.test(msg.content) ||
    msg.content.includes('All todos have been completed') ||
    msg.content.includes('All todos completed') ||
    msg.eventType === 'ALL_TODOS_COMPLETE'
  ) return null;
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[92%] bg-transparent text-white/75 w-full px-3 py-1.5 text-[12.5px] leading-relaxed font-sans">
        <AgentMarkdown content={msg.content} />
        {isStreaming && msg.eventType !== 'TOOL_COMPLETED' && <StreamingCursor />}
        {msg.modifiedFiles && msg.modifiedFiles.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-white/[0.07] w-full">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-bold uppercase tracking-widest text-white/30">Files Modified</span>
              <span className="bg-white/10 text-white/50 px-1.5 py-0.5 rounded-full text-[9px] font-semibold">{msg.modifiedFiles.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {msg.modifiedFiles.map((f, i) => {
                const fileName = f.split('/').pop() || f;
                const iconSrc = getMaterialFileIcon(fileName);
                return (
                  <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 border border-white/[0.08] hover:bg-white/10 transition-colors max-w-[160px] cursor-default">
                    <img src={iconSrc} alt="" className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-[11px] text-white/60 font-mono truncate">{fileName}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Demo messages ────────────────────────────────────────────────────────────
type DemoBlock =
  | { type: "text"; content: string; isStreaming?: boolean }
  | { type: "shell"; command: string; details?: string }
  | { type: "file"; action: string; filePath: string }
  | { type: "code"; language: string; code: string };

interface DemoMessage {
  id: string;
  sender: "user" | "assistant";
  blocks: DemoBlock[];
}

const INITIAL_MESSAGES: DemoMessage[] = [
  { id: "init", sender: "assistant", blocks: [{ type: "text", content: "Hello! I am AI Agents. What can I build or edit for you today?" }] }
];


// ─── Main ChatPane ────────────────────────────────────────────────────────────
export default function ChatPane({
  viewMode,
  wsMessages,
  isAgentRunning,
  onRealSubmit,
  onStop,
  isPlanMode,
  onPlanModeChange,
  isMultiAgent,
  onMultiAgentChange,
  planQuestions,
  onPlanAnswer,
  planReady,
  onBuildPlan,
  isLoadingHistory,
  hasMoreHistory,
  onLoadMore,
  todos,
  subAgentStates,
  subAgentIsLive,
  wsRef,
  sandboxId,
  sessionStats,
  agentStartedAt,
  workspaceId,
}: ChatPaneProps) {
  const isRealMode = !!wsMessages;

  const [demoMessages, setDemoMessages] = useState<DemoMessage[]>(INITIAL_MESSAGES);
  const [inputValue, setInputValue] = useState("");
  const [demoStatus, setDemoStatus] = useState<"idle" | "running" | "completed">("completed");
  const [showTodos, setShowTodos] = useState(false);

  const effectiveRunning = isRealMode ? (isAgentRunning ?? false) : demoStatus === "running";
  const hasTodos = !!todos && todos.length > 0;

  // ── Message queue (while agent is running) ──────────────────────────────────
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const prevRunningRef = useRef(isAgentRunning);

  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isAgentRunning;
    if (wasRunning && !isAgentRunning && messageQueue.length > 0) {
      const toSend = [...messageQueue];
      setMessageQueue([]);
      if (toSend.length === 1) {
        onRealSubmit?.(toSend[0]);
      } else {
        const combined = `[Multiple queued requests — please address all in order:]\n${toSend.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
        onRealSubmit?.(combined);
      }
    }
  }, [isAgentRunning]);

  const handleRealSubmitWithQueue = useCallback((text: string, images?: import('@/app/system/[id]/_types/system').ChatImage[]) => {
    if (isAgentRunning && isRealMode) {
      setMessageQueue(prev => [...prev, text]);
      return;
    }
    onRealSubmit?.(text, images);
  }, [isAgentRunning, isRealMode, onRealSubmit]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Tracks how many times user tried to scroll up while agent is running
  const scrollUpAttemptsRef = useRef(0);
  const [userUnlocked, setUserUnlocked] = useState(false);

  const scrollToBottom = () => {
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" });
    scrollUpAttemptsRef.current = 0;
    setUserUnlocked(false);
    setIsAtBottom(true);
  };

  // Reset unlock when agent stops
  useEffect(() => {
    if (!effectiveRunning) {
      scrollUpAttemptsRef.current = 0;
      setUserUnlocked(false);
    }
  }, [effectiveRunning]);

  // Auto-scroll to bottom on new messages unless user has unlocked free scroll
  useEffect(() => {
    if (!userUnlocked) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [wsMessages, demoMessages, planQuestions, userUnlocked]);

  const handleLoadMore = () => {
    const el = scrollContainerRef.current;
    if (!el) { onLoadMore?.(); return; }
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    setUserUnlocked(true);
    onLoadMore?.();
    // After DOM settles, restore relative scroll position
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight - prevHeight + prevTop;
        }
      });
    });
  };

  const handleScrollContainerScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setIsAtBottom(atBottom);
    if (atBottom) {
      scrollUpAttemptsRef.current = 0;
      setUserUnlocked(false);
    }
  };

  const handleWheelOnChat = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!effectiveRunning || userUnlocked) return;
    if (e.deltaY < 0) {
      scrollUpAttemptsRef.current += 1;
      if (scrollUpAttemptsRef.current >= 2) setUserUnlocked(true);
    }
  };

  const handleDemoSubmit = () => {
    if (!inputValue.trim() || demoStatus === "running") return;
    const userText = inputValue;
    setInputValue("");
    setDemoStatus("running");
    setDemoMessages(prev => [...prev, { id: Date.now().toString(), sender: "user", blocks: [{ type: "text", content: userText }] }]);
    setTimeout(() => {
      setDemoMessages(prev => [...prev, { id: `${Date.now()}-a`, sender: "assistant", blocks: [{ type: "text", content: "Before I begin building, let me gather a few details to ensure the final product matches your requirements.", isStreaming: true }] }]);
    }, 800);
    setTimeout(() => {
      setDemoMessages(prev => [...prev, { id: `${Date.now()}-b`, sender: "assistant", blocks: [{ type: "shell", command: "ls workspace/frontend/components/", details: "Button, Input, Checkbox, Card" }] }]);
    }, 3500);
    setTimeout(() => {
      setDemoMessages(prev => [...prev, { id: `${Date.now()}-c`, sender: "assistant", blocks: [{ type: "file", action: "Read File", filePath: "/workspace/app/page.tsx" }] }]);
    }, 5000);
    setTimeout(() => {
      setDemoMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.sender === "assistant") {
          const tb = last.blocks.find(b => b.type === "text");
          if (tb?.type === "text") tb.isStreaming = false;
        }
        return [...updated, { id: `${Date.now()}-d`, sender: "assistant", blocks: [{ type: "code", language: "typescript", code: `import { useState } from 'react';\n\nexport default function App() {\n  const [items, setItems] = useState([]);\n  return <div>Hello World</div>;\n}` }] }];
      });
      setDemoStatus("completed");
    }, 7000);
  };

  return (
    <motion.div
      layout
      initial={false}
      animate={{
        width: viewMode === 'chat' ? '100%' : viewMode === 'split' ? '520px' : '0px',
        opacity: viewMode === 'preview' ? 0 : 1
      }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`relative flex flex-col h-full shrink-0 border-r border-white/5 bg-[#161616] ${viewMode === 'chat' ? 'border-r-0' : ''}`}
      style={{ display: viewMode === 'preview' ? 'none' : 'flex', overflow: 'hidden' }}
    >
      {/* ── Chat History ── */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScrollContainerScroll}
        onWheel={handleWheelOnChat}
        className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 scrollbar-none"
      >
        <div className={`flex flex-col gap-3 ${viewMode === 'chat' ? 'max-w-4xl mx-auto w-full' : 'w-full'}`}>

          {isRealMode && hasMoreHistory && (
            <div className="flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={isLoadingHistory}
                className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50"
              >
                {isLoadingHistory ? "Loading..." : "Load earlier messages"}
              </button>
            </div>
          )}

          {isRealMode ? (() => {
            const msgs = wsMessages ?? [];
            const hasLiveAgents = subAgentIsLive && subAgentStates && Object.keys(subAgentStates).length > 0;
            return (
              <>
                <AnimatePresence initial={false}>
                  {msgs.map((msg, i) => (
                    <React.Fragment key={msg.id}>
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, transition: { duration: 0.15 } }}
                        transition={{ duration: 0.25 }}
                      >
                        <RealMessage
                          msg={msg}
                          isLast={i === msgs.length - 1}
                          isAgentRunning={isAgentRunning}
                          isSplit={viewMode === 'split'}
                          onPlanAnswer={onPlanAnswer ? (answers) => onPlanAnswer(answers, planQuestions) : undefined}
                        />
                      </motion.div>
                    </React.Fragment>
                  ))}
                </AnimatePresence>
                {/* Live SubAgentPanel always at the bottom, after all messages */}
                {hasLiveAgents && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="w-full"
                  >
                    <div className="rounded-2xl border border-white/[0.07] bg-[#1c1c1e] overflow-hidden py-1">
                      <SubAgentPanel agents={subAgentStates!} />
                    </div>
                  </motion.div>
                )}
              </>
            );
          })() : (
            <AnimatePresence initial={false}>
              {demoMessages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className={`flex flex-col ${message.sender === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    style={message.sender === 'user' ? { borderRadius: '15px', background: '#373737', padding: '10px 15px' } : undefined}
                    className={message.sender === 'user'
                      ? 'max-w-[90%] text-white text-[12.5px] leading-relaxed shadow-md font-sans'
                      : 'max-w-[90%] bg-transparent text-white/55 w-full px-3 py-2 text-[12.5px] leading-relaxed'
                    }
                  >
                    {message.blocks.map((block, idx) => {
                      if (block.type === "text") {
                        return (
                          <div key={idx} className="font-sans">
                            {block.isStreaming
                              ? <><AgentMarkdown content={block.content} /><StreamingCursor /></>
                              : <AgentMarkdown content={block.content} />
                            }
                          </div>
                        );
                      }
                      if (block.type === "shell") {
                        return <ShellBlock key={idx} command={block.command} output={block.details} />;
                      }
                      if (block.type === "file") {
                        return <FileBlock key={idx} action={block.action} filePath={block.filePath} />;
                      }
                      if (block.type === "code") {
                        return <FinishedCodeBlock key={idx} path={`file.${block.language}`} content={block.code} />;
                      }
                      return null;
                    })}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          )}

          {/* Plan Ready Card */}
          {isRealMode && planReady && onBuildPlan && (
            <PlanReadyCard data={planReady} onBuild={onBuildPlan} />
          )}

          {/* Agent Status Logo */}
          {isRealMode && !planQuestions && !(subAgentIsLive && subAgentStates && Object.keys(subAgentStates).length > 0) && (
            <div className="px-4">
              <AgentStatusLogo isRunning={isAgentRunning ?? false} />
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Scroll to bottom button ── */}
      <AnimatePresence>
        {!isAtBottom && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            className="absolute bottom-[88px] right-4 z-10"
          >
            <button
              onClick={scrollToBottom}
              className="flex items-center justify-center w-7 h-7 rounded-full bg-[#2a2a2d] border border-white/10 hover:bg-[#333] hover:border-white/20 text-white/60 hover:text-white/90 shadow-lg transition-all"
              aria-label="Scroll to bottom"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bottom: Input ── */}
      <div className={`shrink-0 bg-[#161616] ${viewMode === 'chat' ? 'max-w-4xl mx-auto w-full' : 'w-full'}`}>
        <div className="p-3 pb-5">
          <SystemInputBar
            status={effectiveRunning ? "running" : "completed"}
            inputValue={isRealMode ? inputValue : undefined}
            onInputChange={isRealMode ? setInputValue : undefined}
            onSubmit={isRealMode ? undefined : handleDemoSubmit}
            onRealSubmit={isRealMode ? handleRealSubmitWithQueue : undefined}
            onStop={onStop}
            isRunning={effectiveRunning}
            isPlanMode={isPlanMode}
            onPlanModeChange={onPlanModeChange}
            isMultiAgent={isMultiAgent}
            onMultiAgentChange={onMultiAgentChange}
            showTodos={showTodos}
            onToggleTodos={() => setShowTodos(v => !v)}
            hasTodos={hasTodos}
            todos={todos}
            planQuestions={planQuestions}
            onPlanAnswer={onPlanAnswer}
            wsRef={wsRef}
            sandboxId={sandboxId}
            sessionStats={sessionStats}
            agentStartedAt={agentStartedAt}
            queuedMessages={messageQueue}
            workspaceId={workspaceId}
          />
        </div>
      </div>
    </motion.div>
  );
}
