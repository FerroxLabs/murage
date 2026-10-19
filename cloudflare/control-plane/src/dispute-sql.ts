// SPDX-License-Identifier: AGPL-3.0-or-later
// Dispute SQL shared by the refund ledger (legal-flows.ts) and the B4 grant ledger (b4-flux-ledger.ts). No imports, on purpose: the
// populated-migration test (test-node/) loads the B4 ledger with plain Node and SQLite.

/** The money a closed dispute returned to the customer through the bank (payment_disputes, migration 0105), per row `d`: nothing while it
 *  is open (the dispute hold stops every refund meanwhile) or once it closed in our favour; on a loss, what Stripe's closure recorded
 *  (returned_cents: the disputed principal less anything reinstated, fees excluded), or the disputed amount for a row ops closed by hand. */
export const DISPUTE_RETURNED_SQL = `CASE WHEN d.closed_at IS NULL THEN 0
  WHEN d.movement_exact=0 THEN CASE WHEN d.outcome='lost' AND d.resolved_at IS NOT NULL THEN COALESCE(d.resolved_returned_cents,0) ELSE 0 END
  WHEN d.returned_cents IS NOT NULL THEN d.returned_cents
  WHEN d.outcome='lost' THEN COALESCE(d.amount_cents,0) ELSE 0 END`;

/** INTEGRATED-14 P1: whether Stripe customer `cust` is, or EVER WAS, one of home `home`'s customers (SQL expressions). A country-mismatch
 *  recreation (b5-billing.ts switchCheckoutCustomer) moves the home's pointer (billing_subscriptions) to a new customer, so the pointer alone
 *  forgets the customer a disputed charge was made on. Ownership is IMMUTABLE history: the pointer, the ownership ledger
 *  `customer_home:<customer>`, the previous-customer record, and (rows written before the ledger existed) an orphan record or a create
 *  journal row of the home naming it.
 *  INTEGRATED-15 P2: the current pointer is read directly; every other record is indexed in customer_owners (migration 0106: backfilled,
 *  then kept by triggers on every write of a record, insert-only), so this is two primary-key lookups whatever the size of the home's
 *  history; no JSON history is read. */
export const homeOwnsCustomerSql = (cust: string, home: string) => `(EXISTS (SELECT 1 FROM billing_subscriptions ob WHERE ob.home_id=${home} AND ob.customer_id=${cust})
    OR EXISTS (SELECT 1 FROM customer_owners co WHERE co.customer_id=${cust} AND co.home_id=${home}))`;
/** G-F1 / INTEGRATED-11/12: an unreleased dispute hold `h` that holds a refund of payment intent `pi`, invoice `inv` and home `home` (SQL
 *  expressions, each may be NULL): the same payment intent, the same invoice, a hold scoped to a customer of that home alone, or a hold whose
 *  scope is not attributed yet (scope_pending: it COULD be this refund's invoice; only its customer's refunds once the customer is known,
 *  else every refund). One predicate for the gate's read (legal-refunds.ts disputeHeldFirst) and the claim that admits a submission
 *  (INTEGRATED-12 P1-3: inside the same statement, so a hold committed after the gate still stops it).
 *  INTEGRATED-14 P1: "a customer of that home" is every customer the home EVER owned (homeOwnsCustomerSql), never only its current pointer:
 *  a hold scoped to the customer a disputed charge was made on keeps fencing every payment of that home after the customer is replaced. */
export const disputeHoldMatchSql = (pi: string, inv: string, home: string) => `h.attributed_at IS NULL AND (
    (${pi} IS NOT NULL AND h.payment_intent=${pi}) OR (${inv} IS NOT NULL AND h.invoice_id=${inv})
    OR (${home} IS NOT NULL AND h.payment_intent IS NULL AND h.invoice_id IS NULL AND h.customer_id IS NOT NULL AND ${homeOwnsCustomerSql("h.customer_id", home)})
    OR (h.scope_pending=1 AND (h.customer_id IS NULL OR ${home} IS NULL OR ${homeOwnsCustomerSql("h.customer_id", home)})))`;
/** The refund-failure codes of a refund held by a dispute (legal-refunds.ts disputeGate). */
export const DISPUTE_HELD_CODES = "('payment_dispute_hold','payment_disputed','payment_dispute_inexact','payment_dispute_returned')";
/** INTEGRATED-12 P2-6: when a hold is released, closed or its scope resolved, every unfinished refund it held is due NOW (never left on a
 *  retry backoff of up to six hours). Binds: ?1 the hold's event id, ?2 now. Run BEFORE the statement that narrows a pending scope.
 *  INTEGRATED-13 P2: every unfinished refund in the hold's scope also gets a new RELEASE GENERATION (wake_gen), whatever its state: a worker
 *  that read the hold before this release imposes its failure backoff only while the generation is still the one it read
 *  (legal-refunds.ts advanceLeased), so the wake is never overwritten. INTEGRATED-14 P1: a customer scope wakes every home that EVER owned it. Only next_attempt_at (sooner, never later) and wake_gen move. */
export const WAKE_HELD_BY_HOLD_SQL = `UPDATE refund_ops SET next_attempt_at=CASE WHEN last_error IN ${DISPUTE_HELD_CODES} AND COALESCE(next_attempt_at,0)>?2
    THEN ?2 ELSE next_attempt_at END,wake_gen=wake_gen+1 WHERE done_at IS NULL AND COALESCE(attribution_hold,0)=0
  AND EXISTS (SELECT 1 FROM dispute_holds h WHERE h.event_id=?1 AND (h.scope_pending=1 OR h.payment_intent=refund_ops.payment_intent
    OR h.invoice_id=refund_ops.invoice_id OR (h.customer_id IS NOT NULL AND ${homeOwnsCustomerSql("h.customer_id", "refund_ops.home_id")})))`;
