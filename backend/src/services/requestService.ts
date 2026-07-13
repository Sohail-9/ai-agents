import { prisma } from '../lib/prisma';

export const requestService = {
  // Create a new request
  createRequest: async (requestData: {
    sessionId: string;
    requestId: string;
    userId: string;
    originalMessage: string;
    state: 'INIT' | 'NEEDS_CLARIFICATION' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'RUNNING' | 'COMPLETED';
    workspaceId?: string;
  }) => {
    const { sessionId, requestId, userId, originalMessage, state, workspaceId } = requestData;
    
    try {
      // Ensure the user exists before creating the request
      await prisma.user.upsert({
        where: { clerkId: userId },
        update: {},
        create: {
          clerkId: userId,
          name: userId.startsWith('anonymous') ? 'Anonymous User' : userId, // Use more descriptive name for anonymous users
        },
      });
      
      // Use upsert to handle potential duplicates - create if not exists, update if exists
      return await prisma.request.upsert({
        where: {
          userId_requestId: { // Use the composite unique key name
            userId,
            requestId
          }
        },
        update: {
          sessionId,
          originalMessage,
          state,
          workspaceId,
          updatedAt: new Date() // Update the timestamp
        },
        create: {
          sessionId,
          requestId,
          userId,
          originalMessage,
          state,
          workspaceId,
        },
      });
    } catch (error) {
      console.error('[Prisma] createRequest failed:', error);
      throw error; // Re-throw to let the caller handle it appropriately
    }
  },

  // Update request state
  updateState: async (updateData: {
    requestId: string;
    state: 'INIT' | 'NEEDS_CLARIFICATION' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'RUNNING' | 'COMPLETED';
    answers?: any;
    resolvedIntent?: {
      summary: string;
      structured: any;
    };
  }) => {
    const { requestId, state, answers, resolvedIntent } = updateData;
    
    try {
      const existing = await prisma.request.findFirst({
        where: { requestId },
      });

      if (!existing) {
        return null;
      }

      return await prisma.request.update({
        where: { id: existing.id },
        data: {
          state,
          answers,
          resolvedIntent,
        },
      });
    } catch (error) {
      console.error('[Prisma] updateState failed:', error);
      throw error;
    }
  },

  // Get request by requestId
  getByRequestId: async (requestId: string) => {
    try {
      return await prisma.request.findFirst({
        where: { requestId },
      });
    } catch (error) {
      console.error('[Prisma] getByRequestId failed:', error);
      throw error;
    }
  },
};