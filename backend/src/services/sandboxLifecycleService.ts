/**
 * sandboxLifecycleService.ts
 *
 * Idle E2B sandboxes burn money. This service tracks sandbox status in Redis
 * so we can pause idle ones (saving cost) and wake them on demand (preserving UX).
 *
 * Redis keys
 * ──────────
 *   sandbox:status:{workspaceId}     "running" | "paused" | "resuming" | "cold"
 *   sandbox:last_hit:{workspaceId}   unix-ms timestamp, TTL = IDLE_TTL_SEC
 *   sandbox:lock:wake:{workspaceId}  short-lived lock (60s) — prevents two
 *                                    callers from issuing concurrent Sandbox.connect()
 *
 * Lifecycle
 * ─────────
 *   1. setupWorker creates sandbox → markCreated()                     status=running
 *   2. user sends USER_REQUEST     → recordHit() refreshes TTL          status=running
 *   3. reaper finds expired TTL    → sleep()                            status=paused
 *   4. user sends USER_REQUEST     → wakeIfNeeded()                     status=resuming → running
 */

import IORedis from "ioredis";
import { redisConnection } from "../queue/connection";
import { Sandbox } from "@e2b/code-interpreter";

export type SandboxStatus = "running" | "paused" | "resuming" | "cold";

const IDLE_TTL_SEC = Number(process.env.SANDBOX_IDLE_TTL_SEC ?? 60 * 60); // 1 hour
const WAKE_LOCK_TTL_SEC = 60;
const WAKE_POLL_INTERVAL_MS = 250;
const WAKE_MAX_WAIT_MS = 30_000;

const statusKey   = (id: string) => `sandbox:status:${id}`;
const lastHitKey  = (id: string) => `sandbox:last_hit:${id}`;
const wakeLockKey = (id: string) => `sandbox:lock:wake:${id}`;

export interface WakeCallbacks {
  onResuming?: () => void | Promise<void>;
  onReady?:    () => void | Promise<void>;
}

class SandboxLifecycleServiceImpl {
  private redis: IORedis;

  constructor(redis: IORedis = redisConnection) {
    this.redis = redis;
  }

  /** Called from setupWorker after Sandbox.create succeeds. */
  async markCreated(workspaceId: string): Promise<void> {
    await Promise.all([
      this.redis.set(statusKey(workspaceId), "running"),
      this.redis.set(lastHitKey(workspaceId), String(Date.now()), "EX", IDLE_TTL_SEC),
    ]);
  }

  /** Refreshes the idle TTL; promotes status to "running" if it was unknown. */
  async recordHit(workspaceId: string): Promise<void> {
    await Promise.all([
      this.redis.set(lastHitKey(workspaceId), String(Date.now()), "EX", IDLE_TTL_SEC),
      this.redis.set(statusKey(workspaceId), "running"),
    ]);
  }

  async getStatus(workspaceId: string): Promise<SandboxStatus> {
    const s = (await this.redis.get(statusKey(workspaceId))) as SandboxStatus | null;
    return s ?? "cold";
  }

  /**
   * If the sandbox is paused/cold/resuming, resume it via Sandbox.connect.
   * Uses a Redis lock so concurrent USER_REQUESTs on the same workspace
   * don't issue two simultaneous connects. Other callers poll status.
   */
  async wakeIfNeeded(
    workspaceId: string,
    sandboxId: string,
    cb: WakeCallbacks = {},
  ): Promise<void> {
    const current = await this.getStatus(workspaceId);
    if (current === "running") {
      await this.recordHit(workspaceId);
      return;
    }

    // Try to acquire the wake lock.
    const gotLock = await this.redis.set(
      wakeLockKey(workspaceId),
      "1",
      "EX",
      WAKE_LOCK_TTL_SEC,
      "NX",
    );

    if (gotLock !== "OK") {
      // Someone else is already resuming — just wait for status=running.
      await this.waitForRunning(workspaceId);
      return;
    }

    try {
      await this.redis.set(statusKey(workspaceId), "resuming");
      await cb.onResuming?.();

      console.log(`[SandboxLifecycle] Resuming sandbox ${sandboxId} for workspace ${workspaceId}`);
      await Sandbox.connect(sandboxId);

      await Promise.all([
        this.redis.set(statusKey(workspaceId), "running"),
        this.redis.set(lastHitKey(workspaceId), String(Date.now()), "EX", IDLE_TTL_SEC),
      ]);
      await cb.onReady?.();
      console.log(`[SandboxLifecycle] Sandbox ${sandboxId} resumed for workspace ${workspaceId}`);
    } catch (err: any) {
      // On failure, mark cold so callers know the sandbox is gone.
      await this.redis.set(statusKey(workspaceId), "cold");
      throw new Error(`Failed to resume sandbox ${sandboxId}: ${err.message}`);
    } finally {
      await this.redis.del(wakeLockKey(workspaceId));
    }
  }

  /** Pause an idle sandbox. Used by reaper and the manual /sleep endpoint. */
  async sleep(workspaceId: string, sandboxId: string): Promise<void> {
    const current = await this.getStatus(workspaceId);
    if (current !== "running") {
      console.log(`[SandboxLifecycle] sleep skipped — workspace ${workspaceId} status=${current}`);
      return;
    }
    try {
      const sb = await Sandbox.connect(sandboxId);
      await sb.pause();
      await Promise.all([
        this.redis.set(statusKey(workspaceId), "paused"),
        this.redis.del(lastHitKey(workspaceId)),
      ]);
      console.log(`[SandboxLifecycle] Paused sandbox ${sandboxId} for workspace ${workspaceId}`);
    } catch (err: any) {
      // If the sandbox is already gone, mark cold and move on.
      await this.redis.set(statusKey(workspaceId), "cold");
      console.warn(`[SandboxLifecycle] sleep failed for ${sandboxId}: ${err.message}`);
    }
  }

  /**
   * Reaper: scans Redis for sandboxes with status=running but no last_hit
   * (TTL expired). Returns the list of candidates so the caller can
   * resolve sandboxIds from DB and call sleep().
   */
  async listIdleCandidates(): Promise<string[]> {
    const idle: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        "sandbox:status:*",
        "COUNT",
        500,
      );
      cursor = next;

      for (const statusK of keys) {
        const workspaceId = statusK.slice("sandbox:status:".length);
        const [status, lastHit] = await Promise.all([
          this.redis.get(statusK),
          this.redis.get(lastHitKey(workspaceId)),
        ]);
        if (status === "running" && !lastHit) idle.push(workspaceId);
      }
    } while (cursor !== "0");
    return idle;
  }

  /** Polls until status becomes "running" or timeout — used by callers that
   *  lost the wake lock to a sibling request. */
  private async waitForRunning(workspaceId: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < WAKE_MAX_WAIT_MS) {
      const s = await this.getStatus(workspaceId);
      if (s === "running") return;
      if (s === "cold") throw new Error("Sandbox is cold — cannot wait for resume");
      await new Promise((r) => setTimeout(r, WAKE_POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for sandbox to resume for workspace ${workspaceId}`);
  }
}

export const sandboxLifecycleService = new SandboxLifecycleServiceImpl();
export const SandboxLifecycleService = SandboxLifecycleServiceImpl;
