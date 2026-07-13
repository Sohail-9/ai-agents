"use client";

import { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, ChevronDown, List, Mic, Check, ArrowUp, Square, ImagePlus, Users, CheckCircle2, Clock, Circle, Folder, Loader, FileCode2, X, ArrowRight, Wand2 } from 'lucide-react';
import type { ChatImage } from '@/app/system/[id]/_types/system';
import { getMaterialFileIcon } from 'file-extension-icon-js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-client";

function QueueBadge({ messages }: { messages: string[] }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative ml-1" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/10 border border-white/15 cursor-default">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        <span className="text-[10px] font-semibold text-white/60">{messages.length} queued</span>
      </div>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full mb-2 left-0 z-50 min-w-[200px] max-w-[280px] bg-[#1c1c1e] border border-white/10 rounded-xl shadow-2xl p-2.5 pointer-events-none"
          >
            <p className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-1.5 px-0.5">Queued messages</p>
            <div className="flex flex-col gap-1.5">
              {messages.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 px-0.5">
                  <span className="text-[9px] text-white/30 font-mono mt-0.5 shrink-0">{i + 1}.</span>
                  <span className="text-[11px] text-white/60 leading-snug break-words">{msg}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface PlanQuestion {
  id: string;
  question: string;
  options: { id: string; text: string }[];
}

interface SystemInputBarProps {
  status?: "running" | "idle" | "completed";
  inputValue?: string;
  onInputChange?: (value: string) => void;
  onSubmit?: () => void;
  onRealSubmit?: (text: string, images?: ChatImage[]) => void;
  workspaceId?: string | null;
  onStop?: () => void;
  isRunning?: boolean;
  isPlanMode?: boolean;
  onPlanModeChange?: (mode: boolean) => void;
  isMultiAgent?: boolean;
  onMultiAgentChange?: (v: boolean) => void;
  showTodos?: boolean;
  onToggleTodos?: () => void;
  hasTodos?: boolean;
  todos?: Array<{ id: string; title: string; status: "pending" | "completed" | "in_progress" }>;
  planQuestions?: { questions: PlanQuestion[]; summary?: string } | null;
  onPlanAnswer?: (answers: Record<string, string>, questionsData?: { questions: PlanQuestion[]; summary?: string } | null) => void;
  wsRef?: MutableRefObject<WebSocket | null>;
  sandboxId?: string | null;
  sessionStats?: { files: number; linesAdded: number; linesRemoved: number };
  agentStartedAt?: number | null;
  queuedMessages?: string[];
}

export default function SystemInputBar({
  status = "running",
  inputValue: externalInputValue,
  onInputChange,
  onSubmit,
  onRealSubmit,
  onStop,
  isRunning,
  isPlanMode: externalPlanMode,
  onPlanModeChange,
  isMultiAgent: externalMultiAgent,
  onMultiAgentChange,
  showTodos,
  onToggleTodos,
  hasTodos,
  todos,
  planQuestions,
  onPlanAnswer,
  wsRef,
  sandboxId,
  sessionStats,
  agentStartedAt,
  queuedMessages,
  workspaceId,
}: SystemInputBarProps) {
  const [internalPlanMode, setInternalPlanMode] = useState<"build" | "plan">("build");
  const [localInputValue, setLocalInputValue] = useState("");
  const [internalMultiAgent, setInternalMultiAgent] = useState(false);
  const [isVisualEditMode, setIsVisualEditMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { getToken } = useAuth();

  // Sync visual edit mode state via window events (EditorPane <-> SystemInputBar)
  useEffect(() => {
    const handler = (e: Event) => setIsVisualEditMode((e as CustomEvent<{ active: boolean }>).detail.active);
    window.addEventListener('pf:visual-edit-changed', handler);
    return () => window.removeEventListener('pf:visual-edit-changed', handler);
  }, []);

  // Plan questions state
  const [planStep, setPlanStep] = useState(0);
  const [planSelected, setPlanSelected] = useState<Record<string, string>>({});
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  const [planCustomText, setPlanCustomText] = useState("");

  // @ mention state
  const [fileTree, setFileTree] = useState<{ path: string; type: "file" | "directory" }[]>([]);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [mentionAnchor, setMentionAnchor] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ path: string; type: "file" | "directory" }[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const [mentionMap, setMentionMap] = useState<Record<string, string>>({});

  // ── Image upload state ───────────────────────────────────────────────────────
  interface PendingImage { id: string; filename: string; mimeType?: string; previewUrl: string; uploading: boolean; }
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

  const uploadImage = useCallback(async (file: File) => {
    if (!workspaceId) return;
    const tempId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    setPendingImages(prev => [...prev, { id: tempId, filename: file.name, mimeType: file.type, previewUrl, uploading: true }]);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/images`, { 
        method: "POST", 
        body: formData,
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      setPendingImages(prev => prev.map(img => img.id === tempId ? { ...img, id: data.id, mimeType: data.mimeType ?? img.mimeType, uploading: false } : img));
    } catch {
      setPendingImages(prev => prev.filter(img => img.id !== tempId));
      URL.revokeObjectURL(previewUrl);
    }
  }, [workspaceId, API_URL]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const remaining = 5 - pendingImages.length;
    if (remaining > 0) Array.from(files).slice(0, remaining).forEach(uploadImage);
    e.target.value = "";
  }, [uploadImage, pendingImages.length]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (pendingImages.length >= 5) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadImage(file);
        return;
      }
    }
  }, [uploadImage, pendingImages.length]);

  const removePendingImage = useCallback((id: string) => {
    setPendingImages(prev => {
      const removed = prev.find(img => img.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter(img => img.id !== id);
    });
  }, []);

  useEffect(() => {
    return () => { pendingImages.forEach(img => URL.revokeObjectURL(img.previewUrl)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (planQuestions && planQuestions.questions.length > 0) {
      setPlanStep(0);
      setPlanSelected({});
      setShowPlanPanel(true);
    } else {
      setShowPlanPanel(false);
    }
  }, [planQuestions]);

  const isRealMode = !!onRealSubmit;
  const activeMode = isRealMode ? (externalPlanMode ? "plan" : "build") : internalPlanMode;
  const multiAgent = isRealMode ? (externalMultiAgent ?? false) : internalMultiAgent;
  const isControlled = externalInputValue !== undefined;
  const inputValue = isControlled ? externalInputValue : localInputValue;

  const handleTextareaChange = (value: string) => {
    if (isControlled) onInputChange?.(value);
    else setLocalInputValue(value);
  };

  // ── @ mention logic ──────────────────────────────────────────────────────────

  // FILE_TREE_RESPONSE listener — polls for WS to become available since
  // wsRef.current is null when this component mounts (WS connects later in parent effects)
  useEffect(() => {
    let attached: WebSocket | null = null;
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "FILE_TREE_RESPONSE") {
          const flat = (data.payload.files || []) as { path: string; type: string }[];
          setFileTree(flat as any);
          setTreeLoaded(true);
        }
      } catch { }
    };
    const sync = () => {
      const ws = wsRef?.current ?? null;
      if (ws === attached) return;
      if (attached) attached.removeEventListener("message", handler);
      attached = ws;
      if (attached) attached.addEventListener("message", handler);
    };
    sync();
    const iv = setInterval(sync, 200);
    return () => {
      clearInterval(iv);
      if (attached) attached.removeEventListener("message", handler);
    };
  }, []); // stable — interval handles WS connect/reconnect

  const loadFileTree = useCallback(() => {
    if (treeLoaded || !sandboxId) return;
    const trySend = () => {
      if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) return false;
      wsRef.current.send(JSON.stringify({
        type: "FILE_TREE_REQUEST",
        payload: { sandboxId, directory: "/workspace" },
        meta: { requestId: `mention_tree_${Date.now()}` },
      }));
      return true;
    };
    if (!trySend()) {
      const iv = setInterval(() => { if (trySend()) clearInterval(iv); }, 300);
    }
  }, [treeLoaded, wsRef, sandboxId]);

  // Build suggestion list whenever mention state changes
  useEffect(() => {
    if (mentionAnchor === null) { setSuggestions([]); return; }

    if (folderPath !== null) {
      const children = fileTree
        .filter(n => {
          const rel = n.path.slice(folderPath.length + 1);
          return n.path.startsWith(folderPath + "/") && !rel.includes("/");
        })
        .slice(0, 6);
      setSuggestions(children);
      setSuggestionIdx(0);
      return;
    }

    if (!mentionQuery) {
      const topLevel = fileTree.filter(n =>
        n.type === "directory" && (n.path === "frontend" || n.path === "backend")
      );
      setSuggestions(
        topLevel.length > 0
          ? topLevel
          : fileTree.filter(n => n.type === "directory" && !n.path.includes("/")).slice(0, 6)
      );
      setSuggestionIdx(0);
      return;
    }

    const q = mentionQuery.toLowerCase();
    const matches = fileTree
      .filter(n => n.path.split("/").pop()?.toLowerCase().includes(q))
      .slice(0, 6);
    setSuggestions(matches);
    setSuggestionIdx(0);
  }, [mentionAnchor, mentionQuery, folderPath, fileTree]);

  const detectMention = (val: string, textarea: HTMLTextAreaElement) => {
    const cursor = textarea.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx !== -1) {
      const afterAt = before.slice(atIdx + 1);
      if (!afterAt.includes(" ") && !afterAt.includes("\n")) {
        if (!treeLoaded) loadFileTree();
        setMentionAnchor(atIdx);
        setMentionQuery(afterAt);
        return;
      }
    }
    setMentionAnchor(null);
    setMentionQuery("");
    setFolderPath(null);
  };

  const selectSuggestion = (node: { path: string; type: "file" | "directory" }) => {
    if (node.type === "directory") {
      setFolderPath(node.path);
      setMentionQuery("");
      return;
    }
    const fileName = node.path.split("/").pop()!;
    const current = isControlled ? (externalInputValue ?? "") : localInputValue;
    const before = current.slice(0, mentionAnchor!);
    const after = current.slice(mentionAnchor! + 1 + mentionQuery.length);
    const newValue = before + "@" + fileName + " " + after;
    if (isControlled) onInputChange?.(newValue);
    else setLocalInputValue(newValue);
    setMentionMap(prev => ({ ...prev, [fileName]: `/workspace/${node.path}` }));
    setMentionAnchor(null);
    setMentionQuery("");
    setFolderPath(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const expandMentions = (text: string): string => {
    let expanded = text;
    Object.entries(mentionMap).forEach(([displayName, fullPath]) => {
      expanded = expanded.replace(new RegExp(`@${displayName.replace(/\./g, "\\.")}`, "g"), fullPath);
    });
    return expanded;
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const handleSubmitClick = () => {
    if (isRealMode) {
      const hasImages = pendingImages.some(img => !img.uploading);
      const text = inputValue.trim();
      if (!text && !hasImages) return;
      if (pendingImages.some(img => img.uploading)) return;
      const expanded = expandMentions(text);
      const images: ChatImage[] = pendingImages
        .filter(img => !img.uploading)
        .map(img => ({ id: img.id, filename: img.filename, mimeType: img.mimeType ?? "image/png" }));
      onRealSubmit(expanded || "Describe this image", images.length ? images : undefined);
      if (!isControlled) setLocalInputValue("");
      else onInputChange?.("");
      setMentionMap({});
      setMentionAnchor(null);
      pendingImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } else {
      onSubmit?.();
    }
  };

  const handleModeChange = (mode: "plan" | "build") => {
    if (isRealMode) onPlanModeChange?.(mode === "plan");
    else setInternalPlanMode(mode);
  };

  const handleMultiAgentToggle = () => {
    if (isRealMode) onMultiAgentChange?.(!multiAgent);
    else setInternalMultiAgent(v => !v);
  };

  const effectiveRunning = isRealMode ? (isRunning ?? false) : status === "running";

  // ── Agent timer ──────────────────────────────────────────────────────────────
  const timerStartRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalMs, setFinalMs] = useState<number | null>(null);

  useEffect(() => {
    let raf: number;
    if (effectiveRunning) {
      const start = agentStartedAt ?? Date.now();
      timerStartRef.current = start;
      setFinalMs(null);
      setElapsedMs(Date.now() - start);
      const tick = () => { setElapsedMs(Date.now() - start); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    } else if (timerStartRef.current !== null) {
      setFinalMs(Date.now() - timerStartRef.current);
      timerStartRef.current = null;
    }
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [effectiveRunning, agentStartedAt]);

  const formatTime = (ms: number) => {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(0).padStart(2, '0');
    return `${m}m ${sec}s`;
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const hasPlanQuestions = !!(planQuestions && planQuestions.questions.length > 0);
  const planQuestion = hasPlanQuestions ? planQuestions!.questions[planStep] : null;
  const planTotal = hasPlanQuestions ? planQuestions!.questions.length : 0;
  const planIsLast = planStep === planTotal - 1;

  // Reset custom text whenever we move to a new question
  useEffect(() => { setPlanCustomText(""); }, [planStep]);

  const advancePlan = (overrideText?: string) => {
    if (!planQuestion) return;
    const custom = (overrideText ?? planCustomText).trim();
    const answerValue = custom || planSelected[planQuestion.id] || "";
    if (!answerValue) return;
    const next = { ...planSelected, [planQuestion.id]: answerValue };
    setPlanSelected(next);
    setPlanCustomText("");
    setTimeout(() => {
      if (planIsLast) {
        onPlanAnswer?.(next, planQuestions);
        setShowPlanPanel(false);
      } else {
        setPlanStep(s => s + 1);
      }
    }, 160);
  };

  const getStatusConfig = () => {
    if (hasPlanQuestions) return { text: "A few quick questions", color: "bg-blue-400" };
    if (effectiveRunning) return { text: "Agent is running", color: "bg-yellow-500" };
    if (status === "completed" || (!effectiveRunning && isRealMode)) return { text: "Agent Completed Your Task", color: "bg-brand-pink" };
    return { text: "Agent is idle", color: "bg-gray-400" };
  };

  const statusConfig = getStatusConfig();
  const showMention = mentionAnchor !== null && (suggestions.length > 0 || !treeLoaded);

  return (
    <div className="relative w-full flex flex-col mt-auto drop-shadow-2xl">
      {/* Top Layer - Status + @ mention + Todos */}
      <div className="bg-[#434343] border border-white/5 border-b-0 px-4 pb-[22px]" style={{ borderRadius: '32px 32px 0 0' }}>
        {/* Status row */}
        <div className="flex items-center gap-2 text-[11px] text-white/90 pt-2.5 pb-2">
          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusConfig.color}`} />
          <span className="font-semibold tracking-wide">{statusConfig.text}</span>
          {hasPlanQuestions && (
            <div className="flex items-center gap-1 ml-1">
              {planQuestions!.questions.map((_, i) => (
                <div key={i} className={`rounded-full transition-all duration-200 ${
                  i < planStep ? 'w-1.5 h-1.5 bg-brand-pink' :
                  i === planStep ? 'w-2.5 h-1.5 bg-brand-pink' :
                  'w-1.5 h-1.5 bg-white/20'
                }`} />
              ))}
              <span className="text-[10px] text-white/30 ml-0.5">{planStep + 1}/{planTotal}</span>
            </div>
          )}
          {!hasPlanQuestions && effectiveRunning && (
            <span className="font-mono text-[10.5px] text-white/40 tracking-wide">
              — {formatTime(elapsedMs)}
            </span>
          )}
          {!hasPlanQuestions && !effectiveRunning && finalMs !== null && finalMs > 500 && (
            <span className="font-mono text-[10px] text-white/35 tracking-wide ml-0.5">
              in {formatTime(finalMs)}
            </span>
          )}

          {/* Queue badge */}
          {effectiveRunning && queuedMessages && queuedMessages.length > 0 && (
            <QueueBadge messages={queuedMessages} />
          )}

          {/* Session file stats */}
          <AnimatePresence>
            {sessionStats && sessionStats.files > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", damping: 25, stiffness: 380 }}
                className="ml-auto flex items-center gap-2"
              >
                <FileCode2 className="w-3 h-3 text-white/35 shrink-0" />
                <span className="text-[10px] font-medium text-white/40">{sessionStats.files} changed</span>
                <span className="text-[10px] font-semibold text-emerald-400">+{sessionStats.linesAdded}</span>
                <span className="text-[10px] font-semibold text-rose-400">-{sessionStats.linesRemoved}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* @ mention suggestions */}
        <AnimatePresence>
          {showMention && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: "spring", damping: 28, stiffness: 380 }, opacity: { duration: 0.15 } }}
              className="overflow-hidden"
            >
              <div className="pt-1 pb-2.5 border-t border-white/10">
                {folderPath && (
                  <div className="flex items-center gap-1 px-1 py-1 mb-0.5 text-[10px] text-white/35">
                    <button
                      type="button"
                      onMouseDown={e => { e.preventDefault(); setFolderPath(null); setMentionQuery(""); }}
                      className="hover:text-brand-pink transition-colors"
                    >
                      workspace
                    </button>
                    <span>/</span>
                    <span className="text-white/50">{folderPath.split("/").pop()}</span>
                  </div>
                )}
                {!treeLoaded && suggestions.length === 0 && (
                  <div className="px-1 py-1.5 text-[11px] text-white/35 flex items-center gap-1.5">
                    <Loader size={10} className="animate-spin shrink-0" />
                    Loading files...
                  </div>
                )}
                <div className="flex flex-col gap-0.5">
                  {suggestions.map((node, i) => {
                    const name = node.path.split("/").pop()!;
                    const isDir = node.type === "directory";
                    return (
                      <button
                        key={node.path}
                        type="button"
                        onMouseDown={e => { e.preventDefault(); selectSuggestion(node); }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 text-[12px] text-left rounded-lg transition-colors cursor-pointer ${
                          i === suggestionIdx ? "bg-white/10" : "hover:bg-white/8"
                        }`}
                      >
                        {isDir
                          ? <Folder size={13} className="shrink-0 text-blue-400" />
                          : <img src={getMaterialFileIcon(name)} alt="" className="w-3.5 h-3.5 shrink-0" />
                        }
                        <span className="text-white/80 font-medium">{name}{isDir ? "/" : ""}</span>
                        {!isDir && (
                          <span className="ml-auto text-[10px] text-white/25 truncate max-w-[100px]">{node.path}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Plan Questions panel */}
        <AnimatePresence>
          {showPlanPanel && planQuestion && (
            <motion.div
              key={planQuestion.id}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: "spring", damping: 28, stiffness: 380 }, opacity: { duration: 0.15 } }}
              className="overflow-hidden"
            >
              <div className="pt-2 pb-2.5 border-t border-white/10 space-y-2">
                <p className="text-[11px] font-semibold text-white/80 leading-snug">{planQuestion.question}</p>

                {/* Option chips */}
                <div className="flex flex-wrap gap-1.5">
                  {planQuestion.options.map(opt => {
                    const isChosen = !planCustomText && planSelected[planQuestion.id] === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setPlanCustomText("");
                          const next = { ...planSelected, [planQuestion.id]: opt.id };
                          setPlanSelected(next);
                          setTimeout(() => {
                            if (planIsLast) {
                              onPlanAnswer?.(next, planQuestions);
                              setShowPlanPanel(false);
                            } else {
                              setPlanStep(s => s + 1);
                            }
                          }, 160);
                        }}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-left transition-all border cursor-pointer ${
                          isChosen
                            ? 'bg-brand-pink/10 border-brand-pink/35 text-brand-pink'
                            : 'bg-white/[0.03] border-white/8 text-white/50 hover:text-white/75 hover:border-white/15'
                        }`}
                      >
                        <div className={`w-2.5 h-2.5 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                          isChosen ? 'border-brand-pink bg-brand-pink' : 'border-white/20'
                        }`}>
                          {isChosen && <div className="w-1 h-1 rounded-full bg-white" />}
                        </div>
                        {opt.text}
                      </button>
                    );
                  })}
                </div>

                {/* Custom text input */}
                <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-all ${
                  planCustomText ? 'border-white/20 bg-white/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
                }`}>
                  <input
                    type="text"
                    value={planCustomText}
                    onChange={e => setPlanCustomText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); advancePlan(); }
                    }}
                    placeholder="Or write your own answer…"
                    className="flex-1 bg-transparent text-[11px] text-white/70 placeholder:text-white/25 outline-none min-w-0"
                  />
                  <AnimatePresence>
                    {planCustomText.trim() && (
                      <motion.button
                        type="button"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.12 }}
                        onClick={() => advancePlan()}
                        className="w-5 h-5 rounded-md bg-brand-pink flex items-center justify-center shrink-0 hover:bg-brand-pink/80 transition-colors"
                      >
                        <ArrowRight className="w-3 h-3 text-white" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Todos panel */}
        <AnimatePresence>
          {!hasPlanQuestions && showTodos && todos && todos.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: "spring", damping: 28, stiffness: 380 }, opacity: { duration: 0.18 } }}
              className="overflow-hidden"
            >
              <div className="pb-3 pt-1 border-t border-white/10 space-y-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-white/25 pt-2">Tasks</p>
                {todos.map(todo => (
                  <div key={todo.id} className="flex items-center gap-2.5">
                    {todo.status === "completed"
                      ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                      : todo.status === "in_progress"
                      ? <Clock className="w-3 h-3 text-blue-400 shrink-0" />
                      : <Circle className="w-3 h-3 text-white/20 shrink-0" />
                    }
                    <span className={`text-[12px] font-medium leading-snug ${todo.status === "completed" ? "line-through text-white/25" : "text-white/70"}`}>
                      {todo.title}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
          {!hasPlanQuestions && showTodos && (!todos || todos.length === 0) && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="pb-3 pt-1 border-t border-white/10">
                <p className="text-[9px] font-bold uppercase tracking-widest text-white/25 pt-2 pb-1.5">Tasks</p>
                <p className="text-[11px] text-white/25 italic">No active tasks</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Main Input Layer */}
      <div className="relative z-10 -mt-[22px] overflow-hidden" style={{ borderRadius: '0 0 32px 32px' }}>
        <div
          className="bg-[#2E2E2E] w-full flex flex-col border border-white/5 border-t-0"
          style={{ clipPath: "polygon(20px 0px, calc(100% - 20px) 0px, 100% 20px, 100% 100%, 0% 100%, 0% 20px)" }}
        >
          {/* Text Area */}
          <div className="px-4 py-2 min-h-[40px] pt-3">
            <div className="relative max-h-[160px] overflow-y-auto scrollbar-none">
              <div className="relative">
                {/* Mirror overlay — renders @mentions in pink; textarea text is transparent on top */}
                <div
                  aria-hidden
                  className="absolute inset-0 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words pointer-events-none select-none overflow-hidden text-gray-200"
                  style={{ fontFamily: 'inherit' }}
                >
                {inputValue
                  ? inputValue.split(/(@\S+)/g).map((part, i) =>
                      part.startsWith("@") && mentionMap[part.slice(1)]
                        ? <span key={i} className="text-brand-pink font-medium">{part}</span>
                        : <span key={i}>{part}</span>
                    )
                  : null}
              </div>
              <textarea
                ref={textareaRef}
                className="relative w-full bg-transparent resize-none outline-none text-[12.5px] leading-relaxed placeholder:text-gray-500 overflow-hidden block"
                style={{ color: Object.keys(mentionMap).some(k => inputValue.includes(`@${k}`)) ? 'transparent' : undefined, caretColor: '#d1d5db', fontFamily: 'inherit' }}
                placeholder="Ask AI Agents... (type @ to mention files)"
                rows={1}
                value={inputValue}
                onChange={(e) => {
                  handleTextareaChange(e.target.value);
                  detectMention(e.target.value, e.target);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (mentionAnchor !== null && suggestions.length > 0) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setSuggestionIdx(i => Math.min(i + 1, suggestions.length - 1)); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setSuggestionIdx(i => Math.max(i - 1, 0)); return; }
                    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectSuggestion(suggestions[suggestionIdx]); return; }
                    if (e.key === "Escape") { setMentionAnchor(null); setFolderPath(null); return; }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmitClick();
                  }
                }}
              />
              </div>
            </div>

            {/* Pending image preview strip */}
            {pendingImages.length > 0 && (
              <div className="flex gap-2 pt-2 pb-1 overflow-x-auto scrollbar-none">
                {pendingImages.map(img => (
                  <div key={img.id} className="relative group flex-shrink-0">
                    <img
                      src={img.previewUrl}
                      alt={img.filename}
                      className={`h-14 w-14 object-cover rounded-lg border border-white/10 ${img.uploading ? "opacity-40" : ""}`}
                    />
                    {img.uploading && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader className="w-3.5 h-3.5 animate-spin text-white" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removePendingImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#1a1a1a] border border-white/20 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Actions Row */}
          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">

            {/* Left Actions */}
            <div className="flex items-center gap-1.5">
              {/* Plus Dropdown */}
              <div className="relative shrink-0">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="w-7 h-7 rounded-[9px] text-gray-400 hover:text-white hover:bg-white/5 transition-colors flex items-center justify-center outline-none focus:outline-none cursor-pointer">
                      <Plus size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-[230px] p-1.5 z-[100] rounded-[18px] bg-[#2A2A2D] text-white overflow-hidden border-none shadow-none">
                    <DropdownMenuItem
                      onSelect={(e) => { e.preventDefault(); fileInputRef.current?.click(); }}
                      className="gap-3 cursor-pointer rounded-[12px] py-2 px-2.5 flex items-start outline-none focus:bg-white/10 hover:bg-white/10"
                    >
                      <ImagePlus size={14} className="text-gray-400 shrink-0 mt-0.5" />
                      <div className="flex flex-col flex-1 gap-0.5">
                        <span className="text-[12px] font-semibold leading-none text-gray-100">Upload image</span>
                        <span className="text-[10px] text-gray-400 leading-snug">Attach an image for reference</span>
                      </div>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      onSelect={(e) => { e.preventDefault(); handleMultiAgentToggle(); }}
                      className="gap-3 cursor-pointer rounded-[12px] py-2 px-2.5 flex items-start outline-none focus:bg-white/10 hover:bg-white/10"
                    >
                      <Users size={14} className="text-gray-400 shrink-0 mt-0.5" />
                      <div className="flex flex-col flex-1 gap-0.5">
                        <span className="text-[12px] font-semibold leading-none text-gray-100">Multi Agent mode</span>
                        <span className="text-[10px] text-gray-400 leading-snug">Run parallel agents</span>
                      </div>
                      {multiAgent && <Check className="w-3.5 h-3.5 text-brand-pink shrink-0 mt-0.5" />}
                    </DropdownMenuItem>

                    <div className="h-px bg-white/10 my-1.5" />

                    <div className="flex items-center justify-between px-2.5 py-0.5 text-[10px] font-medium text-gray-400">
                      <span>Actions menu</span>
                      <div className="flex items-center gap-0.5">
                        <kbd className="pointer-events-none h-4.5 select-none items-center justify-center rounded-[3px] border border-white/10 bg-white/5 px-1 font-sans text-[8px] font-medium text-gray-400 flex shadow-[0_1px_0_rgba(255,255,255,0.05)]">Cmd</kbd>
                        <kbd className="pointer-events-none h-4.5 select-none items-center justify-center rounded-[3px] border border-white/10 bg-white/5 px-1 font-sans text-[8px] font-medium text-gray-400 flex shadow-[0_1px_0_rgba(255,255,255,0.05)]">I</kbd>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Build/Plan Mode Dropdown */}
              <div className="relative shrink-0">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1 px-2 py-1 rounded-[8px] cursor-pointer text-[11px] font-medium text-gray-400 hover:text-white hover:bg-white/5 data-[state=open]:bg-white/10 data-[state=open]:text-white outline-none transition-colors">
                      {activeMode === 'build' ? "Build mode" : "Plan mode"}
                      <ChevronDown className="w-3 h-3 opacity-50 text-white" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-[180px] p-1 z-[100] rounded-[18px] bg-[#2A2A2D] text-white border-none shadow-none">
                    <DropdownMenuItem
                      onClick={() => handleModeChange("plan")}
                      className="gap-2.5 cursor-pointer rounded-[10px] py-1.5 px-2 flex items-start outline-none focus:bg-white/10 hover:bg-white/10"
                    >
                      <div className="flex flex-col flex-1 gap-0.5">
                        <span className="text-[12px] font-semibold leading-none text-gray-100">Plan</span>
                        <span className="text-[10px] text-gray-400 leading-snug">Detailed plan before building</span>
                      </div>
                      {activeMode === 'plan' && <Check className="w-3.5 h-3.5 text-brand-pink shrink-0 mt-0.5" />}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleModeChange("build")}
                      className="gap-2.5 cursor-pointer rounded-[10px] py-1.5 px-2 flex items-start outline-none focus:bg-white/10 hover:bg-white/10"
                    >
                      <div className="flex flex-col flex-1 gap-0.5">
                        <span className="text-[12px] font-semibold leading-none text-gray-100">Build</span>
                        <span className="text-[10px] text-gray-400 leading-snug">Make changes directly</span>
                      </div>
                      {activeMode === 'build' && <Check className="w-3.5 h-3.5 text-brand-pink shrink-0 mt-0.5" />}
                    </DropdownMenuItem>
                    <div className="h-px bg-white/10 my-1" />
                    <div className="flex items-center justify-between px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                      <span>Toggle mode</span>
                      <div className="flex items-center gap-0.5">
                        <kbd className="pointer-events-none h-4.5 select-none items-center justify-center rounded-[3px] border border-white/10 bg-white/5 px-1 font-sans text-[8px] font-medium text-gray-400 flex">Ctrl</kbd>
                        <kbd className="pointer-events-none h-4.5 select-none items-center justify-center rounded-[3px] border border-white/10 bg-white/5 px-1 font-sans text-[8px] font-medium text-gray-400 flex">M</kbd>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Visual Editor toggle */}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('pf:toggle-visual-edit'))}
                className="flex items-center gap-1 px-2 py-1 rounded-[8px] cursor-pointer text-[11px] font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                <Wand2 size={11} />
                Visual editor
              </button>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={onToggleTodos}
                className={`w-7 h-7 flex items-center justify-center rounded-[9px] transition-colors cursor-pointer relative ${showTodos ? 'text-blue-400 bg-blue-500/10' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                <List size={13} />
                {hasTodos && !showTodos && (
                  <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] animate-pulse" />
                )}
              </button>
              <button className="w-7 h-7 flex items-center justify-center rounded-[9px] text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer mr-1">
                <Mic size={13} />
              </button>
              {effectiveRunning && (
                <button
                  onClick={onStop}
                  className="w-7 h-7 flex items-center justify-center rounded-[10px] bg-[#3E3D3D] hover:bg-[#4E4D4D] text-white transition-colors cursor-pointer"
                >
                  <Square size={10} className="fill-red-500 text-red-500" />
                </button>
              )}
              <button
                onClick={handleSubmitClick}
                disabled={!inputValue.trim()}
                className={`w-7 h-7 flex items-center justify-center rounded-[10px] transition-all ${
                  !inputValue.trim()
                    ? 'bg-[#3E3D3D] text-white/25 cursor-not-allowed'
                    : effectiveRunning
                    ? 'bg-amber-500 hover:opacity-90 text-white cursor-pointer'
                    : activeMode === 'build'
                    ? 'bg-brand-pink hover:opacity-90 text-white cursor-pointer'
                    : 'bg-white hover:bg-gray-100 text-[#1C1C1D] cursor-pointer'
                }`}
              >
                <ArrowUp size={14} />
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
