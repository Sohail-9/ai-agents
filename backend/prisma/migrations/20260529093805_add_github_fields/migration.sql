-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "githubConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "githubHeadSha" TEXT,
ADD COLUMN     "githubOwner" TEXT,
ADD COLUMN     "githubRepo" TEXT,
ADD COLUMN     "githubTreeSha" TEXT;

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "files" JSONB NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "githubSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Snapshot_workspaceId_createdAt_idx" ON "Snapshot"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Snapshot_workspaceId_githubSha_idx" ON "Snapshot"("workspaceId", "githubSha");

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
