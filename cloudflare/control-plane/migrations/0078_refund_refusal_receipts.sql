-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The receipt of a 7-day request refused at request time as "not your first payment" (Astra ASTRA-REFUND6 #4). Such a request opens no
-- refund operation, so without this its receipt time was lost: once the refusal became obsolete (the codes it rested on erased on an
-- upheld objection) the customer had to ask again and, after day 7, got window_expired for a request that was on time. The receipt is
-- kept here (one per payment; the first one stands). When an erasure decided after the receipt touches someone the refusal rested on
-- (rested_on: their user ids, a JSON array) the billing sweep checks it once (checked_at) and, if the refusal no longer stands, reopens
-- the request as a pending refund operation dated at the original receipt (op_id, reopened_at); it is then decided as of that time.
-- Asking again while the refusal does not stand (held under an open objection, or obsolete after such an erasure) reopens it the same way.
-- Purged with the refund-identity records at the 24-month retention.
CREATE TABLE refund_refusal_receipts (
  invoice_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  rested_on TEXT NOT NULL DEFAULT '[]',
  checked_at INTEGER,
  reopened_at INTEGER,
  op_id TEXT
);
CREATE INDEX refund_refusal_receipts_open ON refund_refusal_receipts (reopened_at, received_at);
