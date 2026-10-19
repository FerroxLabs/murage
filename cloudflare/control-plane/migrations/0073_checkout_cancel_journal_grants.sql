-- Cloud checkout WP5 r3 (ASTRA-WP5-3 #2). 0073: the next free number (0069-0072 are taken by other packages, and earlier files are not edited).
-- The cancellation of a rejected, UNPAID order is journaled with its tombstone, in the same batch as the rejection, BEFORE Stripe is asked:
-- cancel_pending=1 until Stripe confirms the cancellation (cancel_confirmed_at). The billing sweep retries every pending row under the home's
-- lease, so a cancellation that failed is never lost. home_id is the lease the retry takes.
-- Edited in place (Astra WP5-4 #2, WP5-5 #2): this file was created in this branch and has never been applied anywhere.
ALTER TABLE rejected_subscriptions ADD COLUMN home_id TEXT;
ALTER TABLE rejected_subscriptions ADD COLUMN cancel_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rejected_subscriptions ADD COLUMN cancel_confirmed_at INTEGER;
CREATE INDEX IF NOT EXISTS rejected_subscriptions_cancel_pending ON rejected_subscriptions(cancel_pending) WHERE cancel_pending=1;
-- One-time reconciliation of rows written before these columns (Astra WP5-4 #2). An older rejection whose cancellation failed at Stripe was
-- left with no retry, so the subscription may still be billable. First the home is filled in from the order that bought the subscription
-- (its consent), else from the refund operation that names it.
UPDATE rejected_subscriptions SET home_id=COALESCE(
  (SELECT c.home_id FROM checkout_consents c WHERE c.stripe_subscription_id=rejected_subscriptions.subscription_id ORDER BY c.created_at DESC LIMIT 1),
  (SELECT r.home_id FROM refund_ops r WHERE r.subscription_id=rejected_subscriptions.subscription_id OR r.cancel_subscription_id=rejected_subscriptions.subscription_id ORDER BY r.created_at LIMIT 1))
WHERE home_id IS NULL;
-- Then every older rejection is queued: the sweep asks Stripe to cancel it (no proration, no invoice) and clears the row once Stripe confirms.
-- SQL cannot tell which old cancellation failed, so all are queued; asking again about a subscription that is already cancelled only
-- confirms it. A failed asynchronous payment is skipped: its cancellation was confirmed before its row was written.
UPDATE rejected_subscriptions SET cancel_pending=1
WHERE cancel_pending=0 AND cancel_confirmed_at IS NULL AND home_id IS NOT NULL AND COALESCE(reason,'')<>'async_payment_failed';
-- A row whose home cannot be found cannot be retried by the sweep (it works under the home's lease): ops is told in ONE alert that lists
-- every such subscription (Astra WP5-5 #2). cloud_alerts keeps one open alert per home and kind, and all of these share home 'billing', so
-- one row per subscription would keep only the first. This kind is new in this file, so no open alert of it exists before it runs.
INSERT OR IGNORE INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
SELECT 'alert:rejected_cancel_no_home','billing','checkout.rejected_cancel_no_home','high',
  json_object('subscriptionId',first_id,'subscriptionIds',json(ids)),CAST(strftime('%s','now') AS INTEGER)*1000
FROM (SELECT COUNT(*) AS n, MIN(subscription_id) AS first_id, json_group_array(subscription_id) AS ids
  FROM (SELECT subscription_id FROM rejected_subscriptions
    WHERE home_id IS NULL AND cancel_confirmed_at IS NULL AND COALESCE(reason,'')<>'async_payment_failed' ORDER BY subscription_id))
WHERE n>0;
-- Not reconciled here: credits granted before credit_grants existed. Whether an old invoice was granted is known only from B4's own history,
-- so those are left as they are (an absent row below does not mean a credit was granted twice).
-- ASTRA-WP5-3 #3: monthly credit is granted once per invoice and kind (period, upgrade_delta), however many Stripe events report that
-- invoice (Stripe may send distinct Event objects for one invoice). claimed_at is written before the B4 grant is asked for, granted_at in
-- the same batch as the period it grants. A row with granted_at set is never granted again. A claim without granted_at (an interruption
-- between the grant and its record) is asked again under the same (invoice_id, kind), which B4 applies at most once.
CREATE TABLE IF NOT EXISTS credit_grants (
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  home_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  granted_at INTEGER,
  PRIMARY KEY (invoice_id, kind)
);
-- Astra WP5-6 #1: a refunded payment never provisions a home. A rejection writes one tombstone per payment it turns away (the order's
-- invoice and its checkout session), in the same fenced batch as the rejection. The lifecycle (b3-control processPayments) skips a "paid"
-- inbox entry whose (home, paymentId) is tombstoned, and re-checks the tombstone inside its own write, so an entry it read before the
-- rejection still grants nothing. Inbox entries are never deleted; only this home's entries for this payment are affected.
CREATE TABLE IF NOT EXISTS cloud_payment_voids (
  home_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  voided_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, payment_id)
);
-- Astra WP5-6 #2: a refunded invoice keeps no credit. Each grant of that invoice (credit_grants, one per invoice and kind) gets ONE reversal
-- row, journaled in the same batch as the rejection: requested_at (asked for), reversed_at (B4 confirmed it took back what was unused of that
-- grant). B4's revokeCredits applies a grant id at most once, never touches consumed credit, prepaid funds or any other grant. A row stays
-- pending (attempts, last_error) until B4 confirms; the billing sweep retries it, independently of the refund, which goes ahead regardless.
CREATE TABLE IF NOT EXISTS credit_reversals (
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  home_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  op_id TEXT,
  requested_at INTEGER NOT NULL,
  reversed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (invoice_id, kind)
);
CREATE INDEX IF NOT EXISTS credit_reversals_pending ON credit_reversals(home_id) WHERE reversed_at IS NULL;
