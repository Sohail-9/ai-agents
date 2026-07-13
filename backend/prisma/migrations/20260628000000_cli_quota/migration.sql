-- CreateTable
CREATE TABLE "CliQuotaPolicy" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "planTier" TEXT,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "windowHours" INTEGER NOT NULL DEFAULT 24,
    "tokenLimit" INTEGER NOT NULL,
    "modelId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CliQuotaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CliQuotaUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "windowStartAt" TIMESTAMP(3) NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CliQuotaUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CliQuotaPolicy_scope_enabled_idx" ON "CliQuotaPolicy"("scope", "enabled");

-- CreateIndex
CREATE INDEX "CliQuotaUsage_userId_idx" ON "CliQuotaUsage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CliQuotaUsage_userId_policyId_key" ON "CliQuotaUsage"("userId", "policyId");
