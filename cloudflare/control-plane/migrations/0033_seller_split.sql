-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Seller split (Sean, 2026-10-10): outside the US, Link (by Stripe) is the merchant of record through Managed Payments, which always uses
-- Adaptive Pricing (the price can be presented and charged in local currency). The currency Stripe actually charged at checkout is kept
-- with the consent, so the confirmation email states the amount the customer saw, never a USD figure they did not.
-- (The seller itself is the consent's tax_source: 'managed_payments' = Link, anything else = Ferrox Labs.)
ALTER TABLE checkout_consents ADD COLUMN charged_currency TEXT;
-- Refunds Link makes on its own (it may refund within 60 days under its own terms) are recorded in the refund ledger as kind 'external'.
