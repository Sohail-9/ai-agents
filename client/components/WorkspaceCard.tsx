"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { MoreHorizontal, ExternalLink, Trash2, Settings, ArrowRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn, getWorkspaceDisplayName } from "@/lib/utils";
import { Workspace } from "@/lib/types";
import Link from "next/link";

interface WorkspaceCardProps {
  workspace: Workspace;
  onDelete?: (id: string) => void;
}

function formatTimeAgo(ts: number) {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function WorkspaceCard({ workspace, onDelete }: WorkspaceCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <>
      <div className="group relative flex flex-col w-full overflow-hidden transition-colors duration-300 rounded-2xl bg-bg-input border border-border-subtle hover:border-white/10">
        <div className="p-5 flex flex-col">
          <div className={cn("flex flex-col mb-4", workspace.github ? "gap-3.5" : "gap-0")}>
            <div className="flex justify-between items-start">
              <div className="flex items-start gap-3">
                <div className="flex flex-col min-w-0 justify-center">
                  <h3 className="text-[15px] font-bold truncate leading-tight text-white">
                    {getWorkspaceDisplayName(workspace)}
                  </h3>
                  {workspace.deployments?.[0]?.cloudfrontUrl && (
                    <a
                      href={workspace.deployments[0].cloudfrontUrl.startsWith("http") ? workspace.deployments[0].cloudfrontUrl : `https://${workspace.deployments[0].cloudfrontUrl}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 hover:underline truncate mt-0.5 flex items-center gap-1"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      {workspace.deployments[0].cloudfrontUrl.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="w-8 h-8 rounded-lg flex items-center justify-center transition-all opacity-40 hover:opacity-100 hover:bg-white/5 active:scale-90 text-white">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  className="w-[200px] p-1.5 z-[100] shadow-xl rounded-xl bg-[#1a1a1c] border-white/10 text-gray-200"
                >
                  <DropdownMenuItem
                    onClick={() => window.open(`/system/${workspace._id}`, "_blank")}
                    className="gap-3 py-2 px-2.5 cursor-pointer flex items-center outline-none"
                  >
                    <ExternalLink className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="text-[13px] font-medium leading-none">Open Workspace</span>
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onClick={() => console.log("Settings clicked")}
                    className="gap-3 py-2 px-2.5 cursor-pointer flex items-center outline-none"
                  >
                    <Settings className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="text-[13px] font-medium leading-none">Settings</span>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator className="bg-white/10 my-1.5" />

                  <DropdownMenuItem
                    onClick={() => setShowDeleteConfirm(true)}
                    className="gap-3 py-2 px-2.5 cursor-pointer flex items-center outline-none focus:bg-red-500/10 focus:text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    <span className="text-[13px] font-medium leading-none text-red-400">Delete</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {workspace.github && (
              <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-white/5 bg-white/5 text-[10px] font-semibold w-fit text-white/80">
                <img src="/icons/github.png" alt="GitHub" className="w-3 h-3 invert opacity-70" />
                <span className="truncate max-w-[160px] tracking-tight">{workspace.github}</span>
              </div>
            )}
          </div>

          <Link
            href={`/system/${workspace._id}`}
            className="relative aspect-video w-full rounded-xl overflow-hidden mb-2 bg-white/2 border border-border-subtle group-hover:border-white/10 transition-colors group/thumb"
          >
            {workspace.image ? (
              <img src={workspace.image} alt={workspace.name} className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-white/2">
                <div className="text-[12px] font-black opacity-20 select-none tracking-tighter text-white">
                  {workspace.name.substring(0, 2).toUpperCase()}
                </div>
              </div>
            )}
            <div className="absolute bottom-3 right-3 translate-y-2 opacity-0 group-hover/thumb:translate-y-0 group-hover/thumb:opacity-100 transition-all duration-300 ease-out">
              <div className="w-8 h-8 rounded-full flex items-center justify-center border border-white/10 bg-white/10 backdrop-blur-md shadow-lg text-white">
                <ArrowRight className="w-4 h-4" />
              </div>
            </div>
          </Link>

          <div className="text-[11px] text-gray-500 mt-1">
            {formatTimeAgo(typeof workspace.updatedAt === "number" ? workspace.updatedAt : new Date(workspace.updatedAt).getTime())}
          </div>
        </div>
      </div>

      {createPortal(
        <AnimatePresence>
          {showDeleteConfirm && (
            <div className="fixed inset-0 z-[200] flex flex-col justify-end sm:justify-center items-center sm:p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowDeleteConfirm(false)}
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              />
              <motion.div
                initial={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.94, y: 16 }}
                animate={isMobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
                exit={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.94, y: 16 }}
                transition={{ type: "spring", damping: 28, stiffness: 340 }}
                className="relative w-full sm:max-w-sm bg-[#1e1e20] rounded-t-[2rem] sm:rounded-2xl shadow-2xl border-t sm:border border-white/8 p-6 pb-10 sm:pb-6"
              >
                <div className="sm:hidden absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1.5 rounded-full bg-white/10" />
                <div className="mt-2 sm:mt-0 flex items-center justify-center w-11 h-11 rounded-full bg-red-500/10 mb-4">
                  <Trash2 className="w-5 h-5 text-red-400" />
                </div>
                <h2 className="text-[15px] font-semibold text-white mb-1">Delete workspace?</h2>
                <p className="text-[13px] text-white/50 mb-6 leading-relaxed">
                  <span className="font-medium text-white/70">{workspace.name}</span> will be permanently removed. This action cannot be undone.
                </p>
                <div className="flex gap-2.5">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 h-11 sm:h-9 rounded-xl text-[14px] sm:text-[13px] font-medium border border-white/8 text-white/60 hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { setShowDeleteConfirm(false); onDelete?.(workspace._id); }}
                    className="flex-1 h-11 sm:h-9 rounded-xl text-[14px] sm:text-[13px] font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
