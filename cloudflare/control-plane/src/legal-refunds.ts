// SPDX-License-Identifier: AGPL-3.0-or-later
// One refund ledger for every refund route (first-month offer, EU withdrawal, region hold, duplicate checkout).
// Each refund is a resumable operation with its own checkpoints: decide the amount (only once the payment and the included-credit use
// are KNOWN), refund through Stripe (idempotent by op id, and an ambiguous earlier attempt is settled by looking for a refund carrying the
// op id first), end the plan, take the plan's credits back, notify. A failed step is retried by the billing sweep with backoff and raises
// an ops alert; nothing is ever finalized as "nothing charged" while the payment state is unknown. The amounts decided against one payment
// can never add up to more than was paid: that is checked in the same D1 batch that decides an amount.
import { DAY_MS } from "./b5-config";
import { StripeError, type CreditNoteView, type RefundView, type StripeClient } from "./b5-stripe";
import { fence, fencedBatch, fencedRun, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { euUkFullDeadline, isRejectKind } from "./checkout-moments";
import { stripeEndConfirmed, SubscriptionParked } from "./subscription-gateway";
import { cancelConfirmed, NO_PRORATION, endSubscription, getSub, notify, coverageWatchQ, reconcilePaymentCoverage, fluxDispatchEnabled, type BillingDependencies, type FluxEntitlementHooks } from "./b5-billing";
import { applyServiceLog } from "./service-intervals";
import { DISPUTE_HELD_CODES, disputeHoldMatchSql } from "./dispute-sql";
import { checkoutRefundTarget, isCheckoutRefundKind, FROZEN_FRACTION_KINDS, refundsViaCreditNote, type RefundPath } from "./refund-kinds";
import { claimOfferStatements, denialText, receiptsToRecheck, refusalFenceStatements, refusalReceiptFor, refusalReceiptReopenable, refusalStands, RefusalWithdrawn,
  type RefusalReceipt } from "./refund-identity";
import { consentIsEu, getConsent, htmlOf, pinCurrentPayment, quoteFirstMonthRefund, refundedAgainst, disputeReturned, DISPUTE_RETURNED_SQL, DISPUTE_INEXACT_HELD_SQL, usd, type PinnedPayment, type RefundQuote } from "./legal-flows";

export type RefundKind = "first_month" | "withdrawal" | "duplicate" | "price_mismatch" | "no_capacity" | "late_payment" | "external"
  // Cloud checkout WP3 (refund-kinds.ts): whole-payment refunds of a purchase the guard turned down, the unused part of a replaced or
  // terminated period, a renewal collected after a cancellation took effect.
  | "mismatch" | "country_paused" | "rejected_consent" | "cutover" | "cancellation_late" | "extraordinary";
export interface RefundOpRow {
  id: string; kind: RefundKind; home_id: string; user_id: string; invoice_id: string | null; payment_intent: string | null; paid_cents: number | null;
  target_cents: number | null; amount_cents: number | null; basis: string | null; detail: string | null; end_plan: number; cancel_subscription_id: string | null;
  decided_at: number | null; stripe_refund_id: string | null; refunded_at: number | null; canceled_at: number | null; credits_revoked_at: number | null;
  notified_at: number | null; done_at: number | null; attempts: number; next_attempt_at: number | null; last_error: string | null; created_at: number;
  refund_status: string | null; submission: number; submitted_at: number | null; lease_until: number | null; subscription_id: string | null;
  /** Migration 0060. refund_submitted_at: the refund (direct: its credit note) exists at Stripe: the only date promised. stripe_refund_status:
   *  Stripe's own state, kept apart from it. cutover_at / old_*: frozen values of a pro-rata refund. */
  refund_submitted_at: number | null; stripe_refund_status: string | null; cutover_at: number | null; old_invoice_id: string | null;
  old_period_start: number | null; old_period_end: number | null; presentment_json: string | null; credit_note_id: string | null;
  /** Migration 0060 backfill: 1 until the submission date of a row written before it is confirmed from Stripe (reconcileRefundSubmissions). */
  submission_reconcile?: number;
  /** Migration 0060: the reconciliation's retry schedule (attempts, next try, last error). */
  reconcile_attempts?: number; reconcile_next_at?: number | null; reconcile_error?: string | null;
  /** Migration 0070 (Astra WP3-5): 1 while the operation's Stripe objects cannot be attributed to it alone. A held operation is never
   *  submitted, followed to success or completed until a person clears it. */
  attribution_hold?: number;
  /** Migration 0106 (INTEGRATED-13 P2): the release generation, raised by every wake of a dispute hold in this operation's scope. */
  wake_gen?: number;
  /** Migration 0070 (Astra WP3-6 #2): 1 = a success or completion recorded on a credit note before 0070, honoured only once the WHOLE note is
   *  validated (one refund carrying exactly the decided amount). */
  note_reconcile?: number;
  /** Migration 0070 (Astra WP3-6 #4): when the attribution reconciliation looks at this held operation next. */
  attribution_next_at?: number | null;
}
interface Detail { /** cancellation_late executed by an operator: the amount they decided (cents) and the record it executes. */
  /** Astra MAILRETRY-14 P2-a: a provision-failed refund opened while no identity source named its payment's subscription: the obligation and
   *  payment it was opened for, from which the subscription is resolved again on every pass (resolveRefundSubscription). */
  planUnresolved?: { obligationId: string; paymentId: string };
  operatorCents?: number; lateRecord?: string; suppliedMs?: number; revoke?: boolean; withdrawalId?: string; confirmedAt?: number; daysSupplied?: number; deductedCents?: number; periodDays?: number;
  /** Astra DROPDOWN-DIRECT-2 (1): a paid refusal opened before its invoice was known: the checkout session it was paid through, from which the
   *  invoice is recovered (Stripe) before the refund is decided. */
  sessionId?: string;
  /** The exact payment (invoice and payment intent) this operation was opened for, and the consent of its contract. Fixed at opening. */
  pay?: PinnedPayment; consentId?: string | null;
  /** Why the voluntary 7-day offer did not apply to a withdrawal (told to the customer with the refund). */
  offerDeclined?: string;
  /** The identity check could not run when a withdrawal was decided: the offer was applied unchecked rather than delay a statutory refund. */
  identityUnchecked?: boolean;
  /** Opened as the EU/UK 14-day full refund (not the 7-day offer). */
  euUkFull?: boolean;
  /** WP9 r1-4: an emailed withdrawal notice qualified for the full refund at `qualifyingAt` (its eligibility_at); frozen when the operation is
   *  opened, so the refund never depends on when the notice arrived or was executed. `confirmedAt` stays the effective time. */
  withdrawalEntitlement?: "eu_uk_full"; qualifyingAt?: number;
  /** LEGACY, no longer written or read: operations opened before 2026-10-12 may carry it (the offer skipped when credit use was unreadable). */
  offerSkipped?: string;
  /** LEGACY, no longer written or read: the credit deduction once measured for the 7-day offer. Since 2026-10-12 (Sean) the offer deducts
   *  nothing for credits used, so a request saved with a deduction is decided at the full fee. */
  usedCreditCents?: number;
  /** Astra NODEDUCT-1 #1: a legacy decision made at the fee minus credits used, upgraded (provably unsubmitted) to the full fee: the amount it had. */
  legacyUpgradedFromCents?: number;
  /** Astra NODEDUCT-1 #1: a legacy deducted decision whose refund may have been (or was) paid at the old amount: the operation that pays the rest
   *  (on the parent), and the parent it pays the rest of (on that operation). Part of the SAME one-per-person refund, never a second one. */
  legacyRemainderOp?: string; legacyRemainderOf?: string;
  /** Decided after the payment passed the 24-month identity retention: honoured without the one-per-person check (ASTRA-REFUND3 #3). */
  identityExpired?: boolean;
  /** WP3: the seller path of the contract this refund belongs to (callers set it from sellerOfConsent): direct = credit note, mp = POST /v1/refunds. */
  path?: RefundPath;
  /** WP3: the invoice's tax, and the tax portion of the amount decided (recorded with the presentment amount). */
  invoiceTaxCents?: number; refundTaxCents?: number;
  /** Round 8b: the amount decided before the payment's dispute was lost, lowered by what the bank returned (capForDisputeReturn). Round 9b:
   *  the FIRST decided amount, kept across caps, so a later reinstatement restores up to it (restoreForDisputeReinstatement). */
  disputeCappedFromCents?: number;
  /** Round 9b (P1-6): the capped operation whose remainder this one pays after a reinstatement (its money step had already run). Part of the
   *  SAME obligation, under the parent's original deadline. */
  disputeRemainderOf?: string }

/** Decision A (Sean, 2026-10-10): every server starts at payment, and an EU, EEA or UK consumer who asks within 14 days of that start gets
 *  everything they paid back. An entitlement of its own: no one-per-person, previous-offer, credit-use or abuse check ever applies to it,
 *  and it never reads or claims the identity tables. */
export const EU_UK_FULL_REFUND_MS = 14 * DAY_MS;
export const euUkFullRefundDue = (consent: { eu_region: number; effective_eu_region: number | null; statutory_withdraw_until?: number | null;
  guarantee_withdraw_until?: number | null } | null, paidAt: number, askedAt: number): boolean =>
  consent !== null && consentIsEu(consent) && askedAt <= euUkFullDeadline(consent, paidAt);

/** The EU/UK 14-day full refund the home's current payment is entitled to when asked at `askedAt`, or null. The ONE calculation behind
 *  both the preview (dry run) and the request that opens the operation (Astra ASTRA-REFUND2 #6); the operation's decision applies the
 *  same euUkFullRefundDue to the payment and consent pinned here. */
export interface EuUkEntitlement { ownerId: string; pay: PinnedPayment; subscriptionId: string; consentId: string }
/** `pinned`: a recorded refund request's own snapshot (Astra JOURNEY-A-2 A2): its payment (invoice) and the consent of its contract, as
 *  recorded at receipt. The entitlement is then judged on THAT consent (its region, its frozen deadlines), never the home's live one, and only
 *  for that payment; a request recorded without a consent has no contract to judge the EU/UK entitlement on (as at its receipt). */
export async function euUkFullRefundFor(env: Env, homeId: string, askedAt: number,
  pinned?: { invoiceId: string; consentId: string | null; snapshot?: { pay: PinnedPayment; subscriptionId: string } | null }): Promise<EuUkEntitlement | null> {
  const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=?").bind(homeId).first<{ owner_id: string }>();
  // Astra JOURNEY-A-3 #6: a request whose payment a replacement superseded brings that payment's own snapshot (and its subscription).
  const snap = pinned?.snapshot && pinned.snapshot.pay.invoiceId === pinned.invoiceId ? pinned.snapshot : null;
  const pay = snap ? snap.pay : await pinCurrentPayment(env, homeId);
  const cur = snap ? null : await getSub(env, homeId);
  const subscriptionId = snap ? snap.subscriptionId : cur?.subscription_id ?? null;
  const consentId = pinned ? pinned.consentId : cur?.consent_id ?? null;
  const consent = consentId ? await getConsent(env, consentId) : null;
  if (pinned && (pay?.invoiceId !== pinned.invoiceId || (consent !== null && consent.home_id !== homeId))) return null;
  if (!owner || !pay || !subscriptionId || !consent || !euUkFullRefundDue(consent, pay.paidAt, askedAt)) return null;
  return { ownerId: owner.owner_id, pay, subscriptionId, consentId: consent.id };
}
/** The preview of that entitlement, in the quote's shape: everything paid, less anything already refunded against the payment. */
export async function euUkFullRefundQuote(env: Env, homeId: string, e: EuUkEntitlement, exceptOp?: string): Promise<RefundQuote & { basis: "eu_uk_full_refund" }> {
  const already = await refundedAgainst(env, e.pay.invoiceId, exceptOp);
  const owed = Math.max(0, e.pay.paidCents - already);
  const windowEndsAt = euUkFullDeadline((await getConsent(env, e.consentId)) ?? {}, e.pay.paidAt);
  return { eligible: owed > 0, reason: owed > 0 ? null : "already_refunded", homeId, userId: e.ownerId, invoiceId: e.pay.invoiceId, paymentIntent: e.pay.paymentIntent,
    paidCents: e.pay.paidCents, feeCents: Math.max(0, e.pay.paidCents - e.pay.taxCents), taxCents: e.pay.taxCents, usedCreditCents: 0,
    refundNetCents: Math.max(0, e.pay.paidCents - e.pay.taxCents), refundTaxCents: e.pay.taxCents, alreadyRefundedCents: already, refundCents: owed,
    windowEndsAt, startsWhenReady: false, window: { deadline: windowEndsAt, startsWhenReady: false }, creditMeasured: false, oncePerPerson: false, basis: "eu_uk_full_refund" };
}

/** Not a failure: a fact this operation needs is not known yet (the payment, or B4's credit use). Retried; alerts after a few tries. */
export class RefundPending extends Error {}
/** Astra INTEGRATED-13 P1-2: a dispute hold stops this operation's DECISION (payment_dispute_hold). `endEligible`: the request's eligibility
 *  is nevertheless established (a statutory EU/UK full refund, or the 7-day offer with no other payment holding the person's one refund,
 *  and something still owed on the payment): the contract it ends is ended now, independently of the hold, which only defers the money. */
export class DisputeHeld extends RefundPending {
  constructor(readonly endEligible = false) { super("payment_dispute_hold"); }
}
/** G-F1 (STRIPE-8) / Astra INTEGRATED-11: a dispute EVENT in this payment's scope arrived and is not applied yet (b5-billing.ts
 *  holdDisputeFirst, one row per event): nothing of it is decided, submitted or adopted until that event's checkpoint commits (or an operator
 *  closes the hold with evidence). A hold matches by ITS scope only: the same payment intent, the same invoice (P1-3: admission is held across
 *  the invoice), or, for a hold scoped to a customer alone (no payment or invoice known), this home's customer. Never a hold with no scope:
 *  another customer's dispute never holds this refund (P1-2). INTEGRATED-12: a hold whose scope is not attributed yet (scope_pending: its
 *  invoice, or anything at all, unknown) holds every refund it could belong to (its customer's, else every refund) until it is resolved. */
export async function disputeHeldFirst(env: Env, s: { paymentIntent?: string | null; invoiceId?: string | null; homeId?: string | null }): Promise<boolean> {
  const pi = s.paymentIntent ?? null; const inv = s.invoiceId ?? null; const home = s.homeId ?? null;
  if (!pi && !inv && !home) return false;
  return await env.DB.prepare(`SELECT 1 AS x FROM dispute_holds h WHERE ${disputeHoldMatchSql("?1", "?2", "?3")} LIMIT 1`)
    .bind(pi, inv, home).first() !== null;
}
/** Astra MAILRETRY-14 P2-a: the plan this operation must end is not known yet (no identity source names the payment's subscription). The
 *  money is refunded regardless; the end stays OPEN (canceled_at NULL, the operation not done) and is re-evaluated on every pass. */
export class PlanUnresolved extends Error { constructor() { super("plan_unresolved"); } }
/** The alert raised while a refund's plan is unresolved (one per operation); resolved when the plan's end is confirmed. */
export const planUnresolvedAlertId = (opId: string) => `alert:refund_plan_unresolved:${opId}`;

/** Astra MAILRETRY-13 P1-5 / MAILRETRY-14 P2-a: the subscription a provision-failed refund obligation must end, from the payment's OWN
 *  identity, never "the home's subscription now". In order: the identity captured with the obligation at the give-up
 *  (cloud_refund_identities, which an operator may also fill in by hand); the invoice's own subscription (Stripe's fact about this payment);
 *  the home's subscription only where this invoice is provably its FIRST invoice. Null: unresolved (nothing is ended, nothing is recorded as
 *  ended). `invoice` is the already-read Stripe invoice, when the caller has it. */
export async function resolveRefundSubscription(env: Env, stripe: StripeClient, homeId: string, obligationId: string, paymentId: string,
  invoice?: { subscription: string | null }): Promise<string | null> {
  const captured = await env.DB.prepare("SELECT subscription_id FROM cloud_refund_identities WHERE obligation_id=? AND payment_id=?")
    .bind(obligationId, paymentId).first<{ subscription_id: string | null }>();
  if (captured?.subscription_id) return captured.subscription_id;
  const fromStripe = (invoice ?? await stripe.getInvoice(paymentId)).subscription;
  if (fromStripe) return fromStripe;
  const proven = await env.DB.prepare("SELECT subscription_id FROM billing_subscriptions WHERE home_id=? AND first_invoice_id=?")
    .bind(homeId, paymentId).first<{ subscription_id: string | null }>();
  return proven?.subscription_id ?? null;
}
/** Stripe accepted the refund but has not finished it (pending / requires_action): checked again later, never counted as refunded. */
class RefundWaiting extends Error {}
/** Another decision for the same payment committed first: decide again from the new ledger state. */
class LedgerConflict extends Error {}

export interface RefundContext { stripe: StripeClient; flux: FluxEntitlementHooks; deps: BillingDependencies; now: number; lease?: HomeLease | null }

export const getRefundOp = (env: Env, id: string) => env.DB.prepare("SELECT * FROM refund_ops WHERE id=?").bind(id).first<RefundOpRow>();

export function refundOpInsert(op: { id: string; kind: RefundKind; homeId: string; userId: string; invoiceId?: string | null; paidCents?: number | null;
  targetCents?: number | null; endPlan: boolean; cancelSubscriptionId?: string | null; detail?: Detail; subscriptionId?: string | null; paymentIntent?: string | null;
  /** false: the operation's subscription is exactly `subscriptionId` (possibly unknown), never the home's current one (a refund of a known
   *  payment whose own contract was resolved). */
  inheritSubscription?: boolean;
  /** WP3, cutover and extraordinary: the values the fraction is computed from, frozen when the operation is opened and never read elsewhere. */
  frozen?: { cutoverAt: number; oldInvoiceId: string; oldPeriodStart: number; oldPeriodEnd: number };
  /** WP9: open the operation only if this condition holds, in the same batch as the transition that authorizes it (`[sql, ...binds]`; a loser of a
   *  race writes nothing). */
  when?: [string, ...unknown[]] }, now: number): Q {
  // An operation that ends a plan ends THAT subscription (subscription_id): a later replacement contract is never suppressed by it.
  const values = `?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,CASE WHEN ? THEN (SELECT subscription_id FROM billing_subscriptions WHERE home_id=?) END),?,?,?,?`;
  const binds = [op.id, op.kind, op.homeId,
    op.userId, op.invoiceId ?? null, op.paidCents ?? null, op.targetCents ?? null, op.endPlan ? 1 : 0, op.cancelSubscriptionId ?? null, JSON.stringify(op.detail ?? {}), now, now, op.paymentIntent ?? op.detail?.pay?.paymentIntent ?? null,
    op.subscriptionId ?? op.cancelSubscriptionId ?? null, op.inheritSubscription === false ? 0 : 1, op.homeId,
    op.frozen?.cutoverAt ?? null, op.frozen?.oldInvoiceId ?? null, op.frozen?.oldPeriodStart ?? null, op.frozen?.oldPeriodEnd ?? null];
  const cols = "id,kind,home_id,user_id,invoice_id,paid_cents,target_cents,end_plan,cancel_subscription_id,detail,created_at,updated_at,payment_intent,subscription_id,cutover_at,old_invoice_id,old_period_start,old_period_end";
  if (op.when) {
    const [cond, ...condBinds] = op.when;
    return q(`INSERT INTO refund_ops (${cols}) SELECT ${values} WHERE ${cond} ON CONFLICT(id) DO NOTHING`, ...binds, ...condBinds);
  }
  return q(`INSERT INTO refund_ops (${cols}) VALUES (${values}) ON CONFLICT(id) DO NOTHING`, ...binds);
}

/** Records the first paid invoice of a plan (also used when the payment state is settled from Stripe instead of a webhook). */
export async function recordFirstInvoice(env: Env, lease: HomeLease, homeId: string, i: FirstInvoice): Promise<void> {
  await fencedBatch(env, lease, [firstInvoiceStatement(homeId, i)]);
}
export interface FirstInvoice { id: string; paidAt: number; cents: number; taxCents: number; periodStart: number | null; periodEnd: number | null; paymentIntent: string | null }
/** The first-payment record as one statement, for a batch that records the order's paid moment with it (Astra WP5-1 #3). Written once. */
export const firstInvoiceStatement = (homeId: string, i: FirstInvoice): Q => q(`UPDATE billing_subscriptions SET first_invoice_id=?,first_paid_at=?,first_invoice_cents=?,first_invoice_tax_cents=?,
      first_period_start=?,first_period_end=?,first_payment_intent=? WHERE home_id=? AND first_invoice_id IS NULL`,
  i.id, i.paidAt, i.cents, i.taxCents, i.periodStart, i.periodEnd, i.paymentIntent, homeId);

/** Invoices that a region-hold or duplicate refund owns entirely are not the plan's first payment. */
async function ownedElsewhere(env: Env, invoiceId: string) {
  return (await env.DB.prepare("SELECT 1 AS x FROM refund_ops WHERE invoice_id=? AND kind IN ('duplicate','price_mismatch','late_payment','mismatch','country_paused','rejected_consent')").bind(invoiceId).first()) !== null;
}

/** The plan's payment: known from our records, settled from Stripe when a webhook is late, confirmed zero only when nothing can have been charged. */
type Payment = { charged: false } | { charged: true; paid: number; tax: number; invoiceId: string; paymentIntent: string | null; paidAt: number; periodStart: number | null;
  periodEnd: number | null };
async function resolvePayment(env: Env, ctx: RefundContext, homeId: string, at: number, opSubscriptionId: string | null): Promise<Payment> {
  let sub = await getSub(env, homeId);
  if (!sub) throw new RefundPending("subscription_unknown");
  if (opSubscriptionId && sub.subscription_id !== opSubscriptionId) {
    // The home has moved on to a replacement subscription: THIS operation's payment is the one of the subscription it captured, read from
    // Stripe (the home's own payment columns now describe the replacement, which this operation must never touch).
    const own = [...(await ctx.stripe.listPaidInvoices(opSubscriptionId)).data].filter((i) => i.amount_paid > 0).sort((a, b) => a.created - b.created);
    for (const inv of own) {
      if (await ownedElsewhere(env, inv.id)) continue;
      const period = inv.lines?.data?.[0]?.period;
      return { charged: true, paid: inv.amount_paid, tax: typeof inv.tax === "number" ? inv.tax : 0, invoiceId: inv.id, paymentIntent: inv.payment_intent, paidAt: inv.created * 1000,
        periodStart: typeof period?.start === "number" ? period.start * 1000 : null, periodEnd: typeof period?.end === "number" ? period.end * 1000 : null };
    }
    return { charged: false };
  }
  const consent = sub.consent_id ? await getConsent(env, sub.consent_id) : null;
  if (!sub.first_invoice_id && sub.subscription_id) {
    const list = await ctx.stripe.listPaidInvoices(sub.subscription_id);
    const paidInvoices = [...list.data].filter((i) => i.amount_paid > 0).sort((a, b) => a.created - b.created);
    for (const inv of paidInvoices) {
      if (await ownedElsewhere(env, inv.id)) continue;
      const period = inv.lines?.data?.[0]?.period;
      await recordFirstInvoice(env, ctx.lease!, homeId, { id: inv.id, paidAt: inv.created * 1000, cents: inv.amount_paid, taxCents: typeof inv.tax === "number" ? inv.tax : 0,
        periodStart: typeof period?.start === "number" ? period.start * 1000 : null, periodEnd: typeof period?.end === "number" ? period.end * 1000 : null,
        paymentIntent: inv.payment_intent });
      break;
    }
    sub = (await getSub(env, homeId))!;
  }
  if (sub.first_invoice_id && sub.first_invoice_cents) {
    const row = await env.DB.prepare("SELECT first_invoice_tax_cents AS t, first_period_start AS ps, first_period_end AS pe, first_payment_intent AS pi FROM billing_subscriptions WHERE home_id=?")
      .bind(homeId).first<{ t: number | null; ps: number | null; pe: number | null; pi: string | null }>();
    return { charged: true, paid: sub.first_invoice_cents, tax: row?.t ?? 0, invoiceId: sub.first_invoice_id, paymentIntent: row?.pi ?? null, paidAt: sub.first_paid_at ?? at, periodStart: row?.ps ?? null, periodEnd: row?.pe ?? null };
  }
  // Nothing recorded and nothing paid at Stripe. Zero is confirmed only for a completed checkout Stripe itself reported as $0; anything
  // else (a paid checkout whose invoice is not visible yet) stays unknown and is retried, never finalized as "nothing charged".
  if (!consent || consent.completed_at === null) throw new RefundPending("payment_unknown");
  // Payment never confirmed (still pending, or failed): nothing was charged for the plan. Zero is also confirmed for a $0 checkout.
  if (consent.paid_at === null || consent.total_cents === 0) return { charged: false };
  throw new RefundPending("payment_unknown");
}

/** Astra LIMITVER-2: the consent of the contract a pinned payment was made under, for an operation saved without it. The home's row while it
 *  still binds that same first invoice; else the completed checkout of the subscription the operation was opened for (a replacement has since
 *  taken the home's row). Null when neither is recorded. */
export async function pinnedPaymentConsent(env: Env, op: Pick<RefundOpRow, "home_id" | "user_id" | "subscription_id">, pay: PinnedPayment): Promise<string | null> {
  const row = await env.DB.prepare("SELECT consent_id AS c FROM billing_subscriptions WHERE home_id=? AND first_invoice_id=?")
    .bind(op.home_id, pay.invoiceId).first<{ c: string | null }>();
  if (row?.c) return row.c;
  if (!op.subscription_id) return null;
  return (await env.DB.prepare(`SELECT id FROM checkout_consents WHERE home_id=? AND user_id=? AND stripe_subscription_id=? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT 1`).bind(op.home_id, op.user_id, op.subscription_id).first<{ id: string }>())?.id ?? null;
}

async function decide(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<void> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  let invoiceId = op.invoice_id; let paid = op.paid_cents ?? 0; let target = op.target_cents ?? 0; let basis = op.basis ?? op.kind;
  let paymentIntent = op.payment_intent; let claimOffer = false;
  // A withdrawal that applies the optional 7-day uplift: its statutory pro-rata amount, settled at once if the offer's claim conflicts.
  let statutory: number | null = null;
  // Whether a claim conflict refuses this decision: only for a customer the one-per-person limit binds (or an offer applied unchecked).
  let claimGuard = true;
  // Round 9b (P1-6): the remainder of a capped operation (disputeRemainderOf): what a reinstatement gave back that the parent, already paid at
  // its capped amount, can no longer pay itself. The parent's own payment; at most its first decided amount less everything it and its
  // remainders already decided, and never more than the payment still allows (the ledger rule below). No claim, no credit change.
  let remainderCap: number | null = null;
  if (detail.disputeRemainderOf) {
    const parent = await getRefundOp(env, detail.disputeRemainderOf);
    const from = parent ? (JSON.parse(parent.detail ?? "{}") as Detail).disputeCappedFromCents : undefined;
    if (!parent || parent.home_id !== op.home_id || parent.invoice_id === null || parent.invoice_id !== op.invoice_id || typeof from !== "number") {
      target = 0; basis = "already_refunded"; paid = 0; remainderCap = 0;
    } else {
      const cap = await disputeCapDue(env, parent, from);
      invoiceId = parent.invoice_id; paid = parent.paid_cents ?? 0; paymentIntent = parent.payment_intent; basis = "dispute_reinstated";
      remainderCap = cap ? Math.max(0, cap.due - cap.mine) : 0;
    }
    detail.revoke = false;
  } else if (op.kind === "first_month" && detail.euUkFull && detail.pay) {
    // The EU/UK 14-day full refund: the whole payment, judged at the request's receipt time. Nothing else is read.
    const consent = detail.consentId ? await getConsent(env, detail.consentId) : null;
    invoiceId = detail.pay.invoiceId; paid = detail.pay.paidCents; paymentIntent = detail.pay.paymentIntent;
    const due = euUkFullRefundDue(consent, detail.pay.paidAt, op.created_at);
    basis = due ? "eu_uk_full_refund" : "window_expired"; target = due ? paid : 0;
    detail.revoke = due && paid > 0;
  } else if (op.kind === "first_month" && detail.legacyRemainderOf) {
    // Astra NODEDUCT-1 #1: the rest of a legacy deducted refund already paid at the old amount. The parent's own payment, the FULL invoice as
    // the target; the ledger rule below caps it at what is still undecided for that invoice. No new claim (the parent holds the person's one
    // refund), no credit revocation (the parent takes the credits back).
    const parent = await getRefundOp(env, detail.legacyRemainderOf);
    if (!parent || parent.home_id !== op.home_id || parent.user_id !== op.user_id || parent.kind !== "first_month" || parent.invoice_id === null
      || parent.invoice_id !== op.invoice_id || parent.basis !== "seven_day_offer") { target = 0; basis = "already_refunded"; paid = 0; }
    else {
      if (parent.refunded_at === null) throw new RefundPending("legacy_parent_unpaid");
      invoiceId = parent.invoice_id; paid = parent.paid_cents ?? 0; paymentIntent = parent.payment_intent; basis = "seven_day_offer"; target = paid;
    }
    detail.revoke = false;
  } else if (op.kind === "first_month") {
    // The payment this operation was opened for, never whatever the home holds now (a replacement subscription may have taken the home).
    if (!detail.pay && op.invoice_id) {
      const cur = await getSub(env, op.home_id);
      if (cur?.first_invoice_id !== op.invoice_id) throw new RefundPending("payment_changed");
    }
    // Astra LIMITVER-2: an operation saved with its pinned payment but without that payment's consent (a request reopened before the consent
    // was saved with it) recovers it here, before the quote's own lookup by the home's current row, and keeps it with the decision.
    // Astra JOURNEY-A-3 #5: only an UNSPECIFIED consent is recovered; an explicitly pinned null (a request recorded without one) stays null.
    if (detail.pay && detail.consentId === undefined) {
      const recovered = await pinnedPaymentConsent(env, op, detail.pay);
      if (recovered) detail.consentId = recovered;
    }
    const q = await quoteFirstMonthRefund(env, op.home_id, op.created_at, { exceptOp: op.id, ignoreClaim: true, pinned: detail.pay, consentId: detail.consentId,
      stripe: ctx.stripe, processedAt: ctx.now });
    if (q.reason === "identity_check_unavailable") throw new RefundPending(q.reason);
    invoiceId = q.invoiceId; paid = q.paidCents; paymentIntent = q.paymentIntent; basis = q.eligible ? "seven_day_offer" : q.reason ?? "not_eligible";
    target = q.eligible ? q.refundNetCents + q.refundTaxCents : 0;
    // A refused request takes nothing back: the plan goes on (it was never cancelled: the decision comes first for this kind).
    detail.revoke = paid > 0 && target > 0;
    claimOffer = q.eligible; claimGuard = q.oncePerPerson;
    if (q.identityExpired) detail.identityExpired = true;
  } else if (op.kind === "withdrawal") {
    const at = detail.confirmedAt ?? op.created_at;
    const pay = await resolvePayment(env, ctx, op.home_id, at, op.subscription_id);
    if (!pay.charged) { invoiceId = null; paid = 0; target = 0; basis = "nothing_charged"; detail.revoke = false; detail.daysSupplied = 0; detail.deductedCents = 0; }
    else {
      invoiceId = pay.invoiceId; paid = pay.paid; paymentIntent = pay.paymentIntent; detail.revoke = true;
      const sub = (await getSub(env, op.home_id))!;
      // The consent of THIS operation's contract (captured when it was opened), not the replacement's.
      const consentRef = detail.consentId !== undefined ? detail.consentId : sub.consent_id;
      const consent = consentRef ? await getConsent(env, consentRef) : null;
      const fee = Math.max(0, paid - pay.tax);
      const periodDays = pay.periodStart && pay.periodEnd ? Math.max(1, Math.round((pay.periodEnd - pay.periodStart) / DAY_MS)) : 30;
      // Deductions count only for service actually supplied: the lifecycle's ready intervals (canary passed until it stopped being served),
      // up to the withdrawal. A queued payment or a home that never came up supplies nothing.
      // Only service supplied under THIS contract's subscription counts (an interval of a predecessor, or one with no subscription recorded,
      // never does), and only from the moment the contract was made.
      await applyServiceLog(env, ctx.lease!); // the lifecycle's journaled service changes, applied first under this lease
      const intervals = op.subscription_id ? await env.DB.prepare("SELECT started_at,ended_at FROM service_intervals WHERE home_id=? AND subscription_id=? AND started_at<?")
        .bind(op.home_id, op.subscription_id, at).all<{ started_at: number; ended_at: number | null }>() : { results: [] as { started_at: number; ended_at: number | null }[] };
      // Clipped to the contract's own window: not before the contract (the early-start request is made at checkout) nor before the paid
      // period began, and not after the withdrawal or the end of that period.
      const lo = Math.max(consent?.created_at ?? 0, pay.periodStart ?? 0);
      const hi = Math.min(at, pay.periodEnd ?? at);
      const suppliedMs = intervals.results.reduce((n, r) => n + Math.max(0, Math.min(r.ended_at ?? hi, hi) - Math.max(r.started_at, lo)), 0);
      const days = consent?.early_start === 1 && suppliedMs > 0 ? Math.min(periodDays, Math.ceil(suppliedMs / DAY_MS)) : 0; // recorded only
      detail.suppliedMs = suppliedMs;
      // r13 (plan §3.1): no deduction is claimed for service supplied before a withdrawal (Art 14(4)(a) is absorbed): a withdrawal is refunded in full.
      const deducted = 0;
      const refundNet = Math.max(0, fee - deducted);
      const proRata = fee > 0 ? refundNet + Math.round(pay.tax * refundNet / fee) : 0;
      if (detail.withdrawalEntitlement === "eu_uk_full" || euUkFullRefundDue(consent, pay.paidAt, at)) {
        // Within 14 days of the server's start (its payment): everything paid comes back, nothing deducted, no offer needed.
        basis = "eu_uk_full_refund"; target = paid;
        Object.assign(detail, { daysSupplied: days, deductedCents: 0, periodDays });
      } else {
      const offerOpts = { exceptOp: op.id, consentId: consentRef,
        pinned: { invoiceId: pay.invoiceId, paymentIntent: pay.paymentIntent, paidCents: pay.paid, taxCents: pay.tax, paidAt: pay.paidAt, periodStart: pay.periodStart, periodEnd: pay.periodEnd },
        stripe: ctx.stripe, processedAt: ctx.now };
      let offer = await quoteFirstMonthRefund(env, op.home_id, at, offerOpts);
      // The voluntary offer only ever ADDS to the statutory refund: a payment that is not the customer's first still gets its pro-rata
      // withdrawal refund below. A one-per-person check that cannot run (no REFUND_KEY_SECRET, Stripe unreachable) never delays a
      // statutory refund: the customer gets the benefit of the doubt and the offer is applied unchecked (logged in the detail).
      if (offer.reason === "identity_check_unavailable") {
        offer = await quoteFirstMonthRefund(env, op.home_id, at, { ...offerOpts, skipIdentity: true });
        detail.identityUnchecked = true;
      }
      if (offer.reason === "not_first_payment") detail.offerDeclined = offer.reason;
      const offerGross = offer.eligible ? offer.refundNetCents + offer.refundTaxCents : 0;
      basis = offerGross > proRata ? "seven_day_offer" : "pro_rata";
      claimOffer = basis === "seven_day_offer"; claimGuard = offer.oncePerPerson || detail.identityUnchecked === true;
      target = Math.max(proRata, offerGross);
      if (claimOffer) statutory = proRata;
      Object.assign(detail, { daysSupplied: days, deductedCents: deducted, periodDays });
      }
    }
  } else if (isCheckoutRefundKind(op.kind)) {
    // Cloud checkout WP3: the amount is round(invoice.amount_paid x fraction) of ONE invoice. Whole-invoice kinds take fraction 1; cutover
    // and extraordinary take the fraction of the FROZEN period (cutover_at, old_period_start, old_period_end) of the frozen old invoice.
    const frozenKind = FROZEN_FRACTION_KINDS.includes(op.kind);
    const inv = frozenKind ? op.old_invoice_id : (detail.pay?.invoiceId ?? op.invoice_id);
    if (!inv) throw new RefundPending(frozenKind ? "frozen_values_missing" : "payment_unknown");
    // The invoice and its payment are ONE bound pair, both from the selected invoice: the payment intent the operation was opened with (or
    // pinned for another invoice) is never carried over, since for a cutover it is the REPLACEMENT's payment (Astra WP3-1 #2). While the
    // selected invoice's payment is not known, the operation waits (payment_unresolved) and nothing is decided.
    let tax: number;
    if (detail.pay && detail.pay.invoiceId === inv) { paid = detail.pay.paidCents; tax = detail.pay.taxCents; paymentIntent = detail.pay.paymentIntent ?? null; }
    else { const live = await ctx.stripe.getInvoice(inv); paid = live.amount_paid; tax = typeof live.tax === "number" ? live.tax : 0; paymentIntent = live.payment_intent ?? null; }
    if (paid > 0 && !paymentIntent && detail.pay?.invoiceId === inv) paymentIntent = (await ctx.stripe.getInvoice(inv)).payment_intent ?? null;
    if (paid > 0 && !paymentIntent) throw new RefundPending("payment_unresolved");
    invoiceId = inv; detail.invoiceTaxCents = tax;
    const t = checkoutRefundTarget(op.kind, paid, { cutoverAt: op.cutover_at, oldPeriodStart: op.old_period_start, oldPeriodEnd: op.old_period_end });
    if (t === null) throw new RefundPending("frozen_values_missing");
    target = t; basis = frozenKind || (op.kind === "cancellation_late" && op.cutover_at !== null) ? "unused_fraction" : "full_refund";
    // Astra JOURNEY-BCORE-3 #5-#8: a post-promise charge executed by an operator refunds exactly the amount the operator decided (never more than
    // the payment); nothing here computes it.
    if (op.kind === "cancellation_late" && typeof detail.operatorCents === "number") {
      target = Math.max(0, Math.min(detail.operatorCents, paid)); basis = target >= paid ? "full_refund" : "unused_fraction";
    }
    detail.revoke = detail.revoke === true; // set by the caller that opened the operation; none of these kinds takes credits back on its own
  } else {
    detail.revoke = false; // region hold and duplicate payments never started a plan
  }
  if (paid > 0 && !paymentIntent && invoiceId) paymentIntent = (await ctx.stripe.getInvoice(invoiceId)).payment_intent;
  // G-F1: a dispute of this charge that arrived and is not applied yet holds the decision itself (the money waits for it).
  // INTEGRATED-13 P1-2: the hold never gates the contract's end: whether the request's eligibility is established anyway goes with it
  // (advanceLeased ends the plan now). Refusals are unchanged: a request that would be refused (not eligible, nothing left to refund on the
  // payment, or the 7-day offer while another payment holds the person's one refund) establishes nothing and ends nothing.
  if (await disputeHeldFirst(env, { paymentIntent, invoiceId, homeId: op.home_id })) {
    let endEligible = false;
    if (op.kind === "first_month" && remainderCap === null && !detail.legacyRemainderOf && paid > 0 && target > 0
      && (basis === "eu_uk_full_refund" || basis === "seven_day_offer")) {
      const decidedCents = invoiceId ? (await env.DB.prepare("SELECT decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(invoiceId)
        .first<{ decided_cents: number }>())?.decided_cents ?? 0 : 0;
      const owed = Math.max(0, Math.min(target, paid) - decidedCents) > 0;
      const offerFree = basis !== "seven_day_offer" || !await env.DB.prepare("SELECT 1 AS x FROM first_month_refunds WHERE user_id=? AND invoice_id IS NOT ? LIMIT 1")
        .bind(op.user_id, invoiceId).first();
      endEligible = owed && offerFree;
    }
    throw new DisputeHeld(endEligible);
  }
  // Round 10 (Astra TAXCOUNTRY-9 P1-2): THE EXACTNESS GUARD runs BEFORE any dispute amount is read: a dispute of this payment whose money is
  // not known exactly (and not yet proven by an operator) holds the decision itself, so nothing is decided (least of all lowered to zero) on
  // an unproven loss. Released by a win (the refund is decided in full) or by the operator's evidenced resolution.
  if (paid > 0 && (invoiceId || paymentIntent) && await env.DB.prepare(`SELECT 1 AS x FROM payment_disputes d WHERE ${DISPUTE_INEXACT_HELD_SQL}
    AND ((?1 IS NOT NULL AND d.invoice_id=?1) OR (?2 IS NOT NULL AND d.payment_intent=?2)) LIMIT 1`).bind(invoiceId, paymentIntent ?? null).first()) {
    throw new RefundPending("payment_dispute_inexact");
  }
  // The payment's ledger row: what is already decided, and a version every decision must compare-and-swap.
  let ledger: { version: number; decided_cents: number } | null = null;
  const lease = ctx.lease!;
  if (invoiceId) {
    await fencedRun(env, lease, "INSERT OR IGNORE INTO refund_invoice_ledger (invoice_id,version,decided_cents) VALUES (?,0,0)", invoiceId);
    ledger = await env.DB.prepare("SELECT version,decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(invoiceId).first<{ version: number; decided_cents: number }>();
  }
  // Round 8b: money a LOST dispute already returned for this payment counts as refunded: a refund never pays it back a second time.
  const returned = paid > 0 ? Math.min(paid, await disputeReturned(env, invoiceId, paymentIntent)) : 0;
  const already = (ledger?.decided_cents ?? 0) + returned;
  if (remainderCap !== null) target = already + remainderCap; // min(target, paid) - already = min(remainderCap, paid - already)
  const g = crypto.randomUUID();
  const batch = (target: number, basis: string, detail: Detail, claimOffer: boolean): Q[] => {
    // A later route refunds only what is still owed for this payment: everything already refunded counts towards it.
    const amount = paid > 0 ? Math.max(0, Math.min(target, paid) - already) : 0;
    // Round 10 (Astra TAXCOUNTRY-9 P1-1): a loss recorded BEFORE (or while) this first decision runs lowers it here, not in capForDisputeReturn.
    // The decision is then a CAPPED one exactly as if the cap had come after it: its uncapped amount (what it would be without the money the
    // bank returned) is kept as disputeCappedFromCents, so a later reinstatement raises it in place or opens its remainder (settleDisputeCap)
    // within the reinstatement window, and a reinstatement after it was completed raises the late-reinstatement alert (settleDispute).
    const uncapped = paid > 0 ? Math.max(0, Math.min(target, paid) - (ledger?.decided_cents ?? 0)) : 0;
    if (remainderCap === null && returned > 0 && amount < uncapped) detail = { ...detail, disputeCappedFromCents: detail.disputeCappedFromCents ?? uncapped };
    if (isCheckoutRefundKind(op.kind) && paid > 0) detail.refundTaxCents = Math.round(amount * (detail.invoiceTaxCents ?? 0) / paid);
    const stmts: Q[] = [
      q(`UPDATE refund_ops SET invoice_id=?,payment_intent=?,paid_cents=?,target_cents=?,amount_cents=?,basis=?,detail=?,decided_at=?,updated_at=?
        WHERE id=? AND decided_at IS NULL`, invoiceId, paymentIntent, paid, target, amount, basis, JSON.stringify(detail), ctx.now, ctx.now, op.id),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-a`),
    ];
    if (invoiceId && ledger) {
      // Serializes decisions for one payment: a concurrent decision that read the same version fails here and decides again.
      stmts.push(q("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=? AND version=?", amount, invoiceId, ledger.version),
        q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-v`),
        // And never more than was paid, whatever else is in the table: a lost dispute's returned money (read again here, so a closure that
        // lands between the read above and this batch fails it and the decision is made again) included.
        q(`INSERT INTO cloud_write_guards VALUES (?,(SELECT COALESCE(SUM(amount_cents),0) FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL)
          + MIN(?,(SELECT COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0) FROM payment_disputes d WHERE d.invoice_id=? OR d.payment_intent=?))<=?)`,
          `${g}-b`, invoiceId, paid, invoiceId, paymentIntent ?? "", paid));
    }
    if (claimOffer && invoiceId && amount > 0) {
      // The 7-day offer is once per person: every identity key of this payment is claimed in this same batch. Another payment that
      // claimed one first makes the batch fail; the decision is then made again and refuses the offer (refund-identity.ts).
      stmts.push(...claimOfferStatements(invoiceId, op.user_id, op.id, ctx.now, `${g}-k`, { guard: claimGuard }));
    }
    if (op.kind === "first_month" && basis === "not_first_payment" && invoiceId) {
      // A refusal on someone's codes is committed only while it still stands (Astra ASTRA-REFUND4 #2): an objection opened after the
      // identity check fails this batch; the decision is made again and the request is held as pending, never refused or emailed.
      // Not for a withdrawal: the statutory refund never waits on the identity check, and the offer only ever adds to it.
      stmts.push(...refusalFenceStatements(invoiceId, op.user_id, `${g}-r`));
    }
    if (claimOffer && op.kind === "withdrawal") {
      // A withdrawal that applies the 7-day offer uses the customer's one first-month refund.
      stmts.push(q(`INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,0,?)
        ON CONFLICT(user_id) DO NOTHING`, op.user_id, op.home_id, invoiceId, amount, ctx.now),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-c`));
    }
    if (op.kind === "withdrawal" && detail.withdrawalId) {
      stmts.push(q("UPDATE withdrawals SET days_supplied=?,deducted_cents=?,refund_cents=?,basis=? WHERE id=?", detail.daysSupplied ?? 0, detail.deductedCents ?? 0, amount, basis, detail.withdrawalId));
    }
    if (op.kind === "first_month" && amount === 0 && !detail.legacyRemainderOf && !detail.disputeRemainderOf && detail.disputeCappedFromCents === undefined) {
      // Nothing refunded: the once-per-customer slot is not used up.
      stmts.push(q("DELETE FROM first_month_refunds WHERE user_id=? AND stripe_refund_id IS NULL", op.user_id));
    }
    stmts.push(q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`));
    return stmts;
  };
  // Decided only while this worker still holds the home's lease (fencedBatch rolls the whole decision back otherwise).
  try { await fencedBatch(env, lease, batch(target, basis, detail, claimOffer)); }
  catch (e) {
    if (e instanceof LeaseLost) throw e;
    if (statutory !== null) {
      // The offer's claim (or the once-per-person slot) was taken by another payment first. The optional uplift is gated on that
      // claim; the statutory pro-rata refund is not: it is settled now, in the same decision, never retried (Astra ASTRA-REFUND5 #3).
      // A batch that fails again is a concurrent decision of this payment's ledger: decided again from the new state.
      try { await fencedBatch(env, lease, batch(statutory, "pro_rata", { ...detail, offerDeclined: "not_first_payment" }, false)); return; }
      catch (e2) { if (e2 instanceof LeaseLost) throw e2; }
    }
    throw new LedgerConflict("ledger_conflict"); // a concurrent decision or the offer already used: decide again from the new state
  }
}

/** Astra NODEDUCT-1 #1: a first-month decision the previous version made at the fee MINUS included credits used (its saved deduction is on
 *  the operation and its target is below what was paid). Since 2026-10-12 nothing is deducted: such a decision is owed the full invoice. */
function legacyDeducted(op: RefundOpRow, detail: Detail): boolean {
  return op.kind === "first_month" && !detail.euUkFull && !detail.legacyRemainderOf && op.basis === "seven_day_offer" && op.decided_at !== null
    && op.invoice_id !== null && typeof op.paid_cents === "number" && op.paid_cents > 0 && typeof op.target_cents === "number" && op.target_cents < op.paid_cents
    && typeof detail.usedCreditCents === "number" && detail.usedCreditCents > 0;
}

/** Astra NODEDUCT-3 #1: the zero the previous version ACTUALLY saved when its usage deduction alone made the request refuse: its quote had
 *  owed = (fee - used + tax on that) - already refunded = 0, reason already_refunded, so the decision was basis='already_refunded',
 *  target_cents=0, amount_cents=0, with the measured usage kept on the operation (usedCreditCents > 0). Never anything else. */
function legacyDeductionRefused(op: RefundOpRow, detail: Detail): boolean {
  return op.kind === "first_month" && !detail.euUkFull && !detail.legacyRemainderOf && op.basis === "already_refunded" && op.decided_at !== null
    && op.invoice_id !== null && typeof op.paid_cents === "number" && op.paid_cents > 0 && op.target_cents === 0 && (op.amount_cents ?? 0) === 0
    && typeof detail.usedCreditCents === "number" && detail.usedCreditCents > 0;
}

/** Astra NODEDUCT-1 #1: a legacy deducted decision whose refund was PROVABLY never submitted is upgraded in place to the full first invoice
 *  (fee + tax), capped by the ledger rule max(0, min(target, paid) - decided by others), and its ledger reservation is replaced in the SAME
 *  fenced batch (version compare-and-swap, aggregate overpayment guard). Provably unsubmitted: no refund recorded or in flight on the row,
 *  every journaled submission affirmatively unpaid (submissionUnpaid), and no live refund at Stripe carrying this op id. Anything less
 *  leaves the decision as it is: it is paid (or reconciled from Stripe) at the old amount, and the rest follows (openLegacyRemainder). */
async function upgradeLegacyDeduction(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<boolean> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  // A ZERO legacy decision (already_refunded) reserved no slot and claimed nothing: it is never upgraded here (that would skip the
  // one-per-person checks); a fresh request reopens it through the slot and identity checks (Astra NODEDUCT-2 #1, reopenLegacyRefusal).
  if (!legacyDeducted(op, detail) || (op.amount_cents ?? 0) === 0 || op.refunded_at !== null || op.stripe_refund_id !== null || op.credit_note_id !== null
    || op.submitted_at !== null || op.attribution_hold === 1) return false;
  const paid = op.paid_cents!; const invoiceId = op.invoice_id!;
  // Reconcile with Stripe first: a refund of this obligation that has not failed means a submission happened.
  const pi = op.payment_intent ?? (await ctx.stripe.getInvoice(invoiceId)).payment_intent;
  if (!pi) return false;
  if ((await ctx.stripe.listRefunds(pi)).data.some((r) => r.metadata?.op_id === op.id && r.status !== "failed" && r.status !== "canceled")) return false;
  const prior = await journalOf(env, op.id);
  for (let s = 1; s <= op.submission; s++) if (!prior.some((j) => j.submission === s)) return false;
  if (prior.some((j) => j.submission < 1 || j.submission > op.submission)) return false;
  for (const j of prior) if (!await submissionUnpaid(ctx, j)) return false;
  const ledger = await env.DB.prepare("SELECT version,decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(invoiceId).first<{ version: number; decided_cents: number }>();
  if (!ledger) return false;
  const old = op.amount_cents ?? 0;
  // min(target = paid, paid) - what OTHER decisions hold - what a lost dispute already returned
  const amount = Math.max(0, paid - (ledger.decided_cents - old) - Math.min(paid, await disputeReturned(env, invoiceId, pi)));
  if (amount <= old) return false;
  const { usedCreditCents: _used, offerSkipped: _skipped, ...rest } = detail;
  const g = crypto.randomUUID();
  try {
    await fencedBatch(env, ctx.lease!, [
      q(`UPDATE refund_ops SET target_cents=?,amount_cents=?,detail=?,updated_at=? WHERE id=? AND decided_at IS NOT NULL AND amount_cents=? AND target_cents=?
        AND refunded_at IS NULL AND stripe_refund_id IS NULL AND credit_note_id IS NULL AND submitted_at IS NULL AND submission=?`,
        paid, amount, JSON.stringify({ ...rest, legacyUpgradedFromCents: old }), ctx.now, op.id, old, op.target_cents, op.submission),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-a`),
      // The reservation is REPLACED, never added twice: the same compare-and-swap every decision makes.
      q("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=? AND version=?", amount - old, invoiceId, ledger.version),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-v`),
      q(`INSERT INTO cloud_write_guards VALUES (?,(SELECT COALESCE(SUM(amount_cents),0) FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL)<=?)`, `${g}-b`, invoiceId, paid),
      q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`),
    ]);
  } catch (e) { if (e instanceof LeaseLost) throw e; throw new LedgerConflict("ledger_conflict"); }
  return true;
}

/** Round 8b: an operation decided while its payment's dispute was still open (the dispute hold kept it from being paid) and whose dispute
 *  was then LOST: the bank already returned part of the payment, so the operation is lowered to what is still owed (the payment less every
 *  other decision and the returned money), in ONE fenced batch with its ledger reservation (the same compare-and-swap every decision makes).
 *  Only an operation whose money step never started (nothing submitted, no refund or note recorded); one already submitted is held at its
 *  next submission instead (intend). True: lowered. */
async function capForDisputeReturn(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<boolean> {
  const amount = op.amount_cents ?? 0;
  if (amount <= 0 || op.decided_at === null || op.refunded_at !== null || op.submitted_at !== null || op.stripe_refund_id !== null || op.credit_note_id !== null
    || !op.invoice_id || typeof op.paid_cents !== "number" || op.paid_cents <= 0) return false;
  const paid = op.paid_cents; const invoiceId = op.invoice_id;
  const returned = Math.min(paid, await disputeReturned(env, invoiceId, op.payment_intent));
  if (returned === 0) return false;
  const ledger = await env.DB.prepare("SELECT version,decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(invoiceId).first<{ version: number; decided_cents: number }>();
  if (!ledger || ledger.decided_cents + returned <= paid) return false;
  const capped = Math.max(0, amount - (ledger.decided_cents + returned - paid));
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  const next: Detail = { ...detail, disputeCappedFromCents: detail.disputeCappedFromCents ?? amount };
  if (isCheckoutRefundKind(op.kind)) next.refundTaxCents = Math.round(capped * (detail.invoiceTaxCents ?? 0) / paid);
  const g = crypto.randomUUID();
  try {
    await fencedBatch(env, ctx.lease!, [
      q(`UPDATE refund_ops SET amount_cents=?,detail=?,updated_at=? WHERE id=? AND amount_cents=? AND decided_at IS NOT NULL AND refunded_at IS NULL
        AND submitted_at IS NULL AND stripe_refund_id IS NULL AND credit_note_id IS NULL`, capped, JSON.stringify(next), ctx.now, op.id, amount),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-a`),
      q("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents-? WHERE invoice_id=? AND version=?", amount - capped, invoiceId, ledger.version),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-v`),
      ...(op.kind === "withdrawal" && detail.withdrawalId ? [q("UPDATE withdrawals SET refund_cents=? WHERE id=?", capped, detail.withdrawalId)] : []),
      q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`),
    ]);
  } catch (e) { if (e instanceof LeaseLost) throw e; throw new RefundPending("ledger_conflict"); }
  return true;
}

/** Round 9b (Astra TAXCOUNTRY-8 P1-6): how long after a LOST dispute closed its money may still come back (a reinstatement: the card network
 *  reverses the outcome, pre-arbitration). A refund a loss capped is never completed as final within it (it waits, looked at daily and at
 *  once on any dispute movement), so a reinstatement always reopens what the loss took off. */
export const DISPUTE_REINSTATEMENT_WINDOW_MS = 120 * DAY_MS;
/** Every remainder operation of a capped operation (disputeRemainderOf), decided or not. */
const remaindersOf = async (env: Env, opId: string) => (await env.DB.prepare(`SELECT id,amount_cents,decided_at,done_at FROM refund_ops
  WHERE json_extract(detail,'$.disputeRemainderOf')=?`).bind(opId).all<{ id: string; amount_cents: number | null; decided_at: number | null; done_at: number | null }>()).results;
/** What a capped operation (and its remainders) may pay in total NOW: its first decided amount, never more than the payment less every other
 *  decision and the money the bank still keeps (evidence: payment_disputes, recorded from Stripe's movements). */
async function disputeCapDue(env: Env, op: RefundOpRow, from: number): Promise<{ due: number; mine: number; ledger: { version: number; decided_cents: number } } | null> {
  if (!op.invoice_id || typeof op.paid_cents !== "number" || op.paid_cents <= 0) return null;
  const ledger = await env.DB.prepare("SELECT version,decided_cents FROM refund_invoice_ledger WHERE invoice_id=?").bind(op.invoice_id).first<{ version: number; decided_cents: number }>();
  if (!ledger) return null;
  const mine = (op.amount_cents ?? 0) + (await remaindersOf(env, op.id)).reduce((n, r) => n + (r.decided_at !== null ? r.amount_cents ?? 0 : 0), 0);
  const returned = Math.min(op.paid_cents, await disputeReturned(env, op.invoice_id, op.payment_intent));
  return { due: Math.max(0, Math.min(from, op.paid_cents - (ledger.decided_cents - mine) - returned)), mine, ledger };
}
/** Round 9b (P1-6): a reinstatement lowered the money a lost dispute returned. An operation the loss capped whose money step never started is
 *  RAISED in place, back towards its first decided amount (never above it, never above what the payment still allows), in ONE fenced batch
 *  with its ledger reservation (the same compare-and-swap and overpayment guard every decision makes). Its deadline is its own (unchanged).
 *  True: raised. */
async function restoreForDisputeReinstatement(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<boolean> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  const from = detail.disputeCappedFromCents;
  const amount = op.amount_cents ?? 0;
  if (typeof from !== "number" || amount >= from || op.decided_at === null || op.refunded_at !== null || op.submitted_at !== null
    || op.stripe_refund_id !== null || op.credit_note_id !== null) return false;
  const cap = await disputeCapDue(env, op, from);
  if (!cap || cap.due <= cap.mine) return false;
  const raised = amount + (cap.due - cap.mine);
  const paid = op.paid_cents!; const invoiceId = op.invoice_id!;
  const next: Detail = { ...detail };
  if (isCheckoutRefundKind(op.kind)) next.refundTaxCents = Math.round(raised * (detail.invoiceTaxCents ?? 0) / paid);
  const g = crypto.randomUUID();
  try {
    await fencedBatch(env, ctx.lease!, [
      q(`UPDATE refund_ops SET amount_cents=?,detail=?,updated_at=? WHERE id=? AND amount_cents=? AND decided_at IS NOT NULL AND refunded_at IS NULL
        AND submitted_at IS NULL AND stripe_refund_id IS NULL AND credit_note_id IS NULL`, raised, JSON.stringify(next), ctx.now, op.id, amount),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-a`),
      q("UPDATE refund_invoice_ledger SET version=version+1,decided_cents=decided_cents+? WHERE invoice_id=? AND version=?", raised - amount, invoiceId, cap.ledger.version),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-v`),
      q(`INSERT INTO cloud_write_guards VALUES (?,(SELECT COALESCE(SUM(amount_cents),0) FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL)
        + MIN(?,(SELECT COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0) FROM payment_disputes d WHERE d.invoice_id=? OR d.payment_intent=?))<=?)`,
        `${g}-b`, invoiceId, paid, invoiceId, op.payment_intent ?? "", paid),
      ...(op.kind === "withdrawal" && detail.withdrawalId ? [q("UPDATE withdrawals SET refund_cents=? WHERE id=?", raised, detail.withdrawalId)] : []),
      q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`),
    ]);
  } catch (e) { if (e instanceof LeaseLost) throw e; throw new RefundPending("ledger_conflict"); }
  return true;
}
/** Round 9b (P1-6): the finishing rule of an operation a lost dispute capped. Its money step already ran (or nothing was owed), but the loss
 *  may still be reversed: while a dispute of its payment is open, or a lost one closed within DISPUTE_REINSTATEMENT_WINDOW_MS, it is NOT
 *  completed (RefundWaiting). Money that came back meanwhile and that this operation can no longer pay itself (it was refunded at the capped
 *  amount) is paid by ONE remainder operation at a time (disputerest:<op>:<n>, decided by the ledger rule, under the parent's original
 *  deadline), opened in one fenced batch. Never completes anything early; never opens a remainder twice. */
/** The remainder operation of a capped operation whose money step ran (or that finished): what the payment owes back now that the bank keeps
 *  less, opened once (no remainder of it still unfinished), under the parent's original deadline. Returns its id when one was opened. */
async function openDisputeRemainder(env: Env, lease: HomeLease, now: number, op: RefundOpRow): Promise<string | null> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  const from = detail.disputeCappedFromCents;
  if (typeof from !== "number" || detail.disputeRemainderOf || !op.invoice_id) return null;
  const rests = await remaindersOf(env, op.id);
  const cap = await disputeCapDue(env, op, from);
  if (!(cap && cap.due > cap.mine && (op.refunded_at !== null || op.done_at !== null) && rests.every((r) => r.decided_at !== null && r.done_at !== null))) return null;
  const id = `disputerest:${op.id}:${rests.length + 1}`;
  const res = await fencedBatch(env, lease, remainderInsertQs(op, detail, id,
    [`NOT EXISTS (SELECT 1 FROM refund_ops WHERE json_extract(detail,'$.disputeRemainderOf')=? AND done_at IS NULL)`, op.id], now));
  return (res[0]?.meta.changes ?? 0) === 1 ? id : null;
}
/** The remainder `id` of capped operation `op` (its own payment, inheriting what its decision reads), opened only if `when` holds, dated as
 *  the parent was (the remainder is the same obligation, under the parent's original deadline). */
function remainderInsertQs(op: RefundOpRow, detail: Detail, id: string, when: [string, ...unknown[]], now: number): Q[] {
  const keep: Detail = { disputeRemainderOf: op.id, ...(detail.path !== undefined ? { path: detail.path } : {}),
    ...(detail.invoiceTaxCents !== undefined ? { invoiceTaxCents: detail.invoiceTaxCents } : {}), ...(detail.euUkFull ? { euUkFull: true } : {}),
    ...(detail.confirmedAt !== undefined ? { confirmedAt: detail.confirmedAt } : {}), ...(detail.consentId !== undefined ? { consentId: detail.consentId } : {}) };
  return [
    refundOpInsert({ id, kind: op.kind, homeId: op.home_id, userId: op.user_id, invoiceId: op.invoice_id, paymentIntent: op.payment_intent, paidCents: op.paid_cents,
      subscriptionId: op.subscription_id, inheritSubscription: false, endPlan: false, detail: keep, when }, now),
    q("UPDATE refund_ops SET created_at=? WHERE id=? AND changes()=1", op.created_at, id),
  ];
}
/** Astra INTEGRATED-8 P1: THE PARENT IS REASSESSED WHEN ITS REMAINDER COMPLETES, in the SAME batch that completes it. While a remainder is
 *  unfinished no other may open (one at a time), so a further fall of the returned money meanwhile (a second reinstatement, a win, a lower
 *  resolution after the remainder was decided or submitted at the older amount) opens nothing then; the remainder's completion is the moment
 *  that money becomes payable. The next remainder is opened by the completing batch itself, judged in SQL against the CURRENT effective
 *  returned money at commit time: the parent's first decided amount still exceeds everything it and its decided remainders hold, and the
 *  payment's decisions plus what the bank keeps are still below what was paid. Durable (no step after the commit can be lost), never twice
 *  (one unfinished remainder at a time; its own decision is capped by the ledger rule and the overpayment guard). */
async function remainderCompletionQs(env: Env, op: RefundOpRow, now: number): Promise<Q[]> {
  const parentId = (JSON.parse(op.detail ?? "{}") as Detail).disputeRemainderOf;
  if (!parentId) return [];
  const parent = await getRefundOp(env, parentId);
  if (!parent || !parent.invoice_id || parent.home_id !== op.home_id) return [];
  const pdetail = JSON.parse(parent.detail ?? "{}") as Detail;
  if (typeof pdetail.disputeCappedFromCents !== "number" || pdetail.disputeRemainderOf) return [];
  const id = `disputerest:${parentId}:${(await remaindersOf(env, parentId)).length + 1}`;
  const owed = `EXISTS (SELECT 1 FROM refund_ops p JOIN refund_invoice_ledger l ON l.invoice_id=p.invoice_id WHERE p.id=?
      AND p.paid_cents>0 AND (p.refunded_at IS NOT NULL OR p.done_at IS NOT NULL) AND json_valid(p.detail)
      AND json_extract(p.detail,'$.disputeCappedFromCents')>COALESCE(p.amount_cents,0)+(SELECT COALESCE(SUM(r.amount_cents),0) FROM refund_ops r
        WHERE json_valid(r.detail) AND json_extract(r.detail,'$.disputeRemainderOf')=p.id AND r.decided_at IS NOT NULL)
      AND l.decided_cents+MIN(p.paid_cents,(SELECT COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0) FROM payment_disputes d
        WHERE d.invoice_id=p.invoice_id OR d.payment_intent=COALESCE(p.payment_intent,'')))<p.paid_cents)
    AND NOT EXISTS (SELECT 1 FROM refund_ops WHERE json_extract(detail,'$.disputeRemainderOf')=? AND done_at IS NULL)`;
  return remainderInsertQs(parent, pdetail, id, [owed, parentId, parentId], now);
}
/** Astra INTEGRATED-7 P1: THE EFFECTIVE RETURNED MONEY WENT DOWN. Whatever lowered it (a win, a reinstatement recorded exactly, one in another
 *  currency that cleared an operator's resolution, an operator's lower resolution), the bank keeps less of this payment than the refunds
 *  capped against it assumed. Every capped operation of the payment is re-looked at: one still unfinished is due at once (the caller makes it
 *  due; it is raised in place or waits for its remainder), and one ALREADY COMPLETED AS FINAL (its 120-day window over, or anything else)
 *  gets its remainder opened here, inside or outside the window. Returns the remainders opened. Never lowers or pays anything itself: each
 *  remainder is decided by the ledger rule (and held while the payment's dispute hold stands). */
export async function reopenDisputeRemainders(env: Env, lease: HomeLease, payment: { invoiceId: string | null; paymentIntent: string | null }, now: number): Promise<string[]> {
  if (!payment.invoiceId && !payment.paymentIntent) return [];
  const done = (await env.DB.prepare(`SELECT * FROM refund_ops WHERE done_at IS NOT NULL AND json_valid(detail)
    AND json_extract(detail,'$.disputeCappedFromCents') IS NOT NULL AND json_extract(detail,'$.disputeRemainderOf') IS NULL
    AND ((?1 IS NOT NULL AND invoice_id=?1) OR (?2 IS NOT NULL AND payment_intent=?2))`).bind(payment.invoiceId, payment.paymentIntent).all<RefundOpRow>()).results;
  const opened: string[] = [];
  for (const op of done) { const id = await openDisputeRemainder(env, lease, now, op); if (id) opened.push(id); }
  return opened;
}
async function settleDisputeCap(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<void> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  const from = detail.disputeCappedFromCents;
  if (typeof from !== "number" || detail.disputeRemainderOf || !op.invoice_id) return;
  if (op.refunded_at !== null) await openDisputeRemainder(env, ctx.lease!, ctx.now, op);
  const open = await env.DB.prepare(`SELECT 1 AS x FROM payment_disputes d WHERE (d.invoice_id=?1 OR (?2 IS NOT NULL AND d.payment_intent=?2))
    AND (d.closed_at IS NULL OR (d.outcome='lost' AND d.closed_at>?3)) LIMIT 1`).bind(op.invoice_id, op.payment_intent, ctx.now - DISPUTE_REINSTATEMENT_WINDOW_MS).first();
  const mine = (op.amount_cents ?? 0) + (await remaindersOf(env, op.id)).reduce((n, r) => n + (r.decided_at !== null ? r.amount_cents ?? 0 : 0), 0);
  if (open && mine < from) throw new RefundWaiting(DISPUTE_REINSTATEMENT_WAIT);
}
const DISPUTE_REINSTATEMENT_WAIT = "dispute_reinstatement_possible";

/** Astra NODEDUCT-1 #1: a legacy deducted refund that was paid at the old amount (a submission that may have happened is reconciled from
 *  Stripe by the normal path first) is owed the rest of the full invoice. One more ledger operation of the same request pays it, decided
 *  under the ledger rule (only the capped remainder) and opened once, in the same fenced batch that marks the parent. */
async function openLegacyRemainder(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<void> {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  if (op.refunded_at === null || !legacyDeducted(op, detail) || detail.legacyRemainderOp) return;
  const id = `legacyrest:${op.id}`;
  await fencedBatch(env, ctx.lease!, [
    q("UPDATE refund_ops SET detail=?,updated_at=? WHERE id=? AND detail=?", JSON.stringify({ ...detail, legacyRemainderOp: id }), ctx.now, op.id, op.detail),
    refundOpInsert({ id, kind: "first_month", homeId: op.home_id, userId: op.user_id, invoiceId: op.invoice_id, paymentIntent: op.payment_intent, paidCents: op.paid_cents,
      subscriptionId: op.subscription_id, inheritSubscription: false, endPlan: false,
      detail: { legacyRemainderOf: op.id, ...(detail.consentId !== undefined ? { consentId: detail.consentId } : {}) }, when: ["changes()=1"] }, ctx.now),
  ]);
}

/** Astra NODEDUCT-1 #2: a refusal the previous version recorded because the included credit used the whole fee (all_credit_used, zero
 *  amount), never paid. Since 2026-10-12 credit use refuses nothing. */
export const isLegacyCreditRefusal = (op: RefundOpRow | null): boolean => !!op && op.kind === "first_month" && op.decided_at !== null
  && (op.amount_cents ?? 0) === 0 && op.basis === "all_credit_used" && op.refunded_at === null && op.stripe_refund_id === null && op.submitted_at === null
  && op.attribution_hold !== 1;
/** Astra NODEDUCT-2 #1: a ZERO decision the previous version reached only through its usage deduction: the deducted target (fee minus credits
 *  used) was at or below what another route had already refunded on the invoice, so it answered already_refunded ($53.90 paid, $10 used:
 *  $42.90 target; $45 already refunded). Under the full-fee rule the same payment may still be owed the rest ($8.90). Never paid. */
export const isLegacyDeductionRefusal = (op: RefundOpRow | null): boolean => {
  if (!op || (op.amount_cents ?? 0) !== 0) return false;
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  // A deducted seven_day_offer capped to zero by the ledger, or the already_refunded zero the old quote itself returned (NODEDUCT-3 #1).
  return (legacyDeducted(op, detail) || legacyDeductionRefused(op, detail)) && op.refunded_at === null && op.stripe_refund_id === null && op.credit_note_id === null
  && op.submitted_at === null && op.attribution_hold !== 1;
};
/** A legacy refusal a fresh, eligible request for the same payment may reopen (NODEDUCT-1 #2, NODEDUCT-2 #1). */
export const isLegacyRefusal = (op: RefundOpRow | null): boolean => isLegacyCreditRefusal(op) || isLegacyDeductionRefusal(op);
/** Reopens such a refusal for a fresh, eligible retry, under the caller's lease, in ONE fenced batch: the customer's once-per-person slot is
 *  reserved again (a slot another payment holds fails the batch), the obsolete decision and completion checkpoints are cleared, the saved
 *  deduction is dropped, and an unsent refusal notice is cancelled. Its zero decision reserved nothing in the ledger and claimed no identity
 *  keys. The request is then decided again by the normal path (identity and ledger checks, as of its receipt).
 *  true: reopened (also when the batch committed but its answer was lost). false: ONLY a confirmed competing reservation (the slot is held
 *  for a DIFFERENT invoice).
 *  Anything else (a database failure that rolled the batch back) is thrown, retryable: the old refusal is left exactly as it was, and
 *  asking again reopens it (Astra NODEDUCT-2 #2). */
export async function reopenLegacyRefusal(env: Env, ctx: RefundContext, op: RefundOpRow, refundCents: number): Promise<boolean> {
  if (!isLegacyRefusal(op)) return false;
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  const { usedCreditCents: _used, offerSkipped: _skipped, ...rest } = detail;
  const g = crypto.randomUUID();
  try {
    await fencedBatch(env, ctx.lease!, [
      q(`INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,?,0,?) ON CONFLICT(user_id) DO NOTHING`,
        op.user_id, op.home_id, op.invoice_id, refundCents, ctx.now),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-s`),
      // Exactly the legacy refusal read (all_credit_used, or a deducted zero: seven_day_offer capped, or the old quote's already_refunded),
      // unpaid and never submitted; `detail IS ?` pins the saved usage.
      q(`UPDATE refund_ops SET decided_at=NULL,basis=NULL,amount_cents=NULL,target_cents=NULL,notified_at=NULL,done_at=NULL,last_error=NULL,attempts=0,
        next_attempt_at=NULL,detail=?,updated_at=? WHERE id=? AND kind='first_month' AND decided_at IS NOT NULL AND amount_cents=0
        AND (basis='all_credit_used' OR (basis='seven_day_offer' AND target_cents<paid_cents)
          OR (basis='already_refunded' AND target_cents=0 AND paid_cents>0)) AND detail IS ?
        AND refunded_at IS NULL AND stripe_refund_id IS NULL AND credit_note_id IS NULL AND submitted_at IS NULL`, JSON.stringify(rest), ctx.now, op.id, op.detail),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", `${g}-o`),
      q("UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL", ctx.now,
        `refund_declined:${op.home_id}:${refusalReason(op)}:${op.invoice_id ?? "none"}`),
      q("DELETE FROM cloud_write_guards WHERE id LIKE ?", `${g}-%`),
    ]);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    // Read back what is committed (a read that fails is itself a retryable error).
    const now = await getRefundOp(env, op.id);
    const slot = await env.DB.prepare("SELECT invoice_id FROM first_month_refunds WHERE user_id=?").bind(op.user_id).first<{ invoice_id: string | null }>();
    // The reopening committed and only its answer was lost: the same request, reopened.
    if (now && now.decided_at === null && now.done_at === null && slot && slot.invoice_id === op.invoice_id) return true;
    // Unchanged, and the person's one slot is held by ANOTHER payment: the one-per-person answer stands (Astra NODEDUCT-3 #2). A slot on
    // this same invoice is not a competing reservation: without an established reopening the failure is propagated (retryable).
    if (now && now.detail === op.detail && isLegacyRefusal(now) && slot && slot.invoice_id !== op.invoice_id) return false;
    throw e;
  }
  return true;
}

/** Why a decided first-month request refunds nothing, in the words of REFUND_DENIAL_TEXT. */
export const refusalReason = (op: Pick<RefundOpRow, "basis">): string =>
  op.basis === "seven_day_offer" || op.basis === "eu_uk_full_refund" ? "already_refunded" : op.basis ?? "not_eligible";

/** The ONE rule for whether a credit note listed for invoice `at.invoiceId` belongs to ledger operation `op` (shared by the external-refund
 *  importer and the operation's own direct recovery; Astra WP3-2 #1, WP3-3 #1). An op id in a note's metadata proves nothing by itself:
 *  anyone can write metadata. The note must name this operation, which must be a checkout kind of the leased home on the direct path (Managed
 *  Payments never makes notes), for this invoice (the note's own invoice too) and this payment (or, before the payment is recorded, the
 *  payment's own invoice). An operation that already checkpointed a note or refund accepts only that note. An operation with NO checkpoint
 *  accepts a note only when it is the one this operation submitted: a durable submission record (the intent written before the note is
 *  made), a decided amount, a note whose refund total equals that amount, and the submission number the note was made under. Anything
 *  else is someone else's note, and its refunds are external. */
export function creditNoteMatchesOp(op: RefundOpRow, n: Pick<CreditNoteView, "id" | "invoice" | "amount" | "refund" | "refunds" | "metadata" | "refundTotal">,
  at: { homeId: string; invoiceId: string; paymentIntent: string; paymentInvoice: string | null }): boolean {
  return creditNoteAttribution(op, n, at) === "match";
}
/** The same rule with its third answer (Astra WP3-4 #2): "unresolved" is a note that would be this operation's but carries MORE THAN ONE
 *  refund. The ledger follows one refund per operation, so a note whose refunds are split (500¢ succeeded + 1,950¢ failed) can never prove
 *  the whole decided amount was paid: it is neither adopted nor treated as foreign; the operation stays pending (attribution_unresolved),
 *  makes no second note, and ops is alerted. Its refunds are never imported as external either. */
export type CreditNoteAttribution = "match" | "foreign" | "unresolved";
export function creditNoteAttribution(op: RefundOpRow, n: Pick<CreditNoteView, "id" | "invoice" | "amount" | "refund" | "refunds" | "metadata" | "refundTotal">,
  at: { homeId: string; invoiceId: string; paymentIntent: string; paymentInvoice: string | null }): CreditNoteAttribution {
  if (n.metadata?.op_id !== op.id || op.kind === "external") return "foreign";
  if (op.home_id !== at.homeId || op.invoice_id !== at.invoiceId || (n.invoice !== null && n.invoice !== at.invoiceId)) return "foreign";
  let path: unknown;
  try { path = (JSON.parse(op.detail ?? "{}") as { path?: unknown }).path; } catch { return "foreign"; }
  if (!refundsViaCreditNote(op, path)) return "foreign";
  if (op.payment_intent !== null ? op.payment_intent !== at.paymentIntent : at.paymentInvoice !== at.invoiceId) return "foreign";
  const carried = [...new Set(n.refunds ?? (n.refund ? [n.refund] : []))];
  if (op.stripe_refund_id !== null && !carried.includes(op.stripe_refund_id)) return "foreign";
  if (op.credit_note_id !== null) { if (op.credit_note_id !== n.id) return "foreign"; }
  else {
    // Uncheckpointed: adopted only as the note this operation itself submitted (Astra WP3-3 #1).
    const total = typeof n.refundTotal === "number" ? n.refundTotal : n.amount;
    if (!(op.submitted_at !== null && op.decided_at !== null && typeof op.amount_cents === "number" && op.amount_cents > 0 && total === op.amount_cents
      && n.metadata.submission === String(op.submission))) return "foreign";
  }
  return carried.length > 1 ? "unresolved" : "match";
}

/** Astra WP3-4 #1: ownership of Stripe objects is EXCLUSIVE in the database. A credit note and every refund it carries (or one Managed
 *  Payments refund) are bound to exactly one operation in refund_object_claims (migration 0070); an object another operation holds (claimed,
 *  or recorded on its row before the table existed) can never be adopted, whatever the note's metadata says. The claim and the caller's
 *  `checkpoint` (an UPDATE ... WHERE, applied only when nothing is held elsewhere) commit in ONE fenced batch. True when `opId` holds every
 *  object afterwards; false: attribution is unresolved, nothing was written, and the caller keeps the operation pending. */
export async function claimRefundObjects(env: Env, lease: HomeLease, opId: string, objects: { creditNoteId?: string | null; refundIds: readonly (string | null | undefined)[] },
  now: number, checkpoint?: Q, withCheckpoint: readonly Q[] = []): Promise<boolean> {
  // `withCheckpoint`: statements committed in the same batch right after the checkpoint (the first may test changes()=1 to follow it).
  const ids = [...new Set([objects.creditNoteId, ...objects.refundIds].filter((x): x is string => typeof x === "string" && x !== ""))];
  if (!ids.length) { if (checkpoint) await fencedBatch(env, lease, [checkpoint, ...withCheckpoint]); return true; }
  const ph = ids.map(() => "?").join(",");
  const foreign = `(EXISTS (SELECT 1 FROM refund_object_claims WHERE object_id IN (${ph}) AND op_id<>?)
    OR EXISTS (SELECT 1 FROM refund_ops WHERE id<>? AND (credit_note_id IN (${ph}) OR stripe_refund_id IN (${ph}))))`;
  const fb = [...ids, opId, opId, ...ids, ...ids];
  const stmts: Q[] = [];
  if (checkpoint) stmts.push(q(`${checkpoint[0]} AND NOT ${foreign}`, ...(checkpoint[1] ?? []), ...fb));
  if (checkpoint) stmts.push(...withCheckpoint);
  for (const id of ids) {
    stmts.push(q(`INSERT INTO refund_object_claims (object_id,object_kind,op_id,claimed_at) SELECT ?,?,?,? WHERE NOT ${foreign} ON CONFLICT(object_id) DO NOTHING`,
      id, id === objects.creditNoteId ? "credit_note" : "refund", opId, now, ...fb));
  }
  await fencedBatch(env, lease, stmts);
  const mine = await env.DB.prepare(`SELECT COUNT(*) AS n FROM refund_object_claims WHERE object_id IN (${ph}) AND op_id=?`).bind(...ids, opId).first<{ n: number }>();
  return (mine?.n ?? 0) === ids.length;
}
/** An operation whose Stripe objects cannot be attributed to it alone (Astra WP3-4): kept pending under the caller's lease with its own reason,
 *  and ops is alerted in the same batch. Never completed and never resubmitted until a person resolves it. */
export async function markAttributionUnresolved(env: Env, lease: HomeLease, op: Pick<RefundOpRow, "id" | "home_id" | "kind">, detail: Record<string, unknown>, now: number): Promise<void> {
  await fencedBatch(env, lease, [
    q("UPDATE refund_ops SET last_error='attribution_unresolved',attribution_hold=1,next_attempt_at=?,updated_at=? WHERE id=? AND done_at IS NULL", now + 3_600_000, now, op.id),
    ...await attributionAlertStmts(env, op.home_id, { add: { opId: op.id, detail: { kind: op.kind, error: "attribution_unresolved", ...detail } } }, now),
  ]);
}

/** Astra WP3-7 #1/#2: our OWN retained creation provenance (migration 0072). One row per operation and submission: the intent (written,
 *  fenced, before the create call) and the id the create call returned. Stripe metadata is mutable and never stands in for it. */
interface JournalRow { submission: number; object_kind: string; invoice_id: string | null; payment_intent: string | null; amount_cents: number;
  intent_at: number; intent_journaled: number; object_id: string | null }
async function journalOf(env: Env, opId: string): Promise<JournalRow[]> {
  return (await env.DB.prepare(`SELECT submission,object_kind,invoice_id,payment_intent,amount_cents,intent_at,intent_journaled,object_id
    FROM refund_submission_journal WHERE op_id=? ORDER BY submission`).bind(opId).all<JournalRow>()).results;
}
type JournalTarget = { opId: string; submission: number; kind: "credit_note" | "refund"; invoiceId: string | null; paymentIntent: string | null; amount: number };
/** The intent row (before the call). `journaled` 0: the intent was recorded before this journal existed, only the returned id is known.
 *  INTEGRATED-12: written only with the claim of that submission (the batch's claiming UPDATE, which a hold may refuse). */
const journalIntent = (t: JournalTarget, intentAt: number, journaled: boolean): Q => q(`INSERT INTO refund_submission_journal
  (op_id,submission,object_kind,invoice_id,payment_intent,amount_cents,intent_at,intent_journaled)
  SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS (SELECT 1 FROM refund_ops WHERE id=?1 AND submission=?2 AND submitted_at IS NOT NULL)
  ON CONFLICT(op_id,submission) DO NOTHING`,
  t.opId, t.submission, t.kind, t.invoiceId, t.paymentIntent, t.amount, intentAt, journaled ? 1 : 0);
/** The id the create call returned for that submission: written once, never replaced. */
const journalReturned = (t: JournalTarget, intentAt: number, objectId: string, now: number): Q => q(`INSERT INTO refund_submission_journal
  (op_id,submission,object_kind,invoice_id,payment_intent,amount_cents,intent_at,intent_journaled,object_id,returned_at) VALUES (?,?,?,?,?,?,?,0,?,?)
  ON CONFLICT(op_id,submission) DO UPDATE SET object_id=COALESCE(refund_submission_journal.object_id,excluded.object_id),
  returned_at=COALESCE(refund_submission_journal.returned_at,excluded.returned_at)`,
  t.opId, t.submission, t.kind, t.invoiceId, t.paymentIntent, t.amount, intentAt, objectId, now);
/** Clock allowance between our intent time and Stripe's `created` of an object the call made. */
const SUBMISSION_SKEW_MS = 10 * 60_000;
/** Astra WP3-7 #2: AFFIRMATIVE evidence that one of our submissions paid nothing. Absence of metadata is never such evidence. True only when
 *  (a) the call returned a refund that Stripe shows failed or canceled, or (b) our journal recorded the intent and no id ever came back, AND a
 *  COMPLETE Stripe listing (it throws when incomplete) of that invoice's credit notes / that payment's refunds shows no object of that amount
 *  created since the intent (an object Stripe shows without a creation time counts as present; a voided note counts as present). A credit
 *  note the call returned is never treated as unpaid automatically: a person decides. */
async function submissionUnpaid(ctx: RefundContext, j: JournalRow): Promise<boolean> {
  if (j.object_id) {
    if (j.object_kind !== "refund") return false;
    const r = await ctx.stripe.getRefund(j.object_id);
    return !!r && (r.status === "failed" || r.status === "canceled");
  }
  if (j.intent_journaled !== 1) return false;
  const since = j.intent_at - SUBMISSION_SKEW_MS;
  const inWindow = (c: number | null | undefined) => !(typeof c === "number" && c > 0) || c * 1000 >= since;
  if (j.object_kind === "credit_note") {
    if (!j.invoice_id) return false;
    const all = (await ctx.stripe.listCreditNotes(j.invoice_id)).data;
    return !all.some((n) => (n.amount === j.amount_cents || n.refundTotal === j.amount_cents) && inWindow(n.created));
  }
  if (!j.payment_intent) return false;
  const all = (await ctx.stripe.listRefunds(j.payment_intent)).data;
  return !all.some((r) => r.status !== "failed" && r.status !== "canceled" && r.amount === j.amount_cents && inWindow(r.created));
}

/** Astra WP3-5 #1: a saved success is honoured only while the operation owns what it rests on. True when another operation holds a claim on
 *  the credit note or refund recorded on this row (a duplicate written before migration 0070, or anything recorded without its claim). */
async function claimedElsewhere(env: Env, op: Pick<RefundOpRow, "id" | "credit_note_id" | "stripe_refund_id">): Promise<boolean> {
  const ids = [op.credit_note_id, op.stripe_refund_id].filter((x): x is string => typeof x === "string" && x !== "");
  if (!ids.length) return false;
  return (await env.DB.prepare(`SELECT 1 AS x FROM refund_object_claims WHERE object_id IN (${ids.map(() => "?").join(",")}) AND op_id<>? LIMIT 1`)
    .bind(...ids, op.id).first()) !== null;
}
/** The quarantine of an operation whose recorded objects belong to another (Astra WP3-5 #1, the runtime twin of migration 0070): what it
 *  held is kept in refund_attribution_quarantine, its success and completion are cleared, its withdrawal goes back to processing, and it is
 *  held for a person. One fenced batch; the caller then raises the attribution alert. */
async function quarantineOp(env: Env, lease: HomeLease, op: RefundOpRow, reason: string, now: number): Promise<void> {
  const res = await fencedBatch(env, lease, [
    // A quarantine that was released (WP3-6 #4) and happens again records the new state; an open one keeps what was first taken away.
    q(`INSERT INTO refund_attribution_quarantine (op_id,home_id,reason,credit_note_id,stripe_refund_id,refunded_at,done_at,quarantined_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(op_id) DO UPDATE SET reason=excluded.reason,credit_note_id=excluded.credit_note_id,stripe_refund_id=excluded.stripe_refund_id,refunded_at=excluded.refunded_at,
      done_at=excluded.done_at,quarantined_at=excluded.quarantined_at,released_at=NULL WHERE refund_attribution_quarantine.released_at IS NOT NULL`,
      op.id, op.home_id, reason, op.credit_note_id, op.stripe_refund_id, op.refunded_at, op.done_at, now),
    q(`UPDATE refund_ops SET refunded_at=NULL,done_at=NULL,credit_note_id=NULL,stripe_refund_id=NULL,refund_submitted_at=NULL,refund_status=NULL,stripe_refund_status=NULL,
      submission_reconcile=0,note_reconcile=0,attribution_hold=1,last_error='attribution_unresolved',updated_at=? WHERE id=?`, now, op.id),
    q("UPDATE withdrawals SET status='processing',stripe_refund_id=NULL WHERE refund_op_id=? AND status='completed' AND changes()=1", op.id),
    // Astra WP3-7 #3: the identity's success goes with the operation's, in the same transaction; its reservation (the row, its keys) stays.
    q("UPDATE refund_identity_claims SET refunded_at=NULL WHERE op_id=? AND refunded_at IS NOT NULL", op.id),
  ]);
  if (res[1].meta.changes !== 1) throw new LeaseLost();
}

/** Astra WP3-5 #2: the whole note settles the operation only when it carries ONE refund, its refunds add up to the decided amount (Stripe's
 *  refund total; the note's amount when Stripe does not show it), and it carries the refund already checkpointed on the row, if any. */
function noteSettlesOp(op: Pick<RefundOpRow, "stripe_refund_id">, note: Pick<CreditNoteView, "amount" | "refund" | "refunds" | "refundTotal">, amount: number): boolean {
  const carried = [...new Set(note.refunds ?? (note.refund ? [note.refund] : []))];
  const total = typeof note.refundTotal === "number" ? note.refundTotal : note.amount;
  if (carried.length > 1 || total !== amount) return false;
  return op.stripe_refund_id === null || carried.includes(op.stripe_refund_id);
}

/** Astra WP3-6 #2: a legacy credit-note success is valid only when the whole note (not voided, for this invoice) carries exactly the decided
 *  amount in ONE refund, that refund is the one checkpointed on the row (if any), and Stripe shows it succeeded for that amount. */
async function legacyNoteSettles(ctx: RefundContext, op: RefundOpRow): Promise<boolean> {
  const amount = op.amount_cents ?? 0;
  if (!op.credit_note_id || amount <= 0) return false;
  const note = await ctx.stripe.getCreditNote(op.credit_note_id);
  if (!note || note.status === "void" || (note.invoice !== null && note.invoice !== op.invoice_id) || !note.refund || !noteSettlesOp(op, note, amount)) return false;
  const refund = await ctx.stripe.getRefund(note.refund);
  return !!refund && refund.status === "succeeded" && (typeof refund.amount !== "number" || refund.amount === amount);
}

const backoff = (attempts: number) => Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(attempts, 12));

/** Runs every unfinished step of one refund operation under the home's billing lease (the one serializer). Safe to call again at any time:
 *  each step is checkpointed, and a worker that has lost the lease records nothing. Busy home: returns, the holder or the sweep goes on. */
export async function advanceRefundOp(env: Env, ctx: RefundContext, id: string): Promise<RefundOpRow | null> {
  const first = await getRefundOp(env, id);
  // A finished operation stays finished only while it owns what it was paid by (Astra WP3-5 #1): one whose note or refund another operation
  // holds is taken back under the lease below.
  // A completion recorded on a credit note before migration 0070 is honoured only after the whole note is validated (Astra WP3-6 #2).
  if (!first || (first.done_at !== null && first.note_reconcile !== 1 && !await claimedElsewhere(env, first))) return first;
  try { return await withHomeLease(env, first.home_id, (lease) => advanceLeased(env, { ...ctx, lease }, id), ctx.lease ?? ctx.deps.lease); }
  catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) return getRefundOp(env, id); throw e; }
}

async function advanceLeased(env: Env, ctx: RefundContext, id: string): Promise<RefundOpRow | null> {
  const lease = ctx.lease!;
  let op = (await getRefundOp(env, id))!;
  // INTEGRATED-13 P2: the release generation this pass read BEFORE any hold check: a wake (a hold closed, released or narrowed) that lands
  // during the pass raises it, and the failure backoff below is then never imposed over it.
  const observedGen = op.wake_gen ?? 0;
  if (op.done_at !== null && op.note_reconcile !== 1 && !await claimedElsewhere(env, op)) return op;
  // Every checkpoint is fenced: written only while this worker still holds the lease.
  const set = async (sql: string, ...v: unknown[]) => {
    if (await fencedRun(env, lease, `UPDATE refund_ops SET ${sql},updated_at=? WHERE id=?`, ...v, ctx.now, id) !== 1) throw new LeaseLost();
  };
  // Error-path bookkeeping is fenced like every other write: a worker that lost the lease records no failure either.
  const bookkeeping = async (stmts: Q[]): Promise<boolean> => {
    try { await fencedBatch(env, lease, stmts); return true; }
    catch (e) { if (e instanceof LeaseLost) return false; throw e; }
  };
  const decideNow = async () => {
    for (let i = 0; op.decided_at === null; i++) {
      try { await decide(env, ctx, op); }
      catch (e) { if (!(e instanceof LedgerConflict) || i >= 4) throw e; }
      op = (await getRefundOp(env, id))!;
    }
  };
  // Astra WP3-7 #2: the intent is journaled with the submission number in ONE fenced batch, before the create call. Before ANY call (a new
  // submission or a retry of the same one, whose idempotency key may have expired) every earlier attempt must be affirmatively unpaid:
  // a returned object that is not a failed refund, or an attempt Stripe may have honoured, holds the operation for a person. Never a second note.
  // Round 8b/9b: THE DISPUTE GATE, one rule for every money step of this operation: a new submission (intend) AND the adoption of a refund
  // or credit note found by its saved id, its journal or Stripe's listing (Astra TAXCOUNTRY-8 P2-a: an already-submitted refund adopted after a
  // dispute loss never bypasses the combined cap). Held (pending, for a person) while:
  //  - a dispute of the payment is OPEN (the bank is already reversing it: never paid back twice);
  //  - a dispute's movements are not known exactly (another currency, an inexact amount): never computed from a conversion;
  //  - every decision on the payment plus the money a lost dispute returned would exceed what was paid.
  const disputeGate = async (paymentIntent: string | null | undefined) => {
    // G-F1: the dispute hold written from the dispute event itself, before its home was even resolved (its payment, invoice or customer).
    if (await disputeHeldFirst(env, { paymentIntent, invoiceId: op.invoice_id, homeId: op.home_id })) throw new RefundPending("payment_dispute_hold");
    // Astra INTEGRATED-11 P1-3 (the frozen invoice-wide cap): an OPEN dispute of ANY charge of this invoice holds every money step of the
    // invoice, not only its own charge's: an open dispute counts nothing returned yet, so another charge's refund admitted meanwhile could
    // take the invoice's cap that the dispute's loss then exceeds. Released by its closure (won: nothing returned; lost: the cap counts it).
    if ((paymentIntent || op.invoice_id) && await env.DB.prepare(`SELECT 1 AS x FROM payment_disputes WHERE closed_at IS NULL
        AND ((?1 IS NOT NULL AND payment_intent=?1) OR (?2 IS NOT NULL AND invoice_id=?2)) LIMIT 1`).bind(paymentIntent ?? null, op.invoice_id).first()) {
      throw new RefundPending("payment_disputed");
    }
    if ((op.invoice_id || paymentIntent) && await env.DB.prepare(`SELECT 1 AS x FROM payment_disputes d WHERE ${DISPUTE_INEXACT_HELD_SQL}
      AND ((?1 IS NOT NULL AND d.invoice_id=?1) OR (?2 IS NOT NULL AND d.payment_intent=?2)) LIMIT 1`).bind(op.invoice_id, paymentIntent ?? null).first()) {
      throw new RefundPending("payment_dispute_inexact");
    }
    // Round 8b: a lost dispute returned part of this payment after this operation was submitted once (capForDisputeReturn lowers only an
    // operation that never was): no submission or adoption may pay more than the payment less what the bank returned. Held for a person.
    if (op.invoice_id && typeof op.paid_cents === "number" && op.paid_cents > 0) {
      const returned = Math.min(op.paid_cents, await disputeReturned(env, op.invoice_id, paymentIntent));
      const decided = returned > 0 ? (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL")
        .bind(op.invoice_id).first<{ n: number }>())?.n ?? 0 : 0;
      if (returned > 0 && decided + returned > op.paid_cents) throw new RefundPending("payment_dispute_returned");
    }
  };
  const intend = async (t: JournalTarget) => {
    // Astra TAXCOUNTRY-7 P1-b: THE DISPUTE HOLD. A payment with an open dispute (payment_disputes, closed_at unset) is being reversed by the
    // bank: no new refund or credit note of it is ever submitted (the same money is never paid back twice). The operation stays pending
    // (retried with backoff, alerted as refund.stuck / payment_disputed) until ops closes the dispute record with its outcome.
    await disputeGate(t.paymentIntent);
    const prior = await journalOf(env, id);
    // Astra WP3-8 #1: COVERAGE first. Every earlier submission number (1 .. target-1), and the target itself when it is a retry of an intent
    // already recorded (submitted_at set), must have a journal row: an intent with no row was made before the journal existed, and nothing
    // proves it paid nothing (its note's metadata may be gone and its idempotency key expired). A legacy zero-number intent (submission 0,
    // submitted_at set) is the same. Missing history holds the operation for a person (attribution_hold + alert); nothing is ever created.
    if (op.submitted_at !== null && (op.submission < 1 || t.submission !== op.submission)) throw new RefundPending("attribution_unresolved");
    const last = op.submitted_at !== null ? t.submission : t.submission - 1;
    for (let s = 1; s <= last; s++) if (!prior.some((j) => j.submission === s)) throw new RefundPending("attribution_unresolved");
    if (prior.some((j) => j.submission < 1 || j.submission > last)) throw new RefundPending("attribution_unresolved");
    for (const j of prior) if (!await submissionUnpaid(ctx, j)) throw new RefundPending("attribution_unresolved");
    // Astra INTEGRATED-12 P1-3: THE CLAIM ITSELF CARRIES THE GATE. The checks above are reads; a hold, an open dispute or a lost dispute's
    // returned money committed since (during the journal reads) must still stop this submission. So the claiming UPDATE admits the
    // submission only while, in the same statement: no unreleased hold matches it (disputeHoldMatchSql, scope-pending holds included), no
    // dispute of the payment is open or inexact, and the decided refunds plus the money disputes returned stay within what was paid (the
    // frozen invoice-wide cap). Decided by its RETURNING rows (never meta.changes); the journal intent is written only with the claim. A
    // submission already claimed before a hold lands keeps its ownership: its call goes out once, and what it returns is recorded.
    const res = await fencedBatch(env, lease, [
      q(`UPDATE refund_ops SET submission=?1,submitted_at=COALESCE(submitted_at,?2),updated_at=?2 WHERE id=?3
        AND NOT EXISTS (SELECT 1 FROM dispute_holds h WHERE ${disputeHoldMatchSql("?4", "?5", "?6")})
        AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE (d.closed_at IS NULL OR ${DISPUTE_INEXACT_HELD_SQL})
          AND ((?4 IS NOT NULL AND d.payment_intent=?4) OR (?5 IS NOT NULL AND d.invoice_id=?5)))
        AND (?5 IS NULL OR ?7 IS NULL OR ?7<=0
          OR (SELECT MIN(?7,COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0)) FROM payment_disputes d WHERE d.invoice_id=?5 OR d.payment_intent=COALESCE(?4,'')) <= 0
          OR (SELECT COALESCE(SUM(r.amount_cents),0) FROM refund_ops r WHERE r.invoice_id=?5 AND r.decided_at IS NOT NULL)
            + (SELECT MIN(?7,COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0)) FROM payment_disputes d WHERE d.invoice_id=?5 OR d.payment_intent=COALESCE(?4,'')) <= ?7)
        RETURNING id`, t.submission, ctx.now, id, t.paymentIntent ?? null, op.invoice_id, op.home_id, typeof op.paid_cents === "number" ? op.paid_cents : null),
      journalIntent(t, op.submitted_at ?? ctx.now, op.submitted_at === null)]);
    if ((res[0].results ?? []).length !== 1) {
      // Not claimed: a hold, an open dispute or the cap committed after the reads above (re-read, for the precise reason), else held.
      await disputeGate(t.paymentIntent);
      throw new RefundPending("payment_dispute_hold");
    }
    return op.submitted_at ?? ctx.now;
  };
  // Astra INTEGRATED-3 #6: this operation's end step (set below) and whether its money step has started (for the catch).
  let runEnd: (() => Promise<void>) | null = null;
  let moneyTried = false;
  try {
    // Astra WP3-5 #1: a held operation does nothing until a person clears the hold. A saved success (refunded_at, done_at) is honoured only
    // while this operation holds the claims on the note and refund it rests on (claimed now when nobody holds them): otherwise it is a
    // duplicate's success, and the operation is quarantined, never completed on it.
    if (op.attribution_hold === 1) throw new RefundPending("attribution_unresolved");
    if ((op.refunded_at !== null || op.done_at !== null) && (op.credit_note_id || op.stripe_refund_id)
      && !await claimRefundObjects(env, lease, op.id, { creditNoteId: op.credit_note_id, refundIds: [op.stripe_refund_id] }, ctx.now)) {
      await quarantineOp(env, lease, op, "claimed_elsewhere", ctx.now);
      op = (await getRefundOp(env, id))!;
      throw new RefundPending("attribution_unresolved");
    }
    // Astra WP3-6 #2: a success or completion recorded on a credit note before migration 0070 (note_reconcile = 1) may rest on ONE refund of a
    // split note (500¢ succeeded + 1,950¢ failed on a 2,450¢ operation). Before done_at or refunded_at is honoured, the whole note is read
    // and must carry exactly the decided amount in one refund (the checkpointed one), and that refund must have succeeded for that amount.
    // Otherwise the operation is quarantined and reopened: its success and completion are cleared, it is held, and ops is alerted below.
    if (op.note_reconcile === 1) {
      if (!await legacyNoteSettles(ctx, op)) {
        await quarantineOp(env, lease, op, "note_invalid", ctx.now);
        op = (await getRefundOp(env, id))!;
        throw new RefundPending("attribution_unresolved");
      }
      await set("note_reconcile=0");
      op = (await getRefundOp(env, id))!;
      if (op.done_at !== null) return op;
    }
    // The voluntary 7-day refund is decided BEFORE anything is cancelled: a request it turns down leaves the plan running (and is
    // explained to the customer), never a cancelled plan with nothing refunded.
    // Astra INTEGRATED-13 P1-2: CANCELLING IS NEVER GATED. A dispute hold that stops the decision (an unrelated, attribution-pending hold
    // included) while the request's eligibility is established anyway (DisputeHeld.endEligible) does not stop the contract's end: the
    // eligibility is recorded, the end step is installed below and runs in this pass (the catch), and only the money waits for the hold.
    let heldEligible: DisputeHeld | null = null;
    if (op.kind === "first_month") {
      try { await decideNow(); }
      catch (e) {
        if (!(e instanceof DisputeHeld) || !e.endEligible || (op.end_plan !== 1 && !op.cancel_subscription_id) || op.canceled_at !== null) throw e;
        heldEligible = e;
        await set("detail=json_set(COALESCE(detail,'{}'),'$.endEligibleAt',COALESCE(json_extract(detail,'$.endEligibleAt'),?))", ctx.now);
        op = (await getRefundOp(env, id))!;
      }
    }
    // Astra NODEDUCT-1 #1: a legacy decision at the fee minus credits used is upgraded to the full fee while provably unsubmitted.
    if (await upgradeLegacyDeduction(env, ctx, op)) op = (await getRefundOp(env, id))!;
    // (Round 9b: a dispute remainder is the rest of its parent's refund too: never a refusal, never the person's one refund record.)
    const remainderOf = (JSON.parse(op.detail ?? "{}") as Detail).legacyRemainderOf ?? (JSON.parse(op.detail ?? "{}") as Detail).disputeRemainderOf;
    // The rest of a legacy refund that refunds nothing more is not a refusal: nothing is said, it just completes.
    // Round 10 (P1-1): an amount a lost dispute lowered to zero is not a refusal (the bank returned the money; a reinstatement reopens it).
    const declined = op.kind === "first_month" && op.decided_at !== null && (op.amount_cents ?? 0) === 0 && !remainderOf
      && (JSON.parse(op.detail ?? "{}") as Detail).disputeCappedFromCents === undefined;
    // Astra INTEGRATED-3 #6: MONEY FIRST, THEN THE END. This operation's own Stripe-end step (end_plan / cancel_subscription_id) runs only
    // AFTER its refund checkpoint: the refund or credit note exists at Stripe (submitted, not failed), or no money is owed (amount 0, or already
    // refunded). Money that cannot move this pass (a payment not settled yet, a fact awaited, a refused refund) was still attempted first;
    // billing then stops in the same pass (the catch below), so a customer never keeps paying while a refund waits. Ordinary cancellation
    // (Cancel plan, Delete) is independent of this and unchanged.
    // Astra JOURNEY-BCORE-7 #1, INTEGRATED-1 #6: ANY failure of the end (parked, a Stripe refusal, an unconfirmed cancel) never holds the
    // money back: the end is its own checkpoint (canceled_at), retried on the next pass; refunded_at keeps the refund single. A declined
    // first-month request ends nothing (the plan keeps running).
    let endParked: unknown = null;
    let endTried = false;
    const endStep = async () => {
      if (endTried || op.canceled_at !== null || declined) return;
      endTried = true;
      try {
        await fence(env, lease);
        if (op.end_plan === 1) {
          // Astra MAILRETRY-14 P2-a: opened with its plan unresolved: resolved again now. Still unknown: the end stays open (no canceled_at,
          // the operation not done, its alert kept) and is re-evaluated on the next pass; never recorded as a cancellation that did not happen.
          const unresolved = (JSON.parse(op.detail ?? "{}") as Detail).planUnresolved;
          if (!op.subscription_id && unresolved) {
            const resolved = await resolveRefundSubscription(env, ctx.stripe, op.home_id, unresolved.obligationId, unresolved.paymentId);
            if (!resolved) throw new PlanUnresolved();
            await set("subscription_id=COALESCE(subscription_id,?)", resolved);
            op = (await getRefundOp(env, id))!;
          }
          // THIS operation's own subscription, captured when it was opened: never whatever the home keeps now (a replacement checkout
          // may have taken the home since, and a retry of an old operation must never cancel it).
          if (op.subscription_id) {
            // Astra INTEGRATED-2 #2: skipped ONLY on Stripe's own end of this subscription (THE checkpoint), never on a local canceled status
            // (another path writes that BEFORE its own end is done). cancelConfirmed sets the checkpoint when Stripe confirms.
            // A turned-away order (a rejection kind) is cancelled like every other rejection: no proration, no invoice now.
            if (!await stripeEndConfirmed(env, op.subscription_id)) await cancelConfirmed(env, lease, ctx.stripe, op.subscription_id, isRejectKind(op.kind) ? NO_PRORATION : undefined);
            await fencedRun(env, lease, "UPDATE billing_subscriptions SET status='canceled',updated_at=?,ended_at=COALESCE(ended_at,?) WHERE home_id=? AND subscription_id=? AND status<>'disputed'", ctx.now, ctx.now, op.home_id, op.subscription_id);
          }
        } else if (op.cancel_subscription_id) {
          await cancelConfirmed(env, lease, ctx.stripe, op.cancel_subscription_id, isRejectKind(op.kind) || op.kind === "cutover" ? NO_PRORATION : undefined);
        }
        await set("canceled_at=?", ctx.now);
        // The plan once unresolved is now ended and confirmed: its alert is resolved.
        if ((JSON.parse(op.detail ?? "{}") as Detail).planUnresolved) {
          await fencedRun(env, lease, "UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", ctx.now, planUnresolvedAlertId(id));
        }
        op = (await getRefundOp(env, id))!;
      } catch (e) { if (e instanceof LeaseLost) throw e; endParked = e; }
    };
    runEnd = endStep;
    moneyTried = true;
    // INTEGRATED-13 P1-2: eligible but held: the end runs now (the catch below), the money is retried once the hold is released.
    if (heldEligible) throw heldEligible;
    // A paid refusal opened without its invoice (Astra DROPDOWN-DIRECT-2 (1)): the invoice is read back from its checkout session first. Not
    // there yet: the operation waits (retried by the sweep, ops alerted after a few tries); the obligation itself is never dropped.
    const sessionOfOp = op.invoice_id === null && op.decided_at === null ? (JSON.parse(op.detail ?? "{}") as Detail).sessionId : undefined;
    if (sessionOfOp) {
      const recovered = await ctx.stripe.checkoutSessionInvoice(sessionOfOp);
      if (!recovered) throw new RefundPending("invoice_unresolved");
      await set("invoice_id=COALESCE(invoice_id,?)", recovered);
      op = (await getRefundOp(env, id))!;
    }
    await decideNow();
    // Round 9b (currency): a dispute of this payment whose movements are not known exactly holds the operation for a person BEFORE any cap or
    // restore: the money the bank returned is never computed from a conversion (nor assumed), so nothing is lowered, raised or paid on it.
    if (op.invoice_id && await env.DB.prepare(`SELECT 1 AS x FROM payment_disputes d WHERE ${DISPUTE_INEXACT_HELD_SQL}
      AND (d.invoice_id=?1 OR (?2 IS NOT NULL AND d.payment_intent=?2)) LIMIT 1`).bind(op.invoice_id, op.payment_intent).first()) throw new RefundPending("payment_dispute_inexact");
    if (await capForDisputeReturn(env, ctx, op)) op = (await getRefundOp(env, id))!;
    if (await restoreForDisputeReinstatement(env, ctx, op)) op = (await getRefundOp(env, id))!;
    const amount = op.amount_cents ?? 0;
    if (amount > 0 && op.refunded_at === null) {
      const pi = op.payment_intent ?? (op.invoice_id ? (await ctx.stripe.getInvoice(op.invoice_id)).payment_intent : null);
      if (!pi) throw new RefundPending("payment_unresolved");
      // G-F1: before ANY money step (a refund or a credit note, new or adopted), the charge's unapplied dispute hold.
      if (await disputeHeldFirst(env, { paymentIntent: pi, invoiceId: op.invoice_id, homeId: op.home_id })) throw new RefundPending("payment_dispute_hold");
      let refund: RefundView | null = null;
      // Made by THIS pass (a new refund or credit note): only then may our own clock stand in for Stripe's `created` when Stripe does not
      // show it. Anything found (a crash, a lost answer) keeps Stripe's own creation time: discovery is never a submission (Astra WP3-1 #5).
      let fresh = false;
      const stripeTime = (created: number | null | undefined): number | null =>
        typeof created === "number" && created > 0 ? created * 1000 : fresh ? ctx.now : null;
      // Cloud checkout WP3: on the direct path the new kinds refund through a CREDIT NOTE (Stripe Tax reverses the tax with it); the note
      // carries the op id, is found by it before any new one is made, and its refund is the one followed. Managed Payments and every older
      // kind keep POST /v1/refunds.
      // Astra DROPDOWN-DIRECT-2 (2): every direct refusal (duplicate and late_payment opened with the direct path too) takes the same route.
      const viaNote = refundsViaCreditNote(op, (JSON.parse(op.detail ?? "{}") as Detail).path);
      // A checkpointed note is validated as a WHOLE before its refund is followed (Astra WP3-5 #2): its checkpointed refund alone is never
      // read straight from the row, since a split note (500¢ pending + 1,950¢ failed) would settle on its first refund.
      if (op.stripe_refund_id && !(viaNote && op.credit_note_id)) refund = await ctx.stripe.getRefund(op.stripe_refund_id);
      if (!refund && viaNote) {
        // Every page of the invoice's notes is read until this op's note is found or none can exist (Astra WP3-1 #3): an incomplete listing
        // throws, and the operation retries; it never makes a second note.
        // A note carrying this op id is followed only when it is the one this operation submitted (creditNoteMatchesOp, the importer's own
        // rule): a copied op id on a foreign note never takes this obligation's place (Astra WP3-3 #1).
        const at = { homeId: lease.homeId, invoiceId: op.invoice_id!, paymentIntent: pi, paymentInvoice: op.invoice_id };
        const attribution = (n: CreditNoteView) => n.status === "void" ? "foreign" : creditNoteAttribution(op, n, at);
        const accept = (n: CreditNoteView) => attribution(n) !== "foreign";
        let note: CreditNoteView | null;
        // Astra WP3-7 #1: a note OUR create call returned for the current submission is followed by its id (retained provenance), whatever
        // its metadata says now: never re-made after the idempotency key expires.
        const ownNote = op.credit_note_id || op.submitted_at === null ? null
          : (await journalOf(env, id)).find((j) => j.submission === op.submission && j.object_kind === "credit_note" && j.object_id)?.object_id ?? null;
        if (op.credit_note_id) note = await ctx.stripe.getCreditNote(op.credit_note_id);
        else if (ownNote) {
          note = (await ctx.stripe.getCreditNote(ownNote)) ?? null;
          if (!note) throw new RefundPending("attribution_unresolved");
        } else {
          const listed = (await ctx.stripe.listCreditNotes(op.invoice_id!, { opId: op.id, accept })).data;
          note = listed.find((n) => attribution(n) === "match") ?? listed.find((n) => attribution(n) === "unresolved") ?? null;
        }
        // A note of this operation that carries several refunds is never followed by its first refund alone (Astra WP3-4 #2), nor one whose
        // refunds do not add up to the decided amount or that does not carry the checkpointed refund (Astra WP3-5 #2).
        if (note && !noteSettlesOp(op, note, amount)) throw new RefundPending("attribution_unresolved");
        if (!note) {
          const n = op.submitted_at !== null ? op.submission : op.submission + 1;
          const target: JournalTarget = { opId: id, submission: n, kind: "credit_note", invoiceId: op.invoice_id, paymentIntent: pi, amount };
          const intentAt = await intend(target); // intent first, durably, and journaled
          await fence(env, lease);
          note = await ctx.stripe.createCreditNote({ invoiceId: op.invoice_id!, amountCents: amount, opId: op.id, submission: n }, `creditnote:${op.id}:${n}`);
          fresh = true;
          await fencedBatch(env, lease, [journalReturned(target, intentAt, note.id, ctx.now)]); // what OUR call made: retained provenance
          // And again as Stripe made it: a note that does not carry exactly this amount in one refund is never followed either.
          if (!noteSettlesOp(op, note, amount)) throw new RefundPending("attribution_unresolved");
        }
        // Round 9b (P2-a): a note found (not made by this pass) is adopted only through the same dispute gate as a new submission.
        if (!fresh) await disputeGate(pi);
        // SUBMITTED: the credit note exists. This is the date we promise (Stripe's own creation time of the note); Stripe's refund state is
        // recorded separately below. The note's refund id is recorded at the same checkpoint: Stripe does not copy the note's op id onto
        // the refund, so this id is what tells the external-refund importer the refund is ours (Astra WP3-1 #1).
        // The note and every refund it carries are CLAIMED for this operation in the same batch as the checkpoint (Astra WP3-4 #1): a note
        // or refund another operation holds is never adopted, whatever its metadata says; the operation stays pending for a person.
        if (!await claimRefundObjects(env, lease, op.id, { creditNoteId: note.id, refundIds: note.refunds ?? [note.refund] }, ctx.now,
          q(`UPDATE refund_ops SET credit_note_id=COALESCE(credit_note_id,?),stripe_refund_id=COALESCE(stripe_refund_id,?),refund_submitted_at=COALESCE(refund_submitted_at,?),
            updated_at=? WHERE id=?`, note.id, note.refund, stripeTime(note.created), ctx.now, id))) throw new RefundPending("attribution_unresolved");
        if (!note.refund) throw new RefundWaiting("pending"); // the note's refund is not shown yet: looked at again, the note is never made twice
        refund = await ctx.stripe.getRefund(note.refund);
        if (typeof refund?.amount === "number" && refund.amount !== amount) throw new RefundPending("attribution_unresolved");
      }
      if (!refund && !viaNote && op.submitted_at !== null) {
        // Astra WP3-7 #1: a refund OUR create call returned for the current submission is followed by its id, whatever its metadata says now.
        const own = (await journalOf(env, id)).find((j) => j.submission === op.submission && j.object_kind === "refund" && j.object_id)?.object_id;
        if (own) refund = (await ctx.stripe.getRefund(own)) ?? null;
      }
      if (!refund) {
        // Before ANY new submission, settle from Stripe by the payment and this obligation's op id (a crash, a lost answer, a migrated
        // pre-0024 operation without a submission number): a refund for this obligation that has not failed IS the refund, so there is never
        // a second live refund for one obligation. Stripe's idempotency keys are not relied on to last.
        // Only a refund of THIS operation's payment counts: matched by op id AND payment intent.
        const mine = (await ctx.stripe.listRefunds(pi)).data.filter((r) => r.metadata?.op_id === op.id && (r.payment_intent ?? pi) === pi);
        refund = mine.find((r) => r.status !== "failed" && r.status !== "canceled")
          ?? (op.submitted_at !== null ? mine.find((r) => r.metadata?.submission === String(op.submission)) ?? null : null);
      }
      if (!refund) {
        // While a submission's outcome is unknown (intent recorded, nothing confirmed) the SAME submission and key are reused, so a worker
        // that lost its lease mid-call and a new one can only ever create one refund. Only a confirmed terminal failure moves to the next.
        const n = op.submitted_at !== null ? op.submission : op.submission + 1;
        const target: JournalTarget = { opId: id, submission: n, kind: "refund", invoiceId: op.invoice_id, paymentIntent: pi, amount };
        const intentAt = await intend(target); // intent first, durably, and journaled
        await fence(env, lease);
        refund = await ctx.stripe.createRefund({ paymentIntent: pi, amountCents: amount, reason: op.kind, opId: op.id, submission: n }, `refundop:${op.id}:${n}`);
        fresh = true;
        await fencedBatch(env, lease, [journalReturned(target, intentAt, refund.id, ctx.now)]); // what OUR call made: retained provenance
      }
      // Round 9b (P2-a): a refund found (its saved id, the journal, Stripe's listing), not made by this pass, that may still move money is
      // adopted only through the same dispute gate (combined refund + dispute cap) as a new submission. A failed one is resubmitted via intend.
      if (!fresh && !viaNote && refund.status !== "failed" && refund.status !== "canceled") await disputeGate(pi);
      // Whatever found it (a checkpoint, a listing by op id, a fresh submission), the refund is this operation's only once it is claimed
      // for it: a refund another operation holds is never counted twice (Astra WP3-4 #1).
      if (!await claimRefundObjects(env, lease, op.id, { refundIds: [refund.id] }, ctx.now)) throw new RefundPending("attribution_unresolved");
      const status = refund.status ?? "pending";
      // Write it only if this operation does not already hold a different refund (a newer holder's): never overwrite another's checkpoint.
      // SUBMITTED (refund_submitted_at, written once) and Stripe's state (stripe_refund_status) are separate columns; "succeeded" is refunded_at below.
      await set("payment_intent=?,stripe_refund_id=COALESCE(stripe_refund_id,?),refund_status=?,stripe_refund_status=?,refund_submitted_at=COALESCE(refund_submitted_at,?)",
        pi, refund.id, status, status, status === "failed" || status === "canceled" ? null : stripeTime(refund.created));
      if (isCheckoutRefundKind(op.kind)) {
        const presentment = presentmentJson(op, refund, amount);
        if (presentment !== op.presentment_json) await set("presentment_json=?", presentment);
      }
      // The refund checkpoint is recorded (the money object exists at Stripe): only now is this operation's subscription ended.
      if (status !== "failed" && status !== "canceled") await endStep();
      if (status === "failed" || status === "canceled") {
        // Stripe could not pay it: the obligation stays open, a new submission follows (a credit note's refund is read again, never re-issued),
        // and a person is told. The promised date goes with the failed attempt: copy says "delayed" until a new refund exists.
        if (viaNote) await set("refund_submitted_at=NULL");
        else {
          // The refund id is cleared, so a row still marked for the migration-0060 reconciliation could never be reconciled: the mark and
          // the row's place in the home's refund.reconcile_stuck alert go in the same batch (Astra WP3-4 #4).
          const membership = op.submission_reconcile === 1 ? await reconcileAlertStmts(env, op.home_id, { remove: op.id }, ctx.now) : [];
          const res = await fencedBatch(env, lease, [
            q("UPDATE refund_ops SET stripe_refund_id=NULL,submitted_at=NULL,refund_submitted_at=NULL,submission_reconcile=0,reconcile_error=NULL,updated_at=? WHERE id=?", ctx.now, id),
            ...membership]);
          if (res[0].meta.changes !== 1) throw new LeaseLost();
        }
        await refundAlert(env, op, "refund.failed", { refundId: refund.id, status }, ctx.now);
        throw new RefundPending(`refund_${status}`);
      }
      if (status !== "succeeded") throw new RefundWaiting(status);
      await set("refunded_at=?,submitted_at=NULL", ctx.now);
      // The person's one refund is the parent's: the rest of a legacy refund never overwrites its record.
      if (op.kind === "first_month" && !remainderOf) await fencedRun(env, lease, "UPDATE first_month_refunds SET stripe_refund_id=?,amount_cents=? WHERE user_id=?", refund.id, amount, op.user_id);
      await fencedRun(env, lease, "UPDATE refund_identity_claims SET refunded_at=? WHERE op_id=? AND refunded_at IS NULL", ctx.now, op.id);
      op = (await getRefundOp(env, id))!;
    }
    // No money owed, or already returned: the end follows now (a no-op when it ran above or is already done).
    await endStep();
    // Astra NODEDUCT-1 #1: paid at a legacy deducted amount (reconciled from Stripe above): the rest of the full invoice follows.
    if (op.refunded_at !== null) { await openLegacyRemainder(env, ctx, op); op = (await getRefundOp(env, id))!; }
    const detail = JSON.parse(op.detail ?? "{}") as Detail;
    // Astra JOURNEY-A-5 #3: an operation opened while its payment's subscription kept the home (end_plan=1) may resume after a replacement
    // checkout took the home over. Immediately before any Stop, under this lease (the replacement's claim takes the same lease), the home's
    // CURRENT subscription is read again: if it is no longer this operation's, the operation downgrades itself, in one fenced write, to the
    // superseded case (end_plan=0): no home-wide Stop, only THIS payment's own grants are reversed below, the replacement's never.
    if (detail.revoke && op.end_plan === 1 && op.credits_revoked_at === null) {
      await fence(env, lease);
      const holder = await env.DB.prepare("SELECT subscription_id FROM billing_subscriptions WHERE home_id=?").bind(op.home_id)
        .first<{ subscription_id: string | null }>();
      const superseded = holder !== null && op.subscription_id !== null && holder.subscription_id !== null && holder.subscription_id !== op.subscription_id;
      if (superseded) {
        const res = await fencedBatch(env, lease, [q(`UPDATE refund_ops SET end_plan=0,detail=json_set(COALESCE(detail,'{}'),'$.supersededBy',?),updated_at=?
          WHERE id=? AND end_plan=1 AND credits_revoked_at IS NULL`, holder.subscription_id, ctx.now, id)]);
        if (res[0].meta.changes !== 1) throw new LeaseLost();
        op = (await getRefundOp(env, id))!;
      }
    }
    // Astra JOURNEY-A-6 #1: the CREDIT adjustment of every refund that takes credits back (a retained contract's included: end_plan=1) is
    // separate from service cancellation. Once this operation's money is returned (refunded_at), its payment goes under payment-level
    // coverage reconciliation (reconcilePaymentCoverage): each grant of the invoice gets a versioned cumulative target that follows EVERY
    // succeeded refund of the payment (this one and any other), so $9 of $49 returned removes 9/49 of a grant, never all of it; a refund that
    // fails later lowers it again. Journaled in the same fenced batch as this operation's write, on every pass that finds the money returned
    // (a reopened refund included). Astra JOURNEY-A-4 #1: a superseded payment's (end_plan=0) targets name only ITS invoice's grants.
    if (detail.revoke && op.refunded_at !== null && op.invoice_id && op.payment_intent
      && (op.end_plan === 1 || op.kind === "first_month" || op.kind === "withdrawal")) {
      const journaled = await fencedBatch(env, lease, [
        q("UPDATE refund_ops SET credits_revoked_at=CASE WHEN end_plan=0 THEN COALESCE(credits_revoked_at,?) ELSE credits_revoked_at END,updated_at=? WHERE id=?",
          ctx.now, ctx.now, id),
        coverageWatchQ({ homeId: op.home_id, paymentIntent: op.payment_intent, invoiceId: op.invoice_id, subscriptionId: op.subscription_id, paidCents: op.paid_cents }, ctx.now)]);
      if (journaled[0].meta.changes !== 1) throw new LeaseLost();
      try { await reconcilePaymentCoverage(env, lease, { stripe: ctx.stripe, flux: ctx.flux, deps: ctx.deps, now: ctx.now }, op.home_id, op.payment_intent); }
      catch (e) { if (e instanceof LeaseLost) throw e; /* journaled: the billing sweep re-reads the payment and asks B4 again */ }
      op = (await getRefundOp(env, id))!;
    } else if (op.refunded_at !== null && op.invoice_id && op.payment_intent
      && await env.DB.prepare("SELECT 1 AS x FROM credit_reversals WHERE op_id=? AND scope='target' AND final=1").bind(op.id).first()) {
      // Astra JOURNEY-A-8 #3: lane B (a turned-away order, an unserved renewal): this operation's grants carry FINAL versioned targets. Once its
      // money is returned, its payment goes under the same coverage reconciliation: the targets follow Stripe's current listing, so a refund
      // that fails or returns to requires_action later lowers them and the credit is given back.
      await fencedBatch(env, lease, [coverageWatchQ({ homeId: op.home_id, paymentIntent: op.payment_intent, invoiceId: op.invoice_id, subscriptionId: op.subscription_id,
        paidCents: op.paid_cents }, ctx.now)]);
      try { await reconcilePaymentCoverage(env, lease, { stripe: ctx.stripe, flux: ctx.flux, deps: ctx.deps, now: ctx.now }, op.home_id, op.payment_intent); }
      catch (e) { if (e instanceof LeaseLost) throw e; /* journaled: the billing sweep re-reads the payment and asks B4 again */ }
      op = (await getRefundOp(env, id))!;
    }
    // The plan this operation ended (end_plan=1: cancelled above, by this kind's own cancellation rule) stops its Flux service. The Stop never
    // reverses credit (keepGrants): the target above adjusts it for the money actually returned.
    if (detail.revoke && op.end_plan === 1 && op.credits_revoked_at === null) {
      if (ctx.flux.stub) {
        // Astra JOURNEY-A-10 #3: Flux is OFF (the pre-B4 stub): JOURNAL-ONLY. The Flux Stop is not sent; it stays pending on this operation
        // (credits_revoked_at NULL, its credit target already journaled above) with ONE alert, and the cash refund still completes and is
        // confirmed below (the email claims nothing about Flux).
        await fencedBatch(env, lease, [q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          `alert:flux_stop_pending:${op.id}`, op.home_id, "flux.stop_pending", "high", JSON.stringify({ opId: op.id, invoiceId: op.invoice_id }), ctx.now)]);
      } else {
        await ctx.flux.stopForBilling(env, op.home_id, undefined, { ...(op.invoice_id ? { invoiceId: op.invoice_id } : {}), keepGrants: true });
        await set("credits_revoked_at=?", ctx.now);
      }
    }
    // Reopens a refusal that no longer stands, and cancels its queued notice in the same write (Astra ASTRA-REFUND5 #1).
    const reopenRefusal = (cond: { sql: string; binds: unknown[] } | null) => fencedBatch(env, lease, [
      q(`UPDATE refund_ops SET decided_at=NULL,basis=NULL,amount_cents=NULL,target_cents=NULL,updated_at=?
        WHERE id=? AND decided_at IS NOT NULL AND notified_at IS NULL AND amount_cents=0${cond ? ` AND NOT ${cond.sql}` : ""}`, ctx.now, id, ...(cond?.binds ?? [])),
      q("UPDATE billing_notices SET canceled_at=?,claimed_until=NULL WHERE id=? AND sent_at IS NULL AND changes()=1", ctx.now,
        `refund_declined:${op.home_id}:not_first_payment:${op.invoice_id}`),
    ]);
    if (declined && op.notified_at === null && op.basis === "not_first_payment" && op.invoice_id) {
      // The refusal notice re-checks, in one fenced write, that the refusal still stands (Astra ASTRA-REFUND4 #2): an objection opened
      // after the decision was committed but before the notice reopens the request (pending, decided again once the objection ends).
      const [reopen] = await reopenRefusal(refusalStands(op.invoice_id, op.user_id));
      if (reopen.meta.changes === 1) throw new RefundPending("identity_check_unavailable");
    }
    if (declined && op.notified_at === null) {
      // Never a silent refusal: the reason in plain words, recorded under this lease and retried by the sweep until it is sent. One
      // notice per payment and reason (the same id the request route uses).
      const reason = refusalReason(op);
      const text = `About your refund request for Murage Cloud.\n\n${denialText(reason)}`;
      try {
        await notify(env, { ...ctx.deps, lease: ctx.lease }, op.home_id, "refund_declined", `${reason}:${op.invoice_id ?? "none"}`,
          { reason, emailText: text, emailHtml: htmlOf(text), invoiceId: op.invoice_id, userId: op.user_id });
      } catch (e) {
        // The notifier found, in its claim, that the refusal no longer stands: the request is pending again, never refused.
        if (!(e instanceof RefusalWithdrawn)) throw e;
        await reopenRefusal(null);
        throw new RefundPending("identity_check_unavailable");
      }
      await set("notified_at=?", ctx.now);
    }
    if (amount > 0 && op.notified_at === null) {
      // One logical notice per refund (the op id); the charge.refunded webhook that follows sends nothing for a ledger refund.
      await notify(env, { ...ctx.deps, lease: ctx.lease }, op.home_id, "refunded", op.id, { amount: usd(amount), refundId: op.stripe_refund_id ?? "",
        reason: op.kind === "withdrawal" ? "Your withdrawal from the contract" : op.kind === "first_month" ? (op.basis === "eu_uk_full_refund" ? "Our 14-day full refund for EU, EEA and UK customers" : "Our 7-day first-month refund offer")
          : op.kind === "price_mismatch" ? "The total charged was not the total you agreed to, so it is refunded in full"
              : op.kind === "late_payment" ? "A payment completed after your plan was cancelled, so it is refunded in full"
              // WP3 kinds. English placeholders: the plan gives no wording for these emails (BUILD-PLAN §D: de is null until it does).
              : op.kind === "mismatch" || op.kind === "country_paused" || op.kind === "rejected_consent" ? "Your payment could not be accepted for this purchase, so it is refunded in full"
                : op.kind === "cancellation_late" ? (op.cutover_at !== null ? "A renewal covered time after your cancellation took effect, so that part of it is refunded"
                  : "A renewal was collected after your cancellation took effect, so it is refunded in full")
                  : op.kind === "cutover" ? "The unused part of your previous plan's paid period"
                    : op.kind === "extraordinary" ? "The unused days after your termination for cause"
              : "A second checkout for the same server was refunded in full",
        // Only while Flux is on: with Flux off nothing was taken back at Flux, so the email says nothing about credits (Astra JOURNEY-A-10 #3).
        ...(op.kind === "first_month" && !remainderOf && fluxDispatchEnabled(ctx.flux) ? { creditsRemoved: "Unused included Flux credits from this plan are removed from your balance." } : {}),
        ...(detail.offerDeclined ? { sevenDayOffer: denialText(detail.offerDeclined) } : {}) });
      await set("notified_at=?", ctx.now);
    }
    // Money returned and the customer told; the subscription's end still waits (parked, or failed): the operation stays open for it alone.
    if (endParked) throw endParked;
    // Round 9b (P1-6): an operation a lost dispute capped is never completed while that loss may still be reversed.
    await settleDisputeCap(env, ctx, op);
    // A finished operation leaves the home's attribution alert in the same batch (Astra WP3-5 #3): only once a person cleared its hold.
    const attributionOut = await attributionAlertStmts(env, op.home_id, { remove: id }, ctx.now);
    // Astra INTEGRATED-8 P1: a dispute remainder's completion re-judges its parent in this same batch (after the completion below).
    const nextRemainder = await remainderCompletionQs(env, op, ctx.now);
    const fin = await fencedBatch(env, lease, [
      // Never completed while held (Astra WP3-5): the hold is read in the completing statement itself.
      q("UPDATE refund_ops SET done_at=?,last_error=NULL,lease_until=NULL,updated_at=? WHERE id=? AND attribution_hold=0", ctx.now, ctx.now, id),
      q("UPDATE withdrawals SET status='completed',stripe_refund_id=? WHERE refund_op_id=? AND changes()=1", op.stripe_refund_id, id),
      q("UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='refund.stuck' AND resolved_at IS NULL AND json_extract(detail,'$.opId')=?",
        ctx.now, op.home_id, id),
      ...attributionOut,
      ...nextRemainder,
    ]);
    if (fin[0].meta.changes !== 1) {
      if ((await getRefundOp(env, id))?.attribution_hold === 1) throw new RefundPending("attribution_unresolved");
      throw new LeaseLost();
    }
  } catch (e) {
    if (e instanceof LeaseLost) return getRefundOp(env, id); // lost the lease: record nothing; the next holder reconciles from Stripe
    // Astra INTEGRATED-3 #6: the money step was attempted FIRST but could not finish this pass (waiting on Stripe or on a fact, or refused):
    // billing still stops now. The end is never held back by money that cannot move yet; it only never goes ahead of money that can.
    if (moneyTried && runEnd) { try { await runEnd(); } catch (x) { if (x instanceof LeaseLost) return getRefundOp(env, id); throw x; } }
    const code = (e instanceof Error ? e.message : "error").slice(0, 80);
    if (e instanceof RefundWaiting) {
      // Accepted by Stripe, not finished: look again in an hour. Not an error, but a refund that needs the customer's action is flagged.
      // A capped refund waiting out its dispute's reinstatement window is looked at daily (and at once on any dispute movement: settleDispute).
      await bookkeeping([q("UPDATE refund_ops SET next_attempt_at=?,last_error=?,lease_until=NULL,updated_at=? WHERE id=?",
        ctx.now + (code === DISPUTE_REINSTATEMENT_WAIT ? DAY_MS : 3_600_000), `refund_${code}`, ctx.now, id),
        q("UPDATE withdrawals SET status='processing' WHERE refund_op_id=? AND status<>'completed'", id)]);
      if (code === "requires_action") await refundAlert(env, op, "refund.stuck", { opId: id, kind: op.kind, error: "refund_requires_action" }, ctx.now);
      return getRefundOp(env, id);
    }
    if (e instanceof PlanUnresolved) {
      // The money went back first; only the plan's end waits for its identity (the alert raised when the operation opened stays open). Not
      // a failure, no attempt counted: looked at again hourly, so a subscription that becomes resolvable is ended then, once.
      await bookkeeping([q("UPDATE refund_ops SET next_attempt_at=?,last_error=?,lease_until=NULL,updated_at=? WHERE id=?", ctx.now + 3_600_000, code, ctx.now, id)]);
      return getRefundOp(env, id);
    }
    if (e instanceof SubscriptionParked) {
      // Only the subscription's end is pending (the money went back first): not a failure, no attempt counted, no refund alert (the parking
      // raised its own). Looked at again hourly; unparkQs makes it due at once when the parking clears.
      await bookkeeping([q("UPDATE refund_ops SET next_attempt_at=?,last_error=?,lease_until=NULL,updated_at=? WHERE id=?", ctx.now + 3_600_000, code, ctx.now, id)]);
      return getRefundOp(env, id);
    }
    const attempts = op.attempts + 1;
    // Astra INTEGRATED-13 P2: the backoff is FENCED by the release generation read at the start of this pass: a hold released (and its
    // refunds woken) after this pass observed it leaves the refund due now, never six hours later.
    if (!await bookkeeping([q(`UPDATE refund_ops SET attempts=?,last_error=?,next_attempt_at=CASE WHEN COALESCE(wake_gen,0)=? THEN ? ELSE ? END,lease_until=NULL,updated_at=?
      WHERE id=?`, attempts, code, observedGen, ctx.now + backoff(attempts), ctx.now, ctx.now, id),
      q("UPDATE withdrawals SET status='processing' WHERE refund_op_id=? AND status<>'completed'", id),
      // Attribution that cannot be settled HOLDS the operation (Astra WP3-5 #2): a later pass never completes it on what it finds then.
      ...(code === "attribution_unresolved" ? [q("UPDATE refund_ops SET attribution_hold=1 WHERE id=?", id)] : [])])) return getRefundOp(env, id);
    // A charged customer always ends with a refund or a person looking at it: after a few tries (or at once for an unwired B4) ops is alerted.
    // Attribution that cannot be settled (Astra WP3-4) is a person's job at once, under its own alert kind.
    if (code === "attribution_unresolved") {
      await bookkeeping(await attributionAlertStmts(env, op.home_id, { add: { opId: id, detail: { kind: op.kind, error: code, attempts } } }, ctx.now));
    } else if (attempts >= 3 || code === "flux_not_wired") {
      await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), op.home_id, "refund.stuck", "high", JSON.stringify({ opId: id, kind: op.kind, error: code, attempts }), ctx.now).run();
    }
  }
  return getRefundOp(env, id);
}

/** What Stripe reported about the refund, recorded with the USD request: the refund object's id and state, its presentment amount (the customer's
 *  own currency, converted by Stripe at the original rate) and the tax portion of the request. */
function presentmentJson(op: RefundOpRow, refund: RefundView, amount: number): string {
  const detail = JSON.parse(op.detail ?? "{}") as Detail;
  return JSON.stringify({ requestedUsdCents: amount, refundId: refund.id, status: refund.status ?? "pending", taxCents: detail.refundTaxCents ?? 0,
    presentment: refund.presentment_details ?? null });
}

async function refundAlert(env: Env, op: RefundOpRow, kind: string, detail: Record<string, unknown>, now: number) {
  await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(crypto.randomUUID(), op.home_id, kind, "high", JSON.stringify({ opId: op.id, ...detail }), now).run();
}

/** An alert written in the same D1 batch as the transition it reports, raised only when that transition is what the row now shows: the
 *  guard reads the row's post-state (its id, this pass's updated_at and the marker the transition wrote), so a batch whose transition
 *  matched nothing raises nothing, and a lost lease rolls the alert back with the transition (Astra WP3-3 #2). */
const guardedAlert = (op: RefundOpRow, kind: string, detail: Record<string, unknown>, lastError: string, now: number): Q =>
  q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM refund_ops WHERE id=? AND updated_at=? AND done_at IS NULL AND last_error=?) ON CONFLICT DO NOTHING`,
  crypto.randomUUID(), op.home_id, kind, "high", JSON.stringify({ opId: op.id, ...detail }), now, op.id, now, lastError);

/** The failure/reopen transition: Stripe reports the operation's current refund failed or canceled, so the obligation is open again (even
 *  after the operation finished): the refund id, both dates, success and completion are cleared, the withdrawal goes back to processing, the
 *  sweep resubmits at once, and ops is alerted. Fenced under the caller's lease; false when the row has moved on (another refund, another
 *  submission) and nothing was changed. Shared by refund events and the migration-0060 reconciliation (Astra WP3-2 #2). The transition, the
 *  withdrawal, the alert and `extra` (the reconciliation's alert bookkeeping) commit as ONE batch (Astra WP3-3 #2). */
async function reopenFailedRefund(env: Env, lease: HomeLease, op: RefundOpRow, refundId: string | null, status: string, now: number, extra: Q[] = []): Promise<boolean> {
  // The transition clears the row's reconciliation mark, so it also takes the row out of the home's refund.reconcile_stuck alert in the
  // same batch (Astra WP3-4 #4): every caller (a refund webhook as much as the reconciliation) passes through here, and none can leave a
  // member named in the alert that nothing will ever reconcile. Guarded by the row's post-state: applied only with the transition.
  const membership = await reconcileAlertStmts(env, op.home_id, { remove: op.id }, now);
  const res = await fencedBatch(env, lease, [
    q(`UPDATE refund_ops SET refund_status=?,stripe_refund_status=?,refund_submitted_at=NULL,stripe_refund_id=NULL,submitted_at=NULL,refunded_at=NULL,done_at=NULL,next_attempt_at=?,
      last_error=?,submission_reconcile=0,reconcile_error=NULL,updated_at=? WHERE id=? AND submission=? AND (stripe_refund_id=? OR stripe_refund_id IS NULL)`,
    status, status, now, `refund_${status}`, now, op.id, op.submission, refundId),
    q("UPDATE withdrawals SET status='processing' WHERE refund_op_id=? AND changes()=1", op.id),
    guardedAlert(op, "refund.failed", { refundId, status }, `refund_${status}`, now),
    ...membership,
    ...extra,
  ]);
  return res[0].meta.changes === 1;
}
/** Stripe reports a refund the operation already counted as succeeded now needs the customer's action (Stripe documents succeeded ->
 *  requires_action for some methods). The operation is reopened with its refund id KEPT (the refund still exists; no new one is made): success
 *  and completion are cleared, the withdrawal goes back to processing, ops is alerted, and the sweep polls the refund again in an hour until
 *  Stripe reports it finished. The submitted date stays. Astra WP3-2 #4. `reconciled` (the migration-0060 reconciliation) also records
 *  Stripe's created time and clears the reconciliation mark IN THE SAME statement, so a lost lease leaves the row still marked (WP3-3 #2). */
async function reopenRequiresAction(env: Env, lease: HomeLease, op: RefundOpRow, refundId: string, now: number,
  reconciled?: { submittedAt: number | null; extra: Q[] }): Promise<boolean> {
  const rec = reconciled ? ",refund_submitted_at=?,submission_reconcile=0,reconcile_error=NULL" : "";
  const res = await fencedBatch(env, lease, [
    q(`UPDATE refund_ops SET refund_status='requires_action',stripe_refund_status='requires_action',refunded_at=NULL,done_at=NULL,next_attempt_at=?,
      last_error='refund_requires_action'${rec},updated_at=? WHERE id=? AND stripe_refund_id=? AND (refunded_at IS NOT NULL OR done_at IS NOT NULL)
      ${reconciled ? "AND submission_reconcile=1" : ""}`,
    now + 3_600_000, ...(reconciled ? [reconciled.submittedAt] : []), now, op.id, refundId),
    q("UPDATE withdrawals SET status='processing' WHERE refund_op_id=? AND changes()=1", op.id),
    guardedAlert(op, "refund.stuck", { kind: op.kind, refundId, error: "refund_requires_action" }, "refund_requires_action", now),
    ...(reconciled?.extra ?? []),
  ]);
  return res[0].meta.changes === 1;
}

/** Stripe's refund events (refund.updated / refund.failed / charge.refund.updated): a ledger refund is only complete once Stripe says it
 *  succeeded; a refund that later fails or is canceled reopens the obligation (even after the operation finished) and alerts ops. */
export async function applyRefundEvent(env: Env, ctx: RefundContext, refund: { id: string | null; status: string | null; opId: string | null;
  submission: string | null; paymentIntent?: string | null }): Promise<string> {
  const op = refund.opId ? await getRefundOp(env, refund.opId)
    : refund.id ? await env.DB.prepare("SELECT * FROM refund_ops WHERE stripe_refund_id=?").bind(refund.id).first<RefundOpRow>() : null;
  if (!op) return "not_a_ledger_refund";
  // A refund of another payment never touches this operation, whatever op id it carries.
  if (refund.paymentIntent && op.payment_intent && refund.paymentIntent !== op.payment_intent) return "stale_refund_event";
  const lease = ctx.lease ?? ctx.deps.lease;
  if (!lease) throw new Error("lease_required");
  // Stripe does not order events. Only the operation's CURRENT refund may change it: the refund it holds, or, before its id is known, the
  // current submission. An older attempt's event never clears a newer checkpoint.
  const current = refund.id !== null && op.stripe_refund_id !== null ? refund.id === op.stripe_refund_id
    : op.stripe_refund_id === null && refund.submission !== null && refund.submission === String(op.submission) && op.submitted_at !== null;
  if (!current) return "stale_refund_event";
  // Stripe does not order events, and an older one may arrive after the refund finished: the refund's CURRENT state is read from Stripe
  // under this lease and applied instead of the event's (Astra WP3-1 #4). A late "pending" never regresses a refund Stripe reports as
  // succeeded; a genuine later failure is what Stripe now reports, and still reopens the obligation.
  let status = refund.status; let authoritative = false;
  if (refund.id !== null) {
    const live = await ctx.stripe.getRefund(refund.id);
    if (live && typeof live.status === "string" && (!live.id || live.id === refund.id)) { status = live.status; authoritative = true; }
  }
  if (status === "failed" || status === "canceled") {
    return await reopenFailedRefund(env, lease, op, refund.id, status, ctx.now) ? "refund_reopened" : "stale_refund_event";
  }
  // Stripe's OWN current state says a counted refund needs the customer's action: reopened, alerted and polled again, the refund id kept
  // (Astra WP3-2 #4). An event's claim alone never reopens anything; a stale "pending" stays blocked below.
  if (status === "requires_action" && authoritative && refund.id !== null && (op.refunded_at !== null || op.done_at !== null)) {
    return await reopenRequiresAction(env, lease, op, refund.id, ctx.now) ? "refund_reopened" : "stale_refund_event";
  }
  // Never back from succeeded to a state before it (only a failure, or Stripe's own requires_action, both handled above, follows success).
  await fencedRun(env, lease, `UPDATE refund_ops SET refund_status=?,stripe_refund_status=?,updated_at=? WHERE id=?
    AND NOT (COALESCE(stripe_refund_status,refund_status)='succeeded' AND ? IS NOT 'succeeded')`, status, status, ctx.now, op.id, status);
  if (op.done_at === null) await advanceRefundOp(env, ctx, op.id);
  return "refund_status_recorded";
}

/** Migration 0060's backfill marks every row written before it that holds a Stripe refund (submission_reconcile=1): its submission date was
 *  never recorded from Stripe, and the old intent time (submitted_at) is not one. Each refund is read from Stripe under the home's lease and
 *  its own `created` time and current state are recorded (Astra WP3-1 #6). A refund Stripe cannot show now is retried with backoff and, if it
 *  keeps missing, escalated to ops (reconcileRetry, Astra WP3-2 #6). */
export async function reconcileRefundSubmissions(env: Env, ctx: RefundContext): Promise<number> {
  // Fair selection (Astra WP3-2 #6): only rows that are due, the least recently tried first. A row Stripe cannot show is pushed back by its
  // own backoff, so it never holds up the rows behind it.
  const due = await env.DB.prepare(`SELECT id, home_id FROM refund_ops WHERE submission_reconcile=1 AND stripe_refund_id IS NOT NULL AND COALESCE(reconcile_next_at,0)<=?
    ORDER BY COALESCE(reconcile_next_at,0), created_at, id LIMIT 50`).bind(ctx.now).all<{ id: string; home_id: string }>();
  let done = 0; let firstError: unknown = null;
  for (const r of due.results) {
    try {
      await withHomeLease(env, r.home_id, async (lease) => {
        const op = await getRefundOp(env, r.id);
        if (!op || op.submission_reconcile !== 1 || !op.stripe_refund_id) return;
        let live: RefundView | null = null; let failure: { code: string; missing: boolean } | null = null;
        try { live = await ctx.stripe.getRefund(op.stripe_refund_id); }
        catch (e) {
          // Every failure to READ the refund goes through the retry schedule (Astra WP3-3 #4): Stripe's own errors, and transport or decoding
          // failures (a fetch TypeError, a body that is not JSON) normalized here. None of them may skip the backoff and escalation, or stop the
          // rows behind this one.
          failure = readFailure(e);
        }
        const status = typeof live?.status === "string" ? live.status : null;
        const created = typeof live?.created === "number" && live.created > 0 ? live.created * 1000 : null;
        if (failure || status === null || (created === null && status !== "failed" && status !== "canceled")) {
          await reconcileRetry(env, lease, op, failure ?? { code: "refund_not_shown", missing: false }, ctx.now);
          return; // nothing authoritative yet: tried again after the backoff
        }
        // The row leaves reconciliation in the same batch as everything below: its entry in the home's escalation alert goes with it (WP3-3 #3).
        const alertOut = await reconcileAlertStmts(env, op.home_id, { remove: op.id }, ctx.now);
        if (status === "failed" || status === "canceled") {
          // Stripe says the recorded refund failed: the case is NOT completed, whatever the old row says (Astra WP3-2 #2). The failure/reopen
          // transition is applied under this lease (done_at, refunded_at and the withdrawal's completion cleared, ops alerted, resubmitted by
          // the sweep), and it clears the reconciliation mark with it, in one batch.
          if (await reopenFailedRefund(env, lease, op, op.stripe_refund_id, status, ctx.now)) done++; // its membership goes with the transition
          return;
        }
        if (status === "requires_action" && (op.refunded_at !== null || op.done_at !== null)) {
          // A row recorded as finished whose refund Stripe now says needs the customer's action is reopened and polled (Astra WP3-2 #4). The
          // status and date, the reopen, the withdrawal and the alert commit together (Astra WP3-3 #2): a lost lease leaves the row marked.
          if (await reopenRequiresAction(env, lease, op, op.stripe_refund_id, ctx.now, { submittedAt: created, extra: alertOut })) done++;
          return;
        }
        const res = await fencedBatch(env, lease, [
          q(`UPDATE refund_ops SET stripe_refund_status=?,refund_submitted_at=?,submission_reconcile=0,reconcile_error=NULL,updated_at=?
            WHERE id=? AND submission_reconcile=1 AND stripe_refund_id=?`, status, created, ctx.now, op.id, op.stripe_refund_id),
          ...alertOut,
        ]);
        if (res[0].meta.changes === 1) done++;
      }, ctx.lease ?? ctx.deps.lease);
    } catch (e) {
      if (e instanceof HomeBusy || e instanceof LeaseLost) continue; // the next sweep tries again
      // Anything else (a database error) is reported, but only after every other due row had its turn (Astra WP3-3 #4).
      firstError ??= e;
    }
  }
  if (firstError !== null) throw firstError;
  return done;
}
/** A failure to read a refund from Stripe, as the reconciliation's retry schedule records it. StripeError keeps its code (404: missing);
 *  anything else (a fetch TypeError, a response that does not decode) is a transport failure, retried like any other (Astra WP3-3 #4). */
function readFailure(e: unknown): { code: string; missing: boolean } {
  if (e instanceof StripeError) return { code: e.code, missing: e.status === 404 };
  if (e instanceof SyntaxError) return { code: "stripe_decode_error", missing: false };
  if (e instanceof TypeError) return { code: "stripe_transport_error", missing: false };
  return { code: `stripe_read_error:${(e instanceof Error ? e.message : String(e)).slice(0, 50)}`, missing: false };
}
/** A reconciliation Stripe could not answer: retried with the ledger's backoff (at most every 6 hours, for as long as it takes), and ops is
 *  told: after 2 misses for a refund Stripe says does not exist (404, which does not heal by waiting), after 6 for anything else. */
const RECONCILE_ESCALATE_MISSING = 2;
const RECONCILE_ESCALATE_OTHER = 6;
async function reconcileRetry(env: Env, lease: HomeLease, op: RefundOpRow, failure: { code: string; missing: boolean }, now: number): Promise<void> {
  const attempts = (op.reconcile_attempts ?? 0) + 1;
  const escalate = attempts >= (failure.missing ? RECONCILE_ESCALATE_MISSING : RECONCILE_ESCALATE_OTHER);
  await fencedBatch(env, lease, [
    q("UPDATE refund_ops SET reconcile_attempts=?,reconcile_next_at=?,reconcile_error=?,updated_at=? WHERE id=? AND submission_reconcile=1",
      attempts, now + backoff(attempts), failure.code.slice(0, 80), now, op.id),
    ...(escalate ? await reconcileAlertStmts(env, op.home_id, { add: { opId: op.id, refundId: op.stripe_refund_id, error: failure.code, missing: failure.missing, attempts } }, now) : []),
  ]);
}
/** The home's ONE open refund.reconcile_stuck alert (cloud_alerts keeps one open alert per home and kind) names EVERY row of the home still
 *  stuck (Astra WP3-3 #3): a row is added when it escalates and removed when it reconciles. When the set changes the alert is re-delivered
 *  (delivered_at cleared) with the new set; when it empties the alert is resolved. Returned as statements for the caller's fenced batch,
 *  each guarded by the row's own state so it applies only with the row's transition. An alert from before this (one opId) counts as that set. */
async function reconcileAlertStmts(env: Env, homeId: string, change: { add?: { opId: string; refundId: string | null; error: string; missing: boolean; attempts: number };
  remove?: string }, now: number): Promise<Q[]> {
  const open = await env.DB.prepare("SELECT id,detail FROM cloud_alerts WHERE home_id=? AND kind='refund.reconcile_stuck' AND resolved_at IS NULL")
    .bind(homeId).first<{ id: string; detail: string }>();
  let detail: Record<string, unknown> = {};
  try { detail = open ? JSON.parse(open.detail) as Record<string, unknown> : {}; } catch { detail = {}; }
  const was = Array.isArray(detail.opIds) ? (detail.opIds as unknown[]).filter((x): x is string => typeof x === "string")
    : typeof detail.opId === "string" ? [detail.opId] : [];
  const rowId = change.add?.opId ?? change.remove!;
  // The row's own state at commit time: still marked when it is added, cleared when it is removed.
  const guard = `EXISTS (SELECT 1 FROM refund_ops WHERE id=? AND submission_reconcile=${change.add ? 1 : 0})`;
  if (change.add) {
    if (was.includes(change.add.opId)) return []; // already named: no repeat delivery while it stays stuck
    const rows = { ...(typeof detail.rows === "object" && detail.rows !== null ? detail.rows as Record<string, unknown> : {}), [change.add.opId]: change.add };
    const next = { ...detail, ...change.add, opIds: [...was, change.add.opId], rows };
    if (!open) {
      return [q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`,
        `alert:reconcile:${homeId}:${crypto.randomUUID()}`, homeId, "refund.reconcile_stuck", "high", JSON.stringify(next), now, rowId)];
    }
    return [q(`UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND ${guard}`, JSON.stringify(next), open.id, rowId)];
  }
  if (!open || !was.includes(rowId)) return [];
  const left = was.filter((x) => x !== rowId);
  if (!left.length) return [q(`UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL AND ${guard}`, now, open.id, rowId)];
  const rows = { ...(typeof detail.rows === "object" && detail.rows !== null ? detail.rows as Record<string, Record<string, unknown>> : {}) };
  delete rows[rowId];
  const next: Record<string, unknown> = { ...detail, opIds: left, rows };
  if (next.opId === rowId) {
    // The headline names a row still stuck, never the one that recovered.
    delete next.refundId; delete next.error; delete next.missing; delete next.attempts;
    Object.assign(next, rows[left[0]] ?? {}, { opId: left[0] });
  }
  return [q(`UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND ${guard}`, JSON.stringify(next), open.id, rowId)];
}

/** The home's ONE open refund.attribution_unresolved alert (cloud_alerts keeps one open alert per home and kind) names EVERY operation of the
 *  home held for attribution (Astra WP3-5 #3), as the reconcile alert does: an operation is added when it becomes unresolved (the alert is
 *  re-delivered with the new set: delivered_at cleared) and removed when it finishes (the alert resolves when the set empties). An alert from
 *  before this (one opId) counts as that set. Statements for the caller's fenced batch, each guarded by the row's post-state: an add applies
 *  only with the transition that marked the row in this batch (its updated_at = now), a removal only once the row is done. */
async function attributionAlertStmts(env: Env, homeId: string, change: { add?: { opId: string; detail: Record<string, unknown> }; remove?: string }, now: number): Promise<Q[]> {
  const open = await env.DB.prepare("SELECT id,detail FROM cloud_alerts WHERE home_id=? AND kind='refund.attribution_unresolved' AND resolved_at IS NULL")
    .bind(homeId).first<{ id: string; detail: string }>();
  let detail: Record<string, unknown> = {};
  try { detail = open ? JSON.parse(open.detail) as Record<string, unknown> : {}; } catch { detail = {}; }
  const was = Array.isArray(detail.opIds) ? (detail.opIds as unknown[]).filter((x): x is string => typeof x === "string")
    : typeof detail.opId === "string" ? [detail.opId] : [];
  const rows = { ...(typeof detail.rows === "object" && detail.rows !== null ? detail.rows as Record<string, Record<string, unknown>> : {}) };
  if (change.add) {
    const { opId } = change.add;
    if (was.includes(opId)) return []; // already named: no repeat delivery while it stays unresolved
    const guard = "EXISTS (SELECT 1 FROM refund_ops WHERE id=? AND updated_at=? AND done_at IS NULL AND last_error='attribution_unresolved')";
    rows[opId] = { opId, ...change.add.detail };
    if (!open) {
      return [q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`,
        `alert:attribution:${homeId}:${crypto.randomUUID()}`, homeId, "refund.attribution_unresolved", "high",
        JSON.stringify({ ...rows[opId], opIds: [opId], rows }), now, opId, now)];
    }
    return [q(`UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND ${guard}`,
      JSON.stringify({ ...detail, opIds: [...was, opId], rows }), open.id, opId, now)];
  }
  const rowId = change.remove!;
  if (!open || !was.includes(rowId)) return [];
  // Removed once it finished, or once the attribution reconciliation proved it and cleared its hold (Astra WP3-6 #4).
  const guard = "EXISTS (SELECT 1 FROM refund_ops WHERE id=? AND (done_at IS NOT NULL OR attribution_hold=0))";
  const left = was.filter((x) => x !== rowId);
  if (!left.length) return [q(`UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL AND ${guard}`, now, open.id, rowId)];
  delete rows[rowId];
  // The headline names an operation still held, never the one that finished.
  const next: Record<string, unknown> = detail.opId === rowId ? { ...rows[left[0]], opId: left[0] } : { ...detail };
  Object.assign(next, { opIds: left, rows });
  return [q(`UPDATE cloud_alerts SET detail=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL AND ${guard}`, JSON.stringify(next), open.id, rowId)];
}

// ---- Attribution reconciliation (Astra WP3-6 #4) ------------------------------------------------------------------------------------------
// A hold must never block a refund that is owed for ever. Every held operation is looked at again under the home's billing lease (one
// worker per home, every write fenced) on its own schedule. Ownership is proven only INDEPENDENTLY, from Stripe: the object names this
// operation AND its recorded submission number, carries exactly its decided amount in one refund, for its home's invoice and payment, on its
// path. Creation order, row ids and what the database recorded never prove it. When it is proven, the ledger is repaired (the object is
// restored on the row and claimed for it; another operation that recorded it is quarantined; claims held by unproven operations are moved)
// and the hold is cleared, so the sweep pays or completes it. When nothing at Stripe names the operation and every object it was
// quarantined over is owned by an operation that proved it, it never had an object: the hold is cleared and it is submitted normally.
// A statutory refund still held as its legal deadline approaches is escalated to ops at rising urgency; it still cannot be paid without proven
// ownership, and the alert says so.

/** EU/EEA/UK statutory refunds must be paid within 14 days (withdrawal: of the withdrawal; the 14-day full refund: of the request). */
export const STATUTORY_REFUND_MS = 14 * DAY_MS;
/** How often a held operation is looked at again when nothing changed. */
export const ATTRIBUTION_RECHECK_MS = 3_600_000;
/** The urgency of a held statutory refund by time left to its legal deadline (first match). */
export const DEADLINE_STAGES = [
  { stage: "overdue", within: 0, severity: "critical" },
  { stage: "imminent", within: 2 * DAY_MS, severity: "critical" },
  { stage: "approaching", within: 7 * DAY_MS, severity: "high" },
] as const;
export type DeadlineStage = (typeof DEADLINE_STAGES)[number]["stage"];

/** The legal deadline of a statutory refund (a withdrawal, or the EU/UK 14-day full refund); null for every other refund. */
export function statutoryDeadline(op: Pick<RefundOpRow, "kind" | "basis" | "detail" | "created_at" | "decided_at" | "amount_cents">): number | null {
  let detail: Detail = {};
  try { detail = JSON.parse(op.detail ?? "{}") as Detail; } catch { detail = {}; }
  const statutory = op.kind === "withdrawal" || (op.kind === "first_month" && (op.basis === "eu_uk_full_refund" || detail.euUkFull === true));
  if (!statutory || (op.decided_at !== null && (op.amount_cents ?? 0) <= 0)) return null;
  const from = op.kind === "withdrawal" && typeof detail.confirmedAt === "number" ? detail.confirmedAt : op.created_at;
  return from + STATUTORY_REFUND_MS;
}
export function deadlineStage(deadline: number, now: number): (typeof DEADLINE_STAGES)[number] | null {
  return DEADLINE_STAGES.find((s) => deadline - now <= s.within) ?? null;
}

/** The home's ONE open refund.statutory_deadline alert names every held statutory refund within 7 days of its deadline, with its stage. It is
 *  raised, escalated (severity and stage) and re-delivered whenever any operation's stage worsens or the set changes, re-delivered daily
 *  while one is overdue, and resolved once none is left. Statements for the caller's fenced batch. */
async function deadlineAlertStmts(env: Env, homeId: string, now: number): Promise<Q[]> {
  // INTEGRATED-13 P1-1: a refund held by a DISPUTE (a dispute hold, an open, inexact or returning dispute: its last failure says so) is a
  // deadline risk exactly like one held for attribution: the legal clock keeps running while the hold stands.
  const held = (await env.DB.prepare(`SELECT * FROM refund_ops WHERE home_id=? AND done_at IS NULL
      AND (attribution_hold=1 OR last_error IN ${DISPUTE_HELD_CODES}) ORDER BY created_at, id`)
    .bind(homeId).all<RefundOpRow>()).results;
  const rows: Record<string, { opId: string; kind: string; amountCents: number | null; deadline: number; stage: DeadlineStage; heldBy: "attribution" | "dispute" }> = {};
  let worst: (typeof DEADLINE_STAGES)[number] | null = null;
  for (const op of held) {
    const deadline = statutoryDeadline(op);
    const s = deadline === null ? null : deadlineStage(deadline, now);
    if (deadline === null || !s) continue;
    rows[op.id] = { opId: op.id, kind: op.kind, amountCents: op.amount_cents, deadline, stage: s.stage, heldBy: op.attribution_hold === 1 ? "attribution" : "dispute" };
    if (!worst || DEADLINE_STAGES.indexOf(s) < DEADLINE_STAGES.indexOf(worst)) worst = s;
  }
  const open = await env.DB.prepare("SELECT id,detail FROM cloud_alerts WHERE home_id=? AND kind='refund.statutory_deadline' AND resolved_at IS NULL")
    .bind(homeId).first<{ id: string; detail: string }>();
  const ids = Object.keys(rows);
  if (!ids.length || !worst) return open ? [q("UPDATE cloud_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", now, open.id)] : [];
  let prev: Record<string, unknown> = {};
  try { prev = open ? JSON.parse(open.detail) as Record<string, unknown> : {}; } catch { prev = {}; }
  const sig = ids.map((id) => `${id}:${rows[id].stage}`).join(",");
  const repeat = worst.stage === "overdue" && now - (typeof prev.escalatedAt === "number" ? prev.escalatedAt : 0) >= DAY_MS;
  if (open && prev.sig === sig && !repeat) return [];
  const deadline = Math.min(...ids.map((id) => rows[id].deadline));
  const byDispute = ids.some((id) => rows[id].heldBy === "dispute");
  const byAttribution = ids.some((id) => rows[id].heldBy === "attribution");
  const detail = { opId: ids[0], opIds: ids, rows, stage: worst.stage, deadline, sig, escalatedAt: now, canPay: false,
    message: (byAttribution ? `${ids.length === 1 ? "A statutory refund is" : `${ids.length} statutory refunds are`} held because ownership of the Stripe credit note or refund `
      + `cannot be proven (${worst.stage}: legal deadline ${new Date(deadline).toISOString()}). It CANNOT be paid until ownership is proven or repaired; `
      + "the hold clears automatically only once the object our own submission record says we created for it carries its exact amount at Stripe (metadata never proves it). A person must resolve it now." : "")
      + (byDispute ? `${byAttribution ? " " : ""}A statutory refund is held by a payment dispute (${worst.stage}: legal deadline ${new Date(deadline).toISOString()}): `
        + "a dispute hold (see dispute.hold_unattributed / dispute.hold_escalated), an open dispute or a dispute whose amounts are not exact. It is paid automatically once "
        + "the hold is released (its event applied, its charge attributed, or an operator's evidenced close at /v1/admin/dispute-holds/{eventId}/close) or the dispute is decided. A person must resolve it now." : "") };
  if (open) return [q("UPDATE cloud_alerts SET detail=?,severity=?,delivered_at=NULL,delivery_attempts=0 WHERE id=? AND resolved_at IS NULL", JSON.stringify(detail), worst.severity, open.id)];
  return [q("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    `alert:deadline:${homeId}:${crypto.randomUUID()}`, homeId, "refund.statutory_deadline", worst.severity, JSON.stringify(detail), now)];
}

type AttributionProof = { kind: "object"; creditNoteId: string | null; refundId: string; submittedAt: number | null } | { kind: "nothing" } | { kind: "unproven"; why: string };

/** Whether a held operation's objects can be attributed to it: by our retained creation provenance (refund_submission_journal) checked against
 *  Stripe's current state of the object. Never by Stripe metadata, and never by the recorded (disputed) ids alone. */
async function proveAttribution(env: Env, ctx: RefundContext, op: RefundOpRow): Promise<AttributionProof> {
  const quar = await env.DB.prepare("SELECT credit_note_id,stripe_refund_id FROM refund_attribution_quarantine WHERE op_id=?").bind(op.id)
    .first<{ credit_note_id: string | null; stripe_refund_id: string | null }>();
  let detail: Detail;
  try { detail = JSON.parse(op.detail ?? "{}") as Detail; } catch { return { kind: "unproven", why: "detail_unreadable" }; }
  const amount = op.amount_cents ?? 0;
  const decided = op.decided_at !== null && amount > 0 && op.submission >= 1;
  const viaNote = refundsViaCreditNote(op, detail.path);
  const pi = op.payment_intent ?? (op.invoice_id ? (await ctx.stripe.getInvoice(op.invoice_id))?.payment_intent ?? null : null);
  if (!pi) return { kind: "unproven", why: "payment_unresolved" };
  const stamp = (created: number | null | undefined) => typeof created === "number" && created > 0 ? created * 1000 : null;
  // Astra WP3-7 #1: ownership is proven ONLY by our own retained creation provenance: the object's id is the one OUR create call returned for
  // this operation and its current submission (refund_submission_journal). Metadata is mutable (anyone can retag B's object with A's op id):
  // it only helps FIND candidates and never proves anything. Every candidate that names the operation (by metadata or by our journal) and
  // does not prove keeps it held for a person.
  const journal = await journalOf(env, op.id);
  const ours = (id: string, kind: string) => journal.find((j) => j.object_id === id && j.object_kind === kind) ?? null;
  const proven: Extract<AttributionProof, { kind: "object" }>[] = [];
  let naming = 0; // live objects at Stripe that name this operation or that our journal says we made for it
  if (viaNote) {
    const seen = new Map<string, CreditNoteView | null>();
    const recorded = journal.filter((j) => j.object_kind === "credit_note" && j.object_id).map((j) => j.object_id!);
    for (const id of [quar?.credit_note_id, op.credit_note_id, ...recorded]) if (id && !seen.has(id)) seen.set(id, (await ctx.stripe.getCreditNote(id)) ?? null);
    for (const n of (await ctx.stripe.listCreditNotes(op.invoice_id!, { opId: op.id, accept: (x: CreditNoteView) => x.metadata?.op_id === op.id })).data) {
      if (!seen.has(n.id)) seen.set(n.id, n);
    }
    for (const n of seen.values()) {
      if (!n) continue;
      const j = ours(n.id, "credit_note");
      if (!j && (n.status === "void" || n.metadata?.op_id !== op.id)) continue;
      naming++;
      if (!j || !decided || n.status === "void" || j.submission !== op.submission || j.amount_cents !== amount || j.invoice_id !== op.invoice_id
        || n.invoice !== op.invoice_id || !n.refund || !noteSettlesOp({ stripe_refund_id: null }, n, amount)) continue;
      const r = await ctx.stripe.getRefund(n.refund);
      if (!r || (typeof r.amount === "number" && r.amount !== amount) || (r.payment_intent && r.payment_intent !== pi)) continue;
      proven.push({ kind: "object", creditNoteId: n.id, refundId: n.refund, submittedAt: stamp(n.created) });
    }
  } else {
    const seen = new Map<string, RefundView | null>();
    const recorded = journal.filter((j) => j.object_kind === "refund" && j.object_id).map((j) => j.object_id!);
    for (const id of [quar?.stripe_refund_id, op.stripe_refund_id, ...recorded]) if (id && !seen.has(id)) seen.set(id, (await ctx.stripe.getRefund(id)) ?? null);
    for (const r of (await ctx.stripe.listRefunds(pi)).data) if (r.metadata?.op_id === op.id && !seen.has(r.id)) seen.set(r.id, r);
    for (const r of seen.values()) {
      if (!r || r.status === "failed" || r.status === "canceled") continue; // a failed refund pays nothing
      const j = ours(r.id, "refund");
      if (!j && r.metadata?.op_id !== op.id) continue;
      naming++;
      if (!j || !decided || j.submission !== op.submission || j.amount_cents !== amount || (j.payment_intent ?? pi) !== pi
        || (r.payment_intent ?? pi) !== pi || r.amount !== amount) continue;
      proven.push({ kind: "object", creditNoteId: null, refundId: r.id, submittedAt: stamp(r.created) });
    }
  }
  if (proven.length === 1) return proven[0];
  if (proven.length > 1) return { kind: "unproven", why: "several_objects_prove" };
  if (naming > 0) return { kind: "unproven", why: "objects_do_not_prove" };
  // Reconcile the payouts it already held: whatever it was quarantined over must be owned by an operation that proved it.
  const ids = [...new Set([quar?.credit_note_id, quar?.stripe_refund_id, op.credit_note_id, op.stripe_refund_id].filter((x): x is string => !!x))];
  if (ids.length) {
    const owned = await env.DB.prepare(`SELECT COUNT(DISTINCT c.object_id) AS n FROM refund_object_claims c JOIN refund_ops o ON o.id=c.op_id
      WHERE c.object_id IN (${ids.map(() => "?").join(",")}) AND c.op_id<>? AND o.attribution_hold=0`).bind(...ids, op.id).first<{ n: number }>();
    if ((owned?.n ?? 0) !== ids.length) return { kind: "unproven", why: "quarantined_objects_unowned" };
  }
  // Astra WP3-7 #2: "nothing" (released as unpaid, to be submitted) is never inferred from absence. Every submission the operation ever
  // made needs AFFIRMATIVE no-payment evidence from our own journal and a complete Stripe listing (submissionUnpaid); a submission with no
  // journal row (made before it existed) or one Stripe may have honoured keeps the operation held for a person.
  for (let s = 1; s <= op.submission; s++) {
    const j = journal.find((x) => x.submission === s);
    if (!j) return { kind: "unproven", why: "submission_without_provenance" };
    if (!await submissionUnpaid(ctx, j)) return { kind: "unproven", why: "submission_may_have_paid" };
  }
  if (op.submission < 1 && op.submitted_at !== null) return { kind: "unproven", why: "submission_without_provenance" };
  return { kind: "nothing" };
}

/** Repairs the ledger for a proven operation and clears its hold, under the caller's lease. False when it could not be applied (another
 *  home's operation holds the object: a person's job). */
async function releaseAttribution(env: Env, lease: HomeLease, op: RefundOpRow, proof: Exclude<AttributionProof, { kind: "unproven" }>, now: number): Promise<boolean> {
  const own = proof.kind === "object" ? { creditNoteId: proof.creditNoteId, refundId: proof.refundId, submittedAt: proof.submittedAt }
    : { creditNoteId: null, refundId: null, submittedAt: null };
  const ids = [own.creditNoteId, own.refundId].filter((x): x is string => !!x);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const others = (await env.DB.prepare(`SELECT * FROM refund_ops WHERE id<>? AND (id IN (SELECT op_id FROM refund_object_claims WHERE object_id IN (${ph}))
      OR credit_note_id IN (${ph}) OR stripe_refund_id IN (${ph}))`).bind(op.id, ...ids, ...ids, ...ids).all<RefundOpRow>()).results;
    if (others.some((o) => o.home_id !== op.home_id)) return false;
    for (const o of others) {
      // Another operation that recorded this operation's object rests its success on it: quarantined (it never proved it), ops alerted.
      if (o.attribution_hold === 1 && !o.credit_note_id && !o.stripe_refund_id) continue;
      await quarantineOp(env, lease, o, "proven_elsewhere", now);
      const add = await attributionAlertStmts(env, o.home_id, { add: { opId: o.id, detail: { kind: o.kind, error: "attribution_unresolved", provenBy: op.id } } }, now);
      if (add.length) await fencedBatch(env, lease, add);
    }
    // Claims held by operations that did not prove the object are released to the one that did.
    await fencedBatch(env, lease, [q(`DELETE FROM refund_object_claims WHERE object_id IN (${ph}) AND op_id<>?`, ...ids, op.id)]);
  }
  // No saved success survives a release: the sweep reads the (validated) object again before anything is honoured.
  const release = q(`UPDATE refund_ops SET attribution_hold=0,last_error=NULL,attempts=0,next_attempt_at=?,attribution_next_at=NULL,credit_note_id=?,stripe_refund_id=?,
    refund_submitted_at=?,refunded_at=NULL,refund_status=NULL,stripe_refund_status=NULL,note_reconcile=0,updated_at=? WHERE id=? AND attribution_hold=1 AND done_at IS NULL`,
    now, own.creditNoteId, own.refundId, own.submittedAt, now, op.id);
  // Astra WP3-7 #3: the identity's success timestamp is cleared in the SAME fenced transaction as the release (its reservation stays).
  if (!await claimRefundObjects(env, lease, op.id, { creditNoteId: own.creditNoteId, refundIds: [own.refundId] }, now, release,
    [q("UPDATE refund_identity_claims SET refunded_at=NULL WHERE op_id=? AND refunded_at IS NOT NULL AND changes()=1", op.id)])) return false;
  if ((await getRefundOp(env, op.id))?.attribution_hold !== 0) return false;
  await fencedBatch(env, lease, [q("UPDATE refund_attribution_quarantine SET released_at=? WHERE op_id=? AND released_at IS NULL", now, op.id),
    ...await attributionAlertStmts(env, op.home_id, { remove: op.id }, now)]);
  return true;
}

/** INTEGRATED-14 P2: the durable per-home stamp of the deadline monitor's last look (cloud_ops_state `deadline_check:<home>` = ms). */
export const DEADLINE_CHECK_PREFIX = "deadline_check:";
/** The leased, deadline-aware reconciliation of held operations (Astra WP3-6 #4), run by the billing sweep. Also validates the legacy
 *  credit-note successes migration 0070 marked (Astra WP3-6 #2), finished or not. Returns how many holds were cleared. */
export async function reconcileAttributionHolds(env: Env, ctx: RefundContext): Promise<number> {
  const marked = await env.DB.prepare(`SELECT id FROM refund_ops WHERE note_reconcile=1 AND attribution_hold=0 AND COALESCE(next_attempt_at,0)<=?
    ORDER BY COALESCE(next_attempt_at,0), created_at, id LIMIT 50`).bind(ctx.now).all<{ id: string }>();
  for (const r of marked.results) await advanceRefundOp(env, ctx, r.id);
  const due = await env.DB.prepare(`SELECT id, home_id FROM refund_ops WHERE attribution_hold=1 AND done_at IS NULL AND COALESCE(attribution_next_at,0)<=?
    ORDER BY COALESCE(attribution_next_at,0), created_at, id LIMIT 50`).bind(ctx.now).all<{ id: string; home_id: string }>();
  let released = 0; let firstError: unknown = null;
  for (const r of due.results) {
    try {
      await withHomeLease(env, r.home_id, async (lease) => {
        const op = await getRefundOp(env, r.id);
        if (!op || op.attribution_hold !== 1 || op.done_at !== null) return;
        let proof: AttributionProof;
        try { proof = await proveAttribution(env, { ...ctx, lease }, op); }
        catch (e) { if (e instanceof LeaseLost) throw e; proof = { kind: "unproven", why: readFailure(e).code }; }
        if (proof.kind !== "unproven" && await releaseAttribution(env, lease, op, proof, ctx.now)) {
          released++;
          const out = await deadlineAlertStmts(env, op.home_id, ctx.now);
          if (out.length) await fencedBatch(env, lease, out);
          return;
        }
        await fencedBatch(env, lease, [
          q("UPDATE refund_ops SET attribution_next_at=?,updated_at=? WHERE id=? AND attribution_hold=1", ctx.now + ATTRIBUTION_RECHECK_MS, ctx.now, op.id),
          ...await deadlineAlertStmts(env, op.home_id, ctx.now)]);
      }, ctx.lease ?? ctx.deps.lease);
    } catch (e) {
      if (e instanceof HomeBusy || e instanceof LeaseLost) continue;
      firstError ??= e;
    }
  }
  // INTEGRATED-13 P1-1: the deadline alerts of refunds held by a DISPUTE (their own pass may be on a retry backoff of up to six hours, and a
  // hold's outage can last longer): every such home is looked at, and so is every home whose deadline alert is open (to escalate it or
  // resolve it once nothing is held). Bounded, one lease per home.
  // INTEGRATED-14 P2: A FAIR, DURABLE ROTATION. Each home's last look is stamped (cloud_ops_state `deadline_check:<home>` = ms) in the same
  // fenced batch as its alert statements; the pass takes the 50 homes looked at longest ago (never looked at first), so homes with an open
  // alert can never monopolise the pass: N held homes are all looked at within ceil(N / 50) passes, and rechecks rotate.
  const homes = await env.DB.prepare(`SELECT c.home_id FROM (SELECT home_id,MIN(t) AS t FROM (SELECT home_id,MIN(created_at) AS t FROM refund_ops
      WHERE done_at IS NULL AND COALESCE(attribution_hold,0)=0 AND last_error IN ${DISPUTE_HELD_CODES} AND kind IN ('withdrawal','first_month') GROUP BY home_id
    UNION ALL SELECT home_id,raised_at FROM cloud_alerts WHERE kind='refund.statutory_deadline' AND resolved_at IS NULL) GROUP BY home_id) c
    LEFT JOIN cloud_ops_state s ON s.key='${DEADLINE_CHECK_PREFIX}' || c.home_id
    ORDER BY COALESCE(CAST(s.value AS INTEGER),0),c.t,c.home_id LIMIT 50`)
    .all<{ home_id: string }>();
  // INTEGRATED-15 P2: THE CURSOR MOVES PAST EVERY HOME IT REACHED. A home whose lease is held, whose lease was lost or whose look failed
  // gets its stamp too (a plain write, outside the alert batch, which rolled back or never ran): it goes to the back of the rotation
  // instead of keeping its slot, so contention on some homes never starves the others (every home is reached within ceil(N / 50) passes
  // whatever is busy). A look that succeeds still writes its alert statements and its stamp in ONE fenced batch.
  const stamp = `INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  for (const h of homes.results) {
    try {
      await withHomeLease(env, h.home_id, async (lease) => {
        const out = await deadlineAlertStmts(env, h.home_id, ctx.now);
        await fencedBatch(env, lease, [...out, q(stamp, `${DEADLINE_CHECK_PREFIX}${h.home_id}`, String(ctx.now))]);
      }, ctx.lease ?? ctx.deps.lease);
    } catch (e) {
      if (!(e instanceof HomeBusy || e instanceof LeaseLost)) firstError ??= e;
      try { await env.DB.prepare(stamp).bind(`${DEADLINE_CHECK_PREFIX}${h.home_id}`, String(ctx.now)).run(); }
      catch (e2) { firstError ??= e2; }
    }
  }
  // INTEGRATED-15 P3: stamps never accumulate. A home with no monitored obligation (an unfinished statutory refund held by a dispute) and no
  // open deadline alert loses its stamp, at most 50 per pass (a home monitored again later starts as never looked at: first in line).
  try {
    await env.DB.prepare(`DELETE FROM cloud_ops_state WHERE key IN (SELECT s.key FROM cloud_ops_state s
      WHERE s.key>='${DEADLINE_CHECK_PREFIX}' AND s.key<'deadline_check;'
        AND NOT EXISTS (SELECT 1 FROM refund_ops r WHERE r.home_id=substr(s.key,${DEADLINE_CHECK_PREFIX.length + 1}) AND r.done_at IS NULL
          AND COALESCE(r.attribution_hold,0)=0 AND r.last_error IN ${DISPUTE_HELD_CODES} AND r.kind IN ('withdrawal','first_month'))
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=substr(s.key,${DEADLINE_CHECK_PREFIX.length + 1})
          AND a.kind='refund.statutory_deadline' AND a.resolved_at IS NULL)
      ORDER BY s.key LIMIT 50)`).run();
  } catch (e) { firstError ??= e; }
  if (firstError !== null) throw firstError;
  return released;
}

/** Astra JOURNEY-A-3 #4: the ledger operation of the 7-day offer has its own identity, separate from the once-per-customer claim
 *  (first_month_refunds). The account's first operation keeps `firstmonth:<user>`; once that id is held by ANOTHER payment's decided,
 *  zero-value operation (a refusal, which never uses the claim up), a request for this payment gets `firstmonth:<user>:<invoice>` and is
 *  decided on its own, never left outstanding behind an operation nothing will ever advance. Returns the id and the operation there, if any.
 *  Astra JOURNEY-A-4 #4: the ONE allocator, shared by the request route and the reopening of an invalidated refusal (route and sweep). */
export async function firstMonthOpFor(env: Env, userId: string, invoiceId: string | null): Promise<{ id: string; op: RefundOpRow | null }> {
  const baseId = `firstmonth:${userId}`;
  if (!invoiceId) return { id: baseId, op: await getRefundOp(env, baseId) };
  const ownId = `${baseId}:${invoiceId}`;
  const own = await getRefundOp(env, ownId);
  if (own) return { id: ownId, op: own };
  const base = await getRefundOp(env, baseId);
  if (base && base.invoice_id !== invoiceId && base.decided_at !== null && (base.amount_cents ?? 0) === 0) return { id: ownId, op: null };
  return { id: baseId, op: base };
}

/** Astra JOURNEY-A-4 #4: what a recorded refund request froze at its receipt: its payment, that payment's subscription, its consent (an
 *  explicit null included: a request recorded without one never adopts a later consent) and its receipt time. */
export interface RequestSnapshot { pay: PinnedPayment; subscriptionId: string; consentId: string | null; receivedAt: number }

/** The snapshot of the recorded request for a refused payment (refund_requests by account and payment), if one was recorded with it. */
export async function requestSnapshotFor(env: Env, userId: string, invoiceId: string): Promise<RequestSnapshot | null> {
  const r = await env.DB.prepare("SELECT payment_snapshot,subscription_id,consent_id,received_at FROM refund_requests WHERE user_id=? AND payment_key=?")
    .bind(userId, invoiceId).first<{ payment_snapshot: string | null; subscription_id: string | null; consent_id: string | null; received_at: number }>();
  if (!r?.payment_snapshot || !r.subscription_id) return null;
  try {
    const pay = JSON.parse(r.payment_snapshot) as PinnedPayment;
    return pay.invoiceId === invoiceId && pay.paidCents > 0 ? { pay, subscriptionId: r.subscription_id, consentId: r.consent_id, receivedAt: r.received_at } : null;
  } catch { return null; }
}

/** Reopens a 7-day request refused at request time whose refusal no longer stands (Astra ASTRA-REFUND6 #4): a pending first-month
 *  operation dated at the ORIGINAL receipt (its window and credit use are judged as of then), opened exactly as the request route opens
 *  one, under the home's lease. The receipt is closed in the same fenced batch that opens the operation, never on its own before it. A receipt superseded by an operation of the customer's own, or
 *  whose payment is no longer the home's, is closed without one. Returns the operation's id, or null.
 *  Astra JOURNEY-A-4 #4: a refusal of a RECORDED request reopens on that request's snapshot (its payment and subscription, its consent with
 *  an explicit null kept, its receipt time), whether the home still holds that payment or a replacement superseded it; only a home-level
 *  refusal (no request recorded) reads the home's current payment. The operation id comes from the shared invoice-aware allocator
 *  (firstMonthOpFor), never a bare `firstmonth:<user>` that another payment's zero-value decision may hold. */
export async function reopenRefusedRequest(env: Env, ctx: RefundContext, r: RefusalReceipt, snapshot?: RequestSnapshot | null): Promise<string | null> {
  const lease = ctx.lease!;
  const snap = snapshot === undefined ? await requestSnapshotFor(env, r.user_id, r.invoice_id) : snapshot;
  const { id: opId, op: existing } = await firstMonthOpFor(env, r.user_id, r.invoice_id);
  const close = (id: string | null) => fencedRun(env, lease, "UPDATE refund_refusal_receipts SET reopened_at=?,op_id=? WHERE invoice_id=? AND reopened_at IS NULL", ctx.now, id, r.invoice_id);
  if (existing) { await close(existing.id); return existing.invoice_id === r.invoice_id ? existing.id : null; }
  const current = await pinCurrentPayment(env, r.home_id);
  const own = await getSub(env, r.home_id);
  let pinned: PinnedPayment; let subscriptionId: string; let detail: Detail; let receivedAt: number; let endPlan: boolean;
  if (snap && snap.pay.invoiceId === r.invoice_id) {
    pinned = snap.pay; subscriptionId = snap.subscriptionId; receivedAt = snap.receivedAt;
    // A superseded payment's refund never ends the replacement's plan (its own grants are reversed once its money is returned).
    endPlan = current?.invoiceId === r.invoice_id && own?.subscription_id === snap.subscriptionId;
    detail = { pay: snap.pay, consentId: snap.consentId };
  } else {
    if (!current || current.invoiceId !== r.invoice_id || !own?.subscription_id) {
      await refundAlert(env, { id: opId, home_id: r.home_id } as RefundOpRow, "refund.receipt_payment_changed", { invoiceId: r.invoice_id }, ctx.now);
      await close(null); return null;
    }
    pinned = current; subscriptionId = own.subscription_id; receivedAt = r.received_at; endPlan = true;
    // The consent of the pinned payment's own contract is saved with it (Astra LIMITVER-2): a replacement subscription later changes the
    // home's row, and without it the quote could no longer bind the payment to its checkout acceptance.
    detail = { pay: current, ...(own.consent_id ? { consentId: own.consent_id } : {}) };
  }
  const g = crypto.randomUUID();
  try {
    await fencedBatch(env, lease, [
      q(`INSERT INTO first_month_refunds (user_id,home_id,invoice_id,amount_cents,used_credit_cents,created_at) VALUES (?,?,?,0,0,?)
        ON CONFLICT(user_id) DO NOTHING`, r.user_id, r.home_id, r.invoice_id, receivedAt),
      q("INSERT INTO cloud_write_guards VALUES (?,changes())", g),
      refundOpInsert({ id: opId, kind: "first_month", homeId: r.home_id, userId: r.user_id, invoiceId: r.invoice_id, paymentIntent: pinned.paymentIntent,
        subscriptionId, endPlan, detail }, receivedAt),
      q("DELETE FROM cloud_write_guards WHERE id=?", g),
      q("UPDATE refund_refusal_receipts SET reopened_at=?,op_id=? WHERE invoice_id=? AND reopened_at IS NULL", ctx.now, opId, r.invoice_id),
    ]);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    // Closed without an operation ONLY when the customer's once-per-customer slot is confirmed taken (the guard's expected failure):
    // nothing more to pay. Any other failure (a transient database error) propagates and the receipt stays open, so the next sweep or
    // request reopens it; a timely request is never lost (Astra ASTRA-REFUND7 #1).
    if (!await env.DB.prepare("SELECT 1 AS x FROM first_month_refunds WHERE user_id=?").bind(r.user_id).first()) throw e;
    await close(null); return null;
  }
  return opId;
}

/** Billing sweep: every unfinished refund operation that is due. Pending operations are never dropped. Requests refused at request time
 *  whose refusal an erasure invalidated (a recorded event, ASTRA-REFUND7 #3) are reopened first, from their original receipt. Rows still
 *  waiting for their submission date from Stripe (migration 0060) are reconciled next. */
export async function sweepRefundOps(env: Env, ctx: RefundContext): Promise<void> {
  for (const r of await receiptsToRecheck(env)) {
    try {
      await withHomeLease(env, r.home_id, async (lease) => {
        // Reopened only on a recorded invalidation event (Astra ASTRA-REFUND7 #3); re-read under the lease (a request may have reopened it).
        const open = await refusalReceiptFor(env, r.invoice_id);
        if (open && await refusalReceiptReopenable(env, open, false)) await reopenRefusedRequest(env, { ...ctx, lease }, open);
      }, ctx.deps.lease);
    } catch (e) { if (!(e instanceof HomeBusy || e instanceof LeaseLost)) throw e; }
  }
  await reconcileRefundSubmissions(env, ctx);
  await reconcileAttributionHolds(env, ctx); // Astra WP3-6 #4: a hold never blocks an owed refund for ever
  const due = await env.DB.prepare("SELECT id FROM refund_ops WHERE done_at IS NULL AND COALESCE(next_attempt_at,0)<=? ORDER BY COALESCE(next_attempt_at,0) LIMIT 50")
    .bind(ctx.now).all<{ id: string }>();
  for (const r of due.results) await advanceRefundOp(env, ctx, r.id);
}

/** Open operations for a home (an invoice that arrives late resumes them at once). */
export async function resumeRefundOpsFor(env: Env, ctx: RefundContext, homeId: string): Promise<void> {
  const open = await env.DB.prepare("SELECT id FROM refund_ops WHERE home_id=? AND done_at IS NULL").bind(homeId).all<{ id: string }>();
  for (const r of open.results) await advanceRefundOp(env, ctx, r.id);
}
