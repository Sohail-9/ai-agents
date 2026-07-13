"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Tip {
  text: string;
  label?: string;
  image?: string;
}

const defaultTips: Tip[] = [
  { label: "Did you know", text: "You can switch to Plan mode before sending a message to get a structured plan before building." },
  { label: "Pro tip", text: "Use the tasks panel to track what the agent is working on in real time." },
  { label: "Pro tip", text: "After the build is done, you can keep iterating — just type your next instruction." },
  { label: "Did you know", text: "Multi-agent mode runs parallel agents to complete complex tasks faster." },
  { label: "Pro tip", text: "Click on any file the agent modified to preview the changes instantly." },
];

interface LoadingCarouselProps {
  tips?: Tip[];
  interval?: number;
  showIndicators?: boolean;
  showProgress?: boolean;
  aspectRatio?: "video" | "wide" | "square";
  className?: string;
}

export function LoadingCarousel({
  tips = defaultTips,
  interval = 4500,
  showIndicators = true,
  showProgress = true,
  aspectRatio = "video",
  className = "",
}: LoadingCarouselProps) {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [direction, setDirection] = useState(1);

  const goTo = useCallback((i: number) => {
    setDirection(i > index ? 1 : -1);
    setIndex(i);
    setProgress(0);
  }, [index]);

  useEffect(() => {
    const step = 100 / (interval / 60);
    const timer = setInterval(() => {
      setProgress(p => {
        if (p + step >= 100) {
          setDirection(1);
          setIndex(i => (i + 1) % tips.length);
          return 0;
        }
        return p + step;
      });
    }, 60);
    return () => clearInterval(timer);
  }, [tips.length, interval]);

  const tip = tips[index];
  const hasImages = tips.some(t => t.image);

  const aspectClass = {
    video: "aspect-video",
    wide: "aspect-[2/1]",
    square: "aspect-square",
  }[aspectRatio];

  const variants = {
    enter: (d: number) => ({ x: d > 0 ? "100%" : "-100%", opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d < 0 ? "100%" : "-100%", opacity: 0 }),
  };

  return (
    <div className={`w-full max-w-lg mx-auto rounded-xl bg-[#0C0C0E] border border-white/8 overflow-hidden ${className}`}>
      {/* Image area */}
      {hasImages && (
        <div className={`relative w-full ${aspectClass} overflow-hidden bg-black`}>
          <AnimatePresence initial={false} custom={direction} mode="popLayout">
            <motion.div
              key={index}
              custom={direction}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.5, ease: "easeInOut" }}
              className="absolute inset-0"
            >
              {tip.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={tip.image}
                  alt={tip.text}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-[#111]" />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      )}

      {/* Text + controls */}
      <div className="p-4 flex flex-col gap-3">
        {/* Indicators */}
        {showIndicators && (
          <div className="flex gap-1.5">
            {tips.map((_, i) => (
              <motion.button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                animate={{ opacity: i === index ? 1 : 0.2, width: i === index ? 24 : 8 }}
                transition={{ duration: 0.3 }}
                className="h-1 rounded-full bg-white/50 cursor-pointer"
              />
            ))}
          </div>
        )}

        {/* Text */}
        <div className="min-h-[2.5rem] flex items-center">
          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, delay: 0.1 }}
            >
              {tip.label && !tip.image && (
                <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-pink/70 block mb-1">
                  {tip.label}
                </span>
              )}
              <p className="text-[12.5px] text-white/55 leading-relaxed">{tip.text}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Progress bar */}
        {showProgress && (
          <div className="h-[2px] w-full rounded-full bg-white/5 overflow-hidden">
            <motion.div
              className="h-full bg-white/25 rounded-full origin-left"
              style={{ scaleX: progress / 100 }}
              transition={{ duration: 0 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default LoadingCarousel;
