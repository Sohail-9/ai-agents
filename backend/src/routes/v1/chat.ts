import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../../lib/prisma";
import { getAzureConfig } from "../../brain/tiers";

// OpenAI-compatible inference router. Behind apiKeyAuth (req.routerUserId /
// req.routerApiKeyId set there). Reuses the same provider SDKs as brain/* but
// talks raw chat-completions passthrough instead of the task-specific helpers
// in brain/providers/* (which don't expose a generic chat method).
//
// Models are Azure-deployed: OpenAI via Azure AI Foundry (getAzureConfig),
// Claude via the Azure /anthropic passthrough. RouterModel.upstreamModel is the
// Azure deployment name (gpt-5.5 / gpt-5.3-codex / claude-opus-4-8). Falls back
// to direct OPENAI_API_KEY / ANTHROPIC_API_KEY when Azure env is absent.

function openaiClient(): OpenAI {
  const azure = getAzureConfig();
  if (azure) return new OpenAI({ apiKey: azure.apiKey, baseURL: azure.baseURL, defaultQuery: azure.defaultQuery, defaultHeaders: azure.defaultHeaders });
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function anthropicClient(): Anthropic {
  const key = process.env.AZURE_CLAUDE_API_KEY;
  const endpoint = process.env.AZURE_CLAUDE_ENDPOINT;
  if (key && endpoint) {
    // Azure Foundry anthropic passthrough — SDK hits {baseURL}/v1/messages.
    // Send both auth header styles (x-api-key via apiKey, plus Azure's api-key).
    return new Anthropic({ apiKey: key, baseURL: endpoint, defaultHeaders: { "api-key": key } });
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wrap a provider request-initiation. On upstream 429: wait 1s, retry once.
// Still 429 → throw a tagged error the route turns into a 529. Must wrap the
// awaited call that fires the HTTP request (so it rejects before SSE headers).
async function callUpstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.status !== 429) throw e;
    await sleep(1000);
    try {
      return await fn();
    } catch (e2: any) {
      if (e2?.status === 429) { const err: any = new Error("upstream overloaded"); err.isUpstream429 = true; throw err; }
      throw e2;
    }
  }
}

type RouterModel = {
  id: string; displayName: string; provider: string; upstreamModel: string;
  inputPricePer1M: any; outputPricePer1M: any; enabled: boolean;
};

// ── Billing ────────────────────────────────────────────────────────────────
// Runs AFTER the response is sent. Atomic, idempotent on requestId.
async function meterAndDebit(opts: {
  userId: string; apiKeyId: string; model: RouterModel; requestId: string;
  promptTokens: number; completionTokens: number; status: string; latencyMs: number;
}): Promise<number> {
  const { userId, apiKeyId, model, requestId, promptTokens, completionTokens, status, latencyMs } = opts;
  // 1 credit = $1, so USD cost == credit cost. Single shared wallet with agents.
  const cost = round6(
    (promptTokens / 1e6) * Number(model.inputPricePer1M) +
    (completionTokens / 1e6) * Number(model.outputPricePer1M),
  );
  try {
    await prisma.$transaction(async (tx) => {
      const uc = await tx.userCredits.findUnique({ where: { userId }, select: { credits: true, routerBalanceUsd: true } });
      const credits = uc?.credits ?? 0;
      // routerBalanceUsd repurposed: sub-credit spend *carry* (accrued USD below
      // one whole credit). Router costs are fractional but `credits` is Int, so
      // we accrue here and settle whole credits against the shared Int wallet —
      // tiny calls no longer round to zero. Clamp settled credits to balance so
      // it never goes negative (mirrors agent billing).
      const carry = Number(uc?.routerBalanceUsd ?? 0);
      const owed = round6(carry + cost);
      const debit = Math.min(Math.floor(owed), Math.max(0, credits)); // whole credits to settle now
      const newCarry = round6(owed - debit);                          // unsettled fraction (+ any unaffordable remainder)
      await tx.userCredits.update({ where: { userId }, data: { credits: { decrement: debit }, routerBalanceUsd: newCarry } });
      await tx.creditLedger.create({
        // delta(Int) = whole credits settled this call; deltaUsd = exact spend.
        // agentRunId reused as the idempotency key (unique [userId, agentRunId]).
        data: { userId, delta: -debit, deltaUsd: -cost, reason: "v1_routing", source: "router", agentRunId: requestId },
      });
      await tx.apiKey.update({ where: { id: apiKeyId }, data: { spent: { increment: cost } } });
      await tx.usageRecord.create({
        data: { userId, apiKeyId, modelId: model.id, requestId, promptTokens, completionTokens, cost, status, latencyMs },
      });
    }, { isolationLevel: "Serializable" }); // serialize concurrent debits so the balance clamp can't be raced past zero
  } catch (e: any) {
    // P2002 = unique violation on requestId/ledger → already billed (retry). Idempotent, swallow.
    if (e?.code !== "P2002") console.error("[router] billing failed:", e?.message ?? e);
  }
  return cost;
}

// Split OpenAI messages into Anthropic (system string + messages[]).
function toAnthropic(messages: any[]): { system?: string; messages: any[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  return { system, messages: rest };
}

const openaiChunk = (id: string, model: string, delta: any, finish: string | null = null) => ({
  id, object: "chat.completion.chunk", created: 0, model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// ── Models ───────────────────────────────────────────────────────────────
export const modelsRouter = Router();
modelsRouter.get("/", async (_req, res) => {
  const models = await prisma.routerModel.findMany({ where: { enabled: true } });
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id, object: "model", owned_by: m.provider.toLowerCase(),
      pricing: { input_per_1m: Number(m.inputPricePer1M), output_per_1m: Number(m.outputPricePer1M) },
    })),
  });
});

// ── Completions ────────────────────────────────────────────────────────────
export const chatRouter = Router();
chatRouter.post("/completions", async (req: Request, res: Response) => {
  const userId = (req as any).routerUserId as string;
  const apiKeyId = (req as any).routerApiKeyId as string;
  const body = req.body ?? {};
  const requestId = randomUUID();
  const startedAt = Date.now();

  // 1. Balance pre-check — single shared wallet (1 credit = $1).
  const uc = await prisma.userCredits.findUnique({ where: { userId }, select: { credits: true } });
  if (!uc || uc.credits <= 0) {
    return res.status(402).json({ error: { message: "insufficient credits" } });
  }

  // 2. Resolve model
  const model = (await prisma.routerModel.findUnique({ where: { id: body.model } })) as RouterModel | null;
  if (!model || !model.enabled) {
    return res.status(400).json({ error: { message: "unknown model" } });
  }

  const stream = body.stream === true;
  let promptTokens = 0, completionTokens = 0;

  try {
    if (model.provider === "OPENAI") {
      const client = openaiClient();
      // GPT-5.x (reasoning) models reject `max_tokens` — remap to the param they
      // accept so standard OpenAI-SDK clients work unchanged.
      const oaBody: any = { ...body, model: model.upstreamModel };
      if (oaBody.max_tokens != null) { oaBody.max_completion_tokens = oaBody.max_tokens; delete oaBody.max_tokens; }
      if (stream) {
        const s = await callUpstream(() => client.chat.completions.create({
          ...oaBody, stream: true, stream_options: { include_usage: true },
        } as any));
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for await (const chunk of s as any) {
          if (chunk.usage) { promptTokens = chunk.usage.prompt_tokens ?? 0; completionTokens = chunk.usage.completion_tokens ?? 0; }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } else {
        const c = await callUpstream(() => client.chat.completions.create({ ...oaBody, stream: false } as any));
        promptTokens = c.usage?.prompt_tokens ?? 0;
        completionTokens = c.usage?.completion_tokens ?? 0;
        const cost = await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
        return res.json({ ...c, id: `chatcmpl-${requestId}`, usage: { ...c.usage, cost } });
      }
    } else if (model.provider === "OPENAI_RESPONSES") {
      // Codex / reasoning models that Azure serves only via the Responses API.
      // Same Azure client; messages[] -> input[], response -> OpenAI-chat shape.
      const client = openaiClient();
      const params: any = { model: model.upstreamModel, input: body.messages ?? [] };
      const cap = body.max_completion_tokens ?? body.max_tokens;
      if (cap != null) params.max_output_tokens = cap;
      if (body.temperature != null) params.temperature = body.temperature;
      const id = `chatcmpl-${requestId}`;
      if (stream) {
        const s = await callUpstream(() => client.responses.create({ ...params, stream: true } as any));
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for await (const ev of s as any) {
          if (ev.type === "response.output_text.delta") {
            res.write(`data: ${JSON.stringify(openaiChunk(id, model.id, { content: ev.delta }))}\n\n`);
          } else if (ev.type === "response.completed") {
            promptTokens = ev.response?.usage?.input_tokens ?? promptTokens;
            completionTokens = ev.response?.usage?.output_tokens ?? completionTokens;
          }
        }
        res.write(`data: ${JSON.stringify(openaiChunk(id, model.id, {}, "stop"))}\n\n`);
      } else {
        const r: any = await callUpstream(() => client.responses.create(params as any));
        promptTokens = r.usage?.input_tokens ?? 0;
        completionTokens = r.usage?.output_tokens ?? 0;
        const cost = await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
        return res.json({
          id, object: "chat.completion", created: Math.floor(startedAt / 1000), model: model.id,
          choices: [{ index: 0, message: { role: "assistant", content: r.output_text ?? "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost },
        });
      }
    } else if (model.provider === "ANTHROPIC") {
      const client = anthropicClient();
      const { system, messages } = toAnthropic(body.messages ?? []);
      const maxTokens = body.max_tokens ?? 4096;
      if (stream) {
        // create({stream:true}) (not .stream()) so a 429 rejects the await
        // before any SSE header is sent, letting callUpstream retry → 529.
        const s = await callUpstream(() => client.messages.create({ model: model.upstreamModel, system, messages, max_tokens: maxTokens, temperature: body.temperature, stream: true } as any));
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const id = `chatcmpl-${requestId}`;
        for await (const ev of s as any) {
          if (ev.type === "message_start") promptTokens = ev.message?.usage?.input_tokens ?? 0;
          else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            res.write(`data: ${JSON.stringify(openaiChunk(id, model.id, { content: ev.delta.text }))}\n\n`);
          } else if (ev.type === "message_delta") completionTokens = ev.usage?.output_tokens ?? completionTokens;
        }
        res.write(`data: ${JSON.stringify(openaiChunk(id, model.id, {}, "stop"))}\n\n`);
      } else {
        const m = await callUpstream(() => client.messages.create({ model: model.upstreamModel, system, messages, max_tokens: maxTokens, temperature: body.temperature } as any));
        promptTokens = m.usage?.input_tokens ?? 0;
        completionTokens = m.usage?.output_tokens ?? 0;
        const text = (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        const cost = await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
        return res.json({
          id: `chatcmpl-${requestId}`, object: "chat.completion", created: Math.floor(startedAt / 1000), model: model.id,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost },
        });
      }
    } else {
      return res.status(400).json({ error: { message: `unsupported provider ${model.provider}` } });
    }

    // ── Streaming tail: bill, then emit usage + [DONE]. Runs even if the
    // client disconnected mid-stream (provider already charged us). ──────────
    const cost = await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ id: `chatcmpl-${requestId}`, object: "chat.completion.chunk", model: model.id, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err: any) {
    // Upstream overloaded after a retry → 529, no charge (no tokens produced).
    if (err?.isUpstream429) {
      if (!res.headersSent) {
        res.setHeader("Retry-After", 5);
        return res.status(529).json({ error: "upstream overloaded" });
      }
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[router] inference error:", err?.message ?? err);
    await meterAndDebit({ userId, apiKeyId, model, requestId, promptTokens, completionTokens, status: "error", latencyMs: Date.now() - startedAt });
    if (res.headersSent) { if (!res.writableEnded) res.end(); }
    else res.status(502).json({ error: { message: "upstream provider error" } });
  }
});
