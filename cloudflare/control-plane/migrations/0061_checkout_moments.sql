-- Cloud checkout WP5: the three moments of an order, apart (STRIPE-HOSTED-PLAN r13c §3.3), the deadlines they start (§4.1), the guard's tombstones
-- and the retry route (§1.1, §1.2). start_request_at already exists (0067, WP4): not added again. The server-start moment is
-- billing_subscriptions.service_start_at (written once, at paid_at).
--   completed_at (existing)  the customer submitted the Stripe page: contract made, payment may be pending -> statutory_withdraw_until
--   paid_at                  payment_status=paid, or the later async_payment_succeeded                   -> provisioning, guarantee, refund7_until
-- Every deadline is written once (COALESCE guard) and never moved. AoE = 23:59:59 UTC-12, inclusive days.
ALTER TABLE checkout_consents ADD COLUMN paid_at INTEGER;
ALTER TABLE checkout_consents ADD COLUMN statutory_withdraw_until INTEGER;
ALTER TABLE checkout_consents ADD COLUMN guarantee_withdraw_until INTEGER;
ALTER TABLE checkout_consents ADD COLUMN refund7_until INTEGER;
ALTER TABLE checkout_consents ADD COLUMN payment_failed_at INTEGER;   -- async_payment_failed: the order stands, the payment did not clear
ALTER TABLE checkout_consents ADD COLUMN rejected_at INTEGER;         -- the guard turned this order away (renewal dropdown, country mismatch, paused country)
ALTER TABLE checkout_consents ADD COLUMN rejected_reason TEXT;        -- 'rejected_consent' | 'mismatch' | 'country_paused'

-- A subscription the guard cancelled. Every later event about it is ignored: it never provisions, renews or ends anything of the home's.
CREATE TABLE rejected_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reason TEXT
);

-- After a mismatch the next reserve pre-fills the country line with Stripe's collected country (plan §1.2). WP6 adds 'address_change' rows.
CREATE TABLE checkout_retry_routes (
  account_id TEXT PRIMARY KEY,
  seller TEXT NOT NULL,
  collected_country TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('mismatch','address_change')),
  replaces_subscription_id TEXT,
  expires_at INTEGER NOT NULL
);

-- The completion could not record the order acceptance (no acceptance line on record): never invented, never retried forever. The consent is
-- parked with one alert until it is repaired and its completion replayed (b5-billing.ts releaseParkedAcceptance).
ALTER TABLE checkout_consents ADD COLUMN acceptance_parked_at INTEGER;
-- A checkout acceptance is final once normalised_at is set: written with every acceptance the completion inserts, and by the one-time
-- normalisation of a pre-r1 row (accepted_at = created_at of the consent). Once-only even when the completion time equals created_at.
ALTER TABLE terms_acceptances ADD COLUMN normalised_at INTEGER;

-- One-time backfill (a populated upgrade): a completed consent whose own subscription has a verified first payment (first_paid_at, written by
-- the signed invoice.paid webhook) has paid at that moment. Matched by subscription id only (never the home current row for another
-- subscription). Deadlines are not backfilled: a consent without stored deadlines keeps the rules it was sold under.
UPDATE checkout_consents SET paid_at=(SELECT b.first_paid_at FROM billing_subscriptions b WHERE b.subscription_id=checkout_consents.stripe_subscription_id)
WHERE paid_at IS NULL AND completed_at IS NOT NULL AND stripe_subscription_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM billing_subscriptions b WHERE b.subscription_id=checkout_consents.stripe_subscription_id AND b.first_paid_at IS NOT NULL);
