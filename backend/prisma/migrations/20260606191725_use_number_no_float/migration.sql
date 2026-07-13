/*
  Warnings:

  - You are about to alter the column `cost` on the `Payment` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Integer`.

*/
-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "cost" SET DATA TYPE INTEGER;
