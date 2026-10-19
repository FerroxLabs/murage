// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 GRANT LEDGER (Astra INTEGRATED-9, reworked for INTEGRATED-10). Replaces the per-grant reversal flags (reversal_state / reason / claim)
// that three rounds of patches kept re-opening. Tables: migration 0106 (flux_grant_accounts, flux_grant_causes, flux_grant_dispatches,
// flux_ledger_cursors).
//
// THE RULES (each one has an "INTEGRATED-9" or "INTEGRATED-10" test in test/b4-flux.test.ts / test/integrated-10.test.ts):
//  L1 ACCOUNT. Every grant has one account: amount A (the grant), paid_cents P (its invoice's payment), returned_cents R (the money its
//     causes returned, all causes together), desired D = A - floor(A x min(R, P) / P) (D = A while nothing is returned): what the customer is
//     entitled to NOW. applied = what Flux holds for the grant BY EVIDENCE only (the router's own acknowledgement, or an operator's receipt).
//     DEBT = D - applied: > 0 delivery/restoration owed, < 0 removal owed. revision rises on every change of D or applied. The database holds
//     D to the formula (a CHECK): a sized account's D is never anything an operator typed.
//  L2 CAUSES are rows (refund: one per refunded payment intent, its SUCCEEDED coverage; dispute_loss: one per dispute of the invoice, the
//     money it returned; cancellation: the stop that cancelled delivery, with the paid entitlement retained then; legacy: what migration 0106
//     carried over from the dropped reversal flags, provenance only). D is computed from all of them together, never from one reason. A cause
//     that later returns LESS (a refund that failed, a reinstatement) raises D again: a restoration debt, also after a confirmed revoke and
//     also after the grant's expiry (INTEGRATED-10: expiry ends SPENDABILITY at Flux, never the accounting of money).
//  L2b SIZING (INTEGRATED-10). P comes from the payment's records (refund_coverage, else the refund operations of the invoice). Money
//     returned with P unknown is UNSIZED (sized=0): nothing automatic, an alerted obligation that only an operator's EVIDENCED sizing (the
//     payment's amount and where it was read) can turn into a D; there is no settlement of an unsized account.
//  L3 ONLY MONEY ACTUALLY RETURNED REMOVES CREDIT. A cancellation (any stop, a suspension) returns nothing: it ends DELIVERY (and journals the
//     retained entitlement first, in the same batch), never the credit. An OPEN dispute returns nothing until the bank decides; a WON one
//     returned nothing. Prepaid funds and spent credit are never touched (a revoke removes only a grant's unspent value).
//  L4 DISPATCHES. Every send (deliver), revoke and operator adjustment is a dispatch row claimed BEFORE any external I/O: a unique fencing
//     token (also the delivery id the router sees), the revision it acts on, claimed_at and expires_at stamped BY THE CLAIM STATEMENT ITSELF
//     (the database clock), and a completion that applies only while that token still owns the row. At most ONE open dispatch per grant
//     (unique partial index): sending, revoking and an operator's adjustment exclude each other.
//  L5 OWNERSHIP ENDS ONLY BY AN AUTHORITATIVE ANSWER OR A SUBSUMING OPERATION (INTEGRATED-10). An AMBIGUOUS answer (a timeout, a 5xx, an
//     unconfirmed acknowledgement: R4/R6/R7) leaves the dispatch OPEN: the request may still execute. Elapsed time never releases it. It may
//     only be SUPERSEDED, atomically, by a dispatch whose own effect subsumes it: a re-delivery of the same grant id (R1: deduped) supersedes
//     a delivery; a revoke (R2: its tombstone makes any late delivery inert) supersedes a delivery or a revoke; an operator who WROTE the
//     grant's tombstone at the router (evidence required) supersedes either. An operator claim is superseded only by another operator with
//     evidence, never by an automatic action. A late answer under a superseded token changes nothing.
//  L6 AUTOMATIC ACTIONS are only the two the router can do exactly: DELIVER the whole grant when D = A (nothing returned) and nothing but
//     this grant id may be at the router (none/maybe); REVOKE it when D = 0 (fully returned) and it may be there. Everything else (a
//     partial D, a restoration after a revoke, an exhausted retry, a tombstone refusal, an expired grant) is an ALERTED OBLIGATION
//     (credit.delivery_owed / credit.removal_owed, one per grant, re-delivered when its revision changes). So is any debt an automatic action
//     COULD converge but something blocks (INTEGRATED-10): an open operator claim, an open dispatch, a billing hold, an unbound recipient;
//     those page once the debt is LEDGER_OVERDUE_MS old (or at once for an operator claim), naming the claim owner, the open dispatch and the
//     blocking reason. Only an operator's claim + receipt (router_state 'manual') settles an obligation by hand.
//  L7 BOUNDED. The sweep reconciles a page of LEDGER_PAGE accounts per run through a durable cursor (flux_ledger_cursors), plus the
//     accounts it touched; every lookup has an index (0106).
//
// ROUTER SEMANTICS THIS LEDGER ASSUMES (all in this block; EACH IS A FLUX CUTOVER CHECK, qualify the app endpoint before enabling B4):
//  R1 The app endpoint POST /api/internal/cloud/credit-grants DEDUPES BY grant_id across delivery ids: a grant id is applied at most once,
//     a re-delivery under the same id adds nothing.
//  R2 REPEATED REVOKES ARE HARMLESS: POST .../credit-grants/revoke always writes a tombstone; 200 {revoked|tombstoned} for that grant_id
//     means no unspent value of the grant remains and no later delivery of that id applies.
//  R3 The 4xx in DEFINITIVE_REFUSALS answered to a delivery APPLY NOTHING.
//  R4 Any other 409 to a delivery is AMBIGUOUS (the id may exist at the router).
//  R5 409 code 'revoked' to a delivery TERMINATES delivery: the id is tombstoned, nothing was or will be applied.
//  R6 A timeout, a network failure or a 5xx is ambiguous for both calls; a 404 to a revoke is ambiguous.
//  R7 (INTEGRATED-10) ONLY DEFINITIVE EVIDENCE CONFIRMS. A delivery is applied only on HTTP 200 whose JSON body names this grant_id, this
//     amount_microcents and status "applied" or "already_applied" (b4-flux.ts createFluxClient grant). 202, 204, an empty 200, or a body for
//     another grant or amount is AMBIGUOUS (the dispatch stays open). A revoke is confirmed only by HTTP 200 naming this grant_id (when the
//     body names one) with status revoked/tombstoned.
//  R8 (INTEGRATED-10) An operator's adjustment reference (adjustmentRef) is a Flux ledger entry of ONE grant: the same reference is never the
//     receipt of two grants (a unique index), and the receipt names the grant and the claim's revision it was made for.
//  R9 (INTEGRATED-11) WHILE FLUX IS OFF every open obligation is a BLOCKED DEBT with its alert kept (blockedBy 'flux_off' for the work an
//     automatic dispatch would own: an open or migrated delivery/revoke, a deliverable or revocable account): nothing automatic will ever
//     converge it. The operator's evidenced recovery (claim, superseding an expired automatic dispatch only with a written tombstone, then
//     the receipt of what was done by hand in the Flux admin) makes no router call and WORKS while off; only the router paths are gated.
//  R10 (INTEGRATED-11) A RESTORATION NEEDS TERMINATION. After an AMBIGUOUS revoke was superseded (by an operator's tombstone, or by a revoke
//     that never got an authoritative answer either) that request may still execute at the router and remove whatever the grant then holds.
//     Until a later revoke of the grant is confirmed (R2) the operator's receipt may record nothing held (applied 0): a restoration
//     (applied > 0) is refused (termination_unconfirmed) and stays an alerted delivery debt.
//  R11 (lane H1, Astra INTEGRATED-16 P1) THE REMOTE FENCE. Every delivery and revoke request carries a per-grant revision allocated in D1
//     before the I/O under the grant's one owner row (flux-grant-fence.ts, migration 0109), recorded on its dispatch (wire_grant_id,
//     remote_revision). Flux refuses a revision below the highest it applied (409 stale_revision). A superseded revoke is terminated once Flux
//     applied its revision or a later one (REVOKE_UNTERMINATED), so a stalled revoke landing after a restoration is refused. A request
//     answered stale_revision or idempotency_mismatch is SUPERSEDED: recorded, never retried, read back by the reconciliation.
//  R8b (INTEGRATED-11) The adjustment reference is ISSUED by the claim (murage:<grant>:r<revision>:<token>) and must be written on the Flux
//     adjustment by hand: the receipt must carry exactly its own claim's reference, so a reference of another grant, revision or claim
//     never settles this one.
//  R8c (INTEGRATED-12) A RECEIPT IS PENDING UNTIL VERIFIED. The amount an operator states is never the stored applied balance on their word:
//     the receipt is kept on its (still open) claim as PENDING VERIFICATION (receipt_*), visible in the obligation's alert with the stated
//     amount and reference (blockedBy 'pending_verification'); the stored applied balance moves, and the alert can resolve, only when Flux's
//     OWN record of that adjustment (FluxClient.verifyAdjustment, the Flux read API: Flux lane) confirms the same amount. While Flux is off
//     nothing is read from Flux, so no path turns a pending receipt into applied. A second receipt contradicting the pending one (another
//     amount) is refused, and a claim holding a pending receipt is never superseded. INTEGRATED-13: while a receipt is pending the
//     obligation stays OPEN (alerted, blockedBy 'pending_verification') whatever the balances say: desired coming back to the stored
//     applied balance (a reinstatement, a failed refund, a sizing) never resolves it.
import { DISPUTE_RETURNED_SQL } from "./dispute-sql";
import { allocateFenceRevision } from "./flux-grant-fence";

/** R3. */
export const DEFINITIVE_REFUSALS = new Set([400, 401, 403, 404, 422, 429]);
/** How long an automatic dispatch may be in flight before a dispatch of a kind that subsumes it may supersede it (L5). */
export const DISPATCH_TTL_MS = 5 * 60_000;
/** How long an operator's claim holds the grant before another operator may take it over (with evidence). */
export const OPERATOR_TTL_MS = 24 * 3_600_000;
/** Automatic revokes of one grant before it becomes an alerted obligation (retry exhaustion never discharges the debt). */
export const MAX_REVOKES = 20;
/** L6: a debt an automatic action could converge but has not, this long after it arose, pages with its blocking reason. */
export const LEDGER_OVERDUE_MS = 24 * 3_600_000;
/** L7: accounts reconciled per sweep through the durable cursor. */
export const LEDGER_PAGE = 200;
/** The database clock in epoch milliseconds: dispatch claims, expiries and completions are stamped by the statement itself (L4). */
export const DB_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

export type DispatchKind = "deliver" | "revoke" | "operator";
export type RouterState = "none" | "maybe" | "delivered" | "revoking" | "revoked" | "manual";
export interface Account {
  grant_id: string; home_id: string; invoice_id: string | null; amount_microcents: number; paid_cents: number | null; paid_source: string | null;
  returned_cents: number; sized: number; desired_microcents: number; applied_microcents: number; delivered_confirmed_microcents: number;
  router_state: RouterState; revision: number; settled_revision: number | null; debt_since: number | null;
}

/** A scope over the accounts table aliased `a` (one grant, one home, a list, or every account). Its SQL holds only `?` placeholders and
 *  `a.` columns (the outbox variant replaces `a.` by `g.`). */
export interface Scope { sql: string; binds: unknown[] }
export const grantScope = (grantId: string): Scope => ({ sql: "a.grant_id=?", binds: [grantId] });
export const homeScope = (homeId: string): Scope => ({ sql: "a.home_id=?", binds: [homeId] });
export const listScope = (grantIds: string[]): Scope => ({ sql: "a.grant_id IN (SELECT value FROM json_each(?))", binds: [JSON.stringify(grantIds)] });
export const allScope: Scope = { sql: "1=1", binds: [] };

/** An OPEN dispute holds the grant's payment (its invoice, or its contract per B5's grant claim): the bank is deciding. No automatic
 *  dispatch while it stands (L3: an open dispute has returned nothing yet; WON or LOST decides). Over accounts `a`. Indexed (0106:
 *  payment_disputes_open_invoice / payment_disputes_open_contract). */
export const DISPUTE_OPEN_HOLD = `(EXISTS (SELECT 1 FROM payment_disputes pd WHERE pd.home_id=a.home_id AND pd.invoice_id=a.invoice_id AND pd.closed_at IS NULL)
  OR EXISTS (SELECT 1 FROM payment_disputes pd WHERE pd.home_id=a.home_id AND pd.closed_at IS NULL AND pd.subscription_id IS NOT NULL
    AND pd.subscription_id=(SELECT cg.subscription_id FROM credit_grants cg WHERE cg.invoice_id=a.invoice_id AND cg.subscription_id IS NOT NULL LIMIT 1)))`;
/** L6, over accounts `a` joined to their grant `g`. */
const REVOKES = "(SELECT COUNT(*) FROM flux_grant_dispatches x WHERE x.grant_id=a.grant_id AND x.kind='revoke')";
export const DELIVER_AUTO = `((g.status='pending' OR (g.status='cancelled' AND g.redeliver IS 'held')) AND a.sized=1
  AND a.desired_microcents=a.amount_microcents AND a.router_state IN ('none','maybe'))`;
export const REVOKE_AUTO = `(a.sized=1 AND a.desired_microcents=0 AND a.router_state IN ('maybe','delivered','revoking') AND ${REVOKES}<${MAX_REVOKES})`;
/** Something is owed or may be in flight (prefix `p`: 'a.' over the alias, '' over the table itself). */
const hasDebt = (p: string) => `(${p}desired_microcents<>${p}applied_microcents OR ${p}router_state IN ('maybe','revoking'))`;
const OPERATOR_OPEN = "EXISTS (SELECT 1 FROM flux_grant_dispatches o WHERE o.grant_id=a.grant_id AND o.state='open' AND o.kind='operator')";
/** R8c: an operator dispatch row `o` holds a receipt not verified yet: on its open claim, or (H4, Astra H3 #7, reachable with Flux off) on a
 *  claim 0109 superseded at the fence cutover (its authorization ended: nothing may be adjusted, received or verified under it any more), kept
 *  as an open VERIFICATION obligation until a later operator claim of the grant (fenced) completes with Flux's own record of what it holds. */
const PENDING_RECEIPT_ROW = (o: string): string => `${o}.kind='operator' AND ${o}.receipt_at IS NOT NULL AND (${o}.state='open'
  OR (${o}.state='superseded' AND ${o}.outcome='superseded_at_fence_cutover:pending_receipt' AND NOT EXISTS (SELECT 1 FROM flux_grant_dispatches y
    WHERE y.grant_id=${o}.grant_id AND y.kind='operator' AND y.state='applied' AND y.completed_at>=${o}.completed_at)))`;
/** R8c: the grant carries a receipt not verified yet (PENDING_RECEIPT_ROW). */
const RECEIPT_PENDING = `EXISTS (SELECT 1 FROM flux_grant_dispatches o WHERE o.grant_id=a.grant_id AND ${PENDING_RECEIPT_ROW("o")})`;
const AUTO_OPEN = "EXISTS (SELECT 1 FROM flux_grant_dispatches o WHERE o.grant_id=a.grant_id AND o.state='open' AND o.kind<>'operator')";
const BILLING_HELD = `(g.status='pending' AND g.redeliver IS NOT 'due' AND EXISTS (SELECT 1 FROM flux_home_keys h WHERE h.home_id=g.home_id AND h.billing_hold=1))`;
/** L6 (INTEGRATED-10): an account that needs a person, over `a` joined to `g`, ?1 = now. An unsized return (always: only evidenced sizing
 *  makes it a D); a debt no automatic action converges; a debt behind an operator's claim (the claim blocks every automatic action); and,
 *  while Flux is live, any debt older than LEDGER_OVERDUE_MS that no open dispute legitimately holds (blocked automatic work: an open or
 *  crashed dispatch, a billing hold, an unbound recipient). Settlement is the debt itself (desired = applied, nothing in flight): never a
 *  receipt's revision. */
export function obligationOpen(live: boolean): string {
  // INTEGRATED-13 P1: a PENDING RECEIPT (R8c) keeps the obligation open WHATEVER the balances say: the hand adjustment it states may have
  // happened at Flux, so a desired amount that comes back to the old stored applied balance (a dispute reinstatement, a failed refund, a
  // sizing) never makes an unverified removal or restoration disappear from operational accounting. Resolved only by verification
  // (the claim completes) or reconciliation.
  // R9 (INTEGRATED-11): with Flux off nothing automatic will converge any debt: every debt is an obligation (blocked, alerted, kept).
  if (!live) return `((a.sized=0 AND a.returned_cents>0) OR ${RECEIPT_PENDING} OR ${hasDebt("a.")})`;
  return `((a.sized=0 AND a.returned_cents>0) OR ${RECEIPT_PENDING}
  OR (${hasDebt("a.")} AND (NOT (${DELIVER_AUTO} OR ${REVOKE_AUTO}) OR ${OPERATOR_OPEN}${live
    ? ` OR (a.debt_since IS NOT NULL AND a.debt_since<=?1-${LEDGER_OVERDUE_MS} AND NOT ${DISPUTE_OPEN_HOLD})` : ""})))`;
}
/** Why an obligation is not converging by itself (the alert's blockedBy), over `a` joined to `g`. R9: with Flux off, the work an automatic
 *  dispatch would own (an open or migrated dispatch, a deliverable or revocable account) is blocked by 'flux_off'. */
const blockedBy = (live: boolean) => `CASE WHEN a.sized=0 THEN 'unsized_return'
  WHEN ${RECEIPT_PENDING} THEN 'pending_verification'
  WHEN ${OPERATOR_OPEN} THEN 'operator_claim'
  ${live ? "" : `WHEN ${AUTO_OPEN} OR ${DELIVER_AUTO} OR ${REVOKE_AUTO} THEN 'flux_off'`}
  WHEN ${AUTO_OPEN} THEN 'dispatch_open'
  WHEN ${DISPUTE_OPEN_HOLD} THEN 'dispute_open'
  WHEN g.status='pending' AND g.recipient_flux_account_id IS NULL THEN 'recipient_unbound'
  WHEN ${BILLING_HELD} THEN 'billing_hold'
  WHEN g.status='failed' OR ${REVOKES}>=${MAX_REVOKES} THEN 'retry_exhausted'
  WHEN g.status='expired' THEN 'grant_expired'
  WHEN ${DELIVER_AUTO} OR ${REVOKE_AUTO} THEN 'automatic_overdue'
  ELSE 'needs_person' END`;

/** The account of every grant in scope that has none yet (a grant made before the ledger, or by a test fixture), from its outbox status.
 *  Scope here is over flux_grants `g`. */
function ensureSql(scopeSql: string): string {
  return `INSERT OR IGNORE INTO flux_grant_accounts (grant_id,home_id,invoice_id,amount_microcents,desired_microcents,applied_microcents,
      delivered_confirmed_microcents,router_state,updated_at)
    SELECT g.grant_id,g.home_id,g.invoice_id,g.amount_microcents,g.amount_microcents,
      CASE WHEN g.status='done' THEN g.amount_microcents ELSE 0 END,CASE WHEN g.status IN ('done','reversed') THEN g.amount_microcents ELSE 0 END,
      CASE WHEN g.status='done' THEN 'delivered' WHEN g.status='reversed' THEN 'revoked' WHEN g.attempts>0 OR g.claim_id IS NOT NULL THEN 'maybe' ELSE 'none' END,?
    FROM flux_grants g WHERE ${scopeSql}`;
}

/** L2b: the payment's amount from its records (refund_coverage, else the refund operations of the invoice), over `a`. */
const PAID_COVERAGE = "(SELECT MAX(c.paid_cents) FROM refund_coverage c WHERE c.home_id=a.home_id AND c.invoice_id=a.invoice_id AND c.paid_cents>0)";
const PAID_OPS = "(SELECT MAX(o.paid_cents) FROM refund_ops o WHERE o.invoice_id=a.invoice_id AND o.home_id=a.home_id AND o.paid_cents>0)";

/** L1/L2 as statements, for the caller's batch (a D1 batch is one transaction): every account in scope gets its causes re-read from the
 *  payment's records (refund_coverage: succeeded coverage; payment_disputes: DISPUTE_RETURNED_SQL) and its desired amount re-derived; the
 *  revision rises only when something changed. INTEGRATED-10: past the grant's expiry too (expiry ends spendability, never accounting).
 *  `now` stamps rows (bookkeeping only, never a claim). */
export function refreshStatements(db: D1Database, scope: Scope, now: number): D1PreparedStatement[] {
  const live = `g.grant_id=a.grant_id AND a.invoice_id IS NOT NULL AND ${scope.sql}`;
  const gScope = scope.sql.replaceAll("a.", "g.");
  const refundSum = "MAX(0,COALESCE((SELECT SUM(c.covered_cents) FROM refund_coverage c WHERE c.home_id=a.home_id AND c.invoice_id=a.invoice_id),0))";
  const disputeSum = `MAX(0,COALESCE((SELECT SUM(${DISPUTE_RETURNED_SQL}) FROM payment_disputes d WHERE d.home_id=a.home_id AND d.invoice_id=a.invoice_id),0))`;
  return [
    db.prepare(ensureSql(gScope)).bind(now, ...scope.binds),
    db.prepare(`INSERT INTO flux_grant_causes (grant_id,cause,ref,returned_cents,evidence,revision,recorded_at,updated_at)
      SELECT a.grant_id,'refund',c.payment_intent,MAX(0,c.covered_cents),'refund_coverage:' || c.payment_intent || ':succeeded',a.revision,?1,?1
      FROM flux_grant_accounts a JOIN flux_grants g ON ${live} JOIN refund_coverage c ON c.home_id=a.home_id AND c.invoice_id=a.invoice_id WHERE 1
      ON CONFLICT(grant_id,cause,ref) DO UPDATE SET returned_cents=excluded.returned_cents,updated_at=excluded.updated_at
        WHERE flux_grant_causes.returned_cents<>excluded.returned_cents`).bind(now, ...scope.binds),
    db.prepare(`INSERT INTO flux_grant_causes (grant_id,cause,ref,returned_cents,evidence,revision,recorded_at,updated_at)
      SELECT a.grant_id,'dispute_loss',d.dispute_id,MAX(0,${DISPUTE_RETURNED_SQL}),
        'payment_disputes:' || d.dispute_id || ':' || COALESCE(d.outcome,'open') || CASE WHEN d.movement_exact=0 THEN ':inexact' ELSE '' END,a.revision,?1,?1
      FROM flux_grant_accounts a JOIN flux_grants g ON ${live} JOIN payment_disputes d ON d.home_id=a.home_id AND d.invoice_id=a.invoice_id WHERE 1
      ON CONFLICT(grant_id,cause,ref) DO UPDATE SET returned_cents=excluded.returned_cents,evidence=excluded.evidence,updated_at=excluded.updated_at
        WHERE flux_grant_causes.returned_cents<>excluded.returned_cents OR flux_grant_causes.evidence<>excluded.evidence`).bind(now, ...scope.binds),
    // L2b: the payment's amount from its records first; an operator's evidenced sizing only where the records have none.
    db.prepare(`WITH calc AS (SELECT a.grant_id AS gid,a.amount_microcents AS amt,${refundSum}+${disputeSum} AS ret,
          ${PAID_COVERAGE} AS pc,${PAID_OPS} AS po,CASE WHEN a.paid_source='operator' THEN a.paid_cents END AS pm
        FROM flux_grant_accounts a JOIN flux_grants g ON ${live}),
      src AS (SELECT gid,amt,ret,COALESCE(pc,po,pm) AS paid,CASE WHEN pc IS NOT NULL THEN 'refund_coverage' WHEN po IS NOT NULL THEN 'refund_ops'
          WHEN pm IS NOT NULL THEN 'operator' END AS psrc FROM calc),
      nxt AS (SELECT gid,ret,paid,psrc,CASE WHEN ret=0 OR paid IS NOT NULL THEN 1 ELSE 0 END AS sized,
        CASE WHEN ret=0 THEN amt WHEN paid IS NULL THEN NULL ELSE amt-(amt*MIN(ret,paid))/paid END AS desired FROM src)
      UPDATE flux_grant_accounts SET returned_cents=nxt.ret,paid_cents=nxt.paid,paid_source=nxt.psrc,sized=nxt.sized,
        desired_microcents=COALESCE(nxt.desired,flux_grant_accounts.desired_microcents),revision=flux_grant_accounts.revision+1,updated_at=?
      FROM nxt WHERE nxt.gid=flux_grant_accounts.grant_id AND (flux_grant_accounts.returned_cents<>nxt.ret OR flux_grant_accounts.paid_cents IS NOT nxt.paid
        OR flux_grant_accounts.paid_source IS NOT nxt.psrc OR flux_grant_accounts.sized<>nxt.sized
        OR flux_grant_accounts.desired_microcents<>COALESCE(nxt.desired,flux_grant_accounts.desired_microcents))`)
      .bind(...scope.binds, now), // the scope's placeholders come first in the text: positional binds in that order
    // Each cause touched now carries the revision it was applied at.
    db.prepare(`UPDATE flux_grant_causes SET revision=(SELECT a.revision FROM flux_grant_accounts a WHERE a.grant_id=flux_grant_causes.grant_id)
      WHERE updated_at=?1 AND cause IN ('refund','dispute_loss') AND grant_id IN (SELECT a.grant_id FROM flux_grant_accounts a WHERE ${scope.sql})`).bind(now, ...scope.binds),
  ];
}

/** L2/L3: the CANCELLATION journal, for the cancelling batch, placed BEFORE the statement that cancels: every grant `where` selects (over
 *  flux_grants `g`) gets a cancellation cause carrying the paid entitlement it retains at that moment (its account's desired amount). The
 *  account itself (and so the debt, alerted by syncAlertStatements) is untouched: cancelling delivery never forfeits paid credit. */
export function cancellationJournalStatements(db: D1Database, where: string, binds: unknown[], ref: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare(ensureSql(where)).bind(now, ...binds),
    db.prepare(`INSERT INTO flux_grant_causes (grant_id,cause,ref,returned_cents,retained_microcents,evidence,revision,recorded_at,updated_at)
      SELECT a.grant_id,'cancellation',?,0,a.desired_microcents,'stop:' || ?,a.revision,?,? FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id
      WHERE ${where} ON CONFLICT(grant_id,cause,ref) DO NOTHING`).bind(ref, ref, now, now, ...binds),
  ];
}

/** L4/L5: claim a dispatch of `kind` for one grant, BEFORE any external call. One batch: the account is refreshed (returned money as it is
 *  now), an EXPIRED open AUTOMATIC dispatch of a kind this one subsumes is superseded (L5: a delivery by a re-delivery; a delivery or a revoke
 *  by a revoke; never an operator's claim), and the row is inserted only if `eligible` (over the refreshed account `a` and its grant `g`)
 *  holds and no other dispatch is open. Returns the claim, or null when not claimed. */
export async function claimDispatch(db: D1Database, a: { grantId: string; kind: Exclude<DispatchKind, "operator">; eligible: string; binds: unknown[];
  now: number; extra?: (token: string) => D1PreparedStatement[] }): Promise<{ token: string; revision: number; claimedAt: number } | null> {
  const token = crypto.randomUUID();
  const subsumes = a.kind === "deliver" ? "('deliver')" : "('deliver','revoke')";
  const state = a.kind === "deliver" ? "CASE WHEN router_state='none' THEN 'maybe' ELSE router_state END" : "'revoking'";
  const open = "EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open')";
  await db.batch([
    ...refreshStatements(db, grantScope(a.grantId), a.now),
    db.prepare(`UPDATE flux_grant_dispatches SET state='superseded',outcome='expired_superseded_by:' || ?,completed_at=${DB_NOW_MS}
      WHERE grant_id=? AND state='open' AND kind IN ${subsumes} AND expires_at<=${DB_NOW_MS}
        AND EXISTS (SELECT 1 FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id WHERE a.grant_id=? AND ${a.eligible})`)
      .bind(token, a.grantId, a.grantId, ...a.binds),
    db.prepare(`INSERT OR IGNORE INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at)
      SELECT ?,a.grant_id,?,a.revision,a.desired_microcents,${DB_NOW_MS},${DB_NOW_MS}+${DISPATCH_TTL_MS}
      FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id WHERE a.grant_id=? AND ${a.eligible}`)
      .bind(token, a.kind, a.grantId, ...a.binds),
    // The claim is the point after which the request may reach the router: the account says so at once (a crash later leaves it right).
    db.prepare(`UPDATE flux_grant_accounts SET router_state=${state} WHERE grant_id=? AND ${open}`).bind(a.grantId, token),
    // A revoke attempt (claimed or not) waits its retry interval in the sweep (deliveries keep their own, flux_grants.last_attempt_at).
    ...(a.kind === "revoke" ? [db.prepare("UPDATE flux_grant_accounts SET last_tried_at=? WHERE grant_id=?").bind(a.now, a.grantId)] : []),
    ...(a.extra ? a.extra(token) : []),
  ]);
  const row = await db.prepare("SELECT revision,claimed_at FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open'").bind(token)
    .first<{ revision: number; claimed_at: number }>();
  return row ? { token, revision: row.revision, claimedAt: row.claimed_at } : null;
}

/** The guard every completion statement carries: the token still owns its open dispatch (L4). Binds (token). */
export const OWNS = "EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open')";

/** Lane H1 (R11): `superseded`: Flux answered 409 stale_revision (a later revision of the grant already applied) or idempotency_mismatch:
 *  the request can never execute; recorded, never retried, the grant read back by the fence reconciliation. `refused` for a revoke: nothing
 *  was sent (another owner holds the grant's fence). */
export type DeliverResult = { kind: "applied" } | { kind: "tombstoned" } | { kind: "refused"; code: string } | { kind: "ambiguous"; code: string }
  | { kind: "superseded"; code: string };
export type RevokeResult = { kind: "applied"; outcome: "revoked" | "tombstoned" } | { kind: "ambiguous"; code: string } | { kind: "superseded"; code: string }
  | { kind: "refused"; code: string };

/** L5: an ambiguous answer keeps the dispatch OPEN (the request may still execute): its last answer and attempt count are recorded, and it is
 *  due at once for a SUBSUMING retry (a re-delivery under the same grant id, or a revoke), which supersedes it atomically. Nothing else
 *  (no operator observation, no elapsed time) ever releases it. */
const stillOpen = (db: D1Database, token: string, code: string) => db.prepare(`UPDATE flux_grant_dispatches SET last_outcome=?,attempts=attempts+1,
  expires_at=MIN(expires_at,${DB_NOW_MS}) WHERE dispatch_id=? AND state='open'`).bind(code, token);

/** L4: the completion of a delivery, applied only while `token` owns its dispatch. `grantStmts` are the outbox's own updates, each guarded
 *  by OWNS (bind the token first). Returns whether the token still owned it. An ambiguous answer leaves the dispatch open (L5). */
export async function completeDelivery(db: D1Database, a: { grantId: string; token: string; result: DeliverResult; now: number;
  grantStmts: D1PreparedStatement[] }): Promise<boolean> {
  const r = a.result;
  const account = r.kind === "applied"
    ? db.prepare(`UPDATE flux_grant_accounts SET router_state='delivered',applied_microcents=amount_microcents,delivered_confirmed_microcents=amount_microcents,
        revision=revision+CASE WHEN applied_microcents<>amount_microcents THEN 1 ELSE 0 END,updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token)
    : r.kind === "tombstoned"
      ? db.prepare(`UPDATE flux_grant_accounts SET router_state='revoked',revision=revision+CASE WHEN applied_microcents<>0 THEN 1 ELSE 0 END,applied_microcents=0,
          updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token)
      : r.kind === "refused"
        // R3: nothing applied. Back to 'none' only when EVERY delivery of the grant was refused (none other may have landed).
        ? db.prepare(`UPDATE flux_grant_accounts SET router_state=CASE WHEN router_state='maybe' AND NOT EXISTS (SELECT 1 FROM flux_grant_dispatches x
            WHERE x.grant_id=flux_grant_accounts.grant_id AND x.kind='deliver' AND x.state<>'refused' AND x.dispatch_id<>?) THEN 'none' ELSE router_state END,
            updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.token, a.now, a.grantId, a.token)
        : db.prepare(`UPDATE flux_grant_accounts SET updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token);
  const finish = r.kind === "ambiguous"
    ? stillOpen(db, a.token, r.code)
    : r.kind === "superseded"
      ? db.prepare(`UPDATE flux_grant_dispatches SET state='superseded',outcome=?,last_outcome=?,completed_at=${DB_NOW_MS} WHERE dispatch_id=? AND state='open'`)
        .bind(r.code, r.code, a.token)
    : db.prepare(`UPDATE flux_grant_dispatches SET state=?,outcome=?,last_outcome=?,completed_at=${DB_NOW_MS} WHERE dispatch_id=? AND state='open'`)
      .bind(r.kind === "refused" ? "refused" : "applied", r.kind === "applied" ? "delivered" : r.kind === "tombstoned" ? "flux_revoked" : r.code,
        r.kind === "applied" ? "delivered" : r.kind === "tombstoned" ? "flux_revoked" : r.code, a.token);
  const results = await db.batch([account, ...a.grantStmts, finish]);
  return results[results.length - 1].meta.changes === 1;
}

/** L4: the completion of a revoke, applied only while `token` owns its dispatch. An ambiguous answer leaves it open (L5). */
export async function completeRevoke(db: D1Database, a: { grantId: string; token: string; result: RevokeResult; now: number }): Promise<boolean> {
  const r = a.result;
  const stmts = r.kind === "applied" ? [
    db.prepare(`UPDATE flux_grant_accounts SET router_state='revoked',revision=revision+CASE WHEN applied_microcents<>0 THEN 1 ELSE 0 END,applied_microcents=0,
      updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token),
    // R2: a tombstone ends delivery too: a pending delivery can never apply now.
    db.prepare(`UPDATE flux_grants SET status=CASE WHEN status='done' THEN 'reversed' WHEN status='pending' THEN 'cancelled' ELSE status END,claim_id=NULL,
      redeliver=NULL WHERE grant_id=? AND ${OWNS}`).bind(a.grantId, a.token),
    db.prepare(`UPDATE flux_grant_dispatches SET state='applied',outcome=?,last_outcome=?,completed_at=${DB_NOW_MS} WHERE dispatch_id=? AND state='open'`)
      .bind(r.outcome, r.outcome, a.token),
  ] : r.kind === "superseded" || r.kind === "refused" ? [
    db.prepare(`UPDATE flux_grant_accounts SET updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token),
    db.prepare(`UPDATE flux_grant_dispatches SET state=?,outcome=?,last_outcome=?,completed_at=${DB_NOW_MS} WHERE dispatch_id=? AND state='open'`)
      .bind(r.kind, r.code, r.code, a.token),
  ] : [
    db.prepare(`UPDATE flux_grant_accounts SET updated_at=? WHERE grant_id=? AND ${OWNS}`).bind(a.now, a.grantId, a.token),
    stillOpen(db, a.token, r.code),
  ];
  const results = await db.batch(stmts);
  return results[results.length - 1].meta.changes === 1;
}

/** L6: ONE alert per grant whose account is an open obligation (credit.delivery_owed when more is owed to the customer than Flux holds,
 *  credit.removal_owed otherwise), its detail the account as it stands (so a new revision re-delivers it), with what blocks it (the claim
 *  owner, the open dispatch, the reason) and since when the debt stands; resolved once it is settled. INTEGRATED-10: no expiry cut-off (an
 *  obligation is paged and kept after the grant's expiry). `live`: Flux is on (overdue automatic work pages; with Flux off nothing is sent,
 *  so only the obligations a person must handle anyway page). Statements for the caller's batch. */
export function syncAlertStatements(db: D1Database, scope: Scope, now: number, live = true): D1PreparedStatement[] {
  const open = obligationOpen(live);
  const kind = "CASE WHEN a.sized=0 OR a.desired_microcents<a.applied_microcents THEN 'credit.removal_owed' ELSE 'credit.delivery_owed' END";
  const detail = `json_object('grantId',a.grant_id,'invoiceId',a.invoice_id,'revision',a.revision,'amountMicrocents',a.amount_microcents,
      'paidCents',a.paid_cents,'paidSource',a.paid_source,'returnedCents',a.returned_cents,'sized',a.sized,'desiredMicrocents',a.desired_microcents,
      'appliedMicrocents',a.applied_microcents,'debtMicrocents',a.desired_microcents-a.applied_microcents,'debtSince',a.debt_since,'routerState',a.router_state,
      'grantStatus',g.status,'expiresAt',g.expires_at,'blockedBy',${blockedBy(live)},'fluxOn',${live ? 1 : 0},
      'openDispatch',json((SELECT json_object('dispatchId',o.dispatch_id,'kind',o.kind,'by',o.by,'claimedAt',o.claimed_at,'expiresAt',o.expires_at)
        FROM flux_grant_dispatches o WHERE o.grant_id=a.grant_id AND o.state='open')),
      'pendingReceipt',json((SELECT json_object('state','pending_verification','appliedMicrocents',o.receipt_microcents,'adjustmentRef',o.adjustment_ref,
        'by',o.receipt_by,'evidence',o.receipt_evidence,'receivedAt',o.receipt_at,'claimState',o.state,'rule','not applied to the stored balance until Flux''s own record of this adjustment confirms the amount')
        FROM flux_grant_dispatches o WHERE o.grant_id=a.grant_id AND ${PENDING_RECEIPT_ROW("o")} ORDER BY o.receipt_at DESC,o.dispatch_id LIMIT 1)),
      'causes',json((SELECT json_group_array(json_object('cause',c.cause,'ref',c.ref,'returnedCents',c.returned_cents,'retainedMicrocents',c.retained_microcents,
        'evidence',c.evidence,'revision',c.revision)) FROM flux_grant_causes c WHERE c.grant_id=a.grant_id)),
      'rule','credit follows money actually returned: Flux must hold desiredMicrocents of this grant (amount less floor(amount x returned / paid)); never touch prepaid funds, spent credit or another grant. sized 0: the payment amount is unknown, size it with evidence in the receipt. routerState maybe/revoking or an open dispatch: a request may still execute at the router; it is never released by time (write the grant''s tombstone at the router and claim with tombstone:true to supersede it)',
      'action','POST /v1/internal/flux/grants/' || a.grant_id || '/claim {by[, evidence, tombstone]}, adjust by hand, then POST /v1/internal/flux/grants/' || a.grant_id || '/applied {token, grantId, revision, appliedMicrocents, adjustmentRef, evidence, by[, sizing {paidCents, evidence}]}')`;
  return [
    // L6: when the debt arose (kept while it stands, cleared once settled): the overdue clock and the alert's debtSince.
    db.prepare(`UPDATE flux_grant_accounts SET debt_since=CASE WHEN ${hasDebt("")} THEN COALESCE(debt_since,?1) ELSE NULL END
      WHERE grant_id IN (SELECT a.grant_id FROM flux_grant_accounts a WHERE ${scope.sql})
        AND (CASE WHEN ${hasDebt("")} THEN 1 ELSE 0 END)<>(CASE WHEN debt_since IS NULL THEN 0 ELSE 1 END)`).bind(now, ...scope.binds),
    db.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:flux_ledger:' || a.grant_id,a.home_id,${kind},'high',${detail},?1,a.grant_id
      FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id WHERE ${scope.sql} AND ${open}
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,detail=excluded.detail,resolved_at=NULL,raised_at=excluded.raised_at,delivered_at=NULL,delivery_attempts=0
        WHERE cloud_alerts.detail<>excluded.detail OR cloud_alerts.kind<>excluded.kind OR cloud_alerts.resolved_at IS NOT NULL`).bind(now, ...scope.binds),
    db.prepare(`UPDATE cloud_alerts SET resolved_at=?1 WHERE kind IN ('credit.delivery_owed','credit.removal_owed') AND resolved_at IS NULL
      AND subject IN (SELECT a.grant_id FROM flux_grant_accounts a WHERE ${scope.sql})
      AND NOT EXISTS (SELECT 1 FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id WHERE a.grant_id=cloud_alerts.subject AND ${open})`)
      .bind(now, ...scope.binds),
  ];
}

/** L7: the next page of the durable reconciliation cursor (grant ids after the stored position, LEDGER_PAGE of them), and the statement
 *  that moves the cursor past it (wrapping to the start after the last page). */
export async function ledgerPage(db: D1Database, now: number, size = LEDGER_PAGE): Promise<{ scope: Scope; advance: D1PreparedStatement; ids: string[] }> {
  const at = (await db.prepare("SELECT position FROM flux_ledger_cursors WHERE name='accounts'").first<{ position: string }>())?.position ?? "";
  const ids = (await db.prepare("SELECT grant_id FROM flux_grants WHERE grant_id>? ORDER BY grant_id LIMIT ?").bind(at, size).all<{ grant_id: string }>())
    .results.map((r) => r.grant_id);
  const next = ids.length < size ? "" : ids[ids.length - 1];
  return {
    scope: listScope(ids), ids,
    advance: db.prepare(`INSERT INTO flux_ledger_cursors (name,position,updated_at) VALUES ('accounts',?,?)
      ON CONFLICT(name) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`).bind(next, now),
  };
}

export async function accountOf(db: D1Database, grantId: string): Promise<Account | null> {
  return db.prepare("SELECT * FROM flux_grant_accounts WHERE grant_id=?").bind(grantId).first<Account>();
}

/** L5/L6: an OPERATOR's claim on one grant, before any hand adjustment. Refused (null, with the dispatch in the way) while another dispatch
 *  is open, except: an EXPIRED operator claim is superseded when `evidence` (what this operator read) is given; an EXPIRED automatic
 *  dispatch only when the operator WROTE the grant's tombstone at the router (`tombstone`, with evidence): a subsuming operation, never an
 *  observation (R2: no late delivery or revoke of that id applies after it).
 *  H2 (Astra P1 "B4 operator claims bypass shared grant ownership"): the claim ALSO takes the Flux grant's one owner row (flux-grant-fence.ts,
 *  `invoice_id:kind`, the same fence B5 grant/reverse/target and B4 delivery/revoke claim), all or nothing in the claim's own transaction:
 *  free, expired, or held by an operator dispatch of this grant the claim has just superseded. Held by anyone else (a B5 sender, a dispute
 *  claim), the claim is refused with nothing changed. Under it a wire revision is allocated: the hand adjustment at Flux must carry it, and the
 *  receipt must name it (operatorApplied), so a newer B5 adjustment can never be overwritten by an older hand one. */
export async function operatorClaim(db: D1Database, a: { grantId: string; by: string; evidence?: string; tombstone?: boolean; now: number }):
  Promise<{ claimed: true; token: string; adjustmentRef: string; account: Account; wireGrantId: string | null; wireRevision: number | null }
    | { claimed: false; open: { kind: string; claimedAt: number; expiresAt: number; by: string | null } | null; account: Account | null }> {
  const token = crypto.randomUUID();
  const evidence = a.evidence?.trim() ? a.evidence.trim() : null;
  const g = await db.prepare("SELECT invoice_id,kind FROM flux_grants WHERE grant_id=?").bind(a.grantId).first<{ invoice_id: string | null; kind: string | null }>();
  const wire = g?.invoice_id ? `${g.invoice_id}:${g.kind ?? "period"}` : null;
  const mineOpen = "EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=?1 AND state='open')";
  const guardId = `op-fence:${token}`;
  const fenceStmts = wire === null ? [] : [
    db.prepare(`INSERT OR IGNORE INTO flux_grant_fence (grant_id,updated_at) SELECT ?1,${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=?2 AND state='open')`)
      .bind(wire, token),
    db.prepare(`UPDATE flux_grant_fence SET epoch=epoch+1,owner_token=?1,owner_kind='b4_operator',owner_expires_at=${DB_NOW_MS}+${OPERATOR_TTL_MS},updated_at=${DB_NOW_MS}
      WHERE grant_id=?2 AND ${mineOpen} AND (owner_token IS NULL OR owner_expires_at<=${DB_NOW_MS}
        OR owner_token IN (SELECT dispatch_id FROM flux_grant_dispatches WHERE grant_id=?3 AND kind='operator' AND state='superseded')) RETURNING epoch`)
      .bind(token, wire, a.grantId),
    // All or nothing: the dispatch claim stands only with the fence (the guard row's CHECK(ok=1) rolls the whole batch back otherwise).
    db.prepare(`INSERT INTO cloud_write_guards VALUES (?1,CASE WHEN NOT ${mineOpen.replace("?1", "?2")}
        OR EXISTS (SELECT 1 FROM flux_grant_fence WHERE grant_id=?3 AND owner_token=?2) THEN 1 ELSE 0 END)`).bind(guardId, token, wire),
    db.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guardId),
  ];
  let fenceEpoch: number | null = null;
  try {
    const res = await db.batch<{ epoch: number }>([
    ...refreshStatements(db, grantScope(a.grantId), a.now),
    db.prepare(`UPDATE flux_grant_dispatches SET state='superseded',outcome='expired_superseded_by:' || ?1 || CASE WHEN kind='operator' THEN '' ELSE ':tombstone' END,
        evidence=?2,by=COALESCE(by,?3),completed_at=${DB_NOW_MS}
      WHERE grant_id=?4 AND state='open' AND expires_at<=${DB_NOW_MS} AND ?2 IS NOT NULL AND (kind='operator' OR ?5=1) AND receipt_at IS NULL`)
      .bind(token, evidence, a.by, a.grantId, a.tombstone === true ? 1 : 0),
    // R8b: the claim ISSUES the adjustment reference (grant, revision, claim) the operator writes on the Flux adjustment.
    db.prepare(`INSERT OR IGNORE INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at,by,evidence,adjustment_ref)
      SELECT ?1,grant_id,'operator',revision,desired_microcents,${DB_NOW_MS},${DB_NOW_MS}+${OPERATOR_TTL_MS},?2,?3,'murage:' || grant_id || ':r' || revision || ':' || ?1
      FROM flux_grant_accounts WHERE grant_id=?4`)
      .bind(token, a.by, evidence, a.grantId),
      ...fenceStmts,
    ]);
    if (wire !== null) fenceEpoch = res[res.length - 3].results[0]?.epoch ?? null;
  } catch (e) {
    if (!/CHECK|constraint/i.test(String(e))) throw e;
    // The grant's fence is held by another owner: refused, nothing changed. Its owner is reported as the dispatch in the way.
    const account = await accountOf(db, a.grantId);
    const f = await db.prepare(`SELECT owner_kind AS kind,updated_at AS claimedAt,owner_expires_at AS expiresAt FROM flux_grant_fence WHERE grant_id=?`)
      .bind(wire).first<{ kind: string | null; claimedAt: number; expiresAt: number | null }>();
    return { claimed: false, open: f ? { kind: `fence:${f.kind ?? "unknown"}`, claimedAt: f.claimedAt, expiresAt: f.expiresAt ?? 0, by: null } : null, account };
  }
  const account = await accountOf(db, a.grantId);
  const mine = await db.prepare("SELECT adjustment_ref FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open'").bind(token).first<{ adjustment_ref: string }>();
  if (mine && account) {
    let wireRevision: number | null = null;
    if (wire !== null && fenceEpoch !== null) {
      wireRevision = await allocateFenceRevision(db, { grantId: wire, token, epoch: fenceEpoch }, { op: "operator" });
      if (wireRevision === null) {
        // Cannot happen under a claim just taken; refused rather than handing out an unfenced claim.
        await db.batch([
          db.prepare(`UPDATE flux_grant_dispatches SET state='superseded',outcome='grant_fence_lost',completed_at=${DB_NOW_MS} WHERE dispatch_id=? AND state='open'`).bind(token),
          db.prepare("UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL WHERE grant_id=? AND owner_token=?").bind(wire, token),
        ]);
        return { claimed: false, open: null, account };
      }
      await db.prepare("UPDATE flux_grant_dispatches SET wire_grant_id=?,remote_revision=? WHERE dispatch_id=? AND state='open'").bind(wire, wireRevision, token).run();
    }
    return { claimed: true, token, adjustmentRef: mine.adjustment_ref, account, wireGrantId: wire, wireRevision };
  }
  const open = await db.prepare("SELECT kind,claimed_at AS claimedAt,expires_at AS expiresAt,by FROM flux_grant_dispatches WHERE grant_id=? AND state='open'")
    .bind(a.grantId).first<{ kind: string; claimedAt: number; expiresAt: number; by: string | null }>();
  return { claimed: false, open, account };
}

/** H3 (Astra H2 #2): an operator dispatch row (`t`) is authorized at Flux: it holds the Flux grant's fence (live, its own token), or the grant
 *  has no Flux grant id at all (no invoice: nothing at the router can be fenced). A NULL wire grant id on an invoice-backed grant (a claim
 *  opened before 0109, which 0109 supersedes) is never authorized: the operator re-claims. */
const fencedOperator = (t: string): string => `(CASE WHEN ${t}.wire_grant_id IS NULL
  THEN NOT EXISTS (SELECT 1 FROM flux_grants g WHERE g.grant_id=${t}.grant_id AND g.invoice_id IS NOT NULL)
  ELSE EXISTS (SELECT 1 FROM flux_grant_fence f WHERE f.grant_id=${t}.wire_grant_id AND f.owner_token=${t}.dispatch_id AND f.owner_expires_at>${DB_NOW_MS}) END)`;
export type OperatorAppliedResult = "applied" | "claim_required" | "revision_mismatch" | "unsized" | "adjustment_ref_reused" | "adjustment_ref_mismatch"
  | "termination_unconfirmed" | "pending_verification" | "receipt_conflict" | "verification_mismatch" | "wire_revision_mismatch" | "fence_lost";
/** R10 / R11 (lane H1, Astra INTEGRATED-16 P1 "revoke A stalls -> B confirms -> restoration -> A lands"): a superseded revoke of the grant
 *  may still execute at Flux. R11, THE REMOTE FENCE: a revoke whose request carried a fenced revision (remote_revision, flux-grant-fence.ts)
 *  is TERMINATED exactly when Flux has applied that revision or a later one (flux_grant_fence.applied_revision, from a receipt, a stale
 *  answer or the GET-state reconciliation): Flux then refuses it (409 stale_revision) or answers its replay, so it can never remove a later
 *  restoration. Confirmation ORDER is never evidence for a fenced revoke. Only a revoke sent without a revision (none since lane H1) keeps
 *  the R10 rule (a later revoke confirmed). Binds: grantId. */
const REVOKE_UNTERMINATED = `EXISTS (SELECT 1 FROM flux_grant_dispatches x WHERE x.grant_id=? AND x.kind='revoke' AND x.state='superseded'
  AND CASE WHEN x.remote_revision IS NOT NULL
    THEN x.remote_revision > COALESCE((SELECT f.applied_revision FROM flux_grant_fence f WHERE f.grant_id=x.wire_grant_id),0)
    ELSE NOT EXISTS (SELECT 1 FROM flux_grant_dispatches y WHERE y.grant_id=x.grant_id AND y.kind='revoke' AND y.state='applied' AND y.claimed_at>=x.claimed_at) END)`;
/** L6/R8: the operator's RECEIPT, completing their own claim (the token). applied is what Flux holds for the grant after the hand adjustment;
 *  `adjustmentRef` is the Flux ledger entry of THIS grant (unique across all receipts), `grantId` and `revision` bind it to the claim (the
 *  revision the claim was made at). An unsized account needs `sizing` (the payment's amount and the evidence it was read from): D then
 *  follows the formula, never a typed amount. The debt stays exactly desired - applied (alerted while non-zero). Refused without an open
 *  claim of that token on that grant, on another revision, for an unsized account without sizing, or with a reference already used. */
export async function operatorApplied(db: D1Database, a: { grantId: string; token: string; revision: number; appliedMicrocents: number; adjustmentRef: string;
  /** H2: the Flux wire revision the claim allocated (operatorClaim's wireRevision), which the hand adjustment carried. Required when the claim
   *  holds the grant's fence. */
  wireRevision?: number;
  evidence: string; by: string; sizing?: { paidCents: number; evidence: string }; now: number; live?: boolean;
  /** R8c: what Flux's own record of this adjustment (its reference) says the grant holds; absent (Flux off, or no read API): pending. */
  verified?: { appliedMicrocents: number } | null }): Promise<OperatorAppliedResult> {
  // H2: a claim holding the Flux grant's fence counts only while it STILL owns it (no expiry, no takeover), checked in the statement itself.
  // H3 (Astra H2 #2): a claim WITHOUT a wire grant id counts only for a grant that has no Flux grant id (no invoice): an invoice-backed grant's
  // claim that holds no fence (one opened before 0109) is never authorized, whatever else holds.
  const owns = `EXISTS (SELECT 1 FROM flux_grant_dispatches d WHERE d.dispatch_id=? AND d.grant_id=? AND d.kind='operator' AND d.state='open' AND d.revision=?
    AND ${fencedOperator("d")})`;
  const claim = await db.prepare(`SELECT revision,adjustment_ref,receipt_at,receipt_microcents,wire_grant_id,remote_revision FROM flux_grant_dispatches WHERE dispatch_id=? AND grant_id=?
      AND kind='operator' AND state='open'`).bind(a.token, a.grantId).first<{ revision: number; adjustment_ref: string | null; receipt_at: number | null;
      receipt_microcents: number | null; wire_grant_id: string | null; remote_revision: number | null }>();
  if (!claim) return "claim_required";
  if (claim.revision !== a.revision) return "revision_mismatch";
  if (claim.adjustment_ref !== a.adjustmentRef) return "adjustment_ref_mismatch"; // R8b: only this claim's issued reference
  // H2: the receipt names the wire revision its claim allocated (the one the hand adjustment carried at Flux), and the claim still owns the fence.
  if (claim.wire_grant_id === null && await db.prepare("SELECT 1 AS x FROM flux_grants WHERE grant_id=? AND invoice_id IS NOT NULL").bind(a.grantId).first()) {
    return "fence_lost"; // H3: an unfenced (pre-0109) claim on an invoice-backed grant: re-claim
  }
  if (claim.wire_grant_id !== null && claim.remote_revision !== a.wireRevision) return "wire_revision_mismatch";
  if (claim.wire_grant_id !== null && !(await db.prepare(`SELECT 1 AS x FROM flux_grant_fence WHERE grant_id=? AND owner_token=? AND owner_expires_at>${DB_NOW_MS}`)
    .bind(claim.wire_grant_id, a.token).first())) return "fence_lost";
  // R8c: one receipt per claim: a second one stating another amount contradicts the pending one and is refused.
  if (claim.receipt_at !== null && claim.receipt_microcents !== a.appliedMicrocents) return "receipt_conflict";
  if (a.appliedMicrocents > 0 && await db.prepare(`SELECT 1 AS x WHERE ${REVOKE_UNTERMINATED}`).bind(a.grantId).first()) return "termination_unconfirmed"; // R10
  const used = await db.prepare("SELECT 1 AS x FROM flux_grant_dispatches WHERE adjustment_ref=? AND state='applied' AND dispatch_id<>?").bind(a.adjustmentRef, a.token).first();
  if (used) return "adjustment_ref_reused";
  const stmts: D1PreparedStatement[] = [];
  const verified = a.verified != null && a.verified.appliedMicrocents === a.appliedMicrocents;
  if (a.sizing) {
    const p = a.sizing.paidCents;
    stmts.push(db.prepare(`UPDATE flux_grant_accounts SET paid_cents=?1,paid_source='operator',sizing_evidence=?2,sized_by=?3,sized=1,
        desired_microcents=amount_microcents-(amount_microcents*MIN(returned_cents,?1))/?1,revision=revision+1,updated_at=?4
      WHERE grant_id=?5 AND sized=0 AND returned_cents>0 AND ?1>0
        AND EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=?6 AND grant_id=?7 AND kind='operator' AND state='open' AND revision=?8)`)
      .bind(p, a.sizing.evidence, a.by, a.now, a.grantId, a.token, a.grantId, a.revision));
  }
  if (!verified) {
    // R8c: PENDING VERIFICATION. Kept on the open claim (exactly once; the same receipt again changes nothing); the stored applied balance
    // and the alert's resolution wait for Flux's own record. The alert shows the stated amount and reference.
    stmts.push(
      db.prepare(`UPDATE flux_grant_dispatches SET receipt_microcents=?1,receipt_evidence=?2,receipt_by=?3,receipt_at=COALESCE(receipt_at,?4)
        WHERE dispatch_id=?5 AND grant_id=?6 AND kind='operator' AND state='open' AND revision=?7 AND ?1 BETWEEN 0 AND (SELECT amount_microcents FROM flux_grant_accounts WHERE grant_id=?6)
          AND (SELECT sized FROM flux_grant_accounts WHERE grant_id=?6)=1 AND (receipt_at IS NULL OR receipt_microcents=?1)
          AND ${fencedOperator("flux_grant_dispatches")}
        RETURNING dispatch_id`)
        .bind(a.appliedMicrocents, a.evidence, a.by, a.now, a.token, a.grantId, a.revision),
      ...syncAlertStatements(db, grantScope(a.grantId), a.now, a.live ?? true));
    const res = await db.batch(stmts);
    if ((res[a.sizing ? 1 : 0].results ?? []).length === 1) return a.verified != null ? "verification_mismatch" : "pending_verification";
    const acct = await accountOf(db, a.grantId);
    return acct && acct.sized === 0 ? "unsized" : "claim_required";
  }
  stmts.push(
    db.prepare(`UPDATE flux_grant_accounts SET applied_microcents=?,router_state='manual',revision=revision+1,settled_revision=revision+1,updated_at=?
      WHERE grant_id=? AND sized=1 AND ? BETWEEN 0 AND amount_microcents AND ${owns} AND (? = 0 OR NOT ${REVOKE_UNTERMINATED})`)
      .bind(a.appliedMicrocents, a.now, a.grantId, a.appliedMicrocents, a.token, a.grantId, a.revision, a.appliedMicrocents, a.grantId),
    db.prepare(`UPDATE flux_grant_dispatches SET state='applied',applied_microcents=?,evidence=?,adjustment_ref=?,by=?,completed_at=${DB_NOW_MS},
        outcome='revision:' || (SELECT revision FROM flux_grant_accounts WHERE grant_id=?)
      WHERE dispatch_id=? AND grant_id=? AND kind='operator' AND state='open' AND changes()=1`)
      .bind(a.appliedMicrocents, a.evidence, a.adjustmentRef, a.by, a.grantId, a.token, a.grantId),
    // H2: the claim's wire revision is settled (applied by hand) and the Flux grant's fence released, only with the receipt that applied.
    db.prepare(`UPDATE flux_grant_revisions SET outcome='applied_by_hand',settled_at=${DB_NOW_MS} WHERE op='operator' AND outcome IS NULL
      AND (grant_id,revision) IN (SELECT wire_grant_id,remote_revision FROM flux_grant_dispatches WHERE dispatch_id=?1 AND state='applied' AND wire_grant_id IS NOT NULL)`)
      .bind(a.token),
    db.prepare(`UPDATE flux_grant_fence SET owner_token=NULL,owner_kind=NULL,owner_expires_at=NULL,state_seq=state_seq+1,updated_at=${DB_NOW_MS}
      WHERE owner_token=?1 AND grant_id=(SELECT wire_grant_id FROM flux_grant_dispatches WHERE dispatch_id=?1 AND state='applied')`).bind(a.token),
    ...syncAlertStatements(db, grantScope(a.grantId), a.now, a.live ?? true),
  );
  let results: D1Result[];
  try { results = await db.batch(stmts); } catch (e) {
    if (/UNIQUE/i.test(String(e))) return "adjustment_ref_reused";
    throw e;
  }
  if (results[a.sizing ? 2 : 1].meta.changes === 1) return "applied";
  const acct = await accountOf(db, a.grantId);
  return acct && acct.sized === 0 ? "unsized" : "claim_required";
}
