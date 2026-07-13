"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const LOADERS = ["/loaders/loader_1st.svg", "/loaders/loader_2nd.svg"];

function getRandomInterval() {
    const ranges = [5000, 6000, 10000, 15000, 20000];
    return ranges[Math.floor(Math.random() * ranges.length)];
}

interface AgentLoaderProps {
    isActive?: boolean;
}

export function AgentLoader({ isActive = true }: AgentLoaderProps) {
    const [currentIndex, setCurrentIndex] = React.useState(0);
    const [isHovering, setIsHovering] = React.useState(false);

    React.useEffect(() => {
        if (!isActive) return;
        let timeout: ReturnType<typeof setTimeout>;
        const cycle = () => {
            const delay = getRandomInterval();
            timeout = setTimeout(() => {
                setCurrentIndex(prev => (prev + 1) % LOADERS.length);
                cycle();
            }, delay);
        };
        cycle();
        return () => clearTimeout(timeout);
    }, [isActive]);

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            whileTap={{ scale: 0.7, rotate: -4, transition: { type: "spring", stiffness: 500, damping: 15 } }}
            onHoverStart={() => setIsHovering(true)}
            onHoverEnd={() => setIsHovering(false)}
            className="flex items-center justify-start py-2 cursor-pointer w-fit relative group"
        >
            <AnimatePresence mode="wait">
                {!isActive ? (
                    <motion.div
                        key="idle-logo"
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                        className="relative"
                    >
                        <img src="/logo.svg" alt="Idle" className="w-10 h-10 select-none pointer-events-none" draggable={false} />
                        <AnimatePresence>
                            {isHovering && (
                                <motion.div
                                    initial={{ opacity: 0, x: 10, scale: 0.9 }}
                                    animate={{ opacity: 1, x: 20, scale: 1 }}
                                    exit={{ opacity: 0, x: 10, scale: 0.9 }}
                                    className="absolute left-full top-1/2 -translate-y-1/2 ml-4 px-3 py-1.5 rounded-xl whitespace-nowrap text-[12px] font-medium pointer-events-none shadow-xl border bg-[#1a1a1c] border-white/5 text-white/70"
                                >
                                    yes, yes what can i do for you?
                                    <div className="absolute right-full top-1/2 -translate-y-1/2 border-[6px] border-transparent border-r-[#1a1a1c]" />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                ) : (
                    <motion.div
                        key={currentIndex}
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
                    >
                        <img
                            src={LOADERS[currentIndex]}
                            alt="Loading"
                            className="w-10 h-10 select-none pointer-events-none invert opacity-100"
                            draggable={false}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
