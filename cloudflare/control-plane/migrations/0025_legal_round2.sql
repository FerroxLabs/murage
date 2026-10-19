-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 2: refund status and submission intent, per-invoice compare-and-swap ledger, an advance lease, and service intervals.
ALTER TABLE refund_ops ADD COLUMN refund_status TEXT;          -- Stripe's refund status: pending | requires_action | succeeded | failed | canceled
ALTER TABLE refund_ops ADD COLUMN submission INTEGER NOT NULL DEFAULT 0;  -- refunds submitted to Stripe so far (one idempotency key each)
ALTER TABLE refund_ops ADD COLUMN submitted_at INTEGER;        -- intent recorded BEFORE the Stripe call; cleared only when the outcome is known
ALTER TABLE refund_ops ADD COLUMN lease_until INTEGER;         -- one worker advances an operation at a time
-- One row per refunded payment. Deciding an amount bumps the version with a compare-and-swap, so concurrent decisions serialize.
CREATE TABLE refund_invoice_ledger (
  invoice_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  decided_cents INTEGER NOT NULL
);
-- When the service was actually supplied: from the lifecycle's ready state (canary passed) until it stops being served.
CREATE TABLE service_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  home_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX service_intervals_home ON service_intervals(home_id, started_at);
CREATE UNIQUE INDEX service_intervals_open ON service_intervals(home_id) WHERE ended_at IS NULL;
-- The Stripe total differed from the total including tax agreed to: no contract at that price (refunded, checkout reopened).
ALTER TABLE checkout_consents ADD COLUMN price_mismatch_at INTEGER;
