import { prisma } from '../lib/prisma';
import { SupportCaseStatus, SupportMessageRole } from '../../generated/prisma';

export const supportCaseService = {
  createCase: async (userId: string, initialMessage: string, workspaceId?: string) => {
    try {
      const title = initialMessage.slice(0, 60).trim();
      return await prisma.supportCase.create({
        data: {
          userId,
          workspaceId: workspaceId || null,
          title,
          messages: {
            create: {
              role: SupportMessageRole.USER,
              content: initialMessage,
            },
          },
        },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          workspace: { select: { id: true, name: true } },
        },
      });
    } catch (error) {
      console.error('[SupportCaseService] createCase failed:', error);
      throw error;
    }
  },

  getCasesByUser: async (userId: string, status?: SupportCaseStatus) => {
    try {
      return await prisma.supportCase.findMany({
        where: { userId, ...(status ? { status } : {}) },
        orderBy: { updatedAt: 'desc' },
        include: {
          workspace: { select: { id: true, name: true } },
          _count: { select: { messages: true } },
        },
      });
    } catch (error) {
      console.error('[SupportCaseService] getCasesByUser failed:', error);
      throw error;
    }
  },

  getCaseById: async (caseId: string, userId: string) => {
    try {
      const supportCase = await prisma.supportCase.findUnique({
        where: { id: caseId },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          workspace: { select: { id: true, name: true } },
        },
      });
      if (!supportCase) return null;
      if (supportCase.userId !== userId) {
        const err = new Error('Forbidden');
        (err as any).status = 403;
        throw err;
      }
      return supportCase;
    } catch (error) {
      console.error('[SupportCaseService] getCaseById failed:', error);
      throw error;
    }
  },

  addMessage: async (caseId: string, role: SupportMessageRole, content: string, toolCalls?: unknown) => {
    try {
      const message = await prisma.supportMessage.create({
        data: { caseId, role, content, toolCalls: toolCalls as any },
      });
      await prisma.supportCase.update({
        where: { id: caseId },
        data: { updatedAt: new Date() },
      });
      return message;
    } catch (error) {
      console.error('[SupportCaseService] addMessage failed:', error);
      throw error;
    }
  },

  updateStatus: async (
    caseId: string,
    status: SupportCaseStatus,
    extras?: { resolution?: string; escalationNote?: string; priority?: string },
  ) => {
    try {
      return await prisma.supportCase.update({
        where: { id: caseId },
        data: {
          status,
          ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
          ...(status === 'ESCALATED' ? { escalatedAt: new Date() } : {}),
          ...(extras?.resolution ? { resolution: extras.resolution } : {}),
          ...(extras?.escalationNote ? { escalationNote: extras.escalationNote } : {}),
          ...(extras?.priority ? { priority: extras.priority as any } : {}),
        },
      });
    } catch (error) {
      console.error('[SupportCaseService] updateStatus failed:', error);
      throw error;
    }
  },

  rateCase: async (caseId: string, rating: 1 | -1) => {
    try {
      return await prisma.supportCase.update({
        where: { id: caseId },
        data: { userRating: rating },
      });
    } catch (error) {
      console.error('[SupportCaseService] rateCase failed:', error);
      throw error;
    }
  },

  closeCase: async (caseId: string) => {
    try {
      return await prisma.supportCase.update({
        where: { id: caseId },
        data: { status: 'CLOSED' },
      });
    } catch (error) {
      console.error('[SupportCaseService] closeCase failed:', error);
      throw error;
    }
  },

  getOpenCaseCount: async (userId: string) => {
    try {
      return await prisma.supportCase.count({
        where: { userId, status: { in: ['OPEN', 'ESCALATED'] } },
      });
    } catch (error) {
      console.error('[SupportCaseService] getOpenCaseCount failed:', error);
      throw error;
    }
  },

  markEmailSent: async (caseId: string) => {
    try {
      return await prisma.supportCase.update({
        where: { id: caseId },
        data: { emailSentAt: new Date() },
      });
    } catch (error) {
      console.error('[SupportCaseService] markEmailSent failed:', error);
      throw error;
    }
  },
};
