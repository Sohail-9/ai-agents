"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface AgentTimerProps {
    isActive: boolean;
}

export function AgentTimer({ isActive }: AgentTimerProps) {
    const startTimeRef = React.useRef<number | null>(null);
    const [elapsedMs, setElapsedMs] = React.useState(0);
    const [finalTimeMs, setFinalTimeMs] = React.useState<number | null>(null);

    React.useEffect(() => {
        let animationFrame: number;
        if (isActive) {
            const start = Date.now();
            startTimeRef.current = start;
            setFinalTimeMs(null);
            setElapsedMs(0);
            const update = () => {
                setElapsedMs(Date.now() - start);
                animationFrame = requestAnimationFrame(update);
            };
            animationFrame = requestAnimationFrame(update);
        } else if (startTimeRef.current !== null) {
            setFinalTimeMs(Date.now() - startTimeRef.current);
            startTimeRef.current = null;
        }
        return () => { if (animationFrame) cancelAnimationFrame(animationFrame); };
    }, [isActive]);

    const formatTimeMs = (ms: number) => {
        const totalSeconds = ms / 1000;
        if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;
        const m = Math.floor(totalSeconds / 60);
        const s = (totalSeconds % 60).toFixed(2);
        return `${m.toString().padStart(2, "0")}.${s.padStart(5, "0")}m`;
    };

    if (!isActive && finalTimeMs === null) return null;

    const currentMs = isActive ? elapsedMs : (finalTimeMs || 0);
    const totalSeconds = currentMs / 1000;
    const isMinutes = totalSeconds >= 60;

    return (
        <AnimatePresence mode="wait">
            {isActive ? (
                <motion.div
                    key="running"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="flex items-center gap-2 px-1 py-1.5 text-[12px] font-mono text-white/80 tracking-wider"
                >
                    <span>{formatTimeMs(currentMs)}</span>
                </motion.div>
            ) : (
                <motion.div
                    key="finished"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex items-center gap-2 px-1 py-1.5 text-[12px] font-medium text-gray-300"
                >
                    <span className="flex items-center gap-1 font-mono tracking-wider">
                        Agent worked for{" "}
                        <span className="text-emerald-400 font-bold mx-0.5">
                            {isMinutes
                                ? `${Math.floor(totalSeconds / 60).toString().padStart(2, "0")}.${(totalSeconds % 60).toFixed(2).padStart(5, "0")}Min`
                                : `${totalSeconds.toFixed(2)}SEC`}
                        </span>
                    </span>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
