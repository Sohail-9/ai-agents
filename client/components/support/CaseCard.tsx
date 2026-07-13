"use client";

import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { CaseStatusBadge } from './CaseStatusBadge';

interface CaseCardProps {
  caseId: string;
  caseNumber: number;
  title?: string | null;
  status: string;
  workspaceName?: string | null;
  messageCount?: number;
  updatedAt: string;
  firstMessagePreview?: string | null;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function CaseCard({
  caseId,
  caseNumber,
  title,
  status,
  workspaceName,
  messageCount,
  updatedAt,
  firstMessagePreview,
}: CaseCardProps) {
  const preview = firstMessagePreview
    ? firstMessagePreview.slice(0, 60) + (firstMessagePreview.length > 60 ? '...' : '')
    : null;

  return (
    <Link
      href={`/support/${caseId}`}
      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.07] bg-[#1e1e1e] hover:bg-[#232323] hover:border-white/[0.11] transition-colors group cursor-pointer"
    >
      {/* Left: number + title + preview */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[11px] font-mono text-white/25 shrink-0">#{caseNumber}</span>
          <span className="text-[13px] font-medium text-white/85 truncate">
            {title || 'Support case'}
          </span>
        </div>
        {preview && (
          <p className="text-[12px] text-white/30 truncate leading-relaxed">{preview}</p>
        )}
        {!preview && workspaceName && (
          <p className="text-[12px] text-white/25 truncate">{workspaceName}</p>
        )}
      </div>

      {/* Right: status + time */}
      <div className="flex items-center gap-2.5 shrink-0">
        {messageCount !== undefined && messageCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-white/20">
            <MessageSquare className="w-2.5 h-2.5" />
            {messageCount}
          </span>
        )}
        <span className="text-[11px] text-white/25">{relativeTime(updatedAt)}</span>
        <CaseStatusBadge status={status} />
      </div>
    </Link>
  );
}
