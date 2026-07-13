import { prisma } from '../lib/prisma';
import { SubAgentLogEntry, AgentKind } from '../brain/agents/subAgentTypes';

export const agentLogService = {
  bulkCreate: async (
    messageId: string,
    workspaceId: string,
    agents: { name: AgentKind; logs: SubAgentLogEntry[] }[],
  ) => {
    const rows = agents.flatMap(({ name, logs }) =>
      logs.map(log => ({
        messageId,
        workspaceId,
        agentName: name,
        type: log.type,
        logMessage: log.message,
        tool: log.tool ?? null,
        timestamp: BigInt(log.timestamp),
      })),
    );

    if (rows.length === 0) return;

    await prisma.agentLog.createMany({ data: rows });
  },
};
