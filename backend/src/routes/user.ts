import { Router } from "express";
import { billingService } from "../billing/billingService";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/credits", async (req, res) => {
  const userId = res.locals.userId as string | undefined;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await billingService.getCredits(userId);

    if (!result) {
      return res.json({
        credits: 1000,
        reservedCredits: 0,
        availableCredits: 1000,
        plan: "FREE",
      });
    }

    const latestPayment = await prisma.payment.findFirst({
      where: { userId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      select: { planId: true },
    });

    const plan = latestPayment ? latestPayment.planId : "FREE";

    return res.json({
      credits: result.credits,
      reservedCredits: result.reservedCredits,
      availableCredits: Math.max(0, result.credits - result.reservedCredits),
      plan,
    });
  } catch (err: any) {
    console.error("[UserRoute] getCredits failed:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.get("/ledger", async (req, res) => {
  const userId = res.locals.userId as string | undefined;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const limit = Math.min(parseInt((req.query.limit as string) || "10", 10), 50);

  try {
    const entries = await prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, delta: true, reason: true, agentRunId: true, createdAt: true },
    });

    const totalUsed = entries
      .filter((e) => e.delta < 0)
      .reduce((s, e) => s + Math.abs(e.delta), 0);

    return res.json({ entries, totalUsed });
  } catch (err: any) {
    console.error("[UserRoute] getLedger failed:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
