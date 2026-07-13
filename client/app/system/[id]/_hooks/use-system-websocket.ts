"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ChatMessage, ChatImage, TodoItem, WSEvent, PlanQuestionsData, PlanReadyData, SubAgentState, SubAgentLog } from "../_types/system";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
const WS_URL = API_URL.replace(/^http/, "ws");

const MAX_MESSAGES = 300;
const capMessages = (arr: ChatMessage[]) =>
    arr.length > MAX_MESSAGES ? arr.slice(-MAX_MESSAGES) : arr;

interface UseSystemWebSocketProps {
    systemId: string;
    initialSandboxId?: string | null;
    initialIdea?: string | null;
    initialImageIds?: string[];
    framework?: string;
    enabled?: boolean;
    userId?: string | null;
    accessToken?: string | null;
    provider?: "OPENAI" | "ANTHROPIC" | "QWEN_DASHSCOPE" | "GROQ" | "GEMINI";
    initialPlanMode?: boolean;
}

export function useSystemWebSocket({
    systemId,
    initialSandboxId = null,
    initialIdea = null,
    initialImageIds = [],
    framework,
    enabled = true,
    userId,
    accessToken,
    provider,
    initialPlanMode = true,
}: UseSystemWebSocketProps) {
    const [messages, setMessages] = React.useState<ChatMessage[]>([]);
    const [todos, setTodos] = React.useState<TodoItem[]>([]);
    const [isAgentRunning, setIsAgentRunning] = React.useState(false);
    const [isAgentDone, setIsAgentDone] = React.useState(false);
    const [activeSandboxId, setActiveSandboxId] = React.useState<string | null>(initialSandboxId);
    const [activePort, setActivePort] = React.useState<number | null>(null);
    const [activeBackendPort, setActiveBackendPort] = React.useState<number | null>(null);
    const [latestActivity, setLatestActivity] = React.useState<string>("");
    const [status, setStatus] = React.useState<"connecting" | "open" | "closed">("closed");
    const [isInitializing, setIsInitializing] = React.useState(enabled);
    const [isSettingUp, setIsSettingUp] = React.useState(!!initialIdea);
    const [setupStatus, setSetupStatus] = React.useState<{ message: string; submessage?: string }>({ message: "Initializing environment..." });
    const [hasMoreHistory, setHasMoreHistory] = React.useState(false);
    const [pendingConfirmation, setPendingConfirmation] = React.useState<{ summary: string } | null>(null);
    const [isPlanMode, setIsPlanMode] = React.useState(initialPlanMode);
    const isPlanModeRef = React.useRef(initialPlanMode);
    React.useEffect(() => { isPlanModeRef.current = isPlanMode; }, [isPlanMode]);
    // Access token rotates (~15m) — hold it in a ref so refreshes don't re-trigger
    // the connect effect and tear down a live socket mid-flight.
    const accessTokenRef = React.useRef<string | null | undefined>(accessToken);
    React.useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
    const [isMultiAgentEnabled, setIsMultiAgentEnabled] = React.useState(false);
    const isMultiAgentEnabledRef = React.useRef(false);
    React.useEffect(() => {
        const planMode = localStorage.getItem("ai-agents:planMode") !== "false";
        setIsPlanMode(planMode);
        isPlanModeRef.current = planMode;
        const multiAgent = localStorage.getItem("pf:multiAgent") === "true";
        setIsMultiAgentEnabled(multiAgent);
        isMultiAgentEnabledRef.current = multiAgent;
    }, []);
    React.useEffect(() => { isMultiAgentEnabledRef.current = isMultiAgentEnabled; }, [isMultiAgentEnabled]);
    const [planQuestions, setPlanQuestions] = React.useState<PlanQuestionsData | null>(null);
    const [planReady, setPlanReady] = React.useState<PlanReadyData | null>(null);
    const [subAgentStates, setSubAgentStates] = React.useState<Record<string, SubAgentState>>({});
    const subAgentStatesRef = React.useRef(subAgentStates);
    React.useEffect(() => { subAgentStatesRef.current = subAgentStates; }, [subAgentStates]);
    const [subAgentIsLive, setSubAgentIsLive] = React.useState(false);
    const subAgentIsLiveRef = React.useRef(false);
    const [isLoadingHistory, setIsLoadingHistory] = React.useState(false);
    const [agentStartedAt, setAgentStartedAt] = React.useState<number | null>(() => {
        if (typeof window === 'undefined' || !systemId) return null;
        const stored = localStorage.getItem(`pf:agentStartAt:${systemId}`);
        return stored ? parseInt(stored, 10) : null;
    });

    const isAgentRunningRef = React.useRef(false);
    React.useEffect(() => { isAgentRunningRef.current = isAgentRunning; }, [isAgentRunning]);
    const activityWatchdogRef = React.useRef<NodeJS.Timeout | null>(null);

    React.useEffect(() => {
        if (typeof window === "undefined") return;
        if (Object.keys(subAgentStates).length === 0) {
            localStorage.removeItem(`pf:subAgents:${systemId}`);
        } else {
            try {
                localStorage.setItem(`pf:subAgents:${systemId}`, JSON.stringify(subAgentStates));
            } catch { }
        }
    }, [subAgentStates, systemId]);

    React.useEffect(() => {
        if (initialIdea && messages.length === 0) {
            setIsSettingUp(true);
            isInitialSetupFlowRef.current = true;
        }
    }, [initialIdea, messages.length]);

    const wsRef = React.useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
    const pingIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
    const retryCountRef = React.useRef(0);
    const hasSentInitialIdea = React.useRef(false);
    const isInitialSetupFlowRef = React.useRef(!!initialIdea);
    const authOkRef = React.useRef(false);
    const pendingInitialIdeaRef = React.useRef<string | null>(null);

    const chunkBufferRef = React.useRef<Map<string, string>>(new Map());
    const toolChunkBufferRef = React.useRef<Map<string, string>>(new Map());
    const flushTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    const flushChunkBuffer = React.useCallback(() => {
        const buffer = chunkBufferRef.current;
        const toolBuffer = toolChunkBufferRef.current;
        if (buffer.size === 0 && toolBuffer.size === 0) return;

        const updates = new Map(buffer);
        const toolUpdates = new Map(toolBuffer);
        buffer.clear();
        toolBuffer.clear();

        setMessages(prev => {
            let changed = false;
            const next = prev.map(m => {
                const chunk = updates.get(m.id);
                const toolChunk = m.toolCallId ? toolUpdates.get(m.toolCallId) : undefined;
                if (chunk || toolChunk) {
                    changed = true;
                    return {
                        ...m,
                        content: chunk ? m.content + chunk : m.content,
                        thinking: chunk ? (m.thinking || "") + chunk : m.thinking,
                        toolArgsStream: toolChunk ? (m.toolArgsStream || "") + toolChunk : m.toolArgsStream,
                    };
                }
                return m;
            });
            return changed ? next : prev;
        });
    }, []);

    const connect = React.useCallback(() => {
        if (!enabled || !systemId) {
            setIsInitializing(false);
            return;
        }

        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        setStatus("connecting");
        setIsInitializing(true);
        const socket = new WebSocket(`${WS_URL}/ws`);
        wsRef.current = socket;

        socket.onopen = () => {
            console.log("[WS] Connected to AI Agents backend");
            setStatus("open");
            retryCountRef.current = 0;
            authOkRef.current = false;

            const authEvent = {
                type: "AUTH",
                payload: { workspaceId: systemId, token: accessTokenRef.current || undefined, provider: provider || undefined },
                meta: { requestId: crypto.randomUUID() }
            };
            socket.send(JSON.stringify(authEvent));

            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            pingIntervalRef.current = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "PING", payload: {}, meta: { requestId: crypto.randomUUID() } }));
                }
            }, 30000);

            // Avoid AUTH/USER_REQUEST races on the backend by waiting for AUTH_OK
            // before sending the automatic initialIdea request.
            if (initialIdea && !hasSentInitialIdea.current) {
                pendingInitialIdeaRef.current = initialIdea;
            }
        };

        socket.onmessage = (event) => {
            try {
                if (typeof event.data === "string" && !event.data.startsWith("{")) {
                    console.log("[WS] Server message:", event.data);
                    return;
                }
                const data: WSEvent = JSON.parse(event.data);
                handleEvent(data);
            } catch (err) {
                console.error("[WS] Failed to parse message:", err);
            }
        };

        socket.onclose = (e) => {
            console.log("[WS] Disconnected", e.reason);
            setStatus("closed");
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            if (activityWatchdogRef.current) clearTimeout(activityWatchdogRef.current);

            // Handle demo access denial
            if (e.reason === "DEMO_ACCESS_DENIED") {
                typeof window !== "undefined" && window.location.replace("/access");
                return;
            }

            if (isAgentRunningRef.current) {
                setIsAgentRunning(false);
                setIsSettingUp(false);
                setIsInitializing(false);
                setMessages(prev => capMessages([...prev, {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: "Connection lost — the agent task was interrupted. Please try again.",
                    timestamp: Date.now()
                }]));
            }

            if (enabled) {
                const timeout = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
                reconnectTimeoutRef.current = setTimeout(() => {
                    retryCountRef.current++;
                    connect();
                }, timeout);
            }
        };

        socket.onerror = (err) => {
            console.error("[WS] Socket error:", err);
            socket.close();
        };
    }, [systemId, enabled, initialIdea, framework, provider]);

    const resetActivityWatchdog = React.useCallback(() => {
        if (activityWatchdogRef.current) clearTimeout(activityWatchdogRef.current);
        if (!isAgentRunningRef.current) return;
        activityWatchdogRef.current = setTimeout(() => {
            if (!isAgentRunningRef.current) return;
            setIsAgentRunning(false);
            setIsSettingUp(false);
            setMessages(prev => capMessages([...prev, {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Agent timed out — no response received. Please try again.",
                timestamp: Date.now()
            }]));
        }, 90_000);
    }, []);

    const handleEvent = React.useCallback((event: WSEvent) => {
        const { type, payload } = event;

        switch (type) {
            case "AUTH_OK":
                console.log("[WS] Auth successful");
                authOkRef.current = true;
                if (pendingInitialIdeaRef.current && !hasSentInitialIdea.current && wsRef.current?.readyState === WebSocket.OPEN) {
                    const idea = pendingInitialIdeaRef.current;
                    pendingInitialIdeaRef.current = null;
                    hasSentInitialIdea.current = true;

                    setIsAgentRunning(true);
                    const setupEvent = {
                        type: "USER_REQUEST",
                        payload: {
                            message: idea,
                            framework: framework,
                            planMode: typeof window !== "undefined"
                                ? localStorage.getItem("ai-agents:planMode") !== "false"
                                : true,
                            ...(initialImageIds.length ? { imageIds: initialImageIds } : {}),
                        },
                        meta: { requestId: crypto.randomUUID(), workspaceId: systemId }
                    };
                    wsRef.current.send(JSON.stringify(setupEvent));

                    setMessages(prev => capMessages([...prev, {
                        id: crypto.randomUUID(),
                        role: "user",
                        content: idea,
                        timestamp: Date.now()
                    }]));
                }
                break;

            case "WORKSPACE_STATE": {
                const p = payload as any;
                setActiveSandboxId(p.sandboxId);
                setActivePort(p.port);
                setActiveBackendPort(p.backendPort);
                break;
            }

            case "CHAT_HISTORY": {
                setIsInitializing(false);
                setIsLoadingHistory(false);
                const p = payload as any;
                if (p.messages) {
                    const mappedMessages = p.messages.map((m: any) => ({
                        ...m,
                        timestamp: m.createdAt ? new Date(m.createdAt).getTime() : Date.now()
                    }));

                    const chatMessages = mappedMessages.map((m: any) => {
                        if (m.role !== "system") return m;
                        try {
                            const parsed = JSON.parse(m.content);
                            if (parsed?.type !== "SUB_AGENT_SUMMARY") return null;
                            const agents: SubAgentState[] = (parsed.agents ?? []).map((a: any) => ({
                                name: a.name,
                                displayName: a.displayName,
                                status: (a.logs ?? []).length > 0 ? a.logs[a.logs.length - 1].message : "",
                                logs: (a.logs ?? []) as SubAgentLog[],
                                isComplete: a.isComplete ?? true,
                            }));
                            return { ...m, role: "agent", eventType: "SUB_AGENT_SUMMARY", content: "", subAgentSummary: agents };
                        } catch { return null; }
                    }).filter(Boolean);

                    if (!p.isPagination) {
                        setSubAgentStates({});
                        setSubAgentIsLive(false);
                        subAgentIsLiveRef.current = false;
                        if (typeof window !== "undefined") localStorage.removeItem(`pf:subAgents:${systemId}`);
                    }

                    if (p.isPagination) {
                        setMessages(prev => {
                            const existingIds = new Set(prev.map(m => m.id));
                            const newMessages = chatMessages.filter((m: any) => !existingIds.has(m.id));
                            const merged = [...newMessages, ...prev];
                            return merged.length > MAX_MESSAGES ? merged.slice(0, MAX_MESSAGES) : merged;
                        });
                    } else {
                        setMessages(capMessages(chatMessages));
                    }
                }
                setHasMoreHistory(!!p.hasMore);
                break;
            }

            case "TODO_LIST_RESULT": {
                const p = payload as any;
                if (p.todos) setTodos(p.todos.slice(-10));
                break;
            }

            case "TODO_CREATED": {
                const p = payload as any;
                setTodos(prev => [...prev, p.todo].slice(-10));
                break;
            }

            case "TODO_UPDATED": {
                const p = payload as any;
                setTodos(prev => prev.map(t => t.id === p.todo.id ? p.todo : t));
                break;
            }

            case "TODO_DELETED": {
                const p = payload as any;
                setTodos(prev => prev.filter(t => t.id !== p.id));
                break;
            }

            case "AGENT_EVENT": {
                setIsInitializing(false);
                setIsSettingUp(false);
                const p = payload as any;

                // Suppress internal config events — don't expose provider details in chat
                if (p.eventType === "LLM_CONFIG") return;

                // Handle insufficient credits before other event types
                if (p.eventType === "INSUFFICIENT_CREDITS") {
                    setIsAgentRunning(false);
                    setIsAgentDone(true);
                    toast.error("Out of credits", {
                        description: "Your credits are exhausted. Top up to run more agents.",
                        duration: Infinity, // Persistent — user must dismiss
                    });
                    return; // Don't add to chat; toast is sufficient signal
                }

                if (p.eventType !== "AGENT_STOPPING") {
                    setIsAgentRunning(true);
                    setIsAgentDone(false);
                }
                setLatestActivity(p.message || "");
                resetActivityWatchdog();

                if (p.eventType === "TODO_STARTED" || p.eventType === "TODO_COMPLETED") {
                    if (p.data?.todoId) {
                        setTodos(prev => prev.map(t =>
                            t.id === p.data.todoId
                                ? { ...t, status: p.eventType === "TODO_COMPLETED" ? "completed" : "in_progress" }
                                : t
                        ));
                    }
                    if (p.eventType === "TODO_COMPLETED") {
                        if (p.data?.port) setActivePort(p.data.port);
                        if (p.data?.backendPort) setActiveBackendPort(p.data.backendPort);
                    }
                    return;
                }

                const subAgentName = (p.data as any)?.agent as string | undefined;
                if (subAgentName === "researcher" || subAgentName === "file") {
                    if (!subAgentIsLiveRef.current) {
                        subAgentIsLiveRef.current = true;
                        setSubAgentIsLive(true);
                    }
                    setSubAgentStates(prev => {
                        const displayName = subAgentName === "researcher" ? "Research Agent" : "File Agent";
                        const existing: SubAgentState = prev[subAgentName] ?? {
                            name: subAgentName, displayName, status: "", logs: [], isComplete: false,
                        };
                        const logType: SubAgentLog["type"] =
                            p.eventType === "SUBAGENT_GOAL" ? "goal" :
                            p.eventType === "TOOL_STARTED" ? "tool_started" :
                            p.eventType === "TOOL_COMPLETED" ? "tool_completed" :
                            p.eventType === "SUBAGENT_COMPLETE" ? "complete" : "thinking";
                        const newLog: SubAgentLog = {
                            type: logType,
                            message: p.message || "",
                            tool: (p.toolCall as string | undefined) ?? (p.data as any)?.tool,
                            timestamp: Date.now(),
                        };
                        const prevLogs = existing.logs;
                        const goalEntry = prevLogs[0]?.type === "goal" ? [prevLogs[0]] : [];
                        const nonGoalLogs = prevLogs.filter(l => l.type !== "goal");
                        const updatedLogs = logType === "goal"
                            ? [newLog, ...nonGoalLogs.slice(-19)]
                            : [...goalEntry, ...nonGoalLogs.slice(-18), newLog];
                        return {
                            ...prev,
                            [subAgentName]: {
                                ...existing,
                                status: p.message || existing.status,
                                logs: updatedLogs,
                                isComplete: p.eventType === "SUBAGENT_COMPLETE",
                                currentTool:
                                    p.eventType === "TOOL_STARTED"
                                        ? ((p.toolCall as string | undefined) ?? (p.data as any)?.tool)
                                        : p.eventType === "TOOL_COMPLETED"
                                            ? undefined
                                            : existing.currentTool,
                            },
                        };
                    });
                    return;
                }

                const ORCH_EVENTS = [
                    "CLASSIFIER_DECISION", "SUBAGENT_PLANNING", "SUBAGENT_GOALS_READY",
                    "SUBAGENT_START", "SYNTHESIS_STARTED", "SYNTHESIS_READY",
                ];
                if (ORCH_EVENTS.includes(p.eventType)) {
                    if (p.eventType === "SYNTHESIS_STARTED" && subAgentIsLiveRef.current) {
                        setSubAgentIsLive(false);
                        subAgentIsLiveRef.current = false;
                        const agentsArray = Object.values(subAgentStatesRef.current);
                        if (agentsArray.length > 0) {
                            setMessages(prev => {
                                if (prev.length > 0 && prev[prev.length - 1].eventType === "SUB_AGENT_SUMMARY") return prev;
                                return capMessages([...prev, {
                                    id: `sub-agent-summary-${Date.now()}`,
                                    role: "agent",
                                    eventType: "SUB_AGENT_SUMMARY",
                                    content: "",
                                    subAgentSummary: agentsArray,
                                    timestamp: Date.now()
                                }]);
                            });
                        }
                    }
                    return;
                }

                if (p.eventType === "AGENT_STREAM_START") {
                    setMessages(prev => capMessages([...prev, {
                        id: p.data?.messageId || crypto.randomUUID(),
                        role: "agent",
                        content: "",
                        eventType: "AGENT_REASONING",
                        thinking: "",
                        timestamp: Date.now()
                    }]));
                } else if (p.eventType === "AGENT_STREAM_CHUNK") {
                    const messageId = p.data?.messageId;
                    const text = p.data?.text || "";
                    if (!messageId || !text) break;

                    setMessages(prev => {
                        const exists = prev.some(m => m.id === messageId);
                        if (!exists) {
                            return capMessages([...prev, {
                                id: messageId,
                                role: "agent",
                                content: "",
                                eventType: "AGENT_REASONING",
                                thinking: "",
                                timestamp: Date.now()
                            }]);
                        }
                        return prev;
                    });

                    const existing = chunkBufferRef.current.get(messageId) || "";
                    chunkBufferRef.current.set(messageId, existing + text);

                    if (!flushTimerRef.current) {
                        flushTimerRef.current = setTimeout(() => {
                            flushTimerRef.current = null;
                            flushChunkBuffer();
                        }, 50);
                    }
                } else if (p.eventType === "AGENT_TOOL_STREAM_START") {
                    const toolCallId = p.data?.toolCallId;
                    const toolName = p.data?.toolName;
                    if (!toolCallId) break;

                    setMessages(prev => {
                        const exists = prev.some(m => (m as any).toolCallId === toolCallId);
                        if (!exists) {
                            return capMessages([...prev, {
                                id: crypto.randomUUID(),
                                role: "agent",
                                content: `Executing tool: ${toolName}`,
                                eventType: "TOOL_STARTED",
                                toolCall: toolName,
                                toolCallId: toolCallId,
                                toolArgsStream: "",
                                timestamp: Date.now()
                            } as ChatMessage & { toolCallId?: string }]);
                        }
                        return prev;
                    });
                } else if (p.eventType === "AGENT_TOOL_STREAM_CHUNK") {
                    const toolCallId = p.data?.toolCallId;
                    const text = p.data?.text || "";
                    if (!toolCallId || !text) break;

                    const existing = toolChunkBufferRef.current.get(toolCallId) || "";
                    toolChunkBufferRef.current.set(toolCallId, existing + text);

                    if (!flushTimerRef.current) {
                        flushTimerRef.current = setTimeout(() => {
                            flushTimerRef.current = null;
                            flushChunkBuffer();
                        }, 50);
                    }
                } else if (p.eventType === "TOOL_COMPLETED") {
                    setMessages(prev => {
                        const toolName = p.toolCall || p.data?.tool;
                        const incomingToolCallId = p.data?.toolCallId;

                        let idx = -1;
                        if (incomingToolCallId) {
                            idx = prev.findLastIndex(m => m.toolCallId === incomingToolCallId);
                        }
                        if (idx === -1) {
                            idx = prev.findLastIndex(m => m.eventType === "TOOL_STARTED" && m.toolCall === toolName);
                        }

                        if (idx !== -1) {
                            const updated = [...prev];
                            updated[idx] = {
                                ...updated[idx],
                                eventType: "TOOL_COMPLETED",
                                toolArgsStream: undefined,
                                toolArgs: p.data?.args || updated[idx].toolArgs,
                                commandExecution: (p.data?.output || p.data?.command) ? {
                                    command: p.data?.command || toolName || "Action",
                                    output: p.data?.output || "Success"
                                } : undefined,
                            };
                            return updated;
                        }
                        return capMessages([...prev, {
                            id: crypto.randomUUID(),
                            role: "agent",
                            content: p.message as string,
                            eventType: p.eventType,
                            toolCall: toolName as string,
                            commandExecution: (p.data?.output || p.data?.command) ? {
                                command: (p.data?.command as string) || toolName || "Action",
                                output: (p.data?.output as string) || "Success"
                            } : undefined,
                            timestamp: Date.now()
                        }]);
                    });
                } else {
                    setMessages(prev => {
                        if (p.eventType === "TOOL_STARTED") {
                            const toolName = p.toolCall || p.data?.tool;
                            const incomingToolCallId = p.data?.toolCallId;

                            let idx = -1;
                            if (incomingToolCallId) {
                                idx = prev.findLastIndex(m => m.toolCallId === incomingToolCallId);
                            }
                            if (idx === -1) {
                                idx = prev.findLastIndex(m => m.eventType === "TOOL_STARTED" && m.toolCall === toolName && !m.toolArgs);
                            }

                            if (idx !== -1) {
                                const updated = [...prev];
                                updated[idx] = {
                                    ...updated[idx],
                                    toolArgs: p.data?.args,
                                    toolCallId: (incomingToolCallId as string | undefined) || updated[idx].toolCallId,
                                    content: p.message as string
                                };
                                return updated;
                            }
                        }

                        return capMessages([...prev, {
                            id: crypto.randomUUID(),
                            role: "agent",
                            content: p.message as string,
                            eventType: p.eventType,
                            thinking: (p.eventType === "AGENT_REASONING" || p.eventType === "LLM_THINKING") ? p.message as string : undefined,
                            toolCall: p.eventType === "TOOL_STARTED" ? ((p.toolCall as string) || (p.data?.tool as string)) : undefined,
                            toolCallId: p.eventType === "TOOL_STARTED" ? (p.data?.toolCallId as string) : undefined,
                            toolArgs: p.eventType === "TOOL_STARTED" ? (p.data?.args as Record<string, any>) : undefined,
                            timestamp: Date.now()
                        }]);
                    });
                }
                break;
            }

            case "AGENT_DONE": {
                const p = payload as any;
                if (activityWatchdogRef.current) clearTimeout(activityWatchdogRef.current);
                setIsAgentRunning(false);
                setAgentStartedAt(null);
                if (systemId) localStorage.removeItem(`pf:agentStartAt:${systemId}`);
                setIsAgentDone(true);
                if (isInitialSetupFlowRef.current) {
                    setIsSettingUp(false);
                    isInitialSetupFlowRef.current = false;
                }
                setLatestActivity(p.summary || "Agent finished.");
                if (p.port) setActivePort(p.port);
                if (p.backendPort) setActiveBackendPort(p.backendPort);
                if (p.sandboxId) setActiveSandboxId(p.sandboxId);

                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    const summary = p.summary || "Agent task completed.";
                    if (lastMsg && lastMsg.role === "agent" && lastMsg.content?.includes(summary.slice(0, 50))) {
                        return prev.map((m, idx) =>
                            idx === prev.length - 1 ? { ...m, modifiedFiles: p.modifiedFiles } : m
                        );
                    }
                    return capMessages([...prev, {
                        id: crypto.randomUUID(),
                        role: "assistant",
                        content: summary,
                        timestamp: Date.now(),
                        modifiedFiles: p.modifiedFiles
                    }]);
                });

                // Auto-refresh history tab when agent finishes
                if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("pf:agent-done", { detail: { workspaceId: systemId } }));
                }
                break;
            }

            case "BILLING_FINALIZED": {
                const p = payload as { newBalance: number };
                // Dispatch with exact balance from backend after deduction is complete
                window.dispatchEvent(new CustomEvent("ai-agents:credits-refresh", {
                    detail: { newBalance: p.newBalance }
                }));
                break;
            }

            case "SYSTEM_ERROR": {
                const p = payload as any;
                console.error("[WS] System Error:", p.message);
                if (activityWatchdogRef.current) clearTimeout(activityWatchdogRef.current);
                setPendingConfirmation(null);
                if (isInitialSetupFlowRef.current) {
                    setIsSettingUp(false);
                    isInitialSetupFlowRef.current = false;
                }
                setMessages(prev => capMessages([...prev, {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: `Error: ${p.message}`,
                    timestamp: Date.now()
                }]));
                setIsAgentRunning(false);
                setAgentStartedAt(null);
                if (systemId) localStorage.removeItem(`pf:agentStartAt:${systemId}`);
                break;
            }

            case "REQUEST_CLARIFICATION": {
                const p = payload as any;
                const questions = p.questions || [];
                const content = `I need some clarifications:\n\n${questions.map((q: any, i: number) => `${i + 1}. ${q.question}`).join('\n')}`;
                setMessages(prev => capMessages([...prev, {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content,
                    timestamp: Date.now()
                }]));
                break;
            }

            case "REQUEST_CONFIRMATION": {
                const p = payload as any;
                const summary = p.summary || "Please confirm whether this project needs a database.";
                setPendingConfirmation({ summary });
                setIsAgentRunning(false);
                setIsInitializing(false);
                setIsSettingUp(false);
                setMessages(prev => capMessages([...prev, {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: summary,
                    timestamp: Date.now()
                }]));
                break;
            }

            case "REQUEST_ACCEPTED": {
                setPendingConfirmation(null);
                if (isInitialSetupFlowRef.current) setIsSettingUp(true);
                setIsInitializing(false);
                setIsAgentRunning(true);
                const startNow = Date.now();
                setAgentStartedAt(startNow);
                if (systemId) localStorage.setItem(`pf:agentStartAt:${systemId}`, String(startNow));
                break;
            }

            case "SETUP_PROGRESS": {
                const p = payload as any;
                setSetupStatus({ message: p.message, submessage: p.submessage });
                if (isInitialSetupFlowRef.current) setIsSettingUp(true);
                break;
            }

            case "PLAN_QUESTIONS": {
                const p = payload as any;
                setIsAgentRunning(false);
                setPlanQuestions({ questions: p.questions || [], summary: p.summary });
                break;
            }

            case "PLAN_READY": {
                const p = payload as any;
                setPlanReady({ content: p.content || "", path: p.path || "" });
                setPlanQuestions(null);
                break;
            }

            case "PONG":
                break;
        }
    }, []);

    const sendUserMessage = React.useCallback((message: string, planModeOverride?: boolean, multiAgentOverride?: boolean, images?: ChatImage[]) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const activePlanMode = planModeOverride !== undefined ? planModeOverride : isPlanModeRef.current;
        const activeMultiAgent = multiAgentOverride !== undefined ? multiAgentOverride : isMultiAgentEnabledRef.current;
        const msgPayload: Record<string, unknown> = { message, planMode: activePlanMode, multiAgentEnabled: activeMultiAgent };
        if (images?.length) msgPayload.imageIds = images.map(img => img.id);
        const event = {
            type: "USER_REQUEST",
            payload: msgPayload,
            meta: { requestId: crypto.randomUUID(), workspaceId: systemId }
        };

        wsRef.current.send(JSON.stringify(event));

        setMessages(prev => capMessages([...prev, {
            id: crypto.randomUUID(),
            role: "user",
            content: message,
            timestamp: Date.now(),
            ...(images?.length ? { images } : {})
        }]));

        setIsAgentRunning(true);
        setSubAgentStates({});
        setSubAgentIsLive(false);
        subAgentIsLiveRef.current = false;
        if (typeof window !== "undefined") localStorage.removeItem(`pf:subAgents:${systemId}`);
    }, [systemId]);

    const stopAgent = React.useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({
            type: "STOP_AGENT",
            payload: { workspaceId: systemId },
            meta: { requestId: crypto.randomUUID() }
        }));
        setIsAgentRunning(false);
        setAgentStartedAt(null);
        if (systemId) localStorage.removeItem(`pf:agentStartAt:${systemId}`);
    }, [systemId]);

    const sendPlanAnswers = React.useCallback((answers: Record<string, string>, questionsData?: PlanQuestionsData | null) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        if (questionsData && questionsData.questions.length > 0) {
            const qaContent = questionsData.questions
                .map(q => {
                    const answerId = answers[q.id];
                    const answerText = q.options.find(o => o.id === answerId)?.text || answerId || "";
                    return JSON.stringify({ q: q.question, a: answerText });
                })
                .join("\n");
            setMessages(prev => capMessages([...prev, {
                id: crypto.randomUUID(),
                role: "user" as const,
                content: qaContent,
                eventType: "PLAN_ANSWERS_DISPLAY",
                timestamp: Date.now(),
            }]));
        }

        const displayText = questionsData
            ? questionsData.questions
                .map(q => {
                    const answerId = answers[q.id];
                    const answerText = q.options.find(o => o.id === answerId)?.text || answerId || "";
                    return JSON.stringify({ q: q.question, a: answerText });
                })
                .join("\n")
            : null;

        wsRef.current.send(JSON.stringify({
            type: "PLAN_ANSWERS",
            payload: { answers, displayText },
            meta: { requestId: crypto.randomUUID(), workspaceId: systemId }
        }));
        setIsAgentRunning(true);
        setPlanQuestions(null);
    }, [systemId]);

    const sendConfirmationResponse = React.useCallback((confirmed: boolean) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({
            type: "CONFIRMATION_RESPONSE",
            payload: { confirmed },
            meta: { requestId: crypto.randomUUID(), workspaceId: systemId }
        }));
    }, [systemId]);

    const [sessionStats, setSessionStats] = React.useState({ files: 0, linesAdded: 0, linesRemoved: 0 });
    const statsTimerRef = React.useRef<NodeJS.Timeout | null>(null);

    React.useEffect(() => {
        if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
        statsTimerRef.current = setTimeout(() => {
            const files = new Set<string>();
            let linesAdded = 0;
            let linesRemoved = 0;
            messages.forEach(msg => {
                if (msg.role === "agent" && (msg.eventType === "TOOL_STARTED" || msg.eventType === "TOOL_COMPLETED") && (msg.toolCall === "edit_file" || msg.toolCall === "write_file")) {
                    if (msg.toolArgs) {
                        const path = msg.toolArgs.path || msg.toolArgs.file || msg.toolArgs.filename;
                        if (path) files.add(path);
                        if (msg.toolArgs.find || msg.toolArgs.replace) {
                            linesRemoved += msg.toolArgs.find ? msg.toolArgs.find.split('\n').length : 0;
                            linesAdded += msg.toolArgs.replace ? msg.toolArgs.replace.split('\n').length : 0;
                        } else if (msg.toolArgs.content) {
                            linesAdded += msg.toolArgs.content.split('\n').length;
                        }
                    }
                }
            });
            setSessionStats({ files: files.size, linesAdded, linesRemoved });
        }, 500);
        return () => { if (statsTimerRef.current) clearTimeout(statsTimerRef.current); };
    }, [messages]);

    React.useEffect(() => {
        if (enabled) connect();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
            if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
            if (activityWatchdogRef.current) clearTimeout(activityWatchdogRef.current);
        };
    }, [connect, enabled]);

    const loadMoreHistory = React.useCallback(() => {
        if (!hasMoreHistory || isLoadingHistory || messages.length === 0) return;
        setIsLoadingHistory(true);
        const oldestMessage = messages[0];
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({
            type: "CHAT_HISTORY_REQUEST",
            payload: { workspaceId: systemId, cursor: oldestMessage.timestamp, limit: 50 },
            meta: { requestId: crypto.randomUUID() }
        }));
    }, [systemId, hasMoreHistory, isLoadingHistory, messages]);

    return {
        wsRef,
        messages,
        todos,
        isAgentRunning,
        isAgentDone,
        activeSandboxId,
        activePort,
        activeBackendPort,
        latestActivity,
        status,
        isInitializing,
        isSettingUp,
        setupStatus,
        pendingConfirmation,
        hasMoreHistory,
        isLoadingHistory,
        loadMoreHistory,
        sessionStats,
        sendUserMessage,
        stopAgent,
        sendConfirmationResponse,
        isPlanMode,
        setIsPlanMode,
        isMultiAgentEnabled,
        setIsMultiAgentEnabled,
        planQuestions,
        setPlanQuestions,
        planReady,
        setPlanReady,
        sendPlanAnswers,
        subAgentStates,
        subAgentIsLive,
        agentStartedAt,
    };
}
