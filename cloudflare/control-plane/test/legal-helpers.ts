// SPDX-License-Identifier: AGPL-3.0-or-later
// A valid clickwrap consent body, built the way the portal builds it (from the control plane's own disclosure, and, when given, the
// Stripe Tax quote the page showed next to the boxes).
import { env } from "cloudflare:workers";
import { currentVersions, SCREEN_VERSION, type ConsentInput, type TaxQuoteRow } from "../src/legal-flows";
import { langOf, renderDisclosure } from "../src/checkout-strings";
import { isConsumerWithdrawalCountry } from "../src/checkout-policy";
import { MANAGED_QUOTE_SOURCE, sellerFor, sellerSettings, type SellerKind } from "../src/seller";
import type { Plan } from "../src/b5-config";
import { issueDisclosureToken, renewalSha256 } from "../src/disclosure-token";

/** Kept so every test file's request helper still calls it: since r13 a consent carries no quote, so there is nothing to seed. */
export async function seedPendingQuotes(): Promise<void> { /* no quotes */ }

/** The environment whose seller settings (CLOUD_NONUS_SELLER, FERROX_TAX_COUNTRIES) decide which path a consent is built for. A test file that
 *  changes them sends the same environment here. */
let sellerEnv: () => unknown = () => env;
export const useSellerEnv = (f: () => unknown) => { sellerEnv = f; };

/** A valid consent body the way the r13 page builds it: the server's own disclosure for the declared country, the one-button booleans, the
 *  early-start line for a listed country. `quote` is accepted for old callers: a Managed Payments quote marks the Link path; nothing else of it is used. */
export function consentFor(plan: Plan | string, now: number, over: Partial<ConsentInput> = {}, quote: TaxQuoteRow | null = null): ConsentInput {
  const billing = (over.billingCountry ?? over.declaredCountry ?? "US").toUpperCase();
  const declared = (over.declaredCountry ?? billing).toUpperCase();
  const language = over.checkoutLanguage ?? "en";
  let seller: SellerKind;
  if (quote) seller = quote.source === MANAGED_QUOTE_SOURCE ? "link" : "ferrox";
  else { try { seller = sellerFor(sellerSettings(sellerEnv()), declared); } catch { seller = "ferrox"; } }
  const siteLanguage = over.siteLanguage ?? langOf(language);
  const d = renderDisclosure(plan as Plan, declared, siteLanguage, seller, language);
  const early = over.earlyStart ?? isConsumerWithdrawalCountry(declared);
  const body: ConsentInput = { termsAccepted: true, recurringAuthorized: true, earlyStart: early, billingCountry: billing, declaredCountry: declared, checkoutLanguage: language,
    siteLanguage, renewalText: d.renewalText, screenVersion: SCREEN_VERSION, documentVersions: currentVersions(),
    client: { ip: "198.51.100.7", ipSource: "x-forwarded-for", userAgent: "vitest-browser/1" },
    ...(over.postalCode ? { postalCode: over.postalCode } : {}), ...over };
  // WP4 r2-3: the token GET /v1/legal/disclosure would have issued at `now` for exactly what this body says the page showed (a test that
  // overrides renewalText, siteLanguage ... in `over` gets a token for those; one that edits the body afterwards keeps the old token).
  if (over.disclosureToken === undefined) body.disclosureToken = disclosureTokenFor(plan as Plan, body, seller, now);
  return body;
}
/** The disclosure token for a consent body's page fields, as GET /v1/legal/disclosure issues it at `issuedAt`. */
export function disclosureTokenFor(plan: Plan, c: Pick<ConsentInput, "declaredCountry" | "siteLanguage" | "checkoutLanguage" | "renewalText" | "screenVersion">,
  seller: SellerKind, issuedAt: number): string {
  const r = renderDisclosure(plan, c.declaredCountry, c.siteLanguage, seller, c.checkoutLanguage);
  return issueDisclosureToken(env, { screenVersion: c.screenVersion, siteLanguage: c.siteLanguage, declaredCountry: r.declaredCountry, path: r.path, locale: r.locale,
    renewalText: c.renewalText }, issuedAt);
}
export async function latestConsentId(homeId: string): Promise<string> {
  return (await env.DB.prepare("SELECT id FROM checkout_consents WHERE home_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(homeId).first<{ id: string }>())!.id;
}
export const getQuote = (id: string) => env.DB.prepare("SELECT * FROM tax_quotes WHERE id=?").bind(id).first<TaxQuoteRow>();

/** A completed checkout session as our checkout really issues it since 2026-10-14 (Astra DROPDOWN-DIRECT-1 (1)): a fixture can no longer
 *  send a pre-change session (dropdown, no hash) for a consent written by the current code, since only a consent WITHOUT Stripe-page
 *  provenance is ever judged by the old rule. For the consent the merged metadata names (this home's), the session gets what our server sends
 *  and Stripe reports: metadata plan, price_id, seller and renewal_sha256 (the test's own metadata still wins), Stripe's `created` second
 *  (the consent's), the Managed Payments dropdown answered (none on the direct path) unless the test sets custom_fields, and its REAL line
 *  item registered in `retrievable` (unless the test registered one). An UNUSED consent (not completed, not rejected) is bound to the
 *  fixture's session id, as if the fake had issued that id; a used one keeps its binding (a second session for it is a different order). */
export async function boundSession(base: Record<string, unknown>, over: Record<string, unknown>, retrievable: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rec = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const merged = { ...rec(base.metadata), ...rec(over.metadata) };
  const id = String(over.id ?? base.id);
  const c = typeof merged.consent_id === "string" ? await env.DB.prepare("SELECT * FROM checkout_consents WHERE id=?").bind(merged.consent_id)
    .first<{ id: string; home_id: string; plan: string; renewal_text: string; stripe_price_id: string | null; price_cents: number; created_at: number;
      tax_source: string | null; completed_at: number | null; rejected_at: number | null; stripe_session_id: string | null }>() : null;
  if (!c || (merged.home_id !== undefined && merged.home_id !== c.home_id)) return { ...base, ...over, metadata: merged };
  const seller = c.tax_source === MANAGED_QUOTE_SOURCE ? "link" : "ferrox";
  if (c.completed_at === null && c.rejected_at === null && c.stripe_session_id !== id)
    await env.DB.prepare("UPDATE checkout_consents SET stripe_session_id=? WHERE id=?").bind(id, c.id).run();
  const path = `/v1/checkout/sessions/${id}/line_items`;
  retrievable[path] ??= { object: "list", has_more: false, data: [{ object: "item", quantity: 1,
    price: { id: c.stripe_price_id, currency: "usd", unit_amount: c.price_cents, recurring: { interval: "month", interval_count: 1 } } }] };
  const bound = { plan: c.plan, price_id: c.stripe_price_id ?? undefined, seller, renewal_sha256: renewalSha256(c.renewal_text) };
  return { ...base, created: Math.floor(c.created_at / 1000), custom_fields: seller === "link" ? RENEWAL_ANSWERED : undefined, ...over,
    metadata: { ...rec(base.metadata), ...bound, ...rec(over.metadata) } };
}
const RENEWAL_ANSWERED = [{ key: "renewalconsent", type: "dropdown", dropdown: { value: "renewalyes" } }];
