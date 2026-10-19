-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra round 9. Service actually supplied is recorded PER SUBSCRIPTION (the contract it was supplied under): a withdrawal deducts only
-- the service supplied under its own contract, never a predecessor's. Existing rows are tied to the home's retained subscription when it
-- already existed when the interval started; anything else stays NULL, and NULL rows are never counted for a contract.
ALTER TABLE service_intervals ADD COLUMN subscription_id TEXT;
UPDATE service_intervals SET subscription_id=(SELECT b.subscription_id FROM billing_subscriptions b
  WHERE b.home_id=service_intervals.home_id AND b.created_at<=service_intervals.started_at);
CREATE INDEX service_intervals_sub ON service_intervals(subscription_id, started_at);
-- A subscription mutation whose request Stripe answered with a failure keeps that answer (status, code, whether it was replayed from Stripe's
-- idempotency cache, request id): the mutation is superseded and the intent is carried out with a fresh key.
ALTER TABLE sub_mutations ADD COLUMN provider_error TEXT;
-- The first-invoice payment is journaled before /pay is sent: a payment that completes after the contract ended is found and refunded.
ALTER TABLE first_invoice_holds ADD COLUMN pay_requested_at INTEGER;
