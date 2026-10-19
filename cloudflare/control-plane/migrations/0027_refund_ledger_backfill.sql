-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Carries refund accounting written before 0024 into the per-payment ledger, and marks unfinished pre-0024 refund operations as possibly
-- submitted, so they are settled from Stripe (by their op_id metadata) before any new submission. Data only and re-runnable.
INSERT INTO refund_invoice_ledger (invoice_id, version, decided_cents)
  SELECT invoice_id, 1, SUM(amount_cents) FROM refund_ops WHERE invoice_id IS NOT NULL AND decided_at IS NOT NULL GROUP BY invoice_id
  ON CONFLICT(invoice_id) DO UPDATE SET decided_cents=excluded.decided_cents, version=refund_invoice_ledger.version+1
  WHERE refund_invoice_ledger.decided_cents<>excluded.decided_cents;
UPDATE refund_ops SET submitted_at=COALESCE(submitted_at, updated_at)
  WHERE done_at IS NULL AND refunded_at IS NULL AND decided_at IS NOT NULL AND COALESCE(amount_cents,0)>0 AND stripe_refund_id IS NULL;
