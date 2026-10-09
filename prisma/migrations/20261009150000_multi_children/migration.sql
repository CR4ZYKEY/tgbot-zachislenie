-- DropIndex
DROP INDEX "users_tgId_key";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "slot" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "parent_state" (
    "tgId" BIGINT NOT NULL,
    "activeSlot" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_state_pkey" PRIMARY KEY ("tgId")
);

-- CreateIndex
CREATE INDEX "users_tgId_idx" ON "users"("tgId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tgId_slot_key" ON "users"("tgId", "slot");

