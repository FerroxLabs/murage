// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP3: the refund kinds the hosted checkout adds to the refund ledger (legal-refunds.ts), the amount rule they share, and the
// one renderer of "Your refund" (plan §4.2 refund states, §5.3(2a)). Pure functions; no database, no Stripe.
//
// Three things are kept apart (plan §4.2):
//   SUBMITTED  the Stripe refund (direct: its credit note) exists; `refund_submitted_at` is the only date we promise;
//   SUCCEEDED  Stripe reports the refund as succeeded: our processor's state, so copy says "processed", never "confirmed";
//   AT THE BANK  not visible to us (Stripe says about 5 to 10 business days); copy says so and never promises arrival.
// A failed or canceled refund is none of those: copy says "delayed; we are trying again" and the ledger alerts ops.

export const CHECKOUT_REFUND_KINDS = ["mismatch", "country_paused", "rejected_consent", "cutover", "cancellation_late", "extraordinary"] as const;
export type CheckoutRefundKind = (typeof CHECKOUT_REFUND_KINDS)[number];
export const isCheckoutRefundKind = (kind: string): kind is CheckoutRefundKind => (CHECKOUT_REFUND_KINDS as readonly string[]).includes(kind);
/** Refusal kinds older than the checkout kinds (Astra DROPDOWN-DIRECT-2 (2)): a second order for one consent, and its payment clearing later.
 *  Opened with an explicit direct path they refund like every other direct refusal, through a credit note; without a path (opened before
 *  the path was recorded, or not a checkout order) they keep POST /v1/refunds. */
export const PATHED_REFUSAL_KINDS = ["duplicate", "late_payment"] as const;
/** Every kind that may refund through a credit note (the importer reconciles notes on invoices of these kinds). */
export const CREDIT_NOTE_KINDS: readonly string[] = [...CHECKOUT_REFUND_KINDS, ...PATHED_REFUSAL_KINDS];
/** The refund instrument of one operation: a credit note (refund_amount, Stripe Tax reverses the tax with it) for a direct invoice, POST
 *  /v1/refunds otherwise (Managed Payments has no credit notes). One rule for the ledger, the attribution check and the importer. */
export function refundsViaCreditNote(op: { kind: string; invoice_id: string | null }, path: unknown): boolean {
  if (op.invoice_id === null || path === "mp") return false;
  return isCheckoutRefundKind(op.kind) || ((PATHED_REFUSAL_KINDS as readonly string[]).includes(op.kind) && path === "direct");
}

/** Kinds that refund the whole invoice they are opened for (fraction 1). */
export const FULL_REFUND_KINDS: readonly CheckoutRefundKind[] = ["mismatch", "country_paused", "rejected_consent", "cancellation_late"];
/** Kinds whose fraction comes from FROZEN values (cutover_at, old_period_start, old_period_end on the operation): the unused part of a paid period. */
export const FROZEN_FRACTION_KINDS: readonly CheckoutRefundKind[] = ["cutover", "extraordinary"];

/** The frozen values of a pro-rata refund, written once when the operation is opened and never read from anywhere else. */
export interface FrozenPeriod { cutoverAt: number | null; oldPeriodStart: number | null; oldPeriodEnd: number | null }

/** `(old_period_end - cutover_at) / (old_period_end - old_period_start)` clamped to [0, 1], as an integer pair; null when a frozen value is
 *  missing or the period is not a period (the operation then waits, and ops hears about it). */
export function unusedFraction(f: FrozenPeriod): { num: number; den: number } | null {
  const { cutoverAt, oldPeriodStart, oldPeriodEnd } = f;
  if (cutoverAt === null || oldPeriodStart === null || oldPeriodEnd === null) return null;
  if (![cutoverAt, oldPeriodStart, oldPeriodEnd].every(Number.isFinite) || oldPeriodEnd <= oldPeriodStart) return null;
  const den = oldPeriodEnd - oldPeriodStart;
  return { num: Math.min(den, Math.max(0, oldPeriodEnd - cutoverAt)), den };
}

/** API amount = round(invoice.amount_paid × fraction) in USD cents. amount_paid already includes tax; tax is never added on top. */
export const apiAmountCents = (amountPaidCents: number, num: number, den: number): number =>
  den > 0 && amountPaidCents > 0 ? Math.round(amountPaidCents * num / den) : 0;

/** A cancellation_late operation opened for a straddling renewal carries all three frozen values. */
export const isStraddle = (f: FrozenPeriod): boolean => f.cutoverAt !== null && f.oldPeriodStart !== null && f.oldPeriodEnd !== null;

/** The amount a checkout refund kind targets for an invoice that was paid `amountPaidCents`; null when a pro-rata kind has no usable frozen values. */
export function checkoutRefundTarget(kind: CheckoutRefundKind, amountPaidCents: number, frozen: FrozenPeriod): number | null {
  // WP8 r3 (Astra WP8-3 #3): a late renewal that straddles the legal end is opened with its period frozen (cutover = the end): only the
  // part after the end is refunded. Without frozen values it is the whole invoice, as before.
  if (kind === "cancellation_late" && isStraddle(frozen)) { const f = unusedFraction(frozen); return f ? apiAmountCents(amountPaidCents, f.num, f.den) : null; }
  if (FULL_REFUND_KINDS.includes(kind)) return Math.max(0, amountPaidCents);
  const f = unusedFraction(frozen);
  return f ? apiAmountCents(amountPaidCents, f.num, f.den) : null;
}

// ---- The refund line ---------------------------------------------------------------------------------------------------------------

export type RefundPath = "direct" | "mp";
export type RefundLineStatus = "being_prepared" | "sent" | "processed" | "delayed";
/** The fields of a refund operation the renderer reads. */
export interface RefundStateFields { refund_submitted_at: number | null; stripe_refund_status: string | null; refunded_at: number | null; attempts: number; done_at: number | null;
  /** 1 while the operation is held because its Stripe objects cannot be attributed to it alone (migration 0070). Optional so older callers compile. */
  attribution_hold?: number | null }
/** Alert threshold of the ledger (3 failed attempts): the same point at which copy stops saying "being prepared". */
export const DELAYED_AFTER_ATTEMPTS = 3;

/** Where an operation stands, in the words of the site contract (C3 `Refund`): never "confirmed", never a bank promise. */
export function refundState(op: RefundStateFields, path: RefundPath): { status: RefundLineStatus; date?: number; path: RefundPath } {
  // A held operation is never "processed" (Astra WP3-6 #3): a success webhook can record Stripe's state on one refund of a split note while
  // the operation itself is held. The hold takes precedence over every success signal.
  if (op.attribution_hold === 1) return { status: "delayed", path };
  if (op.stripe_refund_status === "failed" || op.stripe_refund_status === "canceled") return { status: "delayed", path };
  if (op.stripe_refund_status === "succeeded" || op.refunded_at !== null) return { status: "processed", ...(op.refunded_at !== null ? { date: op.refunded_at } : {}), path };
  if (op.refund_submitted_at !== null) return { status: "sent", date: op.refund_submitted_at, path };
  if (op.done_at === null && op.attempts >= DELAYED_AFTER_ATTEMPTS) return { status: "delayed", path };
  return { status: "being_prepared", path };
}

/** A UTC date for customer copy: "2026-10-11 (UTC)". */
export const utcDate = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)} (UTC)`;

/** "Your refund: ..." (plan §5.3(2a), strings copied from the plan). The Managed Payments wording appears on the managed path only. */
export function refundLine(op: RefundStateFields, lang: "en" | "de", path: RefundPath): string {
  const s = refundState(op, path);
  const d = s.date !== undefined ? utcDate(s.date) : "";
  if (lang === "de") {
    const body = s.status === "being_prepared" ? "wird vorbereitet"
      : s.status === "sent" ? (path === "mp" ? `am ${d} an Ihren Zahlungsanbieter gesendet` : `am ${d} gesendet`)
        : s.status === "processed" ? `am ${d} verarbeitet; Ihre Bank kann 5 bis 10 Werktage brauchen, bis sie sichtbar ist`
          : "verzögert; wir versuchen es erneut";
    return `Ihre Erstattung: ${body}.`;
  }
  const body = s.status === "being_prepared" ? "being prepared"
    : s.status === "sent" ? (path === "mp" ? `sent to your payment provider on ${d}` : `sent on ${d}`)
      : s.status === "processed" ? `processed on ${d}; your bank may take 5 to 10 business days to show it`
        : "delayed; we are trying again";
  return `Your refund: ${body}.`;
}
