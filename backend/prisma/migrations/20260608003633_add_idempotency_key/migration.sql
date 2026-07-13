-- Add idempotencyKey column
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

-- Create unique constraint on idempotencyKey (allowing multiple NULLs)
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- Create index for queries
CREATE INDEX "Payment_idempotencyKey_idx" ON "Payment"("idempotencyKey");
