/**
 * sandboxPrewarmService.ts
 *
 * Pure Redis state for the pre-warm sandbox pool.
 * E2B calls (Sandbox.create / Sandbox.kill) live in the prewarm worker
 * so this service can be unit-tested without touching real cloud resources.
 *
 * Pool design
 * ───────────
 *   warm:pool:{framework}    ZSET
 *      member = sandboxId
 *      score  = createdAt (unix ms)
 *
 *   ZADD on release, ZPOPMIN on acquire (oldest first, so the freshest
 *   sandboxes stay in the pool the longest).
 *
 *   Eviction picks members with score < now - maxAgeMs.
 *
 * Concurrency
 * ───────────
 *   ZPOPMIN is atomic. Two callers that race will get distinct members
 *   (or one gets null). No external lock needed.
 *
 *   The worker that calls `release` should be a singleton to avoid
 *   double-provisioning the same pool, but multiple consumers calling
 *   `acquire` is safe.
 */

import IORedis from "ioredis";
import { redisConnection } from "../queue/connection";

const poolKey = (framework: string) => `warm:pool:${framework}`;

export class SandboxPrewarmServiceImpl {
  private redis: IORedis;

  constructor(redis: IORedis = redisConnection) {
    this.redis = redis;
  }

  /**
   * Pop the oldest sandboxId off the pool, or null if empty.
   * Atomic. Two simultaneous callers will get different IDs (or one null).
   */
  async acquire(framework: string): Promise<string | null> {
    // zpopmin returns [member, score] as a flat array, or [] if empty.
    const res = await this.redis.zpopmin(poolKey(framework), 1);
    if (!res || res.length === 0) return null;
    const [sandboxId] = res;
    return sandboxId ?? null;
  }

  /**
   * Add a freshly-created sandboxId to the pool, scored by creation time.
   * Idempotent: if the same id is released twice, the score is just updated.
   */
  async release(framework: string, sandboxId: string, createdAtMs = Date.now()): Promise<void> {
    await this.redis.zadd(poolKey(framework), createdAtMs, sandboxId);
  }

  /** Current pool size for a framework. */
  async size(framework: string): Promise<number> {
    return this.redis.zcard(poolKey(framework));
  }

  /**
   * Return sandboxIds older than maxAgeMs (score = createdAt < now - maxAgeMs).
   * Caller is expected to kill them in E2B and then call `evict()` to remove.
   */
  async listExpired(framework: string, maxAgeMs: number): Promise<string[]> {
    const cutoff = Date.now() - maxAgeMs;
    return this.redis.zrangebyscore(poolKey(framework), "-inf", cutoff);
  }

  /** Remove specific sandboxIds from the pool. */
  async evict(framework: string, sandboxIds: string[]): Promise<number> {
    if (sandboxIds.length === 0) return 0;
    return this.redis.zrem(poolKey(framework), ...sandboxIds);
  }

  /** Drain the whole pool — used for shutdown / tests. */
  async drain(framework: string): Promise<string[]> {
    const all = await this.redis.zrange(poolKey(framework), 0, -1);
    if (all.length > 0) await this.redis.del(poolKey(framework));
    return all;
  }

  /** All sandboxIds currently in the pool, oldest first. Read-only. */
  async list(framework: string): Promise<string[]> {
    return this.redis.zrange(poolKey(framework), 0, -1);
  }
}

export const sandboxPrewarmService = new SandboxPrewarmServiceImpl();
export const SandboxPrewarmService = SandboxPrewarmServiceImpl;
