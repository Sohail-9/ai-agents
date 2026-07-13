import { Router } from "express";
import { paymentService } from "../services/paymentService";
import { PlanType, PaymentStatus } from "../../generated/prisma";
import { prisma } from "../lib/prisma";
const router = Router();
const PAYMENT_SERVICE_URL =
  process.env.PAYMENT_SERVICE_URL || "http://localhost:8081";

// Map provider/planId to PlanType enum and cost
export const PLAN_ENUM_MAP: Record<
  string,
  Record<
    string,
    {
      type: PlanType;
      data: {
        id: string;
        cost: number;
      };
    }
  >
> = {
  dodo: {
    STANDARD: {
      type: "STANDARD",
      data: {
        id: process.env.PLAN_STANDARD!,
        cost: 2499,
      },
    },
    PRO: {
      type: "PRO",
      data: {
        id: process.env.PLAN_PRO!,
        cost: 5499,
      },
    },
  },
};

// Create a new payment checkout
router.post("/", async (req, res) => {
  const ClerkId = res.locals.userId as string | undefined;
  if (!ClerkId) return res.status(401).json({ error: "Unauthorized" });

  // Ensure user exists (create if webhook hasn't synced yet)
  let userId: string;
  try {
    const existingUser = await prisma.user.findUnique({
      where: { clerkId: ClerkId },
    });

    if (!existingUser) {
      const newUser = await prisma.user.create({
        data: {
          clerkId: ClerkId,
          email: "",
          name: "User",
        },
      });
      userId = newUser.id;
      console.log(`Created user for clerkId ${ClerkId} with id ${userId}`);
    } else {
      userId = existingUser.id;
    }
  } catch (err) {
    console.error("Failed to ensure user exists:", err);
    return res.status(500).json({ error: "Failed to create user account" });
  }

  try {
    const {
      idempotencyKey,
      provider = "dodo",
      paymentPlan,
      metadata,
    } = req.body;

    if (!idempotencyKey) {
      return res.status(400).json({
        error: "Missing required fields: idempotencyKey",
      });
    }

    // Check if payment already exists for this idempotencyKey
    const existingPayment = await prisma.payment.findUnique({
      where: { idempotencyKey },
    });

    if (existingPayment) {
      console.log(
        `[PaymentRoute] Idempotent request: returning existing payment ${existingPayment.id}`,
      );
      return res.json({
        paymentId: existingPayment.id,
        transactionId: existingPayment.transactionId,
        status: existingPayment.status,
      });
    }

    // Map planId to PlanType enum and get cost
    const planId = PLAN_ENUM_MAP["dodo"][paymentPlan].data.id;

    // Create payment without transactionId (will be filled in later)
    const addPayment = await prisma.payment.create({
      data: {
        userId: ClerkId,
        planId: paymentPlan,
        idempotencyKey,
        transactionId: null,
        cost: PLAN_ENUM_MAP["dodo"][paymentPlan].data.cost,
        currency: "USD",
        status: "PENDING",
        paymentMethodId: PLAN_ENUM_MAP["dodo"][paymentPlan].data.id,
      },
    });
    console.log(
      `[PaymentRoute] Created payment ${addPayment.id} with idempotencyKey: ${idempotencyKey}`,
    );

    // Call payment service to initiate payment
    const payemntServiceUrl = `${PAYMENT_SERVICE_URL}/payment/checkout-session`;
    const paymentServiceResponse = await fetch(payemntServiceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planId: planId,
        userId: userId,
        idempotencyKey,
        provider,
        metadata,
      }),
    });

    if (!paymentServiceResponse.ok) {
      const error = await paymentServiceResponse.json();
      console.error(`[PaymentRoute] Payment service error: ${error.error}`);
      return res.status(paymentServiceResponse.status).json(error);
    }

    const paymentData = await paymentServiceResponse.json();
    const transactionId = paymentData.sessionId || paymentData.transactionId;
    console.log(
      `[PaymentRoute] Payment service returned transactionId: ${transactionId}`,
    );

    // Update payment record with transactionId from payment service
    if (transactionId) {
      await prisma.payment.update({
        where: { id: addPayment.id },
        data: { transactionId },
      });
      console.log(
        `[PaymentRoute] Updated payment ${addPayment.id} with transactionId: ${transactionId}`,
      );
    }

    res.json({
      ...paymentData,
      paymentId: addPayment.id,
      transactionId,
    });
  } catch (err: any) {
    if (err.code === "P2002") {
      const constraint = err.meta?.target?.[0];
      if (constraint === "idempotencyKey") {
        console.log(
          "[PaymentRoute] Idempotency key collision detected, retrying lookup",
        );
        const existingPayment = await prisma.payment.findUnique({
          where: { idempotencyKey: req.body.idempotencyKey },
        });
        if (existingPayment) {
          return res.json({
            paymentId: existingPayment.id,
            transactionId: existingPayment.transactionId,
            status: existingPayment.status,
          });
        }
      } else if (constraint === "transactionId") {
        console.error(
          "[PaymentRoute] Duplicate transactionId (payment service idempotency issue)",
        );
        return res
          .status(409)
          .json({ error: "Payment with this transaction already exists" });
      }
    }
    console.error(
      "[PaymentRoute] POST /payments failed:",
      err.message,
      err.code,
    );
    return res.status(500).json({ error: "Failed to create payment" });
  }
});

// Get payment by ID
router.get("/:id", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payment = await paymentService.getPayment(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Verify ownership (payment.userId stores clerkId)
    if (payment.userId !== clerkId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(payment);
  } catch (err: any) {
    console.error("[PaymentRoute] GET /:id failed:", err.message);
    return res.status(500).json({ error: "Failed to get payment" });
  }
});

// Get user's payments
router.get("/", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const payments = await paymentService.getPaymentsByUserId(clerkId, limit);

    return res.json({
      payments,
      total: payments.length,
    });
  } catch (err: any) {
    console.error("[PaymentRoute] GET / failed:", err.message);
    return res.status(500).json({ error: "Failed to get payments" });
  }
});

// Get payment by transaction ID
router.get("/transaction/:transactionId", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payment = await paymentService.getPaymentByTransactionId(
      req.params.transactionId,
    );

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Verify ownership (payment.userId stores clerkId)
    if (payment.userId !== clerkId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(payment);
  } catch (err: any) {
    console.error("[PaymentRoute] GET /transaction/:id failed:", err.message);
    return res.status(500).json({ error: "Failed to get payment" });
  }
});

// Update payment status
router.put("/:id/status", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { status } = req.body;

    if (!status || !Object.values(PaymentStatus).includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${Object.values(PaymentStatus).join(", ")}`,
      });
    }

    // Verify ownership first
    const payment = await paymentService.getPayment(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    if (payment.userId !== clerkId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updatedPayment = await paymentService.updatePaymentStatus(
      req.params.id,
      status,
    );

    return res.json(updatedPayment);
  } catch (err: any) {
    console.error("[PaymentRoute] PUT /:id/status failed:", err.message);
    return res.status(500).json({ error: "Failed to update payment" });
  }
});

// Update payment status by transaction ID (from payment redirect)
router.put("/update-by-transaction", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { transactionId, success } = req.body;

    if (!transactionId || success === undefined) {
      return res.status(400).json({
        error: "Missing required fields: transactionId, success",
      });
    }

    console.log(
      `[PaymentRoute] Looking up payment by transactionId: ${transactionId}`,
    );
    const payment =
      await paymentService.getPaymentByTransactionId(transactionId);

    if (!payment) {
      console.error(
        `[PaymentRoute] Payment not found for transactionId: ${transactionId}`,
      );
      return res.status(404).json({ error: "Payment not found" });
    }
    console.log(
      `[PaymentRoute] Found payment: ${payment.id} for transactionId: ${transactionId}`,
    );

    // Verify ownership (payment.userId stores clerkId)
    if (payment.userId !== clerkId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const status = success ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;

    // Return early if already updated to target status
    if (payment.status === status) {
      console.log(`Payment ${payment.id} already has status ${status}`);
      return res.json(payment);
    }

    console.log(`Updating payment ${payment.id} to status ${status}`);

    const updatedPayment = await paymentService.updatePaymentStatus(
      payment.id,
      status,
    );

    console.log(`Updated payment:`, updatedPayment);

    // Add credits if payment successful
    if (success) {
      const creditsMap: Record<string, number> = {
        STANDARD: 10000,
        PRO: 50000,
      };

      const creditsToAdd = creditsMap[payment.planId] || 0;
      console.log(`Plan: ${payment.planId}, Credits to add: ${creditsToAdd}`);

      if (creditsToAdd > 0) {
        const existingCredits = await prisma.userCredits.findUnique({
          where: { userId: payment.userId },
        });
        console.log(`Existing credits for ${payment.userId}:`, existingCredits);

        const updatedCredits = await prisma.userCredits.upsert({
          where: { userId: payment.userId },
          update: { credits: { increment: creditsToAdd } },
          create: { userId: payment.userId, credits: creditsToAdd },
        });

        console.log(`Updated credits:`, updatedCredits);
      }
    }

    return res.json(updatedPayment);
  } catch (err: any) {
    console.error(
      "[PaymentRoute] PUT /update-by-transaction failed:",
      err.message,
    );
    return res.status(500).json({ error: "Failed to update payment" });
  }
});

// Get latest successful payment
router.get("/latest/successful", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payment = await paymentService.getLatestSuccessfulPayment(clerkId);

    if (!payment) {
      return res.status(404).json({ error: "No successful payments found" });
    }

    return res.json(payment);
  } catch (err: any) {
    console.error("[PaymentRoute] GET /latest/successful failed:", err.message);
    return res.status(500).json({ error: "Failed to get payment" });
  }
});

// Refund payment
router.post("/:id/refund", async (req, res) => {
  const clerkId = res.locals.userId as string | undefined;
  if (!clerkId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Verify ownership
    const payment = await paymentService.getPayment(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }
    if (payment.userId !== clerkId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const refundedPayment = await paymentService.refundPayment(req.params.id);

    return res.json(refundedPayment);
  } catch (err: any) {
    console.error("[PaymentRoute] POST /:id/refund failed:", err.message);
    return res.status(500).json({ error: "Failed to refund payment" });
  }
});

export default router;
