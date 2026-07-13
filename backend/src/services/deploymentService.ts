import { prisma } from "../lib/prisma";
import { DeploymentType, DeploymentStatus } from "../../generated/prisma";

export const deploymentService = {
  async createDeployment(data: {
    id: string;
    workspaceId: string;
    type: DeploymentType;
    status: DeploymentStatus;
    env?: any;
    config?: any;
  }) {
    return prisma.deployment.upsert({
      where: { id: data.id },
      create: data,
      update: { status: data.status, type: data.type, env: data.env },
    });
  },

  async updateDeployment(
    id: string,
    data: {
      status?: DeploymentStatus;
      logs?: any;
      previewUrl?: string;
      completedAt?: Date;
      startedAt?: Date;
      config?: any;
    },
  ) {
    return prisma.deployment.update({ where: { id }, data });
  },

  async getDeployment(id: string) {
    return prisma.deployment.findUnique({ where: { id } });
  },

  async getDeploymentsByWorkspace(workspaceId: string) {
    return prisma.deployment.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  },

  async getDeploymentLogs(deploymentId: string) {
    return prisma.deploymentLog.findMany({
      where: { deploymentId },
      orderBy: { createdAt: "asc" },
    });
  },
};
