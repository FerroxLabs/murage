-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Durable capture-completion state (refund-identity.ts, Astra ASTRA-REFUND3 #1). A first payment identity read is SETTLED once Stripe
-- showed the payment itself, or its keys are complete (a card or billing identity). A payment whose capture is not settled (Stripe could
-- not show it: only the account or customer email is recorded) is never judged "first" on what is recorded, however long ago it was paid:
-- its own 7-day request stays pending and reads Stripe again on every retry until the read settles. The capture grace period and the
-- 14-day enrichment period no longer decide it (they only stop an unreadable payment from holding up requests of OTHER customers).
-- refund_identity_captures is append-only (the source of its first read never changes), so the settled state is its own append-only table.
-- Purged with the other records of the payment after 24 months.
CREATE TABLE refund_identity_settled (
  invoice_id TEXT PRIMARY KEY,
  paid_at INTEGER NOT NULL,
  settled_at INTEGER NOT NULL
);
CREATE INDEX refund_identity_settled_paid ON refund_identity_settled (paid_at);
-- Existing captures: settled when the payment itself was read, or a card or billing key was recorded. An unreadable capture with neither
-- is left unsettled (its enrichment may have expired unread): its own request reads Stripe again before it is decided.
INSERT INTO refund_identity_settled (invoice_id,paid_at,settled_at)
  SELECT c.invoice_id,c.paid_at,c.captured_at FROM refund_identity_captures c
  WHERE c.source<>'unreadable' OR EXISTS (SELECT 1 FROM refund_identity_keys k WHERE k.invoice_id=c.invoice_id AND k.kind IN ('card','billing'));
CREATE TRIGGER refund_identity_settled_append_only BEFORE UPDATE ON refund_identity_settled
BEGIN SELECT RAISE(ABORT, 'refund_identity_settled_append_only'); END;
