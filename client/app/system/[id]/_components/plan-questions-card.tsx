"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanQuestionsData } from "../_types/system";

interface PlanQuestionsCardProps {
    data: PlanQuestionsData;
    onSubmit: (answers: Record<string, string>) => void;
}

export function PlanQuestionsCard({ data, onSubmit }: PlanQuestionsCardProps) {
    const [currentStep, setCurrentStep] = React.useState(0);
    const [selected, setSelected] = React.useState<Record<string, string>>({});

    const question = data.questions[currentStep];
    const total = data.questions.length;
    const isLast = currentStep === total - 1;
    const hasAnswer = question && !!selected[question.id];

    const handleNext = () => {
        if (!hasAnswer) return;
        if (isLast) onSubmit(selected);
        else setCurrentStep(prev => prev + 1);
    };

    if (!question) return null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-4 mb-4 rounded-2xl overflow-hidden bg-[#1a1a1c] border border-white/10"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <span className="text-[13px] font-semibold text-white">A few quick questions</span>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                        {data.questions.map((_, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "rounded-full transition-all duration-200",
                                    i < currentStep ? "w-1.5 h-1.5 bg-brand-pink" :
                                    i === currentStep ? "w-2.5 h-1.5 bg-brand-pink" :
                                    "w-1.5 h-1.5 bg-white/20"
                                )}
                            />
                        ))}
                    </div>
                    <span className="text-[11px] text-white/40">{currentStep + 1}/{total}</span>
                </div>
            </div>

            {/* Question */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={question.id}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    className="p-4 space-y-3"
                >
                    <p className="text-[13px] font-medium text-white">{question.question}</p>
                    <div className="flex flex-col gap-1.5">
                        {question.options.map(opt => {
                            const isChosen = selected[question.id] === opt.id;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setSelected(prev => ({ ...prev, [question.id]: opt.id }))}
                                    className={cn(
                                        "flex items-center gap-2.5 px-3 py-2 rounded-xl text-[12.5px] text-left transition-all border",
                                        isChosen
                                            ? "bg-brand-pink/20 border-brand-pink/50 text-brand-pink"
                                            : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:border-white/20"
                                    )}
                                >
                                    <div className={cn(
                                        "w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all",
                                        isChosen ? "border-brand-pink bg-brand-pink" : "border-white/30"
                                    )}>
                                        {isChosen && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                                    </div>
                                    {opt.text}
                                </button>
                            );
                        })}
                    </div>
                </motion.div>
            </AnimatePresence>

            {/* Action */}
            <div className="px-4 pb-4 pt-0">
                <button
                    type="button"
                    onClick={handleNext}
                    disabled={!hasAnswer}
                    className="w-full flex items-center justify-center gap-2 h-9 text-[13px] rounded-xl bg-white text-[#1C1C1C] font-semibold hover:bg-white/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {isLast ? (
                        <><CheckCircle2 className="w-3.5 h-3.5" />Submit</>
                    ) : (
                        <>Next<ChevronRight className="w-3.5 h-3.5" /></>
                    )}
                </button>
            </div>
        </motion.div>
    );
}
