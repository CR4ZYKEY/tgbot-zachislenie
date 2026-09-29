-- CreateTable
CREATE TABLE "photo_cache" (
    "path" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photo_cache_pkey" PRIMARY KEY ("path")
);
