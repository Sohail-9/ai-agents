"use client";

import { CheckCircle, Folder, Terminal, BookOpen, CheckCircle2, AlertTriangle, Code, RotateCcw } from 'lucide-react';

const TOOL_LABELS: Record<string, string> = {
  getUserWorkspaces: 'Checking your workspaces',
  getWorkspaceDetails: 'Reading workspace details',
  getRequestDetails: 'Looking up request',
  getSandboxLogs: 'Fetching sandbox logs',
  searchDocs: 'Searching documentation',
  resolveCase: 'Marking as resolved',
  escalateCase: 'Escalating to support team',
  reopenCase: 'Reopening case',
};

const TOOL_ICONS: Record<string, React.ElementType> = {
  getUserWorkspaces: Folder,
  getWorkspaceDetails: Folder,
  getRequestDetails: Code,
  getSandboxLogs: Terminal,
  searchDocs: BookOpen,
  resolveCase: CheckCircle2,
  escalateCase: AlertTriangle,
  reopenCase: RotateCcw,
};

interface ToolCallPillProps {
  toolName: string;
  status: 'calling' | 'done';
}

export function ToolCallPill({ toolName, status }: ToolCallPillProps) {
  const label = TOOL_LABELS[toolName] || toolName;
  const Icon = TOOL_ICONS[toolName] || Code;
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/8 bg-white/[0.03] w-fit text-[11px] text-white/40 mb-1.5"
      style={{ animation: 'fadeSlideIn 0.15s ease-out' }}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span>{label}</span>
      {status === 'calling' ? (
        <span
          className="w-1.5 h-1.5 rounded-full bg-white/30 shrink-0"
          style={{ animation: 'pulse 1s ease-in-out infinite' }}
        />
      ) : (
        <CheckCircle className="w-3 h-3 text-emerald-400/70 shrink-0" />
      )}
    </div>
  );
}
