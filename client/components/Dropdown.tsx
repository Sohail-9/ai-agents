"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import useMeasure from "react-use-measure";
import { MoreHorizontal, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: LucideIcon | any;
  isDivider?: boolean;
  isDanger?: boolean;
  onClick?: () => void;
}

interface DropdownProps {
  items: DropdownItem[];
  trigger?: React.ReactNode;
  triggerIcon?: LucideIcon | any;
  activeItemId?: string;
  onItemSelect?: (id: string) => void;
  className?: string;
  width?: number;
  header?: React.ReactNode;
  align?: "left" | "right";
  direction?: "up" | "down";
  id?: string;
  maxHeight?: number;
}

export function Dropdown({
  items,
  trigger,
  triggerIcon: TriggerIcon = MoreHorizontal,
  activeItemId,
  onItemSelect,
  className,
  width = 180,
  align = "right",
  direction = "down",
  id = "dropdown",
  header,
  maxHeight,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [contentRef, contentBounds] = useMeasure();
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node) &&
        !(sheetRef.current && sheetRef.current.contains(event.target as Node))
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const actualHeight = Math.max(40, Math.ceil(contentBounds.height));
  const openHeight = maxHeight ? Math.min(actualHeight, maxHeight) : actualHeight;

  return (
    <div ref={containerRef} className={cn("relative inline-block not-prose", className)}>
      {/* Trigger */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="cursor-pointer transition-opacity hover:opacity-90 active:scale-95 flex items-center justify-center"
      >
        {trigger ? trigger : (
          <TriggerIcon size={16} className="text-gray-400 hover:text-white transition-colors" />
        )}
      </div>

      {/* Animated Dropdown Menu */}
      {isMobile ? (
        mounted && createPortal(
          <AnimatePresence>
            {isOpen && (
              <div className="fixed inset-0 z-[100] flex flex-col justify-end pointer-events-none">
                <motion.div 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  exit={{ opacity: 0 }} 
                  className="absolute inset-0 bg-black/60 pointer-events-auto"
                  onClick={() => setIsOpen(false)}
                />
                <motion.div
                  ref={sheetRef}
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                  exit={{ y: "100%" }}
                  transition={{ type: "spring", damping: 28, stiffness: 340 }}
                  className="relative w-full max-h-[55vh] flex flex-col bg-bg-input border-t border-border-subtle rounded-t-[2rem] pb-8 pt-6 px-4 shadow-2xl origin-bottom pointer-events-auto"
                >
                  <div className="absolute top-3 left-1/2 -translate-y-1/2 w-12 h-1.5 rounded-full bg-white/20 shrink-0" />
                  {header && (
                    <div onClick={(e) => e.stopPropagation()} className="mb-3 shrink-0 text-white">
                      {header}
                    </div>
                  )}
                  <ul className="flex flex-col gap-1 m-0 p-0 list-none overflow-y-auto pr-1">
                    {items.map((item, index) => {
                      if (item.isDivider) return <hr key={`div-${index}`} className="border-border-subtle my-2" />;
                      const IconComponent = item.icon;
                      const isActive = activeItemId === item.id;
                      const isDanger = item.isDanger;
                      return (
                        <li
                          key={item.id}
                          onClick={() => {
                            if (onItemSelect) onItemSelect(item.id);
                            if (item.onClick) item.onClick();
                            setIsOpen(false);
                          }}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors font-medium text-sm",
                            isActive 
                              ? "bg-white/10 text-white" 
                              : "text-gray-400 hover:bg-white/5 hover:text-white",
                            isDanger && "text-red-500 hover:bg-red-500/10"
                          )}
                        >
                          {IconComponent && <IconComponent size={18} className={cn(isActive ? "text-brand-pink" : "")} />}
                          {item.label}
                        </li>
                      );
                    })}
                  </ul>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body
        )
      ) : (
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{
                opacity: 0,
                scale: 0.95,
                y: direction === "up" ? 10 : -10,
                filter: "blur(10px)"
              }}
              animate={{
                opacity: 1,
                scale: 1,
                y: 0,
                width: width,
                height: openHeight,
                filter: "blur(0px)"
              }}
              exit={{
                opacity: 0,
                scale: 0.95,
                y: direction === "up" ? 10 : -10,
                filter: "blur(10px)"
              }}
              transition={{
                type: "spring",
                damping: 25,
                stiffness: 300,
                mass: 0.8,
                filter: { duration: 0.2 }
              }}
              className={cn(
                "absolute bg-[#222222] border border-[#3E3D3D] shadow-2xl z-[100] rounded-xl flex flex-col overflow-hidden",
                direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
                align === "right" ? "right-0 origin-bottom-right" : "left-0 origin-bottom-left"
              )}
            >
              {/* Menu Content */}
              <div ref={contentRef} className="p-1.5">
                {header && (
                  <div onClick={(e) => e.stopPropagation()} className="mb-1.5 text-gray-200">
                    {header}
                  </div>
                )}
                <ul 
                  className={cn(
                    "flex flex-col gap-0.5 m-0 p-0 list-none overflow-x-hidden",
                    maxHeight && "overflow-y-auto pr-1"
                  )}
                  style={{ maxHeight: maxHeight ? maxHeight - (header ? 50 : 10) : undefined }}
                >
                  {items.map((item, index) => {
                    if (item.isDivider) {
                      return (
                        <motion.hr
                          key={`divider-${index}`}
                          className="border-border-subtle/50 my-1"
                        />
                      );
                    }

                    const IconComponent = item.icon;
                    const isActive = activeItemId === item.id;
                    const isDanger = item.isDanger;
                    const showIndicator = hoveredItem === item.id || isActive;

                    return (
                      <motion.li
                        key={item.id}
                        onClick={() => {
                          if (onItemSelect) onItemSelect(item.id);
                          if (item.onClick) item.onClick();
                          setIsOpen(false);
                        }}
                        onMouseEnter={() => setHoveredItem(item.id)}
                        onMouseLeave={() => setHoveredItem(null)}
                        className={cn(
                          "relative flex items-center gap-2.5 rounded-lg text-[13px] cursor-pointer transition-colors duration-200 ease-out m-0 pl-2.5 py-1.5",
                          isDanger && showIndicator
                            ? "text-red-500"
                            : isActive
                              ? "text-white"
                              : isDanger
                                ? "text-gray-400 hover:text-red-500"
                                : "text-gray-400 hover:text-white"
                        )}
                      >
                        {/* Dynamic Indicator */}
                        {showIndicator && (
                          <motion.div
                            layoutId={`${id}-activeIndicator`}
                            className={cn(
                              "absolute inset-0 rounded-lg z-0",
                              isDanger ? "bg-red-500/10" : "bg-white/5"
                            )}
                            transition={{
                              type: "spring",
                              damping: 30,
                              stiffness: 520,
                              mass: 0.8,
                            }}
                          />
                        )}

                        {/* Left Accent Bar */}
                        {showIndicator && (
                          <motion.div
                            layoutId={`${id}-leftBar`}
                            className={cn(
                              "absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full z-10",
                              isDanger ? "bg-red-500" : "bg-brand-pink"
                            )}
                            transition={{
                              type: "spring",
                              damping: 30,
                              stiffness: 520,
                              mass: 0.8,
                            }}
                          />
                        )}

                        {IconComponent && (
                          <IconComponent
                            size={14}
                            className={cn(
                              "relative z-10 shrink-0",
                              isActive ? "text-brand-pink" : "text-gray-400"
                            )}
                          />
                        )}
                        <span className="font-medium relative z-10 whitespace-nowrap">
                          {item.label}
                        </span>
                      </motion.li>
                    );
                  })}
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
