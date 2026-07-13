import { prisma } from '../lib/prisma';
import { MessageRole } from '../../generated/prisma';
import { imageService } from './imageService';
import { redactSensitive, redactSensitiveJson } from '../security/piiGuard';

export const messageService = {
  // Create a message
  createMessage: async (messageData: {
    sessionId?: string | null;
    role: MessageRole | 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    requestId?: string;
    workspaceId?: string;
    toolCalls?: any;
    toolCallId?: string;
    toolName?: string;
  }) => {
    const { sessionId, role, content, requestId, workspaceId, toolCalls, toolCallId, toolName } = messageData;

    try {
      // Redact sensitive data before storing
      const safeContent = redactSensitive(content);
      const safeToolCalls = toolCalls ? redactSensitiveJson(toolCalls) : undefined;

      return await prisma.message.create({
        data: {
          sessionId: sessionId ?? null,
          role: role as MessageRole,
          content: safeContent,
          requestId,
          workspaceId,
          toolCalls: safeToolCalls,
          toolCallId,
          toolName,
        },
      });
    } catch (error) {
      console.error('[Prisma] createMessage failed:', error);
      throw error;
    }
  },

  // Get all messages for a session (before workspace exists)
  getBySession: async (sessionId: string) => {
    try {
      return await prisma.message.findMany({
        where: { sessionId },
      });
    } catch (error) {
      console.error('[Prisma] getBySession failed:', error);
      throw error;
    }
  },

  // Get messages for a workspace with pagination
  getByWorkspace: async (workspaceId: string, cursorDate?: Date, limit: number = 50, visibleOnly: boolean = false, includeImageData: boolean = false) => {
    try {
      const whereClause: any = {
        workspaceId,
      };

      if (cursorDate) {
        whereClause.createdAt = { lt: cursorDate };
      }

      if (visibleOnly) {
        whereClause.OR = [
          { role: { in: ['assistant', 'tool'] } },
          { role: 'user', requestId: { not: null } },
        ];
      }

      const imageInclude = includeImageData
        ? { orderBy: { createdAt: 'asc' as const } }
        : {
            select: {
              id: true,
              filename: true,
              mimeType: true,
              width: true,
              height: true,
              sizeBytes: true,
            },
            orderBy: { createdAt: 'asc' as const },
          };

      const messages = await prisma.message.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          agentLogs: {
            orderBy: { timestamp: 'asc' },
          },
          images: imageInclude as any,
        },
      });

      if (includeImageData) {
        const allImages: any[] = [];
        for (const m of messages as any[]) {
          if (m.images?.length) allImages.push(...m.images);
        }
        await Promise.all(
          allImages.map(async (img) => {
            try {
              const result = await imageService.getBytes(img.id);
              img.base64Data = result ? result.buffer.toString('base64') : '';
            } catch (err) {
              console.error(`[messageService] Failed to hydrate image ${img.id}:`, err);
              img.base64Data = '';
            }
          }),
        );
      }

      return messages;
    } catch (error) {
      console.error('[Prisma] getByWorkspace failed:', error);
      throw error;
    }
  },

  // Fetch AgentLog rows for a workspace grouped by their anchor message,
  // ready to be merged by createdAt into the chat timeline.
  getAgentLogGroups: async (workspaceId: string, cursorDate?: Date) => {
    const rows = await prisma.agentLog.findMany({
      where: {
        workspaceId,
        ...(cursorDate ? { message: { createdAt: { lt: cursorDate } } } : {}),
      },
      include: {
        message: { select: { id: true, createdAt: true, content: true } },
      },
      orderBy: [{ messageId: 'asc' }, { timestamp: 'asc' }],
    });

    // Group rows by messageId
    const groupMap = new Map<string, {
      createdAt: Date;
      agentsByName: Map<string, { name: string; displayName: string; logs: any[] }>;
    }>();

    for (const row of rows) {
      if (!groupMap.has(row.messageId)) {
        groupMap.set(row.messageId, {
          createdAt: row.message.createdAt,
          agentsByName: new Map(),
        });
      }
      const group = groupMap.get(row.messageId)!;
      if (!group.agentsByName.has(row.agentName)) {
        // Resolve displayName from the anchor message content
        let displayName = row.agentName === 'researcher' ? 'Research Agent' : 'File Agent';
        try {
          const parsed = JSON.parse(row.message.content);
          const found = (parsed.agents ?? []).find((a: any) => a.name === row.agentName);
          if (found?.displayName) displayName = found.displayName;
        } catch { /* use fallback */ }
        group.agentsByName.set(row.agentName, { name: row.agentName, displayName, logs: [] });
      }
      group.agentsByName.get(row.agentName)!.logs.push({
        type: row.type,
        message: row.logMessage,
        tool: row.tool ?? undefined,
        timestamp: Number(row.timestamp),
      });
    }

    return Array.from(groupMap.entries()).map(([messageId, g]) => ({
      id: `sub-agent-${messageId}`,
      role: 'agent' as const,
      eventType: 'SUB_AGENT_SUMMARY' as const,
      content: '',
      createdAt: g.createdAt,
      subAgentSummary: Array.from(g.agentsByName.values()).map(a => ({
        name: a.name,
        displayName: a.displayName,
        status: a.logs.length > 0 ? a.logs[a.logs.length - 1].message : '',
        logs: a.logs,
        isComplete: true,
      })),
    }));
  },

  // Clear all messages for a workspace (e.g. workspace teardown or reset)
  clearWorkspaceMessages: async (workspaceId: string) => {
    try {
      return await prisma.message.deleteMany({
        where: { workspaceId },
      });
    } catch (error) {
      console.error('[Prisma] clearWorkspaceMessages failed:', error);
      throw error;
    }
  },
};