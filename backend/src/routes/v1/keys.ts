import { Router, Request, Response } from "express";
import { randomBytes, createHash } from "crypto";
import { prisma } from "../../lib/prisma";

// API key management for the router. Mounted under /api/v1/keys behind the
// existing JWT requireAuth (see routes/index.ts) — userId = res.locals.userId,
// same auth-service id used as User.clerkId everywhere else.
const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  const name = (req.body?.name ?? "").toString().trim();
  if (!name) return res.status(400).json({ error: "name required" });

  const raw = "sk-pf-" + randomBytes(32).toString("base64url");
  const keyHash = createHash("sha256").update(raw).digest("hex");

  const key = await prisma.apiKey.create({
    data: {
      userId,
      name,
      keyHash,
      keyPrefix: raw.slice(0, 12) + "…",
      last4: raw.slice(-4),
    },
    select: { id: true, name: true, keyPrefix: true, last4: true, status: true, createdAt: true },
  });

  // raw key returned ONCE — never stored, never retrievable again.
  return res.status(201).json({ ...key, key: raw });
});

router.get("/", async (_req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  const keys = await prisma.apiKey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, last4: true, status: true, lastUsedAt: true, spent: true, createdAt: true },
  });
  return res.json({ keys });
});

router.delete("/:id", async (req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  // updateMany scoped to userId so a user can't revoke someone else's key.
  const result = await prisma.apiKey.updateMany({
    where: { id: String(req.params.id), userId },
    data: { status: "REVOKED" },
  });
  if (result.count === 0) return res.status(404).json({ error: "key not found" });
  return res.json({ ok: true });
});

export default router;
