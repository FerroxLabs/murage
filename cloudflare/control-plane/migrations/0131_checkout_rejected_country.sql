-- The country Stripe collected for an order the guard turned away (checkout_consents.rejected_reason says why). Until now it only lived in the
-- checkout.<verdict> alert detail; the member-facing refusal (GET /v1/account/home and /v1/account/order, "refused") names it, so it is kept
-- with the consent. ISO-2, uppercase; NULL when the order was refused without one (a missing billing country) and for older rows.
ALTER TABLE checkout_consents ADD COLUMN rejected_collected_country TEXT;
