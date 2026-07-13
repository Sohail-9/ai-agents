"use client";

import { forwardRef } from "react";
import { cn } from "@/lib/utils";

interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "xs" | "sm" | "md" | "lg";
}

const sizeClasses = {
  xs: "px-2.5 py-1 text-xs rounded-md",
  sm: "px-3 py-1.5 text-xs rounded-lg",
  md: "px-4 py-2 text-sm rounded-lg",
  lg: "px-5 py-2.5 text-base rounded-xl",
};

const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ className, size = "sm", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        {...props}
        className={cn(
          "relative inline-flex items-center justify-center gap-1.5 cursor-pointer",
          "text-white font-medium select-none",
          "bg-white/[0.04] border border-white/20 backdrop-blur-sm",
          "shadow-[inset_0_1px_0px_rgba(255,255,255,0.15),0_2px_6px_rgba(0,0,0,0.15)]",
          "hover:bg-white/10 transition-all duration-200",
          "before:absolute before:inset-0 before:rounded-[inherit] before:bg-gradient-to-b before:from-white/10 before:to-transparent before:pointer-events-none",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          sizeClasses[size],
          className,
        )}
      >
        {children}
      </button>
    );
  }
);

GlassButton.displayName = "GlassButton";

export { GlassButton };
