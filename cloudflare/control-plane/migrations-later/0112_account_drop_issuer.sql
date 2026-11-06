-- SPDX-License-Identifier: AGPL-3.0-or-later
-- F35 step 2 of 2. NOT applied with the others: it lives outside migrations/ on purpose. MurageCloud moves it into migrations/ and applies
-- it only once the 1.7.7 Worker is live everywhere and no 1.7.1 Worker or rollback to one remains (a 1.7.1 Worker writes "issuer" and
-- would fail on every new account row after this). Requires 0111 (issuer nullable) and the 1.7.7 Worker first.
DROP INDEX IF EXISTS "account_issuer_accountId_uidx";
ALTER TABLE "account" DROP COLUMN "issuer";
