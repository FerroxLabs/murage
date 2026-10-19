-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Lane H1 (Flux on): THE GRANT FENCE. Flux refuses any grant mutation whose integer `revision` is below the highest it applied for that
-- grant id (409 stale_revision, no side effect); the same revision with the same body is a replay (the original 200); the same revision with
-- another body is 409 idempotency_mismatch. Every grant mutation this control plane sends (grant, reverse, reversal-target, B4 and B5 alike)
-- carries a revision allocated HERE, in D1, BEFORE the request leaves, under the grant's ONE owner row (b4-flux-ledger.ts R11,
-- flux-grant-fence.ts).
--  * flux_grant_fence: one row per Flux grant id (`invoice_id:kind`). Ownership is a compare-and-set claim with a fencing epoch (epoch rises on
--    every claim; an owner whose claim expired cannot allocate). next_revision only ever grows and is never below a revision Flux reported
--    as applied, so a revision is never reused and a later mutation (a restoration, a re-delivery) is always above every earlier one (every
--    revoke included). applied_revision is the highest revision Flux confirmed (a receipt, a stale answer, or the GET-state reconciliation).
--    needs_reconcile marks a grant whose last outcome is unknown (timeout, 5xx), superseded (stale_revision) or a mismatch: the billing and
--    Flux sweeps read GET state for it and record what Flux holds.
--    H3: a journaled revision that may have been dispatched (outcome NULL with its owner gone, or unknown) stays due a read-back until Flux
--    confirms it or applies a later one; it is never retired on an early read.
--  * flux_grant_revisions: the journal of every allocated revision: who allocated it (epoch, op), what it carried (the body hash without the
--    revision) and how it ended. A B5 target's logical revision below one already journaled for the grant is refused at allocation (H2), and
--    a B4 operator claim takes the grant's fence like any other owner and carries its allocated revision (H2).
CREATE TABLE flux_grant_fence (
  grant_id TEXT PRIMARY KEY,
  home_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  owner_token TEXT,
  owner_kind TEXT,
  owner_expires_at INTEGER,
  next_revision INTEGER NOT NULL DEFAULT 0 CHECK (next_revision >= 0),
  applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  last_revision INTEGER,
  last_outcome TEXT,
  needs_reconcile INTEGER NOT NULL DEFAULT 0 CHECK (needs_reconcile IN (0, 1)),
  remote_state TEXT,
  remote_remaining_microcents INTEGER,
  reconciled_at INTEGER,
  -- H3: raised by every write that changes what the row says of Flux (an allocation, a settlement, a fresh read-back, a hand adjustment). A
  -- GET-state snapshot is published only if it is unchanged since the read began, so a delayed read never overwrites newer state (F4).
  state_seq INTEGER NOT NULL DEFAULT 0,
  -- H4 (Astra H3 #8): the applied revision the published snapshot (remote_state, remote_remaining_microcents) was read at. A read that loses
  -- the state_seq compare-and-set keeps the grant due unless a snapshot at least this recent is already published.
  snapshot_revision INTEGER,
  -- H5 (Astra H4 #8): the newest applied revision a read observed but could not publish (it lost the compare-and-set and no published snapshot
  -- covered it). While a snapshot below it (or below a later settled revision) is all the row holds, the grant stays due: a settlement never
  -- clears that demand; only a covering snapshot (snapshot_revision at or above it) does.
  snapshot_due_revision INTEGER,
  -- H4 (Astra H3 #9): when the sweep last tried to read this grant back, whatever the answer (a failure too): the sweep takes the least
  -- recently tried first, so grants whose reads keep failing never starve the others.
  read_attempted_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((owner_token IS NULL) = (owner_expires_at IS NULL))
);
CREATE INDEX flux_grant_fence_reconcile ON flux_grant_fence (updated_at) WHERE needs_reconcile = 1;
CREATE TABLE flux_grant_revisions (
  grant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  epoch INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('grant', 'reverse', 'target', 'operator')),
  body_sha256 TEXT,
  -- A B5 reversal target's own revision (credit_reversals.target_revision) this wire revision carried: receipts are read back in it.
  logical_revision INTEGER,
  allocated_at INTEGER NOT NULL,
  outcome TEXT,
  settled_at INTEGER,
  PRIMARY KEY (grant_id, revision)
);
-- H2: a journaled revision with outcome NULL may have been dispatched (written before the I/O). One whose owner is gone without settling it
-- (a worker that died mid-request, an operator claim that expired or was taken over) is an ORPHAN: the sweeps read the grant back (F4).
CREATE INDEX flux_grant_revisions_open ON flux_grant_revisions (grant_id, epoch) WHERE outcome IS NULL;
-- B4 dispatches (deliver/revoke) record the Flux grant id and the revision their request carried: a superseded revoke whose revision Flux
-- has since passed can never execute (R11), whatever the order of confirmations.
ALTER TABLE flux_grant_dispatches ADD COLUMN wire_grant_id TEXT;
ALTER TABLE flux_grant_dispatches ADD COLUMN remote_revision INTEGER;
-- H3 (Astra H2 #2): an OPERATOR claim opened before this migration holds no fence and carries no wire revision, so it could adjust a grant
-- that a fenced owner (B5) holds. Every such claim still open on an invoice-backed grant (one with a Flux grant id) is SUPERSEDED here: its
-- authorization ends (a receipt or verification under it is refused: no open claim) and the operator re-claims, which takes the grant's fence
-- and a wire revision like any other owner.
-- H4 (Astra H3 #7, reachable with Flux off): a superseded claim that already holds a receipt PENDING VERIFICATION (R8c) keeps it as an open
-- verification obligation (outcome superseded_at_fence_cutover:pending_receipt): the hand adjustment it states may have happened at Flux, so
-- its alert stays open (blockedBy pending_verification, with the stated amount and reference) whatever the balances say, until a fenced
-- re-claim of the grant completes with Flux's own record (b4-flux-ledger.ts RECEIPT_PENDING).
UPDATE flux_grant_dispatches SET state='superseded',
  outcome=CASE WHEN receipt_at IS NOT NULL THEN 'superseded_at_fence_cutover:pending_receipt' ELSE 'superseded_at_fence_cutover:reclaim' END,
  completed_at=CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)
WHERE kind='operator' AND state='open' AND wire_grant_id IS NULL
  AND EXISTS (SELECT 1 FROM flux_grants g WHERE g.grant_id=flux_grant_dispatches.grant_id AND g.invoice_id IS NOT NULL);
