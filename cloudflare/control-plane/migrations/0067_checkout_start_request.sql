-- Cloud checkout WP4: the moment the customer pressed the one button on our page (STRIPE-HOSTED-PLAN r13c §3.1). WP5 writes the other
-- consent moments (paid_at, ...) and must NOT add this column again.
ALTER TABLE checkout_consents ADD COLUMN start_request_at INTEGER;
