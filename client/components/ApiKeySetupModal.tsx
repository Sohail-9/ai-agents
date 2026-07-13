"use client";

import React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Key, X, Wand2, Check } from "lucide-react";
import { useUser, useAuth } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const PROVIDERS = [
  { value: "OPENAI", label: "OpenAI", placeholder: "sk-...", icon: "/icons/openai.svg" },
  { value: "ANTHROPIC", label: "Anthropic", placeholder: "sk-ant_...", icon: "/icons/claude.png" },
  { value: "GEMINI", label: "Gemini", placeholder: "API_KEY...", icon: "/icons/google.png" },
] as const;

type ProviderValue = (typeof PROVIDERS)[number]["value"];

interface ApiKeySetupModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function ApiKeySetupModal({ open, onClose, onSaved }: ApiKeySetupModalProps) {
  const { user } = useUser();
  const { getToken } = useAuth();
  const [selectedProvider, setSelectedProvider] = React.useState<ProviderValue>("ANTHROPIC");
  const [keyInput, setKeyInput] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const currentProvider = PROVIDERS.find((p) => p.value === selectedProvider)!;

  const handleSave = async () => {
    if (!user?.id || !keyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: selectedProvider, key: keyInput.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save key");
      }
      await fetch(`${API_URL}/api/user/preference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: selectedProvider }),
      });
      setSuccess(true);
      setKeyInput("");
      onSaved?.();
      setTimeout(() => { setSuccess(false); onClose(); }, 1200);
    } catch (err: any) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (typeof window === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[200] flex flex-col justify-end sm:justify-center items-center sm:p-4">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.98, y: 8 }}
            animate={isMobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
            exit={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: "spring", damping: 30, stiffness: 400 }}
            className="w-full sm:max-w-[420px] rounded-t-3xl sm:rounded-2xl overflow-hidden relative origin-bottom pb-8 sm:pb-0 bg-[#1a1a1c] border border-white/10 text-white"
          >
            <div className="sm:hidden absolute top-3 left-1/2 -translate-x-1/2 w-12 h-1.5 rounded-full bg-white/10 z-50" />

            <div className="relative z-10 p-6">
              <div className="flex items-center justify-between mb-6 mt-2 sm:mt-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/10">
                    <Key className="w-4 h-4 opacity-70" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold tracking-tight leading-tight">Setup AI Keys</h3>
                    <p className="text-[11px] mt-0.5 text-white/50">Enable agent intelligence</p>
                  </div>
                </div>
                <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors">
                  <X className="w-3.5 h-3.5 opacity-40 hover:opacity-100" />
                </button>
              </div>

              <div className="space-y-5">
                <div className="flex bg-white/5 p-1 rounded-xl gap-1 border border-white/5">
                  {PROVIDERS.map((p) => {
                    const isActive = selectedProvider === p.value;
                    return (
                      <button
                        key={p.value}
                        onClick={() => { setSelectedProvider(p.value); setError(null); }}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg transition-all duration-200",
                          isActive ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
                        )}
                      >
                        <img src={p.icon} alt={p.label} className={cn("w-3.5 h-3.5", !isActive && "opacity-40 grayscale")} />
                        <span className="text-xs font-semibold hidden xs:inline">{p.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="relative">
                  <input
                    value={keyInput}
                    onChange={(e) => { setKeyInput(e.target.value); setError(null); }}
                    placeholder={currentProvider.placeholder}
                    type="password"
                    autoFocus
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-3 text-[13px] font-mono outline-none text-white placeholder:text-white/20 focus:border-white/20 focus:bg-white/8 transition-all"
                  />
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-30">
                    <Wand2 className="w-3.5 h-3.5" />
                  </div>
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-[11px] font-semibold text-red-400 flex items-center gap-1.5 px-1">
                      <X className="w-3 h-3" />{error}
                    </motion.div>
                  )}
                  {success && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1.5 px-1">
                      <Check className="w-3 h-3" />Encrypted and saved successfully
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSave}
                    disabled={saving || !keyInput.trim() || success}
                    className="flex-1 h-10 rounded-xl text-xs font-semibold transition-all active:scale-[0.98] bg-white text-[#1C1C1C] hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? "Authenticating..." : success ? "Ready" : "Activate Agent"}
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 h-10 rounded-xl text-xs font-semibold bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-all active:scale-[0.98]"
                  >
                    Use free models
                  </button>
                </div>

                <div className="flex items-center justify-center gap-4 opacity-20">
                  <div className="h-px flex-1 bg-current" />
                  <div className="text-[9px] uppercase tracking-wider font-semibold font-mono">Secure Layer</div>
                  <div className="h-px flex-1 bg-current" />
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}
