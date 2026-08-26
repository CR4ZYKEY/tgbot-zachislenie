-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tgId" BIGINT NOT NULL,
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
    "resumePoint" TEXT,
    "deferredStage1" BOOLEAN NOT NULL DEFAULT false,
    "cohortYear" INTEGER,
    "consentAt" TIMESTAMP(3),
    "lastTouchAt" TIMESTAMP(3),
    "mutedStages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consecutiveMisses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

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
CREATE TABLE "checklist_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "users_tgId_key" ON "users"("tgId");

-- CreateIndex
CREATE UNIQUE INDEX "users_clientCode_key" ON "users"("clientCode");

-- CreateIndex
CREATE INDEX "answers_userId_screenId_idx" ON "answers"("userId", "screenId");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_items_userId_subject_key" ON "checklist_items"("userId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupKey_key" ON "jobs"("dedupKey");

-- CreateIndex
CREATE INDEX "jobs_runAt_status_idx" ON "jobs"("runAt", "status");

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
