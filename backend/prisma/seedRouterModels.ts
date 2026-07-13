import { prisma } from "../src/lib/prisma";

// Seed the router model registry with exact USD per-1M-token pricing.
// Idempotent: re-running upserts (safe to run after every migration).
// gpt-5.3-codex uses provider "OPENAI_RESPONSES" — Azure serves it via the
// Responses API, not /chat/completions (handled in routes/v1/chat.ts).
const MODELS = [
  { id: "openai/gpt-5.5", displayName: "GPT-5.5", provider: "OPENAI", upstreamModel: "gpt-5.5", inputPricePer1M: "5.00", outputPricePer1M: "30.00", enabled: true },
  { id: "openai/gpt-5.3-codex", displayName: "GPT-5.3 Codex", provider: "OPENAI_RESPONSES", upstreamModel: "gpt-5.3-codex", inputPricePer1M: "1.75", outputPricePer1M: "14.00", enabled: true },
  { id: "anthropic/opus-4.8", displayName: "Claude Opus 4.8", provider: "ANTHROPIC", upstreamModel: "claude-opus-4-8", inputPricePer1M: "5.00", outputPricePer1M: "25.00", enabled: true },
  { id: "anthropic/opus-4.7", displayName: "Claude Opus 4.7", provider: "ANTHROPIC", upstreamModel: "claude-opus-4-7", inputPricePer1M: "5.00", outputPricePer1M: "25.00", enabled: true },
  { id: "anthropic/opus-4.6", displayName: "Claude Opus 4.6", provider: "ANTHROPIC", upstreamModel: "claude-opus-4-6", inputPricePer1M: "5.00", outputPricePer1M: "25.00", enabled: true },
  { id: "anthropic/sonnet-5", displayName: "Claude Sonnet 5", provider: "ANTHROPIC", upstreamModel: "claude-sonnet-5", inputPricePer1M: "3.00", outputPricePer1M: "15.00", enabled: true },
  { id: "anthropic/sonnet-4.6", displayName: "Claude Sonnet 4.6", provider: "ANTHROPIC", upstreamModel: "claude-sonnet-4-6", inputPricePer1M: "3.00", outputPricePer1M: "15.00", enabled: true },
];

async function main() {
  for (const m of MODELS) {
    await prisma.routerModel.upsert({
      where: { id: m.id },
      update: { displayName: m.displayName, provider: m.provider, upstreamModel: m.upstreamModel, inputPricePer1M: m.inputPricePer1M, outputPricePer1M: m.outputPricePer1M, enabled: m.enabled },
      create: m,
    });
    console.log(`seeded ${m.id} (enabled=${m.enabled})`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
