/*
  Warnings:

  - You are about to drop the column `credits` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `reservedCredits` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `reservedExpiresAt` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "credits",
DROP COLUMN "reservedCredits",
DROP COLUMN "reservedExpiresAt";
