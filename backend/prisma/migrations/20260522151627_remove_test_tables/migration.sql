-- DropForeignKey
ALTER TABLE "TestResult" DROP CONSTRAINT "TestResult_testCaseId_fkey";

-- DropForeignKey
ALTER TABLE "TestResult" DROP CONSTRAINT "TestResult_testRunId_fkey";

-- DropForeignKey
ALTER TABLE "TestCase" DROP CONSTRAINT "TestCase_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "TestRun" DROP CONSTRAINT "TestRun_workspaceId_fkey";

-- DropIndex
DROP INDEX "TestCase_workspaceId_order_idx";

-- DropIndex
DROP INDEX "TestResult_testCaseId_idx";

-- DropIndex
DROP INDEX "TestResult_testRunId_idx";

-- DropIndex
DROP INDEX "TestRun_workspaceId_startedAt_idx";

-- DropTable
DROP TABLE "TestResult";

-- DropTable
DROP TABLE "TestRun";

-- DropTable
DROP TABLE "TestCase";

-- DropEnum
DROP TYPE "TestResultStatus";

-- DropEnum
DROP TYPE "TestRunStatus";
