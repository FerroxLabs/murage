-- Cloud checkout WP3 r4 (Astra WP3-4 #1): a Stripe credit note and every refund it carries (or one Managed Payments refund) belong to
-- exactly ONE ledger operation. Metadata on a note or refund can be edited by anyone with Dashboard access, so it never decides ownership by
-- itself: an operation adopts an object only by claiming it here, inside the same fenced batch as its checkpoint, and a claim held by another
-- operation leaves the operation pending (last_error = attribution_unresolved) with an ops alert. The primary key makes the binding exclusive.
CREATE TABLE IF NOT EXISTS refund_object_claims (
  object_id TEXT PRIMARY KEY,                                                -- cn_... or re_...
  object_kind TEXT NOT NULL CHECK (object_kind IN ('credit_note', 'refund')),
  op_id TEXT NOT NULL,                                                       -- refund_ops.id
  claimed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refund_object_claims_op ON refund_object_claims (op_id);
-- Cloud checkout WP3 r5 (Astra WP3-5 #1): an operation whose Stripe objects cannot be attributed to it alone is HELD. A held operation is
-- never submitted, never followed to success and never completed until a person clears the hold (attribution_hold = 0).
ALTER TABLE refund_ops ADD COLUMN attribution_hold INTEGER NOT NULL DEFAULT 0;
-- Cloud checkout WP3 r6 (Astra WP3-6 #4): when the attribution reconciliation looks at a held operation next (its own schedule).
ALTER TABLE refund_ops ADD COLUMN attribution_next_at INTEGER;
-- Cloud checkout WP3 r6 (Astra WP3-6 #2): 1 = a success or completion recorded on a credit note before this migration, never validated as a
-- whole note (one refund carrying exactly the decided amount). It is honoured only after that validation; an invalid one is quarantined.
ALTER TABLE refund_ops ADD COLUMN note_reconcile INTEGER NOT NULL DEFAULT 0;
-- What this migration (and the runtime ownership check) took away from a held operation, kept for the person who resolves it.
CREATE TABLE IF NOT EXISTS refund_attribution_quarantine (
  op_id TEXT PRIMARY KEY,                                                    -- refund_ops.id
  home_id TEXT NOT NULL,
  reason TEXT NOT NULL,                                                      -- duplicate_object | unresolved_before_0070 | claimed_elsewhere
  credit_note_id TEXT,                                                       -- the ids and dates the operation held before it was quarantined
  stripe_refund_id TEXT,
  refunded_at INTEGER,
  done_at INTEGER,
  quarantined_at INTEGER NOT NULL,
  released_at INTEGER                                                        -- set when attribution was proven and the hold cleared (WP3-6 #4)
);
-- Duplicates written before claims existed (Astra WP3-5 #1, WP3-6 #1). Two operations recording the same credit note or the same refund
-- cannot both be paid by it, and NOTHING in the database proves which one it belongs to: creation order does not (an older stalled operation
-- can adopt a newer one's payout), and the recorded ids are what is in dispute. So EVERY conflicting claimant is quarantined: its success and
-- completion are cleared (refunded_at, done_at, the Stripe ids and states), its withdrawal goes back to processing, it is held, the home's
-- attribution alert names it, and none of them is given a claim below. Ownership is then settled only by independent attribution read from
-- Stripe (reconcileAttributionHolds in legal-refunds.ts: the object names the operation and its recorded submission number, carries exactly
-- its decided amount in one refund, for its home's invoice and payment on its path), which restores the owner and clears its hold. The
-- quarantine rows are written first, so later statements never see a half-applied state.
INSERT OR IGNORE INTO refund_attribution_quarantine (op_id, home_id, reason, credit_note_id, stripe_refund_id, refunded_at, done_at, quarantined_at)
  SELECT l.id, l.home_id, 'duplicate_object', l.credit_note_id, l.stripe_refund_id, l.refunded_at, l.done_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM refund_ops l WHERE EXISTS (SELECT 1 FROM refund_ops w WHERE w.id <> l.id
    AND ((l.credit_note_id IS NOT NULL AND w.credit_note_id = l.credit_note_id) OR (l.stripe_refund_id IS NOT NULL AND w.stripe_refund_id = l.stripe_refund_id)));
UPDATE refund_ops SET refunded_at = NULL, done_at = NULL, credit_note_id = NULL, stripe_refund_id = NULL, refund_submitted_at = NULL, refund_status = NULL,
  stripe_refund_status = NULL, submission_reconcile = 0, attribution_hold = 1, last_error = 'attribution_unresolved',
  next_attempt_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE attribution_hold = 0 AND id IN (SELECT op_id FROM refund_attribution_quarantine WHERE reason = 'duplicate_object');
-- An operation the round-4 code already left unresolved (its importer or its own recovery found a note it could not attribute) is held too
-- (Astra WP3-5 #2): unheld, a later pass could still complete it on whatever it finds then.
INSERT OR IGNORE INTO refund_attribution_quarantine (op_id, home_id, reason, credit_note_id, stripe_refund_id, refunded_at, done_at, quarantined_at)
  SELECT id, home_id, 'unresolved_before_0070', credit_note_id, stripe_refund_id, refunded_at, done_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM refund_ops WHERE done_at IS NULL AND last_error = 'attribution_unresolved';
UPDATE refund_ops SET attribution_hold = 1
WHERE attribution_hold = 0 AND id IN (SELECT op_id FROM refund_attribution_quarantine WHERE reason = 'unresolved_before_0070');
UPDATE withdrawals SET status = 'processing', stripe_refund_id = NULL
WHERE status = 'completed' AND refund_op_id IN (SELECT op_id FROM refund_attribution_quarantine WHERE reason = 'duplicate_object');
-- The home's ONE open attribution alert names every held operation. An alert already open (raised by the round-4 code) has the new names
-- merged in and is delivered again. A home with none gets one.
UPDATE cloud_alerts SET detail = json_set(CASE WHEN json_valid(detail) THEN detail ELSE '{}' END, '$.opIds', json((
    SELECT json_group_array(x) FROM (
      SELECT j.value AS x FROM json_each(CASE WHEN json_valid(cloud_alerts.detail)
        THEN COALESCE(json_extract(cloud_alerts.detail, '$.opIds'), json_array(json_extract(cloud_alerts.detail, '$.opId'))) ELSE '[]' END) j WHERE j.value IS NOT NULL
      UNION SELECT qq.op_id FROM refund_attribution_quarantine qq WHERE qq.home_id = cloud_alerts.home_id))),
  '$.source', 'migration_0070'), delivered_at = NULL, delivery_attempts = 0
WHERE kind = 'refund.attribution_unresolved' AND resolved_at IS NULL AND home_id IN (SELECT home_id FROM refund_attribution_quarantine);
INSERT INTO cloud_alerts (id, home_id, kind, severity, detail, raised_at)
  SELECT 'alert:attribution:' || qa.home_id || ':0070', qa.home_id, 'refund.attribution_unresolved', 'high',
    json_object('opId', MIN(qa.op_id), 'opIds', json(json_group_array(qa.op_id)), 'error', 'attribution_unresolved', 'source', 'migration_0070'), MAX(qa.quarantined_at)
  FROM refund_attribution_quarantine qa
  WHERE NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id = qa.home_id AND a.kind = 'refund.attribution_unresolved' AND a.resolved_at IS NULL)
  GROUP BY qa.home_id
  ON CONFLICT DO NOTHING;
-- Legacy credit-note successes (Astra WP3-6 #2): a refunded_at or done_at written on a note before this migration may rest on one refund of
-- a split note (500¢ succeeded + 1,950¢ failed on a 2,450¢ operation). Each is marked; the ledger validates the whole note before it
-- honours the success again, and quarantines and reopens it when the note does not carry exactly the decided amount in one refund.
UPDATE refund_ops SET note_reconcile = 1
WHERE credit_note_id IS NOT NULL AND (refunded_at IS NOT NULL OR done_at IS NOT NULL) AND attribution_hold = 0;
-- Every object an operation still holds is its claim (after the quarantine above, at most one operation holds each object).
INSERT OR IGNORE INTO refund_object_claims (object_id, object_kind, op_id, claimed_at)
  SELECT credit_note_id, 'credit_note', id, updated_at FROM refund_ops WHERE credit_note_id IS NOT NULL ORDER BY created_at, id;
INSERT OR IGNORE INTO refund_object_claims (object_id, object_kind, op_id, claimed_at)
  SELECT stripe_refund_id, 'refund', id, updated_at FROM refund_ops WHERE stripe_refund_id IS NOT NULL ORDER BY created_at, id;
