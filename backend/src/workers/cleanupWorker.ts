import "../env";
import { prisma } from "../lib/prisma";

/**
 * Cleanup job: Release reserved credits that expired after 24 hours.
 *
 * Runs hourly via Node setInterval (can be migrated to BullMQ/Cron later).
 * If agent crashes after reserve() but before finalize(), reserved credits
 * would be stuck forever. This releases them after 24h timeout, preventing
 * users from being permanently locked out.
 */
async function cleanupExpiredReserves(): Promise<void> {
  try {
    const now = new Date();
    const result = await prisma.userCredits.updateMany({
      where: {
        reservedExpiresAt: { lte: now },
        reservedCredits: { gt: 0 },
      },
      data: {
        reservedCredits: 0,
        reservedExpiresAt: null,
      },
    });

    if (result.count > 0) {
      console.log(
        `[CleanupWorker] Released expired reserves for ${result.count} user(s)`,
      );
    }
  } catch (err: any) {
    console.error("[CleanupWorker] Cleanup failed:", err.message);
  }
}

/**
 * Start cleanup loop: runs every hour (3600000ms).
 * Safe to call multiple times — only one instance should run in production.
 */
export function startCleanupLoop(): void {
  // Run immediately on startup
  cleanupExpiredReserves().catch((err: any) =>
    console.error("[CleanupWorker] Initial cleanup failed:", err.message),
  );

  // Then run every hour
  const intervalId = setInterval(() => {
    cleanupExpiredReserves().catch((err: any) =>
      console.error("[CleanupWorker] Scheduled cleanup failed:", err.message),
    );
  }, 60 * 60 * 1000); // 1 hour

  // Allow graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[CleanupWorker] SIGTERM received, stopping cleanup loop");
    clearInterval(intervalId);
  });

  console.log("[CleanupWorker] Started (releases expired reserves every hour)");
}
