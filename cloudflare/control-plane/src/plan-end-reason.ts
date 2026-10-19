// SPDX-License-Identifier: AGPL-3.0-or-later
// Follow-up 1 #1/#2: why a plan ended and where the refund that came with the end stands, derived from rows that already exist (no table of
// its own). One reader for the account summary (subscription.endedReason / refundState) and for the cancellation verifier, which retires a
// declaration the plan did not live to see (public-cancellation.ts supersedeOutlived), so both always name the same reason.
//
//   setup_failed_refunded  THIS contract's payment was given up on while its home was being set up: a provision-failed refund obligation
//                          (cloud_outbox refund:provision_failed:...) of a payment of this contract (its captured identity names this
//                          subscription, or the payment is this subscription's first invoice, or its refund operation ends this
//                          subscription), or (an older give-up with no such record) this subscription's own no_capacity refund operation on a
//                          home that was given up. Astra MAILRETRY-14 P2-b: never the home's history: a home given up for payment A and
//                          set up again for payment B reports B's own end, never A's failed setup.
//   withdrawn              a withdrawal of THIS contract (withdrawals.consent_id = the subscription's consent) or a withdrawal / first-month
//                          refund operation of THIS subscription whose own end step ran (refund_ops.canceled_at): a declined or still
//                          undecided first-month request ended nothing
//   dispute                a payment dispute ended it (billing_subscriptions.status 'disputed'; the dispute notice of this contract)
//   cancelled              anything else: a public or in-app cancellation, or Delete my Cloud (which ends the plan the in-app way)
// Astra INTEGRATED-5 #1: when several apply, the one that happened FIRST wins (the plan can end only once): an end already on record
// (billing_subscriptions.ended_at, which a later dispute never moves) is a "cancelled" candidate at its own time, so a dispute filed after the
// plan ended never renames it. Every piece of evidence is scoped to this contract (subscription id / consent id), never the home's history.
// Astra INTEGRATED-5 #2: refundState combines every refund operation that came with the end (end_plan=1) with the home's queued refund
// obligations (cloud_outbox refund_required), one entry per payment (an operation stands for its own payment's obligation): "pending" while
// ANY of them is unsettled, else "sent" when any was refunded, else null.

export type EndedReason = "setup_failed_refunded" | "withdrawn" | "dispute" | "cancelled";
export type RefundState = "pending" | "sent";
export interface PlanEnd { reason: EndedReason; at: number | null; refundState: RefundState | null }
export interface EndedSubRow { subscription_id: string | null; status: string; ended_at?: number | null; updated_at?: number | null }

/** Ties (or no time on record) go to the more specific reason, in this order. */
const PRECEDENCE: EndedReason[] = ["setup_failed_refunded", "withdrawn", "dispute", "cancelled"];

type Obligation = "pending" | "sent" | "none";

/** A refund obligation row (alias `o`) belongs to this contract's payment (numbered binds: ?1 the home, ?2 the subscription): the identity
 *  captured with it names this subscription, or its payment is this subscription's first invoice, or its payment's refund operation ends this
 *  subscription. A NULL subscription matches nothing. */
const OF_THIS_CONTRACT = (o: string) => `(EXISTS (SELECT 1 FROM cloud_refund_identities ri WHERE ri.obligation_id=${o}.id AND ri.subscription_id=?2)
  OR json_extract(${o}.payload,'$.paymentId') IN (SELECT s.first_invoice_id FROM billing_subscriptions s WHERE s.home_id=?1 AND s.subscription_id=?2
    AND s.first_invoice_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM refund_ops ro WHERE ro.id='no_capacity:'||json_extract(${o}.payload,'$.paymentId') AND ro.subscription_id=?2))`;

export async function planEndOf(env: Env, homeId: string, sub: EndedSubRow): Promise<PlanEnd> {
  const subId = sub.subscription_id;
  // This contract's consent (the checkout it was made by), and when it was made.
  const consentSql = "SELECT consent_id FROM billing_subscriptions WHERE home_id=? AND subscription_id IS ?";
  const [setupR, wdR, opR, disputeR, publicR, refundR, outboxR] = await env.DB.batch([
    env.DB.prepare(`SELECT MIN(at) AS at FROM (
        SELECT o.created_at AS at FROM cloud_outbox o WHERE o.home_id=?1 AND o.kind='refund_required' AND substr(o.id,1,24)='refund:provision_failed:'
          AND ${OF_THIS_CONTRACT("o")}
        UNION ALL
        SELECT x.created_at FROM refund_ops x WHERE x.home_id=?1 AND x.kind='no_capacity' AND x.end_plan=1 AND x.subscription_id=?2
          AND EXISTS (SELECT 1 FROM provision_attempts p WHERE p.home_id=x.home_id AND p.gave_up_at IS NOT NULL))`)
      .bind(homeId, subId),
    env.DB.prepare(`SELECT MIN(confirmed_at) AS at FROM withdrawals WHERE home_id=? AND consent_id IN (${consentSql})`).bind(homeId, homeId, subId),
    // Only an operation that actually ended THIS subscription (its end step ran: canceled_at), from the time it was asked for (Stripe's own
    // deletion event may land before the operation's checkpoint, so ended_at can precede canceled_at).
    env.DB.prepare(`SELECT MIN(created_at) AS at FROM refund_ops WHERE home_id=? AND kind IN ('withdrawal','first_month') AND end_plan=1
      AND canceled_at IS NOT NULL AND subscription_id IS ?`).bind(homeId, subId),
    env.DB.prepare(`SELECT MIN(created_at) AS at FROM billing_notices WHERE home_id=? AND kind='dispute_opened'
      AND created_at>=COALESCE((SELECT c.created_at FROM checkout_consents c WHERE c.id IN (${consentSql})),0)`).bind(homeId, homeId, subId),
    // A public cancellation that ended the plan itself (one retired because the plan ended earlier is superseded and never counts).
    env.DB.prepare(`SELECT MIN(COALESCE(effective_at,completed_at)) AS at FROM cancellation_requests WHERE subscription_id IS ? AND match_state='matched'
      AND status='completed' AND superseded_by IS NULL`).bind(subId),
    // Astra MAILRETRY-15 P2-a: an operation that names no subscription (planUnresolved) is never another contract's: it counts only when
    // its payment (invoice_id, or the payment its no_capacity:<payment> id names) is a payment of THIS contract (this subscription's first
    // invoice, or the payment of an obligation whose captured identity names this subscription); otherwise it is excluded.
    env.DB.prepare(`SELECT id,invoice_id,refunded_at,done_at FROM refund_ops ro WHERE ro.home_id=?1 AND ro.end_plan=1 AND ro.kind<>'external'
      AND ((?2 IS NOT NULL AND ro.subscription_id=?2) OR (ro.subscription_id IS NULL
        AND COALESCE(ro.invoice_id, CASE WHEN substr(ro.id,1,12)='no_capacity:' THEN substr(ro.id,13) END) IN (
          SELECT s.first_invoice_id FROM billing_subscriptions s WHERE s.home_id=?1 AND s.subscription_id IS ?2 AND s.first_invoice_id IS NOT NULL
          UNION ALL SELECT ri.payment_id FROM cloud_refund_identities ri WHERE ri.home_id=?1 AND ri.subscription_id IS ?2 AND ri.subscription_id IS NOT NULL)))`)
      .bind(homeId, subId),
    // A failed setup's (or a retired home's late payment's) refund is queued here first; the live refund sweep then opens its refund
    // operation (no_capacity:<payment>).
    // Astra MAILRETRY-14 P2-b: a provision-failed obligation counts only for the contract whose payment it refunds.
    env.DB.prepare(`SELECT id,payload,completed_at,receipt FROM cloud_outbox WHERE home_id=?1 AND kind='refund_required'
      AND (substr(id,1,24)<>'refund:provision_failed:' OR ${OF_THIS_CONTRACT("cloud_outbox")})`).bind(homeId, subId),
  ]);
  const at = (r: D1Result) => (r.results[0] as { at: number | null } | undefined)?.at ?? null;
  const setupAt = at(setupR);
  const withdrawnAt = [at(wdR), at(opR)].filter((x): x is number => x !== null);
  const candidates: { reason: EndedReason; at: number | null }[] = [
    ...(setupAt !== null ? [{ reason: "setup_failed_refunded" as const, at: setupAt }] : []),
    ...(withdrawnAt.length ? [{ reason: "withdrawn" as const, at: Math.min(...withdrawnAt) }] : []),
    ...(sub.status === "disputed" ? [{ reason: "dispute" as const, at: at(disputeR) ?? sub.updated_at ?? null }] : []),
    ...(at(publicR) !== null ? [{ reason: "cancelled" as const, at: at(publicR) }] : []),
    // The end already on record (ended_at is stamped once and never moved by a later dispute): whatever ended it then, nothing after renames it.
    ...(sub.ended_at != null ? [{ reason: "cancelled" as const, at: sub.ended_at }] : []),
  ];
  const key = (c: { at: number | null }) => c.at ?? Number.MAX_SAFE_INTEGER;
  candidates.sort((a, b) => key(a) - key(b) || PRECEDENCE.indexOf(a.reason) - PRECEDENCE.indexOf(b.reason));
  const first = candidates[0] ?? { reason: "cancelled" as const, at: sub.ended_at ?? null };

  // One obligation per payment: an operation stands for its payment; a queued row counts only while no operation of its payment exists.
  const owed = new Map<string, Obligation>();
  for (const o of refundR.results as { id: string; invoice_id: string | null; refunded_at: number | null; done_at: number | null }[]) {
    const state: Obligation = o.refunded_at !== null ? "sent" : o.done_at === null ? "pending" : "none";
    owed.set(`op:${o.id}`, state);
    if (o.invoice_id) owed.set(`pay:${o.invoice_id}`, state);
    if (o.id.startsWith("no_capacity:")) owed.set(`pay:${o.id.slice("no_capacity:".length)}`, state);
  }
  for (const r of outboxR.results as { id: string; payload: string | null; completed_at: number | null; receipt: string | null }[]) {
    let paymentId: string | null = null;
    try { paymentId = (JSON.parse(r.payload ?? "{}") as { paymentId?: unknown }).paymentId as string ?? null; } catch { /* unreadable: its own entry */ }
    const k = typeof paymentId === "string" && paymentId ? `pay:${paymentId}` : `outbox:${r.id}`;
    if (owed.has(k)) continue;
    // Settled without an operation (the B3 fake ledger) reads as refunded when its receipt says so.
    const refunded = (() => { try { return (JSON.parse(r.receipt ?? "{}") as { outcome?: string }).outcome === "refunded"; } catch { return false; } })();
    owed.set(k, r.completed_at === null ? "pending" : refunded ? "sent" : "none");
  }
  const states = [...owed.values()];
  const refundState: RefundState | null = states.includes("pending") ? "pending" : states.includes("sent") ? "sent" : null;
  return { reason: first.reason, at: first.at, refundState };
}
