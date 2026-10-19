// SPDX-License-Identifier: AGPL-3.0-or-later
// What the Murage Cloud legal documents promise, as code (plans/cloud-legal/CHECKOUT.md in the site repo):
//  - the checkout wording, word for word, priced by the server (Stripe Tax) BEFORE the boxes are ticked, and the consent record;
//  - the document versions shown, archived as immutable text, and the re-acceptance when they change;
//  - the three moments of an order (completed_at, paid_at, service start) and the deadlines they start (WP5);
//  - the auto top-up authorization (applied to Flux auto-recharge through B4);
//  - the durable confirmation email (built only from the archived versions accepted) and the yearly renewal reminder;
//  - the first-month refund amount (one ledger with the withdrawal refund, legal-refunds.ts);
//  - the export request that pauses the day-14 deletion, once per deletion cycle.
// Pure text/date helpers first, then the D1 helpers. HTTP lives in legal-routes.ts.
import { fencedBatch, fencedRun, q, type HomeLease, type Q } from "./billing-lease";
import { z } from "zod";
import { LEGAL_DOCS, type LegalDoc } from "./legal-docs.generated";
import { DAY_MS, PLAN_MONTHLY_USD, PLANS, RETENTION_MS, type Plan } from "./b5-config";
import { b3Config, b3Enabled } from "./b3-config";
import { HTTPError } from "./http";
import { DISPUTE_RETURNED_SQL } from "./dispute-sql";
import type { StripeClient } from "./b5-stripe";
import { firstPaymentCheck, refundLimitAccepted, retentionCutoff } from "./refund-identity";
import { MANAGED_PATH, MANAGED_QUOTE_SOURCE, DIRECT_PATH, NOT_REGISTERED_REASONS, sellerOfConsent, SUBMIT_TEXT_VARIANT, type SellerKind } from "./seller";
import { buttonWordsFor, checkoutLocale, isConsumerWithdrawalCountry } from "./checkout-policy";
import { aoeDate, aoeEnd, readyAnchorSql, refundWindow } from "./checkout-moments";
import { REPLACEMENT_WORDS } from "./checkout-replacement";
import { langOf, renderDisclosure, stringsFor, stripePageOf, topupTotalPhrase, topupWording, type Lang } from "./checkout-strings";

/** Bump when any wording below changes; it is logged with every consent so the exact screen can be reconstructed. */
// .3 (WP4 r2-1): every consent recorded before r2 (including the pre-r1 r13 rows without start_request_text) is stale for reuse.
// .4 (WP4 x WP5 merge): the combined screen (WP5's start-at-payment wording plus WP4's r2 snapshot); every earlier consent is stale.
// .5 (2026-10-12, owner-approved): the 7-day first-month refund wording is now "full refund, nothing deducted for used credits"; every earlier consent is stale.
// .6 (2026-10-12, B3 refund clock): the refund line counts from "the day your server is ready" (was "starts"), and the renewal text's refund
//    sentence with it (REFUND-CLOCK-AND-DOWNGRADE-WORDING.md (b), (e)); every earlier consent is stale.
export const SCREEN_VERSION = "checkout-clickwrap-2026-10-11.6";
export const WITHDRAWAL_WINDOW_MS = 14 * DAY_MS;
export const REFUND_WINDOW_MS = 7 * DAY_MS;
export const EXPORT_PAUSE_MAX_MS = 7 * DAY_MS;
/** Yearly renewal reminder goes out this long before each anniversary (inside the 15 to 45 day ARL window). */
export const RENEWAL_REMINDER_LEAD_MS = 30 * DAY_MS;
/** A changed document applies to an existing customer only after this notice and a fresh acceptance. */
export const TERMS_NOTICE_MS = 30 * DAY_MS;
export const TAX_QUOTE_TTL_MS = 30 * 60_000;

/** EU 27, EEA (Iceland, Liechtenstein, Norway) and the UK. Switzerland is not in the CHECKOUT.md list. */
export const EU_REGION_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB",
] as const;
const EU_SET: ReadonlySet<string> = new Set(EU_REGION_COUNTRIES);
export const isEuRegion = (country: string) => EU_SET.has(country.toUpperCase());

export const PLAN_NAMES: Record<Plan, string> = { starter: "Starter", pro: "Pro", max: "Max" };

export const TOPUP_DEFAULTS = { amountUsd: 20, thresholdUsd: 5, capUsd: 100 } as const;
export const TOPUP_CAP_PERIOD = "calendar month";
export const TOPUP_CAP_RESETS = "00:00 UTC on the first day of each month";

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- Wording (CHECKOUT.md, verbatim) -------------------------------------------------------------------------------------

export const WORDING = {
  terms: "I have read and agree to the Murage Cloud terms, the Terms of Service and the Privacy Policy",
  reaccept: "I have read and agree to the updated Murage Cloud terms, the Terms of Service and the Privacy Policy",
  authorization: "I authorize Ferrox Labs, LLC to charge my payment method for this monthly subscription until I cancel.",
  arbitration: "Disputes go to individual arbitration, not class actions, unless you are a consumer in the EU, EEA, UK or Switzerland. "
    + "You can opt out within 30 days of ticking this box: email privacy@murage.ai.",
  earlyStart: "Start my service before the 14-day withdrawal period ends. If I withdraw, I understand I may pay proportionately "
    + "for service actually supplied, subject to the 7-day refund offer.",
  nearEarlyStart: "If you buy as a consumer in the EU, EEA or UK and want your server right away, tick the start-now box.",
  // {amount}, {threshold}, {cap} and {total} are filled in with the numbers on the screen.
  topupBox: "Top up my Flux credits automatically: add ${amount} whenever my balance falls below ${threshold}, up to a monthly cap of ${cap}. "
    + "I can change the amount or the cap, or turn this off, at any time.",
  topupCharge: "When my Flux balance falls below ${threshold}, I authorize Ferrox Labs, LLC to charge my payment method ${total} "
    + "for ${amount} of Flux credits, up to ${cap} per calendar month. The cap resets at 00:00 UTC on the first day of each month. "
    + "It covers automatic top-up charges only, not my plan or manual purchases.",
} as const;

export interface TopupNumbers { amount: number; threshold: number; cap: number; totalCents?: number | null }
/** The charge for one top-up: the total including tax Stripe Tax priced. The bare amount appears only on the screen before a quote exists,
 *  and no consent can be given until there is one. */
export const topupTotalText = (v: TopupNumbers) => typeof v.totalCents === "number"
  ? `${usd(v.totalCents)} including tax` : `$${v.amount} plus tax where it applies`;
const fill = (template: string, v: TopupNumbers) => template.replaceAll("${total}", topupTotalText(v))
  .replaceAll("${amount}", `$${v.amount}`).replaceAll("${threshold}", `$${v.threshold}`).replaceAll("${cap}", `$${v.cap}`);
export const topupBoxText = (v: TopupNumbers) => fill(WORDING.topupBox, v);
export const topupChargeText = (v: TopupNumbers) => fill(WORDING.topupCharge, v);

export function renewalBase(plan: Plan, priceUsd: number = PLAN_MONTHLY_USD[plan]): string {
  return `${PLAN_NAMES[plan]} renews monthly at US$${priceUsd} plus applicable tax, charged on the same day each month until you cancel. `
    + RENEWAL_TAIL;
}
/** CHECKOUT.md (MurageSite, 2026-10-10): the bold head names the currency charged today; then the cancel and refund promises. */
const RENEWAL_TAIL = "Cancel any time from your account page, with one click and no call or email. Your server runs to the end of the month you paid for. "
  + "Ask within 7 days of the day your server is ready and we refund your first month in full.";
const FX_LINE = "If you pay in another currency, renewal amounts may change with exchange rates.";

/** The "I authorize [payment collector] to charge" box (CHECKOUT.md: Ferrox Labs, LLC in the US; Link (by Stripe), which takes payment for
 *  Ferrox Labs, outside the US). Ferrox Labs is the seller everywhere; Link is merchant of record on its behalf, never "the seller". */
export const authorizationFor = (seller: SellerKind) =>
  `I authorize ${seller === "link" ? MANAGED_PATH.chargeName : DIRECT_PATH.chargeName} to charge my payment method for this monthly subscription until I cancel.`;
/** Shown above the pay button for a Link (Managed Payments) buyer, verbatim from CHECKOUT.md. */
export const LINK_SELLER_LINE = "Ferrox Labs sells and provides Murage Cloud. Outside the US, Link (by Stripe) takes your payment as merchant of record for us, adds local tax where it handles that tax, and sends your receipt. Murage provides the service and support.";

const scheduleText = (s: Schedule) =>
  `Your service starts today, ${isoDate(s.startAt)}. Your first charge is today, and your next charge is ${isoDate(s.nextChargeAt)}.`;

/** The renewal statement for a Link (Managed Payments) buyer. Link prices the tax and, with Adaptive Pricing (always on), may charge in local
 *  currency; neither is known before Link's own page, so no total in a currency the customer may not pay in is stated here. Link shows the
 *  total including tax, in the charge currency, before payment; the confirmation email repeats the amount and currency actually charged. */
export function renewalStatementManaged(plan: Plan, s: Schedule): string {
  return `${renewalHeadManaged(plan, s)} ${RENEWAL_TAIL} ${scheduleText(s)}`;
}
const renewalHeadManaged = (plan: Plan, s: Schedule) =>
  `${PLAN_NAMES[plan]} renews monthly at US$${PLAN_MONTHLY_USD[plan]} plus applicable tax, charged by Link (by Stripe), which takes payment for Ferrox Labs, on the same day each month until you cancel. `
  + "Today's total, including tax and in the currency you pay in, is shown on Link's payment page before you pay. "
  + FX_LINE;
export function renewalBaseManaged(plan: Plan): string {
  return `${PLAN_NAMES[plan]} renews monthly at US$${PLAN_MONTHLY_USD[plan]} plus applicable tax, charged by Link (by Stripe), which takes payment for Ferrox Labs, on the same day each month until you cancel. ${FX_LINE} ${RENEWAL_TAIL}`;
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Stripe's zero-decimal currencies: their amounts are whole units (https://docs.stripe.com/currencies#zero-decimal). */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** An amount in the currency Stripe charged it in (minor units), e.g. "45.20 EUR"; USD keeps the "$45.20" form. */
export function moneyIn(minor: number, currency: string | null | undefined): string {
  const cur = (currency ?? "usd").toLowerCase();
  if (cur === "usd") return usd(minor);
  return `${ZERO_DECIMAL.has(cur) ? String(minor) : (minor / 100).toFixed(2)} ${cur.toUpperCase()}`;
}
/** Same day next month in UTC; the 31st clamps to the end of a shorter month (what Stripe does for a monthly anchor). */
export function addMonthUtc(ms: number, months = 1): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.getTime();
}

export interface Schedule { startAt: number; firstChargeAt: number; nextChargeAt: number }
/** Every server starts at payment (r13): the start is now, never a later date. */
export function scheduleFor(now: number): Schedule {
  const startAt = now;
  return { startAt, firstChargeAt: startAt, nextChargeAt: addMonthUtc(startAt) };
}

/** The tax view a renewal statement is priced with: a Stripe Tax quote. Without one there is no statement and no checkout. */
export interface TaxView { priceCents: number; taxCents: number; totalCents: number }
export const taxViewOf = (q: TaxQuoteRow | null): TaxView | null =>
  q && q.source === "stripe_tax" && q.tax_cents !== null && q.total_cents !== null ? { priceCents: q.price_cents, taxCents: q.tax_cents, totalCents: q.total_cents } : null;

/** The renewal statement shown directly above the main checkbox and logged word for word. "Due today" is kept apart from the recurring total. */
export function renewalStatement(plan: Plan, s: Schedule, tax: TaxView): string {
  const today = tax.totalCents;
  const head = `${PLAN_NAMES[plan]} renews monthly at US$${PLAN_MONTHLY_USD[plan]} plus applicable tax, charged on the same day each month until you cancel. `
    + `Today's total is ${usd(today)} in USD. ${FX_LINE}`;
  const money = `Total including tax: ${usd(tax.totalCents)} a month (${usd(tax.priceCents)} plus ${usd(tax.taxCents)} tax).`
    ;
  return `${head} ${RENEWAL_TAIL} ${scheduleText(s)} ${money}`;
}

/** The numbers a top-up text is filled with before any quote exists: the cap never sits below the amount. */
export function topupNumbers(amountUsd: number, siteLocale: string | null | undefined) {
  return { amount: amountUsd, threshold: TOPUP_DEFAULTS.thresholdUsd, cap: Math.max(TOPUP_DEFAULTS.capUsd, amountUsd), totalText: topupTotalPhrase(siteLocale, amountUsd) };
}

export const currentVersions = () => ({ cloudTerms: LEGAL_DOCS.cloudTerms.versionId, termsOfService: LEGAL_DOCS.termsOfService.versionId,
  privacyPolicy: LEGAL_DOCS.privacyPolicy.versionId });

/** `opts` (the r13 GET /v1/legal/disclosure only): the site locale and top-up amount the server-owned top-up wording is filled for. */
export function buildDisclosure(plan: Plan, now: number, quote: TaxQuoteRow | null = null, opts?: { siteLocale?: string | null; topupAmountUsd?: number }) {
  const tax = taxViewOf(quote);
  const managed = quote?.source === MANAGED_QUOTE_SOURCE;
  const seller: SellerKind = managed ? "link" : "ferrox";
  const variant = () => {
    const s = scheduleFor(now);
    return { startDate: isoDate(s.startAt), firstChargeDate: isoDate(s.firstChargeAt), nextChargeDate: isoDate(s.nextChargeAt),
      renewalText: managed ? renewalStatementManaged(plan, s) : tax ? renewalStatement(plan, s, tax) : null,
      dueTodayCents: tax ? tax.totalCents : null };
  };
  return {
    screenVersion: SCREEN_VERSION,
    versions: currentVersions(),
    plan, planName: PLAN_NAMES[plan], priceUsd: PLAN_MONTHLY_USD[plan],
    euCountries: EU_REGION_COUNTRIES,
    variants: { immediate: variant() },
    wording: { ...WORDING, authorization: authorizationFor(seller), ...(opts ? topupWording(opts.siteLocale, topupNumbers(opts.topupAmountUsd ?? TOPUP_DEFAULTS.amountUsd, opts.siteLocale)) : {}) },
    // Who sells (seller.ts). A Link buyer sees the merchant-of-record line, and automatic top-up is not offered: a Managed Payments
    // subscription only authorizes Link to charge it, so Ferrox cannot charge that payment method for top-ups.
    seller, sellerLine: managed ? LINK_SELLER_LINE : null, topupAvailable: !managed,
    topupDefaults: { ...TOPUP_DEFAULTS, capPeriod: TOPUP_CAP_PERIOD, capResets: TOPUP_CAP_RESETS },
    tax: quote ? { quoteId: quote.id, source: quote.source, country: quote.country, postalCode: quote.postal_code, priceCents: quote.price_cents,
      taxCents: quote.tax_cents, totalCents: quote.total_cents, topupAmountCents: quote.topup_amount_cents, topupTaxCents: quote.topup_tax_cents,
      topupTotalCents: quote.topup_total_cents, expiresAt: quote.expires_at } : null,
  };
}

// ---- Tax quote (Stripe Tax Calculations, before consent) ----------------------------------------------------------------------

export interface TaxQuoteRow { id: string; user_id: string; plan: string; country: string; postal_code: string | null; price_cents: number;
  tax_cents: number | null; total_cents: number | null; topup_amount_cents: number; topup_tax_cents: number | null; topup_total_cents: number | null;
  source: string; calculation_id: string | null; created_at: number; expires_at: number }
export const getTaxQuote = (env: Env, id: string) => env.DB.prepare("SELECT * FROM tax_quotes WHERE id=?").bind(id).first<TaxQuoteRow>();
const normPostal = (p: string | undefined | null) => (p ?? "").trim().toUpperCase() || null;

/** Prices the plan and the top-up amount at the customer's address through Stripe Tax. If Stripe Tax fails this throws 409 tax_unavailable:
 *  there is no checkout without a quote. A fresh identical quote is reused (Stripe Tax is billed). */
export async function createTaxQuote(env: Env, stripe: StripeClient, i: { userId: string; plan: Plan; country: string; postalCode?: string | null;
  topupAmountCents: number }, now: number): Promise<TaxQuoteRow> {
  const country = i.country.toUpperCase(); const postal = normPostal(i.postalCode); const price = PLAN_MONTHLY_USD[i.plan] * 100;
  const reuse = await env.DB.prepare(`SELECT * FROM tax_quotes WHERE user_id=? AND plan=? AND country=? AND COALESCE(postal_code,'')=? AND topup_amount_cents=?
      AND source='stripe_tax' AND expires_at>? ORDER BY created_at DESC LIMIT 1`).bind(i.userId, i.plan, country, postal ?? "", i.topupAmountCents, now + 5 * 60_000)
    .first<TaxQuoteRow>();
  if (reuse) return reuse;
  let row: TaxQuoteRow = { id: `quote-${crypto.randomUUID()}`, user_id: i.userId, plan: i.plan, country, postal_code: postal, price_cents: price,
    tax_cents: null, total_cents: null, topup_amount_cents: i.topupAmountCents, topup_tax_cents: null, topup_total_cents: null,
    source: "stripe_tax", calculation_id: null, created_at: now, expires_at: now + TAX_QUOTE_TTL_MS };
  try {
    const calc = await stripe.createTaxCalculation({ country, postalCode: postal ?? undefined,
      lines: [{ reference: `plan_${i.plan}`, amountCents: price }, { reference: "flux_topup", amountCents: i.topupAmountCents }] });
    // Outside the US a direct sale needs Ferrox's own registration there: Stripe Tax answering "not_collecting" (zero because the seller is not
    // registered) is a missing registration, not a non-taxable sale, and is never quoted as zero tax.
    if (country !== "US" && (calc.tax_breakdown ?? []).some((b) => NOT_REGISTERED_REASONS.has(b.taxability_reason ?? ""))) throw new Error("not_registered");
    const items = calc.line_items?.data ?? [];
    const planTax = items.find((l) => l.reference === `plan_${i.plan}`)?.amount_tax;
    const topupTax = items.find((l) => l.reference === "flux_topup")?.amount_tax;
    // Without per-line tax the total tax is split by amount (both lines carry the same rate at one address).
    const total = calc.tax_amount_exclusive;
    const pTax = typeof planTax === "number" ? planTax : Math.round(total * price / (price + i.topupAmountCents));
    const tTax = typeof topupTax === "number" ? topupTax : total - pTax;
    row = { ...row, tax_cents: pTax, total_cents: price + pTax, topup_tax_cents: tTax, topup_total_cents: i.topupAmountCents + tTax,
      source: "stripe_tax", calculation_id: calc.id };
  } catch { throw new HTTPError(409, "tax_unavailable"); } // no quote, no checkout: the page says to try again in a moment
  await env.DB.prepare(`INSERT INTO tax_quotes (id,user_id,plan,country,postal_code,price_cents,tax_cents,total_cents,topup_amount_cents,topup_tax_cents,
      topup_total_cents,source,calculation_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.user_id, row.plan, row.country, row.postal_code, row.price_cents, row.tax_cents, row.total_cents, row.topup_amount_cents,
      row.topup_tax_cents, row.topup_total_cents, row.source, row.calculation_id, row.created_at, row.expires_at).run();
  return row;
}

/** A Link (Managed Payments) checkout's quote: no Stripe Tax calculation (Link computes and is liable for the tax on its own page), only
 *  the record that this plan, country and postal code were offered through Link, so the consent binds to that seller. */
export async function createManagedQuote(env: Env, i: { userId: string; plan: Plan; country: string; postalCode?: string | null; topupAmountCents: number },
  now: number): Promise<TaxQuoteRow> {
  const row: TaxQuoteRow = { id: `quote-${crypto.randomUUID()}`, user_id: i.userId, plan: i.plan, country: i.country.toUpperCase(), postal_code: normPostal(i.postalCode),
    price_cents: PLAN_MONTHLY_USD[i.plan] * 100, tax_cents: null, total_cents: null, topup_amount_cents: i.topupAmountCents, topup_tax_cents: null,
    topup_total_cents: null, source: MANAGED_QUOTE_SOURCE, calculation_id: null, created_at: now, expires_at: now + TAX_QUOTE_TTL_MS };
  await env.DB.prepare(`INSERT INTO tax_quotes (id,user_id,plan,country,postal_code,price_cents,tax_cents,total_cents,topup_amount_cents,topup_tax_cents,
      topup_total_cents,source,calculation_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.user_id, row.plan, row.country, row.postal_code, row.price_cents, row.tax_cents, row.total_cents, row.topup_amount_cents,
      row.topup_tax_cents, row.topup_total_cents, row.source, row.calculation_id, row.created_at, row.expires_at).run();
  return row;
}

// ---- Consent --------------------------------------------------------------------------------------------------------------

const money = z.number().int();
export const topupSchema = z.object({ enabled: z.boolean(), amountUsd: money, thresholdUsd: money, capUsd: money }).strict();
export type TopupInput = z.infer<typeof topupSchema>;
export function validateTopup(t: TopupInput): void {
  const ok = t.amountUsd >= 5 && t.amountUsd <= 500 && t.thresholdUsd >= 1 && t.thresholdUsd <= 500 && t.capUsd >= t.amountUsd && t.capUsd <= 2000;
  if (!ok) throw new HTTPError(400, "topup_invalid");
}
const versionsSchema = z.object({ cloudTerms: z.string().max(80), termsOfService: z.string().max(80), privacyPolicy: z.string().max(80) }).strict();
/** What the portal saw of the customer's own request, with where it came from. Claims only; the control plane records what it observed too. */
export const clientSchema = z.object({ ip: z.string().max(64).optional(), ipSource: z.enum(["x-forwarded-for", "x-real-ip", "unavailable"]).optional(),
  userAgent: z.string().max(400).optional() }).strict();

export const consentSchema = z.object({
  termsAccepted: z.boolean(),
  recurringAuthorized: z.boolean(),
  earlyStart: z.boolean().default(false),
  billingCountry: z.string().regex(/^[A-Za-z]{2}$/),
  /** The country the customer confirmed on our page. It picks the seller and must equal billingCountry (400 declared_country_mismatch). */
  declaredCountry: z.string().regex(/^[A-Za-z]{2}$/),
  /** The language the customer confirmed for Stripe's page (any Stripe locale; the server sends de for DE/AT whatever this says). */
  checkoutLanguage: z.string().trim().min(2).max(16),
  /** The language our page showed the disclosure in (GET /v1/legal/disclosure?siteLanguage=). renewalText is checked against that rendering only. */
  siteLanguage: z.enum(["en", "de"]),
  postalCode: z.string().trim().max(20).optional(),
  taxId: z.string().trim().max(40).optional(),
  renewalText: z.string().max(3000),
  screenVersion: z.string().max(80),
  /** The document versions the page showed. Consent binds to these; a newer deployed version makes the screen stale. */
  documentVersions: versionsSchema,
  /** Optional and ignored since r13 (the page makes no quote call; Stripe prices on its own page). */
  quoteId: z.string().regex(/^quote-[\w-]{1,80}$/).optional(),
  topup: topupSchema.optional(),
  client: clientSchema.optional(),
  /** WP4 r2-3: disclosure.token from GET /v1/legal/disclosure, sent back unchanged. Required by POST /v1/billing/checkout (409 disclosure_stale
   *  when missing, forged, older than 24 h, or issued for another siteLanguage, declaredCountry, path, Stripe locale or renewalText). */
  disclosureToken: z.string().max(3000).optional(),
}).strict();
export type ConsentInput = z.infer<typeof consentSchema>;

export interface ClientMeta {
  claimed: { ip: string | null; ipSource: string; userAgent: string | null };
  observed: { ip: string | null; userAgent: string | null };
}
/** Claimed (forwarded by the portal) and observed (this request) metadata, each explicitly "unavailable" when missing. */
export function clientMeta(client: z.infer<typeof clientSchema> | undefined, request: Request): ClientMeta {
  return {
    claimed: { ip: client?.ip ?? null, ipSource: client?.ip ? client.ipSource ?? "x-forwarded-for" : "unavailable", userAgent: client?.userAgent ?? null },
    observed: { ip: request.headers.get("CF-Connecting-IP"), userAgent: request.headers.get("User-Agent")?.slice(0, 400) ?? null },
  };
}

export interface PreparedConsent {
  id: string; plan: Plan; priceCents: number; billingCountry: string; declaredCountry: string; postalCode: string | null; euRegion: boolean; earlyStart: boolean;
  /** Every server starts at payment: never delayed (the delayed start is gone, r13). */
  schedule: Schedule;
  renewalText: string; wording: Record<string, string>; taxId: string | null;
  topup: { enabled: boolean; amountCents: number; thresholdCents: number; capCents: number; totalCents: number | null; text: string | null };
  versions: { cloudTerms: string; tos: string; privacy: string }; screenVersion: string;
  seller: SellerKind;
  /** The Stripe locale actually sent (de for DE/AT whatever the client said). */
  locale: string;
  /** The site language our disclosure was shown in (en or de), as the page declared it (consent.siteLanguage). */
  siteLanguage: Lang;
  /** The words Stripe renders on the order button in `locale`, or null when that locale has not been rendered (plan 3.4). */
  buttonText: string | null;
  /** The label of OUR button the customer pressed, in the site language (plan §3.1). Never Stripe's words (buttonText). */
  startRequestText: string;
  policyVersion: string; ipCountryHint: string | null; startRequestAt: number;
  meta: ClientMeta; disclosure: string;
}

/** billingCountry must equal declaredCountry (400 declared_country_mismatch); returns the upper-case country. */
export function declaredCountryOf(input: { billingCountry: string; declaredCountry: string }): string {
  const declared = input.declaredCountry.trim().toUpperCase();
  if (input.billingCountry.trim().toUpperCase() !== declared) throw new HTTPError(400, "declared_country_mismatch");
  return declared;
}

/** Server-side check of the one button, the region rules, the document versions and the shown text. Throws before anything is charged or
 *  provisioned. The seller (for the declared country) and the effective policy version are decided by the caller. */
export function prepareConsent(input: ConsentInput, plan: Plan, now: number, meta: ClientMeta,
  ctx: { seller: SellerKind; policyVersion: string; ipCountryHint?: string | null }): PreparedConsent {
  if (input.termsAccepted !== true || input.recurringAuthorized !== true) throw new HTTPError(400, "consent_required");
  const country = declaredCountryOf(input);
  const postal = normPostal(input.postalCode);
  const euRegion = isConsumerWithdrawalCountry(country);
  // The EU/EEA/UK line is the proof of the early-start request: no consent for a listed country without it. Elsewhere it is ignored.
  if (euRegion && input.earlyStart !== true) throw new HTTPError(409, "early_start_required");
  const earlyStart = euRegion;
  const cur = currentVersions();
  const dv = input.documentVersions;
  // The documents shown must be the documents in force: a page from before a terms change cannot carry consent to the new terms.
  if (dv.cloudTerms !== cur.cloudTerms || dv.termsOfService !== cur.termsOfService || dv.privacyPolicy !== cur.privacyPolicy) throw new HTTPError(409, "disclosure_stale");
  if (input.screenVersion !== SCREEN_VERSION) throw new HTTPError(409, "disclosure_stale");
  // The text the customer saw must be, byte for byte, the one we render now for this declared country, path and the page language the site
  // declared (en or de): this is how the conditional lines (EU/EEA/UK, Managed Payments, DE/AT) are checked. Only that one rendering counts:
  // the other language's text for the same country is a substituted screen, not the one shown (409 disclosure_stale).
  const siteLanguage: Lang = input.siteLanguage;
  const shown = renderDisclosure(plan, country, siteLanguage, ctx.seller, input.checkoutLanguage);
  if (shown.renewalText !== input.renewalText) throw new HTTPError(409, "disclosure_stale");
  // Automatic top-up is a Ferrox charge on the saved card; a Managed Payments subscription only authorizes Link to charge it.
  if (ctx.seller === "link" && input.topup?.enabled) throw new HTTPError(409, "topup_not_available");
  let topup: PreparedConsent["topup"] = { enabled: false, amountCents: TOPUP_DEFAULTS.amountUsd * 100, thresholdCents: TOPUP_DEFAULTS.thresholdUsd * 100,
    capCents: TOPUP_DEFAULTS.capUsd * 100, totalCents: null, text: null };
  // The words the customer actually saw, in the site language and page order: the disclosure lines (price, renewal, refund, mp, eu, deat,
  // acceptance) and, below, the top-up switch. Never the pre-r13 checkbox wording (WORDING.terms, .earlyStart ...): that screen no longer exists.
  const wording = { ...shown.lines } as Record<string, string>;
  if (input.topup) {
    validateTopup(input.topup);
    // Server-owned wording in the site language; no quote exists, so the total reads "plus tax where it applies".
    const w = topupWording(siteLanguage, { amount: input.topup.amountUsd, threshold: input.topup.thresholdUsd, cap: input.topup.capUsd,
      totalText: topupTotalPhrase(siteLanguage, input.topup.amountUsd) });
    wording.topupBox = w.topupBox;
    topup = { enabled: input.topup.enabled, amountCents: input.topup.amountUsd * 100, thresholdCents: input.topup.thresholdUsd * 100,
      capCents: input.topup.capUsd * 100, totalCents: null, text: input.topup.enabled ? w.topupCharge : null };
    if (input.topup.enabled) wording.topupCharge = topup.text!;
  }
  const id = `consent-${crypto.randomUUID()}`;
  const versions = { cloudTerms: cur.cloudTerms, tos: cur.termsOfService, privacy: cur.privacyPolicy };
  const locale = checkoutLocale(country, input.checkoutLanguage);
  const buttonText = buttonWordsFor(locale);
  const startRequestText = stringsFor(siteLanguage).disclosure.button;
  const schedule = scheduleFor(now);
  // Everything the screen showed, frozen with the record (the exact consent wording, the lines, the documents).
  const disclosure = JSON.stringify({ screenVersion: SCREEN_VERSION, documentVersions: cur, plan, priceCents: PLAN_MONTHLY_USD[plan] * 100,
    declaredCountry: country, billingCountry: country, postalCode: postal, locale, siteLanguage, path: shown.path, lines: shown.lines, renewalText: input.renewalText,
    buttonText, startRequestText, policyVersion: ctx.policyVersion, wording, topup,
    // Which Stripe-page variant this customer is sent to, with its version and exact words (plan §3.2, owner decision 2026-10-14; Astra
    // NO-DROPDOWN-1 (4)): direct = the renewal sentence and acceptance text above the Pay button (links shown as labels), Managed Payments =
    // the required dropdown (label, single option, no default). The authorization itself is this record, bound to the session by its id and
    // sha256(renewalText); the archive never holds a dropdown answer.
    stripePage: { ...stripePageOf(shown.path, plan, locale, SUBMIT_TEXT_VARIANT), authorization: "clickwrap_consent_record" } });
  return {
    id, plan, priceCents: PLAN_MONTHLY_USD[plan] * 100, billingCountry: country, declaredCountry: country, postalCode: postal, euRegion,
    earlyStart, schedule, renewalText: input.renewalText, wording, taxId: input.taxId || null, topup, versions,
    screenVersion: SCREEN_VERSION, seller: ctx.seller, locale, siteLanguage, buttonText, startRequestText, policyVersion: ctx.policyVersion,
    ipCountryHint: ctx.ipCountryHint ?? null, startRequestAt: now, meta, disclosure,
  };
}

const archiveStmt = (env: Env, d: LegalDoc, now: number) =>
  env.DB.prepare("INSERT OR IGNORE INTO legal_doc_archive (version_id,title,sha256,text,archived_at) VALUES (?,?,?,?,?)").bind(d.versionId, d.title, d.sha256, d.text, now);
export const archiveCurrentDocs = (env: Env, now: number) => [archiveStmt(env, LEGAL_DOCS.cloudTerms, now), archiveStmt(env, LEGAL_DOCS.termsOfService, now),
  archiveStmt(env, LEGAL_DOCS.privacyPolicy, now)];
/** The same archive writes in the form the fenced batch takes. */
const archiveQs = (now: number): Q[] => [LEGAL_DOCS.cloudTerms, LEGAL_DOCS.termsOfService, LEGAL_DOCS.privacyPolicy].map((d) =>
  q("INSERT OR IGNORE INTO legal_doc_archive (version_id,title,sha256,text,archived_at) VALUES (?,?,?,?,?)", d.versionId, d.title, d.sha256, d.text, now));

export async function recordConsent(env: Env, lease: HomeLease, c: PreparedConsent, who: { homeId: string; userId: string; email: string | null }, now: number): Promise<void> {
  const metaJson = JSON.stringify(c.meta);
  const row: Array<[string, string | number | null]> = [
    ["id", c.id], ["home_id", who.homeId], ["user_id", who.userId], ["email", who.email], ["created_at", now], ["screen_version", c.screenVersion],
    ["cloud_terms_version", c.versions.cloudTerms], ["tos_version", c.versions.tos], ["privacy_version", c.versions.privacy],
    ["terms_accepted", 1], ["recurring_authorized", 1], ["early_start", c.earlyStart ? 1 : 0], ["eu_region", c.euRegion ? 1 : 0],
    ["topup_enabled", c.topup.enabled ? 1 : 0], ["topup_amount_cents", c.topup.amountCents], ["topup_threshold_cents", c.topup.thresholdCents],
    ["topup_cap_cents", c.topup.capCents], ["topup_text", c.topup.text], ["renewal_text", c.renewalText], ["wording", JSON.stringify(c.wording)],
    ["billing_country", c.billingCountry], ["tax_id", c.taxId], ["plan", c.plan], ["price_cents", c.priceCents],
    // Every server starts at payment: the start is the button press, never a later date.
    ["start_at", c.schedule.startAt], ["first_charge_at", c.schedule.firstChargeAt], ["delayed_start", 0],
    ["ip", c.meta.claimed.ip], ["ip_seen", c.meta.observed.ip], ["user_agent", c.meta.claimed.userAgent ?? c.meta.observed.userAgent],
    ["user_agent_seen", c.meta.observed.userAgent], ["client_meta", metaJson], ["postal_code", c.postalCode],
    // No quote (r13): tax_source only records which seller this consent belongs to (sellerOfConsent).
    ["quote_id", null], ["tax_source", c.seller === "link" ? MANAGED_QUOTE_SOURCE : "hosted"], ["quoted_tax_cents", null],
    ["quoted_total_cents", null], ["quoted_topup_total_cents", null], ["disclosure", c.disclosure], ["tax_line", null],
    ["effective_start_at", c.schedule.startAt],
    ["declared_country", c.declaredCountry], ["checkout_language", c.locale], ["policy_version", c.policyVersion], ["ip_country_hint", c.ipCountryHint],
    ["button_text", c.buttonText], ["site_language", c.siteLanguage], ["start_request_at", c.startRequestAt],
    ["start_request_text", c.startRequestText],
  ];
  // Pending disclosure evidence only: the terms are accepted when the order is submitted on Stripe's page (plan §3.3), so the
  // terms_acceptances row is written at verified completion (recordAcceptanceAtCompletion), never here. An abandoned or failed checkout
  // leaves no acceptance.
  await fencedBatch(env, lease, [
    ...archiveQs(now),
    q(`INSERT INTO checkout_consents (${row.map(([k]) => k).join(",")}) VALUES (${row.map(() => "?").join(",")})`, ...row.map(([, v]) => v)),
  ]);
}

/** WP5 calls this from the verified checkout.session.completed handler: the customer submitted the order, so the terms shown with this
 *  consent are now accepted. Inserts the acceptance once per consent (idempotent: a replay or a second delivery changes nothing).
 *  accepted_at is the completion time; the wording is the acceptance line the page showed (site language), from the consent's wording, else
 *  its archived disclosure lines. Returns true when this call inserted the row. terms_acceptances is user-level (not a billing table), so no lease.
 *  WP4 r2-2: a pre-r1 r13 consent already has an acceptance written at our button (accepted_at = the consent's created_at, the old checkbox
 *  wording). That row is normalised once, here, to the completion time and the archived acceptance line. Once normalised its accepted_at is
 *  no longer the consent's created_at, so a replay (even with another completion time) leaves it alone. Normalising returns false. */
export async function recordAcceptanceAtCompletion(env: Env, consentId: string, completedAt: number): Promise<boolean> {
  const c = await getConsent(env, consentId);
  if (!c) throw new Error("consent_missing");
  let line: string | undefined;
  try { line = (JSON.parse(c.wording) as Record<string, string>).acceptance; } catch { line = undefined; }
  line ??= archivedSnapshot(c).lines?.acceptance;
  // Only a pre-r13 (checkbox screen) consent may fall back to the checkbox terms line: that screen did show it.
  if (line === undefined && c.start_request_at !== null) throw new Error("acceptance_line_missing");
  const wording = line ?? WORDING.terms;
  // terms_acceptances is user-level, not a billing table. normalised_at (migration 0061) marks a row as final: a row this call inserts is
  // final at once, and a pre-r1 row is normalised exactly once, even when the completion time equals the consent's created_at (a replay
  // can then never rewrite it; WP4 closing pass, P3).
  const [ins] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta,normalised_at)
      SELECT ?,user_id,cloud_terms_version,tos_version,privacy_version,'checkout',id,?,?,COALESCE(client_meta,'{}'),? FROM checkout_consents
      WHERE id=? AND NOT EXISTS (SELECT 1 FROM terms_acceptances WHERE consent_id=?)`)
      .bind(`accept-${crypto.randomUUID()}`, wording, completedAt, completedAt, consentId, consentId),
    env.DB.prepare(`UPDATE terms_acceptances SET accepted_at=?, wording=?, normalised_at=? WHERE consent_id=? AND source='checkout' AND normalised_at IS NULL
      AND accepted_at=(SELECT created_at FROM checkout_consents WHERE id=? AND start_request_at IS NOT NULL)`)
      .bind(completedAt, wording, completedAt, consentId, consentId),
  ]);
  return (ins.meta.changes ?? 0) > 0;
}

/** SQL condition (on a terms_acceptances row aliased `a`): the row counts as an acceptance. A row tied to a checkout consent counts only once
 *  that order was completed; a consent without a completion is not accepted (pre-r1 rows were written before the order was submitted). */
export const acceptanceCounts = (a: string) =>
  `(${a}.consent_id IS NULL OR EXISTS (SELECT 1 FROM checkout_consents ac WHERE ac.id=${a}.consent_id AND ac.completed_at IS NOT NULL))`;

export interface ConsentRow {
  id: string; home_id: string; user_id: string; email: string | null; created_at: number; screen_version: string;
  cloud_terms_version: string; tos_version: string; privacy_version: string; early_start: number; eu_region: number; topup_enabled: number;
  topup_amount_cents: number | null; topup_threshold_cents: number | null; topup_cap_cents: number | null; topup_text: string | null;
  renewal_text: string; wording: string; billing_country: string; plan: string; price_cents: number; start_at: number; first_charge_at: number;
  delayed_start: number; tax_cents: number | null; total_cents: number | null; stripe_country: string | null; stripe_session_id: string | null;
  completed_at: number | null; contract_made_at: number | null; confirmation_sent_at: number | null; effective_country: string | null;
  effective_eu_region: number | null; effective_start_at: number | null; quoted_tax_cents: number | null;
  quoted_total_cents: number | null; quoted_topup_total_cents: number | null; tax_source: string | null; postal_code: string | null; price_mismatch_at: number | null;
  trial_moved_at: number | null; agreed_recurring_cents: number | null; preflight_at: number | null; charged_currency: string | null;
  /** What the customer actually paid at checkout, in charged_currency (Adaptive Pricing's presentment amount, or the session amount). The tax
   *  in that currency is null when Stripe did not itemize it there. total_cents / tax_cents are the integration amounts. */
  charged_total_cents?: number | null; charged_tax_cents?: number | null;
  /** r13 policy fields (migration 0059, 0067). */
  declared_country: string | null; checkout_language: string | null; policy_version: string | null; button_text: string | null;
  site_language: string | null; start_request_at: number | null;
  /** r13 moments and deadlines (migration 0061); each written once. */
  paid_at: number | null;
  /** Migration 0061: the completion could not record the acceptance (no acceptance line on record); parked until repaired and replayed. */
  acceptance_parked_at?: number | null; statutory_withdraw_until: number | null; guarantee_withdraw_until: number | null; refund7_until: number | null;
  payment_failed_at: number | null; rejected_at: number | null; rejected_reason: string | null;
  /** Migration 0068: our button label as pressed, in the site language. NULL on a consent from before r1. */
  start_request_text?: string | null;
  /** The frozen screen (JSON: lines, renewalText, siteLanguage, startRequestText from r1, ...). Read through archivedSnapshot. */
  disclosure?: string | null;
  /** Migration 0022: the renewal authorization pressed on our page (always 1 when written by recordConsent). The webhook requires it. */
  recurring_authorized?: number | null;
  /** The Stripe price the checkout session was created with (set with stripe_session_id). */
  stripe_price_id?: string | null;
  /** The one subscription this consent's completed checkout created (attachSessionToConsent claims it once). */
  stripe_subscription_id?: string | null;
}
/** What the consent's archived disclosure holds of the r13 screen: the lines shown (in page order) and our button label as pressed. Null
 *  fields when the archive does not hold them (a pre-r1 r13 row has lines but no startRequestText; a pre-r13 row has neither). */
export function archivedSnapshot(c: Pick<ConsentRow, "disclosure">): { lines: Record<string, string> | null; startRequestText: string | null; siteLanguage: string | null } {
  let d: Record<string, unknown> | null = null;
  try { d = c.disclosure ? JSON.parse(c.disclosure) as Record<string, unknown> : null; } catch { d = null; }
  const lines = d && d.lines && typeof d.lines === "object" && !Array.isArray(d.lines) && Object.keys(d.lines).length > 0
    && Object.values(d.lines).every((v) => typeof v === "string") ? d.lines as Record<string, string> : null;
  return { lines, startRequestText: typeof d?.startRequestText === "string" ? d.startRequestText : null,
    siteLanguage: typeof d?.siteLanguage === "string" ? d.siteLanguage : null };
}
/** A consent from the current hosted screen whose snapshot is complete: our button label and the shown lines are both on record. */
export const hostedSnapshotComplete = (c: Pick<ConsentRow, "start_request_text" | "disclosure">) =>
  typeof c.start_request_text === "string" && c.start_request_text.length > 0 && archivedSnapshot(c).lines !== null;
export const getConsent = (env: Env, id: string) => env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(id).first<ConsentRow>();
/** The region whose rules apply: Stripe's collected billing address once checkout completed, else what the customer chose. */
export const consentIsEu = (c: Pick<ConsentRow, "effective_eu_region" | "eu_region">) => (c.effective_eu_region ?? c.eu_region) === 1;

/** Stripe's session says where the card holder really is, what tax was added and when the contract was made. Stripe's country is the authority. */
export async function attachSessionToConsent(env: Env, lease: HomeLease, id: string, s: { sessionId: string; subscriptionId: string | null; country: string | null;
  taxCents: number | null; totalCents: number | null; contractMadeAt: number; currency?: string | null; chargedCents?: number | null; chargedTaxCents?: number | null },
  _now: number): Promise<{ row: ConsentRow; effectiveEu: boolean; mismatch: boolean; acceptanceMissing: boolean; subscriptionTaken?: false }
    | { row: ConsentRow; subscriptionTaken: true }> {
  const row = await getConsent(env, id);
  if (!row) throw new Error("consent_missing");
  const effectiveCountry = s.country ?? row.billing_country;
  const effectiveEu = isEuRegion(effectiveCountry);
  // completed_at (moment 1) is Stripe's submission time (contractMadeAt: the completion event's own creation time), never our processing time
  // (Astra WP5-1 #6). It is persisted once; the acceptance is then recorded at that PERSISTED value (idempotent, user-level; WP4 r1), so a
  // crash between the two is repaired by the retried event with the same instant.
  // The session binding written when the session was created (or reissued) is never replaced here (Astra NO-DROPDOWN-1 (3)): the webhook
  // has already judged this session against it. And ONE subscription per consent, atomically: a consent that already holds another
  // subscription is not attached to a second one (the caller refuses that order as a duplicate; nothing of this row changes).
  const [upd] = await fencedBatch(env, lease, [q(`UPDATE checkout_consents SET stripe_session_id=COALESCE(stripe_session_id,?),
      stripe_subscription_id=COALESCE(stripe_subscription_id,?),stripe_country=?,tax_cents=?,total_cents=?,
      completed_at=COALESCE(completed_at,?),contract_made_at=COALESCE(contract_made_at,?),effective_country=?,effective_eu_region=?,charged_currency=?,
      charged_total_cents=?,charged_tax_cents=? WHERE id=? AND (? IS NULL OR stripe_subscription_id IS NULL OR stripe_subscription_id=?)`,
    s.sessionId, s.subscriptionId, s.country, s.taxCents, s.totalCents, s.contractMadeAt, s.contractMadeAt, effectiveCountry, effectiveEu ? 1 : 0,
    (s.currency ?? "usd").toLowerCase(), s.chargedCents === undefined ? s.totalCents : s.chargedCents,
    s.chargedTaxCents === undefined ? s.taxCents : s.chargedTaxCents, id, s.subscriptionId, s.subscriptionId)]);
  if ((upd?.meta.changes ?? 0) === 0) return { row, subscriptionTaken: true };
  const done = (await getConsent(env, id))!;
  let acceptanceMissing = false;
  // No acceptance line on record: never invented, and never an endless retry: the caller parks the consent (one alert) for repair and replay.
  try { await recordAcceptanceAtCompletion(env, id, done.completed_at ?? s.contractMadeAt); }
  catch (e) { if (e instanceof Error && e.message === "acceptance_line_missing") acceptanceMissing = true; else throw e; }
  return { row: done, effectiveEu, mismatch: effectiveEu !== (row.eu_region === 1), acceptanceMissing };
}

// ---- Accepted documents ------------------------------------------------------------------------------------------------------

export interface ArchivedDoc { version_id: string; title: string; sha256: string; text: string }
/** The exact archived text of the versions recorded with this consent. Never today's generated text: a revision deployed later must not
 *  be sent under an older acceptance. A missing archive row fails closed. */
export async function loadAcceptedDocs(env: Env, c: Pick<ConsentRow, "cloud_terms_version" | "tos_version">): Promise<{ cloudTerms: ArchivedDoc; termsOfService: ArchivedDoc }> {
  const get = (v: string) => env.DB.prepare("SELECT version_id,title,sha256,text FROM legal_doc_archive WHERE version_id=?").bind(v).first<ArchivedDoc>();
  const [cloudTerms, termsOfService] = await Promise.all([get(c.cloud_terms_version), get(c.tos_version)]);
  if (!cloudTerms || !termsOfService) throw new Error("accepted_documents_missing");
  for (const d of [cloudTerms, termsOfService]) if (await sha256Hex(d.text) !== d.sha256) throw new Error("accepted_documents_corrupt");
  return { cloudTerms, termsOfService };
}

// ---- Emails ---------------------------------------------------------------------------------------------------------------

/** The trader's identity for EU pre-contract information (CRD Art. 6(1)(c)). The phone number is a Worker secret (LEGAL_PHONE), never in
 *  source: it is shown only behind sign-in (the checkout consent page, the withdrawal page) and in the order confirmation, as plain text.
 *  It is labelled as a legal and contract notice line, never as support. Unset: the line is left out. */
export function traderIdentity(env: unknown): { name: string; address: string; email: string; phone: string | null } {
  const phone = (env as Record<string, unknown>).LEGAL_PHONE;
  return { name: "Ferrox Labs, LLC", address: "1000 Brickell Ave, Suite 715, Miami, Florida 33131, USA", email: "support@murage.ai",
    phone: typeof phone === "string" && phone.trim() ? phone.trim().slice(0, 40) : null };
}
export const SUPPORT_LINE = "Support: support@murage.ai (we reply within 2 working days)";
/** The phone is for legal and contract notices only (Sean): never presented as a support line, and always after the support line. */
export const legalPhoneLine = (n: string) => `Phone (legal and contract notices only, no support by phone): ${n}`;
export const WITHDRAWAL_ADDRESS = "Ferrox Labs, LLC, a Florida limited liability company, 1000 Brickell Ave, Suite 715, Miami, Florida 33131, USA";

export const WITHDRAWAL_INSTRUCTIONS = [
  "If you are a consumer in the European Union, the European Economic Area or the United Kingdom, you have a legal right to withdraw from this contract within 14 days, without giving a reason.",
  "The 14 days start on the day the contract was made: the day you completed checkout.",
  `To withdraw, tell us clearly before the 14 days end: use the "Withdraw from contract here" button on your account page, email support@murage.ai or write to ${WITHDRAWAL_ADDRESS}. You can use any clear statement, or the model withdrawal form below. You do not have to use the form.`,
  "If you withdraw, we refund what you paid within 14 days of getting your notice, to the way you paid, and we charge no fee for it.",
  "If you asked us to start your service before the 14 days ended and then withdraw, we deduct only the part of the monthly subscription price for service actually supplied after your start-now request and before your notice, worked out by the days in your billing period, counted from the day your service actually started. We add no separate charge for included Flux credits. If our 7-day refund offer gives you a larger refund, we apply that offer instead. If the promise we made at checkout, a full refund if you change your mind within 14 days of the day your service started, gives you a larger refund, we apply that promise instead. Anything already refunded to you for the same payment counts towards the refund.",
  "If you did not ask for an early start, your service starts after the 14 days and we make no deduction.",
].join("\n\n");

export const MODEL_WITHDRAWAL_FORM = [
  "MODEL WITHDRAWAL FORM",
  "(Complete and return this form only if you wish to withdraw from the contract.)",
  "",
  "To Murage (Ferrox Labs, LLC), support@murage.ai (postal address: " + WITHDRAWAL_ADDRESS + "):",
  "I withdraw from my contract for Murage Cloud.",
  "Ordered on: ______",
  "Your name: ______",
  "Your address: ______",
  "Account email, if you have one: ______",
  "Signature, only for a paper form: ______",
  "Date: ______",
].join("\n");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export interface RenderedEmail { subject: string; text: string; html: string }
export const htmlOf = (text: string) => `<!doctype html><html><body><pre style="font-family:inherit;white-space:pre-wrap;font-size:14px;line-height:1.5">${esc(text)}</pre></body></html>`;

/** The contract confirmation: a copy the customer can keep, with the ACCEPTED document versions embedded as full text (not links). */
export function buildConfirmationEmail(c: ConsentRow, docs: { cloudTerms: ArchivedDoc; termsOfService: ArchivedDoc }, o: { portalOrigin: string; legalPhone?: string | null; paid?: boolean; paidAt?: number | null; replacement?: boolean;
  /** Stripe's renewal date (the subscription's current period end). Unknown: no date is stated (never one we work out ourselves). */
  renewsAt?: number | null }): RenderedEmail {
  if (docs.cloudTerms.version_id !== c.cloud_terms_version || docs.termsOfService.version_id !== c.tos_version) throw new Error("accepted_documents_mismatch");
  const plan = c.plan as Plan;
  const eu = consentIsEu(c);
  // "We got your order" is the first moment (completed_at); "Payment received" the second (paid_at). Every server starts at payment.
  const paid = o.paid !== false;
  const paidAt = o.paidAt ?? c.paid_at ?? (paid ? c.first_charge_at : null);
  const link = sellerOfConsent(c) === "link";
  // The recurring contract total is the server-priced quote shown before consent; what was charged at checkout is reported apart.
  const recurring = link
    ? "Ferrox Labs, LLC sells and provides Murage Cloud. Link (by Stripe) takes your payments as merchant of record for Ferrox Labs: it added local tax where it handles that tax, charged you in the currency shown on its payment page, and sends your receipt. Each renewal is US$" + (c.price_cents / 100) + " plus applicable tax; if you pay in another currency, renewal amounts may change with exchange rates."
    : c.quoted_total_cents !== null && c.quoted_tax_cents !== null
    ? `Total including tax: ${usd(c.quoted_total_cents)} a month (${usd(c.price_cents)} plus ${usd(c.quoted_tax_cents)} tax), as shown before you agreed.`
    : c.agreed_recurring_cents !== null
      ? `Total including tax: ${usd(c.agreed_recurring_cents)} a month (${usd(c.price_cents)} before tax), as shown on the payment page and confirmed there.`
      : "Tax is added where it applies. The tax and the total were shown on the payment page and are on your receipt.";
  const charged = (n: number) => moneyIn(n, c.charged_currency);
  // What the customer actually paid (Stripe's read-back: the presentment amount and currency under Adaptive Pricing), never the integration
  // (USD) total of a payment made in another currency. Its tax is stated only when Stripe itemized it in that currency.
  const paidTotal = c.charged_total_cents ?? c.total_cents;
  const paidTax = c.charged_total_cents !== null && c.charged_total_cents !== undefined ? c.charged_tax_cents ?? null : c.tax_cents;
  const dueNow = paidTotal !== null && paidTax !== null ? `Charged at checkout: ${charged(paidTotal)} (tax ${charged(paidTax)})${link ? ", by Link (by Stripe)" : ""}.`
    : paidTotal !== null ? `Charged at checkout: ${charged(paidTotal)} including tax${link ? ", by Link (by Stripe); Link's receipt itemizes the tax" : "; your receipt itemizes the tax"}.` : "";
  // Deadlines (plan §4.4): both the statutory and the guarantee date show as the one later date.
  const resident = eu;
  const later = c.guarantee_withdraw_until !== null || c.statutory_withdraw_until !== null
    ? Math.max(c.statutory_withdraw_until ?? 0, c.guarantee_withdraw_until ?? 0) : null;
  const deadlines = [resident && later ? `You can withdraw from the contract until the end of ${aoeDate(later)} (anywhere on Earth).` : "",
    c.refund7_until !== null ? `You can ask for the 7-day refund until the end of ${aoeDate(c.refund7_until)}.` : ""].filter(Boolean);
  const parts: string[] = [];
  parts.push(`Your Murage Cloud order confirmation. ${o.replacement ? (paid ? "We got your order. Payment received: your plan is switched." : REPLACEMENT_WORDS.replacementUnpaid.en) : paid ? "We got your order. Payment received: your server is starting." : "We got your order. Your server starts as soon as your payment clears."} Please keep this email: it is your copy of the contract.`);
  parts.push(["ORDER", `Plan: ${PLAN_NAMES[plan]}`, link ? `Plan price: US$${c.price_cents / 100} a month before tax, billed monthly in advance` : `Price: $${c.price_cents / 100} a month, billed monthly in advance, in US dollars`, recurring, paid ? dueNow : "",
    `Billing country: ${c.effective_country ?? c.billing_country}`,
    paidAt !== null && paid ? `Service starts: ${isoDate(paidAt)}` : "Service starts: as soon as your payment clears",
    paidAt !== null && paid ? `First charge: ${isoDate(paidAt)}` : "",
    paidAt !== null && paid && o.renewsAt ? `Next renewal after that: ${isoDate(o.renewsAt)}` : "", ...deadlines]
    .filter(Boolean).join("\n"));
  parts.push(["RENEWAL AND CANCELLING", c.renewal_text, "",
    `To cancel: sign in to your account page and press the Cancel plan button: ${cloudUrl(o.portalOrigin)}. It is one click; you do not need to call or email us. Your plan ends at the end of the period you paid for, and we confirm by email.`,
    "We will email you once a year to remind you that your plan renews.",
    "Refund: ask within 7 days of the day we tell you your server is ready, or of your first payment if that is later, and we refund your first month's subscription fee in full, including tax (once per person or payment method; not Flux top-ups; not accounts closed for abuse). We deduct nothing for included Flux credits you have used. When we refund, the included credits are removed from your balance."].join("\n"));
  if (eu) {
    parts.push(["YOUR RIGHT TO WITHDRAW (EU, EEA AND UK CONSUMERS)", WITHDRAWAL_INSTRUCTIONS, "", MODEL_WITHDRAWAL_FORM].join("\n"));
  }
  const wording = JSON.parse(c.wording) as Record<string, string>;
  const early = c.early_start === 1 ? earlyStartCopy(c, wording) : "";
  if (early) parts.push(early);
  if (c.topup_enabled === 1) {
    parts.push(["COPY OF YOUR AUTOMATIC TOP-UP AUTHORIZATION",
      `Made on ${new Date(c.created_at).toISOString()} at checkout:`, wording.topupBox ?? "", wording.topupCharge ?? c.topup_text ?? "",
      `Amount: ${usd(c.topup_amount_cents ?? 0)}${c.quoted_topup_total_cents !== null ? ` (${usd(c.quoted_topup_total_cents)} including tax)` : ""}. Trigger: balance below ${usd(c.topup_threshold_cents ?? 0)}. Monthly cap: ${usd(c.topup_cap_cents ?? 0)}.`,
      `You can turn it off or change the cap at any time on your account page: ${cloudUrl(o.portalOrigin)}.`].join("\n"));
  }
  parts.push(["WHO YOU CONTRACT WITH", "Ferrox Labs, LLC (Murage), 1000 Brickell Ave, Suite 715, Miami, Florida 33131, USA",
    SUPPORT_LINE, o.legalPhone ? legalPhoneLine(o.legalPhone) : ""].filter(Boolean).join("\n"));
  parts.push(["WHAT YOU ACCEPTED", `Murage Cloud terms: version ${c.cloud_terms_version}`, `Terms of Service: version ${c.tos_version}`,
    `Privacy Policy: version ${c.privacy_version}`,
    // r1 and later: accepted when the order was submitted on the payment page (completion), not when our page was shown.
    // Every r13 consent (start_request_at set, pre-r1 rows included): accepted at completion, never at our button.
    `Accepted on ${new Date(c.start_request_at !== null ? c.completed_at ?? c.created_at : c.created_at).toISOString()} (UTC), checkout screen ${c.screen_version}.`].join("\n"));
  parts.push(`COPY OF THE ${docs.cloudTerms.title.toUpperCase()} (version ${docs.cloudTerms.version_id})\n\n${docs.cloudTerms.text}`);
  parts.push(`COPY OF THE ${docs.termsOfService.title.toUpperCase()} (version ${docs.termsOfService.version_id})\n\n${docs.termsOfService.text}`);
  const text = parts.join("\n\n----------------------------------------\n\n");
  return { subject: "Murage Cloud: your order confirmation and contract copy", text, html: htmlOf(text) };
}
/** The copy of the early-start request, only ever from what the consent archived; the old checkbox wording is never used for it.
 *  - r1 and later: the EU line shown and our button label, both from the consent's own snapshot.
 *  - a pre-r1 r13 consent (no start_request_text): the EU line from its archived disclosure; our button label is reconstructed from the
 *    plan §3.1 strings for its stored site language and said to be reconstructed. If even the lines are not archived, both are
 *    reconstructed for its stored language and declared country, labelled as such.
 *  - a pre-r13 consent (the checkbox screen, no start_request_at): the request it archived in its own wording column, else nothing. */
function earlyStartCopy(c: ConsentRow, wording: Record<string, string>): string {
  const head = "COPY OF YOUR EARLY-START REQUEST";
  if (c.start_request_at === null) {
    return wording.earlyStart ? [head, `Made on ${new Date(c.created_at).toISOString()} at checkout:`, wording.earlyStart].join("\n") : "";
  }
  const made = `Made on ${new Date(c.start_request_at ?? c.created_at).toISOString()} on our checkout page.`;
  const snap = archivedSnapshot(c);
  if (c.start_request_text && snap.lines?.eu) {
    return [head, `${made} Shown above the button:`, snap.lines.eu, `You pressed: "${c.start_request_text}"`].join("\n");
  }
  if (c.start_request_text) return [head, `${made} Shown above the button:`, wording.eu ?? "", `You pressed: "${c.start_request_text}"`].filter(Boolean).join("\n");
  const lang = langOf(c.site_language ?? snap.siteLanguage);
  const reconstructedButton = stringsFor(lang).disclosure.button;
  if (snap.lines?.eu) {
    return [head, `${made} Shown above the button (from our record of your checkout screen):`, snap.lines.eu,
      `The button on that page read: "${reconstructedButton}" (reconstructed from the page's wording for your language; our record of that order did not store the button label).`].join("\n");
  }
  const country = c.declared_country ?? c.billing_country;
  const plan = (PLANS as readonly string[]).includes(c.plan) ? c.plan as Plan : null;
  const eu = plan ? renderDisclosure(plan, country, lang, sellerOfConsent(c), c.checkout_language).lines.eu : undefined;
  if (!eu) return "";   // nothing to reconstruct from: the request copy is omitted rather than invented
  return [head, made, `Reconstructed from our checkout page's wording for your language and country (our record of that order did not store the words shown): ${eu}`,
    `The button read: "${reconstructedButton}" (reconstructed).`].join("\n");
}
/** The members area's Cloud page (murage.ai/home/cloud): the "account page" every email links to. */
export const CLOUD_MEMBERS_PATH = "/home/cloud";
const cloudUrl = (origin: string) => `${origin.replace(/\/$/, "")}${CLOUD_MEMBERS_PATH}`;

export function buildReminderEmail(plan: Plan, o: { portalOrigin: string; renewsOn: number; seller?: SellerKind }): RenderedEmail {
  const text = [`Your yearly Murage Cloud reminder.`, "", o.seller === "link" ? renewalBaseManaged(plan) : renewalBase(plan), "",
    `Your plan renews again on ${isoDate(o.renewsOn)} and every month after that until you cancel.`,
    `To cancel, press Cancel plan on your account page: ${cloudUrl(o.portalOrigin)}. It is one click and needs no call or email.`].join("\n");
  return { subject: "Murage Cloud: your plan renews every month (yearly reminder)", text, html: htmlOf(text) };
}

/** The 30-day notice of changed documents, with full copies of the new versions. They apply to you only after you accept them again. */
export function buildTermsChangeEmail(o: { portalOrigin: string; effectiveAt: number; changed: LegalDoc[]; alreadyAccepted?: boolean }): RenderedEmail {
  const text = o.alreadyAccepted ? ["We are changing the Murage Cloud documents listed below. You already accepted the new versions on your account page; this is your 30-day notice and your copy of them.", "",
    ...o.changed.flatMap((d) => ["----------------------------------------", `COPY OF THE NEW ${d.title.toUpperCase()} (version ${d.versionId})`, "", d.text, ""])].join("\n")
    : ["We are changing the Murage Cloud documents listed below.", "",
    `The new versions apply to your plan only after you accept them. We will ask you to tick the box again the next time you sign in to your account page (${cloudUrl(o.portalOrigin)}), and not before ${isoDate(o.effectiveAt)}, even if you accept them sooner.`,
    `Until you accept, the versions you agreed to keep applying. ${TERMS_NONACCEPTANCE_WORDING} If you do not want the new versions, you can also cancel your plan at any time with the Cancel plan button.`, "",
    ...o.changed.flatMap((d) => ["----------------------------------------", `COPY OF THE NEW ${d.title.toUpperCase()} (version ${d.versionId})`, "", d.text, ""])].join("\n");
  return { subject: "Murage Cloud: our terms are changing (30-day notice)", text, html: htmlOf(text) };
}

/** Murage Cloud terms (site 6947dd1), word for word: what happens if the customer never accepts changed terms. */
export const TERMS_NONACCEPTANCE_WORDING = "A renewal is not an acceptance. If you never accept them, your current terms keep running to the end of the period you have paid for, "
  + "and then your plan does not renew. We remind you when we send the notice, 7 days before your period ends, and when it ends. If you accept before then, your plan carries on.";

/** Reminders for changed terms not yet accepted: 7 days before the paid period ends, and when it has ended. */
/** The deletion schedule's retention (suspended -> deleted): config.retentionMs (CLOUD_B3_CONFIG), RETENTION_MS only when B3 is off. */
export const retentionMsOf = (env: Env): number => b3Enabled(env) ? b3Config(env).retentionMs : RETENTION_MS;
/** Until when a home's data is kept, by the lifecycle's own schedule (B2, the ended view), or null when there is no such date: a running home
 *  (nothing is scheduled), or one being deleted or deleted (purged). Suspended: its delete_after, or an open export request's pause if later
 *  (the deletion waits for it). In its grace period (payment_problem): grace_until plus the retention, the earliest the lifecycle can delete
 *  it (it suspends at grace_until and keeps the data retentionMs from then), so the date never promises more than the schedule keeps. */
export function dataKeptUntil(env: Env, h: { desired_state: string; grace_until: number | null; delete_after: number | null }, exportPauseUntil: number | null = null): number | null {
  if (h.desired_state === "suspended") return h.delete_after === null ? null : Math.max(h.delete_after, exportPauseUntil ?? 0);
  if (h.desired_state === "payment_problem" && h.grace_until !== null) return h.grace_until + retentionMsOf(env);
  return null;
}
/** B3, the server-ready moment, lifecycle side: the home's first canary pass records that the ready email is owed (ready_pending_at, once,
 *  in the SAME batch as the pass). Astra JOURNEY-B-1 #7: this is durable work, not the refund clock: the clock (ready_at) starts only when
 *  queueServerReady queues the ready email, and the billing sweep keeps queueing for every home still owed one, with no age cutoff. */
export const readyStamp = (env: Env, homeId: string, now: number): D1PreparedStatement =>
  env.DB.prepare("UPDATE cloud_homes SET ready_pending_at=? WHERE id=? AND ready_pending_at IS NULL AND ready_at IS NULL").bind(now, homeId);
/** B3, billing side, under the home's billing lease: the server-ready moment itself. ONE fenced batch writes cloud_homes.ready_at (once, never
 *  moved), the "your server is ready" email (billing_notices server_ready, created AT ready_at, sent by the billing sweep) and the consent's
 *  frozen refund deadline grown to the later of the payment rule and 7 days from ready (MAX: it never shrinks). The date the customer is told
 *  and the date the refund window runs from are therefore the email's own timestamp (Astra JOURNEY-B-1 #7). Idempotent; right after the
 *  canary pass, and from the billing sweep for every home whose email is still owed (ready_pending_at set, ready_at NULL). */
export async function queueServerReady(env: Env, lease: HomeLease, homeId: string, now: number): Promise<void> {
  const h = await env.DB.prepare("SELECT ready_at,ready_pending_at FROM cloud_homes WHERE id=?").bind(homeId).first<{ ready_at: number | null; ready_pending_at: number | null }>();
  if (!h || (h.ready_at === null && h.ready_pending_at === null)) return;
  const readyAt = h.ready_at ?? now;
  const readyEnd = aoeEnd(readyAt, 7);
  // The queued payload's deadline is a placeholder: the email's words are generated again at its handoff (serverReadyData), with the clock
  // the refund window runs from (Astra JOURNEY-B-3 #5).
  const data = await serverReadyData(env, homeId, readyAt, readyAt);
  await fencedBatch(env, lease, [
    q("UPDATE cloud_homes SET ready_at=? WHERE id=? AND ready_at IS NULL", readyAt, homeId),
    q("INSERT INTO billing_notices (id,home_id,kind,payload,created_at) VALUES (?,?,'server_ready',?,?) ON CONFLICT(id) DO NOTHING",
      `server_ready:${homeId}:first`, homeId, JSON.stringify(data), readyAt),
    q(`UPDATE checkout_consents SET refund7_until=MAX(refund7_until,?) WHERE refund7_until IS NOT NULL AND paid_at IS NOT NULL
      AND id=(SELECT consent_id FROM billing_subscriptions WHERE home_id=?)`, readyEnd, homeId),
  ]);
}
/** The "your server is ready" email (Astra JOURNEY-B-3 #5): its refund deadline is generated with the SAME clock as eligibility. `handoffAt`
 *  is the moment the email is handed to the sender (billing_notices sent_at, readyAnchorSql: the refund window's ready moment), so the
 *  deadline is the later of the consent's frozen deadline, the payment rule and 7 days from that handoff (refundWindow, refund7Deadline),
 *  never the queue-time value. The default notifier calls it at the handoff, with the `now` it records as sent_at in the same batch that
 *  grows the frozen deadline. No deadline is stated without a first payment. */
export async function serverReadyData(env: Env, homeId: string, readyAt: number, handoffAt: number): Promise<Record<string, unknown>> {
  const sub = await env.DB.prepare(`SELECT b.first_paid_at AS paid, c.refund7_until AS frozen FROM billing_subscriptions b LEFT JOIN checkout_consents c ON c.id=b.consent_id
    WHERE b.home_id=?`).bind(homeId).first<{ paid: number | null; frozen: number | null }>();
  const deadline = sub?.paid != null ? Math.max(sub.frozen ?? 0, aoeEnd(sub.paid, 7), aoeEnd(handoffAt, 7)) : null;
  const text = "Your Murage Cloud server is ready. Sign in to your account page to open it.\n\n"
    + (deadline !== null ? `Not right for you? Ask by the end of ${aoeDate(deadline)} (anywhere on Earth), 7 days from the day your server is ready, and we refund your first month in full.\n\n` : "")
    + `Reference: ${homeId}`;
  return { readyAt, refundWindowEndsAt: deadline, emailSubject: "Murage Cloud: your server is ready", emailText: text, emailHtml: htmlOf(text) };
}
/** How long a suspended server's data is kept before deletion, as customer wording ("30 days"): the deletion schedule's own
 *  config.retentionMs (CLOUD_B3_CONFIG), in whole days rounded DOWN, so the wording never promises more than the schedule keeps
 *  (29.6 days is "29 days"; Astra MAKERKIT2 #4); RETENTION_MS only when B3 is off and nothing is deleted. */
export function retentionDaysText(env: Env): string {
  const days = Math.floor(retentionMsOf(env) / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function buildTermsReminderEmail(o: { portalOrigin: string; periodEnd: number; stage: "7d" | "end"; retention: string }): RenderedEmail {
  const text = o.stage === "7d"
    ? [`You have not accepted our updated Murage Cloud terms yet.`, "",
      `Your current terms run to the end of the period you have paid for, ${isoDate(o.periodEnd)}. If you do not accept the updated terms by then, your plan does not renew and ends on that day.`,
      `To keep your plan, sign in to your account page and accept them: ${cloudUrl(o.portalOrigin)}. A renewal is not an acceptance.`].join("\n")
    : [`Your Murage Cloud plan ended on ${isoDate(o.periodEnd)} and did not renew, because the updated terms were not accepted.`, "",
      `After a plan ends your server is suspended and we keep your data for ${o.retention}. You can ask for a copy of your data from your account page: ${cloudUrl(o.portalOrigin)}.`].join("\n");
  return { subject: o.stage === "7d" ? "Murage Cloud: accept the updated terms to keep your plan (7 days left)" : "Murage Cloud: your plan ended (updated terms not accepted)", text, html: htmlOf(text) };
}

// ---- Auto top-up (applied to Flux auto-recharge through B4) ---------------------------------------------------------------

export interface TopupRow { home_id: string; user_id: string; enabled: number; amount_cents: number; threshold_cents: number; cap_cents: number; cap_period: string;
  cap_resets: string; updated_at: number; consent_id: string | null; revision: number; applied_revision: number | null; applied_at: number | null; apply_error: string | null }
export async function saveTopup(env: Env, lease: HomeLease, a: { homeId: string; userId: string; enabled: boolean; amountCents: number; thresholdCents: number; capCents: number;
  consentId: string | null; source: string; ip: string | null; userAgent: string | null }, now: number): Promise<void> {
  await fencedBatch(env, lease, [
    q(`INSERT INTO topup_settings (home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,cap_period,cap_resets,consent_id,updated_at,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(home_id) DO UPDATE SET enabled=excluded.enabled,amount_cents=excluded.amount_cents,
        threshold_cents=excluded.threshold_cents,cap_cents=excluded.cap_cents,consent_id=COALESCE(excluded.consent_id,consent_id),updated_at=excluded.updated_at,
        revision=topup_settings.revision+1,apply_error=NULL`,
      a.homeId, a.userId, a.enabled ? 1 : 0, a.amountCents, a.thresholdCents, a.capCents, TOPUP_CAP_PERIOD, TOPUP_CAP_RESETS, a.consentId, now),
    q(`INSERT INTO topup_events (id,home_id,user_id,enabled,amount_cents,threshold_cents,cap_cents,source,ip,user_agent,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      crypto.randomUUID(), a.homeId, a.userId, a.enabled ? 1 : 0, a.amountCents, a.thresholdCents, a.capCents, a.source, a.ip, a.userAgent, now),
  ]);
}
export const getTopup = (env: Env, homeId: string) => env.DB.prepare("SELECT * FROM topup_settings WHERE home_id=?").bind(homeId).first<TopupRow>();

// ---- Export request pauses the day-14 deletion -----------------------------------------------------------------------------

/** SQL the lifecycle uses inside the same batch that moves a home to "deleting": 1 when no export request is holding it. */
export const NO_EXPORT_HOLD_SQL = "(SELECT COUNT(*) FROM data_export_requests WHERE home_id=? AND status='open' AND pause_until>?)=0";
/** True while an export request is open and inside its (non-extendable) pause. The lifecycle refuses to delete a home while this is true. */
export async function exportPausesDeletion(env: Env, homeId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM data_export_requests WHERE home_id=? AND status='open' AND pause_until>? LIMIT 1")
    .bind(homeId, now).first();
  return row !== null;
}
/** Requests past their pause stop pausing deletion; mark them so the record shows why deletion resumed. */
export async function expireExportRequests(env: Env, now: number): Promise<void> {
  await env.DB.prepare("UPDATE data_export_requests SET status='expired',closed_at=? WHERE status='open' AND pause_until<=?").bind(now, now).run();
}

// ---- First-month refund ---------------------------------------------------------------------------------------------------

export const MICROCENTS_PER_USD = 1_000_000; // B4's unit (b4-flux-config.ts): 1 USD = 1,000,000 microcents
export interface RefundQuote {
  eligible: boolean; reason: string | null; homeId: string; userId: string | null; invoiceId: string | null; paymentIntent: string | null;
  paidCents: number; feeCents: number; taxCents: number; usedCreditCents: number; refundNetCents: number; refundTaxCents: number;
  alreadyRefundedCents: number; refundCents: number; windowEndsAt: number | null;
  /** Lane B's refund-window shape ({ deadline, startsWhenReady }): true when the window has not started yet because the server is not ready
   *  (it starts when the server is first ready), so windowEndsAt is null and the window is OPEN, its end not yet known. */
  startsWhenReady?: boolean;
  /** Astra JOURNEY-A-3 #7: the refund window of EVERY outcome (never dropped): deadline null with startsWhenReady true is open, its end not
   *  known yet; deadline null with startsWhenReady false is unknown (no home or no first payment to run it from). */
  window: { deadline: number | null; startsWhenReady: boolean };
  /** True when the quote reached the amount; false when it stopped before it. usedCreditCents is always 0: nothing is deducted for credits used. */
  creditMeasured: boolean;
  /** True when the one-per-person limit binds this customer (they accepted a terms version carrying it) and was checked. */
  oncePerPerson: boolean;
  /** True when the payment was past the 24-month identity retention when this quote was worked out: its identity records are gone, so a
   *  timely request still waiting is decided without the one-per-person check (Astra ASTRA-REFUND3 #3). */
  identityExpired?: boolean;
}
/** Thrown by the pre-B4 stub: the usage summary page shows "unavailable". Never read for money (Sean 2026-10-12: no refund deducts credits used). */
export class IncludedCreditUnavailable extends Error { constructor() { super("included_credit_unavailable"); } }

// The SQL lives in dispute-sql.ts (no imports: the B4 ledger and its plain-SQLite migration test load it alone).
export { DISPUTE_RETURNED_SQL };
/** Round 10 (Astra TAXCOUNTRY-9 P1-2): THE INEXACT HOLD, per row `d`. A dispute whose movements are not known exactly (another currency, an
 *  inexact amount: movement_exact=0) holds every refund of its payment while it is OPEN or LOST and no operator has recorded, with evidence,
 *  the money it actually returned (resolved_at; POST /v1/admin/disputes/{id}/resolve-returned). Never computed from a conversion and never
 *  assumed: an unproven loss counts as NOTHING returned (DISPUTE_RETURNED_SQL), so no refund is lowered on it; the hold is what keeps the
 *  refund from being paid meanwhile. A dispute closed in our favour (won, warning_closed, prevented) returned nothing: no hold, the refund
 *  is paid in full. */
export const DISPUTE_INEXACT_HELD_SQL = `(d.movement_exact=0 AND d.resolved_at IS NULL AND (d.closed_at IS NULL OR d.outcome='lost'))`;
/** Round 10 (Astra TAXCOUNTRY-9 P2-a): an obligation is OPEN while the adjustment applied by hand (its applied receipt) differs from what is
 *  owed now (returned_cents, 0 once cleared): never applied, or applied for an amount a later reinstatement or win changed. */
export const DISPUTE_CREDIT_OPEN_SQL = "(o.returned_cents<>COALESCE(o.applied_returned_cents,0))";
/** ONE open alert per home and kind (cloud_alerts_open): its detail lists every OPEN obligation of the home (owed, and what was applied);
 *  resolved once none is open. Statements for the caller's fenced batch.
 *  Astra INTEGRATED-9: an obligation covers the invoice's B5 grants (credit_grants) only. A B4 grant (flux_grants) is adjusted through the B4
 *  ledger (b4-flux-ledger.ts: its account counts the lost dispute's share with every other cause, and an operator claims it before adjusting
 *  by hand), never through this obligation: one place per grant, so a hand adjustment and a revoke can never both remove the same credit. */
export function disputeCreditAlertQs(homeId: string, now: number): Q[] {
  return [
    q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
      SELECT 'alert:dispute_credit:' || ?2,?2,'credit.dispute_reversal_owed','high',json_object('obligations',(SELECT json_group_array(json_object('disputeId',o.dispute_id,
        'invoiceId',o.invoice_id,'returnedCents',o.returned_cents,'exact',o.exact,'appliedCents',o.applied_returned_cents))
        FROM dispute_credit_obligations o WHERE o.home_id=?2 AND ${DISPUTE_CREDIT_OPEN_SQL}),
        'rule','reversal targets count refunds only: apply each adjustment by hand for the PROPORTIONAL share of the money returned, to this invoice''s B5 credit grants only (B4 grants are the B4 ledger''s: credit.removal_owed), then record it with its evidence (POST /v1/admin/dispute-credit-obligations/{disputeId}/applied)'),?1
      WHERE EXISTS (SELECT 1 FROM dispute_credit_obligations o WHERE o.home_id=?2 AND ${DISPUTE_CREDIT_OPEN_SQL})
      ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,resolved_at=NULL,raised_at=excluded.raised_at,delivered_at=NULL,delivery_attempts=0
      WHERE cloud_alerts.detail<>excluded.detail OR cloud_alerts.resolved_at IS NOT NULL`, now, homeId),
    q(`UPDATE cloud_alerts SET resolved_at=?1,resolve_notice_due=1 WHERE id='alert:dispute_credit:' || ?2 AND resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM dispute_credit_obligations o WHERE o.home_id=?2 AND ${DISPUTE_CREDIT_OPEN_SQL})`, now, homeId),
  ];
}
/** Everything disputes returned for one payment (its invoice, or its payment intent): already returned money that no refund pays again. */
export async function disputeReturned(env: Env, invoiceId: string | null, paymentIntent?: string | null): Promise<number> {
  if (!invoiceId && !paymentIntent) return 0;
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(${DISPUTE_RETURNED_SQL}),0) AS n FROM payment_disputes d WHERE d.invoice_id=?1 OR d.payment_intent=?2`)
    .bind(invoiceId ?? "", paymentIntent ?? "").first<{ n: number }>();
  return Math.max(0, r?.n ?? 0);
}
/** Sum of every refund decided against one payment, across both refund routes (the ledger), and the money a lost dispute already returned. */
export async function refundedAgainst(env: Env, invoiceId: string, exceptOp?: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM refund_ops WHERE invoice_id=? AND decided_at IS NOT NULL AND id<>?")
    .bind(invoiceId, exceptOp ?? "").first<{ n: number }>();
  return (r?.n ?? 0) + await disputeReturned(env, invoiceId);
}
export const abuseClosed = async (env: Env, homeId: string) =>
  (await env.DB.prepare("SELECT 1 AS x FROM abuse_closures WHERE home_id=?").bind(homeId).first()) !== null;

/** The exact payment a refund operation was opened for, captured when the operation is opened. A later replacement subscription changes
 *  the home's own payment columns; this snapshot never changes, so the operation always works from the payment it was opened for. */
export interface PinnedPayment { invoiceId: string; paymentIntent: string | null; paidCents: number; taxCents: number; paidAt: number;
  periodStart: number | null; periodEnd: number | null }
/** The home's current first payment as a pinned snapshot (null when none is recorded yet). */
export async function pinCurrentPayment(env: Env, homeId: string): Promise<PinnedPayment | null> {
  const r = await env.DB.prepare(`SELECT first_invoice_id AS i,first_paid_at AS at,first_invoice_cents AS c,first_invoice_tax_cents AS t,first_period_start AS ps,
    first_period_end AS pe,first_payment_intent AS pi FROM billing_subscriptions WHERE home_id=?`).bind(homeId).first<{ i: string | null; at: number | null; c: number | null;
    t: number | null; ps: number | null; pe: number | null; pi: string | null }>();
  if (!r?.i || r.at === null || !r.c) return null;
  return { invoiceId: r.i, paymentIntent: r.pi, paidCents: r.c, taxCents: r.t ?? 0, paidAt: r.at, periodStart: r.ps, periodEnd: r.pe };
}

/** The full first-month fee (everything paid for that invoice, tax included): nothing is deducted for included Flux credits used
 *  (Sean 2026-10-12; the credits themselves are taken back when the refund runs). Once per customer and only for a customer's first
 *  payment (one per person or payment method: refund-identity.ts), never top-ups or abuse closures,
 *  minus anything already refunded against the same payment by either route. */
export async function quoteFirstMonthRefund(env: Env, homeId: string, now: number,
  opts: { exceptOp?: string; ignoreClaim?: boolean; pinned?: PinnedPayment; stripe?: StripeClient | null;
    /** Withdrawal only: the identity check could not run, so the customer gets the benefit of the doubt (a statutory refund never waits on it). */
    skipIdentity?: boolean;
    /** When this quote is worked out (default `now`). The identity check's capture, retention and grace period run on it; the request's
     *  receipt time (`now`) only decides entitlement and deductions (Astra ASTRA-REFUND2 #7). */
    processedAt?: number;
    /** The consent of the payment's own contract: its frozen refund7_until is the offer's deadline (Astra WP5-1 #5). Without it, the consent
     *  the home's subscription row binds to that same first payment; else the AoE rule from the payment. Astra JOURNEY-A-3 #5: an explicit
     *  null is a PINNED absence (a request recorded without a consent): it never falls back to the live consent; only undefined does. */
    consentId?: string | null } = {}): Promise<RefundQuote> {
  // `now` is the request's receipt time: it decides the window.
  const blank: RefundQuote = { eligible: false, reason: null, homeId, userId: null, invoiceId: null, paymentIntent: null, paidCents: 0, feeCents: 0, taxCents: 0,
    usedCreditCents: 0, refundNetCents: 0, refundTaxCents: 0, alreadyRefundedCents: 0, refundCents: 0, windowEndsAt: null, startsWhenReady: false,
    window: { deadline: null, startsWhenReady: false }, creditMeasured: false, oncePerPerson: false };
  const no = (reason: string, extra: Partial<RefundQuote> = {}): RefundQuote => ({ ...blank, ...extra, eligible: false, reason });
  const home = await env.DB.prepare(`SELECT h.owner_id,h.ready_at,h.ready_legacy,h.desired_state,${readyAnchorSql("h")} AS ready_anchor FROM cloud_homes h WHERE h.id=?`).bind(homeId)
    .first<{ owner_id: string; ready_at: number | null; ready_legacy: number | null; desired_state: string; ready_anchor: number | null }>();
  if (!home) return no("not_found");
  const sub = opts.pinned ? { first_invoice_id: opts.pinned.invoiceId, first_paid_at: opts.pinned.paidAt, first_invoice_cents: opts.pinned.paidCents,
    first_invoice_tax_cents: opts.pinned.taxCents, first_period_start: opts.pinned.periodStart, first_period_end: opts.pinned.periodEnd,
    first_payment_intent: opts.pinned.paymentIntent,
    abuse_closed_at: (await env.DB.prepare("SELECT abuse_closed_at AS a FROM billing_subscriptions WHERE home_id=?").bind(homeId).first<{ a: number | null }>())?.a ?? null, status: "pinned" }
    : await env.DB.prepare(`SELECT first_invoice_id,first_paid_at,first_invoice_cents,first_invoice_tax_cents,first_period_start,first_period_end,
      first_payment_intent,abuse_closed_at,status FROM billing_subscriptions WHERE home_id=?`).bind(homeId).first<{
    first_invoice_id: string | null; first_paid_at: number | null; first_invoice_cents: number | null; first_invoice_tax_cents: number | null;
    first_period_start: number | null; first_period_end: number | null; first_payment_intent: string | null; abuse_closed_at: number | null; status: string }>();
  if (!sub?.first_invoice_id || sub.first_paid_at === null || !sub.first_invoice_cents) {
    // No payment to run the window from: its end is not known; a home not ready yet still says the window starts when it is.
    const pending = refundWindow(null, 0, home).startsWhenReady;
    return no("no_first_payment", { userId: home.owner_id, startsWhenReady: pending, window: { deadline: null, startsWhenReady: pending } });
  }
  const already = await refundedAgainst(env, sub.first_invoice_id, opts.exceptOp);
  const ownConsent = opts.consentId !== undefined ? opts.consentId : (await env.DB.prepare("SELECT consent_id AS c FROM billing_subscriptions WHERE home_id=? AND first_invoice_id=?")
    .bind(homeId, sub.first_invoice_id).first<{ c: string | null }>())?.c ?? null;
  const frozen = ownConsent ? (await env.DB.prepare("SELECT refund7_until AS r FROM checkout_consents WHERE id=?").bind(ownConsent).first<{ r: number | null }>())?.r ?? null : null;
  // B3: the later of the first payment and the server-ready day (refundWindow, the one rule). Not ready yet: the window is open, no date yet.
  const window = refundWindow(frozen, sub.first_paid_at, home);
  const windowEndsAt = window.endsAt;
  const base = { userId: home.owner_id, invoiceId: sub.first_invoice_id, paymentIntent: sub.first_payment_intent, windowEndsAt,
    startsWhenReady: window.startsWhenReady, window: { deadline: windowEndsAt, startsWhenReady: window.startsWhenReady },
    paidCents: sub.first_invoice_cents, alreadyRefundedCents: already };
  if (windowEndsAt !== null && now > windowEndsAt) return no("window_expired", base);
  if (!opts.ignoreClaim && await env.DB.prepare("SELECT 1 AS x FROM first_month_refunds WHERE user_id=?").bind(home.owner_id).first()) return no("already_refunded", base);
  // Only an explicit, evidenced closure counts; a raised (or resolved) abuse alert is a suspicion, not a closure.
  if (sub.abuse_closed_at !== null || await abuseClosed(env, homeId)) return no("abuse_closure", base);
  // Once per person or payment method: the offer is for the customer's FIRST payment (refund-identity.ts). Unchecked is never eligible.
  // Only for a customer who accepted a terms version carrying that limit; anyone else has the offer as their terms gave it.
  // A timely request still undecided when its payment passes the 24-month retention (the identity was never readable meanwhile) is
  // settled automatically, never left for a person: the payment's identity records are purged and are never captured again, so the
  // saved request is honoured as received, without the one-per-person check (Astra ASTRA-REFUND3 #3). Only reachable for a saved
  // request: a new one for such a payment is far outside the 7-day window above.
  const identityExpired = !opts.skipIdentity && sub.first_paid_at < retentionCutoff(opts.processedAt ?? now);
  const oncePerPerson = !opts.skipIdentity && !identityExpired && await refundLimitAccepted(env, home.owner_id, sub.first_paid_at, ownConsent);
  const identity = oncePerPerson ? await firstPaymentCheck(env, opts.stripe ?? null, { homeId, userId: home.owner_id, invoiceId: sub.first_invoice_id,
    paidAt: sub.first_paid_at, paymentIntent: sub.first_payment_intent }, opts.processedAt ?? now) : null;
  if (identity) return no(identity, { ...base, oncePerPerson });
  const tax = sub.first_invoice_tax_cents ?? 0;
  const fee = sub.first_invoice_cents - tax; // the subscription fee; the invoice carries no top-ups
  // No deduction for credits used: usedCreditCents is always 0 (a request saved earlier with a measured deduction is also paid in full).
  const refundNet = fee;
  const refundTax = tax;
  const owed = Math.max(0, refundNet + refundTax - already); // never more than paid: the ledger caps it again at decision time
  // Round 10 (Astra TAXCOUNTRY-9 P1-1): money a LOST dispute returned is not a refund of ours: a request whose amount only that money used up
  // is still eligible (owed 0 now). Its operation is opened and decided as a CAPPED one (disputeCappedFromCents), so a later reinstatement
  // reopens what the loss took off, within the reinstatement window, instead of the request being refused for good as already refunded.
  const disputeOnly = owed === 0 && sub.first_invoice_id !== null
    && refundNet + refundTax - Math.max(0, already - await disputeReturned(env, sub.first_invoice_id)) > 0;
  const reason = owed === 0 && !disputeOnly ? "already_refunded" : null;
  return { ...blank, ...base, eligible: owed > 0 || disputeOnly, reason, feeCents: fee, taxCents: tax, usedCreditCents: 0, refundNetCents: refundNet,
    refundTaxCents: refundTax, refundCents: owed, creditMeasured: true, oncePerPerson, ...(identityExpired ? { identityExpired } : {}) };
}

// ---- Document versions and re-acceptance ---------------------------------------------------------------------------------------

export interface AcceptanceRow { cloud_terms_version: string; tos_version: string; privacy_version: string; accepted_at: number }
export const latestAcceptance = (env: Env, userId: string) => env.DB.prepare(`SELECT cloud_terms_version,tos_version,privacy_version,accepted_at
  FROM terms_acceptances WHERE user_id=? AND ${acceptanceCounts("terms_acceptances")} ORDER BY accepted_at DESC, rowid DESC LIMIT 1`).bind(userId).first<AcceptanceRow>();
/** Which documents changed since this acceptance. Empty when the customer agreed to everything now in force. */
export function changedSince(a: AcceptanceRow | null): LegalDoc[] {
  if (!a) return [];
  return [a.cloud_terms_version !== LEGAL_DOCS.cloudTerms.versionId ? LEGAL_DOCS.cloudTerms : null,
    a.tos_version !== LEGAL_DOCS.termsOfService.versionId ? LEGAL_DOCS.termsOfService : null,
    a.privacy_version !== LEGAL_DOCS.privacyPolicy.versionId ? LEGAL_DOCS.privacyPolicy : null].filter((d): d is LegalDoc => d !== null);
}

export const planFrom = (v: unknown): Plan | null => (PLANS as readonly string[]).includes(String(v)) ? v as Plan : null;
