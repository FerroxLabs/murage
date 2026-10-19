-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B4 round 2: link identity and fencing, monotonic per-home versions, durable key
-- compensation, per-period entitlement accounting, and a durable grant-delivery claim.
-- 0086 is already applied; everything here is additive.

-- A link has an identity (link_id, new on every link) and a version that only goes up.
-- Unlink FENCES first (fenced=1, link_version+1), stops the homes, then deletes the row and
-- remembers the version in flux_link_floor so a later relink starts above it.
ALTER TABLE flux_links ADD COLUMN link_id TEXT;
ALTER TABLE flux_links ADD COLUMN link_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flux_links ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0 CHECK (fenced IN (0, 1));
UPDATE flux_links SET link_id = lower(hex(randomblob(16))) WHERE link_id IS NULL;

CREATE TABLE flux_link_floor (
  owner_user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 0)
);

-- cap_version: monotonic per home, bumped on every cap change and every issuance.
-- gen_floor: the highest generation ever attempted. A mint that may have reached Flux is
--   compensated by a tombstone for ITS generation, so the next attempt must use a higher one.
-- stop_version / stop_link_version: what a pending Stop sends, so a retry never carries a
--   newer number than the Stop that created it.
-- link_id / link_version: the link the live key was issued under.
ALTER TABLE flux_home_keys ADD COLUMN cap_version INTEGER NOT NULL DEFAULT 0 CHECK (cap_version >= 0);
ALTER TABLE flux_home_keys ADD COLUMN gen_floor INTEGER NOT NULL DEFAULT 0 CHECK (gen_floor >= 0);
ALTER TABLE flux_home_keys ADD COLUMN stop_version INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN stop_link_version INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN link_id TEXT;
ALTER TABLE flux_home_keys ADD COLUMN link_version INTEGER;
-- Optional billing identity (Stripe customer id) passed to the router when known.
-- Never required here: a prepaid-only account has none.
ALTER TABLE flux_home_keys ADD COLUMN billing_customer_id TEXT;
UPDATE flux_home_keys SET gen_floor = generation;

-- A mint that may have published a key. 'armed' is written BEFORE the router is called;
-- it is deleted in the same D1 batch as the commit that adopts the key. 'due' means the
-- key must be revoked by generation (scope "key"); the cron retries until it is done.
CREATE TABLE flux_key_compensations (
  comp_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lifecycle_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('armed', 'due', 'done')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX flux_key_compensations_by_state ON flux_key_compensations (state, last_attempt_at);

-- outcome is written in the same batch as the invoice's entitlement and grant. A NULL
-- outcome means the invoice was recorded by older code (or never finished): replay
-- re-runs the processing instead of answering duplicate_period with zero grants.
ALTER TABLE flux_invoices ADD COLUMN outcome TEXT;
UPDATE flux_invoices SET outcome = 'reversed' WHERE reversed_at IS NOT NULL;
UPDATE flux_invoices SET outcome = 'granted'
  WHERE outcome IS NULL AND EXISTS (SELECT 1 FROM flux_grants g WHERE g.invoice_id = flux_invoices.invoice_id);

-- The amount ALREADY GRANTED for a home in a subscription period. A new invoice grants
-- only max(0, planAmount - granted_microcents), so no plan cycling can exceed the highest plan.
CREATE TABLE flux_entitlements (
  home_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  granted_microcents INTEGER NOT NULL DEFAULT 0 CHECK (granted_microcents >= 0),
  PRIMARY KEY (home_id, period_start)
);
INSERT INTO flux_entitlements (home_id, period_start, granted_microcents)
  SELECT home_id, period_start, SUM(amount_microcents) FROM flux_grants GROUP BY home_id, period_start;

-- Durable delivery claim. claim_id (the delivery id sent to the Flux app) and claimed_at are
-- written, together with the billing/link re-check, BEFORE any network call. attempts counts
-- claims, so attempts > 0 always means "a delivery may have reached Flux".
ALTER TABLE flux_grants ADD COLUMN claim_id TEXT;
ALTER TABLE flux_grants ADD COLUMN claimed_at INTEGER;
