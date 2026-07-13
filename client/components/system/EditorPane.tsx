"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, type MutableRefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Eye, Code, Tablet, Monitor, ArrowUpRight, Rocket, History, GitCommit, RefreshCw, ChevronRight, Loader, Cloud, CheckCircle2, AlertCircle, X, ChevronDown, Globe, Server, Settings } from 'lucide-react';
import { GlassButton } from '@/components/ui/glass-button';
import { useUser, useAuth } from "@/lib/auth-client";
import { useRouter } from 'next/navigation';
import VisualEditorPanel, { type SelectedElement } from './VisualEditorPanel';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
import { getMaterialFileIcon, getMaterialFolderIcon } from 'file-extension-icon-js';
import { LoadingCarousel } from '@/components/ui/loading-carousel';
import { buildTree } from '@/app/system/[id]/_lib/file-tree';
import { HistoryTab } from '@/app/system/[id]/_components/history-tab';
import { CloudPanel } from '@/app/system/[id]/_components/cloud-panel';
import type { FileNode } from '@/app/system/[id]/_types/system';
import { DirtyStateProvider, useDirtyState } from '@/contexts/DirtyStateContext';
import CodeEditor from './CodeEditor';
import { CommitModal } from './CommitModal';
import { CommitButton } from './CommitButton';

interface EditorPaneProps {
  viewMode: "chat" | "split" | "preview";
  previewUrl?: string;
  wsRef?: MutableRefObject<WebSocket | null>;
  sandboxId?: string | null;
  workspaceName?: string;
  coregitNamespace?: string | null;
  workspaceId?: string | null;
  isResuming?: boolean;
}

interface OpenTab {
  path: string;
  content: string;
  originalContent: string;
  loading: boolean;
}

// ── Language helpers ──────────────────────────────────────────────────────────
function getLang(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
    yml: 'yaml', yaml: 'yaml', py: 'python', go: 'go', rs: 'rust',
    sh: 'bash', sql: 'sql',
  };
  return map[ext] || 'text';
}

function getPreferredOpenPaths(flat: FileNode[], root: string): string[] {
  const normalize = (p: string) => (p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').replace(/^\/+/, '');
  const rootN = normalize(root);
  const relSet = new Set(flat.map(f => {
    const p = normalize(f.path);
    if (rootN && p.startsWith(rootN + '/')) return p.slice(rootN.length + 1);
    return p;
  }).filter(Boolean));

  if (relSet.has('repo')) {
    const sub = [...relSet].filter(p => p.startsWith('repo/') && (p.endsWith('/src') || p.endsWith('/app')));
    const preferred = sub.sort((a, b) => a.length - b.length)[0];
    if (preferred) {
      const segs = preferred.split('/');
      const paths = ['repo'];
      let cur = '';
      for (const seg of segs) { cur = cur ? `${cur}/${seg}` : seg; if (!paths.includes(cur)) paths.push(cur); }
      return paths;
    }
    return ['repo'];
  }
  return ['frontend', 'frontend/app'].filter(p => relSet.has(p));
}

// ── Simple syntax highlighter ─────────────────────────────────────────────────
function HighlightedCode({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="flex gap-5 min-w-0">
      <div className="flex flex-col text-right text-[11px] text-gray-700 select-none shrink-0 font-mono leading-[1.65]">
        {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="flex-1 font-mono text-[12px] leading-[1.65] whitespace-pre min-w-0">
        {lines.map((line, li) => <CodeLine key={li} line={line} />)}
      </div>
    </div>
  );
}

function CodeLine({ line }: { line: string }) {
  if (!line.trim()) return <div className="h-[1.65em]" />;
  if (/^\s*(\/\/|#|\/\*|\*(?!\/)|\*$)/.test(line) || line.trim().startsWith('@tailwind'))
    return <div className="text-gray-600 italic">{line}</div>;
  const regex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:import|from|as|export|default|const|let|var|function|return|class|if|else|new|true|false|typeof|async|await|type|interface|extends|implements)\b|\b\d+\b|[a-zA-Z_]\w*|[^\w\s]+|\s+)/g;
  const parts: React.ReactNode[] = [];
  let m: RegExpExecArray | null; let k = 0;
  while ((m = regex.exec(line)) !== null) {
    const t = m[0];
    if (/^["'`]/.test(t)) parts.push(<span key={k++} className="text-amber-300">{t}</span>);
    else if (/^(import|from|as|export|default|const|let|var|function|return|class|if|else|new|true|false|typeof|async|await|type|interface|extends|implements)$/.test(t)) parts.push(<span key={k++} className="text-brand-pink">{t}</span>);
    else if (/^\d+$/.test(t)) parts.push(<span key={k++} className="text-orange-300">{t}</span>);
    else if (/^[a-zA-Z_]\w*$/.test(t)) parts.push(<span key={k++} className={line.charAt(regex.lastIndex) === '(' ? 'text-blue-300' : 'text-gray-300'}>{t}</span>);
    else parts.push(<span key={k++} className="text-gray-500">{t}</span>);
  }
  return <div className="min-h-[1.65em]">{parts}</div>;
}

// ── File tree node ────────────────────────────────────────────────────────────
function TreeNode({ node, depth, onFile, activeFile, dirtyFiles }: {
  node: FileNode; depth: number; onFile: (path: string) => void; activeFile: string | null; dirtyFiles: Map<string, any>;
}) {
  const [open, setOpen] = useState(node.isOpen ?? false);
  const name = node.path.split('/').filter(Boolean).pop() || node.path;
  const isDir = node.type === 'directory';
  const iconSrc = isDir
    ? getMaterialFolderIcon(name.toLowerCase(), open)
    : getMaterialFileIcon(name);
  const isDirty = dirtyFiles.has(node.path);

  if (isDir) return (
    <div>
      <button type="button" onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 py-[3px] rounded hover:bg-white/5 text-gray-400 hover:text-white transition-colors text-[12px] cursor-pointer"
        style={{ paddingLeft: `${depth * 12 + 8}px`, paddingRight: '8px' }}
      >
        <ChevronRight size={10} className={`shrink-0 text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`} />
        <img src={iconSrc} alt="" className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      {open && node.children?.map(child => (
        <TreeNode key={child.path} node={child} depth={depth + 1} onFile={onFile} activeFile={activeFile} dirtyFiles={dirtyFiles} />
      ))}
    </div>
  );

  const isActive = activeFile === node.path;
  return (
    <button type="button" onClick={() => onFile(node.path)}
      className={`w-full flex items-center gap-1.5 py-[3px] rounded transition-colors text-[12px] cursor-pointer ${isActive ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
      style={{ paddingLeft: `${depth * 12 + 8}px`, paddingRight: '8px' }}
    >
      <span className="w-3 shrink-0" />
      <img src={iconSrc} alt="" className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{name}</span>
      {isDirty && (
        <span className="text-[#EF9F27] text-[8px] ml-auto flex-shrink-0 transition-opacity duration-150">●</span>
      )}
    </button>
  );
}

// ── Inner component (uses DirtyStateContext) ────────────────────────────────────
function EditorPaneInner({ viewMode, previewUrl, wsRef, sandboxId, workspaceName, coregitNamespace, workspaceId, isResuming }: EditorPaneProps) {
  const { state: dirtyState, dispatch: dirtyDispatch } = useDirtyState();
  const { user } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'history' | 'cloud'>('preview');
  const [activeDevice, setActiveDevice] = useState<'pc' | 'phone'>('pc');

  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // ── Visual editor state ───────────────────────────────────────────────────
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const inspectorReadyRef = useRef(false);
  const [isVisualEditMode, setIsVisualEditMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [pendingStyleChanges, setPendingStyleChanges] = useState<Record<string, string>>({});
  const [pendingTextChange, setPendingTextChange] = useState<string | null>(null);
  const [pendingSrcChange, setPendingSrcChange] = useState<string | null>(null);
  const [isApplyingToCode, setIsApplyingToCode] = useState(false);
  // Tracks which element the pending changes belong to (may differ from selectedElement after switching)
  const pendingTargetRef = useRef<SelectedElement | null>(null);

  const fileCacheRef = useRef<Map<string, string>>(new Map());
  const pendingPathRef = useRef<string | null>(null);
  const activeTabPathRef = useRef<string | null>(null);
  activeTabPathRef.current = activeTabPath;
  const openTabsRef = useRef<OpenTab[]>([]);
  openTabsRef.current = openTabs;
  const wsInstanceRef = useRef<WebSocket | null>(null);
  const [wsVersion, setWsVersion] = useState(0);

  const activeTab_ = useMemo(() => openTabs.find(t => t.path === activeTabPath) || null, [openTabs, activeTabPath]);

  // ── Commit modal state ────────────────────────────────────────────────────────
  const [commitModalOpen, setCommitModalOpen] = useState(false);

  // ── Deploy state ─────────────────────────────────────────────────────────────
  const [isDeploying, setIsDeploying] = useState(false);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);
  const [deployFrontend, setDeployFrontend] = useState(true);
  const [deployBackend, setDeployBackend] = useState(false);


  const showNotification = useCallback((message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(prev => prev?.message === message ? null : prev), 5000);
  }, []);

  const handleDeploy = useCallback(async () => {
    if (!deployFrontend && !deployBackend) return;
    setDeployMenuOpen(false);
    setIsDeploying(true);
    try {
      const type = deployFrontend && deployBackend ? 'fullstack' : deployBackend ? 'backend' : 'frontend';
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: workspaceName, type }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Deploy failed');
      setActiveTab('cloud');
      const label = type === 'fullstack' ? 'Frontend & Backend' : type === 'backend' ? 'Backend' : 'Frontend';
      showNotification(`${label} deployment queued!`, 'success');
    } catch (err: any) {
      showNotification(`Deploy failed: ${err.message}`, 'error');
    } finally {
      setIsDeploying(false);
    }
  }, [deployFrontend, deployBackend, workspaceId, workspaceName, showNotification, getToken]);

  // ── Visual editor helpers ─────────────────────────────────────────────────
  const sendToIframe = useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  const exitVisualEdit = useCallback(() => {
    setIsVisualEditMode(false);
    setSelectedElement(null);
    pendingTargetRef.current = null;
    setPendingStyleChanges({});
    setPendingTextChange(null);
    setPendingSrcChange(null);
    sendToIframe({ kind: 'pf:set-mode', mode: 'idle' });
    window.dispatchEvent(new CustomEvent('pf:visual-edit-changed', { detail: { active: false } }));
  }, [sendToIframe]);

  const toggleVisualEdit = useCallback(() => {
    if (isVisualEditMode) {
      exitVisualEdit();
    } else {
      setIsVisualEditMode(true);
      if (inspectorReadyRef.current) sendToIframe({ kind: 'pf:set-mode', mode: 'inspect' });
      window.dispatchEvent(new CustomEvent('pf:visual-edit-changed', { detail: { active: true } }));
    }
  }, [isVisualEditMode, exitVisualEdit, sendToIframe]);

  // Listen for toggle events from SystemInputBar
  useEffect(() => {
    window.addEventListener('pf:toggle-visual-edit', toggleVisualEdit);
    return () => window.removeEventListener('pf:toggle-visual-edit', toggleVisualEdit);
  }, [toggleVisualEdit]);

  // postMessage bridge — listen for messages from the inspector iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
      if (msg.kind === 'pf:ready') {
        inspectorReadyRef.current = true;
        if (isVisualEditMode) sendToIframe({ kind: 'pf:set-mode', mode: 'inspect' });
      } else if (msg.kind === 'pf:element-selected') {
        const el: SelectedElement = {
          ...msg,
          classes: Array.isArray(msg.classes) ? msg.classes : [],
          breadcrumb: Array.isArray(msg.breadcrumb) ? msg.breadcrumb.map((n: any) => ({ ...n, classes: Array.isArray(n.classes) ? n.classes : [] })) : [],
          src: typeof msg.src === 'string' ? msg.src : '',
          currentText: typeof msg.currentText === 'string' ? msg.currentText : '',
          hasEditableText: !!msg.hasEditableText,
        } as SelectedElement;
        setSelectedElement(el);
      } else if (msg.kind === 'pf:text-edited') {
        if (typeof msg.text === 'string') setPendingTextChange(msg.text);
      } else if (msg.kind === 'pf:element-not-found') {
        showNotification('Element not found in preview', 'error');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isVisualEditMode, sendToIframe, showNotification]);

  // Exit visual edit when switching away from preview tab
  useEffect(() => {
    if (activeTab !== 'preview' && isVisualEditMode) exitVisualEdit();
  }, [activeTab]);

  const handleStyleChange = useCallback((prop: string, value: string) => {
    if (selectedElement) pendingTargetRef.current = selectedElement;
    setPendingStyleChanges(prev => {
      const next = { ...prev, [prop]: value };
      if (selectedElement) sendToIframe({ kind: 'pf:apply-style', selector: selectedElement.selector, style: next });
      return next;
    });
  }, [selectedElement, sendToIframe]);

  const handleTextChange = useCallback((text: string) => {
    if (selectedElement) pendingTargetRef.current = selectedElement;
    setPendingTextChange(text);
    if (selectedElement) sendToIframe({ kind: 'pf:set-content', selector: selectedElement.selector, text });
  }, [selectedElement, sendToIframe]);

  const handleSrcChange = useCallback((src: string) => {
    if (selectedElement) pendingTargetRef.current = selectedElement;
    setPendingSrcChange(src);
    if (selectedElement) sendToIframe({ kind: 'pf:apply-attribute', selector: selectedElement.selector, attribute: 'src', value: src });
  }, [selectedElement, sendToIframe]);

  const handleClimbToAncestor = useCallback((depth: number) => {
    if (selectedElement) sendToIframe({ kind: 'pf:climb-to-ancestor', selector: selectedElement.selector, depth });
  }, [selectedElement, sendToIframe]);

  const handleReset = useCallback(() => {
    const target = pendingTargetRef.current ?? selectedElement;
    if (target) {
      sendToIframe({ kind: 'pf:reset', selector: target.selector });
      if (pendingTextChange !== null && target.hasEditableText) {
        sendToIframe({ kind: 'pf:set-content', selector: target.selector, text: target.currentText });
      }
      if (pendingSrcChange !== null && target.tagName === 'img') {
        sendToIframe({ kind: 'pf:apply-attribute', selector: target.selector, attribute: 'src', value: target.src });
      }
    }
    pendingTargetRef.current = null;
    setPendingStyleChanges({});
    setPendingTextChange(null);
    setPendingSrcChange(null);
  }, [selectedElement, pendingTextChange, pendingSrcChange, sendToIframe]);


  const handleApplyToCode = useCallback(async () => {
    const target = pendingTargetRef.current ?? selectedElement;
    if (!target || !workspaceId) return;
    if (!user?.id) return;
    setIsApplyingToCode(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/inspector/apply-tailwind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId,
          selector: target.selector,
          tagName: target.tagName,
          cssChanges: pendingStyleChanges,
          elementClasses: target.classes,
          newText: pendingTextChange ?? undefined,
          currentText: target.currentText || undefined,
          newSrc: pendingSrcChange ?? undefined,
          currentSrc: target.src || undefined,
        }),
      });
      if (res.ok) {
        showNotification('Applied to source code', 'success');
      } else {
        showNotification('Saved as CSS override', 'success');
      }
      pendingTargetRef.current = null;
      setPendingStyleChanges({});
      setPendingTextChange(null);
      setPendingSrcChange(null);
    } catch {
      showNotification('Failed to apply changes', 'error');
    } finally {
      setIsApplyingToCode(false);
    }
  }, [user, selectedElement, workspaceId, pendingStyleChanges, pendingTextChange, pendingSrcChange, showNotification]);

  // Detect WebSocket reconnection (wsRef identity never changes, but .current does)
  useEffect(() => {
    const id = setInterval(() => {
      const ws = wsRef?.current;
      if (ws && ws !== wsInstanceRef.current) {
        wsInstanceRef.current = ws;
        setWsVersion(v => v + 1);
      }
    }, 300);
    return () => clearInterval(id);
  }, [wsRef]);

  // ── WS message handler ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'FILE_TREE_RESPONSE') {
          const flat: FileNode[] = data.payload.files || [];
          const root = data.payload.directory || '/workspace';
          setFileTree(buildTree(flat, root, getPreferredOpenPaths(flat, root)));
          setIsLoadingTree(false);
          return;
        }
        if (data.type === 'FILE_CONTENT_RESPONSE') {
          const responsePath = data.payload.path || pendingPathRef.current || activeTabPathRef.current;
          const content = data.payload.error
            ? `// Error: ${data.payload.error}`
            : (data.payload.content || '');
          if (!responsePath) return;
          fileCacheRef.current.set(responsePath, content);
          setOpenTabs(prev => prev.map(tab =>
            tab.path === responsePath ? { ...tab, content, originalContent: content, loading: false } : tab
          ));
          dirtyDispatch({ type: 'SET_ORIGINAL', path: responsePath, content });
          pendingPathRef.current = null;
        }
      } catch { /* ignore */ }
    };

    const ws = wsRef?.current;
    if (ws) ws.addEventListener('message', handler);
    return () => { if (ws) ws.removeEventListener('message', handler); };
  }, [wsRef, wsVersion]); // wsVersion re-triggers when WS reconnects

  // Retry any tabs stuck in loading state (handles WS reconnect race condition)
  useEffect(() => {
    if (!sandboxId) return;
    const id = setInterval(() => {
      const ws = wsRef?.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const loading = openTabsRef.current.filter(t => t.loading);
      for (const tab of loading) {
        ws.send(JSON.stringify({
          type: 'FILE_CONTENT_REQUEST',
          payload: { sandboxId, path: tab.path },
          meta: { requestId: `file_retry_${Date.now()}` },
        }));
      }
    }, 4000);
    return () => clearInterval(id);
  }, [sandboxId, wsRef]);

  // ── Request file tree — mirrors frontend exactly ───────────────────────────
  const requestFileTree = useCallback(() => {
    if (!sandboxId || !wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setIsLoadingTree(true);
    wsRef.current.send(JSON.stringify({
      type: 'FILE_TREE_REQUEST',
      payload: { sandboxId, directory: '/workspace' },
      meta: { requestId: `tree_${Date.now()}` },
    }));
  }, [sandboxId, wsRef]);

  // Exactly as frontend: poll every 500ms until WS is open, then request once
  useEffect(() => {
    if (!sandboxId) return;
    const interval = setInterval(() => {
      if (wsRef?.current?.readyState === WebSocket.OPEN) {
        requestFileTree();
        clearInterval(interval);
      }
    }, 500);
    if (wsRef?.current?.readyState === WebSocket.OPEN) {
      requestFileTree();
      clearInterval(interval);
    }
    return () => clearInterval(interval);
  }, [sandboxId, requestFileTree, wsRef]);

  useEffect(() => {
    const handleAgentDone = () => requestFileTree();
    window.addEventListener("pf:agent-done", handleAgentDone);
    return () => window.removeEventListener("pf:agent-done", handleAgentDone);
  }, [requestFileTree]);

  // ── Request file content ───────────────────────────────────────────────────
  const requestFileContent = (path: string) => {
    if (!sandboxId || !wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setActiveTabPath(path);

    const cached = fileCacheRef.current.get(path);
    if (cached != null) {
      setOpenTabs(prev => {
        const exists = prev.some(t => t.path === path);
        if (exists) return prev;
        return [...prev, { path, content: cached, originalContent: cached, loading: false }];
      });
      return;
    }

    setOpenTabs(prev => {
      const exists = prev.some(t => t.path === path);
      if (exists) return prev.map(t => t.path === path ? { ...t, loading: true } : t);
      return [...prev, { path, content: '', originalContent: '', loading: true }];
    });

    pendingPathRef.current = path;
    wsRef.current.send(JSON.stringify({
      type: 'FILE_CONTENT_REQUEST',
      payload: { sandboxId, path },
      meta: { requestId: `file_${Date.now()}` },
    }));
  };

  const closeTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    dirtyDispatch({ type: 'CLEAR_FILE', path });
    setOpenTabs(prev => {
      const remaining = prev.filter(t => t.path !== path);
      if (activeTabPath === path) {
        setActiveTabPath(remaining[remaining.length - 1]?.path ?? null);
      }
      return remaining;
    });
  };

  const isVisible = viewMode === 'split' || viewMode === 'preview';

  return (
    <div
      style={{ flex: isVisible ? '1 1 0%' : '0 0 0px', width: isVisible ? undefined : 0 }}
      className={cn(
        'relative flex flex-col h-full bg-[#161616] overflow-hidden transition-opacity duration-300',
        !isVisible && 'opacity-0 pointer-events-none',
      )}
    >
      {/* Toast notification */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.95 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={cn(
              'absolute top-14 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl shadow-xl border backdrop-blur-md min-w-[280px]',
              notification.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-800/60 text-emerald-200'
                : 'bg-red-950/90 border-red-800/60 text-red-200'
            )}
          >
            {notification.type === 'success'
              ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              : <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            }
            <span className="flex-1 text-[12px] font-medium">{notification.message}</span>
            <button
              onClick={() => setNotification(null)}
              className="p-1 rounded-md hover:bg-white/10 transition-colors text-white/40 hover:text-white/80"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[42px] border-b border-white/5 shrink-0 bg-[#1C1C1D]">
        <div className="flex items-center gap-1">
          {([['preview', Eye], ['code', Code], ['history', History], ['cloud', Cloud]] as const).map(([tab, Icon]) => (
            <button key={tab} onClick={() => setActiveTab(tab as any)}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors cursor-pointer ${activeTab === tab ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
              title={tab.charAt(0).toUpperCase() + tab.slice(1)}
            >
              <Icon size={14} />
            </button>
          ))}
          <div className="w-px h-4 bg-white/10 mx-1" />
          {([['pc', Monitor], ['phone', Tablet]] as const).map(([d, Icon]) => (
            <button key={d} onClick={() => setActiveDevice(d as any)}
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors cursor-pointer ${activeDevice === d ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
              title={d === 'pc' ? 'Desktop' : 'Mobile'}
            >
              <Icon size={14} />
            </button>
          ))}
          {previewUrl && (
            <a href={previewUrl} target="_blank" rel="noreferrer"
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/5 text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Open in new tab"
            >
              <ArrowUpRight size={14} />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          {workspaceId && (
            <button
              onClick={() => router.push(`/system/${workspaceId}/settings`)}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/5 text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Settings"
            >
              <Settings size={14} />
            </button>
          )}
          {isVisualEditMode ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleReset}
                className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.12] transition-all cursor-pointer"
              >
                Reset
              </button>
              <GlassButton
                size="sm"
                onClick={handleApplyToCode}
                disabled={isApplyingToCode}
              >
                {isApplyingToCode ? <Loader size={12} className="animate-spin" /> : null}
                {isApplyingToCode ? 'Applying…' : 'Apply to Code'}
              </GlassButton>
            </div>
          ) : (
          <div className="relative">
          <GlassButton
            size="sm"
            onClick={() => setDeployMenuOpen(v => !v)}
            disabled={isDeploying}
          >
            {isDeploying ? <Loader size={12} className="animate-spin" /> : null}
            {isDeploying ? 'Deploying...' : 'Deploy'}
            <ChevronDown size={11} className="opacity-60" />
          </GlassButton>

          {deployMenuOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center"
              onClick={() => setDeployMenuOpen(false)}
            >
              {/* Blur backdrop */}
              <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

              {/* Modal */}
              <div
                className="relative w-80 rounded-2xl border border-white/[0.08] bg-[#1C1C1D] shadow-2xl p-5 flex flex-col gap-4"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between">
                  <span className="text-white text-sm font-semibold">Deploy</span>
                  <button onClick={() => setDeployMenuOpen(false)} className="text-white/30 hover:text-white/70 transition-colors cursor-pointer">
                    <X size={15} />
                  </button>
                </div>

                <p className="text-white/40 text-xs -mt-1">Select what to deploy to production.</p>

                <div className="flex flex-col gap-2">
                  {([
                    { key: 'frontend', label: 'Frontend', desc: 'Next.js web app', icon: Globe, checked: deployFrontend, set: setDeployFrontend },
                    { key: 'backend', label: 'Backend', desc: 'API server', icon: Server, checked: deployBackend, set: setDeployBackend },
                  ] as const).map(({ key, label, desc, icon: Icon, checked, set }) => (
                    <label
                      key={key}
                      onClick={() => set(v => !v)}
                      className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${checked ? 'border-white/20 bg-white/[0.06]' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                        }`}
                    >
                      <div className={`w-4 h-4 rounded-md border flex items-center justify-center flex-shrink-0 transition-all ${checked ? 'border-white/50 bg-white/15' : 'border-white/20'
                        }`}>
                        {checked && <div className="w-2 h-2 rounded-sm bg-white" />}
                      </div>
                      <Icon size={13} className="text-white/50 flex-shrink-0" />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-white/80 text-xs font-medium">{label}</span>
                        <span className="text-white/30 text-[10px]">{desc}</span>
                      </div>
                    </label>
                  ))}
                </div>

                <GlassButton
                  size="md"
                  onClick={handleDeploy}
                  disabled={!deployFrontend && !deployBackend}
                  className="w-full justify-center"
                >
                  {isDeploying ? <Loader size={13} className="animate-spin" /> : null}
                  {isDeploying ? 'Deploying…' : 'Deploy'}
                </GlassButton>
              </div>
            </div>
          )}
        </div>
          )}
        </div>
      </div>

      {/* Body — all tabs always mounted, CSS-toggled */}
      <div className="flex-1 overflow-hidden relative">

        {/* ── Code tab ── */}
        <div className={cn('absolute inset-0 flex overflow-hidden', activeTab !== 'code' && 'opacity-0 pointer-events-none')}>
          {/* Explorer */}
          <div className="w-56 shrink-0 border-r border-white/5 flex flex-col bg-[#1C1C1D]">
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-[10px] font-bold text-gray-500 tracking-wider select-none">EXPLORER</span>
              <button onClick={requestFileTree} title="Refresh"
                className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors cursor-pointer"
              >
                <RefreshCw size={10} className={isLoadingTree ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pb-4 scrollbar-subtle">
              {isLoadingTree ? (
                <div className="flex items-center justify-center h-16">
                  <Loader size={13} className="animate-spin text-gray-600" />
                </div>
              ) : fileTree.length === 0 ? (
                <p className="text-[11px] text-gray-600 px-4 py-2 italic">
                  {sandboxId ? 'Loading files…' : 'No sandbox active'}
                </p>
              ) : fileTree.map(node => (
                <TreeNode key={node.path} node={node} depth={0} onFile={requestFileContent} activeFile={activeTabPath} dirtyFiles={dirtyState.files} />
              ))}
            </div>
          </div>

          {/* Editor */}
          <div className="flex-1 flex flex-col overflow-hidden bg-[#161616]">
            {/* Tab bar with dirty indicators */}
            <div className="flex items-center bg-[#1C1C1D] border-b border-white/5 h-[34px] overflow-x-auto scrollbar-subtle select-none">
              {openTabs.map(tab => {
                const name = tab.path.split('/').pop() || tab.path;
                const isActive = tab.path === activeTabPath;
                const isDirty = dirtyState.files.has(tab.path);
                return (
                  <div key={tab.path} onClick={() => setActiveTabPath(tab.path)}
                    className={`flex items-center gap-1.5 px-3 h-full text-[12px] border-r border-white/5 cursor-pointer transition-colors shrink-0 ${isActive ? 'bg-[#161616] text-white border-t border-brand-pink' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
                  >
                    {isDirty && (
                      <span className="text-[#EF9F27] text-[10px] transition-opacity duration-150">●</span>
                    )}
                    <img src={getMaterialFileIcon(name)} alt="" className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate max-w-[120px]">{name}</span>
                    <button type="button" onClick={e => closeTab(e, tab.path)} className="opacity-40 hover:opacity-100 hover:text-red-400 ml-0.5 transition-colors">✕</button>
                  </div>
                );
              })}
            </div>

            {/* Action bar with Commit button (always visible) */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#161616] border-b border-white/5 text-[12px] h-10">
              <div className="flex items-center gap-2 flex-1">
                {dirtyState.files.size > 0 ? (
                  <>
                    <span className="text-[#EF9F27]">●</span>
                    <span className="text-gray-400">{dirtyState.files.size} modified</span>
                  </>
                ) : (
                  <span className="text-gray-600">No changes</span>
                )}
              </div>
              <CommitButton
                dirtyFileCount={dirtyState.files.size}
                onCommit={() => setCommitModalOpen(true)}
                disabled={dirtyState.files.size === 0}
              />
            </div>

            {/* Code Editor (CodeMirror 6) */}
            <div className="flex-1 overflow-hidden">
              {activeTab_?.loading ? (
                <div className="flex items-center justify-center h-20">
                  <Loader size={13} className="animate-spin text-gray-600" />
                </div>
              ) : activeTab_?.content !== undefined ? (
                <CodeEditor
                  path={activeTabPath || ''}
                  content={activeTab_.content}
                  onChange={(newContent) => {
                    dirtyDispatch({ type: 'UPDATE', path: activeTabPath!, content: newContent });
                    setOpenTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: newContent } : t));
                  }}
                />
              ) : !activeTabPath ? (
                <div className="h-full flex items-center justify-center text-gray-600 text-[12px]">
                  Select a file from the explorer
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── History tab ── */}
        <div className={cn('absolute inset-0 overflow-hidden', activeTab !== 'history' && 'opacity-0 pointer-events-none')}>
          {workspaceName ? (
            <HistoryTab workspaceName={workspaceName} workspaceId={workspaceId} />
          ) : (
            <div className="flex items-center justify-center text-gray-600 text-[12px] h-full">
              <div className="flex flex-col items-center gap-2 opacity-40">
                <GitCommit size={20} />
                <span>Loading workspace…</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Cloud tab ── */}
        <div className={cn('absolute inset-0 overflow-hidden', activeTab !== 'cloud' && 'opacity-0 pointer-events-none')}>
          {workspaceId ? (
            <CloudPanel workspaceId={workspaceId} />
          ) : (
            <div className="flex items-center justify-center text-gray-600 text-[12px] h-full">
              <div className="flex flex-col items-center gap-2 opacity-40">
                <Cloud size={20} />
                <span>Loading workspace…</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Preview tab ── */}
        <div className={cn('absolute inset-0 flex overflow-hidden', activeTab !== 'preview' && 'opacity-0 pointer-events-none')}>
          {/* Preview area */}
          <div className={cn('flex items-center justify-center overflow-auto bg-[#0d0d0e] transition-all duration-300', isVisualEditMode && selectedElement ? 'flex-[6]' : 'flex-1')}>
            <motion.div
              layout
              transition={{ type: 'spring', stiffness: 280, damping: 30, mass: 1 }}
              className={`relative flex flex-col shrink-0 overflow-hidden ${activeDevice === 'pc'
                  ? 'w-full h-full rounded-none'
                  : 'w-[360px] h-[720px] rounded-[48px] border-[14px] border-[#2A2A2D] shadow-2xl bg-white'
                }`}
            >
              {isResuming ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-[#0d0d0e]">
                  <img
                    src="/logos/logo.svg"
                    alt="Loading"
                    className="w-8 h-8"
                    style={{ animation: "spin 3.8s linear infinite" }}
                  />
                  <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                  <span className="text-[12px] text-white/30">Resuming sandbox…</span>
                </div>
              ) : previewUrl ? (
                <iframe ref={iframeRef} src={previewUrl} className="w-full h-full border-none" title="Live Preview" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center px-8">
                  <LoadingCarousel />
                </div>
              )}
            </motion.div>
          </div>

          {/* Visual editor panel */}
          {isVisualEditMode && (
            <div className="w-72 shrink-0 border-l border-white/[0.06] bg-[#161617] overflow-hidden flex flex-col">
              <VisualEditorPanel
                element={selectedElement}
                pendingChanges={pendingStyleChanges}
                externalText={pendingTextChange}
                hasPendingChanges={Object.keys(pendingStyleChanges).length > 0 || pendingTextChange !== null || pendingSrcChange !== null}
                onStyleChange={handleStyleChange}
                onTextChange={handleTextChange}
                onSrcChange={handleSrcChange}
                onClimbToAncestor={handleClimbToAncestor}
                onApplyToCode={handleApplyToCode}
                onReset={handleReset}
                onExit={exitVisualEdit}
                isApplying={isApplyingToCode}
              />
            </div>
          )}
        </div>

      </div>

      {/* Commit Modal */}
      <CommitModal
        open={commitModalOpen}
        onClose={() => setCommitModalOpen(false)}
        dirtyFiles={Array.from(dirtyState.files.entries())}
        sandboxId={sandboxId ?? null}
        workspaceName={workspaceName}
        workspaceId={workspaceId ?? null}
        coregitNamespace={coregitNamespace ?? null}
        onSuccess={() => {
          dirtyDispatch({ type: 'CLEAR_ALL' });
          setCommitModalOpen(false);
        }}
      />
    </div>
  );
}

// ── Main export with DirtyStateProvider ────────────────────────────────────
export default function EditorPane(props: EditorPaneProps) {
  return (
    <DirtyStateProvider>
      <EditorPaneInner {...props} />
    </DirtyStateProvider>
  );
}
