-- SPDX-License-Identifier: AGPL-3.0-or-later
-- DISPUTE-FENCE-ACCOUNT: an email-proof dispute is an ACCOUNT-level fact that stays authoritative after the account is linked to Flux.
--
-- flux_account_dispute: ONE row per account, never deleted. `open` is 1 while a dispute stands; `version` rises on every dispute (a repeat
-- included) and on every clear, so it is monotonic over the account's whole history: a clear carries the version it read and lifts only
-- that dispute (UPDATE ... WHERE open=1 AND version=?), never a newer one, even after a clear and a re-open in between.
-- Written only by the dispute and dispute-clear batches (src/flux-email-proof.ts). While open=1, the four commit points (Flux key claim,
-- key commit, credit grant dispatch, spending on / cap raise above 0) refuse INSIDE their own statement (src/flux-dispute-fence.ts).
-- No unlink and no accounting change: the link, the ledger and the debts are untouched, and switching spending off is never refused.
CREATE TABLE flux_account_dispute (
  account_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  open INTEGER NOT NULL CHECK (open IN (0, 1)),
  note TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- proof_hold: the hold as the key row carries it. Set on every existing row of the account when a dispute opens, inherited by a row created
-- while a dispute is open (lazy ensureHomeRow, the step-up claim, a home bought later), lifted when the dispute is cleared.
-- The commit points read flux_account_dispute, not this column, so a row can never be missed.
ALTER TABLE flux_home_keys ADD COLUMN proof_hold INTEGER NOT NULL DEFAULT 0 CHECK (proof_hold IN (0, 1));

-- BACKFILL (Astra H3): a dispute that stood BEFORE this migration is an open account fence from the first minute, so the commit points that now
-- read this table alone never miss it. Idempotent (INSERT OR IGNORE on the primary key; the hold is a plain set). Each line is one statement.
-- 1. an unlinked account's proof dispute (flux_email_proof_disputes): same note, operator and time.
INSERT OR IGNORE INTO flux_account_dispute (account_id,version,open,note,by,at) SELECT account_id,1,1,note,by,at FROM flux_email_proof_disputes;
-- 2. a LINKED account's dispute lived only as an open paging alert (subject 'account:<id>'): the operator is read from its detail when it parses.
INSERT OR IGNORE INTO flux_account_dispute (account_id,version,open,note,by,at) SELECT substr(subject,9),1,1,'linked dispute opened before the account-level fence (backfilled by migration 0147)',COALESCE(CASE WHEN json_valid(detail) THEN json_extract(detail,'$.by') END,'migration-0147'),raised_at FROM cloud_alerts WHERE kind='credit.email_proof_disputed' AND resolved_at IS NULL AND subject LIKE 'account:%' AND length(subject)>8;
-- 3. the key rows of those accounts' homes are held.
UPDATE flux_home_keys SET proof_hold=1 WHERE home_id IN (SELECT h.id FROM cloud_homes h JOIN flux_account_dispute d ON d.account_id=h.owner_id WHERE d.open=1);
