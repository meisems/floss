-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "keySalt" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SessionWallet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "encryptedKey" TEXT,
    "keyIv" TEXT,
    "keyVersion" INTEGER NOT NULL,
    "workingFloatLamports" BIGINT NOT NULL DEFAULT 0,
    "baselineLamports" BIGINT,
    "exportCount" INTEGER NOT NULL DEFAULT 0,
    "lastSweepAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "purgedAt" DATETIME,
    CONSTRAINT "SessionWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ColdVaultConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "pendingAddress" TEXT,
    "pendingEffectiveAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ColdVaultConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SweepTriggerRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'default',
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "thresholdLamports" BIGINT,
    "percentBps" INTEGER,
    "idleMinutes" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SweepTriggerRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "sessionId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "signature" TEXT,
    "lamports" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SessionWallet" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionWallet_address_key" ON "SessionWallet"("address");

-- CreateIndex
CREATE INDEX "SessionWallet_userId_status_idx" ON "SessionWallet"("userId", "status");

-- CreateIndex
CREATE INDEX "SessionWallet_status_lastCheckedAt_idx" ON "SessionWallet"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ColdVaultConfig_userId_key" ON "ColdVaultConfig"("userId");

-- CreateIndex
CREATE INDEX "ColdVaultConfig_pendingEffectiveAt_idx" ON "ColdVaultConfig"("pendingEffectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "SweepTriggerRule_userId_scope_kind_key" ON "SweepTriggerRule"("userId", "scope", "kind");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
