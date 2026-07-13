"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Home, Database, Globe, MessageSquare, Settings, Hash, ArrowRight, FolderOpen } from "lucide-react";

interface Project {
  id: string;
  name: string;
}

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
}

const NAV_ITEMS = [
  { label: "Home", href: "/", icon: Home, description: "Your projects" },
  { label: "Databases", href: "/databases", icon: Database, description: "Database management" },
  { label: "Deployments", href: "/deployments", icon: Globe, description: "Deploy your apps" },
  { label: "Settings", href: "/settings", icon: Settings, description: "Account & preferences" },
  { label: "Support", href: "/support", icon: MessageSquare, description: "Help & FAQ" },
];

export function SearchPalette({ open, onClose, projects }: SearchPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredNav = query.trim()
    ? NAV_ITEMS.filter(
        (n) =>
          n.label.toLowerCase().includes(query.toLowerCase()) ||
          n.description.toLowerCase().includes(query.toLowerCase())
      )
    : NAV_ITEMS;

  const filteredProjects = projects.filter((p) =>
    !query.trim() ? true : p.name.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 6);

  // Flatten all results for keyboard nav
  const allResults: { type: "nav" | "project"; href: string; label: string }[] = [
    ...filteredNav.map((n) => ({ type: "nav" as const, href: n.href, label: n.label })),
    ...filteredProjects.map((p) => ({ type: "project" as const, href: `/system/${p.id}`, label: p.name })),
  ];

  const navigate = useCallback((href: string) => {
    router.push(href);
    onClose();
  }, [router, onClose]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Keep activeIndex in bounds
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, allResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && allResults[activeIndex]) {
      navigate(allResults[activeIndex].href);
    }
  };

  // Global Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!open) {
          // Let parent open it — handled by Sidebar's own listener
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  let resultIdx = -1;

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-md"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="panel"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="fixed left-1/2 top-[22vh] z-[201] w-full max-w-[560px] -translate-x-1/2"
          >
            <div className="rounded-2xl border border-white/[0.09] bg-[#18181a] shadow-[0_32px_80px_rgba(0,0,0,0.7)] overflow-hidden">
              {/* Input row */}
              <div className="flex items-center gap-3 px-5 h-[56px] border-b border-white/[0.07]">
                <Search className="w-4 h-4 text-white/30 shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search pages, projects…"
                  className="flex-1 bg-transparent text-[14px] text-white placeholder:text-white/25 focus:outline-none"
                />
                <kbd className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-white/[0.08] text-[10px] text-white/20 font-mono">
                  ESC
                </kbd>
              </div>

              {/* Results */}
              <div ref={listRef} className="max-h-[380px] overflow-y-auto py-2 scrollbar-none">

                {/* Nav section */}
                {filteredNav.length > 0 && (
                  <div className="mb-1">
                    <p className="px-4 py-1.5 text-[10px] font-semibold text-white/25 uppercase tracking-widest">Pages</p>
                    {filteredNav.map((item) => {
                      resultIdx++;
                      const idx = resultIdx;
                      const Icon = item.icon;
                      const isActive = activeIndex === idx;
                      return (
                        <button
                          key={item.href}
                          data-idx={idx}
                          onClick={() => navigate(item.href)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${isActive ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                        >
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors ${isActive ? "bg-white/10 text-white" : "bg-white/[0.05] text-white/40"}`}>
                            <Icon className="w-3.5 h-3.5" />
                          </div>
                          <div className="flex-1 text-left min-w-0">
                            <p className={`text-[13px] font-medium leading-tight ${isActive ? "text-white" : "text-white/70"}`}>{item.label}</p>
                            <p className="text-[11px] text-white/25 mt-0.5">{item.description}</p>
                          </div>
                          {isActive && <ArrowRight className="w-3.5 h-3.5 text-white/30 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Projects section */}
                {filteredProjects.length > 0 && (
                  <div>
                    <p className="px-4 py-1.5 text-[10px] font-semibold text-white/25 uppercase tracking-widest">Projects</p>
                    {filteredProjects.map((project) => {
                      resultIdx++;
                      const idx = resultIdx;
                      const isActive = activeIndex === idx;
                      return (
                        <button
                          key={project.id}
                          data-idx={idx}
                          onClick={() => navigate(`/system/${project.id}`)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${isActive ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                        >
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors ${isActive ? "bg-brand-pink/15 text-brand-pink" : "bg-white/[0.05] text-white/40"}`}>
                            <FolderOpen className="w-3.5 h-3.5" />
                          </div>
                          <div className="flex-1 text-left min-w-0">
                            <p className={`text-[13px] font-medium truncate leading-tight ${isActive ? "text-white" : "text-white/70"}`}>{project.name}</p>
                          </div>
                          {isActive && <ArrowRight className="w-3.5 h-3.5 text-white/30 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Empty state */}
                {allResults.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <Hash className="w-6 h-6 text-white/15" />
                    <p className="text-[13px] text-white/30">No results for "{query}"</p>
                  </div>
                )}
              </div>

              {/* Footer hint */}
              <div className="px-5 py-2.5 border-t border-white/[0.05] flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-[10px] text-white/20">
                  <kbd className="px-1.5 py-0.5 rounded border border-white/[0.08] font-mono">↑↓</kbd>
                  <span>navigate</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-white/20">
                  <kbd className="px-1.5 py-0.5 rounded border border-white/[0.08] font-mono">↵</kbd>
                  <span>open</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-white/20">
                  <kbd className="px-1.5 py-0.5 rounded border border-white/[0.08] font-mono">esc</kbd>
                  <span>close</span>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
