"use client";

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Wrench } from 'lucide-react';
import { AgentAvatar } from './ChatMessage';

interface ToolCall {
  id: string;
  toolName: string;
  status: 'calling' | 'done';
}

interface AgentThinkingStateProps {
  activeToolCalls: ToolCall[];
  startTime: number;
}

function formatTool(name: string): string {
  return name
    .replace(/^(get_|list_|fetch_|run_|execute_|search_|check_|read_|write_|create_|delete_)/, '')
    .replace(/_/g, ' ');
}

const THINKING_LABELS = ['Thinking', 'Analyzing', 'Working', 'Investigating', 'Processing'];

export function AgentThinkingState({ activeToolCalls, startTime: _startTime }: AgentThinkingStateProps) {
  const [labelIndex, setLabelIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setLabelIndex((prev) => (prev + 1) % THINKING_LABELS.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const callingTool = [...activeToolCalls].reverse().find((t) => t.status === 'calling');
  const label = THINKING_LABELS[labelIndex];

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className="flex gap-2.5 mb-5"
    >
      <AgentAvatar isStreaming={true} />
      <div className="flex-1 min-w-0 flex items-center" style={{ minHeight: 28 }}>
        <AnimatePresence mode="wait">
          {callingTool ? (
            <motion.div
              key={callingTool.toolName}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 4 }}
              transition={{ duration: 0.18 }}
              className="flex items-center gap-2"
            >
              <Wrench className="w-[13px] h-[13px] text-[#FF15DC]/50 shrink-0" />
              <span className="text-[13px] text-white/35 italic">
                Running {formatTool(callingTool.toolName)}
                <span style={{ letterSpacing: '0.5px' }}>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0s' }}>.</span>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0.2s' }}>.</span>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0.4s' }}>.</span>
                </span>
              </span>
            </motion.div>
          ) : (
            <motion.div
              key={label}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-2"
            >
              <Globe className="w-[13px] h-[13px] text-white/25 shrink-0" />
              <span className="text-[13px] text-white/35 italic">
                {label}
                <span style={{ letterSpacing: '0.5px' }}>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0s' }}>.</span>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0.2s' }}>.</span>
                  <span style={{ animation: 'thinkingDots 1.4s infinite', animationDelay: '0.4s' }}>.</span>
                </span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
