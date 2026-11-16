// SPDX-License-Identifier: AGPL-3.0-or-later
// The member-facing refusal: what a customer is told when the checkout guard turned an order away (checkout-moments.ts guardVerdict:
// mismatch, country_paused, rejected_consent). rejectOrder (b5-billing.ts) marks the consent rejected, refunds and cancels; this reads that
// record back for GET /v1/account/home and GET /v1/account/order, so the site never shows "confirming your payment" for a refused order.
import { isRejectKind, type RejectKind } from "./checkout-moments";

export type Refused = {
  kind: RejectKind;
  /** The country the customer declared (the path), else their billing country. */
  declared: string | null;
  /** The country Stripe collected, ISO-2 uppercase; null when the order was refused without one (or before it was stored). */
  collected: string | null;
  /** The refund of this order: pending (opened, not yet sent), sent (every part has left), none (nothing was charged). */
  refund: "pending" | "sent" | "none";
  /** When the guard turned the order away, ms. */
  at: number;
};

export interface RefundRow { amount_cents: number | null; target_cents: number | null; paid_cents: number | null; refunded_at: number | null; done_at: number | null }

interface RefusedConsent { id: string; home_id: string; declared_country: string | null; billing_country: string | null; rejected_at: number | null;
  rejected_reason: string | null; rejected_collected_country: string | null; stripe_subscription_id: string | null }

const COLUMNS = "amount_cents,target_cents,paid_cents,refunded_at,done_at";

/** The refunds of ONE order, money-bearing or not yet decided (a decided zero is no refund): the one lookup behind both refused.refund and
 *  reconcileOrder. An operation belongs to the order when its detail names the consent (rejectOrder writes it) or when it is on the order's
 *  own subscription only when it names no consent at all (a legacy operation); an operation stamped with another consent never matches here. For a refused order only the refund of that refusal's kind counts. Never matched by home alone. */
export async function orderRefunds(env: Env, homeId: string, consentId: string | null, subId: string | null, kind: string | null = null): Promise<RefundRow[]> {
  if (consentId === null && subId === null) return [];
  const rows = await env.DB.prepare(`SELECT ${COLUMNS} FROM refund_ops WHERE home_id=? AND (? IS NULL OR kind=?)
    AND ((? IS NOT NULL AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.consentId') END = ?)
      OR (? IS NOT NULL AND (subscription_id=? OR cancel_subscription_id=?) AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.consentId') END IS NULL))`)
    .bind(homeId, kind, kind, consentId, consentId, subId, subId, subId).all<RefundRow>();
  return rows.results.filter((r) => { const a = r.amount_cents ?? r.target_cents ?? r.paid_cents; return a === null ? r.done_at === null : a > 0; });
}

/** refused for one consent: null unless the guard turned that order away. */
async function refusedOf(env: Env, consent: RefusedConsent | null): Promise<Refused | null> {
  if (!consent || consent.rejected_at === null || consent.rejected_reason === null || !isRejectKind(consent.rejected_reason)) return null;
  const refunds = await orderRefunds(env, consent.home_id, consent.id, consent.stripe_subscription_id, consent.rejected_reason);
  const refund = refunds.length === 0 ? "none" : refunds.every((r) => r.refunded_at !== null) ? "sent" : "pending";
  return { kind: consent.rejected_reason, declared: consent.declared_country ?? consent.billing_country ?? null,
    collected: consent.rejected_collected_country ? consent.rejected_collected_country.toUpperCase() : null, refund, at: consent.rejected_at };
}

/** How long a refusal stays on the account's pages after the guard turned the order away. */
export const REFUSED_VISIBLE_MS = 7 * 86_400_000;

/** refused for an account (it can have no home at all): its LATEST checkout consent decides (created_at, then id). Null when that consent is
 *  not rejected (a newer checkout), when the refusal is older than 7 days, and when the account PAID after the refusal: another consent paid or
 *  contracted after this one's rejected_at, or a home whose own first payment came after it. A payment before the rejection never hides it. */
export async function refusedForAccount(env: Env, userId: string, now: number): Promise<Refused | null> {
  const latest = await env.DB.prepare("SELECT * FROM checkout_consents WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 1").bind(userId).first<RefusedConsent & { created_at: number }>();
  if (!latest || latest.rejected_at === null || now - latest.rejected_at > REFUSED_VISIBLE_MS) return null;
  const paid = await env.DB.prepare(`SELECT 1 AS x FROM checkout_consents WHERE user_id=? AND id<>? AND rejected_at IS NULL AND COALESCE(paid_at,contract_made_at)>?
    UNION ALL SELECT 1 FROM billing_subscriptions s JOIN cloud_homes h ON h.id=s.home_id WHERE h.owner_id=? AND h.desired_state<>'deleted' AND s.first_paid_at>? LIMIT 1`)
    .bind(userId, latest.id, latest.rejected_at, userId, latest.rejected_at).first();
  return paid ? null : refusedOf(env, latest);
}
