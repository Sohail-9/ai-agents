import { prisma } from '../lib/prisma';
import { EnvTarget, EnvStore, normalizeEnvStore, filterByTarget } from '../skills/env/env_manager';

// Normalize a raw workspace name to lowercase letters and numbers only.
// No hyphens, spaces, or special characters — safe for domains and URLs.
function normalizeWorkspaceName(name: string): string {
  let normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');  // strip ALL non-alphanumeric characters

  if (normalized.length > 56) {
    normalized = normalized.slice(0, 56);
  }

  return normalized || 'project';
}

// Generate a random alphanumeric suffix for deduplication.
function generateRandomSuffix(length: number = 4): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Ensure the desired name is globally unique (name column has a global unique constraint).
async function resolveUniqueName(desiredName: string): Promise<string> {
  const base = normalizeWorkspaceName(desiredName);

  const existing = await prisma.workspace.findFirst({
    where: { isDeleted: false, name: base },
    select: { id: true },
  });

  if (!existing) {
    return base;
  }

  return base + generateRandomSuffix(4);
}

export const workspaceService = {
  // Create a workspace (initial record from REST, or full record from WS)
  createWorkspace: async (workspaceData: {
    userId: string;
    name: string;
    idea: string;
    framework: string;
    language: string;
    database: string;
    aiAgentsMd?: string;
    summary: string;
    sandboxId?: string;
    status?: 'GENERATING' | 'READY' | 'ACTIVE' | 'ARCHIVED' | 'FAILED';
  }) => {
    const { userId, name, idea, framework, language, database, aiAgentsMd, summary, sandboxId, status } = workspaceData;

    try {
      // Ensure the user exists before creating the workspace
      await prisma.user.upsert({
        where: { clerkId: userId },
        update: {},
        create: {
          clerkId: userId,
          name: userId.startsWith('anonymous') ? 'Anonymous User' : userId,
        },
      });

      const base = normalizeWorkspaceName(name);
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateName = attempt === 0
          ? await resolveUniqueName(name)
          : base + generateRandomSuffix(4);
        try {
          return await prisma.workspace.create({
            data: {
              name: candidateName,
              userId,
              aiAgentsMd: aiAgentsMd || '',
              summary,
              sandboxId: sandboxId || null,
              status: status || (sandboxId ? 'ACTIVE' : 'ACTIVE'),
              config: {
                idea,
                framework,
                language,
                database,
              },
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002' && attempt < 4) continue;
          throw err;
        }
      }
      throw new Error('Failed to generate a unique workspace name after 5 attempts');
    } catch (error) {
      console.error('[Prisma] createWorkspace failed:', error);
      throw error;
    }
  },

  // Link all session messages & requests to the newly created workspace
  linkSessionToWorkspace: async (sessionId: string, workspaceId: string) => {
    // Back-fill messages
    const messages = await prisma.message.findMany({
      where: { sessionId }
    });

    const messagesUpdated = await Promise.all(
      messages.map((message) =>
        prisma.message.update({
          where: { id: message.id },
          data: { workspaceId }
        })
      )
    );

    // Back-fill requests
    const requests = await prisma.request.findMany({
      where: { sessionId }
    });

    const requestsUpdated = await Promise.all(
      requests.map((request) =>
        prisma.request.update({
          where: { id: request.id },
          data: { workspaceId }
        })
      )
    );

    return {
      messagesLinked: messagesUpdated.length,
      requestsLinked: requestsUpdated.length
    };
  },

  // Get a workspace (when agent needs to read context)
  getWorkspace: async (id: string) => {
    try {
      return await prisma.workspace.findUnique({
        where: { id },
      });
    } catch (error) {
      console.error('[Prisma] getWorkspace failed:', error);
      throw error;
    }
  },

  // Update sandbox id
  updateSandboxId: async (id: string, sandboxId: string) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { sandboxId },
      });
    } catch (error) {
      console.error('[Prisma] updateSandboxId failed:', error);
      throw error;
    }
  },

  // Update status (when stage changes)
  updateStatus: async (id: string, status: string) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { status: status as any }, // Type assertion since status is an enum
      });
    } catch (error) {
      console.error('[Prisma] updateStatus failed:', error);
      throw error;
    }
  },

  // Update AI Agents (at end of session (agent updates memory))
  updateAI Agents: async (id: string, aiAgentsMd: string) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { aiAgentsMd },
      });
    } catch (error) {
      console.error('[Prisma] updateAI Agents failed:', error);
      throw error;
    }
  },

  // Update port
  updatePort: async (id: string, port: number) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { port },
      });
    } catch (error) {
      console.error('[Prisma] updatePort failed:', error);
      throw error;
    }
  },

  // Update backend port
  updateBackendPort: async (id: string, port: number) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { backendPort: port },
      });
    } catch (error) {
      console.error('[Prisma] updateBackendPort failed:', error);
      throw error;
    }
  },

  updateName: async (id: string, name: string) => {
    try {
      const workspace = await prisma.workspace.findUnique({ where: { id } });
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      const normalizedRequestedName = normalizeWorkspaceName(name);
      if (workspace.name === normalizedRequestedName) {
        return workspace;
      }

      const base = normalizeWorkspaceName(name);
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateName = attempt === 0
          ? await resolveUniqueName(name)
          : base + generateRandomSuffix(4);
        try {
          return await prisma.workspace.update({ where: { id }, data: { name: candidateName } });
        } catch (err: any) {
          if (err.code === 'P2002' && attempt < 4) continue;
          throw err;
        }
      }
      throw new Error('Failed to generate a unique workspace name after 5 attempts');
    } catch (error) {
      console.error('[Prisma] updateName failed:', error);
      throw error;
    }
  },

  updateSummary: async (id: string, summary: string) => {
    try {
      return await prisma.workspace.update({ where: { id }, data: { summary } });
    } catch (error) {
      console.error('[Prisma] updateSummary failed:', error);
      throw error;
    }
  },

  // Save the git clone URL for this workspace
  updateGitUrl: async (id: string, gitUrl: string) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { gitUrl },
      });
    } catch (error) {
      console.error('[Prisma] updateGitUrl failed:', error);
      throw error;
    }
  },

  updateConfig: async (id: string, configPatch: Record<string, unknown>) => {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id },
      });

      if (!workspace) {
        throw new Error("Workspace not found");
      }

      return await prisma.workspace.update({
        where: { id },
        data: {
          // Merge the new config patch so callers can add database metadata
          // without clobbering existing stack fields.
          config: {
            ...((workspace.config as Record<string, unknown>) || {}),
            ...configPatch,
          } as any,
        },
      });
    } catch (error) {
      console.error('[Prisma] updateConfig failed:', error);
      throw error;
    }
  },

  // List workspaces by userId (for "Your Systems" in frontend)
  listByUser: async (userId: string) => {
    try {
      return await prisma.workspace.findMany({
        where: { userId, isDeleted: false },
        orderBy: { updatedAt: 'desc' },
        include: {
          deployments: {
            where: { status: 'SUCCESS' },
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          database: true,
        }
      });
    } catch (error) {
      console.error('[Prisma] listByUser failed:', error);
      throw error;
    }
  },

  softDelete: async (id: string) => {
    try {
      return await prisma.workspace.update({
        where: { id },
        data: { isDeleted: true },
      });
    } catch (error) {
      console.error('[Prisma] softDelete failed:', error);
      throw error;
    }
  },

  // Read the env JSON column filtered by target (defaults to "both" = all vars)
  getEnv: async (id: string, target: EnvTarget = "both"): Promise<Record<string, string>> => {
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id },
        select: { env: true },
      });
      if (!ws) throw new Error(`Workspace ${id} not found`);
      const store = normalizeEnvStore(ws.env);
      return filterByTarget(store, target);
    } catch (error) {
      console.error('[Prisma] getEnv failed:', error);
      throw error;
    }
  },

  // Merge-patch the env JSON column with target flags (defaults to "both" for backward compat)
  setEnv: async (id: string, patch: Record<string, string>, target: EnvTarget = "both"): Promise<Record<string, string>> => {
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id },
        select: { env: true },
      });
      if (!ws) throw new Error(`Workspace ${id} not found`);
      const store = normalizeEnvStore(ws.env);
      const frontend = target === "frontend" || target === "both";
      const backend = target === "backend" || target === "both";
      for (const [k, v] of Object.entries(patch)) {
        const existing = store[k];
        store[k] = {
          value: v,
          frontend: existing ? existing.frontend || frontend : frontend,
          backend: existing ? existing.backend || backend : backend,
        };
      }
      await prisma.workspace.update({
        where: { id },
        data: { env: store as any },
      });
      return filterByTarget(store, target);
    } catch (error) {
      console.error('[Prisma] setEnv failed:', error);
      throw error;
    }
  },
};

