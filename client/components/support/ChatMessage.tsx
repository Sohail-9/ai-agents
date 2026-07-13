"use client";

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';

function renderInline(text: string, key: string) {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[\s\S]*?\*\*|\*[\s\S]*?\*)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`'))
      parts.push(
        <code key={`${key}-${k++}`} className="bg-white/10 px-1 py-0.5 rounded text-[#FF15DC] font-mono text-[11px]">
          {t.slice(1, -1)}
        </code>,
      );
    else if (t.startsWith('**'))
      parts.push(<strong key={`${key}-${k++}`} className="font-semibold text-white">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('*'))
      parts.push(<em key={`${key}-${k++}`} className="italic opacity-80">{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : <>{parts}</>;
}

export function AgentMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      i++;
      nodes.push(
        <pre key={k++} className="bg-black/30 rounded-lg p-3 my-2 text-[11px] text-white/70 font-mono whitespace-pre-wrap overflow-x-auto">
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      nodes.push(
        <p key={k++} className="font-semibold text-white/85 mb-1.5 text-[13px]">
          {renderInline(hm[2], `h${k}`)}
        </p>,
      );
      i++;
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const txt = lines[i].replace(/^[-*+]\s+/, '');
        items.push(
          <li key={i} className="text-[13px] text-white/75 leading-relaxed">
            {renderInline(txt, `li${i}`)}
          </li>,
        );
        i++;
      }
      nodes.push(<ul key={k++} className="list-disc pl-4 space-y-0.5 mb-2">{items}</ul>);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    nodes.push(
      <p key={k++} className="mb-2 text-[13px] text-white/75 leading-[1.75]">
        {renderInline(line, `p${k}`)}
      </p>,
    );
    i++;
  }

  return <div className="space-y-0">{nodes}</div>;
}

export function AgentAvatar({ isStreaming: _isStreaming }: { isStreaming?: boolean }) {
  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{ width: 28, height: 28, marginTop: 2 }}
    >
      <img src="/logos/logo.svg" alt="AI Agents" className="w-[18px] h-[18px]" />
    </div>
  );
}

interface ChatMessageProps {
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  isStreaming?: boolean;
  noAnimate?: boolean;
  onRate?: (rating: 1 | -1) => Promise<void>;
  children?: React.ReactNode;
}

export function ChatMessage({ role, content, isStreaming, noAnimate, onRate, children }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const [rated, setRated] = useState<1 | -1 | null>(null);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleRate = async (r: 1 | -1) => {
    if (rated !== null || !onRate) return;
    await onRate(r);
    setRated(r);
  };

  if (role === 'SYSTEM') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
        className="flex justify-center my-3"
      >
        <span className="text-[11px] text-white/20 italic">{content}</span>
      </motion.div>
    );
  }

  if (role === 'USER') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        className="flex justify-end mb-4"
      >
        <div
          className="max-w-[72%] px-3.5 py-2.5 text-[13.5px] text-white/85 leading-relaxed whitespace-pre-wrap"
          style={{
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '16px 16px 4px 16px',
          }}
        >
          {content}
        </div>
      </motion.div>
    );
  }

  // AGENT
  return (
    <motion.div
      initial={noAnimate ? false : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="flex gap-2.5 mb-5"
    >
      <AgentAvatar isStreaming={isStreaming} />

      <div className="flex-1 min-w-0">
        {children}

        {content && (
          <AgentMarkdown content={content} />
        )}

        {!content && isStreaming && (
          <span className="text-[13px] text-white/25 italic">Thinking</span>
        )}

        {!isStreaming && content && (
          <div className="flex items-center gap-0.5 mt-2">
            {onRate && (
              <>
                <button
                  onClick={() => handleRate(1)}
                  disabled={rated !== null}
                  title="Helpful"
                  className={`p-1.5 rounded-md transition-colors disabled:opacity-40 cursor-pointer ${
                    rated === 1 ? 'text-emerald-400' : 'text-white/20 hover:text-white/50 hover:bg-white/5'
                  }`}
                >
                  <ThumbsUp className="w-3 h-3" />
                </button>
                <button
                  onClick={() => handleRate(-1)}
                  disabled={rated !== null}
                  title="Not helpful"
                  className={`p-1.5 rounded-md transition-colors disabled:opacity-40 cursor-pointer ${
                    rated === -1 ? 'text-red-400' : 'text-white/20 hover:text-white/50 hover:bg-white/5'
                  }`}
                >
                  <ThumbsDown className="w-3 h-3" />
                </button>
              </>
            )}
            <button
              onClick={handleCopy}
              title="Copy"
              className="p-1.5 rounded-md text-white/20 hover:text-white/50 hover:bg-white/5 transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
