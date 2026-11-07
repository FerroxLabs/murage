-- SPDX-License-Identifier: AGPL-3.0-or-later
-- F35 step 1 of 2 (better-auth 1.7.1 -> 1.7.7). 1.7.3+ dropped the account "issuer" field and never writes it, so the NOT NULL column
-- from 0001 would refuse every new account row a 1.7.7 Worker creates. This step only makes "issuer" NULLABLE (SQLite needs a rebuild
-- for that); the column and its unique index stay, so a 1.7.1 Worker (the one running now, or a rollback to it) keeps working unchanged.
-- Step 2 (migrations-later/0112_account_drop_issuer.sql) drops the index and the column, and moves into migrations/ only once no 1.7.1
-- Worker or rollback to one remains. Order for MurageCloud: apply 0111, deploy the 1.7.7 Worker, later move and apply 0112.
-- Nothing references "account" (it references "user"), so the rebuild keeps every foreign key.
PRAGMA defer_foreign_keys = true;

CREATE TABLE "account_f35" (
  "id" text not null primary key,
  "issuer" text,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

INSERT INTO "account_f35" ("id", "issuer", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
  "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
SELECT "id", "issuer", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken",
  "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "account_f35" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");
