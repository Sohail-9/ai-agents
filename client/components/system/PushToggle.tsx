'use client';

import { cn } from '@/lib/utils';

interface PushToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function PushToggle({ label, checked, onChange }: PushToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'px-3 py-1.5 rounded-full font-medium text-[11px] transition-colors duration-150 flex-shrink-0',
        checked
          ? 'bg-[#E93D82] text-white'
          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
      )}
    >
      {label}
    </button>
  );
}
