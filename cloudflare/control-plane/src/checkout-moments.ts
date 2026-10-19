// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP5: the three moments of an order, the deadlines they start, the guard's verdict and the customer emails of the
// completion step (STRIPE-HOSTED-PLAN r13c §1.1, §3.3, §4.1, §4.4). Pure functions; no database, no Stripe.
//
//   completed_at  the customer submitted the Stripe page ("We got your order"): contract made, payment may still be pending
//                 -> statutory_withdraw_until
//   paid_at       payment_status=paid, or the later async_payment_succeeded ("Payment received")
//                 -> provisioning, service_start_at, guarantee_withdraw_until, refund7_until
//   service_start_at  the server starts at payment in this build (every server starts at payment): equal to paid_at.
// Deadlines are inclusive days ending 23:59:59 UTC-12 (AoE). Each is written once and never moved.

import { RENEWAL_FIELD_KEY, RENEWAL_OPTION_VALUE, stripePageProvenance } from "./checkout-strings";

const HOUR_MS = 3_600_000;
export const DAY = 86_400_000;
/** UTC-12: the last place on Earth to reach a calendar day. */
export const AOE_OFFSET_MS = 12 * HOUR_MS;

/** AoE end (23:59:59 UTC-12) of date(ms) + days, where date(ms) is the UTC calendar date of the moment. */
export function aoeEnd(ms: number, days: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 23, 59, 59) + AOE_OFFSET_MS;
}
/** The calendar date a deadline is shown as ("2026-10-25"): the AoE day it ends. */
export const aoeDate = (endMs: number): string => new Date(endMs - AOE_OFFSET_MS).toISOString().slice(0, 10);

// ---- The renewal authorization (plan §3.2, owner decision 2026-10-14, option 1) ---------------------------------------------------
// The authorization is the customer's press on our clickwrap page under the server-verified renewal sentence, journaled in checkout_consents
// (recurring_authorized=1, the exact renewalText, versions, client info) BEFORE the Stripe session exists. Every session names that record
// (metadata consent_id), the sentence (metadata renewal_sha256), the price (metadata price_id) and the seller (metadata seller). Stripe's page:
//  - direct: no dropdown; the renewal sentence (cadence, price + tax, how to end it) is always visible above the Pay button (custom_text);
//  - Managed Payments: the required one-option dropdown, its label carrying the statement. Such a session needs BOTH the answer and the record.
// TRANSITION (Astra DROPDOWN-DIRECT-1 (1)): missing metadata alone NEVER downgrades the check. A session is judged by the old rule (the one
// offered option answered, the metadata naming this home's consent) only when ALL of these hold: it carries the dropdown and no renewal hash,
// the consent it names has NO Stripe-page provenance in its archive (prepareConsent records the variant and version with every consent
// since this change, and a reissue is refused unless the archived page is the one we would send: members-api stripePageStands, so
// only a consent written by the pre-change code lacks it), and Stripe created the session before LEGACY_SESSION_CUTOFF_S. Anything else
// with missing metadata is judged by the record (consentRefusal) and refused.

export { RENEWAL_FIELD_KEY, RENEWAL_OPTION_VALUE };

const meta = (session: Record<string, unknown>): Record<string, unknown> =>
  session.metadata && typeof session.metadata === "object" ? session.metadata as Record<string, unknown> : {};
const nonEmpty = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;

/** The answer in the session's `custom_fields` to the renewal dropdown, or null when the field is missing or not answered. Anything but the
 *  one option the server offered is not consent. */
export function renewalAnswer(session: Record<string, unknown>): string | null {
  const fields = Array.isArray(session.custom_fields) ? session.custom_fields as Record<string, unknown>[] : [];
  const f = fields.find((x) => x && x.key === RENEWAL_FIELD_KEY);
  const dd = f && typeof f.dropdown === "object" && f.dropdown ? f.dropdown as Record<string, unknown> : null;
  return dd && typeof dd.value === "string" && dd.value ? dd.value : null;
}
/** The session carries the renewal dropdown (Managed Payments now, either path before 2026-10-14). */
export const hasRenewalDropdown = (session: Record<string, unknown>): boolean =>
  Array.isArray(session.custom_fields) && (session.custom_fields as Record<string, unknown>[]).some((x) => x && x.key === RENEWAL_FIELD_KEY);
/** The deployment cutoff of the 2026-10-14 change (Stripe's `created`, in seconds): only a session Stripe created before it can be a
 *  pre-change session. FROZEN at the staging deployment hour, 2026-10-14T16:00:00Z (Astra DROPDOWN-DIRECT-2 (3)). This is the deployment
 *  cutoff and must NOT move: a later deploy never re-opens the legacy window. An old-code session after it fails closed (refused, refunded). */
export const LEGACY_SESSION_CUTOFF_S = Date.UTC(2026, 9, 14, 16, 0, 0) / 1000;
/** A session issued by the pre-change code, positively identified (see TRANSITION above): the dropdown and no renewal hash, the named
 *  consent without Stripe-page provenance, and created before the cutoff. Judged by the old rule. */
export const isLegacySession = (session: Record<string, unknown>, b: Pick<ConsentBinding, "consent">): boolean =>
  nonEmpty(meta(session).renewal_sha256) === null && hasRenewalDropdown(session)
  && b.consent !== null && stripePageProvenance(b.consent.disclosure) === "absent"
  && typeof session.created === "number" && Number.isFinite(session.created) && session.created < LEGACY_SESSION_CUTOFF_S;
/** The dropdown's shape alone (any locale): the key, whatever the answer. Never decides legacy by itself (isLegacySession). */
export const hasLegacyRenewalDropdown = hasRenewalDropdown;

/** One line item of the session as Stripe reports it (GET /v1/checkout/sessions/{id}/line_items), normalized. */
export interface SessionLineItem { priceId: string | null; currency: string | null; interval: string | null; intervalCount: number | null;
  quantity: number | null; unitAmount: number | null }
/** What the webhook knows when it checks the journaled consent against the completed session. */
export interface ConsentBinding {
  /** The consent the session's metadata names, when it is this home's (null otherwise: refused). */
  consent: { id: string; home_id: string; user_id: string; recurring_authorized?: number | null; renewal_text: string; plan: string; created_at: number;
    price_cents: number; stripe_price_id?: string | null; stripe_session_id?: string | null;
    /** The archived disclosure (JSON): its `stripePage` is the issuance provenance (archivedStripePage). */
    disclosure?: string | null } | null;
  /** The home the session resolved to, and its owner (the account that pressed our button). */
  homeId: string; ownerId: string | null;
  /** The seller the consent was sold on (seller.ts sellerOfConsent: "ferrox" direct, "link" Managed Payments). */
  consentSeller: "ferrox" | "link";
  /** The Stripe price configured for the consent's plan (used when the consent has no stored stripe_price_id). */
  configuredPriceId: string | null;
  /** The session's REAL line items, read from Stripe (null: not read, refused). */
  lineItems: SessionLineItem[] | null;
  /** sha256 hex of a renewalText (disclosure-token.ts renewalSha256). */
  sha256: (text: string) => string;
}
/** The reason a session is not covered by its consent record, or null when it is. Every rule must hold:
 *  - the metadata consent id is a checkout_consents row of the SAME home, made by the home's owner, with recurring_authorized=1, and the
 *    session is the one bound to it (stripe_session_id, written when the session was created or reissued);
 *  - metadata.renewal_sha256 equals sha256 of the renewalText frozen with that consent (what the customer saw above our button);
 *  - the seller path the session was made for (metadata.seller) is the consent's;
 *  - the REAL Stripe line item is exactly one of the price the consent was sold at (stripe_price_id, else the configured price of its plan),
 *    quantity 1, monthly, in USD, at the consent's price; metadata plan and price agree;
 *  - the consent was written before the session was created (consent created_at, in ms, no later than the session's `created` second);
 *  - Managed Payments: the dropdown answered with the one offered option. Direct: no dropdown at all (our server never sends one there). */
export function consentRefusal(session: Record<string, unknown>, b: ConsentBinding): string | null {
  const c = b.consent;
  if (!c) return "consent_not_this_home";
  const m = meta(session);
  if (nonEmpty(m.consent_id) !== c.id || c.home_id !== b.homeId) return "consent_not_this_home";
  // A present but unreadable Stripe-page archive proves no issuance (Astra DROPDOWN-DIRECT-2 (3)): refused, never legacy, never accepted.
  if (stripePageProvenance(c.disclosure) === "invalid") return "provenance_invalid";
  if (!b.ownerId || c.user_id !== b.ownerId) return "consent_other_account";
  if (c.recurring_authorized !== 1) return "recurring_not_authorized";
  if (!nonEmpty(session.id) || c.stripe_session_id !== session.id) return "session_not_bound";
  const hash = nonEmpty(m.renewal_sha256);
  if (!hash || typeof c.renewal_text !== "string" || hash !== b.sha256(c.renewal_text)) return "renewal_text_mismatch";
  if (nonEmpty(m.seller) !== b.consentSeller) return "seller_mismatch";
  const expectedPrice = c.stripe_price_id ?? b.configuredPriceId;
  if (!expectedPrice || nonEmpty(m.plan) !== c.plan || nonEmpty(m.price_id) !== expectedPrice) return "plan_mismatch";
  const items = b.lineItems;
  if (!items || items.length !== 1) return "line_items_mismatch";
  const [li] = items;
  if (li.priceId !== expectedPrice || li.quantity !== 1 || li.interval !== "month" || (li.intervalCount ?? 1) !== 1
    || (li.currency ?? "").toLowerCase() !== "usd" || li.unitAmount !== c.price_cents) return "line_items_mismatch";
  const created = typeof session.created === "number" && Number.isFinite(session.created) ? session.created : null;
  if (created === null || typeof c.created_at !== "number" || Math.floor(c.created_at / 1000) > created) return "consent_after_session";
  if (b.consentSeller === "link" ? renewalAnswer(session) !== RENEWAL_OPTION_VALUE : hasRenewalDropdown(session)) return "dropdown_rule";
  return null;
}
export const consentAuthorizes = (session: Record<string, unknown>, b: ConsentBinding): boolean => consentRefusal(session, b) === null;
/** The renewal authorization of a completed session: a positively identified pre-change session (isLegacySession) by the old rule
 *  (answered, its metadata naming this home's consent); every other session by the consent record (consentRefusal), which on Managed
 *  Payments includes the answer. */
export const renewalAuthorized = (session: Record<string, unknown>, b: ConsentBinding): boolean =>
  isLegacySession(session, b) ? renewalAnswer(session) === RENEWAL_OPTION_VALUE : consentAuthorizes(session, b);

// ---- The guard (plan §1.1) --------------------------------------------------------------------------------------------------------

export type RejectKind = "rejected_consent" | "mismatch" | "country_paused";
export const REJECT_KINDS: readonly RejectKind[] = ["rejected_consent", "mismatch", "country_paused"];
export const isRejectKind = (k: string): k is RejectKind => (REJECT_KINDS as readonly string[]).includes(k);

export interface GuardInput {
  /** The renewal authorization holds (renewalAuthorized: the consent record, or the legacy dropdown answer). */
  authorized: boolean;
  /** Stripe's collected billing country, and the one the customer declared on our page. */
  collectedCountry: string | null; declaredCountry: string | null;
  /** The path (seller) of the consent covers the collected country. */
  pathCoversCountry: boolean;
  /** The kill switch for the declared country, read now: it can have been paused after the session was created. */
  declaredCountryPaused: boolean;
}
/** The first rule that turns the order down, or null. Order: the renewal authorization, then declared = billing and path, then the paused country. */
export function guardVerdict(i: GuardInput): RejectKind | null {
  if (!i.authorized) return "rejected_consent";
  const c = i.collectedCountry?.trim().toUpperCase() || null;
  const d = i.declaredCountry?.trim().toUpperCase() || null;
  if (!c || !d || c !== d || !i.pathCoversCountry) return "mismatch";
  if (i.declaredCountryPaused) return "country_paused";
  return null;
}

// ---- Deadlines (plan §4.1) --------------------------------------------------------------------------------------------------------

export interface Deadlines { statutoryWithdrawUntil: number | null; guaranteeWithdrawUntil: number | null; refund7Until: number | null }
/** What each moment writes. `resident`: the billing country is in CONSUMER_WITHDRAWAL_COUNTRIES (the statutory right and the 14-day
 *  guarantee exist only for them); the 7-day refund is for everyone.
 *   - statutory_withdraw_until: AoE end of date(completed_at)+14, written at order acceptance, even if payment is pending;
 *   - guarantee_withdraw_until: original purchase AoE end of date(service_start_at)+14; replacement for a running server date(paid_at)+14;
 *   - refund7_until: AoE end of date(service_start_at)+7. */
export function deadlinesFor(i: { resident: boolean; completedAt: number; paidAt: number | null; serviceStartAt: number | null; replacement: boolean }): Deadlines {
  const start = i.replacement ? i.paidAt : (i.serviceStartAt ?? i.paidAt);
  return {
    statutoryWithdrawUntil: i.resident ? aoeEnd(i.completedAt, 14) : null,
    guaranteeWithdrawUntil: i.resident && start !== null ? aoeEnd(start, 14) : null,
    refund7Until: (i.serviceStartAt ?? i.paidAt) !== null ? aoeEnd((i.serviceStartAt ?? i.paidAt)!, 7) : null,
  };
}

/** The last moment of the 7-day refund offer for a payment. Astra JOURNEY-B-1 #8: ALWAYS the latest of the three, never one instead of
 *  another: the consent's frozen refund7_until (written once with the paid moment; it can only grow), the payment's own AoE rule
 *  (aoeEnd(paidAt, 7): a frozen value inherited from an earlier start never hides a later payment) and the server-ready rule
 *  (aoeEnd(readyAt, 7)). A consent from before 0061 has none frozen: the payment rule (never a fixed 168 hours; Astra WP5-1 #5). */
export const refund7Deadline = (frozen: number | null | undefined, paidAt: number, readyAt: number | null = null): number =>
  Math.max(frozen ?? 0, aoeEnd(paidAt, 7), readyAt !== null ? aoeEnd(readyAt, 7) : 0);
/** B3, the ONE refund-clock rule every check uses (the summary, the first-month quote, the refund request, the refusal): the 7 days run from the
 *  LATER of the first payment and the day the server is ready (the ready email's handoff, readyAnchorSql; Astra JOURNEY-B-2 #6), and never end before the
 *  consent's frozen deadline (refund7Deadline). Before the server is ready the deadline is not known yet: endsAt null and startsWhenReady true,
 *  and the window is open. Astra JOURNEY-B-1 #9: "ready" is decided by persistent evidence only, never by the mutable lifecycle state: a
 *  ready_at, or ready_legacy (a home that was ready before ready_at existed, marked once by migration 0094; it keeps the payment-based
 *  deadline). A home with neither has never been ready, whatever its state now (failed, stopped, deleting): its window stays open. */
export function refundWindow(frozen: number | null | undefined, paidAt: number,
  home: { ready_at: number | null; ready_legacy: number | null; ready_anchor?: number | null } | null): { endsAt: number | null; startsWhenReady: boolean } {
  // Astra JOURNEY-B-2 #6: the ready moment is the successful HANDOFF of the ready email (readyAnchorSql), when the row carries it.
  const ready = home && home.ready_anchor !== undefined ? home.ready_anchor : home?.ready_at ?? null;
  if (home && ready === null && (home.ready_legacy !== 1 || home.ready_at !== null)) return { endsAt: null, startsWhenReady: true };
  return { endsAt: refund7Deadline(frozen, paidAt, ready), startsWhenReady: false };
}
/** Astra JOURNEY-B-2 #6: the refund clock's ready moment for the cloud_homes row aliased `h`: when the "your server is ready" email
 *  (billing_notices server_ready:<home>:first) was successfully handed to the sender (its sent_at). Queued but not handed off yet (sent_at
 *  NULL): NULL, so the window stays open (startsWhenReady) however long that takes, and the frozen deadline grows at the handoff
 *  (b5-billing.ts sendNotice). A home ready before the email existed (no such notice; ready_at backfilled by migration 0094): its ready_at. */
export const readyAnchorSql = (h: string): string => `CASE WHEN EXISTS (SELECT 1 FROM billing_notices rn WHERE rn.id='server_ready:'||${h}.id||':first')
  THEN (SELECT rn.sent_at FROM billing_notices rn WHERE rn.id='server_ready:'||${h}.id||':first') ELSE ${h}.ready_at END`;
/** The last moment of the EU/UK full refund (Decision A: within 14 days of the server's start, the deadlines frozen on the consent): the later of
 *  statutory_withdraw_until and guarantee_withdraw_until, as withdrawal uses them. A consent from before 0061: AoE end of date(payment)+14. */
export const euUkFullDeadline = (c: { statutory_withdraw_until?: number | null; guarantee_withdraw_until?: number | null }, paidAt: number): number =>
  (c.statutory_withdraw_until ?? null) !== null || (c.guarantee_withdraw_until ?? null) !== null
    ? Math.max(c.statutory_withdraw_until ?? 0, c.guarantee_withdraw_until ?? 0) : aoeEnd(paidAt, 14);

/** A consent's withdrawal deadlines as availability, the displayed date and the full refund all use them (Astra WP5-2 #3). Stored deadlines
 *  win. A consent from before 0061 has neither stored: the SAME AoE fallback everywhere, statutory = AoE end of date(contract)+14 and, once
 *  the consent's own payment is known (paid_at), the guarantee = AoE end of date(paid_at)+14 (the date euUkFullDeadline grants the refund
 *  to). An unpaid legacy consent has no guarantee date yet (withdrawalOpen counts it unbounded while the server has not started). */
export function withdrawalDeadlines(c: { statutory_withdraw_until: number | null; guarantee_withdraw_until: number | null; contract_made_at: number | null; completed_at: number;
  paid_at?: number | null }): { statutory: number; guarantee: number | null; legacy: boolean } {
  if (c.statutory_withdraw_until !== null || c.guarantee_withdraw_until !== null) {
    return { statutory: c.statutory_withdraw_until ?? aoeEnd(c.contract_made_at ?? c.completed_at, 14), guarantee: c.guarantee_withdraw_until, legacy: false };
  }
  return { statutory: aoeEnd(c.contract_made_at ?? c.completed_at, 14), guarantee: c.paid_at !== null && c.paid_at !== undefined ? aoeEnd(c.paid_at, 14) : null, legacy: true };
}
/** The withdrawal date shown to the customer: the later of the two deadlines (withdrawalDeadlines). */
export const withdrawalEndsAt = (c: Parameters<typeof withdrawalDeadlines>[0]): number => {
  const d = withdrawalDeadlines(c);
  return Math.max(d.statutory, d.guarantee ?? 0);
};

/** Withdrawal is open while now <= max(statutory_withdraw_until, guarantee_withdraw_until), the guarantee counting as unbounded while
 *  the server has not started (payment or provisioning pending or failed). A consent from before 0061 has no stored deadline: the same AoE
 *  fallback as the full refund (withdrawalDeadlines, from the consent's own paid_at), never a fixed +336 hours (Astra WP5-2 #3). */
export function withdrawalOpen(c: { statutory_withdraw_until: number | null; guarantee_withdraw_until: number | null; contract_made_at: number | null; completed_at: number;
  paid_at?: number | null }, serviceStartAt: number | null, now: number): boolean {
  const d = withdrawalDeadlines(c);
  const guarantee = d.guarantee ?? (serviceStartAt === null ? Infinity : -Infinity);
  return now <= Math.max(d.statutory, guarantee);
}

// ---- Emails (plan §1.1, §3.3, §4.4) ------------------------------------------------------------------------------------------------

/** English and German per string. The plan has no German for most of them: `de: null` is a launch gate (BUILD-PLAN §D), never a translation.
 *  A null German falls back to English. */
export interface Words { en: string; de: string | null }
export const ORDER_WORDS = {
  orderReceivedUnpaid: { en: "We got your order. Your server starts as soon as your payment clears.", de: "Wir haben Ihre Bestellung erhalten. Ihr Server startet, sobald die Zahlung eingeht." },
  orderReceivedPaid: { en: "We got your order. Payment received: your server is starting.", de: "Wir haben Ihre Bestellung erhalten. Zahlung eingegangen: Ihr Server startet." },
  paymentReceived: { en: "Payment received. Your server is starting.", de: "Zahlung eingegangen. Ihr Server startet." },
  paymentReceivedSubject: { en: "Murage Cloud: payment received", de: "Murage Cloud: Zahlung eingegangen" },
  orderSubject: { en: "Murage Cloud: we got your order", de: "Murage Cloud: Bestellung erhalten" },
  // The rejection emails (plan §1.1): what happened, then what happened to the money (rejectedRefunding + the WP3 ledger's refund line, or
  // rejectedUnpaid), then what to do next. Never "we refunded" before the ledger says so (Astra WP5-1 #8).
  mismatch: { en: "The billing address you entered ({country}) doesn't match the country you chose ({declared}), so your order was cancelled. {money} Press Continue to payment on your account page and pick the right country.", de: "Die eingegebene Rechnungsadresse ({country}) passt nicht zu dem Land, das Sie gewählt haben ({declared}). Deshalb wurde Ihre Bestellung storniert. {money} Drücken Sie „Weiter zur Zahlung“ auf Ihrer Kontoseite und wählen Sie das richtige Land." },
  mismatchSubject: { en: "Murage Cloud: your billing country doesn't match", de: "Murage Cloud: Ihr Rechnungsland passt nicht" },
  countryPaused: { en: "We can't take orders from {country} right now, so your order was cancelled. {money} We'll email you when we can.", de: "Aus {country} nehmen wir derzeit keine Bestellungen an. Deshalb wurde Ihre Bestellung storniert. {money} Wir schreiben Ihnen, sobald es geht." },
  countryPausedSubject: { en: "Murage Cloud: we can't take orders from {country} right now", de: "Murage Cloud: Bestellungen aus {country} derzeit nicht möglich" },
  // 2026-10-14: no dropdown on Stripe's page any more; the refusal means the journaled authorization did not match this order (or, for a
  // session from before the change, its dropdown was not answered). Same sentence shape as orderNotFinished; German to be reviewed with it.
  rejectedConsent: { en: "We could not confirm your monthly renewal for this order, so it was cancelled. {money} You can start again from your account page.", de: "Wir konnten die monatliche Verlängerung für diese Bestellung nicht bestätigen. Deshalb wurde sie storniert. {money} Sie können auf Ihrer Kontoseite neu starten." },
  rejectedConsentSubject: { en: "Murage Cloud: your order was cancelled", de: "Murage Cloud: Ihre Bestellung wurde storniert" },
  // A paid order we could not finish on our side (its acceptance record could not be recovered within 24 hours): cancelled and refunded.
  orderNotFinished: { en: "We could not finish your order on our side, so it was cancelled. {money} You can start again from your account page.", de: "Wir konnten Ihre Bestellung auf unserer Seite nicht abschließen. Deshalb wurde sie storniert. {money} Sie können auf Ihrer Kontoseite neu starten." },
  rejectedRefunding: { en: "We are refunding your payment in full. {refund}", de: "Wir erstatten Ihre Zahlung vollständig. {refund}" },
  rejectedUnpaid: { en: "Your payment had not gone through, so nothing was charged. If it still goes through, we refund it in full.", de: "Ihre Zahlung war nicht durchgegangen, es wurde also nichts abgebucht. Geht sie doch noch durch, erstatten wir sie vollständig." },
  // "Payment received" (plan §3.3, §4.4): rendered from the deadlines stored with the paid moment and Stripe's renewal date.
  paymentWithdrawUntil: { en: "You can withdraw from the contract until the end of {date} (anywhere on Earth).", de: "Sie können den Vertrag bis zum Ende des {date} widerrufen (in jeder Zeitzone)." },
  paymentRefund7Until: { en: "You can ask for the 7-day refund until the end of {date}.", de: "Die 7-Tage-Erstattung können Sie bis zum Ende des {date} verlangen." },
  paymentRenewsOn: { en: "Your plan renews on {date}.", de: "Ihr Plan verlängert sich am {date}." },
  paymentFailed: { en: "Your payment did not go through, so your order was cancelled and nothing was charged. You can start again from your account page.", de: "Ihre Zahlung ist nicht durchgegangen. Deshalb wurde Ihre Bestellung storniert, und es wurde nichts abgebucht. Sie können auf Ihrer Kontoseite neu starten." },
  paymentFailedSubject: { en: "Murage Cloud: your payment did not go through", de: "Murage Cloud: Ihre Zahlung ist nicht durchgegangen" },
} as const satisfies Record<string, Words>;
export type OrderWord = keyof typeof ORDER_WORDS;
/** Every order string that still has no German (a launch gate: Sean has them written and reviewed before release). */
export const MISSING_DE: readonly OrderWord[] = (Object.keys(ORDER_WORDS) as OrderWord[]).filter((k) => ORDER_WORDS[k].de === null);

export function orderWords(key: OrderWord, lang: string | null | undefined, vars: Record<string, string> = {}): string {
  const w: Words = ORDER_WORDS[key];
  const raw = lang === "de" && w.de !== null ? w.de : w.en;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
