'use client';

interface FileStatusBadgeProps {
  status: 'M' | 'A' | 'D';
}

export function FileStatusBadge({ status }: FileStatusBadgeProps) {
  const colors: Record<'M' | 'A' | 'D', { bg: string; text: string }> = {
    M: { bg: '#EF9F27', text: '#0d0d0f' },
    A: { bg: '#63C052', text: '#0d0d0f' },
    D: { bg: '#E24B4A', text: '#ffffff' },
  };

  const { bg, text } = colors[status];

  return (
    <span
      className="px-2 py-0.5 rounded font-mono font-bold text-[9px] flex-shrink-0"
      style={{
        backgroundColor: bg,
        color: text,
      }}
    >
      {status}
    </span>
  );
}
