"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useUser, useAuth } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { useWorkspaceManager } from "@/hooks/use-workspace-manager";
import { useDemoAccessGuard } from "@/hooks/use-demo-access";
import { GithubRepo, Attachment } from "@/lib/types";
import { DEFAULT_FRAMEWORK } from "@/lib/constants";
import {
  Plus, Mic, MicOff, ArrowUp, Loader, BarChart2,
  ChevronDown, ChevronRight, ChevronLeft, Sparkles, Globe, CreditCard,
  ImagePlus, Users, Check, X, GitBranch, File, Menu, ArrowRight, Gift,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export default function Home() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const { isAccessGranted, isLoading: isDemoAccessLoading } = useDemoAccessGuard();
  const {
    systems,
    systemsLoading,
    isCreating,
    error,
    setError,
    initiateWorkspace,
    initiateRepoSetup,
    deleteWorkspace,
    clarificationQuestions,
    setClarificationQuestions,
    suggestionIdeas,
    setSuggestionIdeas,
    refinedInitiateWorkspace,
  } = useWorkspaceManager();

  // Input state
  const [inputValue, setInputValue] = useState("");
  const [showPromo, setShowPromo] = useState(true);
  const [promoConnected, setPromoConnected] = useState(true);
  const [activeMode, setActiveMode] = useState<"build" | "plan">("plan");
  const [multiAgent, setMultiAgent] = useState(false);
  const [plusMenuState, setPlusMenuState] = useState<"main" | "github">("main");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Attachment state
  const MAX_ATTACHMENTS = 5;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // GitHub state
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);

  // Voice state
  const [voiceActive, setVoiceActive] = useState(false);
  const recognitionRef = useRef<any>(null);
  const initialValueRef = useRef("");
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clarification modal state
  const [showClarification, setShowClarification] = useState(false);
  const [clarificationAnswer, setClarificationAnswer] = useState("");

  // Mobile sidebar state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Mobile bottom sheets
  const [plusSheetOpen, setPlusSheetOpen] = useState(false);
  const [plusSheetView, setPlusSheetView] = useState<"main" | "github">("main");
  const [modeSheetOpen, setModeSheetOpen] = useState(false);

  // Persist mode
  useEffect(() => {
    const saved = localStorage.getItem("ai-agents:planMode");
    setActiveMode(saved === "false" ? "build" : "plan");
    setMultiAgent(localStorage.getItem("pf:multiAgent") === "true");
  }, []);

  // Show clarification modal when questions arrive
  useEffect(() => {
    if (clarificationQuestions.length > 0) setShowClarification(true);
  }, [clarificationQuestions]);

  // Show error as toast
  useEffect(() => {
    if (error) {
      toast.error(error);
      setError(null);
    }
  }, [error, setError]);

  // GitHub: check connection + fetch repos
  useEffect(() => {
    if (!user) return;
    const check = async () => {
      try {
        const token = await getToken();
        const res = await fetch(`${BACKEND_URL}/api/github/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        setIsConnected(data.isConnected);
        if (data.isConnected) fetchRepos();
      } catch {
        setIsConnected(false);
      }
    };
    const fetchRepos = async () => {
      setIsLoadingRepos(true);
      try {
        const token = await getToken();
        const res = await fetch(`${BACKEND_URL}/api/github/repos`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (Array.isArray(data)) setRepos(data);
      } catch (err) {
        console.error("Failed to fetch repos:", err);
      } finally {
        setIsLoadingRepos(false);
      }
    };
    check();
  }, [user]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [inputValue]);

  // Speech recognition setup
  const stopVoice = useCallback(() => {
    setVoiceActive(false);
    recognitionRef.current?.stop();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(stopVoice, 4500);
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      const base = initialValueRef.current.trim();
      setInputValue(base ? `${base} ${transcript.trim()}` : transcript.trim());
    };
    rec.onerror = () => stopVoice();
    recognitionRef.current = rec;
    return () => { if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current); };
  }, [stopVoice]);

  const toggleVoice = () => {
    if (voiceActive) {
      stopVoice();
    } else {
      initialValueRef.current = inputValue;
      setVoiceActive(true);
      recognitionRef.current?.start();
      silenceTimerRef.current = setTimeout(stopVoice, 4500);
    }
  };

  const toggleMode = useCallback(() => {
    setActiveMode((prev) => {
      const next = prev === "plan" ? "build" : "plan";
      localStorage.setItem("ai-agents:planMode", next === "plan" ? "true" : "false");
      return next;
    });
  }, []);

  // Ctrl+M to toggle mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMode(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleMode]);

  // Attachment handlers
  const addImageFiles = useCallback((files: File[]) => {
    setAttachments((prev) => {
      const remaining = MAX_ATTACHMENTS - prev.length;
      if (remaining <= 0) return prev;
      const accepted = files.filter((f) => f.type.startsWith("image/")).slice(0, remaining);
      const next = [...prev];
      for (const file of accepted) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        next.push({ id, name: file.name, preview: URL.createObjectURL(file), file });
      }
      return next;
    });
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.preview?.startsWith("blob:")) URL.revokeObjectURL(removed.preview);
      return prev.filter((a) => a.id !== id);
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addImageFiles(Array.from(e.target.files));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.type.startsWith("image/")) { const f = item.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  }, [addImageFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault(); dragCounterRef.current += 1; setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault(); dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragging(false); }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault(); dragCounterRef.current = 0; setIsDragging(false);
    addImageFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")));
  }, [addImageFiles]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => { attachments.forEach((a) => { if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview); }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = async () => {
    if (isCreating) return;

    if (selectedRepo) {
      initiateRepoSetup(selectedRepo, inputValue.trim());
      return;
    }

    if (!inputValue.trim()) {
      toast.error("Please describe what you want to build");
      return;
    }

    const files = attachments.map((a) => a.file).filter((f): f is File => !!f);
    await initiateWorkspace(inputValue.trim(), DEFAULT_FRAMEWORK, files);
  };

  const handleSuggestionChipClick = (text: string) => {
    setInputValue(text);
    textareaRef.current?.focus();
  };

  const handleSuggestionSelect = async (suggestion: string) => {
    const projectName = suggestion.split(" - ")[0].trim();
    const msg = `Build a ${projectName.toLowerCase()}`;
    setSuggestionIdeas([]);
    setInputValue(msg);
    await initiateWorkspace(msg, DEFAULT_FRAMEWORK);
  };

  const handleClarificationSubmit = async () => {
    if (!clarificationAnswer.trim()) return;
    setShowClarification(false);
    setClarificationQuestions([]);
    const answer = clarificationAnswer.trim();
    setClarificationAnswer("");
    await refinedInitiateWorkspace(answer);
  };

  if (isDemoAccessLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0d0d0e]">
        <img
          src="/logos/logo.svg"
          alt="Loading"
          className="w-9 h-9"
          style={{ animation: "spin 3.8s linear infinite" }}
        />
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!isAccessGranted) {
    return null;
  }

  const filteredRepos = repos.filter((r) =>
    repoSearch.trim() ? r.name.toLowerCase().includes(repoSearch.toLowerCase()) : true
  );

  const canSubmit = Boolean(selectedRepo) || Boolean(inputValue.trim());

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-main text-white selection:bg-brand-pink/30 font-sans">
      {/* Sidebar — hidden on mobile */}
      <div className="hidden md:block">
        <Sidebar systems={systems} systemsLoading={systemsLoading} />
      </div>

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile-only top bar */}
        <div className="md:hidden flex items-center justify-between px-4 h-[52px] border-b border-white/5 shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-[10px] text-gray-400 hover:text-white hover:bg-white/8 transition-colors -ml-1"
          >
            <Menu size={20} />
          </button>
          <img src="/logos/logoname_dark.svg" alt="AI Agents" className="h-[18px] absolute left-1/2 -translate-x-1/2" />
          <div className="w-9" />
        </div>

        <div className="flex-1 flex flex-col items-center justify-center relative px-4 py-6 md:p-5 overflow-y-auto">
        <div className="w-full max-w-[820px] flex flex-col items-center gap-6 md:gap-9">
          <motion.h1
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            className="font-display text-[26px] md:text-[38px] font-bold tracking-tight text-center text-white/95 px-2"
          >
            What do you want to build?
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            className="w-full"
          >
            {/* Promo top layer — sits behind, peeks above main input (same trick as SystemInputBar status layer) */}
            <AnimatePresence initial={false} onExitComplete={() => setPromoConnected(false)}>
              {showPromo && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{
                    height: { duration: 0.34, ease: [0.4, 0, 0.2, 1] },
                    opacity: { duration: 0.18, ease: "easeOut" },
                  }}
                  style={{ overflow: "hidden" }}
                >
                  <div
                    onClick={() => router.push("/pricing")}
                    className="group flex items-center justify-between px-[16px] md:px-[24px] pt-[9px] pb-[26px] rounded-t-[20px] md:rounded-t-[24px] cursor-pointer"
                    style={{ background: "#a14a7d" }}
                  >
                    <div className="flex items-center gap-2">
                      <Gift className="w-[13px] h-[13px] text-white shrink-0" />
                      <span className="text-[12.5px] font-medium text-white">
                        Use code{" "}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText("PRETTI30");
                            toast.success("Code PRETTI30 copied!");
                          }}
                          className="font-bold tracking-wide px-1.5 py-0.5 rounded-md bg-white/20 hover:bg-white/30 transition-colors cursor-copy"
                        >
                          PRETTI30
                        </span>{" "}
                        to get <span className="font-bold">30% off</span>
                      </span>
                      <ArrowRight className="w-[13px] h-[13px] text-white/80 shrink-0 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowPromo(false); }}
                      className="w-5 h-5 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/20 transition-all cursor-pointer text-[14px] leading-none shrink-0"
                    >
                      ×
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              style={promoConnected ? { clipPath: "polygon(20px 0px, calc(100% - 20px) 0px, 100% 20px, 100% 100%, 0% 100%, 0% 20px)" } : undefined}
              className={`relative bg-bg-input border flex flex-col items-start gap-[8px] self-stretch min-h-[120px] md:min-h-[125px] h-auto py-[12px] px-[16px] md:px-[24px] transition-[margin,border-radius,background-color] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${promoConnected ? "z-10 -mt-[22px] rounded-b-[20px] md:rounded-b-[24px] border-t-0" : "rounded-[20px] md:rounded-[24px]"} ${isDragging ? "border-brand-pink/50 ring-2 ring-brand-pink/20" : "border-border-subtle"}`}
            >

              {selectedRepo && (
                <div className="flex items-center gap-2 pt-1 pb-0.5 w-full">
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-border-subtle text-[11px] font-medium text-white/80">
                    <GitBranch size={11} />
                    <span>{selectedRepo.name}</span>
                    <button
                      onClick={() => setSelectedRepo(null)}
                      className="ml-1 text-gray-500 hover:text-white transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </div>
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleGenerate(); } }}
                onPaste={handlePaste}
                rows={1}
                className="w-full bg-transparent resize-none outline-none text-[14px] md:text-[15px] placeholder:text-gray-500 pt-2 min-h-[52px] md:min-h-[56px] max-h-[180px] md:max-h-[240px] overflow-y-auto scrollbar-none text-white"
                placeholder={selectedRepo ? `Describe what you want to do in ${selectedRepo.name}...` : "Describe what you want to build..."}
              />

              <AnimatePresence>
                {attachments.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex flex-wrap gap-2 w-full pb-1"
                  >
                    {attachments.map((att) => (
                      <motion.div key={att.id} className="relative group">
                        <div className="relative w-16 h-16 rounded-xl overflow-visible border border-white/10">
                          {att.preview ? (
                            <img src={att.preview} alt={att.name} className="w-full h-full object-cover rounded-xl" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-white/5 rounded-xl">
                              <File className="w-5 h-5 text-white/30" />
                            </div>
                          )}
                          <button
                            onClick={() => removeAttachment(att.id)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white/20 backdrop-blur-sm text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-center justify-between w-full pt-0.5">
                <div className="flex items-center gap-2">

                  {/* + Menu — mobile: bottom sheet / desktop: dropdown */}
                  <button
                    className="md:hidden p-1.5 rounded-[12px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center"
                    onClick={() => { setPlusSheetView("main"); setPlusSheetOpen(true); }}
                  >
                    <Plus size={20} />
                  </button>
                  <div className="hidden md:block">
                    <DropdownMenu onOpenChange={(open) => { if (!open) setTimeout(() => setPlusMenuState("main"), 300); }}>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1.5 rounded-[12px] text-gray-400 hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center outline-none focus:outline-none cursor-pointer">
                          <Plus size={20} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-[230px] p-1.5 z-[100] shadow-2xl rounded-[18px] bg-[#2A2A2D] border-white/10 text-white overflow-hidden">
                        <AnimatePresence mode="wait" initial={false}>
                          {plusMenuState === "main" && (
                            <motion.div key="main" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.12 }} className="flex flex-col">
                              <DropdownMenuItem
                                onClick={() => fileInputRef.current?.click()}
                                className="gap-3 cursor-pointer rounded-[12px] py-2 px-2.5 flex items-start outline-none hover:bg-white/10"
                              >
                                <ImagePlus size={14} className="text-gray-400 shrink-0 mt-0.5" />
                                <div className="flex flex-col flex-1 gap-0.5">
                                  <span className="text-[12px] font-semibold text-gray-100">Upload image</span>
                                  <span className="text-[10px] text-gray-400">Attach an image for reference</span>
                                </div>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={(e) => { e.preventDefault(); setMultiAgent((v) => { const n = !v; localStorage.setItem("pf:multiAgent", String(n)); return n; }); }}
                                className="gap-3 cursor-pointer rounded-[12px] py-2 px-2.5 flex items-start outline-none hover:bg-white/10"
                              >
                                <Users size={14} className="text-gray-400 shrink-0 mt-0.5" />
                                <div className="flex flex-col flex-1 gap-0.5">
                                  <span className="text-[12px] font-semibold text-gray-100">Multi Agent mode</span>
                                  <span className="text-[10px] text-gray-400">Run parallel agents</span>
                                </div>
                                {multiAgent && <Check className="w-3.5 h-3.5 text-brand-pink shrink-0 mt-0.5" />}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={(e) => { e.preventDefault(); setPlusMenuState("github"); }}
                                className="gap-3 cursor-pointer rounded-[12px] py-2 px-2.5 flex items-start outline-none hover:bg-white/10"
                              >
                                <img src="/icons/github.png" alt="GitHub" className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-70 invert" />
                                <div className="flex flex-col flex-1 gap-0.5">
                                  <span className="text-[12px] font-semibold text-gray-100">GitHub repos</span>
                                  <span className="text-[10px] text-gray-400">Connect your codebase</span>
                                </div>
                                <ChevronRight className="ml-auto opacity-50 shrink-0 mt-0.5" size={12} />
                              </DropdownMenuItem>
                              <DropdownMenuSeparator className="bg-white/10 my-1" />
                              <div className="flex items-center justify-between px-2.5 py-0.5 text-[10px] font-medium text-gray-500">
                                <span>Actions menu</span>
                                <div className="flex items-center gap-0.5">
                                  <kbd className="pointer-events-none h-4 select-none rounded-[3px] border border-white/10 bg-white/5 px-1 text-[8px] font-medium text-gray-400 flex items-center">Cmd</kbd>
                                  <kbd className="pointer-events-none h-4 select-none rounded-[3px] border border-white/10 bg-white/5 px-1 text-[8px] font-medium text-gray-400 flex items-center">I</kbd>
                                </div>
                              </div>
                            </motion.div>
                          )}
                          {plusMenuState === "github" && (
                            <motion.div key="github" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.12 }} className="flex flex-col">
                              <div className="flex items-center gap-2 px-1 py-1 mb-1">
                                <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPlusMenuState("main"); }} className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors outline-none cursor-pointer">
                                  <ChevronLeft size={16} />
                                </button>
                                <span className="text-xs font-semibold text-gray-400">{isConnected ? "Select Repository" : "Connect GitHub"}</span>
                              </div>
                              <DropdownMenuSeparator className="bg-white/10 mb-1 mx-1" />
                              {isConnected === false && (
                                <DropdownMenuItem onClick={() => user && (window.location.href = `${BACKEND_URL}/api/github/connect?userId=${user.id}`)} className="gap-2 cursor-pointer rounded-[10px] py-2 px-2.5 flex items-center outline-none hover:bg-white/10">
                                  <GitBranch size={14} className="text-gray-400" />
                                  <span className="text-[12px] font-medium">Connect GitHub account</span>
                                </DropdownMenuItem>
                              )}
                              {isConnected === true && (
                                <>
                                  <div className="px-2 pb-1.5">
                                    <input value={repoSearch} onChange={(e) => setRepoSearch(e.target.value)} onClick={(e) => e.stopPropagation()} placeholder="Search repos..." className="w-full bg-white/5 border border-white/10 rounded-lg h-7 px-2.5 text-[11px] text-white placeholder:text-gray-500 outline-none focus:border-white/20" />
                                  </div>
                                  <div className="max-h-[160px] overflow-y-auto">
                                    {isLoadingRepos ? (
                                      <div className="py-4 text-center text-[11px] text-gray-500">Loading repos...</div>
                                    ) : filteredRepos.length === 0 ? (
                                      <div className="py-4 text-center text-[11px] text-gray-500">No repos found</div>
                                    ) : (
                                      filteredRepos.map((repo) => (
                                        <DropdownMenuItem key={repo.id} onClick={() => { setSelectedRepo(repo); setPlusMenuState("main"); }} className="gap-2 cursor-pointer rounded-[10px] py-1.5 px-2 flex items-center outline-none hover:bg-white/10">
                                          <div className="flex flex-col flex-1 min-w-0">
                                            <span className="text-[12px] font-medium leading-none truncate">{repo.name}</span>
                                            {repo.language && <span className="text-[10px] text-gray-500 mt-0.5">{repo.language}</span>}
                                          </div>
                                          {repo.private && <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500 shrink-0">Private</span>}
                                          {selectedRepo?.id === repo.id && <Check size={12} className="text-brand-pink shrink-0" />}
                                        </DropdownMenuItem>
                                      ))
                                    )}
                                  </div>
                                </>
                              )}
                              {isConnected === null && <div className="py-4 text-center text-[11px] text-gray-500">Checking connection...</div>}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Mode selector — mobile: bottom sheet / desktop: dropdown */}
                  <button
                    className="md:hidden flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-medium text-gray-300 bg-white/[0.06] hover:text-white hover:bg-white/10 transition-colors"
                    onClick={() => setModeSheetOpen(true)}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeMode === "build" ? "bg-brand-pink" : "bg-white"}`} />
                    <span>{activeMode === "plan" ? "Plan" : "Build"}</span>
                    <ChevronDown className="w-3.5 h-3.5 opacity-50" />
                  </button>
                  <div className="hidden md:block">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] cursor-pointer text-[11px] font-medium text-gray-300 bg-white/[0.06] hover:text-white hover:bg-white/10 data-[state=open]:bg-white/10 data-[state=open]:text-white outline-none focus:outline-none">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activeMode === "build" ? "bg-brand-pink" : "bg-white"}`} />
                          <span>{activeMode === "plan" ? "Plan mode" : "Build mode"}</span>
                          <ChevronDown className="w-3.5 h-3.5 opacity-50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="bottom" sideOffset={8} className="w-[180px] p-1 z-[100] shadow-2xl rounded-[18px] bg-[#2A2A2D] border-white/10 text-white">
                        <DropdownMenuItem onClick={() => { setActiveMode("plan"); localStorage.setItem("ai-agents:planMode", "true"); }} className="gap-2.5 cursor-pointer rounded-[10px] py-1.5 px-2 flex items-start outline-none hover:bg-white/10">
                          <div className="flex flex-col flex-1 gap-0.5">
                            <span className="text-[12px] font-semibold text-gray-100">Plan</span>
                            <span className="text-[10px] text-gray-400">Detailed plan before building</span>
                          </div>
                          {activeMode === "plan" && <Check className="w-3.5 h-3.5 text-brand-pink mt-0.5 shrink-0" />}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setActiveMode("build"); localStorage.setItem("ai-agents:planMode", "false"); }} className="gap-2.5 cursor-pointer rounded-[10px] py-1.5 px-2 flex items-start outline-none hover:bg-white/10">
                          <div className="flex flex-col flex-1 gap-0.5">
                            <span className="text-[12px] font-semibold text-gray-100">Build</span>
                            <span className="text-[10px] text-gray-400">Make changes directly</span>
                          </div>
                          {activeMode === "build" && <Check className="w-3.5 h-3.5 text-brand-pink mt-0.5 shrink-0" />}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-white/10 my-1" />
                        <div className="flex items-center justify-between px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                          <span>Toggle mode</span>
                          <div className="flex items-center gap-0.5">
                            <kbd className="pointer-events-none h-4 select-none rounded-[3px] border border-white/10 bg-white/5 px-1.5 text-[8px] font-medium text-gray-400 flex items-center">Ctrl</kbd>
                            <kbd className="pointer-events-none h-4 select-none rounded-[3px] border border-white/10 bg-white/5 px-1.5 text-[8px] font-medium text-gray-400 flex items-center">M</kbd>
                          </div>
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleVoice}
                    className={`p-2 rounded-full transition-colors ${voiceActive ? "text-red-400 bg-red-500/10" : "text-gray-400 hover:text-white hover:bg-white/5"}`}
                  >
                    {voiceActive ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                  <button
                    onClick={handleGenerate}
                    disabled={!canSubmit || isCreating}
                    className={`p-2 md:p-2 rounded-[12px] transition-all active:scale-95 shadow-sm flex items-center justify-center cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                      activeMode === "build"
                        ? "bg-brand-pink text-white hover:opacity-90"
                        : "bg-white text-[#1C1C1C] hover:bg-white/90"
                    }`}
                  >
                    {isCreating
                      ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}><Loader size={18} /></motion.div>
                      : <ArrowUp size={18} />
                    }
                  </button>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Suggestion chips — dynamic from backend or static defaults */}
          <AnimatePresence mode="wait">
            {suggestionIdeas.length > 0 ? (
              <motion.div
                key="backend-suggestions"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="flex flex-col w-full gap-2"
              >
                <p className="text-[11px] text-gray-500 font-medium text-center">Pick one of these instead:</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {suggestionIdeas.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => handleSuggestionSelect(s)}
                      className="px-3.5 py-1.5 rounded-[12px] border border-brand-pink/30 bg-brand-pink/5 text-[12.5px] text-brand-pink hover:bg-brand-pink/10 transition-colors cursor-pointer"
                    >
                      {s}
                    </button>
                  ))}
                  <button
                    onClick={() => setSuggestionIdeas([])}
                    className="px-3 py-1.5 rounded-[12px] border border-border-subtle text-[12px] text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="default-chips"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="w-full mt-1"
              >
                {/* Mobile: 2×2 grid */}
                <div className="grid grid-cols-2 gap-2 md:hidden">
                  <MobileChip icon={<BarChart2 size={14} />} label="SaaS Dashboard" sublabel="Analytics & metrics" onClick={() => handleSuggestionChipClick("Build a SaaS dashboard")} />
                  <MobileChip icon={<Sparkles size={14} />} label="AI Chat App" sublabel="LLM-powered chat" onClick={() => handleSuggestionChipClick("Build an AI chat app")} />
                  <MobileChip icon={<Globe size={14} />} label="Landing Page" sublabel="Marketing site" onClick={() => handleSuggestionChipClick("Create a landing page")} />
                  <MobileChip icon={<CreditCard size={14} />} label="Stripe Payments" sublabel="Accept payments" onClick={() => handleSuggestionChipClick("Set up Stripe payments")} />
                </div>
                {/* Desktop: centered pill chips */}
                <div className="hidden md:flex flex-wrap items-center justify-center gap-2.5 max-w-xl mx-auto">
                  <SuggestionChip icon={<BarChart2 size={13} />} label="Build SaaS Dashboard" onClick={() => handleSuggestionChipClick("Build a SaaS dashboard")} />
                  <SuggestionChip icon={<Sparkles size={13} />} label="Build AI Chat App" onClick={() => handleSuggestionChipClick("Build an AI chat app")} />
                  <SuggestionChip icon={<Globe size={13} />} label="Create Landing Page" onClick={() => handleSuggestionChipClick("Create a landing page")} />
                  <SuggestionChip icon={<CreditCard size={13} />} label="Set Up Stripe Payments" onClick={() => handleSuggestionChipClick("Set up Stripe payments")} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>

        <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} className="hidden" />
        </div>
      </main>

      {/* Mobile: + (actions) bottom sheet */}
      <AnimatePresence>
        {plusSheetOpen && (
          <>
            <motion.div key="plus-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[160] bg-black/60 backdrop-blur-sm md:hidden" onClick={() => { setPlusSheetOpen(false); setTimeout(() => setPlusSheetView("main"), 300); }} />
            <motion.div key="plus-sheet" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", damping: 32, stiffness: 320 }}
              className="fixed bottom-0 left-0 right-0 z-[161] rounded-t-[24px] bg-[#1c1c1e] border-t border-white/[0.08] md:hidden overflow-hidden">
              {/* drag handle */}
              <div className="flex justify-center pt-3 pb-0.5"><div className="w-9 h-1 rounded-full bg-white/15" /></div>

              <AnimatePresence mode="wait" initial={false}>
                {plusSheetView === "main" && (
                  <motion.div key="sheet-main" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.15 }}>
                    <p className="px-5 pt-3 pb-2 text-[11px] font-semibold text-white/30 uppercase tracking-widest">Actions</p>
                    <div className="px-3 pb-8 flex flex-col gap-1">
                      <SheetRow icon={<ImagePlus size={16} />} label="Upload image" sublabel="Attach an image for reference"
                        onClick={() => { fileInputRef.current?.click(); setPlusSheetOpen(false); }} />
                      <SheetRow icon={<Users size={16} />} label="Multi Agent mode" sublabel="Run parallel agents"
                        right={multiAgent ? <div className="w-2 h-2 rounded-full bg-brand-pink" /> : undefined}
                        onClick={() => { setMultiAgent((v) => { const n = !v; localStorage.setItem("pf:multiAgent", String(n)); return n; }); }} />
                      <SheetRow icon={<img src="/icons/github.png" alt="GitHub" className="w-4 h-4 opacity-60 invert" />} label="GitHub repos" sublabel="Connect your codebase"
                        right={<ChevronRight size={14} className="text-white/30" />}
                        onClick={() => setPlusSheetView("github")} />
                    </div>
                  </motion.div>
                )}

                {plusSheetView === "github" && (
                  <motion.div key="sheet-github" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
                    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                      <button onClick={() => setPlusSheetView("main")} className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/8 transition-colors">
                        <ChevronLeft size={16} />
                      </button>
                      <p className="text-[13px] font-semibold text-white">{isConnected ? "Select Repository" : "Connect GitHub"}</p>
                    </div>
                    <div className="px-4 pb-8">
                      {isConnected === false && (
                        <button onClick={() => user && (window.location.href = `${BACKEND_URL}/api/github/connect?userId=${user.id}`)}
                          className="w-full flex items-center gap-3 py-3 px-4 rounded-[14px] bg-white/5 border border-white/8 hover:bg-white/10 transition-colors">
                          <GitBranch size={16} className="text-gray-400" />
                          <span className="text-[13px] font-medium text-white/80">Connect GitHub account</span>
                        </button>
                      )}
                      {isConnected === true && (
                        <>
                          <input value={repoSearch} onChange={(e) => setRepoSearch(e.target.value)} placeholder="Search repos…"
                            className="w-full bg-white/5 border border-white/10 rounded-xl h-9 px-3.5 text-[13px] text-white placeholder:text-white/25 outline-none focus:border-white/20 mb-3" />
                          <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1">
                            {isLoadingRepos ? (
                              <p className="py-6 text-center text-[12px] text-white/30">Loading repos…</p>
                            ) : filteredRepos.length === 0 ? (
                              <p className="py-6 text-center text-[12px] text-white/30">No repos found</p>
                            ) : filteredRepos.map((repo) => (
                              <button key={repo.id} onClick={() => { setSelectedRepo(repo); setPlusSheetOpen(false); setTimeout(() => setPlusSheetView("main"), 300); }}
                                className={`flex items-center gap-3 py-2.5 px-3.5 rounded-[12px] transition-colors text-left ${selectedRepo?.id === repo.id ? "bg-brand-pink/10 border border-brand-pink/20" : "hover:bg-white/5"}`}>
                                <div className="flex flex-col flex-1 min-w-0">
                                  <span className="text-[13px] font-medium text-white/80 truncate">{repo.name}</span>
                                  {repo.language && <span className="text-[11px] text-white/30">{repo.language}</span>}
                                </div>
                                {repo.private && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/30 shrink-0">Private</span>}
                                {selectedRepo?.id === repo.id && <Check size={13} className="text-brand-pink shrink-0" />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      {isConnected === null && <p className="py-6 text-center text-[12px] text-white/30">Checking connection…</p>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile: mode bottom sheet */}
      <AnimatePresence>
        {modeSheetOpen && (
          <>
            <motion.div key="mode-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[160] bg-black/60 backdrop-blur-sm md:hidden" onClick={() => setModeSheetOpen(false)} />
            <motion.div key="mode-sheet" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", damping: 32, stiffness: 320 }}
              className="fixed bottom-0 left-0 right-0 z-[161] rounded-t-[24px] bg-[#1c1c1e] border-t border-white/[0.08] md:hidden overflow-hidden">
              <div className="flex justify-center pt-3 pb-0.5"><div className="w-9 h-1 rounded-full bg-white/15" /></div>
              <p className="px-5 pt-3 pb-2 text-[11px] font-semibold text-white/30 uppercase tracking-widest">Mode</p>
              <div className="px-3 pb-8 flex flex-col gap-1">
                <SheetRow icon={<Sparkles size={16} />} label="Plan mode" sublabel="Detailed plan before building"
                  right={activeMode === "plan" ? <Check size={15} className="text-brand-pink" /> : undefined}
                  onClick={() => { setActiveMode("plan"); localStorage.setItem("ai-agents:planMode", "true"); setModeSheetOpen(false); }} />
                <SheetRow icon={<ArrowUp size={16} />} label="Build mode" sublabel="Make changes directly"
                  right={activeMode === "build" ? <Check size={15} className="text-brand-pink" /> : undefined}
                  onClick={() => { setActiveMode("build"); localStorage.setItem("ai-agents:planMode", "false"); setModeSheetOpen(false); }} />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile sidebar drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              key="mobile-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[150] bg-black/60 backdrop-blur-sm md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              key="mobile-drawer"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 280 }}
              className="fixed top-0 left-0 z-[151] h-screen md:hidden"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest("a")) setMobileMenuOpen(false);
              }}
            >
              <Sidebar systems={systems} systemsLoading={systemsLoading} defaultCollapsed={false} onCollapse={() => setMobileMenuOpen(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Clarification modal */}
      <AnimatePresence>
        {showClarification && clarificationQuestions.length > 0 && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm"
              onClick={() => setShowClarification(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: "spring", damping: 30, stiffness: 400 }}
              className="fixed inset-x-0 bottom-0 md:inset-0 z-[81] flex items-end md:items-center justify-center md:p-4 pointer-events-none"
            >
              <div className="w-full md:max-w-[480px] bg-[#1a1a1c] border border-white/[0.08] rounded-t-2xl md:rounded-2xl p-5 md:p-6 pointer-events-auto shadow-2xl">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-[15px] font-bold text-white tracking-tight">A few questions before we start</h3>
                    <p className="text-[11px] text-white/40 mt-0.5">Help me understand your project better.</p>
                  </div>
                  <button
                    onClick={() => setShowClarification(false)}
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
                  >
                    <X size={15} />
                  </button>
                </div>

                <ul className="flex flex-col gap-2.5 mb-5">
                  {clarificationQuestions.map((q: any, i: number) => (
                    <li key={i} className="text-[13px] text-white/70 leading-relaxed">
                      <span className="text-white/30 mr-1.5">{i + 1}.</span>
                      {typeof q === "string" ? q : q.question || JSON.stringify(q)}
                    </li>
                  ))}
                </ul>

                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={clarificationAnswer}
                    onChange={(e) => setClarificationAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleClarificationSubmit(); if (e.key === "Escape") setShowClarification(false); }}
                    placeholder="Your answer..."
                    className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-xl h-10 px-3.5 text-[13px] text-white placeholder:text-white/25 outline-none focus:border-white/20 transition-colors"
                  />
                  <button
                    onClick={handleClarificationSubmit}
                    disabled={!clarificationAnswer.trim() || isCreating}
                    className="px-5 rounded-xl bg-white text-[#1C1C1C] text-[13px] font-semibold hover:bg-white/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isCreating ? <Loader size={14} className="animate-spin" /> : "Continue"}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function SuggestionChip({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-[12px] border border-border-subtle bg-transparent text-[12.5px] text-gray-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
    >
      <span className="text-gray-400 flex items-center shrink-0">{icon}</span>
      {label}
    </button>
  );
}

function SheetRow({ icon, label, sublabel, right, onClick }: { icon: React.ReactNode; label: string; sublabel?: string; right?: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3.5 w-full px-4 py-3.5 rounded-[16px] hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left"
    >
      <div className="w-8 h-8 rounded-[10px] bg-white/[0.06] flex items-center justify-center text-gray-400 shrink-0">{icon}</div>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[13.5px] font-semibold text-white/85 leading-tight">{label}</span>
        {sublabel && <span className="text-[11px] text-white/30 mt-0.5 leading-tight">{sublabel}</span>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </button>
  );
}

function MobileChip({ icon, label, sublabel, onClick }: { icon: React.ReactNode; label: string; sublabel: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-2.5 p-3 rounded-[14px] border border-border-subtle bg-white/[0.03] hover:bg-white/[0.07] hover:border-white/10 transition-colors cursor-pointer text-left active:scale-[0.97]"
    >
      <span className="text-gray-400 flex items-center shrink-0 mt-0.5">{icon}</span>
      <div className="flex flex-col min-w-0">
        <span className="text-[12.5px] font-semibold text-white/80 leading-tight truncate">{label}</span>
        <span className="text-[10.5px] text-gray-500 mt-0.5 leading-tight">{sublabel}</span>
      </div>
    </button>
  );
}
