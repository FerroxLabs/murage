-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Astra review of d3e987b9d (round 12), P3.
-- A reconciled paid invoice asks whether its payment was already applied (paidInvoiceApplied in b5-billing.ts): processed events about
-- the same Stripe object. Without an index that is a scan of the whole event history. A partial expression index (SQLite 3.9+, D1)
-- covers exactly that lookup: the object id inside the stored payload, processed events only. The query repeats the same expression
-- and the same processed_at IS NOT NULL condition, which is what lets SQLite use it.
CREATE INDEX stripe_events_processed_object ON stripe_events (json_extract(payload,'$.data.object.id')) WHERE processed_at IS NOT NULL;
