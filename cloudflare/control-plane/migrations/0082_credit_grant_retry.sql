-- A monthly grant is recorded as granted only when B4 confirmed it (the pre-B4 stub now fails closed with flux_not_wired). A claim whose
-- grant failed stays claimed (granted_at NULL); the billing sweep asks B4 again under the home's lease with the same input, which B4 applies
-- at most once per (invoice_id, kind). attempts/last_error: as credit_reversals; 3 failures or flux_not_wired list the claim in the home's
-- ONE open credit.grant_pending alert (detail.grantIds), which is resolved only when every listed claim is granted, reversed or cleared.
-- alerted_at: when the claim was first listed in that alert (Astra STUB-2 #3). An escalated claim stays listed, whatever its later errors,
-- until it is granted, its reversal is confirmed (credit_reversals.reversed_at; a journaled, unconfirmed one keeps it listed, STUB-2 #4) or
-- ops clears it (alerted_at=NULL with cleared_at, below).
-- period_start/period_end/previous_plan: the grant's input, kept with the claim so the retry asks with exactly what was asked first.
-- subscription_id: the subscription whose invoice the claim is for. The sweep asks again only while THAT subscription still owns the home and
-- has not ended (canceled, disputed); otherwise the claim is suppressed (Astra STUB-1 #2): a re-subscription never receives an old claim.
-- suppressed_at/suppressed_reason: a claim the sweep never asks for again ('subscription_ended', or 'grant_input_missing' for a claim made
-- before this migration, which has no period to ask with). It stays listed in the alert for ops; clearing suppressed_at re-queues it.
-- last_attempt_at: the claim's scheduling stamp, written (fenced) BEFORE B4 is asked and apart from attempts/last_error, so a claim whose
-- ask fails on infrastructure still moves back; the sweep takes the least recently tried claims and homes first, so no set of claims that
-- keep failing, on B4 or on infrastructure, can starve another (Astra STUB-1 #3, STUB-2 #2).
-- tries: how many times B4 was asked for the claim, counted in the same fenced write as last_attempt_at (before the hook). An ask that ends
-- in neither a grant nor a FluxHookRetry (a raw error: D1, network, a lost worker) is not an attempt, so tries-attempts counts those
-- infrastructure failures; 3 of them, or a claim still ungranted 2 hours after it was made, escalate it too (error 'infra_failing' /
-- 'pending_too_long'), apart from attempt accounting (Astra STUB-3 #2).
-- cleared_at/cleared_tries: ops clearance (Astra STUB-3 #3). Ops clears an escalated claim with
--   UPDATE credit_grants SET alerted_at=NULL,cleared_at=<now>,cleared_tries=tries WHERE invoice_id=? AND kind=?
-- The next billing sweep rebuilds the home's alert under its lease (a home with only cleared or suppressed claims included), closing it or
-- updating its list; ops never edits cloud_alerts for this (Astra STUB-4 #2).
-- A cleared claim is escalated again only by a NEW failed ask after the clearance (tries>cleared_tries) or a suppression after it
-- (suppressed_at>cleared_at); age, attempts>=3 and flux_not_wired alone never undo a clearance.
-- A reversal's alert, once resolved, is reopened (new revision) by a later failure of the same reversal (Astra STUB-4 #1).
-- credit_reversals.last_attempt_at/tries: the same fenced pre-call stamp for reversals (Astra STUB-3 #1): the sweep takes the least
-- recently tried reversals and homes first, so one whose ask fails raw (which ends its home's pass) never blocks a sibling or a 51st home.
-- A reversal with 3 such failures or pending 2 hours raises its credit.reversal_pending alert ('infra_failing' / 'pending_too_long').
-- flux_hook_stub_log.grant_id: the pre-B4 stub's grant log keeps ONE row per grant id, written by one atomic upsert on the unique
-- (hook, grant_id) index (Astra STUB-2 #5); rows of other hooks, and older rows, keep grant_id NULL.
-- Edited in place (Astra STUB-1, STUB-2, STUB-3): this migration was never applied anywhere (staging has 0038..0081 only) before this version.
ALTER TABLE credit_grants ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_grants ADD COLUMN last_error TEXT;
ALTER TABLE credit_grants ADD COLUMN period_start INTEGER;
ALTER TABLE credit_grants ADD COLUMN period_end INTEGER;
ALTER TABLE credit_grants ADD COLUMN previous_plan TEXT;
ALTER TABLE credit_grants ADD COLUMN subscription_id TEXT;
ALTER TABLE credit_grants ADD COLUMN suppressed_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN suppressed_reason TEXT;
ALTER TABLE credit_grants ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN alerted_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_grants ADD COLUMN cleared_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN cleared_tries INTEGER;
ALTER TABLE credit_reversals ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE credit_reversals ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
-- Existing reversals keep their attempts in tries, so tries-attempts counts only asks made from now on (Astra STUB-4 #4). credit_grants.attempts is new here (all 0).
UPDATE credit_reversals SET tries=attempts;
ALTER TABLE flux_hook_stub_log ADD COLUMN grant_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS flux_hook_stub_log_grant ON flux_hook_stub_log(hook, grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_grants_pending ON credit_grants(home_id) WHERE granted_at IS NULL;
CREATE INDEX IF NOT EXISTS credit_grants_retry ON credit_grants(last_attempt_at, home_id) WHERE granted_at IS NULL AND suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS credit_reversals_retry ON credit_reversals(last_attempt_at, home_id) WHERE reversed_at IS NULL;
