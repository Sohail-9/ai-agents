"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Copy, Check } from "lucide-react";

// Public endpoints shown in docs.
const OPENAI_BASE = "https://api.ai-agents.com/api/v1";
const ANTHROPIC_BASE = "https://api.ai-agents.com/api"; // SDK appends /v1/messages

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "authentication", label: "Authentication" },
  { id: "models", label: "Models" },
  { id: "openai-sdk", label: "OpenAI SDK" },
  { id: "claude-code", label: "Claude Code" },
  { id: "streaming", label: "Streaming" },
  { id: "response", label: "Response" },
  { id: "errors", label: "Errors" },
  { id: "pricing", label: "Pricing" },
];

const MODELS = [
  { id: "anthropic/opus-4.8", name: "Claude Opus 4.8", inp: "$5.00", out: "$25.00" },
  { id: "anthropic/opus-4.7", name: "Claude Opus 4.7", inp: "$5.00", out: "$25.00" },
  { id: "anthropic/opus-4.6", name: "Claude Opus 4.6", inp: "$5.00", out: "$25.00" },
  { id: "anthropic/sonnet-5", name: "Claude Sonnet 5", inp: "$3.00", out: "$15.00" },
  { id: "anthropic/sonnet-4.6", name: "Claude Sonnet 4.6", inp: "$3.00", out: "$15.00" },
  { id: "openai/gpt-5.5", name: "GPT-5.5", inp: "$5.00", out: "$30.00" },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", inp: "$1.75", out: "$14.00" },
];

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group my-3">
      <pre
        className="rounded-[12px] px-4 py-3.5 text-[12.5px] leading-relaxed text-white/85 font-mono overflow-x-auto scrollbar-subtle whitespace-pre"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        {children}
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-2.5 right-2.5 w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: "rgba(255,255,255,0.08)" }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-white/60" />}
      </button>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 pb-14 border-b border-white/[0.06] mb-14 last:border-0">
      <h2 className="text-[26px] font-bold text-white tracking-tight mb-4">{title}</h2>
      <div className="text-[14px] text-white/60 leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

const code = "text-white/80 bg-white/[0.06] px-1.5 py-0.5 rounded-[5px] text-[13px] font-mono";

export default function ApiDocsPage() {
  const [active, setActive] = useState(SECTIONS[0].id);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive((vis[0].target as HTMLElement).id);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    SECTIONS.forEach((s) => { const el = document.getElementById(s.id); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden text-white" style={{ background: "#1C1C1C" }}>

      {/* Left TOC */}
      <aside className="hidden md:flex flex-col w-[248px] shrink-0 h-full px-5 py-7" style={{ borderRight: "1px solid rgba(255,255,255,0.07)", background: "#191919" }}>
        <Link href="/dashboard/keys" className="flex items-center gap-2 text-[13px] text-white/45 hover:text-white/80 transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to API Keys
        </Link>
        <p className="text-[11px] uppercase tracking-widest text-white/30 mb-3 px-2">API Reference</p>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
            const on = active === s.id;
            return (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                className="relative text-left text-[13.5px] px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
                style={on
                  ? { color: "#fff", background: "rgba(255,21,220,0.10)" }
                  : { color: "rgba(255,255,255,0.5)" }}
                onMouseEnter={(e) => { if (!on) e.currentTarget.style.color = "rgba(255,255,255,0.85)"; }}
                onMouseLeave={(e) => { if (!on) e.currentTarget.style.color = "rgba(255,255,255,0.5)"; }}
              >
                {on && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full" style={{ background: "#FF15DC" }} />}
                {s.label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-subtle scroll-smooth">
        <div className="max-w-[760px] mx-auto px-8 md:px-12 pt-12 pb-32">

          <h1 className="text-[40px] font-bold tracking-tight leading-none mb-3">API Reference</h1>
          <p className="text-[15px] text-white/45 mb-14">
            OpenAI- and Anthropic-compatible LLM gateway. Bring your own SDK, point it at AI Agents, pay per token from your credits.
          </p>

          <Section id="overview" title="Overview">
            <p>AI Agents exposes two compatible surfaces on one key:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li><span className={code}>/api/v1/chat/completions</span> — OpenAI Chat Completions shape.</li>
              <li><span className={code}>/api/v1/messages</span> — Anthropic Messages shape (drop-in for Claude Code).</li>
            </ul>
            <p className="mt-3">Both stream, both bill from the same balance (1 credit = $1).</p>
          </Section>

          <Section id="authentication" title="Authentication">
            <p>Pass your key as a Bearer token (OpenAI SDK) or <span className={code}>x-api-key</span> (Anthropic SDK). Create keys on the API Keys page — they are shown once.</p>
            <CodeBlock>{`Authorization: Bearer pk_your_key
# or
x-api-key: pk_your_key`}</CodeBlock>
          </Section>

          <Section id="models" title="Models">
            <p>Send any id below. Anthropic ids also accept the native name (e.g. <span className={code}>claude-opus-4-8</span>) and a <span className={code}>[1m]</span> / dated suffix.</p>
            <div className="overflow-x-auto scrollbar-subtle mt-3 rounded-[12px]" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-white/40 text-left" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    <th className="font-medium px-4 py-2.5">Model id</th>
                    <th className="font-medium px-4 py-2.5">Name</th>
                    <th className="font-medium px-4 py-2.5 text-right">Input /1M</th>
                    <th className="font-medium px-4 py-2.5 text-right">Output /1M</th>
                  </tr>
                </thead>
                <tbody>
                  {MODELS.map((m) => (
                    <tr key={m.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                      <td className="px-4 py-2.5 font-mono text-white/75">{m.id}</td>
                      <td className="px-4 py-2.5 text-white/60">{m.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-white/60">{m.inp}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: "#FF8CEC" }}>{m.out}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="openai-sdk" title="OpenAI SDK">
            <p>Point <span className={code}>base_url</span> at <span className={code}>{OPENAI_BASE}</span>.</p>
            <CodeBlock>{`from openai import OpenAI

client = OpenAI(api_key="pk_your_key", base_url="${OPENAI_BASE}")

resp = client.chat.completions.create(
    model="anthropic/opus-4.8",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`}</CodeBlock>
            <CodeBlock>{`curl ${OPENAI_BASE}/chat/completions \\
  -H "Authorization: Bearer pk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"anthropic/opus-4.8","messages":[{"role":"user","content":"Hello"}]}'`}</CodeBlock>
          </Section>

          <Section id="claude-code" title="Claude Code / Anthropic SDK">
            <p>Drop-in Anthropic endpoint. The base URL omits <span className={code}>/v1</span> — the SDK appends <span className={code}>/v1/messages</span> itself.</p>
            <CodeBlock>{`export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE}"
export ANTHROPIC_API_KEY="pk_your_key"

# then just run:
claude`}</CodeBlock>
            <p>Use model <span className={code}>claude-opus-4-8</span> (or <span className={code}>anthropic/opus-4.8</span>). Any Claude id resolves; unknown ones fall back to the default Anthropic model.</p>
          </Section>

          <Section id="streaming" title="Streaming">
            <p>Set <span className={code}>stream: true</span>. OpenAI paths emit <span className={code}>chat.completion.chunk</span> SSE; the Anthropic path emits native Anthropic events (<span className={code}>message_start</span> … <span className={code}>message_stop</span>).</p>
            <CodeBlock>{`resp = client.chat.completions.create(
    model="anthropic/opus-4.8",
    messages=[{"role": "user", "content": "Hi"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")`}</CodeBlock>
          </Section>

          <Section id="response" title="Response">
            <p>Standard shape for each surface, plus a <span className={code}>cost</span> (USD) in <span className={code}>usage</span>.</p>
            <CodeBlock>{`{
  "id": "chatcmpl-…",
  "choices": [{ "message": { "role": "assistant", "content": "…" } }],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 34,
    "cost": 0.000425
  }
}`}</CodeBlock>
          </Section>

          <Section id="errors" title="Errors">
            <ul className="list-none space-y-2">
              <li><span className={code}>401</span> — missing / invalid key.</li>
              <li><span className={code}>400</span> — unknown model or malformed request.</li>
              <li><span className={code}>402</span> — out of credits; top up to continue.</li>
              <li><span className={code}>529</span> — upstream busy; retry with backoff.</li>
            </ul>
          </Section>

          <Section id="pricing" title="Pricing">
            <p>Billed per token from your credit balance — <span className={code}>1 credit = $1</span>. See the Models table for per-model rates. Usage and remaining balance are on the Usage page.</p>
          </Section>

        </div>
      </div>
    </div>
  );
}
