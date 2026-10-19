// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP6: the billing-address change and the replacement checkout (STRIPE-HOSTED-PLAN r13d §1.3, §3.3 replacement rows, §4.1).
// Pure functions; no database, no Stripe.
//
//   address change   a new billing country is checked for PATH COVERAGE only (the kill switch is never read here: it stops new and
//                    replacement purchases, never a running subscription, its renewals or its address changes)
//                      covered by the current path   -> declared_country follows; nothing else
//                      the other path covers it       -> cancel_at_period_end + an `address_change` retry route + Email A
//                      no path covers it              -> cancel_at_period_end + an `address_change` route with seller NONE_SELLER + Email B
//   replacement      ownership moves only on confirmed payment (paid_at: payment_status=paid, or async_payment_succeeded), never on completion.
//   The Managed Payments (Link) side of an address change is untested in the sandbox: the same check is built for it and flagged (MP_ADDRESS_SYNC_UNVERIFIED).
import { sellerCovers, sellerFor, type SellerKind, type SellerSettings } from "./seller";
import { apiAmountCents, unusedFraction } from "./refund-kinds";
import { DAY } from "./checkout-moments";

/** The `seller` column of a route that no path can serve (Email B): the plan simply ends. */
export const NONE_SELLER = "none";
/** Link syncs a changed billing address to the customer only as Link decides: whether `customer.updated` reaches us on the MP path is not
 *  verified in the sandbox (plan §0). The backstop at invoice.created covers either path with the same check. */
export const MP_ADDRESS_SYNC_UNVERIFIED = true;
/** How long a route outlives the old plan's period end, so a customer who pays just after the old plan ended is still a replacement. */
export const ROUTE_GRACE_MS = 7 * DAY;

export type Coverage = { kind: "unknown" } | { kind: "covered" } | { kind: "other_path"; seller: SellerKind } | { kind: "uncovered" };
/** Is `country` covered by the path the running subscription was sold through (the seller recorded with its consent)? A malformed or
 *  missing country is "unknown": a renewal of an existing contract is never touched on a guess (the new-order guard fails closed; this does not).
 *  The RETAINED seller's coverage decides (sellerCovers), never new-purchase routing: only when it no longer covers the country is another
 *  seller chosen, by the routing a new purchase from there would get (WP6 r1-3). */
export function pathCoverage(settings: SellerSettings, current: SellerKind, country: string | null | undefined): Coverage {
  const c = country?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(c)) return { kind: "unknown" };
  if (sellerCovers(settings, current, c)) return { kind: "covered" };
  let wanted: SellerKind;
  try { wanted = sellerFor(settings, c); } catch { return { kind: "uncovered" }; }
  return wanted === current ? { kind: "uncovered" } : { kind: "other_path", seller: wanted };
}

/** The route's end: the old period end (or now) plus the grace. */
export const routeExpiresAt = (periodEnd: number | null, now: number): number => Math.max(periodEnd ?? 0, now) + ROUTE_GRACE_MS;

/** A route that lets a replacement checkout through `already_subscribed`: an `address_change` route, unexpired, naming THIS subscription, with a path that can sell. */
export interface RetryRoute { account_id: string; seller: string; collected_country: string; reason: string; replaces_subscription_id: string | null; expires_at: number }
export const routeIsValid = (r: RetryRoute | null | undefined, currentSubscriptionId: string | null, now: number): r is RetryRoute =>
  !!r && r.reason === "address_change" && r.seller !== NONE_SELLER && r.replaces_subscription_id !== null && r.replaces_subscription_id === currentSubscriptionId && r.expires_at > now;

/** What the old plan's unused days are worth, from the FROZEN values only: { days, cents } or null when nothing is owed. */
export function cutoverEstimate(paidCents: number, f: { cutoverAt: number; oldPeriodStart: number; oldPeriodEnd: number }): { days: number; cents: number } | null {
  const frac = unusedFraction(f);
  if (!frac || frac.num <= 0) return null;
  const cents = apiAmountCents(paidCents, frac.num, frac.den);
  return cents > 0 ? { days: Math.ceil(frac.num / DAY), cents } : null;
}
/** The FROZEN cutover boundary of a replaced subscription (table replacement_cutovers, written in the cutover batch even when nothing is
 *  owed): the payment time of the replacement and the old invoice whose service period covered it (null when none did). */
export interface CutoverBoundary { cutoverAt: number; oldInvoiceId: string | null }
/** An old-plan invoice judged against the frozen boundary, never against when its event arrives (Stripe reorders and duplicates events):
 *    frozen        the invoice the cutover refund was computed on (that operation owns it)
 *    served        its period ended at or before the cutover: the old plan served it, nothing is owed
 *    unserved      its period starts at or after the cutover: never served by the old plan, refunded in full
 *    overlap       its period spans the cutover but it is not the frozen invoice (paid after the cutover was frozen): the unused fraction
 *    unclassified  no readable service period: never refunded by default, ops is told */
export type ReplacedInvoiceClass = "frozen" | "served" | "unserved" | "overlap" | "unclassified";
export function classifyReplacedInvoice(b: CutoverBoundary, inv: { id: string; periodStart: number | null; periodEnd: number | null }): ReplacedInvoiceClass {
  if (b.oldInvoiceId !== null && inv.id === b.oldInvoiceId) return "frozen";
  const { periodStart: s, periodEnd: e } = inv;
  if (s === null || e === null || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return "unclassified";
  if (e <= b.cutoverAt) return "served";
  if (s >= b.cutoverAt) return "unserved";
  return "overlap";
}
/** The invoice to freeze for a cutover at `paidAt`: the one whose service period covers paidAt (start <= paidAt < end), never simply the one
 *  with the greatest period end (an old renewal charged while the replacement was being processed is a later period, refunded on its own). */
export function invoiceCoveringPaidAt<T extends { start: number; end: number }>(candidates: readonly T[], paidAt: number): T | null {
  let best: T | null = null;
  for (const c of candidates) if (c.start <= paidAt && paidAt < c.end && (!best || c.start > best.start)) best = c;
  return best;
}
export const usd = (cents: number): string => `US$${(cents / 100).toFixed(2)}`;
/** The amount as the recipient's price line writes it: "US$12.00" (en), "12,00 US$" (de, as in the German price line). */
export const usdFor = (cents: number, lang: string | null | undefined): string =>
  lang === "de" ? `${(cents / 100).toFixed(2).replace(".", ",")} US$` : usd(cents);

// ---- Customer words (plan §1.3 Email A and Email B from r4, §1.3 steps 2 and 4, r4 step 7) -----------------------------------------------

/** English and German per string. The plan has no German for any of them: `de: null` is a launch gate (BUILD-PLAN §D), never a translation. */
export interface Words { en: string; de: string | null }
export const REPLACEMENT_WORDS = {
  addressChangeA: { en: "Your billing address is now in {country}, so a different company has to take your payments: {payee}. Press Continue to payment on your account page before {periodEnd}. You won't pay twice: we refund the unused days of your current plan.", de: "Ihre Rechnungsadresse liegt jetzt in {country}. Deshalb muss ein anderes Unternehmen Ihre Zahlungen entgegennehmen: {payee}. Drücken Sie vor dem {periodEnd} „Weiter zur Zahlung“ auf Ihrer Kontoseite. Sie zahlen nicht doppelt: Wir erstatten die ungenutzten Tage Ihres aktuellen Plans." },
  addressChangeASubject: { en: "Murage Cloud: your billing address changed", de: "Murage Cloud: Ihre Rechnungsadresse hat sich geändert" },
  addressChangeB: { en: "Your billing address is now in {country}. We can't take payments there yet, so your plan ends on {periodEnd}. Your server keeps running until then. We'll email you when we can.", de: "Ihre Rechnungsadresse liegt jetzt in {country}. Dort können wir noch keine Zahlungen entgegennehmen, deshalb endet Ihr Plan am {periodEnd}. Ihr Server läuft bis dahin weiter. Wir schreiben Ihnen, sobald es geht." },
  addressChangeBSubject: { en: "Murage Cloud: we can't take payments from {country} yet", de: "Murage Cloud: Zahlungen aus {country} noch nicht möglich" },
  payeeLink: { en: "Link (by Stripe)", de: "Link (by Stripe)" },
  payeeDirect: { en: "Ferrox Labs directly", de: "Ferrox Labs direkt" },
  replacementUnpaid: { en: "We got your order. We'll switch your plan as soon as your payment clears.", de: "Wir haben Ihre Bestellung erhalten. Wir stellen Ihren Plan um, sobald die Zahlung eingeht." },
  replacementUnpaidSubject: { en: "Murage Cloud: we got your order", de: "Murage Cloud: Bestellung erhalten" },
  replacementFailed: { en: "Your payment didn't go through, so your plan is unchanged and still ends on {periodEnd}. Press Continue to payment to try again.", de: "Ihre Zahlung ist nicht durchgegangen. Ihr Plan bleibt unverändert und endet weiterhin am {periodEnd}. Drücken Sie „Weiter zur Zahlung“, um es erneut zu versuchen." },
  replacementFailedSubject: { en: "Murage Cloud: your payment didn't go through", de: "Murage Cloud: Ihre Zahlung ist nicht durchgegangen" },
  replacementDone: { en: "Your new payment method is set up. Your refund of {amount} for the {days} unused days of your old plan is being prepared (once it is sent it can take 5–10 days to show).", de: "Ihre neue Zahlungsmethode ist eingerichtet. Ihre Erstattung von {amount} für die {days} ungenutzten Tage Ihres alten Plans wird vorbereitet (nach dem Versand kann es 5–10 Tage dauern, bis sie sichtbar ist)." },
  replacementDoneNoRefund: { en: "Your new payment method is set up. Your old plan had no unused days left to refund.", de: "Ihre neue Zahlungsmethode ist eingerichtet. Ihr alter Plan hatte keine ungenutzten Tage mehr zu erstatten." },
  replacementDoneSubject: { en: "Murage Cloud: your plan is switched", de: "Murage Cloud: Ihr Plan ist umgestellt" },
} as const satisfies Record<string, Words>;
export type ReplacementWord = keyof typeof REPLACEMENT_WORDS;
/** Every WP6 string that still has no German (a launch gate: Sean has them written and reviewed before release). */
export const MISSING_DE_REPLACEMENT: readonly ReplacementWord[] = (Object.keys(REPLACEMENT_WORDS) as ReplacementWord[]).filter((k) => REPLACEMENT_WORDS[k].de === null);

/** The {periodEnd} stand-in when Stripe gives no period end. Reads after "vor dem" and "am" alike (vor dem Ende / am Ende). */
export function periodEndFallback(lang: string | null | undefined): string {
  return lang === "de" ? "Ende des bezahlten Zeitraums" : "the end of the period you paid for";
}

export function replacementWords(key: ReplacementWord, lang: string | null | undefined, vars: Record<string, string> = {}): string {
  const w: Words = REPLACEMENT_WORDS[key];
  const raw = lang === "de" && w.de !== null ? w.de : w.en;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
