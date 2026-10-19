-- Cloud checkout WP6 r1-5: the frozen cutover boundary of every replaced subscription, written in the cutover batch even when nothing is
-- owed (zero cents remaining, or no paid invoice covering the payment time). A delayed old-plan invoice is classified against it
-- (checkout-replacement.ts classifyReplacedInvoice), never refunded in full by default.
-- WP6 r2: replacement_subscription_id NULL = the successor is UNKNOWN (never guessed from the home's current subscription). source says where
-- the row came from: 'cutover' (the cutover batch), 'refund_op' (a pre-0071 cutover refund operation), 'payment_event' (a pre-0071 cutover
-- with nothing owed, recovered from the original replacement payment event; its old invoice is unknown, so old_invoice_id stays NULL).
CREATE TABLE IF NOT EXISTS replacement_cutovers (
  old_subscription_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  replacement_subscription_id TEXT,
  cutover_at INTEGER NOT NULL,
  old_invoice_id TEXT,
  old_period_start INTEGER,
  old_period_end INTEGER,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'cutover'
);
-- Every ADOPTED replacement payment on record (checkout.session.completed paid at completion, or async_payment_succeeded): the old
-- subscription it names in metadata.replaces, the replacement subscription it pays for, and its paid moment (the event's created, exactly the
-- cutover_at the cutover froze). Read by this backfill and by the runtime recovery (b5-billing.ts recoverCutoverBoundary).
-- WP6 r3-1: a paid event alone proves no cutover. Only COMMITTED replacement evidence counts: the cutover batch's own "replacement done"
-- obligation for exactly that home and that replacement subscription (billing_notices replacement_done:<home>:<sub>, written in the same batch
-- as the cutover); a replacement subscription rejected for any other reason (a refunded duplicate, a failed or unrecoverable attempt) is
-- excluded; and a paid moment the order itself recorded differently (checkout_consents.paid_at) disqualifies the event.
CREATE VIEW IF NOT EXISTS replacement_payment_events AS
  SELECT e.old_subscription_id, e.home_id, e.replacement_subscription_id, e.paid_at FROM (
    SELECT json_extract(payload,'$.data.object.metadata.replaces') AS old_subscription_id,
      COALESCE(json_extract(payload,'$.data.object.metadata.home_id'), json_extract(payload,'$.data.object.client_reference_id')) AS home_id,
      COALESCE(json_extract(payload,'$.data.object.subscription.id'), json_extract(payload,'$.data.object.subscription')) AS replacement_subscription_id,
      json_extract(payload,'$.created') * 1000 AS paid_at,
      json_extract(payload,'$.data.object.metadata.consent_id') AS consent_id
    FROM stripe_events
    WHERE type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') AND json_valid(payload)
      AND json_extract(payload,'$.data.object.payment_status')='paid' AND json_extract(payload,'$.data.object.metadata.replaces') IS NOT NULL) e
  WHERE EXISTS (SELECT 1 FROM billing_notices n WHERE n.id='replacement_done:' || e.home_id || ':' || e.replacement_subscription_id AND n.home_id=e.home_id)
    AND NOT EXISTS (SELECT 1 FROM rejected_subscriptions r WHERE r.subscription_id=e.replacement_subscription_id AND COALESCE(r.reason,'')<>'replaced')
    AND NOT EXISTS (SELECT 1 FROM checkout_consents c WHERE c.id=e.consent_id AND c.paid_at IS NOT NULL AND c.paid_at<>e.paid_at);
-- Cutovers made before this table existed, with a refund owed: their boundary is the frozen values of their cutover refund operation. The
-- successor is the subscription the ORIGINAL replacement payment event (same old subscription, same paid moment) paid for, never the home's
-- current one (A->B->C stays A->B); NULL when that event is not on record or is not unique.
INSERT OR IGNORE INTO replacement_cutovers (old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end,created_at,source)
  SELECT r.subscription_id, r.home_id,
    (SELECT CASE WHEN COUNT(DISTINCT v.replacement_subscription_id)=1 THEN MIN(v.replacement_subscription_id) END FROM replacement_payment_events v
      WHERE v.old_subscription_id=r.subscription_id AND v.paid_at=r.cutover_at),
    r.cutover_at, r.old_invoice_id, r.old_period_start, r.old_period_end, r.created_at, 'refund_op'
  FROM refund_ops r WHERE r.kind='cutover' AND r.subscription_id IS NOT NULL AND r.cutover_at IS NOT NULL;
-- Cutovers made before this table existed with NOTHING owed (no refund operation): recovered from the original replacement payment event when
-- exactly one is on record (one successor, one paid moment, one home). Anything else stays unresolved: the runtime keeps such an old
-- invoice as a retryable reconciliation obligation (alert, never closed) until its refund is decided.
INSERT OR IGNORE INTO replacement_cutovers (old_subscription_id,home_id,replacement_subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end,created_at,source)
  SELECT t.subscription_id, MIN(v.home_id), MIN(v.replacement_subscription_id), MIN(v.paid_at), NULL, NULL, NULL, t.at, 'payment_event'
  FROM rejected_subscriptions t JOIN replacement_payment_events v ON v.old_subscription_id=t.subscription_id
  WHERE t.reason='replaced' AND v.home_id IS NOT NULL AND v.replacement_subscription_id IS NOT NULL AND v.paid_at IS NOT NULL
  GROUP BY t.subscription_id, t.at
  HAVING COUNT(DISTINCT v.replacement_subscription_id)=1 AND COUNT(DISTINCT v.paid_at)=1 AND COUNT(DISTINCT v.home_id)=1;
