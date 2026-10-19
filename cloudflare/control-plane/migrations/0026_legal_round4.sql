-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 3 (review of 2939441b7): cancellation ownership, the trial-move checkpoint, the fallback-consent confirmation on Stripe's page,
-- per-item backoff and dead-letter for notices and terms enforcement, and a durable queue of change-notice obligations.
ALTER TABLE billing_subscriptions ADD COLUMN customer_cancel_at INTEGER;      -- the customer asked to cancel (never undone by re-acceptance)
ALTER TABLE checkout_consents ADD COLUMN trial_moved_at INTEGER;             -- region hold: the trial move to day 15 is checkpointed
ALTER TABLE checkout_consents ADD COLUMN fallback_confirmed_total_cents INTEGER; -- fallback consent: the total the customer confirmed on Stripe's page
ALTER TABLE terms_change_notices ADD COLUMN enforce_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE terms_change_notices ADD COLUMN enforce_next_at INTEGER;
ALTER TABLE terms_change_notices ADD COLUMN enforce_dead_at INTEGER;
ALTER TABLE billing_notices ADD COLUMN dead_at INTEGER;
-- Every change notice owed, queued independently of its delivery (so an undeliverable one never holds back the next customer).
CREATE TABLE terms_notice_obligations (
  user_id TEXT NOT NULL,
  cloud_terms_version TEXT NOT NULL,
  tos_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  home_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  dead_at INTEGER,
  delivered_at INTEGER,
  PRIMARY KEY (user_id, cloud_terms_version, tos_version, privacy_version)
);
CREATE INDEX terms_notice_obligations_due ON terms_notice_obligations(next_attempt_at) WHERE delivered_at IS NULL AND dead_at IS NULL;
