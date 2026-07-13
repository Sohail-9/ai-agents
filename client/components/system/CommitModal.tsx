'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUpRight, Loader, CheckCircle2, X, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { DirtyFile } from '@/contexts/DirtyStateContext';
import { FileStatusBadge } from './FileStatusBadge';
import { GlassButton } from '@/components/ui/glass-button';
import { useAuth } from "@/lib/auth-client";
import { getMaterialFileIcon } from 'file-extension-icon-js';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

interface CommitModalProps {
  open: boolean;
  onClose: () => void;
  dirtyFiles: Array<[string, DirtyFile]>;
  sandboxId: string | null;
  workspaceName: string | undefined;
  workspaceId: string | null;
  coregitNamespace: string | null;
  onSuccess: () => void;
}

function buildUnifiedDiff(dirtyFiles: Array<[string, DirtyFile]>): string {
  const patches: string[] = [];

  for (const [path, dirty] of dirtyFiles) {
    if (dirty.status === 'D') {
      const lineCount = (dirty.original.match(/\n/g) || []).length;
      patches.push(`--- a/${path}`);
      patches.push(`+++ /dev/null`);
      patches.push(`@@ -1,${lineCount} +0,0 @@`);
      dirty.original.split('\n').forEach((line) => {
        patches.push(`-${line}`);
      });
    } else {
      const oldLines = dirty.original.split('\n');
      const newLines = dirty.current.split('\n');
      patches.push(`--- a/${path}`);
      patches.push(`+++ b/${path}`);
      patches.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

      for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
        if (i < oldLines.length && i < newLines.length) {
          if (oldLines[i] !== newLines[i]) {
            patches.push(`-${oldLines[i]}`);
            patches.push(`+${newLines[i]}`);
          } else {
            patches.push(` ${oldLines[i]}`);
          }
        } else if (i < oldLines.length) {
          patches.push(`-${oldLines[i]}`);
        } else {
          patches.push(`+${newLines[i]}`);
        }
      }
    }
  }

  return patches.join('\n');
}

export function CommitModal({
  open,
  onClose,
  dirtyFiles,
  sandboxId,
  workspaceName,
  workspaceId,
  coregitNamespace,
  onSuccess,
}: CommitModalProps) {
  const { getToken } = useAuth();
  const [message, setMessage] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const generateCommitMessage = async () => {
    setIsGenerating(true);
    setPushError(null);
    try {
      if (!workspaceId) {
        throw new Error('Workspace ID is missing');
      }

      const diff = buildUnifiedDiff(dirtyFiles);
      if (!diff || diff.length === 0) {
        throw new Error('No changes to generate message for');
      }

      console.log('[CommitModal] Generating commit message for diff:', diff.slice(0, 100) + '...');

      const url = `${API_URL}/api/workspaces/${workspaceId}/generate-commit`;
      console.log('[CommitModal] Calling:', url);

      const token = await getToken();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ diff }),
      });

      console.log('[CommitModal] Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[CommitModal] API error:', errorText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Get the full text response (Qwen generates quickly, no need for streaming)
      const result = await response.text();
      console.log('[CommitModal] Generated message:', result);
      setMessage(result);
    } catch (err: any) {
      console.error('[CommitModal] Generation failed:', err);
      setPushError(`Failed to generate: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCommit = async () => {
    if (!message.trim()) {
      setPushError('Message required');
      return;
    }
    if (!workspaceId) {
      setPushError('Workspace ID missing');
      return;
    }

    setIsPushing(true);
    setPushError(null);

    try {
      const files = Array.from(dirtyFiles).map(([path, dirty]) => ({
        path,
        content: dirty.current,
      }));

      const token = await getToken();
      const response = await fetch(
        `${API_URL}/api/workspaces/${workspaceId}/commit-targeted`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            message: message.trim(),
            files,
            pushSandbox: true,
            pushCoregit: true,
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const { sha } = await response.json();

      setShowSuccess(true);
      await new Promise((r) => setTimeout(r, 1500));

      toast.success(`Committed · ${sha.slice(0, 7)}`, { duration: 3000 });
      onSuccess();
      onClose();
    } catch (err: any) {
      setPushError(err.message || 'Commit failed');
    } finally {
      setIsPushing(false);
      setShowSuccess(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center">
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            key="modal"
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="relative w-[440px] rounded-2xl border border-white/[0.08] bg-[#1C1C1D] shadow-2xl p-5 flex flex-col gap-4 max-h-[85vh] z-[201]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className="text-white text-sm font-semibold">Commit Changes</span>
              <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors cursor-pointer">
                <X size={15} />
              </button>
            </div>

            <p className="text-white/40 text-xs -mt-1">
              {dirtyFiles.length} file{dirtyFiles.length !== 1 ? 's' : ''} modified. Write a message or let AI generate one.
            </p>

            <div className="flex flex-col gap-3 overflow-y-auto pr-1 scrollbar-subtle">
              {/* Message input */}
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe what you changed…"
                rows={3}
                disabled={isGenerating}
                className={cn(
                  'w-full px-3 py-2.5 rounded-xl text-xs resize-none',
                  'bg-white/[0.02] border border-white/[0.08] transition-all',
                  'placeholder:text-white/20 text-white/80 disabled:opacity-50',
                  'focus:outline-none focus:border-white/20'
                )}
              />

              {/* AI Generate button */}
              <button
                type="button"
                onClick={generateCommitMessage}
                disabled={isGenerating || dirtyFiles.length === 0}
                className={cn(
                  'w-full py-2 rounded-xl text-[11px] font-medium transition-all duration-200',
                  'border border-brand-pink/20 bg-brand-pink/5 text-brand-pink',
                  'hover:bg-brand-pink/10 hover:border-brand-pink/30',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'flex items-center justify-center gap-1.5'
                )}
              >
                {isGenerating && <Loader size={12} className="animate-spin" />}
                {isGenerating ? 'Generating...' : message.trim() ? 'Regenerate' : 'Generate with AI'}
              </button>

              {/* Files changed section */}
              {dirtyFiles.length > 0 && (
                <div className="flex flex-col gap-2 mt-1">
                  <span className="text-white/50 text-[10px] font-medium uppercase tracking-wider">Files</span>
                  <div className="space-y-1.5 pr-1">
                    {dirtyFiles.map(([path, dirty]) => (
                      <div
                        key={path}
                        className="flex items-center justify-between px-3 py-2 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] transition-all"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FileStatusBadge status={dirty.status} />
                          <img src={getMaterialFileIcon(path.split('/').pop() || path)} alt="" className="w-3.5 h-3.5 shrink-0" />
                          <span className="text-[11px] text-white/70 truncate">{path}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {dirty.addedLines > 0 && (
                            <span className="text-emerald-400 text-[10px] font-semibold">+{dirty.addedLines}</span>
                          )}
                          {dirty.removedLines > 0 && (
                            <span className="text-red-400 text-[10px] font-semibold">−{dirty.removedLines}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Error message */}
            {pushError && (
              <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/20 bg-red-500/[0.08]">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-px" />
                <p className="text-[11px] text-red-300">{pushError}</p>
              </div>
            )}

            {/* Footer / Commit Button */}
            <GlassButton
              size="md"
              onClick={handleCommit}
              disabled={isPushing || !message.trim()}
              className="w-full justify-center mt-1"
            >
              {showSuccess ? (
                <>
                  <CheckCircle2 size={13} />
                  Done
                </>
              ) : isPushing ? (
                <>
                  <Loader size={13} className="animate-spin" />
                  Committing...
                </>
              ) : (
                <>
                  <ArrowUpRight size={13} />
                  Commit
                </>
              )}
            </GlassButton>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
