import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../../lib/prisma";

// Anthropic-native Messages endpoint — the drop-in for Claude Code and the
// Anthropic SDK. Behind apiKeyAuth (req.routerUserId / req.routerApiKeyId), so
// it accepts the sk-pf key via either `x-api-key` (Anthropic SDK default) or
// `Authorization: Bearer` (see middleware/apiKeyAuth).
//
// Unlike v1/chat (OpenAI shape, needs translation), this speaks Anthropic on
// both sides: the client body is forwarded almost verbatim to the Azure Claude
// passthrough and the native SSE frames are re-emitted unchanged. Only the model
// name is rewritten (client id → Azure deployment) and usage is billed.
//
// Point Claude Code at it:
//   ANTHROPIC_BASE_URL=https://api.ai-agents.com/api   (NOT /api/v1 — the
//     Anthropic SDK appends `/v1/messages` itself → /api/v1/messages here)
//   ANTHROPIC_API_KEY=sk-pf-…
// A compat alias is also mounted at /api/v1/v1/messages (see server.ts) so a
// base URL of …/api/v1 works too. Model may be sent as the RouterModel id
// (anthropic/opus-4.8) OR the native upstream name (claude-opus-4-8).

const router = Router();

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function anthropicClient(): Anthropic {
  const key = process.env.AZURE_CLAUDE_API_KEY;
  const endpoint = process.env.AZURE_CLAUDE_ENDPOINT;
  if (key && endpoint) {
    // Azure Foundry anthropic passthrough — SDK hits {baseURL}/v1/messages.
    return new Anthropic({ apiKey: key, baseURL: endpoint, defaultHeaders: { "api-key": key } });
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Total billable input tokens: base input + prompt-cache create + read. Cache
// reads priced at the full input rate (slight over-bill) — mirrors cli-llm.
function inputTokensFrom(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
}

type ResolvedModel = { id: string; upstreamModel: string; inputPricePer1M: any; outputPricePer1M: any };

const MODEL_SELECT = { id: true, upstreamModel: true, inputPricePer1M: true, outputPricePer1M: true } as const;

const MAX_UPSTREAM_BODY_BYTES = 30 * 1024 * 1024;
const MAX_COMPACTION_TOOL_RESULT_CHARS = 64 * 1024;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function isCompactionRequest(body: any): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  // These phrases are part of Claude Code's built-in compaction prompt. Keep
  // this narrow so normal requests retain their full history and attachments.
  const prompt = messages.slice(-3).map((message: any) => textFromContent(message?.content)).join("\n");
  return prompt.includes("Please provide your summary") && prompt.includes("RECENT messages");
}

function compactToolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    if (content.length <= MAX_COMPACTION_TOOL_RESULT_CHARS) return content;
    return `${content.slice(0, MAX_COMPACTION_TOOL_RESULT_CHARS)}\n[Older tool result truncated by adapter during conversation compaction]`;
  }
  if (!Array.isArray(content)) return content;
  return content.map((block: any) => {
    if (block?.type === "image" || block?.type === "document") {
      return { type: "text", text: `[${block.type} omitted during conversation compaction]` };
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > MAX_COMPACTION_TOOL_RESULT_CHARS) {
      return {
        ...block,
        text: `${block.text.slice(0, MAX_COMPACTION_TOOL_RESULT_CHARS)}\n[Older tool result truncated by adapter during conversation compaction]`,
      };
    }
    return block;
  });
}

function reduceOversizedCompaction(body: any): any {
  if (!isCompactionRequest(body) || Buffer.byteLength(JSON.stringify(body)) <= MAX_UPSTREAM_BODY_BYTES) return body;

  const reduced = { ...body };
  // The compaction prompt explicitly forbids tool calls. Schemas can be large,
  // and are unnecessary for the one-turn summarization request.
  delete reduced.tools;
  delete reduced.tool_choice;
  reduced.messages = (Array.isArray(body.messages) ? body.messages : []).map((message: any) => ({
    ...message,
    content: Array.isArray(message?.content)
      ? message.content.map((block: any) => {
          if (block?.type === "image" || block?.type === "document") {
            return { type: "text", text: `[${block.type} omitted during conversation compaction]` };
          }
          if (block?.type === "tool_result") {
            return { ...block, content: compactToolResultContent(block.content) };
          }
          return block;
        })
      : message?.content,
  }));
  return reduced;
}

// Resolve the client's model to a RouterModel row. Claude Code sends many id
// shapes for the same model — a `[1m]` context suffix, a trailing -YYYYMMDD
// version, family aliases — so we can't require an exact string. Strategy:
//   1. exact match on id or upstreamModel (raw + normalized)
//   2. any claude-* that still misses falls back to the default enabled
//      ANTHROPIC row, so the adapter never 400s a real Anthropic request.
async function resolveModel(model: string): Promise<ResolvedModel | null> {
  const raw = String(model ?? "").trim();
  // strip a "[1m]"-style suffix and a trailing "-YYYYMMDD" version date
  const norm = raw.replace(/\[[^\]]*\]\s*$/, "").replace(/-\d{8}$/, "");
  const candidates = Array.from(new Set([raw, norm].filter(Boolean)));

  const exact = (await prisma.routerModel.findFirst({
    where: { enabled: true, provider: "ANTHROPIC", OR: [{ id: { in: candidates } }, { upstreamModel: { in: candidates } }] },
    select: MODEL_SELECT,
  })) as ResolvedModel | null;
  if (exact) return exact;

  // Fallback: a Claude model with no exact row → keep it in-family so we don't
  // silently bill (say) a Sonnet alias as Opus or vice-versa. Pick the newest
  // enabled row of the requested family (upstreamModel desc), then Opus, then
  // any enabled Anthropic row. Explicit prefixes — NOT a bare `desc` over all
  // rows, which would order "claude-sonnet-*" ahead of "claude-opus-*".
  const lower = `${raw} ${norm}`.toLowerCase();
  if (lower.includes("claude")) {
    const family = lower.includes("sonnet") ? "claude-sonnet"
      : lower.includes("haiku") ? "claude-haiku"
      : "claude-opus";
    const byPrefix = async (prefix: string) => (await prisma.routerModel.findFirst({
      where: { enabled: true, provider: "ANTHROPIC", upstreamModel: { startsWith: prefix } },
      orderBy: { upstreamModel: "desc" },
      select: MODEL_SELECT,
    })) as ResolvedModel | null;
    return (
      (await byPrefix(family)) ??           // same family (newest)
      (await byPrefix("claude-opus")) ??    // Opus default
      ((await prisma.routerModel.findFirst({ where: { enabled: true, provider: "ANTHROPIC" }, orderBy: { upstreamModel: "desc" }, select: MODEL_SELECT })) as ResolvedModel | null)
    );
  }
  return null;
}

// Meter + debit one turn. Shared credit wallet (1 credit = $1) with the
// sub-credit carry scheme from v1/chat. Idempotent on requestId, never throws.
async function meterAndDebit(opts: {
  userId: string; apiKeyId: string; model: ResolvedModel; requestId: string;
  promptTokens: number; completionTokens: number; status: string; latencyMs: number;
}): Promise<number> {
  const { userId, apiKeyId, model, requestId, promptTokens, completionTokens, status, latencyMs } = opts;
  const cost = round6(
    (promptTokens / 1e6) * Number(model.inputPricePer1M) +
    (completionTokens / 1e6) * Number(model.outputPricePer1M),
  );
  try {
    await prisma.$transaction(async (tx) => {
      const uc = await tx.userCredits.findUnique({ where: { userId }, select: { credits: true, routerBalanceUsd: true } });
      const credits = uc?.credits ?? 0;
      const carry = Number(uc?.routerBalanceUsd ?? 0);
      const owed = round6(carry + cost);
      const debit = Math.min(Math.floor(owed), Math.max(0, credits));
      const newCarry = round6(owed - debit);
      await tx.userCredits.update({ where: { userId }, data: { credits: { decrement: debit }, routerBalanceUsd: newCarry } });
      await tx.creditLedger.create({
        data: { userId, delta: -debit, deltaUsd: -cost, reason: "v1_messages", source: "router", agentRunId: requestId },
      });
      await tx.apiKey.update({ where: { id: apiKeyId }, data: { spent: { increment: cost } } });
      await tx.usageRecord.create({
        data: { userId, apiKeyId, modelId: model.id, requestId, promptTokens, completionTokens, cost, status, latencyMs },
      });
    }, { isolationLevel: "Serializable" });
  } catch (e: any) {
    if (e?.code !== "P2002") console.error("[v1/messages] billing failed:", e?.message ?? e);
  }
  return cost;
}

// POST /api/v1/messages — Anthropic Messages, native passthrough.
router.post("/", async (req: Request, res: Response) => {
  const userId = (req as any).routerUserId as string;
  const apiKeyId = (req as any).routerApiKeyId as string;
  const body = req.body ?? {};
  const requestId = randomUUID();
  const startedAt = Date.now();

  // 1. Balance pre-check — shared wallet (1 credit = $1).
  const uc = await prisma.userCredits.findUnique({ where: { userId }, select: { credits: true } });
  if (!uc || uc.credits <= 0) {
    return res.status(402).json({ error: { type: "insufficient_credits", message: "insufficient credits" } });
  }

  // 2. Resolve model (RouterModel id or native upstream name).
  const model = await resolveModel(String(body.model ?? ""));
  if (!model) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: "unknown model" } });
  }

  // 3. Forward to upstream with the model rewritten to the Azure deployment.
  //    Strip fields the Azure Claude passthrough rejects: newer Claude Code
  //    betas it doesn't accept (context_management), and `temperature`, which
  //    opus-4-8 has deprecated ("temperature is deprecated for this model").
  //    Dropping temperature falls back to the model default (== Claude Code's
  //    default of 1), so no behavioural change.
  const upstream: any = reduceOversizedCompaction({ ...body, model: model.upstreamModel });
  delete upstream.context_management;
  delete upstream.temperature;
  const client = anthropicClient();
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let promptTokens = 0, completionTokens = 0;

  try {
    if (upstream.stream === true) {
      const stream = await client.messages.create({ ...upstream, stream: true } as any, { signal: controller.signal });
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      (res as any).flushHeaders?.();

      for await (const ev of stream as any) {
        if (ev.type === "message_start") promptTokens = inputTokensFrom(ev.message?.usage);
        else if (ev.type === "message_delta") completionTokens = ev.usage?.output_tokens ?? completionTokens;
        // Re-emit native Anthropic SSE frame unchanged — the SDK parses as-is.
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }

      await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
      if (!res.writableEnded) res.end();
    } else {
      const message = await client.messages.create({ ...upstream, stream: false } as any, { signal: controller.signal });
      promptTokens = inputTokensFrom((message as any).usage);
      completionTokens = (message as any).usage?.output_tokens ?? 0;
      await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
      // Return the native Anthropic message, but report the client's model id.
      return res.json({ ...(message as any), model: body.model });
    }
  } catch (err: any) {
    if (controller.signal.aborted) {
      await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "aborted", latencyMs: Date.now() - startedAt });
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[v1/messages] inference error:", err?.message ?? err);
    await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "error", latencyMs: Date.now() - startedAt });
    if (res.headersSent) { if (!res.writableEnded) res.end(); }
    else res.status(502).json({ error: { type: "api_error", message: "upstream provider error" } });
  }
});

export const messagesRouter = router;
export default router;
