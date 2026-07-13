import * as React from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "pf.inspector.firstClickTip.dismissed";
const AUTO_DISMISS_MS = 5000;

interface FirstRunTipProps {
  visible: boolean;
  onDismiss: () => void;
}

export function FirstRunTip({ visible, onDismiss }: FirstRunTipProps) {
  React.useEffect(() => {
    if (!visible) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [visible, onDismiss]);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-md flex items-start gap-3 bg-neutral-950/95 border border-cyan-500/30 rounded-lg px-3.5 py-2.5 shadow-lg backdrop-blur"
    >
      <div className="text-[12px] text-white leading-snug flex-1">
        Click any element on the right to edit it. Press{" "}
        <kbd className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-white/10 border border-white/15">Esc</kbd>{" "}
        to exit.
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss tip"
        className="text-white/55 hover:text-white transition-colors min-w-[24px] min-h-[24px] flex items-center justify-center"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function isFirstClickTipDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try { return window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { return true; }
}

export function markFirstClickTipDismissed(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch { }
}
