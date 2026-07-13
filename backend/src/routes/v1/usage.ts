import { Router, Request, Response } from "express";
import { prisma } from "../../lib/prisma";

// Router usage + credits dashboard data. Mounted under /api/v1/usage behind JWT.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const router = Router();

router.get("/summary", async (_req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  const [uc, agg, count, models] = await Promise.all([
    prisma.userCredits.findUnique({ where: { userId }, select: { credits: true, routerBalanceUsd: true } }),
    prisma.usageRecord.aggregate({ where: { userId }, _sum: { cost: true, promptTokens: true, completionTokens: true } }),
    prisma.usageRecord.count({ where: { userId } }),
    prisma.routerModel.findMany({ where: { enabled: true }, select: { id: true, displayName: true } }),
  ]);
  // 1 credit = $1. routerBalanceUsd is the unsettled sub-credit spend carry, so
  // true remaining = whole credits minus the fraction already consumed.
  const promptTokens = Number(agg._sum.promptTokens ?? 0);
  const completionTokens = Number(agg._sum.completionTokens ?? 0);
  res.json({
    balanceUsd: round6(Math.max(0, Number(uc?.credits ?? 0) - Number(uc?.routerBalanceUsd ?? 0))),
    totalSpent: Number(agg._sum.cost ?? 0),
    totalRequests: count,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    models,
  });
});

router.get("/", async (req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "25", 10) || 25));
  const days = parseInt((req.query.days as string) ?? "7", 10);

  const where: any = { userId };
  if (req.query.model) where.modelId = req.query.model as string;
  if (req.query.keyId) where.apiKeyId = req.query.keyId as string;
  if (days > 0) where.createdAt = { gte: new Date(Date.now() - days * 86_400_000) };

  const [records, total, keys] = await Promise.all([
    prisma.usageRecord.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.usageRecord.count({ where }),
    prisma.apiKey.findMany({ where: { userId }, select: { id: true, keyPrefix: true } }),
  ]);
  const keyMap = Object.fromEntries(keys.map((k) => [k.id, k.keyPrefix]));

  res.json({
    total, page, limit,
    records: records.map((r) => ({
      id: r.id, createdAt: r.createdAt, modelId: r.modelId,
      promptTokens: r.promptTokens, completionTokens: r.completionTokens,
      cost: Number(r.cost), status: r.status,
      keyPrefix: keyMap[r.apiKeyId] ?? "—",
    })),
  });
});

export default router;
