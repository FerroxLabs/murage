-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One voluntary 7-day refund per person (refund-identity.ts): the claim that makes it atomic.
-- When a refund decision applies the voluntary 7-day offer to a payment, every identity key of that payment is claimed IN THE SAME D1 BATCH
-- that decides the amount. A key can be claimed by one payment only (primary key), so two accounts sharing a card, email or billing
-- identity cannot both get the offer: the second decision fails, decides again, and sees the first one's claim. The EU/UK 14-day full
-- refund and every other statutory or guaranteed refund never claims and never reads this table.
--   claimed_at  : when the offer was decided (the amount is fixed then; the ledger guarantees it is paid)
--   refunded_at : when Stripe confirmed the refund (a decided offer that is not yet paid is still a claim: it is never undone)
CREATE TABLE refund_identity_claims (
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  refunded_at INTEGER,
  PRIMARY KEY (kind, key_hash)
);
CREATE INDEX refund_identity_claims_invoice ON refund_identity_claims (invoice_id);
CREATE INDEX refund_identity_claims_op ON refund_identity_claims (op_id);
