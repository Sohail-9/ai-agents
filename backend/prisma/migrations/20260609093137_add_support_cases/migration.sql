/*
  Warnings:

  - You are about to drop the column `caseNumber` on the `SupportCase` table. All the data in the column will be lost.
  - The `priority` column on the `SupportCase` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Made the column `title` on table `SupportCase` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- DropForeignKey
ALTER TABLE "SupportCase" DROP CONSTRAINT "SupportCase_userId_fkey";

-- DropIndex
DROP INDEX "SupportCase_caseNumber_key";

-- DropIndex
DROP INDEX "SupportCase_status_idx";

-- DropIndex
DROP INDEX "SupportCase_workspaceId_idx";

-- AlterTable
ALTER TABLE "SupportCase" DROP COLUMN "caseNumber",
ALTER COLUMN "title" SET NOT NULL,
DROP COLUMN "priority",
ADD COLUMN     "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL';

-- DropEnum
DROP TYPE "SupportCasePriority";

-- CreateIndex
CREATE INDEX "SupportCase_userId_status_idx" ON "SupportCase"("userId", "status");
