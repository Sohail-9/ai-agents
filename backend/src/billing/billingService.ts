import { prisma } from "../lib/prisma";
import { UsageEntry } from "./types";
import { computeCredits } from "./normalizeUsage";
import { CREDIT_RESERVATION_BUFFER } from "./constants";

export const billingService = {
  async reserve(userId: string): Promise<boolean> {
    try {
      await prisma.$transaction(
        async (tx) => {
          const now = new Date();
          const credits = await tx.userCredits.upsert({
            where: { userId },
            update: {},
            create: {
              userId,
              credits: 0,
              reservedCredits: 0,
              reservedExpiresAt: null,
            },
          });

          // If cleanup worker isn't running (or missed a tick), expired reserves can
          // incorrectly block new work. Clear them inline before checking balance.
          let reservedCredits = credits.reservedCredits;
          if (
            credits.reservedCredits > 0 &&
            credits.reservedExpiresAt &&
            credits.reservedExpiresAt <= now
          ) {
            await tx.userCredits.update({
              where: { userId },
              data: { reservedCredits: 0, reservedExpiresAt: null },
            });
            reservedCredits = 0;
          }

          if (credits.credits - reservedCredits < CREDIT_RESERVATION_BUFFER) {
            throw new Error("INSUFFICIENT_CREDITS");
          }
          // Set expiryAt to 24h from now to prevent indefinite stuck reserves
          const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          await tx.userCredits.update({
            where: { userId },
            data: {
              reservedCredits: { increment: CREDIT_RESERVATION_BUFFER },
              reservedExpiresAt: expiresAt,
            },
          });
        },
        { isolationLevel: "Serializable" }
      );
      return true;
    } catch (err: any) {
      if (err.message === "INSUFFICIENT_CREDITS") return false;
      throw err;
    }
  },

  async finalize(
    userId: string,
    agentRunId: string,
    entries: UsageEntry[],
    reservedCredits: number,
  ): Promise<number> {
    // ── IDEMPOTENCY CHECK: Prevent double-charge on job retry ────────────────────
    // If ledger entry with this (userId, agentRunId) exists, finalize already ran.
    // Return early to avoid double-deduction.
    const existingLedger = await prisma.creditLedger.findUnique({
      where: { userId_agentRunId: { userId, agentRunId } },
    });
    if (existingLedger) {
      console.log(
        `[Billing] IDEMPOTENT: ${agentRunId} already finalized (delta=${existingLedger.delta}), skipping`,
      );
      // Return current balance for idempotent case
      const currentCredits = await prisma.userCredits.findUnique({
        where: { userId },
        select: { credits: true },
      });
      return currentCredits?.credits ?? 0;
    }

    // ── FETCH CURRENT BALANCE ──────────────────────────────────────────────────
    const credits = await prisma.userCredits.findUnique({
      where: { userId },
    });
    if (!credits) throw new Error("UserCredits not found during finalize");

    // ── CALCULATE DEDUCTION with CLAMPING ─────────────────────────────────────
    const creditsToDeduct = entries.length > 0 ? computeCredits(entries) : 0;
    // availableBalance = credits minus OTHER reserved (not this job's own reservation)
    // This job reserved CREDIT_RESERVATION_BUFFER, so don't double-subtract it
    const otherReserved = Math.max(0, credits.reservedCredits - CREDIT_RESERVATION_BUFFER);
    const availableBalance = Math.max(0, credits.credits - otherReserved);
    const actualDeduct = Math.min(creditsToDeduct, availableBalance);
    const wasCapped = actualDeduct < creditsToDeduct;

    // Determine ledger reason based on whether we capped the deduction
    const ledgerReason = wasCapped ? "agent_run_capped" : "agent_run";

    if (wasCapped) {
      console.warn(
        `[Billing] CAPPED: userId=${userId} needed=${creditsToDeduct} available=${availableBalance} deducting=${actualDeduct}`,
      );
    }

    // ── DEDUCT & RELEASE RESERVED ────────────────────────────────────────────────
    const updated = await prisma.$transaction(
      async (tx) => {
        const currentCredits = await tx.userCredits.findUnique({
          where: { userId },
          select: {
            credits: true,
            reservedCredits: true,
            reservedExpiresAt: true,
          },
        });
        if (!currentCredits) {
          throw new Error("UserCredits not found during finalize");
        }

        const reservedRelease = Math.min(
          Math.max(0, reservedCredits),
          Math.max(0, currentCredits.reservedCredits),
        );
        const remainingReserved = Math.max(
          0,
          currentCredits.reservedCredits - reservedRelease,
        );
        const reservedExpiresAt =
          remainingReserved === 0
            ? null
            : currentCredits.reservedExpiresAt ??
              new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Update credits
        const updatedCredits = await tx.userCredits.update({
          where: { userId },
          data: {
            reservedCredits: { decrement: reservedRelease },
            credits: { decrement: actualDeduct },
            reservedExpiresAt,
          },
          select: { credits: true },
        });
        // Create ledger entry
        await tx.creditLedger.create({
          data: {
            userId,
            delta: -actualDeduct,
            reason: ledgerReason,
            agentRunId,
          },
        });
        return updatedCredits;
      },
      { isolationLevel: "Serializable" }
    );

    const newBalance = updated.credits;
    console.log(
      `[Billing] FINALIZED: userId=${userId} agentRunId=${agentRunId} entries=${entries.length} totalTokens=${entries.reduce((sum, e) => sum + e.totalTokens, 0)} creditsDeducted=${actualDeduct} newBalance=${newBalance}`,
    );
    return newBalance;
  },

  async getCredits(userId: string) {
    return prisma.userCredits.findUnique({
      where: { userId },
      select: { credits: true, reservedCredits: true },
    });
  },
};
