"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { LoadingCarousel } from "@/components/ui/loading-carousel";

interface SetupLoadingProps {
    status: { message: string; submessage?: string };
    projectName: string;
}

const setupTips = [
    {
        text: "Building isolated development environments...",
        image: "https://www.cult-ui.com/placeholders/cult-seo.png",
    },
    {
        text: "Analyzing project requirements and architecture...",
        image: "https://www.cult-ui.com/placeholders/cult-manifest.png",
    },
    {
        text: "Provisioning cloud-based compute power...",
        image: "https://www.cult-ui.com/placeholders/cult-dir.png",
    },
    {
        text: "Initializing your agentic development loop...",
        image: "https://www.cult-ui.com/placeholders/cult-snips.png",
    },
];

export function SetupLoading({ status, projectName }: SetupLoadingProps) {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0d0d0e] overflow-hidden">
            <div className="relative z-10 w-full max-w-xl px-8 flex flex-col items-center text-center">

                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-10 flex flex-col items-center gap-2"
                >
                    <h2 className="text-xl font-bold tracking-tight text-white">
                        Preparing {projectName}
                    </h2>
                    {status.message && (
                        <p className="text-[13px] text-white/35">{status.message}</p>
                    )}
                </motion.div>

                <div className="w-full">
                    <LoadingCarousel
                        tips={setupTips}
                        interval={2000}
                        showIndicators={true}
                        showProgress={true}
                        aspectRatio="wide"
                        className="border-none shadow-none bg-transparent"
                    />
                </div>
            </div>
        </div>
    );
}
