import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

const isAdmin = (req: Request): boolean => {
  const adminToken = req.headers["x-admin-token"] as string | undefined;
  const expectedToken = btoa(`${process.env.DEMO_ADMIN_EMAIL}:${process.env.DEMO_ADMIN_PASSWORD}`);
  return adminToken === expectedToken;
};

// GET /api/credits/admin/users
router.get("/admin/users", async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  try {
    const users = await prisma.user.findMany({
      include: {
        creditAccount: { select: { credits: true, reservedCredits: true } },
        ledger: {
          where: { delta: { lt: 0 } },
          select: { delta: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.json(
      users.map((u) => {
        const credits = u.creditAccount?.credits ?? 10000;
        const reserved = u.creditAccount?.reservedCredits ?? 0;
        const usedCredits = u.ledger.reduce((sum, l) => sum + Math.abs(l.delta), 0);
        const totalEver = credits + usedCredits;
        const usagePercent =
          totalEver > 0 ? Math.round((usedCredits / totalEver) * 1000) / 10 : 0;
        return {
          id: u.id,
          clerkId: u.clerkId,
          email: u.email,
          name: u.name,
          image: u.image,
          createdAt: u.createdAt,
          credits,
          reservedCredits: reserved,
          availableCredits: Math.max(0, credits - reserved),
          usedCredits,
          usagePercent,
        };
      })
    );
  } catch (error) {
    console.error("[AdminCredits] list users error:", error);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/credits/admin/users/:clerkId/adjust
router.post("/admin/users/:clerkId/adjust", async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  const clerkId = req.params.clerkId as string;
  const { delta } = req.body as { delta?: number };

  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: "delta must be a non-zero finite number" });
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.userCredits.findUnique({ where: { userId: clerkId } });

      if (!existing) {
        const newCredits = Math.max(0, 10000 + delta);
        const created = await tx.userCredits.create({
          data: { userId: clerkId, credits: newCredits },
        });
        await tx.creditLedger.create({
          data: { userId: clerkId, delta, reason: delta > 0 ? "topup" : "manual_refund" },
        });
        return created;
      }

      const newCredits = Math.max(0, existing.credits + delta);
      const actualDelta = newCredits - existing.credits;
      if (actualDelta === 0) return existing;

      const result = await tx.userCredits.update({
        where: { userId: clerkId },
        data: { credits: newCredits },
      });
      await tx.creditLedger.create({
        data: {
          userId: clerkId,
          delta: actualDelta,
          reason: actualDelta > 0 ? "topup" : "manual_refund",
        },
      });
      return result;
    });

    return res.json({ credits: updated.credits });
  } catch (error) {
    console.error("[AdminCredits] adjust error:", error);
    return res.status(500).json({ error: "Failed to adjust credits" });
  }
});

// POST /api/credits/admin/allocate-all
router.post("/admin/allocate-all", async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  const { credits } = req.body as { credits?: number };

  if (typeof credits !== "number" || !Number.isFinite(credits) || credits === 0) {
    return res.status(400).json({ error: "credits must be a non-zero finite number" });
  }

  try {
    const allUsers = await prisma.userCredits.findMany({
      select: { userId: true, credits: true },
    });

    if (allUsers.length === 0) return res.json({ affected: 0 });

    await prisma.$transaction(async (tx) => {
      for (const u of allUsers) {
        const newCredits = Math.max(0, u.credits + credits);
        await tx.userCredits.update({
          where: { userId: u.userId },
          data: { credits: newCredits },
        });
      }
      await tx.creditLedger.createMany({
        data: allUsers.map((u) => ({
          userId: u.userId,
          delta: credits,
          reason: credits > 0 ? "topup" : ("manual_refund" as string),
        })),
      });
    });

    return res.json({ affected: allUsers.length });
  } catch (error) {
    console.error("[AdminCredits] allocate-all error:", error);
    return res.status(500).json({ error: "Failed to allocate credits" });
  }
});

// POST /api/credits/admin/conditional-allocate
router.post("/admin/conditional-allocate", async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  const { usageThresholdPercent, creditsToAdd } = req.body as {
    usageThresholdPercent?: number;
    creditsToAdd?: number;
  };

  if (
    typeof usageThresholdPercent !== "number" ||
    !Number.isFinite(usageThresholdPercent) ||
    usageThresholdPercent < 0 ||
    usageThresholdPercent > 100
  ) {
    return res.status(400).json({ error: "usageThresholdPercent must be 0–100" });
  }

  if (
    typeof creditsToAdd !== "number" ||
    !Number.isFinite(creditsToAdd) ||
    creditsToAdd === 0
  ) {
    return res.status(400).json({ error: "creditsToAdd must be a non-zero number" });
  }

  try {
    const users = await prisma.user.findMany({
      include: {
        creditAccount: { select: { userId: true, credits: true } },
        ledger: {
          where: { delta: { lt: 0 } },
          select: { delta: true },
        },
      },
    });

    const eligible = users.filter((u) => {
      if (!u.creditAccount) return false;
      const credits = u.creditAccount.credits;
      const usedCredits = u.ledger.reduce((sum, l) => sum + Math.abs(l.delta), 0);
      const totalEver = credits + usedCredits;
      const usagePercent = totalEver > 0 ? (usedCredits / totalEver) * 100 : 0;
      return usagePercent >= usageThresholdPercent;
    });

    if (eligible.length === 0) return res.json({ affected: 0 });

    await prisma.$transaction(async (tx) => {
      for (const u of eligible) {
        await tx.userCredits.update({
          where: { userId: u.clerkId },
          data: { credits: { increment: creditsToAdd } },
        });
      }
      await tx.creditLedger.createMany({
        data: eligible.map((u) => ({
          userId: u.clerkId,
          delta: creditsToAdd,
          reason: "topup" as string,
        })),
      });
    });

    return res.json({ affected: eligible.length });
  } catch (error) {
    console.error("[AdminCredits] conditional-allocate error:", error);
    return res.status(500).json({ error: "Failed to conditionally allocate credits" });
  }
});

export default router;
