import "../env";
import { redisConnection } from "../queue/connection";

/**
 * Per-workspace deploy rate limit (rolling window).
 * Requires REDIS_URL. On Redis errors, allows the request (fail-open) so deploy is not blocked by transient cache issues.
 */
export async function checkWorkspaceDeployRateLimit(workspaceId: string): Promise<{
  allowed: boolean;
  retryAfterSeconds?: number;
}> {
  if (process.env.DEPLOY_RATE_LIMIT_ENABLED === "false") {
    return { allowed: true };
  }

  if (!process.env.REDIS_URL?.trim()) {
    return { allowed: true };
  }

  const max = parseInt(process.env.DEPLOY_RATE_LIMIT_PER_WORKSPACE || "5", 10);
  const windowSec = parseInt(process.env.DEPLOY_RATE_LIMIT_WINDOW_SECONDS || "3600", 10);

  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowSec) || windowSec <= 0) {
    return { allowed: true };
  }

  const key = `pf:deploy:rl:${workspaceId}`;

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
    console.warn(
      "[deployRateLimit] Redis error; allowing deploy (fail-open):",
      e?.message || e,
    );
    return { allowed: true };
  }
}
