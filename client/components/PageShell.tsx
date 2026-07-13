"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Sidebar from "@/components/Sidebar";
import { Workspace } from "@/lib/types";

interface PageShellProps {
  children: React.ReactNode;
  systems?: Workspace[];
  systemsLoading?: boolean;
}

export default function PageShell({ children, systems, systemsLoading }: PageShellProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#0d0d0e] text-white font-sans">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <Sidebar systems={systems} systemsLoading={systemsLoading} />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden relative flex items-center justify-between px-4 h-[52px] border-b border-white/5 shrink-0">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="w-9 h-9 flex items-center justify-center rounded-[10px] text-gray-400 hover:text-white transition-colors -ml-1"
          >
            <Menu size={20} />
          </button>
          <img src="/logos/logoname_dark.svg" alt="AI Agents" className="h-[18px] absolute left-1/2 -translate-x-1/2" />
          <div className="w-9" />
        </div>

        {children}
      </div>

      {/* Mobile sidebar drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              key="shell-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[150] bg-black/60 backdrop-blur-sm md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              key="shell-drawer"
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 280 }}
              className="fixed top-0 left-0 z-[151] h-screen md:hidden"
              onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setMobileMenuOpen(false); }}
            >
              <Sidebar
                systems={systems}
                systemsLoading={systemsLoading}
                defaultCollapsed={false}
                onCollapse={() => setMobileMenuOpen(false)}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
