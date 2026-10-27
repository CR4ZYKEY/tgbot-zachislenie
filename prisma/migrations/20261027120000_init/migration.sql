-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tgId" BIGINT NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 1,
    "clientCode" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "package" TEXT,
    "class" TEXT,
    "isReturning" BOOLEAN,
    "stage" TEXT NOT NULL DEFAULT 's0',
    "renderVersion" INTEGER NOT NULL DEFAULT 0,
    "historyStack" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phoneAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastMessageId" INTEGER,
    "lastOverlayMessageId" INTEGER,
    "overlayBackTarget" TEXT,
    "resumePoint" TEXT,
    "deferredStage1" BOOLEAN NOT NULL DEFAULT false,
    "cohortYear" INTEGER,
    "consentAt" TIMESTAMP(3),
    "lastTouchAt" TIMESTAMP(3),
    "mutedStages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consecutiveMisses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sheetSyncHash" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "photo_cache" (
    "path" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photo_cache_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "parent_state" (
    "tgId" BIGINT NOT NULL,
    "activeSlot" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parent_state_pkey" PRIMARY KEY ("tgId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clientCode_key" ON "users"("clientCode");

-- CreateIndex
CREATE UNIQUE INDEX "users_tgId_slot_key" ON "users"("tgId", "slot");

-- CreateIndex
CREATE INDEX "answers_userId_createdAt_idx" ON "answers"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "answers_createdAt_idx" ON "answers"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupKey_key" ON "jobs"("dedupKey");

-- CreateIndex
CREATE INDEX "jobs_runAt_status_idx" ON "jobs"("runAt", "status");

-- CreateIndex
CREATE INDEX "jobs_userId_status_idx" ON "jobs"("userId", "status");

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

