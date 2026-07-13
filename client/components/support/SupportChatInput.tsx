"use client";

import { useRef, useEffect, useState, KeyboardEvent } from 'react';
import { ArrowUp, Paperclip, ChevronDown } from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
}

interface SupportChatInputProps {
  workspaces?: Workspace[];
  selectedWorkspaceId?: string;
  onWorkspaceChange?: (id: string) => void;
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SupportChatInput({
  workspaces = [],
  selectedWorkspaceId = '',
  onWorkspaceChange,
  onSend,
  disabled,
  isStreaming,
  value,
  onChange,
  placeholder,
}: SupportChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [wsOpen, setWsOpen] = useState(false);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }, [value]);

  useEffect(() => {
    if (!wsOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setWsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [wsOpen]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const submit = () => {
    if (!value.trim() || disabled || isStreaming) return;
    onSend(value.trim());
  };

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const workspaceLabel = selectedWorkspace?.name ?? 'Project_Name';
  const inputPlaceholder = isStreaming
    ? 'Agent is responding...'
    : (placeholder ?? 'Send a Message...');

  const canSend = !!value.trim() && !disabled && !isStreaming;

  return (
    <div className="rounded-xl border border-white/[0.08] overflow-visible focus-within:border-white/[0.13] transition-colors" style={{ background: '#1e1e1e' }}>

      {/* Workspace chip */}
      <div className="px-3 pt-2.5 pb-1.5">
        {onWorkspaceChange && workspaces.length > 0 ? (
          <div className="relative inline-block" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setWsOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/[0.1] bg-[#2a2a2a] hover:bg-[#303030] hover:border-white/[0.15] transition-colors cursor-pointer"
            >
              <span className="w-[7px] h-[7px] rounded-full bg-[#FF15DC] shrink-0" />
              <span className="text-[12px] text-white/55 leading-none">{workspaceLabel}</span>
              <ChevronDown className="w-3 h-3 text-white/30 shrink-0" />
            </button>
            {wsOpen && (
              <div className="absolute top-full left-0 mt-1.5 w-56 bg-[#2a2a2a] border border-white/[0.08] rounded-xl py-1 z-50 shadow-2xl">
                <button
                  type="button"
                  onClick={() => { onWorkspaceChange(''); setWsOpen(false); }}
                  className={`w-full text-left px-3.5 py-2 text-[12px] hover:bg-white/[0.04] transition-colors ${!selectedWorkspaceId ? 'text-white/80' : 'text-white/35'}`}
                >
                  General / Account
                </button>
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => { onWorkspaceChange(ws.id); setWsOpen(false); }}
                    className={`w-full text-left px-3.5 py-2 text-[12px] hover:bg-white/[0.04] transition-colors ${selectedWorkspaceId === ws.id ? 'text-white/80' : 'text-white/35'}`}
                  >
                    {ws.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/[0.08] bg-[#2a2a2a] w-fit">
            <span className="w-[7px] h-[7px] rounded-full bg-[#FF15DC] shrink-0" />
            <span className="text-[12px] text-white/55 leading-none">{workspaceLabel}</span>
            <ChevronDown className="w-3 h-3 text-white/30 shrink-0" />
          </div>
        )}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={inputPlaceholder}
        disabled={disabled || isStreaming}
        rows={2}
        className="w-full bg-transparent px-3.5 py-1 text-[14px] text-white/85 placeholder:text-white/25 focus:outline-none resize-none disabled:opacity-40 leading-relaxed"
        style={{ minHeight: 44, maxHeight: 180 }}
      />

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-3 pb-2.5">
        <button
          type="button"
          disabled
          className="p-1.5 rounded-lg text-white/20 cursor-not-allowed"
          title="Attach (coming soon)"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        <button
          onClick={submit}
          disabled={!canSend}
          title="Send"
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: canSend ? '#FF15DC' : 'rgba(255,255,255,0.07)' }}
        >
          <ArrowUp className="w-4 h-4 text-white" />
        </button>
      </div>
    </div>
  );
}
