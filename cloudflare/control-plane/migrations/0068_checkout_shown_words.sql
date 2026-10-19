-- Cloud checkout WP4 r1 (ASTRA-WP4-1 P1-3, P1-4). 0068 because 0059-0067 are taken by other packages; 0067 is not edited.
-- start_request_text: the Murage button label the customer pressed on our page, in the site language ("Start my server and continue to payment" /
-- "Server starten und weiter zur Zahlung", STRIPE-HOSTED-PLAN r13c §3.1). Stripe's own order-button words stay in button_text. NULL for a
-- consent recorded before this column (its wording column keeps what that older screen showed).
ALTER TABLE checkout_consents ADD COLUMN start_request_text TEXT;
-- The terms are accepted at order completion, once per consent (recordAcceptanceAtCompletion): one acceptance row per checkout consent.
-- Rows written before r1 are one per consent already (each checkout recorded a fresh consent id); reaccept rows carry no consent_id.
CREATE UNIQUE INDEX IF NOT EXISTS terms_acceptances_consent ON terms_acceptances(consent_id) WHERE consent_id IS NOT NULL;
