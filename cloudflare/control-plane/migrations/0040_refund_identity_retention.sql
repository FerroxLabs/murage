-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Refund-identity retention (Sean, 2026-10-10): the keyed hashes of a payment, and the claims made from them, are kept for 24 months
-- from that payment, also after the account is closed, then purged by the billing sweep (refund-identity.ts purgeRefundIdentity).
-- They are pseudonymous personal data (keyed hashes: they cannot be turned back, but they still single out a payer), kept on the basis
-- of a legitimate interest (one voluntary refund per person). After 24 months that payment is forgotten: the one-per-person rule then no
-- longer sees it, which is the price of finite retention and is what the terms and privacy policy say. The sweep never captures a payment
-- older than 24 months, so a purged payment is never recorded again.
CREATE INDEX refund_identity_keys_paid ON refund_identity_keys (paid_at);
CREATE INDEX refund_identity_captures_paid ON refund_identity_captures (paid_at);
