-- Cloud checkout WP3: the refund ledger carries the new refund kinds (mismatch, country_paused, rejected_consent, cutover,
-- cancellation_late, extraordinary) and keeps three things apart: SUBMITTED (the Stripe refund or credit note exists; refund_submitted_at is the
-- only date promised), SUCCEEDED (Stripe says so; stripe_refund_status / refunded_at) and the customer's bank (not visible to us).
ALTER TABLE refund_ops ADD COLUMN refund_submitted_at INTEGER;   -- when the refund (or credit note) was created at Stripe; written once, cleared only by a failed refund
ALTER TABLE refund_ops ADD COLUMN stripe_refund_status TEXT;     -- Stripe's own state of the refund: pending | requires_action | succeeded | failed | canceled
ALTER TABLE refund_ops ADD COLUMN cutover_at INTEGER;            -- frozen at ownership change (cutover) or at the effective time of an accepted termination (extraordinary)
ALTER TABLE refund_ops ADD COLUMN old_invoice_id TEXT;           -- frozen: the invoice the fraction applies to
ALTER TABLE refund_ops ADD COLUMN old_period_start INTEGER;      -- frozen: that invoice's period
ALTER TABLE refund_ops ADD COLUMN old_period_end INTEGER;
ALTER TABLE refund_ops ADD COLUMN presentment_json TEXT;         -- USD request, Stripe's refund id, presentment_details and the tax portion, as Stripe reported them
ALTER TABLE refund_ops ADD COLUMN credit_note_id TEXT;           -- direct path: the credit note (Stripe Tax reversal) that carries the refund
-- 1 = the submission date of this row is not confirmed from Stripe yet (a row written before this migration). The refund sweep reads the
-- refund at Stripe and records its created time and current state, then clears it. Rows written by the WP3 code never need it.
ALTER TABLE refund_ops ADD COLUMN submission_reconcile INTEGER NOT NULL DEFAULT 0;
-- The reconciliation's own retry schedule (Astra WP3-2 #6): a refund Stripe cannot show now (an error, a 404) is retried with backoff and
-- goes to the back of the queue, so it never starves the rows behind it; repeated misses (a permanent 404) are escalated to ops.
ALTER TABLE refund_ops ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refund_ops ADD COLUMN reconcile_next_at INTEGER;
ALTER TABLE refund_ops ADD COLUMN reconcile_error TEXT;
-- Backfill of rows that already hold a Stripe refund (Astra WP3-1 #6). The Stripe state is copied from what was recorded (refund_status, and a
-- finished refund, refunded_at, is succeeded). The submission date is never the old intent time (submitted_at, written BEFORE the call):
-- a succeeded refund provisionally takes refunded_at (it certainly existed at Stripe then), an unfinished one stays empty, and every such
-- row is marked for the sweep, which replaces either with the created time of the refund at Stripe.
UPDATE refund_ops SET
  stripe_refund_status = COALESCE(stripe_refund_status, CASE WHEN refunded_at IS NOT NULL THEN 'succeeded' ELSE refund_status END),
  refund_submitted_at = COALESCE(refund_submitted_at, CASE WHEN refunded_at IS NOT NULL AND COALESCE(refund_status, 'succeeded') NOT IN ('failed', 'canceled') THEN refunded_at END),
  submission_reconcile = 1
WHERE stripe_refund_id IS NOT NULL;
-- Rows whose refund failed or was canceled had their refund id cleared by the failure transition: their recorded state is copied too,
-- independently of the id (Astra WP3-2 #6). Nothing is left to read at Stripe for them, so they are not marked.
UPDATE refund_ops SET stripe_refund_status = refund_status
WHERE stripe_refund_id IS NULL AND stripe_refund_status IS NULL AND refund_status IS NOT NULL;
