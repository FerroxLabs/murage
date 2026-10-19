// SPDX-License-Identifier: AGPL-3.0-or-later
// Who sells a NEW Murage Cloud subscription (Sean, 2026-10-10), behind one interface:
//  - "ferrox": Ferrox Labs, LLC sells directly through our own Stripe Checkout plus Stripe Tax (every US billing country; and non-US buyers
//    too once CLOUD_NONUS_SELLER=direct, the later "$25k/month non-US" switch, which applies to NEW signups only: an existing subscription
//    keeps the seller recorded with its consent).
//  - "link": a Checkout Session with managed_payments[enabled]=true. Sold through Link, LLC is MERCHANT OF RECORD on Ferrox's behalf (Stripe
//    Managed Payments terms 2.1(a)); Ferrox Labs is the seller everywhere and the EU "trader". Never call Link the seller. Link adds local tax, may present the price in local currency (Adaptive Pricing is always on), sends the
//    receipt and can refund within 60 days under its own terms. https://docs.stripe.com/payments/managed-payments/update-checkout
// Routing uses the country chosen on our page; Stripe's collected billing address is verified at checkout.session.completed and a seller
// mismatch is refunded and the customer asked to check out again.
import { HTTPError } from "./http";
import type { Plan } from "./b5-config";
import { PLANS } from "./b5-config";
import type { SubmitVariant } from "./checkout-strings";
import { directSubmitMessage, RENEWAL_FIELD_KEY, RENEWAL_LABEL_MAX, RENEWAL_OPTION_VALUE, renewalField } from "./checkout-strings";
import { MANAGED_PAYMENTS_TAX_COVERAGE } from "./managed-payments-coverage";

export type SellerKind = "ferrox" | "link";
/** The tax quote source that marks a Managed Payments (Link) checkout: Link computes the tax on its own page, there is no Stripe Tax quote. */
export const MANAGED_QUOTE_SOURCE = "managed_payments";

export interface SellerSettings { nonUsMode: "managed_payments" | "direct"; ferroxTaxCountries: ReadonlySet<string> }
/** CLOUD_NONUS_SELLER: "managed_payments" (default) or "direct". FERROX_TAX_COUNTRIES: comma list of countries where Ferrox holds its own
 *  tax registration in Stripe Tax (default "US"). */
export function sellerSettings(env: unknown): SellerSettings {
  const e = env as Record<string, unknown>;
  const mode = e.CLOUD_NONUS_SELLER === "direct" ? "direct" : "managed_payments";
  const list = typeof e.FERROX_TAX_COUNTRIES === "string" ? e.FERROX_TAX_COUNTRIES : "US";
  return { nonUsMode: mode, ferroxTaxCountries: new Set(list.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)) };
}

const COVERED: ReadonlySet<string> = new Set(MANAGED_PAYMENTS_TAX_COVERAGE.countries);

/** The seller for a new checkout from this billing country. Nobody is sold to where no one handles the tax: zero tax is never assumed
 *  (409 tax_unavailable, the page asks to try again).
 *  - Link (Managed Payments, the default outside the US): a country inside Stripe's Managed Payments tax coverage, or one where Ferrox holds
 *    its own tax registration (FERROX_TAX_COUNTRIES).
 *  - Ferrox direct outside the US (CLOUD_NONUS_SELLER=direct): ONLY a country where Ferrox holds its own tax registration. Stripe Tax
 *    answers zero for a country where the seller is not registered ("not_collecting"), which is not a non-taxable sale, so the switch
 *    never bypasses this gate. It applies at quoting, at session creation and to the billing country Stripe collected (sellerMismatch). */
export function sellerFor(settings: SellerSettings, country: string): SellerKind {
  const c = country.toUpperCase();
  if (c === "US") return "ferrox";
  if (settings.nonUsMode === "direct") {
    if (settings.ferroxTaxCountries.has(c)) return "ferrox";
    throw new HTTPError(409, "tax_unavailable");
  }
  if (COVERED.has(c) || settings.ferroxTaxCountries.has(c)) return "link";
  throw new HTTPError(409, "tax_unavailable");
}
/** Does `seller` still cover `country` for a subscription it ALREADY sells (WP6 address change)? Independent of new-purchase routing
 *  (CLOUD_NONUS_SELLER): Ferrox direct covers the US and every country where Ferrox holds its own tax registration; Link (Managed Payments)
 *  covers a non-US country inside Stripe's Managed Payments tax coverage or with a Ferrox registration. Switching new signups to direct
 *  never makes a running Link plan in a country Link still covers need a replacement. */
export function sellerCovers(settings: SellerSettings, seller: SellerKind, country: string): boolean {
  const c = country.toUpperCase();
  if (seller === "ferrox") return c === "US" || settings.ferroxTaxCountries.has(c);
  return c !== "US" && (COVERED.has(c) || settings.ferroxTaxCountries.has(c));
}
/** Stripe Tax's taxability reasons that mean the seller is NOT collecting there (no registration), as opposed to a sale that is genuinely
 *  not taxable (https://docs.stripe.com/api/tax/calculations/object, tax_breakdown.taxability_reason). A direct quote with one of these
 *  outside the US is refused (no zero-tax assumption). */
export const NOT_REGISTERED_REASONS: ReadonlySet<string> = new Set(["not_collecting"]);

/** The seller recorded with a consent (the quote it was priced with). */
export const sellerOfConsent = (c: { tax_source: string | null }): SellerKind => c.tax_source === MANAGED_QUOTE_SOURCE ? "link" : "ferrox";

/** Stripe's collected billing country against the seller the checkout was made with: the seller that country gets NOW must be the same.
 *  (A direct (Ferrox) checkout chosen for the US whose card holder is outside the US, or a Link checkout whose card holder is in the US,
 *  went to the wrong seller; in direct mode Ferrox sells everywhere and only the region rules apply.) A collected country nobody may sell to
 *  (outside Stripe's tax coverage, no Ferrox registration) is a mismatch too. FAILS CLOSED: a missing or malformed collected country is a
 *  mismatch (no provisioning; refunded in full and the customer asked to check out again). The country chosen on our page is never taken as
 *  verification of where the card holder is. */
export function sellerMismatch(settings: SellerSettings, seller: SellerKind, collectedCountry: string | null): boolean {
  if (!collectedCountry || !/^[A-Za-z]{2}$/.test(collectedCountry)) return true;
  try { return sellerFor(settings, collectedCountry) !== seller; } catch { return true; }
}

type Form = Record<string, string | number | boolean | undefined | null>;
/** Where each "[Label]" of the direct submit text links to (the site's pages; Stripe renders custom_text as Markdown). */
export interface SubmitLinks { terms: string; tos: string; privacy: string }
export interface SessionInput { customerId: string; homeId: string; plan: string; priceId: string; fpTid?: string; successUrl: string; cancelUrl: string;
  /** The journaled consent this session is for, and sha256 of its renewalText (disclosure-token.ts renewalSha256). Both are required: the
   *  webhook accepts the order only against this record (checkout-moments.ts consentAuthorizes). */
  consentId: string; renewalSha256: string; expiresAtSeconds?: number;
  /** The Stripe `locale` (always sent, checkoutLocale() of the declared country and confirmed language: de for DE/AT). */
  locale: string;
  /** Direct path only: the links inside the §3.3 submit text. Required there; ignored on the managed path. */
  submitLinks?: SubmitLinks;
  /** Direct path only: which submit text (SUBMIT_TEXT_VARIANT unless the caller says otherwise). */
  submitVariant?: SubmitVariant;
  /** Replacement purchase: the subscription id this checkout replaces (metadata only). */
  replaces?: string;
  /** Astra JOURNEY-A-3 #2: the durable identity of this session request (its Stripe idempotency key), journaled on the consent
   *  (checkout_consents.session_issuance_id) before Stripe is asked. An expiry or completion settles only the request it names. */
  issuanceId?: string }
/** One interface, two implementations: the Checkout Session parameters for each seller. */
export interface SellerPath {
  kind: SellerKind;
  /** The name in the "I authorize ... to charge" boxes (CHECKOUT.md [seller]). */
  chargeName: string;
  sessionForm(i: SessionInput): Form;
}
/** Which §3.3 submit text the direct path sends until the re-rendered direct agreement-line screenshot decides: "full" (names the Cloud terms,
 *  ToS and privacy) is the safe one, because it is correct whether or not Stripe's own agreement line says "agree". */
export const SUBMIT_TEXT_VARIANT: SubmitVariant = "full";
const planOf = (plan: string): Plan => {
  if (!(PLANS as readonly string[]).includes(plan)) throw new Error(`session_plan_unknown:${plan}`);
  return plan as Plan;
};
/** Parameters both paths send. No `submit_type` (not allowed in subscription mode), no `subscription_data[trial_end]` (no delayed start), no
 *  `custom_text` (direct-only, added by DIRECT_PATH) and no `custom_fields` (Managed-Payments-only, added by MANAGED_PATH). Owner decision
 *  2026-10-14 (plan §3.2, option 1): the direct path shows the renewal sentence above the Pay button, the Managed Payments path keeps the
 *  required dropdown with the statement in its label. On both, the session names the journaled consent (id), the exact renewal sentence
 *  pressed on our page (sha256) and the price, and the webhook refuses any order that record does not cover (checkout-moments.ts). */
const common = (i: SessionInput): Form => {
  planOf(i.plan);
  if (!i.consentId || !/^[0-9a-f]{64}$/.test(i.renewalSha256 ?? "")) throw new Error("session_consent_binding_missing");
  return {
    mode: "subscription", customer: i.customerId, "line_items[0][price]": i.priceId, "line_items[0][quantity]": 1,
    billing_address_collection: "required", client_reference_id: i.homeId,
    "metadata[home_id]": i.homeId, "metadata[plan]": i.plan, "metadata[price_id]": i.priceId, "metadata[fp_tid]": i.fpTid, "metadata[replaces]": i.replaces,
    "subscription_data[metadata][home_id]": i.homeId, "subscription_data[metadata][plan]": i.plan, "subscription_data[metadata][fp_tid]": i.fpTid,
    "subscription_data[metadata][replaces]": i.replaces,
    "metadata[consent_id]": i.consentId, "subscription_data[metadata][consent_id]": i.consentId,
    "metadata[renewal_sha256]": i.renewalSha256, "metadata[issuance_id]": i.issuanceId,
    expires_at: i.expiresAtSeconds, success_url: i.successUrl, cancel_url: i.cancelUrl,
    locale: i.locale,
  };
};
export const DIRECT_PATH: SellerPath = {
  kind: "ferrox", chargeName: "Ferrox Labs, LLC",
  sessionForm: (i) => {
    if (!i.submitLinks) throw new Error("session_submit_links_missing");
    // The renewal sentence (cadence, this plan's price + tax, how to end it), always visible above the Pay button, then the acceptance links.
    const message = directSubmitMessage(i.locale, planOf(i.plan), i.submitVariant ?? SUBMIT_TEXT_VARIANT, i.submitLinks);
    if (message.length > SUBMIT_TEXT_MAX) throw new Error("session_submit_text_too_long");
    return assertDirectForm({ ...common(i), "managed_payments[enabled]": false, "adaptive_pricing[enabled]": false, "automatic_tax[enabled]": true,
      "tax_id_collection[enabled]": true, "customer_update[address]": "auto", "customer_update[name]": "auto",
      "custom_text[submit][message]": message, "metadata[seller]": "ferrox" });
  },
};
/** Managed Payments: managed_payments[enabled]=true and nothing in MANAGED_FORBIDDEN (assertManagedForm checks every form built here).
 *  The price's product needs an eligible tax code (txcd_10103001 SaaS or an IaaS code); that is Stripe product configuration, checked before launch. */
export const MANAGED_PATH: SellerPath = {
  kind: "link", chargeName: "Link (by Stripe), which takes payment for Ferrox Labs,",
  sessionForm: (i) => {
    // Stripe rejects custom_text here and has no checkbox: the required one-option dropdown stays (§3.2). Its LABEL is always shown and
    // carries the renewal statement; the option is the customer's action. Never a default value (that would be pre-ticked consent).
    const field = renewalField(i.locale);
    if (field.label.length > RENEWAL_LABEL_MAX || field.option.length > RENEWAL_LABEL_MAX) throw new Error("session_renewal_label_too_long");
    return assertManagedForm({ ...common(i), "managed_payments[enabled]": true, "metadata[seller]": "link",
      "custom_fields[0][key]": RENEWAL_FIELD_KEY, "custom_fields[0][type]": "dropdown", "custom_fields[0][optional]": false,
      "custom_fields[0][label][type]": "custom", "custom_fields[0][label][custom]": field.label,
      "custom_fields[0][dropdown][options][0][label]": field.option, "custom_fields[0][dropdown][options][0][value]": RENEWAL_OPTION_VALUE });
  },
};
export { RENEWAL_FIELD_KEY, RENEWAL_LABEL_MAX, RENEWAL_OPTION_VALUE };
/** Stripe's limit for custom_text.submit.message. */
export const SUBMIT_TEXT_MAX = 1200;
/** Never on a Managed Payments session (stripe-dashboard/MP-DISALLOWED-PARAMS.md; plan §1 parameter guard). A key matches itself or any `key[...]`. */
export const MANAGED_FORBIDDEN = ["automatic_tax", "tax_id_collection", "customer_update[name]", "customer_update[address]", "payment_method_types",
  "payment_method_configuration", "payment_method_options", "payment_method_collection", "saved_payment_method_options", "adaptive_pricing", "subscription_data[invoice_settings]",
  "subscription_data[default_tax_rates]", "invoice_creation", "shipping_address_collection", "shipping_options", "subscription_data[application_fee_percent]",
  "subscription_data[on_behalf_of]", "subscription_data[transfer_data]", "custom_text", "submit_type"];
/** Never on either path: submit_type (subscription mode rejects it) and a delayed start (decision A: every server starts at payment). */
export const NEVER_FORBIDDEN = ["submit_type", "subscription_data[trial_end]"];
/** Never on a direct session: custom_fields (owner decision 2026-10-14: no dropdown on the direct path; the renewal sentence is in the
 *  submit message). Checked by assertDirectForm behind DIRECT_PATH.sessionForm. */
export const DIRECT_FORBIDDEN = ["custom_fields"];
const hasKey = (form: Form, k: string) => Object.entries(form).some(([x, v]) => v !== undefined && v !== null && (x === k || x.startsWith(`${k}[`)));
/** Throws when a Managed Payments form carries a forbidden key (the guard behind MANAGED_PATH.sessionForm). Returns the form unchanged. */
export function assertManagedForm(form: Form): Form {
  const bad = MANAGED_FORBIDDEN.filter((k) => hasKey(form, k));
  if (bad.length) throw new Error(`managed_forbidden_param:${bad.join(",")}`);
  return assertNoNeverKeys(form);
}
/** Throws when a direct form carries a forbidden key (DIRECT_FORBIDDEN or NEVER_FORBIDDEN). Returns the form unchanged. */
export function assertDirectForm(form: Form): Form {
  const bad = DIRECT_FORBIDDEN.filter((k) => hasKey(form, k));
  if (bad.length) throw new Error(`direct_forbidden_param:${bad.join(",")}`);
  return assertNoNeverKeys(form);
}
export function assertNoNeverKeys(form: Form): Form {
  const bad = NEVER_FORBIDDEN.filter((k) => hasKey(form, k));
  if (bad.length) throw new Error(`forbidden_param:${bad.join(",")}`);
  return form;
}
export const pathOf = (kind: SellerKind): SellerPath => kind === "link" ? MANAGED_PATH : DIRECT_PATH;
/** The one place a Checkout Session request body is built: createCheckoutSession sends exactly this. Both paths are guarded. */
export const sessionParams = (seller: SellerKind, i: SessionInput): Form => assertNoNeverKeys(pathOf(seller).sessionForm(i));
