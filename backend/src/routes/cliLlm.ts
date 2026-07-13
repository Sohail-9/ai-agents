import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../lib/prisma";
import { verifyServiceToken } from "../lib/serviceToken";
import { redisConnection } from "../queue/connection";

/**
 * CLI LLM gateway (Phases 1, 3, 4).
 *
 * The AI Agents CLI no longer calls the provider directly. Instead its kosong
 * provider is pointed at this endpoint as an Anthropic-compatible base URL, so
 * the Anthropic SDK on the CLI hits `POST {baseURL}/v1/messages` here. We inject
 * the real Azure Claude key server-side (never shipped to the client), forward
 * to the Azure Claude passthrough, and stream the native Anthropic SSE events
 * straight back — tools, thinking and images ride the wire format unchanged, so
 * there is nothing to translate on either side.
 *
 * Additive and non-destructive:
 *   - always on by design; opt-out kill-switch via CLI_LLM_DISABLED=1 (→ 503).
 *   - Phase 1: records token usage into UsageRecord (`apiKeyId`/`modelId` are
 *     bare strings, no FK → no migration).
 *   - Phase 3: computes cost from RouterModel pricing (or CLI_LLM_*_PRICE_PER_1M
 *     env fallback) and debits credits atomically + idempotently, in the SAME
 *     transaction as the usage record (mirrors v1/chat meterAndDebit). When no
 *     pricing is configured the rate is 0 → cost 0 → no debit, i.e. it safely
 *     degrades to observe-only.
 *   - Phase 4: pre-flight enforcement. Opt-in credit gate (CLI_LLM_ENFORCE_CREDITS
 *     → 402 at zero balance) and time-windowed token quota (CliQuotaPolicy /
 *     CliQuotaUsage → 429 + Retry-After). Quota is inert until a policy row
 *     exists, so this ships without locking anyone out.
 *
 * Auth: this subtree is excluded from the global requireAuth (see routes/index)
 * and authenticates itself, because the CLI's Anthropic SDK sends the account
 * token in the `x-api-key` header (not `Authorization`). We accept either and
 * verify with the same JWKS service-token check the global guard uses.
 */

const router = Router();

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Total billable input tokens from an Anthropic usage object: base input plus
 * prompt-cache create + read. NOTE: this prices cache reads at the full input
 * rate, which over-bills them slightly. Precise cache pricing (separate columns
 * + rates) is a documented follow-up; folding them in keeps Phase 3 migration-free.
 */
function inputTokensFrom(usage: any): number {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
}

type Rates = { input: number; output: number };

// Pricing changes rarely → cache resolved rates in Redis. Default 1h; admins who
// edit a RouterModel see it after the TTL (or delete the key to bust it).
const PRICE_CACHE_TTL = Number(process.env.CLI_LLM_PRICE_CACHE_TTL ?? 3600);
const priceCacheKey = (modelId: string, deployment: string | undefined) =>
  `cli-llm:price:${modelId}:${deployment ?? "-"}`;

/** Read RouterModel pricing (by id or deployment); fall back to env, then 0. */
async function lookupRatesFromDb(
  modelId: string,
  deployment: string | undefined,
): Promise<Rates> {
  try {
    const m = await prisma.routerModel.findFirst({
      where: { OR: [{ id: modelId }, ...(deployment ? [{ upstreamModel: deployment }] : [])] },
      select: { inputPricePer1M: true, outputPricePer1M: true },
    });
    if (m) return { input: Number(m.inputPricePer1M), output: Number(m.outputPricePer1M) };
  } catch (e: any) {
    console.error("[cli-llm] price lookup failed:", e?.message ?? e);
  }
  return {
    input: Number(process.env.CLI_LLM_INPUT_PRICE_PER_1M ?? 0),
    output: Number(process.env.CLI_LLM_OUTPUT_PRICE_PER_1M ?? 0),
  };
}

/**
 * Per-1M input/output USD rates, cached in Redis. First call hits the DB and
 * stores the result; later calls read the cache. Cache failures are non-fatal —
 * we fall straight through to the DB so pricing never depends on Redis being up.
 */
async function resolveRates(modelId: string, deployment: string | undefined): Promise<Rates> {
  const key = priceCacheKey(modelId, deployment);
  try {
    const cached = await redisConnection.get(key);
    if (cached) return JSON.parse(cached) as Rates;
  } catch (e: any) {
    console.error("[cli-llm] price cache read failed:", e?.message ?? e);
  }

  const rates = await lookupRatesFromDb(modelId, deployment);

  // Cache the result (including a 0-rate miss) so repeated turns don't re-query.
  try {
    await redisConnection.set(key, JSON.stringify(rates), "EX", PRICE_CACHE_TTL);
  } catch (e: any) {
    console.error("[cli-llm] price cache write failed:", e?.message ?? e);
  }
  return rates;
}

/** Extract the account token from x-api-key (Anthropic SDK) or Bearer header. */
function extractToken(req: Request): string | undefined {
  const xApiKey = req.header("x-api-key");
  if (xApiKey && xApiKey.trim().length > 0) return xApiKey.trim();
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

function anthropicClient(): Anthropic {
  const key = process.env.AZURE_CLAUDE_API_KEY;
  const endpoint = process.env.AZURE_CLAUDE_ENDPOINT;
  if (key && endpoint) {
    // Azure Foundry anthropic passthrough — SDK hits {baseURL}/v1/messages.
    return new Anthropic({ apiKey: key, baseURL: endpoint, defaultHeaders: { "api-key": key } });
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Meter + debit one CLI turn. Records usage and (when cost > 0) debits credits
 * in a single Serializable transaction, idempotent on requestId. Never throws —
 * a billing/telemetry failure must not break the response.
 */
async function meterCliTurn(opts: {
  userId: string; requestId: string; modelId: string; deployment: string | undefined;
  promptTokens: number; completionTokens: number; status: string; latencyMs: number;
}): Promise<void> {
  const rates = await resolveRates(opts.modelId, opts.deployment);
  const cost = round6(
    (opts.promptTokens / 1e6) * rates.input +
    (opts.completionTokens / 1e6) * rates.output,
  );
  try {
    await prisma.$transaction(async (tx) => {
      // Usage row first — its unique requestId is the idempotency guard for the
      // whole transaction (a retry hits P2002 here and aborts before debiting).
      await tx.usageRecord.create({
        data: {
          userId: opts.userId,
          apiKeyId: "cli", // sentinel: CLI turns have no router ApiKey (bare string, no FK)
          modelId: opts.modelId,
          requestId: opts.requestId,
          promptTokens: opts.promptTokens,
          completionTokens: opts.completionTokens,
          cost,
          status: opts.status,
          latencyMs: opts.latencyMs,
        },
      });

      // Quota: increment every live window for this user by total tokens used.
      // Inside the txn so the usageRecord P2002 guard makes it idempotent (a
      // retried turn won't double-count). No-op when the user has no windows.
      const totalTokens = opts.promptTokens + opts.completionTokens;
      if (totalTokens > 0) {
        await tx.cliQuotaUsage.updateMany({
          where: { userId: opts.userId },
          data: { tokensUsed: { increment: totalTokens } },
        });
      }

      if (cost <= 0) return; // no pricing configured → observe-only, nothing to debit
      const uc = await tx.userCredits.findUnique({
        where: { userId: opts.userId },
        select: { credits: true, routerBalanceUsd: true },
      });
      if (!uc) return; // no wallet row → can't debit (Phase 4 will pre-check existence)

      // Same sub-credit carry scheme as v1/chat: accrue fractional USD spend in
      // routerBalanceUsd, settle whole credits against the Int wallet, clamp so
      // the balance never goes negative. 1 credit = $1.
      const credits = uc.credits ?? 0;
      const carry = Number(uc.routerBalanceUsd ?? 0);
      const owed = round6(carry + cost);
      const debit = Math.min(Math.floor(owed), Math.max(0, credits));
      const newCarry = round6(owed - debit);
      await tx.userCredits.update({
        where: { userId: opts.userId },
        data: { credits: { decrement: debit }, routerBalanceUsd: newCarry },
      });
      await tx.creditLedger.create({
        // delta(Int) = whole credits settled; deltaUsd = exact spend. requestId
        // reused as agentRunId → unique [userId, agentRunId] idempotency.
        data: { userId: opts.userId, delta: -debit, deltaUsd: -cost, reason: "cli_turn", source: "cli", agentRunId: opts.requestId },
      });
    }, { isolationLevel: "Serializable" });
  } catch (e: any) {
    // P2002 = duplicate requestId/ledger (idempotent retry) → already billed. Swallow.
    if (e?.code !== "P2002") console.error("[cli-llm] metering failed:", e?.message ?? e);
  }
}

/**
 * Quota (Phase 4). Time-windowed token allowance, separate from credits. Inert
 * until at least one enabled policy exists. Applicable policies = GLOBAL + this
 * user's USER-scoped overrides (PLAN scope is a later addition). A turn passes
 * only if every applicable window is under its limit.
 */
async function checkQuota(userId: string): Promise<{ ok: boolean; retryAt?: Date }> {
  let policies;
  try {
    policies = await prisma.cliQuotaPolicy.findMany({
      where: { enabled: true, OR: [{ scope: "GLOBAL" }, { scope: "USER", userId }] },
    });
  } catch (e: any) {
    // Never fail-closed on a quota-store error — let the turn through, just log.
    console.error("[cli-llm] quota lookup failed:", e?.message ?? e);
    return { ok: true };
  }
  if (policies.length === 0) return { ok: true };

  const now = new Date();
  for (const p of policies) {
    const { tokensUsed, windowEndAt } = await rollWindow(userId, p, now);
    if (tokensUsed >= p.tokenLimit) return { ok: false, retryAt: windowEndAt };
  }
  return { ok: true };
}

/** Load the current window for (user, policy), rolling/creating it if expired. */
async function rollWindow(
  userId: string,
  policy: { id: string; windowHours: number },
  now: Date,
): Promise<{ tokensUsed: number; windowEndAt: Date }> {
  const where = { userId_policyId: { userId, policyId: policy.id } };
  const endFrom = (start: Date) => new Date(start.getTime() + policy.windowHours * 3600_000);

  const existing = await prisma.cliQuotaUsage.findUnique({ where });
  if (existing && now < existing.windowEndAt) {
    return { tokensUsed: existing.tokensUsed, windowEndAt: existing.windowEndAt };
  }

  const windowEndAt = endFrom(now);
  if (!existing) {
    try {
      await prisma.cliQuotaUsage.create({
        data: { userId, policyId: policy.id, windowStartAt: now, windowEndAt, tokensUsed: 0 },
      });
    } catch (e: any) {
      if (e?.code !== "P2002") throw e; // racing create → fall through to read below
      const row = await prisma.cliQuotaUsage.findUnique({ where });
      if (row && now < row.windowEndAt) return { tokensUsed: row.tokensUsed, windowEndAt: row.windowEndAt };
    }
    return { tokensUsed: 0, windowEndAt };
  }

  // Expired → reset the window.
  await prisma.cliQuotaUsage.update({
    where,
    data: { windowStartAt: now, windowEndAt, tokensUsed: 0 },
  });
  return { tokensUsed: 0, windowEndAt };
}

// POST /api/cli/llm/v1/messages — Anthropic-compatible passthrough.
router.post("/v1/messages", async (req: Request, res: Response) => {
  // Gateway is always on: AI Agents routes the CLI through the server gateway by
  // design, so this is hardcoded enabled (no env flag). Opt out explicitly with
  // CLI_LLM_DISABLED=1 if a kill-switch is ever needed.
  if (process.env.CLI_LLM_DISABLED) {
    return res.status(503).json({ error: { message: "CLI LLM gateway disabled" } });
  }

  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: { message: "Unauthorized" } });
  const identity = await verifyServiceToken(token);
  if (!identity) return res.status(401).json({ error: { message: "Unauthorized" } });
  const userId = identity.userId;

  // ── Phase 4 enforcement (pre-flight, before any LLM spend) ──
  // Credit gate is opt-in so it can't lock users out on rollout.
  if (process.env.CLI_LLM_ENFORCE_CREDITS) {
    const uc = await prisma.userCredits.findUnique({ where: { userId }, select: { credits: true } });
    if (!uc || uc.credits <= 0) {
      return res.status(402).json({ error: { message: "insufficient credits" } });
    }
  }
  // Quota gate is self-gating: inert unless a policy row exists.
  const quota = await checkQuota(userId);
  if (!quota.ok) {
    if (quota.retryAt) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((quota.retryAt.getTime() - Date.now()) / 1000)));
    }
    return res.status(429).json({ error: { message: "quota exceeded", resetAt: quota.retryAt } });
  }

  const body = req.body ?? {};
  const requestId = randomUUID();
  const startedAt = Date.now();
  const modelId = String(body.model ?? "claude");
  const deployment = process.env.AZURE_CLAUDE_DEPLOYMENT || undefined;

  // Map the logical model to the Azure deployment; key stays server-side.
  const upstream = {
    ...body,
    model: deployment || body.model,
  };

  const client = anthropicClient();
  const controller = new AbortController();
  // Client disconnect → abort upstream so we stop generating (and paying).
  req.on("close", () => controller.abort());

  let promptTokens = 0, completionTokens = 0;

  try {
    if (upstream.stream === true) {
      const stream = await client.messages.create(
        { ...upstream, stream: true } as any,
        { signal: controller.signal },
      );

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      (res as any).flushHeaders?.();

      for await (const ev of stream as any) {
        if (ev.type === "message_start") {
          promptTokens = inputTokensFrom(ev.message?.usage);
        } else if (ev.type === "message_delta") {
          completionTokens = ev.usage?.output_tokens ?? completionTokens;
        }
        // Re-emit the native Anthropic SSE frame so the CLI SDK parses it as-is.
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }

      await meterCliTurn({ userId, requestId, modelId, deployment, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
      if (!res.writableEnded) res.end();
    } else {
      const message = await client.messages.create(
        { ...upstream, stream: false } as any,
        { signal: controller.signal },
      );
      promptTokens = inputTokensFrom((message as any).usage);
      completionTokens = (message as any).usage?.output_tokens ?? 0;
      await meterCliTurn({ userId, requestId, modelId, deployment, promptTokens, completionTokens, status: "success", latencyMs: Date.now() - startedAt });
      return res.json(message);
    }
  } catch (err: any) {
    // Client aborted mid-stream: still bill what was generated, then bail.
    if (controller.signal.aborted) {
      await meterCliTurn({ userId, requestId, modelId, deployment, promptTokens, completionTokens, status: "aborted", latencyMs: Date.now() - startedAt });
      if (!res.writableEnded) res.end();
      return;
    }
    console.error("[cli-llm] inference error:", err?.message ?? err);
    await meterCliTurn({ userId, requestId, modelId, deployment, promptTokens, completionTokens, status: "error", latencyMs: Date.now() - startedAt });
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
    } else {
      res.status(502).json({ error: { message: "upstream provider error" } });
    }
  }
});

export default router;
