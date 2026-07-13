"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-client";
import { ArrowLeft, Loader2, AlertTriangle, ChevronDown, CheckCircle2, Lock } from "lucide-react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import PageShell from "@/components/PageShell";
import { CaseStatusBadge } from "@/components/support/CaseStatusBadge";
import { ChatMessage, AgentMarkdown, AgentAvatar } from "@/components/support/ChatMessage";
import { SupportChatInput } from "@/components/support/SupportChatInput";
import { AgentThinkingState } from "@/components/support/AgentThinkingState";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const WS_URL = API_URL.replace(/^http/, "ws");

interface Message {
  id: string;
  role: "USER" | "AGENT" | "SYSTEM";
  content: string;
  createdAt: string;
}

interface SupportCase {
  id: string;
  caseNumber: number;
  title?: string | null;
  status: string;
  workspace?: { id: string; name: string } | null;
  messages: Message[];
  userRating?: number | null;
}

interface ToolCall {
  id: string;
  toolName: string;
  status: "calling" | "done";
}

type ConfirmMode = null | "escalate" | "close";

export default function CasePage() {
  const params = useParams();
  const router = useRouter();
  const { getToken } = useAuth();
  const caseId = params.caseId as string;

  const [supportCase, setSupportCase] = useState<SupportCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [agentRunning, setAgentRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [agentError, setAgentError] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const agentStartTimeRef = useRef<number>(0);
  const justStreamedMsgIdRef = useRef<string | null>(null);

  const authFetch = useCallback(
    async (url: string, opts?: RequestInit) => {
      const token = await getToken();
      return fetch(url, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(opts?.headers || {}),
        },
      });
    },
    [getToken],
  );

  useEffect(() => {
    authFetch(`${API_URL}/api/support/cases/${caseId}`)
      .then((r) => {
        if (r.status === 404) throw new Error("Case not found");
        if (r.status === 403) throw new Error("Access denied");
        if (!r.ok) throw new Error("Failed to load case");
        return r.json();
      })
      .then(setSupportCase)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [caseId, authFetch]);

  useEffect(() => {
    if (!caseId) return;
    let alive = true;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = async () => {
      if (!alive) return;
      const token = await getToken();
      const ws = new WebSocket(`${WS_URL}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "AUTH",
            payload: { workspaceId: caseId },
            meta: { requestId: crypto.randomUUID(), token },
          }),
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const { type, payload } = msg;
          if (payload?.caseId && payload.caseId !== caseId) return;

          if (type === "SUPPORT_AGENT_START") {
            agentStartTimeRef.current = Date.now();
            setAgentRunning(true);
            setStreamingText("");
            setActiveToolCalls([]);
            setAgentError(null);
          } else if (type === "SUPPORT_AGENT_TOKEN") {
            setStreamingText((prev) => prev + (payload?.token || ""));
          } else if (type === "SUPPORT_AGENT_TOOL_CALL") {
            const { toolName, status } = payload;
            setActiveToolCalls((prev) => {
              if (status === "done") {
                return prev.map((t) =>
                  t.toolName === toolName && t.status === "calling" ? { ...t, status: "done" } : t,
                );
              }
              if (status === "calling") {
                return [...prev, { id: crypto.randomUUID(), toolName, status: "calling" }];
              }
              return prev;
            });
          } else if (type === "SUPPORT_AGENT_DONE") {
            authFetch(`${API_URL}/api/support/cases/${caseId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => {
                if (data) {
                  const lastAgent = [...data.messages].reverse().find((m: { role: string }) => m.role === 'AGENT');
                  if (lastAgent) justStreamedMsgIdRef.current = lastAgent.id;
                  setSupportCase(data);
                }
                setAgentRunning(false);
                setStreamingText("");
                setActiveToolCalls([]);
              })
              .catch(() => {
                setAgentRunning(false);
                setStreamingText("");
                setActiveToolCalls([]);
              });
          } else if (type === "SUPPORT_AGENT_ERROR") {
            setAgentRunning(false);
            setStreamingText("");
            setActiveToolCalls([]);
            setAgentError("Something went wrong. Please try again.");
            authFetch(`${API_URL}/api/support/cases/${caseId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => { if (data) setSupportCase(data); })
              .catch(() => {});

          } else if (type === "SUPPORT_CASE_STATUS") {
            setSupportCase((prev) => (prev ? { ...prev, status: payload.status } : prev));
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (alive) reconnectTimeout = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, [caseId, getToken, authFetch]);

  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    if (!userScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } else {
      setShowScrollBtn(true);
    }
  }, [supportCase?.messages, streamingText, agentRunning, userScrolledUp]);

  const handleScroll = useCallback(() => {
    const near = isNearBottom();
    setUserScrolledUp(!near);
    if (near) setShowScrollBtn(false);
  }, [isNearBottom]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setUserScrolledUp(false);
    setShowScrollBtn(false);
  };

  const sendMessage = async () => {
    if (!input.trim() || sending || agentRunning) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    setAgentError(null);
    try {
      const res = await authFetch(`${API_URL}/api/support/cases/${caseId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) throw new Error("Failed to send");
      const msg = await res.json();
      setSupportCase((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                { id: msg.id, role: "USER", content: text, createdAt: new Date().toISOString() },
              ],
              status: prev.status === "RESOLVED" ? "OPEN" : prev.status,
            }
          : prev,
      );
    } catch {
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const handleEscalate = async () => {
    setActionLoading(true);
    try {
      const res = await authFetch(`${API_URL}/api/support/cases/${caseId}/escalate`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSupportCase(data);
      }
    } finally {
      setActionLoading(false);
      setConfirmMode(null);
    }
  };

  const handleClose = async () => {
    setActionLoading(true);
    try {
      await authFetch(`${API_URL}/api/support/cases/${caseId}/close`, { method: "POST" });
      setSupportCase((prev) => (prev ? { ...prev, status: "CLOSED" } : prev));
    } finally {
      setActionLoading(false);
      setConfirmMode(null);
    }
  };

  const handleRate = useCallback(
    async (rating: 1 | -1) => {
      await authFetch(`${API_URL}/api/support/cases/${caseId}/rate`, {
        method: "POST",
        body: JSON.stringify({ rating }),
      });
    },
    [authFetch, caseId],
  );

  if (loading) {
    return (
      <PageShell>
        <div className="flex-1 flex items-center justify-center" style={{ background: '#1C1C1C' }}>
          <Loader2 className="w-5 h-5 animate-spin text-white/20" />
        </div>
      </PageShell>
    );
  }

  if (error || !supportCase) {
    return (
      <PageShell>
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ background: '#1C1C1C' }}>
          <AlertTriangle className="w-7 h-7 text-red-400/50" />
          <p className="text-[13px] text-white/35">{error || "Case not found"}</p>
          <Link href="/support" className="text-[12px] text-white/25 hover:text-white/50 underline">
            Back to Support
          </Link>
        </div>
      </PageShell>
    );
  }

  const isClosed = supportCase.status === "CLOSED";
  const isEscalated = supportCase.status === "ESCALATED";
  const isResolved = supportCase.status === "RESOLVED";

  const caseWorkspaces = supportCase.workspace
    ? [{ id: supportCase.workspace.id, name: supportCase.workspace.name }]
    : [];
  const caseWorkspaceId = supportCase.workspace?.id ?? "";

  return (
    <PageShell>
      <div className="flex-1 flex flex-col min-h-0" style={{ background: '#1C1C1C' }}>

        {/* Compact sticky header */}
        <div
          className="shrink-0 flex items-center gap-3 px-10 md:px-16 py-0 border-b border-white/[0.07] z-10"
          style={{ background: 'rgba(37,37,37,0.95)', backdropFilter: 'blur(12px)', height: 44 }}
        >
          <Link
            href="/support"
            className="p-1 rounded-md text-white/30 hover:text-white/65 hover:bg-white/[0.06] transition-colors shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </Link>

          <span className="text-[11px] font-mono text-[#FF15DC]/50 shrink-0">#{supportCase.caseNumber}</span>

          <span className="text-white/[0.08] text-[11px] shrink-0">·</span>

          <h1 className="text-[13px] font-medium text-white/70 truncate flex-1 min-w-0">
            {supportCase.title || "Support Case"}
          </h1>

          <div className="flex items-center gap-1.5 shrink-0">
            <CaseStatusBadge status={supportCase.status} />

            {!isClosed && !isEscalated && (
              <GlassButton
                size="xs"
                onClick={() => setConfirmMode(confirmMode === "escalate" ? null : "escalate")}
                className="text-red-400/70"
              >
                Escalate
              </GlassButton>
            )}
            {!isClosed && (
              <GlassButton
                size="xs"
                onClick={() => setConfirmMode(confirmMode === "close" ? null : "close")}
              >
                Close
              </GlassButton>
            )}
          </div>
        </div>

        {/* Confirm bar */}
        <AnimatePresence>
          {confirmMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="shrink-0 overflow-hidden"
            >
              <div className="flex items-center justify-between px-10 md:px-16 py-2.5 border-b border-white/[0.05]" style={{ background: 'rgba(37,37,37,0.95)' }}>
                <p className="text-[12px] text-white/40">
                  {confirmMode === "escalate"
                    ? "Team will be notified and follow up via email."
                    : "Case will be closed and archived."}
                </p>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <GlassButton
                    size="xs"
                    onClick={() => setConfirmMode(null)}
                    className="text-white/40"
                  >
                    Cancel
                  </GlassButton>
                  <GlassButton
                    size="xs"
                    onClick={confirmMode === "escalate" ? handleEscalate : handleClose}
                    disabled={actionLoading}
                    className={confirmMode === "escalate" ? "text-red-400/80" : ""}
                  >
                    {actionLoading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : confirmMode === "escalate" ? (
                      "Confirm escalation"
                    ) : (
                      "Confirm close"
                    )}
                  </GlassButton>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Scrollable messages */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto scrollbar-subtle"
        >
          <div className="px-10 md:px-16 pt-8 pb-6">

            {/* Agent section header */}
            <div className="flex items-center gap-2.5 mb-5">
              <img src="/logos/logo.svg" alt="Prettiflow" className="w-[18px] h-[18px]" />
              <h3 className="text-[16px] font-semibold text-white/85">Prettiflow Agent</h3>
            </div>

            {/* Messages */}
            {supportCase.messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                role={msg.role}
                content={msg.content}
                noAnimate={msg.id === justStreamedMsgIdRef.current}
                onRate={msg.role === "AGENT" ? handleRate : undefined}
              />
            ))}

            {/* Thinking state */}
            <AnimatePresence>
              {agentRunning && !streamingText && (
                <AgentThinkingState
                  key="thinking"
                  activeToolCalls={activeToolCalls}
                  startTime={agentStartTimeRef.current}
                />
              )}
            </AnimatePresence>

            {/* Streaming — layout identical to ChatMessage AGENT to prevent position jump */}
            {streamingText && (
              <div className="flex gap-2.5 mb-5">
                <AgentAvatar isStreaming={agentRunning} />
                <div className="flex-1 min-w-0">
                  <AgentMarkdown content={streamingText} />
                  {agentRunning && (
                    <span
                      className="inline-block w-[2px] h-[13px] bg-white/35 animate-pulse ml-[1px] rounded-sm"
                      style={{ verticalAlign: 'text-bottom' }}
                    />
                  )}
                </div>
              </div>
            )}

            <AnimatePresence>
              {agentError && !agentRunning && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2 px-3.5 py-2.5 mb-4 rounded-xl border border-red-500/20 bg-red-500/[0.05]"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400/60 shrink-0" />
                  <span className="text-[12px] text-red-400/70">{agentError}</span>
                  <button
                    onClick={() => setAgentError(null)}
                    className="ml-auto text-[11px] text-white/25 hover:text-white/50 transition-colors cursor-pointer"
                  >
                    Dismiss
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>

          <AnimatePresence>
            {showScrollBtn && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.15 }}
                className="sticky bottom-4 flex justify-end pr-6 pointer-events-none"
              >
                <button
                  onClick={scrollToBottom}
                  className="pointer-events-auto w-8 h-8 rounded-full backdrop-blur-sm border border-white/[0.1] flex items-center justify-center text-white/40 hover:text-white/70 transition-all shadow-lg cursor-pointer"
                  style={{ background: 'rgba(37,37,37,0.9)' }}
                >
                  <ChevronDown className="w-4 h-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Resolved banner */}
        {isResolved && !isClosed && (
          <div className="shrink-0 flex items-center justify-between px-10 md:px-16 py-3 border-t border-white/[0.05]" style={{ background: '#1C1C1C' }}>
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/70 shrink-0" />
              <span className="text-[12px] text-emerald-400/70 font-medium">Case resolved</span>
              <span className="text-[11px] text-white/25">Was this helpful?</span>
              <button onClick={() => handleRate(1)} className="p-1 rounded text-white/20 hover:text-emerald-400 transition-colors cursor-pointer text-[13px]">👍</button>
              <button onClick={() => handleRate(-1)} className="p-1 rounded text-white/20 hover:text-red-400 transition-colors cursor-pointer text-[13px]">👎</button>
            </div>
            <button
              onClick={() => router.push("/support/new")}
              className="text-[11px] text-white/25 hover:text-white/50 transition-colors cursor-pointer"
            >
              New case
            </button>
          </div>
        )}

        {isClosed && (
          <div className="shrink-0 border-t border-white/[0.05] px-10 md:px-16 py-3" style={{ background: '#1C1C1C' }}>
            <div className="flex items-center justify-center gap-2 text-white/20">
              <Lock className="w-3 h-3" />
              <p className="text-[12px]">This case is closed.</p>
            </div>
          </div>
        )}

        {!isClosed && (
          <div className="shrink-0 border-t border-white/[0.05] px-10 md:px-16 py-4" style={{ background: '#1C1C1C' }}>
            <div>
              <SupportChatInput
                workspaces={caseWorkspaces}
                selectedWorkspaceId={caseWorkspaceId}
                onSend={sendMessage}
                disabled={sending}
                isStreaming={agentRunning}
                value={input}
                onChange={setInput}
              />
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
