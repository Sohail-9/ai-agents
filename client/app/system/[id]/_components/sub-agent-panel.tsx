"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, FolderSearch, ChevronDown, Bot, Wrench, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubAgentState } from "../_types/system";

function parseLogMessage(msg: string): { text: string; iteration?: string } {
    let text = msg.replace(/^\[(?:Research|File) Agent\][-–\s]*/i, "").trim();
    let iteration: string | undefined;
    const match = text.match(/^Iteration\s+(\d+(?:\/\d+)?)\s*[-–—]\s*(.*)/i);
    if (match) { iteration = match[1]; text = match[2]; }
    else {
        const exactMatch = text.match(/^Iteration\s+(\d+(?:\/\d+)?)$/i);
        if (exactMatch) { iteration = exactMatch[1]; text = "Thinking..."; }
    }
    return { text, iteration };
}

function PixelLoader() {
    const clockwiseDelay = [0, 1, 3, 2];
    return (
        <div className="grid grid-cols-2 gap-[2px] shrink-0" style={{ width: 12, height: 12 }}>
            {clockwiseDelay.map((step, i) => (
                <motion.div
                    key={i}
                    className="bg-brand-pink/70"
                    animate={{ opacity: [0.15, 1, 0.15] }}
                    transition={{ duration: 0.9, delay: step * 0.2, repeat: Infinity, ease: "easeInOut" }}
                />
            ))}
        </div>
    );
}

function SubAgentCard({ agent, defaultExpanded = false }: { agent: SubAgentState; defaultExpanded?: boolean }) {
    const [expanded, setExpanded] = React.useState(defaultExpanded);
    const goalLog = agent.logs.find(l => l.type === "goal");
    const nonGoalLogs = agent.logs.filter(l => l.type !== "goal");
    const recentLogs = goalLog ? [goalLog, ...nonGoalLogs] : nonGoalLogs;
    const toolCallCount = agent.logs.filter(l => l.type === "tool_started").length;
    const goalCount = agent.logs.filter(l => l.type === "goal").length;

    return (
        <div className="overflow-hidden w-full">
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer hover:bg-white/[0.03]"
            >
                {agent.isComplete
                    ? <Bot className="w-3 h-3 shrink-0 text-white/25" />
                    : <PixelLoader />
                }
                <span className="text-[11.5px] font-medium flex-1 text-left text-white/45">
                    {agent.displayName}
                </span>
                {agent.isComplete ? (
                    <span className="flex items-center gap-1.5 text-[10px] font-mono text-white/20">
                        {toolCallCount > 0 && (
                            <span className="flex items-center gap-1 text-xs">
                                {toolCallCount}<Wrench className="w-3 h-3 shrink-0" />
                            </span>
                        )}
                        {toolCallCount > 0 && goalCount > 0 && <span className="opacity-30">·</span>}
                        {goalCount > 0 && (
                            <span className="flex items-center gap-1 text-xs">
                                {goalCount}<FileText className="w-3 h-3 shrink-0" />
                            </span>
                        )}
                    </span>
                ) : (
                    <span className="flex items-center gap-1.5 text-[10px] text-white/30">
                        <span className="w-1 h-1 rounded-full animate-pulse shrink-0 bg-brand-pink/50" />
                        Running
                    </span>
                )}
                <ChevronDown className={cn(
                    "w-3 h-3 shrink-0 transition-transform duration-200 text-white/15",
                    expanded && "rotate-180"
                )} />
            </button>

            <AnimatePresence initial={false}>
                {expanded && recentLogs.length > 0 && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        className="overflow-hidden"
                    >
                        <div className="px-3 pb-2.5 pt-1 space-y-0.5 border-t border-white/[0.05]">
                            <AnimatePresence initial={false}>
                                {recentLogs.map((log, i) => {
                                    const parsed = parseLogMessage(log.message);
                                    if (!parsed.text) return null;
                                    const isGoal = log.type === "goal";
                                    const isLatest = i === recentLogs.length - 1;
                                    const marker = isGoal ? "◈"
                                        : log.type === "tool_started" ? "→"
                                        : log.type === "tool_completed" ? "✓"
                                        : log.type === "complete" ? "✔"
                                        : "·";
                                    const stableKey = `${log.timestamp}-${log.message.slice(0, 30)}`;

                                    return (
                                        <motion.div
                                            layout="position"
                                            key={stableKey}
                                            initial={{ opacity: 0, height: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, height: "auto", scale: 1 }}
                                            exit={{ opacity: 0, height: 0, scale: 0.95 }}
                                            transition={{ duration: 0.25, type: "spring", bounce: 0 }}
                                            className={cn(
                                                "flex items-start gap-1.5 font-mono text-[10px] leading-tight overflow-hidden",
                                                isGoal
                                                    ? "text-white/50 pb-1 mb-0.5 border-b border-white/[0.06]"
                                                    : isLatest && !agent.isComplete
                                                        ? "text-white/38"
                                                        : "text-white/18"
                                            )}
                                        >
                                            <div className={cn(
                                                "shrink-0 w-2.5 text-center mt-px flex items-center justify-center",
                                                isGoal ? "opacity-70" : "opacity-50"
                                            )}>
                                                {marker}
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-wrap gap-1 items-start">
                                                <span className="break-words whitespace-normal leading-relaxed">
                                                    {parsed.text}
                                                </span>
                                            </div>
                                        </motion.div>
                                    );
                                })}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

interface SubAgentPanelProps {
    agents: Record<string, SubAgentState> | SubAgentState[];
    inline?: boolean;
}

export function SubAgentPanel({ agents, inline = false }: SubAgentPanelProps) {
    const entries = Array.isArray(agents) ? agents : Object.values(agents);
    if (entries.length === 0) return null;

    return (
        <div className="flex flex-col w-full divide-y divide-white/[0.04]">
            {entries.map((agent, i) => (
                <SubAgentCard key={agent.name} agent={agent} defaultExpanded={i === 0} />
            ))}
        </div>
    );
}
