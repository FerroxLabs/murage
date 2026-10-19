-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Which open refusal receipts an "erase" decision may affect, found from the CURRENT matching keys and claims (Astra ASTRA-REFUND8 #1),
-- not only from the frozen rested_on: a matching payment captured after the refusal (or a claim made since) is never named in rested_on.
-- Written in the SAME batch as the decision, BEFORE the codes are deleted (one row per receipt whose refusal has a qualifying match right
-- then, objections ignored), read after the deletion to record the invalidation events (0079), and deleted before the batch ends: a
-- committed batch leaves no row behind (scan_id is the decision's write-guard id).
CREATE TABLE refund_refusal_erasure_scan (
  scan_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (scan_id, invoice_id)
);
