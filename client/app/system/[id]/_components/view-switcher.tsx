"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Globe, Code2, Cloud, GitBranch } from "lucide-react";

export type ViewMode = "preview" | "code" | "activity" | "history";

interface ViewSwitcherProps {
    value: ViewMode;
    onChange: (mode: ViewMode) => void;
}

const springConfig = { type: "spring" as const, damping: 25, stiffness: 300, mass: 0.8 };

export function ViewSwitcher({ value, onChange }: ViewSwitcherProps) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const previewRef = React.useRef<HTMLButtonElement>(null);
    const codeRef = React.useRef<HTMLButtonElement>(null);
    const activityRef = React.useRef<HTMLButtonElement>(null);
    const historyRef = React.useRef<HTMLButtonElement>(null);
    const [bgStyle, setBgStyle] = React.useState({ left: 0, width: 0 });
    const [isInitialized, setIsInitialized] = React.useState(false);

    const updateBgPosition = React.useCallback(() => {
        const refs = { preview: previewRef, code: codeRef, activity: activityRef, history: historyRef };
        const activeRef = refs[value];
        if (activeRef.current) {
            setBgStyle({ left: activeRef.current.offsetLeft, width: activeRef.current.offsetWidth });
        }
    }, [value]);

    React.useEffect(() => {
        const timer = setTimeout(() => {
            updateBgPosition();
            if (!isInitialized) setIsInitialized(true);
        }, 50);
        return () => clearTimeout(timer);
    }, [value, updateBgPosition, isInitialized]);

    React.useEffect(() => {
        const refs = { preview: previewRef, code: codeRef, activity: activityRef, history: historyRef };
        const activeRef = refs[value];
        if (!activeRef?.current) return;
        const observer = new ResizeObserver(() => updateBgPosition());
        observer.observe(activeRef.current);
        return () => observer.disconnect();
    }, [value, updateBgPosition]);

    const tabs = [
        { id: "preview" as const, label: "Preview", icon: Globe, ref: previewRef },
        { id: "code" as const, label: "Code", icon: Code2, ref: codeRef },
        { id: "activity" as const, label: "Cloud", icon: Cloud, ref: activityRef },
        { id: "history" as const, label: "History", icon: GitBranch, ref: historyRef },
    ];

    return (
        <div ref={containerRef} className="relative flex items-center rounded-xl p-1 gap-1 bg-[#1a1a1a]">
            <motion.div
                className="absolute rounded-lg h-[calc(100%-8px)] bg-white/10"
                initial={false}
                animate={{ left: bgStyle.left, width: bgStyle.width }}
                transition={isInitialized ? springConfig : { duration: 0 }}
                style={{ top: 4 }}
            />
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    ref={tab.ref}
                    onClick={() => onChange(tab.id)}
                    className={cn(
                        "relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer z-10",
                        value === tab.id ? "text-white" : "text-white/50 hover:text-white/70"
                    )}
                >
                    <tab.icon className="w-4 h-4 shrink-0" />
                    <AnimatePresence initial={false} mode="popLayout">
                        {value === tab.id && (
                            <motion.span
                                key={`${tab.id}-text`}
                                initial={{ width: 0, opacity: 0, x: -5, filter: "blur(8px)" }}
                                animate={{ width: "auto", opacity: 1, x: 0, filter: "blur(0px)" }}
                                exit={{ width: 0, opacity: 0, x: -5, filter: "blur(8px)" }}
                                transition={{ ...springConfig, filter: { duration: 0.15 } }}
                                className="overflow-hidden whitespace-nowrap text-[13px]"
                            >
                                {tab.label}
                            </motion.span>
                        )}
                    </AnimatePresence>
                </button>
            ))}
        </div>
    );
}
