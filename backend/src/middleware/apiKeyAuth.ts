import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { prisma } from "../lib/prisma";

// Auth plane for the OpenAI-compatible router. Validates a `sk-pf-…` Bearer
// token against ApiKey.keyHash (sha256). Mounted on /api/v1/chat and
// /api/v1/models BEFORE the global JWT requireAuth — its own isolated plane.
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (!process.env.ROUTING_ENABLED) {
    return res.status(503).json({ error: { message: "Routing disabled" } });
  }

  // Accept the key from Authorization: Bearer <key> (OpenAI SDK) OR x-api-key
  // (Anthropic SDK / Claude Code default). Either header carries the sk-pf key.
  const xApiKey = req.header("x-api-key");
  const auth = req.headers.authorization;
  const token = xApiKey?.trim() || (auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "");
  if (!token) {
    return res.status(401).json({ error: { message: "Missing API key" } });
  }
  const keyHash = createHash("sha256").update(token).digest("hex");

  const key = await prisma.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, userId: true, status: true },
  });
  if (!key || key.status !== "ACTIVE") {
    return res.status(401).json({ error: { message: "Invalid API key" } });
  }

  (req as any).routerUserId = key.userId;
  (req as any).routerApiKeyId = key.id;

  // fire-and-forget last-used stamp; never block the request on it.
  prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return next();
}
