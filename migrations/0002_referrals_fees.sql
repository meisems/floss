-- Floss 0002: referrals + fees. Additive only (no table rebuilds), safe on a live D1 database.
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredById" TEXT REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD COLUMN "referredAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "referralOwedLamports" BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

CREATE TABLE "FeeLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payerUserId" TEXT NOT NULL,
    "sessionId" TEXT,
    "referrerUserId" TEXT,
    "baseLamports" BIGINT NOT NULL,
    "feeLamports" BIGINT NOT NULL,
    "platformLamports" BIGINT NOT NULL,
    "referrerLamports" BIGINT NOT NULL,
    "referrerStatus" TEXT NOT NULL,
    "signature" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeeLedger_payerUserId_fkey" FOREIGN KEY ("payerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeeLedger_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "FeeLedger_payerUserId_createdAt_idx" ON "FeeLedger"("payerUserId", "createdAt");
CREATE INDEX "FeeLedger_referrerUserId_createdAt_idx" ON "FeeLedger"("referrerUserId", "createdAt");
