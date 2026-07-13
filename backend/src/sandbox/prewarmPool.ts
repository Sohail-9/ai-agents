/**
 * Sandbox Pre-warming Pool
 * Maintains a pool of warm E2B sandboxes ready for immediate use.
 * Reduces sandbox creation latency (2-3s) to wake latency (~100ms).
 */

import { Sandbox } from "@e2b/code-interpreter";

export interface WarmSandbox {
  sandboxId: string;
  framework: string;
  createdAt: Date;
  status: "ready" | "in-use" | "expired";
}

const WARM_VM_COUNT = parseInt(process.env.WARM_VM || "2", 10);
const SANDBOX_TTL_MS = 30 * 60 * 1000; // 30 minutes before sandbox is retired

class PrewarmPool {
  private pool = new Map<string, WarmSandbox[]>();
  private maintenanceRunning = false;

  constructor() {
    this.initializeFrameworks();
  }

  private initializeFrameworks() {
    const frameworks = ["Next.js", "FastAPI", "Django", "Express"];
    for (const fw of frameworks) {
      this.pool.set(fw, []);
    }
  }

  /**
   * Get a warm sandbox, or create a new one if pool empty.
   */
  async getSandbox(framework: string = "Next.js"): Promise<string> {
    const pool = this.pool.get(framework) || [];

    // Find ready sandbox
    const ready = pool.find((s) => s.status === "ready");
    if (ready) {
      ready.status = "in-use";
      console.log(
        `[PrewarmPool] Using warm sandbox ${ready.sandboxId} (framework=${framework})`,
      );
      return ready.sandboxId;
    }

    // No warm sandbox; create new one
    console.log(
      `[PrewarmPool] No warm sandbox available for ${framework}, creating new...`,
    );
    return await this.createNewSandbox(framework);
  }

  /**
   * Release sandbox back to pool (called by agent after run completes).
   */
  releaseSandbox(sandboxId: string, framework: string) {
    const pool = this.pool.get(framework);
    if (!pool) return;

    const sandbox = pool.find((s) => s.sandboxId === sandboxId);
    if (sandbox) {
      sandbox.status = "ready";
      console.log(`[PrewarmPool] Sandbox ${sandboxId} released back to pool`);
    }
  }

  /**
   * Create a new E2B sandbox.
   */
  private async createNewSandbox(framework: string): Promise<string> {
    try {
      const t0 = Date.now();
      const sandbox = await Sandbox.create();
      console.log(
        `[PrewarmPool] Created new sandbox ${sandbox.sandboxId} in ${Date.now() - t0}ms`,
      );

      const pool = this.pool.get(framework) || [];
      pool.push({
        sandboxId: sandbox.sandboxId,
        framework,
        createdAt: new Date(),
        status: "in-use",
      });
      this.pool.set(framework, pool);

      return sandbox.sandboxId;
    } catch (err: any) {
      console.error(
        `[PrewarmPool] Failed to create sandbox: ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Maintenance task: keep pool topped up with warm sandboxes.
   * Run periodically (every 5 minutes).
   */
  async maintain() {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;

    try {
      for (const [framework, sandboxes] of this.pool) {
        // Clean expired sandboxes
        this.pool.set(
          framework,
          sandboxes.filter((s) => {
            if (s.status === "expired") return false;
            if (Date.now() - s.createdAt.getTime() > SANDBOX_TTL_MS) {
              console.log(
                `[PrewarmPool] Expired sandbox ${s.sandboxId} (age: ${Math.round((Date.now() - s.createdAt.getTime()) / 1000)}s)`,
              );
              return false;
            }
            return true;
          }),
        );

        // Top up to WARM_VM_COUNT
        const updated = this.pool.get(framework) || [];
        const readyAfterClean = updated.filter((s) => s.status === "ready")
          .length;
        const toCreate = Math.max(0, WARM_VM_COUNT - readyAfterClean);

        if (toCreate > 0) {
          console.log(
            `[PrewarmPool] Creating ${toCreate} warm sandboxes for ${framework}`,
          );
          for (let i = 0; i < toCreate; i++) {
            try {
              const sandboxId = await this.createNewSandbox(framework);
              const pool = this.pool.get(framework) || [];
              const idx = pool.findIndex((s) => s.sandboxId === sandboxId);
              if (idx >= 0) {
                pool[idx].status = "ready"; // Mark as ready since we just created it
              }
              this.pool.set(framework, pool);
            } catch (err: any) {
              console.warn(
                `[PrewarmPool] Failed to create warm sandbox: ${err.message}`,
              );
            }
          }
        }

        const finalReady = updated.filter((s) => s.status === "ready").length;
        console.log(
          `[PrewarmPool] ${framework}: ${finalReady}/${WARM_VM_COUNT} ready`,
        );
      }
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * Get pool stats for monitoring.
   */
  getStats() {
    const stats: Record<string, { ready: number; inUse: number; total: number }> = {};
    for (const [framework, sandboxes] of this.pool) {
      const ready = sandboxes.filter((s) => s.status === "ready").length;
      const inUse = sandboxes.filter((s) => s.status === "in-use").length;
      const total = sandboxes.filter((s) => s.status !== "expired").length;
      stats[framework] = { ready, inUse, total };
    }
    return stats;
  }
}

export const prewarmPool = new PrewarmPool();
