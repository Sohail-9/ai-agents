"use client";

import { motion } from 'framer-motion';
import { CheckCircle } from 'lucide-react';

interface ToolCallSummaryProps {
  toolCount: number;
  elapsedSeconds: number;
}

export function ToolCallSummary({ toolCount, elapsedSeconds }: ToolCallSummaryProps) {
  if (toolCount === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.15 }}
      className="flex items-center gap-1.5 mb-2 ml-[38px]"
    >
      <CheckCircle className="w-3 h-3 text-emerald-400/60 shrink-0" />
      <span className="text-[11px] text-white/25">
        Used {toolCount} {toolCount === 1 ? 'tool' : 'tools'} · {elapsedSeconds}s
      </span>
    </motion.div>
  );
}
