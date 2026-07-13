"use client";

import { ArrowLeft, MessageSquare, LayoutPanelLeft, Maximize2, BarChart2, GitBranch, Loader, ExternalLink, CheckCircle2, ChevronDown, RefreshCw, Unplug, X } from 'lucide-react';
import { useRouter, useParams } from 'next/navigation';
import { useUser, useAuth } from "@/lib/auth-client";
import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

interface SystemHeaderProps {
  viewMode: "chat" | "split" | "preview";
  setViewMode: (mode: "chat" | "split" | "preview") => void;
  projectName?: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export default function SystemHeader({
  viewMode,
  setViewMode,
  projectName = "My Project",
  workspaceId,
  workspaceName,
}: SystemHeaderProps) {
  const router = useRouter();
  const params = useParams();
  const { user } = useUser();
  const { getToken } = useAuth();
  const systemId = params?.id as string | undefined;

  // ── GitHub sync status state ──────────────────────────────────────────────
  const [githubConnected, setGithubConnected] = React.useState<boolean | null>(null);
  const [githubWebUrl, setGithubWebUrl] = React.useState<string | null>(null);
  const [githubOAuthConnected, setGithubOAuthConnected] = React.useState<boolean | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [syncDone, setSyncDone] = React.useState(false);
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const [showConnectModal, setShowConnectModal] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const connectJobRef = React.useRef<string | null>(null);

  React.useEffect(() => { setMounted(true); }, []);

  // Fetch GitHub connection info
  React.useEffect(() => {
    if (!workspaceName || !workspaceId) {
      setGithubConnected(false);
      return;
    }
    (async () => {
      try {
        const token = await getToken();

        // Check OAuth status upfront
        const statusRes = await fetch(`${API_URL}/api/github/status`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        const statusData = statusRes?.ok ? await statusRes.json() : null;
        setGithubOAuthConnected(statusData?.isConnected ?? false);

        const res = await fetch(`${API_URL}/api/coregit/${workspaceName}/info`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setGithubConnected(false);
          return;
        }
        const data = await res.json();
        setGithubConnected(data?.githubConnected ?? false);
        setGithubWebUrl(data?.webUrl ?? null);

        // Check for errors in workspace config
        const wsRes = await fetch(`${API_URL}/api/workspaces/detail/${workspaceId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (wsRes.ok) {
          const ws = await wsRes.json();
          const config = ws?.config || {};
          if (config.lastGithubError) {
            setConnectError(config.lastGithubError);
          }
        }
      } catch {
        setGithubConnected(false);
      }
    })();
  }, [workspaceName, workspaceId, getToken]);

  // Auto-resume connect after returning from OAuth
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('github-oauth') !== 'done') return;
    window.history.replaceState(null, '', window.location.pathname);
    setGithubOAuthConnected(true);
    if (workspaceId && user?.id) handleConnectGithub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user?.id]);

  const handleConnectGithub = React.useCallback(async () => {
    if (!workspaceId || !user?.id) return;
    setConnecting(true);
    setConnectError(null);

    try {
      const token = await getToken();

      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/connect-github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connect failed');
      connectJobRef.current = data.jobId;

      const poll = setInterval(async () => {
        const jobId = connectJobRef.current;
        if (!jobId) { clearInterval(poll); return; }
        const freshToken = await getToken();
        const sr = await fetch(
          `${API_URL}/api/workspaces/${workspaceId}/connect-github/status?jobId=${encodeURIComponent(jobId)}`,
          { headers: { Authorization: `Bearer ${freshToken}` } },
        ).catch(() => null);
        if (!sr?.ok) return;
        const sd = await sr.json();
        if (sd.status === 'completed') {
          clearInterval(poll);
          setConnecting(false);
          setShowConnectModal(false);
          const freshToken = await getToken();
          fetch(`${API_URL}/api/coregit/${workspaceName}/info`, {
            headers: { Authorization: `Bearer ${freshToken}` },
          })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) { setGithubConnected(d.githubConnected); setGithubWebUrl(d.webUrl); } })
            .catch(() => {});
        } else if (sd.status === 'failed') {
          clearInterval(poll);
          setConnecting(false);
          setConnectError(sd.failedReason || 'Connection failed');
        }
      }, 3000);
    } catch (err: any) {
      setConnecting(false);
      setConnectError(err.message || 'Failed to connect GitHub');
    }
  }, [workspaceId, workspaceName, user?.id, getToken]);

  const handleOAuthRedirect = React.useCallback(async () => {
    if (!user?.id) return;
    try {
      const token = await getToken();
      const returnTo = `${window.location.origin}${window.location.pathname}?github-oauth=done`;
      const connectUrl = new URL(`${API_URL}/api/github/connect`);
      connectUrl.searchParams.set('returnTo', returnTo);
      const res = await fetch(connectUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to get OAuth URL');
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      setConnectError(err.message || 'Failed to initiate GitHub OAuth');
    }
  }, [user?.id, getToken]);

  const handleForceSync = React.useCallback(async () => {
    if (!workspaceId) return;
    setConnecting(true);
    setConnectError(null);

    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/force-github-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Force sync failed');

      const jobId = data.jobId;
      const poll = setInterval(async () => {
        const freshToken = await getToken();
        const sr = await fetch(
          `${API_URL}/api/workspaces/${workspaceId}/connect-github/status?jobId=${encodeURIComponent(jobId)}`,
          { headers: { Authorization: `Bearer ${freshToken}` } },
        ).catch(() => null);

        if (!sr?.ok) return;
        const sd = await sr.json();

        if (sd.status === 'completed') {
          clearInterval(poll);
          setConnecting(false);
          setSyncDone(true);
          setTimeout(() => setSyncDone(false), 2500);
        } else if (sd.status === 'failed') {
          clearInterval(poll);
          setConnecting(false);
          setConnectError(sd.failedReason || 'Sync failed');
        }
      }, 3000);
    } catch (err: any) {
      setConnecting(false);
      setConnectError(err.message || 'Failed to start force sync');
    }
  }, [workspaceId, getToken]);

  const handleDisconnect = React.useCallback(async () => {
    if (!confirm('Disconnect GitHub? Workspace will no longer sync to GitHub.')) return;

    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/github/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to disconnect');

      setGithubConnected(false);
      setGithubWebUrl(null);
      setConnectError(null);
    } catch (err: any) {
      setConnectError(err.message || 'Failed to disconnect');
    }
  }, [getToken]);

  // ── GitHub pill rendering ─────────────────────────────────────────────────
  function GithubPill() {
    // Still loading — show nothing to avoid flash
    if (githubConnected === null || githubOAuthConnected === null) return null;

    // Connected ✓ (Premium Dropdown)
    if (githubConnected && githubWebUrl) {
      const repoPath = githubWebUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '');

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title="GitHub sync options"
              className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/[0.14] transition-all duration-200 cursor-pointer data-[state=open]:bg-white/[0.08] data-[state=open]:border-white/20"
            >
              <div className="flex items-center">
                <div className="relative z-10 w-[18px] h-[18px] rounded-full ring-[1.5px] ring-[#1C1C1D] overflow-hidden shrink-0">
                  {user?.imageUrl ? (
                    <img src={user.imageUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-white/10 flex items-center justify-center text-[8px] text-white/50">
                      {user?.firstName?.[0] ?? '?'}
                    </div>
                  )}
                </div>
                <div className="relative -ml-2 w-[18px] h-[18px] rounded-full ring-[1.5px] ring-[#1C1C1D] overflow-hidden shrink-0 bg-[#24292f]">
                  <img src="/icons/github.png" alt="GitHub" className="w-full h-full object-cover invert" />
                </div>
              </div>
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              <ChevronDown size={10} className="text-white/30 group-hover:text-white/60 transition-colors -ml-1" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={8} className="w-64 bg-[#1C1C1D] border-white/[0.08] p-1.5 shadow-2xl rounded-xl">
            <div className="px-2 py-2.5 flex flex-col gap-0.5">
              <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Repository</span>
              <span className="text-[12px] font-medium text-white/90 truncate">{repoPath}</span>
            </div>

            <DropdownMenuSeparator className="bg-white/[0.06] -mx-1" />

            <DropdownMenuGroup className="py-1">
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-[12px] focus:bg-white/[0.06] focus:text-white py-2"
                onClick={() => window.open(githubWebUrl, '_blank')}
              >
                <ExternalLink size={13} className="mr-2 text-white/50" />
                <span>View on GitHub</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-[12px] focus:bg-white/[0.06] focus:text-white py-2 disabled:opacity-50"
                onSelect={(e) => { e.preventDefault(); if (!connecting && !syncDone) handleForceSync(); }}
                disabled={connecting || syncDone}
              >
                {syncDone ? (
                  <>
                    <CheckCircle2 size={13} className="mr-2 text-emerald-400" />
                    <span className="text-emerald-400">Synced</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={13} className={`mr-2 ${connecting ? 'animate-spin' : 'text-white/50'}`} />
                    <span>{connecting ? 'Syncing…' : 'Sync now'}</span>
                  </>
                )}
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <DropdownMenuSeparator className="bg-white/[0.06] -mx-1" />

            <DropdownMenuGroup className="py-1">
              <DropdownMenuItem
                className="cursor-pointer rounded-lg text-[12px] text-red-400 focus:bg-red-500/10 focus:text-red-300 py-2"
                onClick={handleDisconnect}
              >
                <Unplug size={13} className="mr-2 text-red-400/70" />
                <span>Disconnect GitHub</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    // Connecting in progress
    if (connecting) {
      return (
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-white/40 bg-white/[0.03] border border-white/[0.08]">
          <Loader size={11} className="animate-spin" />
          <span>Connecting…</span>
        </div>
      );
    }

    const githubPillContent = (label: string) => (
      <>
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt="" className="w-6 h-6 rounded-full object-cover shrink-0 ring-[1.5px] ring-[#1C1C1D] relative z-10" />
        ) : (
          <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[9px] text-white/50 shrink-0 ring-[1.5px] ring-[#1C1C1D] relative z-10">
            {user?.firstName?.[0] ?? '?'}
          </div>
        )}
        <div className="-ml-2 pl-4 pr-2.5 py-[5px] rounded-full bg-[#282828] hover:bg-[#313131] border border-white/[0.09] flex items-center gap-1 transition-colors relative z-0">
          <svg viewBox="0 0 16 16" className="w-3 h-3 fill-current shrink-0 text-white" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span className="text-[11.5px] font-medium text-white relative z-10">{label}</span>
        </div>
      </>
    );

    // User not OAuth'd
    if (!githubOAuthConnected) {
      return (
        <button onClick={handleOAuthRedirect} className="flex items-center cursor-pointer">
          {githubPillContent('Link Github')}
        </button>
      );
    }

    // OAuth done, workspace not connected
    return (
      <button onClick={() => setShowConnectModal(true)} title={connectError || 'Connect workspace to GitHub'} className="flex items-center cursor-pointer">
        {githubPillContent(connectError ? 'Retry Github' : 'Link Github')}
      </button>
    );
  }

  return (
    <>
      <header className="h-[52px] flex items-center justify-between px-6 border-b border-white/5 shrink-0 bg-[#1C1C1D]">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')} className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={16} />
          </button>
          <span className="font-medium text-[13px] text-gray-200 truncate max-w-[200px]">{projectName}</span>
        </div>

        <div className="flex items-center gap-2">
          {workspaceId && <GithubPill />}

          <div className="w-px h-4 bg-white/[0.08]" />

          {systemId && (
            <button
              onClick={() => router.push(`/system/${systemId}/analytics`)}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-all"
              title="Analytics"
            >
              <BarChart2 size={15} />
            </button>
          )}

          <div className="flex items-center bg-black/20 p-1 rounded-lg border border-white/5">
            <button
              onClick={() => setViewMode('chat')}
              className={`px-3 py-1 text-[12px] rounded-md flex items-center gap-2 transition-all ${viewMode === 'chat' ? 'bg-[#3E3D3D] text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}
            >
              <MessageSquare size={13} /> Chat
            </button>
            <button
              onClick={() => setViewMode('split')}
              className={`px-3 py-1 text-[12px] rounded-md flex items-center gap-2 transition-all ${viewMode === 'split' ? 'bg-[#3E3D3D] text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}
            >
              <LayoutPanelLeft size={13} /> Split
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={`px-3 py-1 text-[12px] rounded-md flex items-center gap-2 transition-all ${viewMode === 'preview' ? 'bg-[#3E3D3D] text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}
            >
              <Maximize2 size={13} /> Preview
            </button>
          </div>
        </div>
      </header>

      {/* Connect GitHub modal */}
      {mounted && createPortal(
        <AnimatePresence>
          {showConnectModal && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center">
              <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={() => !connecting && setShowConnectModal(false)}
              />
              <motion.div
                key="modal"
                initial={{ scale: 0.96, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.96, opacity: 0, y: 8 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="relative w-[380px] rounded-2xl border border-white/[0.08] bg-[#1C1C1D] shadow-2xl p-6 flex flex-col gap-5 z-[201]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Close */}
                <button
                  onClick={() => setShowConnectModal(false)}
                  disabled={connecting}
                  className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                >
                  <X size={15} />
                </button>

                {/* Avatar pair */}
                <div className="flex justify-center pt-1">
                  <div className="relative flex items-center">
                    <div className="w-14 h-14 rounded-full ring-2 ring-[#1C1C1D] overflow-hidden z-10 shadow-lg">
                      {user?.imageUrl ? (
                        <img src={user.imageUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-white/10 flex items-center justify-center text-lg text-white/50">
                          {user?.firstName?.[0] ?? '?'}
                        </div>
                      )}
                    </div>
                    <div className="w-14 h-14 rounded-full ring-2 ring-[#1C1C1D] overflow-hidden -ml-4 bg-[#24292f] shadow-lg">
                      <img src="/icons/github.png" alt="GitHub" className="w-full h-full object-cover invert" />
                    </div>
                  </div>
                </div>

                {/* Text */}
                <div className="flex flex-col gap-1.5 text-center">
                  <span className="text-white text-[14px] font-semibold">Connect to GitHub</span>
                  <p className="text-white/40 text-[12px] leading-relaxed">
                    Sync this workspace to a GitHub repository. Changes will be pushed automatically.
                  </p>
                  {connectError && (
                    <p className="text-red-400 text-[11px] mt-1">{connectError}</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowConnectModal(false)}
                    className="flex-1 py-2.5 rounded-xl text-[12px] font-medium text-white/40 hover:text-white/70 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConnectGithub}
                    disabled={connecting}
                    className="flex-1 py-2.5 rounded-xl text-[12px] font-medium text-white bg-[#24292f] hover:bg-[#2d333b] border border-white/[0.12] hover:border-white/20 transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {connecting ? (
                      <RefreshCw size={13} className="animate-spin shrink-0" />
                    ) : (
                      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-current shrink-0" aria-hidden>
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                    )}
                    {connecting ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
