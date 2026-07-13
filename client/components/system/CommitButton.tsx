'use client';

import { cn } from '@/lib/utils';

interface CommitButtonProps {
  dirtyFileCount: number;
  onCommit: () => void;
  disabled?: boolean;
}

const GitCommitIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="flex-shrink-0">
    <circle cx="6" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    <line x1="6" y1="0" x2="6" y2="3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="6" y1="8.5" x2="6" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export function CommitButton({ dirtyFileCount, onCommit, disabled = false }: CommitButtonProps) {
  return (
    <button
      type="button"
      onClick={onCommit}
      disabled={disabled}
      className={cn(
        'relative flex items-center justify-center gap-1.5 px-2.5 py-1.5',
        'h-7 rounded-md',
        'bg-[#E93D82] text-white font-medium text-[11px]',
        'transition-all duration-150 ease-out',
        'hover:bg-[#d63275] hover:-translate-y-0.5',
        'active:translate-y-0.5 active:scale-[0.99]',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#E93D82] disabled:hover:translate-y-0',
        'whitespace-nowrap',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.12),_0_1px_4px_rgba(233,61,130,0.3)]'
      )}
    >
      <GitCommitIcon />
      <span>Commit</span>
      {dirtyFileCount > 0 && (
        <span className="flex items-center justify-center h-4 min-w-4 px-1 ml-0.5 rounded-sm bg-black/25 text-white text-[9px] font-semibold">
          {dirtyFileCount}
        </span>
      )}
    </button>
  );
}
