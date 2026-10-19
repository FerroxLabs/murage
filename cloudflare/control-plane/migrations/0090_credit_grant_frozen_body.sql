-- Murage Cloud B4 WP5-P4 D1 (design b4/GRANTS-DESIGN.md r9, sections 2 and 7). The grant hook input has no amount, recipient or expiry, so the
-- control plane freezes the canonical request body INTO THE CLAIM and resends exactly those bytes on every attempt, whatever the
-- configuration says later (the router compares body_sha256 and answers a changed body 409 idempotency_conflict).
-- body_json: the canonical body (grant_id, invoice_id, kind, home_id, account_id, plan, amount_microcents, period_start, period_end,
-- expires_at), written once (the fenced claim INSERT, or the fenced write-once rebuild before an ask) and never overwritten. body_sha256:
-- its SHA-256, lower-case hex. Both stay NULL while no grants client is configured, while the home has no unfenced Flux link (the claim is
-- HELD, never frozen with a guessed recipient), and for claims made before this migration (rebuilt before their next ask, or by the
-- stub-era cutover, scripts/flux-grants-cutover.mjs, for claims the stub stamped).
-- pending_review_at/pending_review_reason: a stub-era claim whose body cannot be rebuilt. It keeps granted_at set, is never cleared by the
-- cutover and is for ops to resolve by hand.
ALTER TABLE credit_grants ADD COLUMN body_json TEXT;
ALTER TABLE credit_grants ADD COLUMN body_sha256 TEXT;
ALTER TABLE credit_grants ADD COLUMN pending_review_at INTEGER;
ALTER TABLE credit_grants ADD COLUMN pending_review_reason TEXT;

-- The subscription period (Unix seconds) Stripe prorated a plan-change quote over: the quote's proration_date lies in [start, end). An
-- upgrade_delta grant is the price difference's credit share over exactly the time the customer was charged for: (end - proration_date) /
-- (end - start), floored once. NULL on quotes made before this migration (their upgrade grant then falls back to the recorded billing period
-- when it is provably the same one, else it is held for ops).
ALTER TABLE plan_quotes ADD COLUMN sub_period_start INTEGER;
ALTER TABLE plan_quotes ADD COLUMN sub_period_end INTEGER;

-- The stub-era cutover's cohort and progress (design section 7). One row per claim the cutover identified (granted_at set by the stub, no
-- frozen body): what granted_at it saw, the body hash it populated, and how far it got. A run interrupted anywhere resumes from here; a row
-- flagged pending_review stays in every later report; the token may be set only when every row of the cohort is cleared or pending_review.
CREATE TABLE credit_grant_cutover (
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  granted_at_seen INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('identified','populated','cleared','pending_review')),
  body_sha256 TEXT,
  reason TEXT,
  identified_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, kind)
);
