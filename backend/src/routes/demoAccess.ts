import { Router, Request, Response } from "express";
import { demoAccessService } from "../services";
import { redisConnection } from "../queue/connection";
import { prisma } from "../lib/prisma";

const router = Router();

async function checkClaimRateLimit(
  clerkUserId: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  if (!process.env.REDIS_URL?.trim()) {
    return { allowed: true };
  }

  const max = parseInt(process.env.DEMO_CLAIM_RATE_LIMIT_PER_USER || "10", 10);
  const windowSec = parseInt(process.env.DEMO_CLAIM_RATE_LIMIT_WINDOW_SECONDS || "3600", 10);

  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowSec) || windowSec <= 0) {
    return { allowed: true };
  }

  const key = `pf:demo:claim:rl:${clerkUserId}`;

  try {
    const n = await redisConnection.incr(key);
    if (n === 1) {
      await redisConnection.expire(key, windowSec);
    }
    if (n > max) {
      const ttl = await redisConnection.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSec };
    }
    return { allowed: true };
  } catch (e: any) {
    console.warn("[demoAccessRateLimit] Redis error; allowing claim (fail-open):", e?.message || e);
    return { allowed: true };
  }
}

// GET /api/demo-access/status
// Returns access status for logged-in user
router.get("/status", async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;

  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const status = await demoAccessService.getAccessStatus(clerkUserId);
    res.json(status);
  } catch (error) {
    console.error("[demoAccess] Status check error:", error);
    res.status(500).json({ error: "Failed to check access status" });
  }
});

// POST /api/demo-access/claim
// Claim a demo key with the provided access key
router.post("/claim", async (req: Request, res: Response) => {
  const clerkUserId = res.locals.userId as string | undefined;
  const { key } = req.body as { key?: string };

  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!key || typeof key !== "string") {
    return res.status(400).json({ error: "Invalid request: key is required" });
  }

  try {
    // Check rate limit
    const rateLimit = await checkClaimRateLimit(clerkUserId);
    if (!rateLimit.allowed) {
      return res
        .status(429)
        .json({
          error: "Too many claim attempts. Please try again later.",
          retryAfter: rateLimit.retryAfterSeconds,
        });
    }

    // Check if user already has access
    const currentAccess = await demoAccessService.getAccessStatus(clerkUserId);
    if (currentAccess.hasAccess) {
      return res.status(400).json({ error: "User already has demo access" });
    }

    // Verify user exists, create if needed before claiming to satisfy foreign key constraints
    const user = await prisma.user.findUnique({ where: { clerkId: clerkUserId } });

    if (!user) {
      // Create user record if it doesn't exist
      await prisma.user.create({ data: { clerkId: clerkUserId } });
    }

    // Verify UserCredits exists, create if needed
    const userCredits = await prisma.userCredits.findUnique({ where: { userId: clerkUserId } });

    if (!userCredits) {
      await prisma.userCredits.create({ data: { userId: clerkUserId } });
    }

    // Attempt to claim key
    const claimed = await demoAccessService.claimKey(key, clerkUserId);
    res.json({ success: true, message: "Demo access granted", demoKey: claimed });
  } catch (error: any) {
    console.error("[demoAccess] Claim error:", error);

    // Return appropriate error based on the error message
    if (error.message === "Invalid demo access key") {
      return res.status(400).json({ error: "Invalid demo access key" });
    }

    if (error.message === "Demo key is no longer available") {
      return res
        .status(400)
        .json({ error: "This demo access key has already been claimed or revoked" });
    }

    res.status(500).json({ error: "Failed to claim demo access" });
  }
});

// Admin authentication
const isAdmin = (req: Request): boolean => {
  const adminToken = req.headers["x-admin-token"] as string | undefined;
  const expectedToken = btoa(`${process.env.DEMO_ADMIN_EMAIL}:${process.env.DEMO_ADMIN_PASSWORD}`);
  return adminToken === expectedToken;
};

// POST /api/demo-access/admin/login
// Authenticate admin with email and password
router.post("/admin/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const adminEmail = process.env.DEMO_ADMIN_EMAIL;
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    return res.status(500).json({ error: "Admin credentials not configured" });
  }

  if (email === adminEmail && password === adminPassword) {
    const token = btoa(`${adminEmail}:${adminPassword}`);
    return res.json({ token, message: "Login successful" });
  }

  res.status(401).json({ error: "Invalid credentials" });
});

// POST /api/demo-access/admin/generate
// Generate a single demo key
router.post("/admin/generate", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const key = await demoAccessService.generateKey();
    res.json(key);
  } catch (error) {
    console.error("[demoAccess] Generate key error:", error);
    res.status(500).json({ error: "Failed to generate demo key" });
  }
});

// POST /api/demo-access/admin/generate-bulk
// Generate bulk demo keys
router.post("/admin/generate-bulk", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const { count } = req.body as { count?: number };

  if (!count || typeof count !== "number" || count <= 0 || count > 1000) {
    return res.status(400).json({ error: "Invalid count: must be between 1 and 1000" });
  }

  try {
    const result = await demoAccessService.generateBulkKeys(count);
    res.json({ created: result.count, message: `Generated ${result.count} demo access keys` });
  } catch (error) {
    console.error("[demoAccess] Bulk generate error:", error);
    res.status(500).json({ error: "Failed to generate demo keys" });
  }
});

// GET /api/demo-access/admin/list
// List all keys with optional filters
router.get("/admin/list", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const { status, claimed } = req.query as { status?: string; claimed?: string };

  try {
    const filter: any = {};
    if (status && ["UNCLAIMED", "CLAIMED", "REVOKED"].includes(status)) {
      filter.status = status;
    }
    if (claimed) {
      filter.claimed = claimed === "true";
    }

    const keys = await demoAccessService.listKeys(filter);
    res.json(keys);
  } catch (error) {
    console.error("[demoAccess] List keys error:", error);
    res.status(500).json({ error: "Failed to list demo keys" });
  }
});

// DELETE /api/demo-access/admin/:id
// Delete a specific demo key
router.delete("/admin/:id", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    await demoAccessService.deleteKey(id);
    res.json({ message: "Demo key deleted" });
  } catch (error: any) {
    console.error("[demoAccess] Delete key error:", error);
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Demo key not found" });
    }
    res.status(500).json({ error: "Failed to delete demo key" });
  }
});

// GET /api/demo-access/admin/stats
// Get statistics about demo keys
router.get("/admin/stats", async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const stats = await demoAccessService.getKeyStats();
    res.json(stats);
  } catch (error) {
    console.error("[demoAccess] Stats error:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

export default router;
