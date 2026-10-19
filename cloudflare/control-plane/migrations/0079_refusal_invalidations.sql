-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Which erasure invalidated which request-time refusal (Astra ASTRA-REFUND7 #3). A refusal receipt (0078) is reopened ONLY on such an
-- event, never because some past erasure and today's absent matches happen to coincide (codes that merely aged out are no grounds).
-- The event is written in the SAME batch as the "erase" decision, judged right after the erasure: for every open receipt that names the
-- erased person (the asker, or one of rested_on) whose refusal no longer stands, one row. held=1 when the refusal does not stand only
-- because it is restricted by another open objection: every later objection decision re-judges held rows in its own batch (stands again:
-- the row is deleted, the erasure did not invalidate it; neither stands nor restricted: held=0). The billing sweep and a request asked
-- again reopen a receipt with a held=0 row. Rows of purged receipts are purged with them. Receipts written before this migration have no
-- events (0078 has not been deployed), so none is backfilled; refund_refusal_receipts.checked_at is no longer used.
CREATE TABLE refund_refusal_invalidations (
  invoice_id TEXT NOT NULL,
  erased_user_id TEXT NOT NULL,
  erased_through INTEGER NOT NULL,
  held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0,1)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, erased_user_id)
);
CREATE INDEX refund_refusal_invalidations_due ON refund_refusal_invalidations (held, invoice_id);
