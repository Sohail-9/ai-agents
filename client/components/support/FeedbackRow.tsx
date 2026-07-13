"use client";

import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';

interface FeedbackRowProps {
  onRate: (rating: 1 | -1) => Promise<void>;
}

export function FeedbackRow({ onRate }: FeedbackRowProps) {
  const [rated, setRated] = useState<1 | -1 | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handle = async (rating: 1 | -1) => {
    if (rated !== null || submitting) return;
    setSubmitting(true);
    try {
      await onRate(rating);
      setRated(rating);
    } finally {
      setSubmitting(false);
    }
  };

  if (rated !== null) {
    return (
      <div className="mt-2 text-[11px] text-white/30">
        {rated === 1 ? 'Thanks for the feedback! Glad we could help.' : 'Thanks — we\'ll work on doing better.'}
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[11px] text-white/30">Was this helpful?</span>
      <button
        onClick={() => handle(1)}
        disabled={submitting}
        className="p-1 rounded-md hover:bg-white/8 text-white/30 hover:text-emerald-400 transition-colors disabled:opacity-40 cursor-pointer"
        title="Yes"
      >
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => handle(-1)}
        disabled={submitting}
        className="p-1 rounded-md hover:bg-white/8 text-white/30 hover:text-red-400 transition-colors disabled:opacity-40 cursor-pointer"
        title="No"
      >
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
