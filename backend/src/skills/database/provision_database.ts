import { ToolResult } from "../types";
import { provisionWorkspaceDatabase } from "../../services/databaseService";
import { prisma } from "../../lib/prisma";
import { env_manager } from "../env/env_manager";

export interface ProvisionDatabaseParams {
  workspaceId: string;
  sandboxId: string;
}

export async function provision_database(params: ProvisionDatabaseParams): Promise<ToolResult> {
  const { workspaceId, sandboxId } = params;

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { userId: true, name: true, databaseUrl: true },
    });

    if (!workspace) {
      return { success: false, error: `Workspace ${workspaceId} not found.` };
    }

    if (workspace.databaseUrl) {
      return {
        success: true,
        output: `Database already exists for this workspace. DATABASE_URL is already set in the backend environment.`,
      };
    }

    const { databaseName, databaseUrl } = await provisionWorkspaceDatabase({
      workspaceId,
      workspaceName: workspace.name,
      userId: workspace.userId,
    });

    await env_manager({
      action: "set_vars",
      workspaceId,
      sandboxId,
      vars: { DATABASE_URL: databaseUrl },
      target: "backend",
    });

    return {
      success: true,
      output: [
        `Database provisioned successfully.`,
        `Database name: ${databaseName}`,
        `DATABASE_URL has been saved to the workspace env and synced to /workspace/backend/.env.`,
        `You can now run migrations (e.g. npx prisma migrate dev) or use the database directly.`,
      ].join("\n"),
    };
  } catch (err: any) {
    return { success: false, error: `provision_database failed: ${err.message}` };
  }
}
