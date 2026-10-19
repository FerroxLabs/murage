-- Murage Cloud: Stripe's own cancel_at (Unix ms) on the home's subscription row.
-- The public cancellation flow (§312k, public-cancellation.ts) ends a plan by setting cancel_at on the Stripe subscription; Stripe then
-- shows cancel_at set and cancel_at_period_end FALSE, so cancel_at_period_end (which mirrors Stripe's own flag and belongs to the in-app
-- Cancel plan path) never said the plan was ending, and the account page showed "next charge" after the confirmation email said it ends.
-- Written by the public flow when Stripe confirmed its cancel_at, and by customer.subscription.updated (never cleared there while an open,
-- synced public cancellation exists). Read by the account summary. NULL = Stripe shows no cancel_at.
-- Numbered 0092: 0091 is taken by 0091_flux_stops.sql on cloud-v2/flux-step2-core.
ALTER TABLE billing_subscriptions ADD COLUMN cancel_at INTEGER;

-- Astra CANCEL-SUMMARY-1 #3: the declaration revision a subscription mutation was computed for. decl_rev is '|' + each matched declaration
-- of the subscription as 'id:last_op' ('-' for no op), sorted by id, joined and closed by '|'; decl_n is how many there were. Every
-- transition writes a new last_op, so a mutation confirms the CURRENT state only while both still match (b5-billing.ts publicCancelEndSql).
-- NULL on rows written before this migration: they never count as current.
ALTER TABLE cancellation_stripe_mutations ADD COLUMN decl_rev TEXT;
ALTER TABLE cancellation_stripe_mutations ADD COLUMN decl_n INTEGER;
