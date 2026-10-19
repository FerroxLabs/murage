-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 4: ONE per-home serializer for every billing operation (the cloud-v2/b4 pattern: a D1 lease, fenced writes).
CREATE TABLE billing_home_leases (
  home_id TEXT PRIMARY KEY,
  holder TEXT,
  lease_until INTEGER
);
-- Cancellation intent, revisioned: the customer's own (customer_cancel_at) and terms non-acceptance (terms_change_notices) both feed one
-- desired state; a sync is complete only when Stripe reads back that state for the same revision.
ALTER TABLE billing_subscriptions ADD COLUMN cancel_intent_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_subscriptions ADD COLUMN cancel_synced_rev INTEGER NOT NULL DEFAULT 0;
-- A refund operation that ends a plan ends THAT subscription only (a replacement contract is never suppressed).
ALTER TABLE refund_ops ADD COLUMN subscription_id TEXT;
UPDATE refund_ops SET subscription_id=(SELECT b.subscription_id FROM billing_subscriptions b WHERE b.home_id=refund_ops.home_id)
  WHERE end_plan=1 AND subscription_id IS NULL;
-- Delayed start: the recurring total including tax the customer agreed to (quote, or Stripe's page on the fallback), checked before day 15.
ALTER TABLE checkout_consents ADD COLUMN agreed_recurring_cents INTEGER;
ALTER TABLE checkout_consents ADD COLUMN preflight_at INTEGER;
