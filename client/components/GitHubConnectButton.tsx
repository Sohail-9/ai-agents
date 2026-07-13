"use client";

import React, { useState, useEffect } from "react";
import { useUser, useAuth } from "@/lib/auth-client";
import { Loader, GitBranch } from "lucide-react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export function GitHubConnectButton() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const [status, setStatus] = useState<{ isConnected: boolean; username?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user?.id) { setStatus({ isConnected: false }); setLoading(false); return; }

    getToken().then(token =>
      fetch(`${BACKEND_URL}/api/github/status`, { headers: { Authorization: `Bearer ${token}` } })
    )
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus({ isConnected: false }))
      .finally(() => setLoading(false));
  }, [isLoaded, user?.id, getToken]);

  const handleConnect = async () => {
    if (!user?.id) return;
    setConnecting(true);
    try {
      const token = await getToken();
      const res = await fetch(`${BACKEND_URL}/api/github/connect`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!user?.id || !confirm("Disconnect your GitHub account?")) return;
    const token = await getToken();
    await fetch(`${BACKEND_URL}/api/github/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    setStatus({ isConnected: false });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 h-12 px-4 rounded-xl border border-border-subtle bg-bg-input text-gray-400 text-sm">
        <Loader className="w-4 h-4 animate-spin" />
        Checking status...
      </div>
    );
  }

  if (status?.isConnected) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-emerald-400">Connected as @{status.username}</span>
          </div>
        </div>
        <button
          onClick={handleDisconnect}
          className="w-full h-11 rounded-xl border border-border-subtle text-sm font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors"
        >
          Disconnect GitHub Account
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      className="w-full h-12 rounded-xl bg-white text-[#1C1C1C] text-sm font-bold hover:bg-white/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
    >
      {connecting ? <Loader className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
      {connecting ? "Connecting..." : "Connect GitHub Account"}
    </button>
  );
}
