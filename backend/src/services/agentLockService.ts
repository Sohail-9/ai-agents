/**
 * agentLockService.ts
 *
 * Distributed mutex enforcing "one agent run per workspace at a time"
 * across all API + worker processes (PM2 cluster, multiple replicas).
 *
 * Replaces the old `agent-${workspaceId}` BullMQ jobId pattern, which
 * silently deduplicated subsequent enqueues — meaning a user's second
 * message during an active run was being dropped instead of queued.
 *
 * Implementation
 * ──────────────
 *   key   : lock:agent:{workspaceId}
 *   value : ownerKey (the unique jobId issued by generateJobId())
 *   TTL   : DEFAULT_TTL_SEC (1h) — safety net if a worker crashes
 *
 *   acquire: SET key owner EX 3600 NX     (atomic)
 *   release: Lua compare-and-delete       (atomic, owner-safe)
 *
 * The acquire+release pair is owner-keyed so a worker can only release
 * the lock it actually holds. This is the standard Redlock single-node
 * pattern (good enough for our single-Redis topology).
 */

import IORedis from "ioredis";
import { redisConnection } from "../queue/connection";
import { randomBytes } from "crypto";

const lockKey = (workspaceId: string) => `lock:agent:${workspaceId}`;
const DEFAULT_TTL_SEC = 60 * 60; // 1 hour

// KEYS[1] = lock key, ARGV[1] = expected owner
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export type AcquireResult =
  | { acquired: true;  ownerKey: string }
  | { acquired: false; currentOwner: string | null };

export class AgentLockServiceImpl {
  private redis: IORedis;

  constructor(redis: IORedis = redisConnection) {
    this.redis = redis;
  }

  /** Generate a unique BullMQ jobId for this workspace. Also serves as the lock owner key. */
  generateJobId(workspaceId: string): string {
    return `agent-${workspaceId}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Try to acquire the lock. Atomic.
   * On success: { acquired: true, ownerKey } — pass ownerKey as the BullMQ jobId.
   * On failure: { acquired: false, currentOwner } — caller should not enqueue.
   */
  async acquire(
    workspaceId: string,
    ownerKey: string,
    ttlSec: number = DEFAULT_TTL_SEC,
  ): Promise<AcquireResult> {
    const res = await this.redis.set(lockKey(workspaceId), ownerKey, "EX", ttlSec, "NX");
    if (res === "OK") return { acquired: true, ownerKey };
    const currentOwner = await this.redis.get(lockKey(workspaceId));
    return { acquired: false, currentOwner };
  }

  /** Release the lock — only succeeds if ownerKey matches the stored value. */
  async release(workspaceId: string, ownerKey: string): Promise<boolean> {
    const result = (await this.redis.eval(
      RELEASE_LUA,
      1,
      lockKey(workspaceId),
      ownerKey,
    )) as number;
    return result === 1;
  }

  async isLocked(workspaceId: string): Promise<boolean> {
    return (await this.redis.exists(lockKey(workspaceId))) === 1;
  }

  async getOwner(workspaceId: string): Promise<string | null> {
    return this.redis.get(lockKey(workspaceId));
  }

  /** Break-glass: drop the lock regardless of owner. For ops / manual recovery. */
  async forceRelease(workspaceId: string): Promise<boolean> {
    return (await this.redis.del(lockKey(workspaceId))) === 1;
  }
}

export const agentLockService = new AgentLockServiceImpl();
export const AgentLockService = AgentLockServiceImpl;
