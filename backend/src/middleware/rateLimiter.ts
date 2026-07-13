import { Request, Response, NextFunction } from "express";
import { redisConnection } from "../queue/connection";

// Rate limiting for the /api/v1 inference plane. Mounted AFTER apiKeyAuth
// (needs req.routerApiKeyId / req.routerUserId), BEFORE the route handler.
// All Redis keys prefixed `rl:` — never overlaps BullMQ (`bull:`) or other keys.
// Fail-OPEN on Redis errors (matches lib/deployRateLimit.ts): a transient cache
// blip must not take the API down.

const RPM_LIMIT = parseInt(process.env.ROUTER_RPM_LIMIT ?? "1000", 10) || 1000;
const WINDOW_MS = 60_000;

// Sliding-window counter in one atomic round-trip: drop entries older than the
// window, count what's left, and (only if under limit) add this request.
// Returns the post-add count when allowed, or -1 when the limit is hit.
const RPM_LUA = `
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return count + 1
end
return -1
`;

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const apiKeyId = (req as any).routerApiKeyId as string | undefined;
  const userId = (req as any).routerUserId as string | undefined;
  if (!apiKeyId || !userId || !process.env.REDIS_URL?.trim()) return next();

  const now = Date.now();

  try {
    // ── CHECK 1: per-key sliding-window RPM ──────────────────────────────
    const member = `${now}-${Math.random().toString(36).slice(2)}`; // unique zset member
    const rpm = (await redisConnection.eval(
      RPM_LUA, 1, `rl:rpm:${apiKeyId}`,
      String(now), String(WINDOW_MS), String(RPM_LIMIT), member,
    )) as number;

    if (rpm === -1) {
      const resetSec = Math.ceil((now + WINDOW_MS) / 1000);
      res.setHeader("X-RateLimit-Limit", RPM_LIMIT);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("X-RateLimit-Reset", resetSec);
      res.setHeader("Retry-After", 60);
      return res.status(429).json({ error: { message: "rate limit exceeded (requests per minute)" } });
    }

    // ── Allowed: surface the per-minute budget ───────────────────────────
    res.setHeader("X-RateLimit-Limit", RPM_LIMIT);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, RPM_LIMIT - rpm));
    res.setHeader("X-RateLimit-Reset", Math.ceil((now + WINDOW_MS) / 1000));
    return next();
  } catch (e: any) {
    console.warn("[rateLimiter] Redis error; allowing request (fail-open):", e?.message || e);
    return next();
  }
}
