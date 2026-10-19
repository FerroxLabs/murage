-- Astra INTEGRATED-3 staging review (iii): 0096 backfilled THE Stripe-end checkpoint (billing_subscriptions.stripe_end_confirmed) on ended rows
-- with no open end obligation. That is inference from an absence, not Stripe's evidence, and one legacy shape had no open obligation while
-- Stripe never ended the subscription: a refund-coverage watch released (end_plan=0, never ended) because a refund operation of the same
-- payment carried canceled_at, which older code stamped on the LOCAL canceled status alone (no provider end call). For exactly that shape, and
-- only when no stored Stripe event shows the end (customer.subscription.deleted, or an update showing it canceled / incomplete_expired), the
-- watch is re-armed and the checkpoint cleared: the billing sweep's coverage reconciliation then asks Stripe itself, through the gateway, and
-- sets the checkpoint only on Stripe's answer. Every other row (a stored Stripe deletion, as in the failed-setup case) is left as it is.
UPDATE refund_coverage SET end_plan=1 WHERE end_plan=0 AND ended_at IS NULL AND subscription_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM billing_subscriptions b WHERE b.home_id=refund_coverage.home_id AND b.subscription_id=refund_coverage.subscription_id
    AND b.stripe_end_confirmed=b.subscription_id)
  AND EXISTS (SELECT 1 FROM refund_ops o WHERE o.home_id=refund_coverage.home_id AND o.payment_intent=refund_coverage.payment_intent AND o.kind<>'external'
    AND o.end_plan=1 AND o.subscription_id=refund_coverage.subscription_id AND o.canceled_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM stripe_events e WHERE json_valid(e.payload) AND json_extract(e.payload,'$.data.object.id')=refund_coverage.subscription_id
    AND (e.type='customer.subscription.deleted' OR (e.type='customer.subscription.updated'
      AND json_extract(e.payload,'$.data.object.status') IN ('canceled','incomplete_expired'))));
UPDATE billing_subscriptions SET stripe_end_confirmed=NULL WHERE stripe_end_confirmed IS NOT NULL AND stripe_end_confirmed=subscription_id
  AND EXISTS (SELECT 1 FROM refund_coverage w WHERE w.home_id=billing_subscriptions.home_id AND w.subscription_id=billing_subscriptions.subscription_id
    AND w.end_plan=1 AND w.ended_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM stripe_events e WHERE json_valid(e.payload) AND json_extract(e.payload,'$.data.object.id')=billing_subscriptions.subscription_id
    AND (e.type='customer.subscription.deleted' OR (e.type='customer.subscription.updated'
      AND json_extract(e.payload,'$.data.object.status') IN ('canceled','incomplete_expired'))));
