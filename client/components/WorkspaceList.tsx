"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GitBranch } from "lucide-react";
import { WorkspaceCard } from "./WorkspaceCard";
import { Workspace } from "@/lib/types";
import { useUser } from "@/lib/auth-client";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface WorkspaceListProps {
  systems: Workspace[];
  systemsLoading: boolean;
  onDelete: (id: string) => void;
}

export function WorkspaceList({ systems, systemsLoading, onDelete }: WorkspaceListProps) {
  const { user } = useUser();

  if (systemsLoading) {
    return (
      <div className="w-full max-w-[850px] mx-auto px-6 py-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-44 rounded-2xl animate-pulse bg-bg-input border border-border-subtle" />
          ))}
        </div>
      </div>
    );
  }

  if (systems.length === 0) {
    return (
      <div className="w-full max-w-[850px] mx-auto px-6 pb-24 pt-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="flex flex-col items-center justify-center py-20 px-4 text-center rounded-2xl border border-dashed border-border-subtle"
        >
          <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mb-5">
            <GitBranch className="w-7 h-7 text-white/40" />
          </div>
          <h3 className="text-base font-semibold text-white mb-2">No workspaces yet</h3>
          <p className="text-[14px] text-gray-400 max-w-[280px] mb-6 leading-relaxed">
            Describe what you want to build above, or connect GitHub to import an existing repo.
          </p>
          <button
            onClick={() => user && (window.location.href = `${BACKEND_URL}/api/github/connect?userId=${user.id}`)}
            className="flex items-center gap-2 px-4 py-2 rounded-[12px] bg-white/5 border border-border-subtle text-[13px] font-medium text-white hover:bg-white/10 transition-colors"
          >
            <GitBranch className="w-4 h-4" />
            Connect GitHub
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[850px] mx-auto px-6 pb-24 pt-4">
      <AnimatePresence mode="popLayout">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 items-start">
          {systems.map((system, index) => (
            <motion.div
              key={system._id}
              layout
              initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { delay: 0.05 + index * 0.05, type: "spring", damping: 30, stiffness: 400 } }}
              exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)", transition: { duration: 0.2 } }}
            >
              <WorkspaceCard workspace={system} onDelete={onDelete} />
            </motion.div>
          ))}
        </div>
      </AnimatePresence>
    </div>
  );
}
