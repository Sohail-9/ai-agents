"use client";

interface CaseStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  OPEN: { label: 'Open', className: 'bg-amber-500/15 text-amber-400 border-amber-500/20' },
  RESOLVED: { label: 'Resolved', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20' },
  ESCALATED: { label: 'Escalated', className: 'bg-red-500/15 text-red-400 border-red-500/20' },
  CLOSED: { label: 'Closed', className: 'bg-white/5 text-white/40 border-white/10' },
};

export function CaseStatusBadge({ status, className = '' }: CaseStatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.OPEN;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${config.className} ${className}`}
    >
      {config.label}
    </span>
  );
}
