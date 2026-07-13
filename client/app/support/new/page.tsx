"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-client";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import PageShell from "@/components/PageShell";
import { SupportChatInput } from "@/components/support/SupportChatInput";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface Workspace {
  id: string;
  name: string;
}

export default function NewCasePage() {
  const router = useRouter();
  const { getToken, userId } = useAuth();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

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
    if (!userId) return;
    authFetch(`${API_URL}/api/workspaces/${userId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list: Workspace[] = Array.isArray(data) ? data : (data.workspaces ?? []);
        setWorkspaces(list);
        if (list.length > 0) setSelectedWorkspaceId(list[0].id);
      })
      .catch(() => {});
  }, [authFetch, userId]);

  const handleSend = async (text: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const body: Record<string, string> = { message: text };
      if (selectedWorkspaceId) body.workspaceId = selectedWorkspaceId;
      const res = await authFetch(`${API_URL}/api/support/cases`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create case");
      const data = await res.json();
      router.push(`/support/${data.id}`);
    } catch {
      setCreating(false);
    }
  };

  return (
    <PageShell>
      <main className="flex-1 overflow-y-auto scrollbar-subtle" style={{ background: '#1C1C1C' }}>
        <div className="px-10 md:px-16 py-8 md:py-10">

          {/* Back nav */}
          <div className="flex items-center gap-2 mb-10">
            <Link
              href="/support"
              className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/[0.05] transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <span className="text-[15px] font-medium text-white/70">Support</span>
          </div>

          {/* Agent section */}
          <div className="flex items-center gap-2.5 mb-4">
            <img src="/logos/logo.svg" alt="AI Agents" className="w-[20px] h-[20px]" />
            <h3 className="text-[18px] font-semibold text-white/90">AI Agents Agent</h3>
          </div>

          <p className="text-[14px] text-white/55 leading-[1.8] mb-6 max-w-[800px]">
            Hello, I'm an AI assistant from AI Agents. If we find something I can't solve, I&apos;ll help you create a support case to solve your issue.
          </p>

          {creating ? (
            <div className="flex items-center gap-2.5 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white/25" />
              <span className="text-[13px] text-white/30">Creating case...</span>
            </div>
          ) : (
            <SupportChatInput
              workspaces={workspaces}
              selectedWorkspaceId={selectedWorkspaceId}
              onWorkspaceChange={setSelectedWorkspaceId}
              onSend={handleSend}
              disabled={creating}
              value={message}
              onChange={setMessage}
              placeholder="Send a Message..."
            />
          )}

        </div>
      </main>
    </PageShell>
  );
}
