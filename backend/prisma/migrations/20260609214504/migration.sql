/*
  Warnings:

  - The `priority` column on the `SupportCase` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[caseNumber]` on the table `SupportCase` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- DropIndex
DROP INDEX "SupportCase_userId_status_idx";

-- AlterTable
ALTER TABLE "SupportCase" ADD COLUMN     "caseNumber" SERIAL NOT NULL,
ALTER COLUMN "title" DROP NOT NULL,
DROP COLUMN "priority",
ADD COLUMN     "priority" "SupportCasePriority" NOT NULL DEFAULT 'MEDIUM';

-- DropEnum
DROP TYPE "SupportPriority";

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_caseNumber_key" ON "SupportCase"("caseNumber");

-- CreateIndex
CREATE INDEX "SupportCase_status_idx" ON "SupportCase"("status");

-- CreateIndex
CREATE INDEX "SupportCase_workspaceId_idx" ON "SupportCase"("workspaceId");

-- AddForeignKey
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("clerkId") ON DELETE CASCADE ON UPDATE CASCADE;
