import { prisma } from '../lib/prisma';
import { PlanType, PaymentStatus } from '../../generated/prisma';

export const paymentService = {
  // Create a new payment
  createPayment: async (data: {
    userId: string;
    planId: PlanType;
    transactionId: string;
    cost: number;
    currency?: string;
    paymentMethodId?: string;
    metadata?: Record<string, any>;
  }) => {
    try {
      return await prisma.payment.create({
        data: {
          userId: data.userId,
          planId: data.planId,
          transactionId: data.transactionId,
          cost: data.cost,
          currency: data.currency || 'USD',
          paymentMethodId: data.paymentMethodId,
          metadata: data.metadata || {},
          status: PaymentStatus.PENDING,
        },
      });
    } catch (error) {
      console.error('[PaymentService] createPayment failed:', error);
      throw error;
    }
  },

  // Get payment by ID
  getPayment: async (paymentId: string) => {
    try {
      return await prisma.payment.findUnique({
        where: { id: paymentId },
      });
    } catch (error) {
      console.error('[PaymentService] getPayment failed:', error);
      throw error;
    }
  },

  // Get payment by transaction ID
  getPaymentByTransactionId: async (transactionId: string) => {
    try {
      return await prisma.payment.findUnique({
        where: { transactionId },
      });
    } catch (error) {
      console.error('[PaymentService] getPaymentByTransactionId failed:', error);
      throw error;
    }
  },

  // Get payments by user ID
  getPaymentsByUserId: async (userId: string, limit?: number) => {
    try {
      return await prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit || 50,
      });
    } catch (error) {
      console.error('[PaymentService] getPaymentsByUserId failed:', error);
      throw error;
    }
  },

  // Update payment status
  updatePaymentStatus: async (
    paymentId: string,
    status: PaymentStatus,
    completedAt?: Date,
  ) => {
    try {
      return await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status,
          completedAt: status === PaymentStatus.COMPLETED ? completedAt || new Date() : null,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('[PaymentService] updatePaymentStatus failed:', error);
      throw error;
    }
  },

  // Get latest successful payment for user
  getLatestSuccessfulPayment: async (userId: string) => {
    try {
      return await prisma.payment.findFirst({
        where: {
          userId,
          status: PaymentStatus.COMPLETED,
        },
        orderBy: { completedAt: 'desc' },
      });
    } catch (error) {
      console.error('[PaymentService] getLatestSuccessfulPayment failed:', error);
      throw error;
    }
  },

  // Get all successful payments for user
  getSuccessfulPayments: async (userId: string) => {
    try {
      return await prisma.payment.findMany({
        where: {
          userId,
          status: PaymentStatus.COMPLETED,
        },
        orderBy: { completedAt: 'desc' },
      });
    } catch (error) {
      console.error('[PaymentService] getSuccessfulPayments failed:', error);
      throw error;
    }
  },

  // Refund payment
  refundPayment: async (paymentId: string) => {
    try {
      return await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('[PaymentService] refundPayment failed:', error);
      throw error;
    }
  },
};
