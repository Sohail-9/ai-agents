"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-client";
import { Plus, MessageSquare, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import PageShell from "@/components/PageShell";
import { CaseCard } from "@/components/support/CaseCard";
import { GlassButton } from "@/components/ui/glass-button";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface SupportCase {
  id: string;
  caseNumber: number;
  title?: string | null;
  status: string;
  priority?: string | null;
  workspace?: { id: string; name: string } | null;
  _count?: { messages: number };
  updatedAt: string;
}

const FAQS = [
  {
    q: "What makes AI Agents different from others",
    a: "AI Agents doesn't just generate code or prototypes. We build, run, and evolve real, live software systems in production from day one. No setup, no DevOps, no drama.",
    defaultOpen: true,
  },
  {
    q: "What makes AI Agents different from others",
    a: "AI Agents doesn't just generate code or prototypes. We build, run, and evolve real, live software systems in production from day one. No setup, no DevOps, no drama.",
    defaultOpen: false,
  },
];

function FAQItem({ q, a, defaultOpen = false }: { q: string; a: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="border border-white/[0.07] rounded-xl overflow-hidden cursor-pointer select-none"
      onClick={() => setOpen((o) => !o)}
    >
      <div className="flex items-center justify-between px-5 py-4 gap-4">
        <span className="text-[14px] text-white/80 font-normal leading-snug">{q}</span>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          className="shrink-0"
        >
          <ChevronDown className="w-4 h-4 text-white/35" />
        </motion.div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="answer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-5 pb-4 border-t border-white/[0.05]">
              <p className="text-[13px] text-white/50 leading-[1.75] pt-3">{a}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.06] bg-[#1e1e1e] animate-pulse">
      <div className="flex-1 space-y-2">
        <div className="flex gap-2 items-center">
          <div className="w-8 h-2.5 rounded bg-white/[0.06]" />
          <div className="w-40 h-2.5 rounded bg-white/[0.06]" />
        </div>
        <div className="w-56 h-2.5 rounded bg-white/[0.04]" />
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-10 h-2.5 rounded bg-white/[0.04]" />
        <div className="w-14 h-4 rounded-full bg-white/[0.06]" />
      </div>
    </div>
  );
}

export default function SupportPage() {
  const router = useRouter();
  const { getToken } = useAuth();

  const [cases, setCases] = useState<SupportCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const authFetch = useCallback(
    async (url: string, opts?: RequestInit) => {
      const token = await getToken();
      return fetch(url, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(opts?.headers || {}),
        },
      });
    },
    [getToken],
  );

  useEffect(() => {
    setLoading(true);
    authFetch(`${API_URL}/api/support/cases`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setCases(Array.isArray(data) ? data : []);
        setError(false);
      })
      .catch(() => {
        setCases([]);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [authFetch]);

  return (
    <PageShell>
      <main className="flex-1 overflow-y-auto scrollbar-subtle" style={{ background: '#1C1C1C' }}>
        <div className="px-10 md:px-16 py-8 md:py-10">

          {/* Title */}
          <div className="mb-8">
            <h1 className="text-[28px] font-semibold text-white tracking-tight mb-2">Support Center</h1>
            <p className="text-[14px] text-white/40">Need help? Search our documentation or contact our team directly.</p>
          </div>

          {/* FAQ */}
          <div className="mb-8">
            <h2 className="text-[16px] font-medium text-white/55 mb-4">Frequently Asked Questions</h2>
            <div className="space-y-3">
              {FAQS.map((faq, i) => (
                <FAQItem key={i} q={faq.q} a={faq.a} defaultOpen={faq.defaultOpen} />
              ))}
            </div>
          </div>

          {/* Contact Support */}
          <div className="mb-10 border border-white/[0.07] rounded-xl px-4 py-3 flex items-center gap-3">
            <MessageSquare className="w-[17px] h-[17px] text-white/35 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold text-white/85">Contact Support</p>
              <p className="text-[12px] text-white/40 mt-0.5">Our team is here to help you scale your ideas to reality.</p>
            </div>
            <GlassButton size="sm" onClick={() => router.push("/support/new")}>
              Open Ticket
            </GlassButton>
          </div>

          {/* Cases */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[16px] font-medium text-white/55">Your Cases</h2>
            <GlassButton size="xs" onClick={() => router.push("/support/new")}>
              <Plus className="w-3 h-3" />
              New Case
            </GlassButton>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-[13px] text-white/30">Failed to load cases.</p>
              <button onClick={() => window.location.reload()} className="mt-2 text-[12px] text-white/25 hover:text-white/50 underline cursor-pointer">Retry</button>
            </div>
          ) : cases.length > 0 ? (
            <div className="space-y-2">
              {cases.map((c) => (
                <CaseCard
                  key={c.id}
                  caseId={c.id}
                  caseNumber={c.caseNumber}
                  title={c.title}
                  status={c.status}
                  workspaceName={c.workspace?.name}
                  messageCount={c._count?.messages}
                  updatedAt={c.updatedAt}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <MessageSquare className="w-8 h-8 text-white/15" />
              <p className="text-[13px] font-medium text-white/35">No support cases yet</p>
              <GlassButton size="xs" className="mt-1" onClick={() => router.push("/support/new")}>
                <Plus className="w-3 h-3" />
                New Case
              </GlassButton>
            </div>
          )}

        </div>
      </main>
    </PageShell>
  );
}
