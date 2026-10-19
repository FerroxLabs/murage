// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP4: POST /v1/billing/checkout with the r13 consent (declared country, confirmed language, the one button), the audited
// country switch, the server-owned disclosure, and the new fields on the order and cloud summaries. Real workerd + D1; Stripe is a fixture.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { fakeProvider, type ProviderAdapter } from "../src/b3-provider";
import type { BillingDependencies } from "../src/b5-billing";
import { currentPolicyVersion, setCountrySwitch, POLICY_VERSION, BUTTON_WORDS } from "../src/checkout-policy";
import { buildConfirmationEmail, latestAcceptance, recordAcceptanceAtCompletion, SCREEN_VERSION, WORDING, type ConsentRow } from "../src/legal-flows";
import { LEGAL_DOCS } from "../src/legal-docs.generated";
import { consentFor, disclosureTokenFor, useSellerEnv } from "./legal-helpers";
import { issueDisclosureToken } from "../src/disclosure-token";
import m0067 from "../migrations/0067_checkout_start_request.sql?raw";
import m0068 from "../migrations/0068_checkout_shown_words.sql?raw";
import { applyCustomerForm, customerFake } from "./stripe-customer-fake";

const ADMIN = "test-only-b5-admin-no-real-access";
const NOW = 1_800_000_000_000;
const USER = "wp4-user";
const IMAGE = `sha256:${"a".repeat(64)}`;
const B3 = { reservationMs: 30 * 60_000, graceMs: 3 * 86_400_000, retentionMs: 14 * 86_400_000, imageDigest: IMAGE, quarantineRelayIP: "192.0.2.20",
  engineSubscriptionGates: { claudeAgent: true, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: true },
  capacity: [1, 2].map((n) => ({ id: `slot-${n}`, projectId: "p1", location: "fsn1", serverType: "cx23", outcome: "available" })) };
let envOver: Partial<Env> = {};
const baseEnv = (): Env => ({ ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: btoa("x".repeat(32)), CLOUD_B3_MODE: "fake", CLOUD_B3_CONFIG: JSON.stringify(B3),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access",
  STRIPE_SECRET_KEY: "sk_test_fixturefixturefixture", STRIPE_WEBHOOK_SECRET: "whsec_testonlyfixturesecret0123456789", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  STRIPE_PRICE_STARTER: "price_starter0001", STRIPE_PRICE_PRO: "price_pro00000001", STRIPE_PRICE_MAX: "price_max000000001", ...envOver } as unknown as Env);
const DIRECT_EVERYWHERE = { CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US,DE,AT,FR,GB,CH,CA" } as Partial<Env>;

interface Call { method: string; path: string; form: URLSearchParams }
let calls: Call[]; let signedIn: string | null; let stripeDown = false;
const cust = customerFake();
const stripeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  // The customer preset (Astra TAXCOUNTRY-1): customers persisted by a shared fake.
  { const cr = await cust.handle(init?.method ?? "GET", new URL(String(input)), new URLSearchParams(String(init?.body ?? ""))); if (cr) return cr; }
  const url = new URL(String(input)); const method = init?.method ?? "GET";
  calls.push({ method, path: url.pathname, form: new URLSearchParams(String(init?.body ?? "")) });
  const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  if (stripeDown && url.pathname === "/v1/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ error: { type: "api_error", message: "down" } }), { status: 500 });
  // Stripe keeps the address a customer is created with (the required preset then reads it back; Astra TAXCOUNTRY-2).
  if (url.pathname === "/v1/customers") { cust.customers.cus_wp4 = applyCustomerForm({}, new URLSearchParams(String(init?.body ?? ""))); return j({ id: "cus_wp4" }); }
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") return j({ data: [] });
  if (url.pathname === "/v1/checkout/sessions") return j({ id: `cs_test_${calls.filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST").length}`, url: "https://checkout.stripe.test/c/x" });
  // Finish checkout (WP4 r1): a session's live state, expiring one, and the price the consent was sold at.
  if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(url.pathname)) return j({ id: url.pathname.split("/")[4], status: "expired" });
  if (url.pathname.startsWith("/v1/checkout/sessions/")) return j({ id: url.pathname.split("/")[4], status: "open" });
  if (url.pathname.startsWith("/v1/prices/")) {
    const id = url.pathname.split("/")[3];
    const cents: Record<string, number> = { price_starter0001: 4900, price_pro00000001: 9900, price_max000000001: 19900 };
    return j({ id, active: true, unit_amount: cents[id], currency: "usd", recurring: { interval: "month", interval_count: 1 } });
  }
  return new Response("{}", { status: 500 });
};
const deps = (): BillingDependencies => ({ stripeFetch, accountUser: async () => (signedIn ? { id: signedIn } : null), stepUp: async () => true, now: () => NOW });
const provider = (db: D1Database): ProviderAdapter => fakeProvider(db);
async function call(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await createWorker(fetch, fetch, { provider }, {}, deps()).fetch(new Request(`https://admin.murage.test${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...headers } }), baseEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const reserve = async () => ((await (await call("/v1/billing/reserve", "POST", {})).json()) as { homeId: string }).homeId;
const checkout = (consent: unknown, plan = "pro") => call("/v1/billing/checkout", "POST", { plan, consent });
const sessionCalls = () => calls.filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST");
const one = <T,>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) => (await one<{ n: number }>(sql, ...args))!.n;
const consentRow = (homeId: string) => one<Record<string, string | number | null>>("SELECT * FROM checkout_consents WHERE home_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", homeId);

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW); calls = []; signedIn = USER; envOver = {}; stripeDown = false;
  useSellerEnv(() => baseEnv());
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'W',?,1,?,?)`).bind(USER, `${USER}@example.test`, NOW, NOW).run();
});
afterEach(() => { vi.restoreAllMocks(); useSellerEnv(() => env); });

describe("Test 1: the locale and the words, end to end through the route", () => {
  // [declared country, language the client sent, locale Stripe must get, the button words stored]
  const rows: Array<[string, string, string, string | null]> = [
    ["DE", "de", "de", "Zahlungspflichtig abonnieren"], ["DE", "en", "de", "Zahlungspflichtig abonnieren"], ["AT", "en", "de", "Zahlungspflichtig abonnieren"],
    ["FR", "fr", "fr", "S'abonner"], ["FR", "de", "de", "Zahlungspflichtig abonnieren"], ["GB", "en", "en", "Subscribe"], ["CH", "fr", "fr", "S'abonner"],
    ["US", "de", "de", "Zahlungspflichtig abonnieren"], ["US", "en", "en", "Subscribe"],
    // a Stripe locale outside the 26 we rendered: sent as is, button words unknown (null), consent still valid; a locale Stripe lacks falls back to en
    ["US", "ja", "ja", null], ["US", "xx", "en", "Subscribe"],
  ];
  for (const [country, language, locale, words] of rows) {
    it(`${country} + ${language} sends ${locale}`, async () => {
      const homeId = await reserve();
      const res = await checkout(consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: language }));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["consentId", "locale", "policyVersion", "sessionId", "url"]);
      expect(body).toMatchObject({ locale, policyVersion: POLICY_VERSION, sessionId: "cs_test_1" });
      // Stripe got exactly that locale
      expect(sessionCalls()).toHaveLength(1);
      expect(sessionCalls()[0].form.get("locale")).toBe(locale);
      // the consent stores the locale actually sent, the declared country, the words and the policy version, and the press time
      const c = (await consentRow(homeId))!;
      expect(c).toMatchObject({ declared_country: country, billing_country: country, checkout_language: locale, button_text: words, policy_version: POLICY_VERSION,
        start_request_at: NOW, start_at: NOW, first_charge_at: NOW, delayed_start: 0, screen_version: SCREEN_VERSION, quote_id: null });
      expect(c.site_language).toBe(language === "de" ? "de" : "en");
      if (words !== null) expect(words).toBe(BUTTON_WORDS[locale]);
    });
  }

  it("the sent locale is part of the fingerprint: the same choices reuse the session, another language does not", async () => {
    const homeId = await reserve();
    const fr = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" });
    const first = await (await checkout(fr)).json() as { sessionId: string; reused?: boolean };
    const again = await (await checkout(fr)).json() as { sessionId: string; reused?: boolean; locale: string; policyVersion: string };
    expect(again).toMatchObject({ sessionId: first.sessionId, reused: true, locale: "fr", policyVersion: POLICY_VERSION });
    expect(sessionCalls()).toHaveLength(1);
    const de = await (await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "de" }))).json() as { reused?: boolean; locale: string };
    expect(de).toMatchObject({ locale: "de" }); expect(de.reused).toBeUndefined();
    expect(sessionCalls()).toHaveLength(2);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(2);
  });

  it("FR + de gets the same price and terms as DE", async () => {
    const run = async (country: string, user: string) => {
      signedIn = user;
      const homeId = await reserve();
      expect((await checkout(consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: "de" }))).status).toBe(200);
      const form = sessionCalls().at(-1)!.form; const c = (await consentRow(homeId))!;
      return { price: form.get("line_items[0][price]"), locale: form.get("locale"), priceCents: c.price_cents, terms: [c.cloud_terms_version, c.tos_version, c.privacy_version], early: c.early_start,
        button: c.button_text, lang: c.checkout_language };
    };
    await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('wp4-other','W','wp4-other@example.test',1,?,?)`).bind(NOW, NOW).run();
    const de = await run("DE", USER); const fr = await run("FR", "wp4-other");
    expect(fr).toEqual(de);
    expect(fr).toMatchObject({ locale: "de", price: "price_pro00000001", priceCents: 9900, early: 1 });
  });
});

describe("the country switch", () => {
  it("a paused country is refused with 409 country_paused before any write; the other countries still buy", async () => {
    const homeId = await reserve();
    await setCountrySwitch(env, { country: "FR", state: "paused", reason: "a regulator's letter, test" }, NOW);
    const paused = await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" }));
    expect(paused.status).toBe(409); expect(await paused.json()).toEqual({ error: "country_paused" });
    expect(calls.filter((c) => c.path !== "/v1/billing/reserve")).toEqual([]);   // no customer, no session
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM open_checkouts WHERE home_id=?", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE home_id=?", homeId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM billing_home_leases WHERE home_id=?", homeId)).toBe(0);   // r1-8: not even a lease
    expect(await count("SELECT COUNT(*) AS n FROM billing_home_leases")).toBe(0);
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en" }))).status).toBe(200);
    // the policy version in the consent is the one in force (the pause bumped it)
    expect((await consentRow(homeId))!.policy_version).toBe(await currentPolicyVersion(env));
    expect((await consentRow(homeId))!.policy_version).toBe(`${POLICY_VERSION}+s1`);
  });
  it("opening it again lets the same consent through", async () => {
    await reserve();
    await setCountrySwitch(env, { country: "FR", state: "paused", reason: "a regulator's letter, test" }, NOW);
    const consent = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" });
    expect((await checkout(consent)).status).toBe(409);
    await setCountrySwitch(env, { country: "FR", state: "open", reason: "letter answered, test" }, NOW);
    expect((await checkout(consent)).status).toBe(200);
  });
});

describe("declared country, early start and the shown text", () => {
  it("billingCountry must equal declaredCountry: 400 declared_country_mismatch, nothing written", async () => {
    const homeId = await reserve();
    const res = await checkout(consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "AT", checkoutLanguage: "de" }));
    expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: "declared_country_mismatch" });
    expect(sessionCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
  });
  it("a declared FR without the EU line is refused 409 early_start_required, with or without earlyStart:false", async () => {
    const homeId = await reserve();
    for (const early of [undefined, false]) {
      const c = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" });
      if (early === undefined) delete (c as { earlyStart?: boolean }).earlyStart; else c.earlyStart = early;
      const res = await checkout(c);
      expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "early_start_required" });
    }
    expect(sessionCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
  });
  it("every listed country needs it; an unlisted one ignores it", async () => {
    await reserve();
    for (const country of ["GB", "NO", "IS", "LI", "DE", "ES"]) {
      const c = consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: "en", earlyStart: false });
      expect((await checkout(c)).status, country).toBe(409);
    }
    // US with earlyStart:true and a US renewalText: accepted, recorded false
    const us = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en", earlyStart: true });
    expect((await checkout(us)).status).toBe(200);
  });
  it("earlyStart:true with a renewalText that lacks the EU line is a stale screen (409 disclosure_stale)", async () => {
    await reserve();
    const us = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en" });
    const fr = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "en" });
    const res = await checkout({ ...fr, renewalText: us.renewalText });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "disclosure_stale" });
    // and an EU line shown for a US customer is stale too
    expect((await checkout({ ...us, renewalText: fr.renewalText })).status).toBe(409);
  });
  it("renewalText must match byte for byte, for the declared country, the path and the language", async () => {
    await reserve();
    const base = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en" });
    for (const text of [base.renewalText + " ", base.renewalText.replace("US$99", "US$98"), base.renewalText.toLowerCase(), "", base.renewalText.split("\n").slice(1).join("\n"),
      consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de" }).renewalText]) {
      const res = await checkout({ ...base, renewalText: text });
      expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "disclosure_stale" });
    }
    // another plan's text, an old screen version, and old document versions
    expect((await checkout({ ...base, renewalText: consentFor("max", NOW, { declaredCountry: "US", billingCountry: "US" }).renewalText })).status).toBe(409);
    expect((await checkout({ ...base, screenVersion: "checkout-clickwrap-2026-10-11.1" })).status).toBe(409);
    expect((await checkout({ ...base, documentVersions: { ...base.documentVersions, cloudTerms: "old" } })).status).toBe(409);
    expect(sessionCalls()).toHaveLength(0);
    expect((await checkout(base)).status).toBe(200);
  });
  it("the managed path's text is not accepted on the direct path and the reverse", async () => {
    await reserve();
    const managed = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "en" });   // default env: FR is Link
    expect(managed.renewalText).toContain("\n");
    envOver = DIRECT_EVERYWHERE; useSellerEnv(() => baseEnv());
    const stale = await checkout(managed);
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "disclosure_stale" });
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "en" }))).status).toBe(200);
  });
  it("the one button needs both booleans (400 consent_required); quoteId and postalCode are optional and a quoteId is ignored", async () => {
    await reserve();
    const base = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" });
    expect((await checkout({ ...base, termsAccepted: false })).status).toBe(400);
    expect((await checkout({ ...base, recurringAuthorized: false })).status).toBe(400);
    expect((await checkout({ ...base, declaredCountry: undefined })).status).toBe(400);
    expect((await checkout({ ...base, quoteId: "quote-does-not-exist", postalCode: "10001" })).status).toBe(200);
  });
  it("a country nobody may sell to is 409 tax_unavailable (unchanged)", async () => {
    await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "BR", billingCountry: "BR" }))).status).toBe(409);
  });
});

describe("top-up", () => {
  it("is off by default and opt-in; the stored charge text is the server's, in the site language", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    expect(await consentRow(homeId)).toMatchObject({ topup_enabled: 0, topup_text: null });
    const on = { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 };
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", topup: on }))).status).toBe(200);
    expect((await consentRow(homeId))!.topup_text).toBe("When my Flux balance falls below $5, I authorize Ferrox Labs, LLC to charge my payment method $20 plus tax where it applies for $20 of Flux credits, up to $100 per calendar month. The cap resets at 00:00 UTC on the first day of each month. It covers automatic top-up charges only, not my plan or manual purchases.");
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "de", topup: on }))).status).toBe(200);
    const de = (await consentRow(homeId))!;
    expect(de.site_language).toBe("de");
    expect(de.topup_text).toContain("$20 zzgl. Steuern, wo sie anfallen");
    expect(de.topup_text).not.toContain("${");
  });
  it("is refused on the Managed Payments path: 409 topup_not_available", async () => {
    const homeId = await reserve();
    const res = await checkout(consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", topup: { enabled: true, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } }));
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "topup_not_available" });
    expect(sessionCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
    // a disabled top-up block on MP is fine
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", topup: { enabled: false, amountUsd: 20, thresholdUsd: 5, capUsd: 100 } }))).status).toBe(200);
  });
});

describe("the Stripe session", () => {
  it("direct: the submit text links to the marketing site's pages, never the cloud origin; managed carries no custom_text", async () => {
    await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    const text = sessionCalls()[0].form.get("custom_text[submit][message]")!;
    for (const path of ["cloud-terms", "terms-of-service", "privacy-policy"]) expect(text).toContain(`(https://murage.ai/${path})`);
    expect(text).not.toContain("cloud.murage.test");
    expect([...sessionCalls()[0].form.keys()].some((k) => k.startsWith("subscription_data[trial"))).toBe(false);
    envOver = { CHECKOUT_SITE_ORIGIN: "https://staging.murage.ai" } as Partial<Env>;
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id IN (SELECT id FROM cloud_homes WHERE owner_id=?)").bind(USER).run();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "fr" }))).status).toBe(200);
    expect(sessionCalls()[1].form.get("custom_text[submit][message]")).toContain("(https://staging.murage.ai/cloud-terms)");
    envOver = {}; calls = [];
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id IN (SELECT id FROM cloud_homes WHERE owner_id=?)").bind(USER).run();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de" }))).status).toBe(200);
    expect([...sessionCalls()[0].form.keys()].filter((k) => k.startsWith("custom_text"))).toEqual([]);
    expect(sessionCalls()[0].form.get("managed_payments[enabled]")).toBe("true");
  });
});

describe("GET /v1/legal/disclosure (r13, no tax quote)", () => {
  const get = async (qs: string) => { const res = await call(`/v1/legal/disclosure?${qs}`, "GET"); return { status: res.status, body: await res.json() as Record<string, any> }; };
  it("US direct in en: price, renewal, refund, acceptance; no eu, mp or deat", async () => {
    const { status, body } = await get("plan=pro&declaredCountry=US&checkoutLanguage=en&locale=en");
    expect(status).toBe(200);
    expect(Object.keys(body.disclosure).sort()).toEqual(["declaredCountry", "lines", "locale", "path", "renewalText", "screenVersion", "token"]);
    expect(body.disclosure).toMatchObject({ screenVersion: SCREEN_VERSION, declaredCountry: "US", locale: "en", path: "direct" });
    expect(Object.keys(body.disclosure.lines)).toEqual(["price", "renewal", "refund", "acceptance"]);
    expect(body.disclosure.lines.price).toBe("Pro: US$99 a month plus tax");
    expect(body.disclosure.renewalText).toBe(Object.values(body.disclosure.lines).join("\n"));
    expect(body.tax).toBeNull();
    expect(body.seller).toBe("ferrox");
  });
  it("FR managed: mp and eu lines present in order; DE adds deat; the German locale forces de", async () => {
    const fr = (await get("plan=pro&declaredCountry=FR&checkoutLanguage=fr&locale=en")).body;
    expect(Object.keys(fr.disclosure.lines)).toEqual(["price", "renewal", "refund", "mp", "eu", "acceptance"]);
    expect(fr.disclosure).toMatchObject({ path: "managed", locale: "fr" });
    expect(fr.disclosure.renewalText).toBe(Object.values(fr.disclosure.lines).join("\n"));
    expect(fr.seller).toBe("link"); expect(fr.topupAvailable).toBe(false); expect(fr.wording.authorization).toContain("Link");
    const de = (await get("plan=pro&declaredCountry=DE&checkoutLanguage=en&locale=en")).body;
    expect(Object.keys(de.disclosure.lines)).toEqual(["price", "renewal", "refund", "mp", "eu", "deat", "acceptance"]);
    expect(de.disclosure.locale).toBe("de");
    const deDe = (await get("plan=pro&declaredCountry=AT&checkoutLanguage=en&locale=de")).body;
    expect(deDe.disclosure.lines.deat).not.toBe(de.disclosure.lines.deat);          // the explanation is in the site language
    expect(deDe.disclosure.lines.price).not.toBe(de.disclosure.lines.price);
    expect(deDe.disclosure.locale).toBe("de");
  });
  it("direct outside the US (CLOUD_NONUS_SELLER=direct): eu line without the mp line", async () => {
    envOver = DIRECT_EVERYWHERE;
    const gb = (await get("plan=pro&declaredCountry=GB&checkoutLanguage=en&locale=en")).body;
    expect(Object.keys(gb.disclosure.lines)).toEqual(["price", "renewal", "refund", "eu", "acceptance"]);
    expect(gb.disclosure.path).toBe("direct");
  });
  it("renewalText is what checkout compares: sending it back verbatim is accepted", async () => {
    await reserve();
    for (const [country, language, locale] of [["US", "en", "en"], ["DE", "en", "de"], ["FR", "fr", "en"], ["AT", "de", "de"]]) {
      const { body } = await get(`plan=pro&declaredCountry=${country}&checkoutLanguage=${language}&locale=${locale}`);
      const c = consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: language, siteLanguage: locale as "en" | "de" });
      const res = await checkout({ ...c, renewalText: body.disclosure.renewalText, screenVersion: body.disclosure.screenVersion });
      expect(res.status, country).toBe(200);
      await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id IN (SELECT id FROM cloud_homes WHERE owner_id=?)").bind(USER).run();
    }
  });
  it("carries the top-up wording in en and de, filled with the amount, and never in renewalText", async () => {
    const en = (await get("plan=pro&declaredCountry=US&locale=en&topupAmountUsd=50")).body;
    expect(en.wording.topupBox).toContain("add $50 whenever my balance falls below $5, up to a monthly cap of $100");
    expect(en.wording.topupCharge).toContain("charge my payment method $50 plus tax where it applies for $50 of Flux credits");
    const de = (await get("plan=pro&declaredCountry=US&locale=de")).body;
    expect(de.wording.topupBox).toContain("$20 hinzufügen, sobald mein Guthaben unter $5 fällt");
    expect(de.wording.topupCharge).toContain("mit $20 zzgl. Steuern, wo sie anfallen für Flux-Guthaben im Wert von $20 zu belasten");
    for (const b of [en, de]) { expect(b.wording.topupBox + b.wording.topupCharge).not.toContain("${"); expect(b.disclosure.renewalText).not.toMatch(/Flux/); }
    // without a country the answer still has the wording (and no disclosure box)
    const bare = (await get("plan=pro&locale=de")).body;
    expect(bare.disclosure).toBeUndefined(); expect(bare.wording.topupBox).toContain("Meine Flux-Guthaben");
    expect((await get("plan=pro&topupAmountUsd=3")).status).toBe(400);
    expect((await get("plan=pro&declaredCountry=XYZ")).status).toBe(400);
    expect((await get("plan=pro&declaredCountry=BR")).status).toBe(409);
  });
});

describe("order and cloud summaries", () => {
  it("GET /v1/account/order carries currentPeriodEnd (null before a payment, Stripe's current_period_end after)", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    const before = await (await call(`/v1/account/order?home=${homeId}`, "GET")).json() as Record<string, unknown>;
    expect(before).toHaveProperty("currentPeriodEnd", null);
    await env.DB.prepare("UPDATE billing_subscriptions SET current_period_end=? WHERE home_id=?").bind(NOW + 30 * 86_400_000, homeId).run();
    // r1-7: the period belongs to this order only once the subscription is the one its own checkout created
    expect((await (await call(`/v1/account/order?home=${homeId}`, "GET")).json() as Record<string, unknown>).currentPeriodEnd).toBeNull();
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_wp4' WHERE home_id=?").bind(homeId).run();
    await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id='sub_wp4' WHERE home_id=?").bind(homeId).run();
    const after = await (await call(`/v1/account/order?home=${homeId}`, "GET")).json() as Record<string, unknown>;
    expect(after.currentPeriodEnd).toBe(NOW + 30 * 86_400_000);
  });
  it("GET /v1/account/cloud carries billingCountry and country (null before a confirmed payment)", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" }))).status).toBe(200);
    const before = await (await call("/v1/account/cloud", "GET")).json() as Record<string, unknown>;
    expect(before).toMatchObject({ billingCountry: null, country: null });
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=?, effective_country='fr', stripe_subscription_id='sub_wp4fr' WHERE home_id=?").bind(NOW, homeId).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_wp4fr', status='incomplete' WHERE home_id=?").bind(homeId).run();
    // r1-6: completed but not paid (an asynchronous payment still processing) is not a confirmed payment: no pre-fill
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ billingCountry: null, country: null });
    // r2-5: the payment evidence is on the consent (WP5 writes it from the signed webhook through recordConsentPaid)
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active', first_paid_at=? WHERE home_id=?").bind(NOW, homeId).run();
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ billingCountry: null, country: null });
    await env.DB.prepare("UPDATE checkout_consents SET paid_at=? WHERE home_id=?").bind(NOW + 1000, homeId).run();   // what WP5's webhook writes
    const after = await (await call("/v1/account/cloud", "GET")).json() as Record<string, unknown>;
    expect(after).toMatchObject({ billingCountry: "FR", country: "FR" });
  });
});

describe("WP4 r1-5: the page language is declared, never inferred", () => {
  it("siteLanguage is required; the other language's text for the same country is refused (no either-language acceptance)", async () => {
    const homeId = await reserve();
    const en = consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", siteLanguage: "en" });
    const de = consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", siteLanguage: "de" });
    expect(en.renewalText).not.toBe(de.renewalText);
    const { siteLanguage: _drop, ...missing } = en; void _drop;
    expect((await checkout(missing)).status).toBe(400);
    expect((await checkout({ ...en, siteLanguage: "fr" })).status).toBe(400);
    for (const swapped of [{ ...en, renewalText: de.renewalText }, { ...de, renewalText: en.renewalText }]) {
      const res = await checkout(swapped);
      expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: "disclosure_stale" });
    }
    expect(sessionCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
    expect((await checkout(en)).status).toBe(200);
    expect((await consentRow(homeId))!.site_language).toBe("en");
  });
  it("GET /v1/legal/disclosure takes siteLanguage (locale is an alias, unknown params ignored); the consent passes only with the same siteLanguage", async () => {
    await reserve();
    const q = "plan=pro&declaredCountry=AT&checkoutLanguage=en";
    const de = (await (await call(`/v1/legal/disclosure?${q}&siteLanguage=de&utm_source=x&whatever=1`, "GET")).json()) as Record<string, any>;
    const alias = (await (await call(`/v1/legal/disclosure?${q}&locale=de`, "GET")).json()) as Record<string, any>;
    const en = (await (await call(`/v1/legal/disclosure?${q}&siteLanguage=en`, "GET")).json()) as Record<string, any>;
    expect(de.disclosure.renewalText).toBe(alias.disclosure.renewalText);
    expect(de.disclosure.lines.price).toBe("Pro: 99 US$ pro Monat zzgl. Steuern");
    expect(en.disclosure.lines.price).toBe("Pro: US$99 a month plus tax");
    const base = consentFor("pro", NOW, { declaredCountry: "AT", billingCountry: "AT", checkoutLanguage: "en" });
    expect((await checkout({ ...base, siteLanguage: "en", renewalText: de.disclosure.renewalText, disclosureToken: de.disclosure.token })).status).toBe(409);
    expect((await checkout({ ...base, siteLanguage: "de", renewalText: de.disclosure.renewalText, disclosureToken: de.disclosure.token })).status).toBe(200);
  });
});

describe("WP4 r2-3: the page language is bound by the server's disclosure token", () => {
  const disclose = async (qs: string) => ((await (await call(`/v1/legal/disclosure?${qs}`, "GET")).json()) as { disclosure: { renewalText: string; token: string } }).disclosure;
  const refused = async (body: unknown) => {
    const res = await checkout(body);
    expect([res.status, await res.json()]).toEqual([409, { error: "disclosure_stale" }]);
  };
  it("a German page's token cannot carry an English consent; missing, forged, foreign-key, expired and other-locale tokens are refused", async () => {
    const homeId = await reserve();
    const q = "plan=pro&declaredCountry=DE&checkoutLanguage=de";
    const de = await disclose(`${q}&siteLanguage=de`);
    const en = await disclose(`${q}&siteLanguage=en`);
    const base = consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", siteLanguage: "de" });
    // the page showed German: relabelling it English (with the English text, which the old check accepted) is refused
    await refused({ ...base, siteLanguage: "en", renewalText: en.renewalText, disclosureToken: de.token });
    await refused({ ...base, disclosureToken: en.token });                                   // a token for another rendering
    const { disclosureToken: _t, ...missing } = base; void _t;
    await refused(missing);
    const [body, sig] = de.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), siteLanguage: "en" })).toString("base64url");
    await refused({ ...base, siteLanguage: "en", renewalText: en.renewalText, disclosureToken: `${forged}.${sig}` });
    await refused({ ...base, disclosureToken: `${body}.${"A".repeat(43)}` });
    await refused({ ...base, disclosureToken: issueDisclosureToken({ CHECKOUT_DISCLOSURE_TOKEN_SECRET: "another-key-another-key-another-key-0001" },
      { screenVersion: SCREEN_VERSION, siteLanguage: "de", declaredCountry: "DE", path: "managed", locale: "de", renewalText: de.renewalText }, NOW) });
    await refused({ ...base, disclosureToken: disclosureTokenFor("pro", base, "link", NOW - 24 * 3_600_000 - 1) });   // older than 24 h
    // the Stripe locale is bound too: a French page token (FR, Stripe fr) does not carry a consent for Stripe en, though the text is the same
    const fr = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr", siteLanguage: "en" });
    expect(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "en", siteLanguage: "en" }).renewalText).toBe(fr.renewalText);
    await refused({ ...fr, checkoutLanguage: "en" });
    expect(sessionCalls()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
    // the genuine token for the page shown, within 24 h
    expect((await checkout({ ...base, disclosureToken: disclosureTokenFor("pro", base, "link", NOW - 23 * 3_600_000) })).status).toBe(200);
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
    expect((await checkout({ ...base, renewalText: de.renewalText, disclosureToken: de.token })).status).toBe(200);
    expect((await consentRow(homeId))!.site_language).toBe("de");
  });
  it("without the secret neither a token nor a checkout exists (503 disclosure_key_missing)", async () => {
    await reserve();
    const body = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" });
    envOver = { CHECKOUT_DISCLOSURE_TOKEN_SECRET: undefined } as unknown as Partial<Env>;
    for (const res of [await call("/v1/legal/disclosure?plan=pro&declaredCountry=US&siteLanguage=en", "GET"), await checkout(body)]) {
      expect([res.status, await res.json()]).toEqual([503, { error: "disclosure_key_missing" }]);
    }
    expect(sessionCalls()).toHaveLength(0);
  });
});

describe("WP4 r1-3: the record holds the words shown, in the site language", () => {
  it("stores the shown lines and our button label (en and de); Stripe's button words stay apart; no legacy checkbox wording", async () => {
    const homeId = await reserve();
    const cases: Array<["en" | "de", string, string]> = [["en", "Start my server and continue to payment", "Zahlungspflichtig abonnieren"],
      ["de", "Server starten und weiter zur Zahlung", "Zahlungspflichtig abonnieren"]];
    for (const [site, label, stripeWords] of cases) {
      await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
      const body = consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "en", siteLanguage: site });
      expect((await checkout(body)).status).toBe(200);
      const c = (await consentRow(homeId))!;
      expect(c.start_request_text).toBe(label);
      expect(c.button_text).toBe(stripeWords);
      const wording = JSON.parse(c.wording as string) as Record<string, string>;
      expect(Object.values(wording).join("\n")).toBe(body.renewalText);
      expect(c.wording as string).not.toMatch(/proportionately|I have read and agree|individual arbitration/);
      const disclosure = JSON.parse(c.disclosure as string) as Record<string, unknown>;
      expect(disclosure).toMatchObject({ siteLanguage: site, startRequestText: label, buttonText: stripeWords, renewalText: body.renewalText });
    }
  });
});

describe("WP4 r1-4: the terms are accepted at order completion, not at our button", () => {
  it("checkout stores pending evidence only; an abandoned checkout leaves no acceptance; completion inserts it once", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    const c = (await consentRow(homeId))!;
    expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances")).toBe(0);
    expect(await latestAcceptance(env, USER)).toBeNull();
    // the session expires unused (abandoned): still nothing accepted
    await env.DB.prepare("UPDATE open_checkouts SET state='failed' WHERE home_id=?").bind(homeId).run();
    expect(await count("SELECT COUNT(*) AS n FROM terms_acceptances")).toBe(0);
    expect(await recordAcceptanceAtCompletion(env, c.id as string, NOW + 5000)).toBe(true);
    expect(await recordAcceptanceAtCompletion(env, c.id as string, NOW + 9000)).toBe(false);
    const rows = (await env.DB.prepare("SELECT source,consent_id,accepted_at,wording FROM terms_acceptances").all()).results;
    expect(rows).toEqual([{ source: "checkout", consent_id: c.id, accepted_at: NOW + 5000,
      wording: "You accept the [Murage Cloud terms] and [Terms of Service] when you submit your order on the payment page. [Privacy Policy]." }]);
    // the consent row is not completed yet (WP5 attaches the session in the same handler): not counted until it is
    expect(await latestAcceptance(env, USER)).toBeNull();
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=? WHERE id=?").bind(NOW + 5000, c.id).run();
    expect(await latestAcceptance(env, USER)).toMatchObject({ accepted_at: NOW + 5000 });
  });
  it("a pre-r1 acceptance written at checkout for an order never completed is not an acceptance", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    const c = (await consentRow(homeId))!;
    await env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES ('acc-legacy',?,?,?,?,'checkout',?,'w',?,'{}')`).bind(USER, c.cloud_terms_version, c.tos_version, c.privacy_version, c.id, NOW).run();
    expect(await latestAcceptance(env, USER)).toBeNull();
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ terms: { reacceptRequired: false } });
    // its completion makes it count, and recording at completion adds no second row (r2-2: checkout and completion times differ)
    const DONE = NOW + 7 * 60_000;
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=? WHERE id=?").bind(DONE, c.id).run();
    expect(await recordAcceptanceAtCompletion(env, c.id as string, DONE)).toBe(false);
    // r2-2: the premature row is normalised once to the completion time and the archived acceptance line
    const line = (JSON.parse(c.wording as string) as Record<string, string>).acceptance;
    expect(line).toMatch(/when you submit your order on the payment page/);
    const rows = async () => (await env.DB.prepare("SELECT id,accepted_at,wording FROM terms_acceptances WHERE consent_id=?").bind(c.id).all()).results;
    expect(await rows()).toEqual([{ id: "acc-legacy", accepted_at: DONE, wording: line }]);
    expect(await latestAcceptance(env, USER)).toMatchObject({ accepted_at: DONE });
    // replay idempotent, even a later delivery with another time
    expect(await recordAcceptanceAtCompletion(env, c.id as string, DONE)).toBe(false);
    expect(await recordAcceptanceAtCompletion(env, c.id as string, DONE + 90_000)).toBe(false);
    expect(await rows()).toEqual([{ id: "acc-legacy", accepted_at: DONE, wording: line }]);
  });
  it("r2-2: a pre-r1 consent whose wording has no acceptance line takes it from the archived disclosure", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "DE", billingCountry: "DE", checkoutLanguage: "de", siteLanguage: "de" }))).status).toBe(200);
    const c = (await consentRow(homeId))!;
    const archived = (JSON.parse(c.disclosure as string) as { lines: Record<string, string> }).lines.acceptance;
    await env.DB.prepare("UPDATE checkout_consents SET wording=?, start_request_text=NULL WHERE id=?").bind(JSON.stringify({ terms: WORDING.terms }), c.id).run();
    await env.DB.prepare(`INSERT INTO terms_acceptances (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES ('acc-legacy-de',?,?,?,?,'checkout',?,?,?,'{}')`).bind(USER, c.cloud_terms_version, c.tos_version, c.privacy_version, c.id, WORDING.terms, NOW).run();
    expect(await recordAcceptanceAtCompletion(env, c.id as string, NOW + 3_600_000)).toBe(false);
    expect(await one("SELECT accepted_at,wording FROM terms_acceptances WHERE id='acc-legacy-de'")).toEqual({ accepted_at: NOW + 3_600_000, wording: archived });
    expect(archived).not.toBe(WORDING.terms);
  });
});

describe("WP4 r1-1 / r1-2: Finish checkout re-checks the country switch and the screen before any reuse", () => {
  const resume = () => call("/v1/billing/checkout/resume", "POST", {});
  const bought = async (country: string, language: string) => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: language }))).status).toBe(200);
    calls = [];
    return homeId;
  };
  const openRow = (homeId: string) => one<Record<string, unknown>>("SELECT state,session_id,expires_at FROM open_checkouts WHERE home_id=?", homeId);

  it("a paused country gets no open session back, no replacement and no saved-attempt replay (409 country_paused, nothing written)", async () => {
    const homeId = await bought("FR", "fr");
    expect(await (await resume()).json()).toMatchObject({ reused: true });   // open: the same session (control)
    calls = [];
    await setCountrySwitch(env, { country: "FR", state: "paused", reason: "test" }, NOW);
    const before = await openRow(homeId);
    // r2-4: refused before the lease is taken: the lease row (holder, generation, expiry) is untouched by every refusal below
    const lease = () => env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id=?").bind(homeId).all();
    const leaseBefore = (await lease()).results;
    expect(leaseBefore).toHaveLength(1);
    // 1. the open, unexpired session
    let res = await resume();
    expect([res.status, await res.json()]).toEqual([409, { error: "country_paused" }]);
    expect((await lease()).results).toEqual(leaseBefore);
    // 2. expired: no replacement
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE home_id=?").bind(NOW - 1000, homeId).run();
    res = await resume();
    expect([res.status, await res.json()]).toEqual([409, { error: "country_paused" }]);
    expect(await openRow(homeId)).toEqual({ ...before, expires_at: NOW - 1000 });
    expect((await lease()).results).toEqual(leaseBefore);
    // 3. a saved attempt waiting to be replayed after a crash: not replayed
    const consentId = (await consentRow(homeId))!.id as string;
    await env.DB.prepare("UPDATE open_checkouts SET state='failed',updated_at=? WHERE home_id=?").bind(NOW - 120_000, homeId).run();
    await env.DB.prepare("INSERT INTO checkout_resume_attempts (id,home_id,consent_id,expires_at,payload,state,created_at) VALUES ('att-paused',?,?,?,'{}','creating',?)")
      .bind(homeId, consentId, NOW + 3_600_000, NOW - 60_000).run();
    res = await resume();
    expect([res.status, await res.json()]).toEqual([409, { error: "country_paused" }]);
    expect(await one("SELECT state FROM checkout_resume_attempts WHERE id='att-paused'")).toEqual({ state: "creating" });
    expect((await lease()).results).toEqual(leaseBefore);
    expect(calls).toEqual([]);                                                  // not even a read at Stripe
  });

  it("a quote-free resume keeps the locale the consent was sold with, once the country is open again", async () => {
    const homeId = await bought("US", "fr");                                    // site en, Stripe fr
    await setCountrySwitch(env, { country: "US", state: "paused", reason: "test" }, NOW);
    await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE home_id=?").bind(NOW - 1000, homeId).run();
    expect((await resume()).status).toBe(409);
    await setCountrySwitch(env, { country: "US", state: "open", reason: "test" }, NOW);
    const res = await resume();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reused: false });
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0].form.get("locale")).toBe("fr");                    // not recomputed from the billing country (en)
    expect([...sessionCalls()[0].form.keys()].some((k) => k.startsWith("subscription_data[trial"))).toBe(false);
  });

  it("a stale screen, a pre-r13 delayed start, or a quote-free consent that is not positively hosted is 409 consent_stale before either reuse", async () => {
    const overs: Array<Record<string, unknown>> = [{ screen_version: "checkout-clickwrap-2026-10-11.1" }, { screen_version: "checkout-clickwrap-2026-10-11.2" },
      { delayed_start: 1, start_at: NOW + 14 * 86_400_000 }, { tax_source: "stripe_tax" }, { start_request_at: null }, { declared_country: null },
      // r2-1: a hosted consent whose snapshot is incomplete (a pre-r1 r13 row: no button label, or no archived lines), even at the current screen
      { start_request_text: null }, { disclosure: JSON.stringify({ screenVersion: SCREEN_VERSION }) }, { disclosure: null }];
    const homeId = await reserve();
    for (const over of overs) {
      await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
      expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en" }))).status).toBe(200);
      calls = [];
      const consentId = (await consentRow(homeId))!.id;
      const sets = Object.keys(over).map((k) => `${k}=?`).join(",");
      await env.DB.prepare(`UPDATE checkout_consents SET ${sets} WHERE id=?`).bind(...Object.values(over), consentId).run();
      for (const expiresAt of [NOW + 3_600_000, NOW - 1000]) {                   // the open session, then the replacement
        await env.DB.prepare("UPDATE open_checkouts SET expires_at=? WHERE home_id=?").bind(expiresAt, homeId).run();
        const res = await resume();
        expect([JSON.stringify(over), res.status, await res.json()]).toEqual([JSON.stringify(over), 409, { error: "consent_stale", restart: "checkout" }]);
      }
      expect(calls).toEqual([]);
    }
  });
});

describe("WP4 r2-1: pre-r1 r13 consents never produce the checkbox wording", () => {
  const docs = () => ({ cloudTerms: { version_id: LEGAL_DOCS.cloudTerms.versionId, title: LEGAL_DOCS.cloudTerms.title, sha256: LEGAL_DOCS.cloudTerms.sha256, text: LEGAL_DOCS.cloudTerms.text },
    termsOfService: { version_id: LEGAL_DOCS.termsOfService.versionId, title: LEGAL_DOCS.termsOfService.title, sha256: LEGAL_DOCS.termsOfService.sha256, text: LEGAL_DOCS.termsOfService.text } });
  const legacy = async (country: string, site: "en" | "de") => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: country, billingCountry: country, checkoutLanguage: site, siteLanguage: site }))).status).toBe(200);
    const row = (await consentRow(homeId))!;
    const d = JSON.parse(row.disclosure as string) as Record<string, unknown>;
    // shaped like a row written before r1: no button label, the old checkbox wording in `wording`, no startRequestText in the snapshot
    const { startRequestText: _s, ...preR1 } = d; void _s;
    return { ...row, start_request_text: null, wording: JSON.stringify({ terms: WORDING.terms, earlyStart: WORDING.earlyStart, nearEarlyStart: WORDING.nearEarlyStart }),
      disclosure: JSON.stringify(preR1), completed_at: NOW + 60_000, lines: d.lines as Record<string, string> } as unknown as ConsentRow & { lines: Record<string, string> };
  };
  it("the confirmation renders the archived EU line, labels the button as reconstructed, and never the checkbox text", async () => {
    const c = await legacy("FR", "en");
    const t = buildConfirmationEmail(c, docs(), { portalOrigin: "https://cloud.murage.test" }).text;
    expect(t).toContain("COPY OF YOUR EARLY-START REQUEST");
    expect(t).toContain(c.lines.eu);
    expect(t).toContain('"Start my server and continue to payment" (reconstructed');
    expect(t).not.toContain(WORDING.earlyStart); expect(t).not.toContain("proportionately");
    // accepted at completion, not at our button
    expect(t).toContain(`Accepted on ${new Date(NOW + 60_000).toISOString()} (UTC)`);
  });
  it("with nothing archived, the plan's lines for the stored language and country are rendered and labelled as reconstructed", async () => {
    const c = await legacy("AT", "de");
    const t = buildConfirmationEmail({ ...c, disclosure: null }, docs(), { portalOrigin: "https://cloud.murage.test" }).text;
    expect(t).toContain(`Reconstructed from our checkout page's wording for your language and country (our record of that order did not store the words shown): ${c.lines.eu}`);
    expect(t).toContain('The button read: "Server starten und weiter zur Zahlung" (reconstructed).');
    expect(t).not.toContain(WORDING.earlyStart); expect(t).not.toContain("proportionately");
  });
});

describe("WP4 r1-6 / r1-7: summaries read only what belongs to the order", () => {
  it("pre-fill skips a newer completed-but-unpaid order and keeps the last paid one's country", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" }))).status).toBe(200);
    const paid = (await consentRow(homeId))!.id;
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=?, effective_country='FR', stripe_subscription_id='sub_paid', paid_at=? WHERE id=?").bind(NOW, NOW, paid).run();
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_paid', status='active', first_paid_at=? WHERE home_id=?").bind(NOW, homeId).run();
    // a later order elsewhere (another home), completed at Stripe but never paid
    await env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,privacy_version,terms_accepted,
      recurring_authorized,early_start,eu_region,topup_enabled,renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,
      completed_at,effective_country,declared_country,stripe_subscription_id) SELECT 'consent-unpaid','home-other',user_id,?,screen_version,cloud_terms_version,tos_version,
      privacy_version,1,1,0,0,0,renewal_text,wording,'US',plan,price_cents,start_at,first_charge_at,0,?,'US','US','sub_unpaid' FROM checkout_consents WHERE id=?`)
      .bind(NOW + 1000, NOW + 2000, paid).run();
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ billingCountry: "FR", country: "FR" });
  });
  it("a retry whose consent has no subscription yet never shows the previous subscription's renewal date", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    // the previous attempt's subscription is still on the row, with its period; checkout already pointed consent_id at the retry
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_previous', current_period_end=? WHERE home_id=?").bind(NOW + 9 * 86_400_000, homeId).run();
    const retry = (await consentRow(homeId))!;
    expect(await one("SELECT consent_id FROM billing_subscriptions WHERE home_id=?", homeId)).toEqual({ consent_id: retry.id });
    expect(retry.stripe_subscription_id).toBeNull();
    expect((await (await call(`/v1/account/order?home=${homeId}`, "GET")).json() as Record<string, unknown>).currentPeriodEnd).toBeNull();
    // a different subscription recorded on the consent does not match either
    await env.DB.prepare("UPDATE checkout_consents SET stripe_subscription_id='sub_retry' WHERE id=?").bind(retry.id).run();
    expect((await (await call(`/v1/account/order?home=${homeId}`, "GET")).json() as Record<string, unknown>).currentPeriodEnd).toBeNull();
  });
});

describe("WP4 r2-5: the pre-fill is the last confirmed payment, by its own payment time", () => {
  it("checkout leaves paid_at NULL (the payment moment is written by WP5's webhook, never at our button)", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    expect((await consentRow(homeId))!.paid_at).toBeNull();
  });
  it("orders by payment time, not completion time; a replaced subscription row never erases the earlier paid consent", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" }))).status).toBe(200);
    const fr = (await consentRow(homeId))!.id;
    // FR: completed first but paid LAST (an asynchronous payment that cleared later)
    await env.DB.prepare("UPDATE checkout_consents SET completed_at=?, effective_country='FR', stripe_subscription_id='sub_fr', paid_at=? WHERE id=?").bind(NOW, NOW + 9000, fr).run();
    // DE (another home of the same user): completed after FR but paid before it
    await env.DB.prepare(`INSERT INTO checkout_consents (id,home_id,user_id,created_at,screen_version,cloud_terms_version,tos_version,privacy_version,terms_accepted,
      recurring_authorized,early_start,eu_region,topup_enabled,renewal_text,wording,billing_country,plan,price_cents,start_at,first_charge_at,delayed_start,
      completed_at,effective_country,declared_country,stripe_subscription_id,paid_at) SELECT 'consent-de','home-other',user_id,?,screen_version,cloud_terms_version,tos_version,
      privacy_version,1,1,0,0,0,renewal_text,wording,'DE',plan,price_cents,start_at,first_charge_at,0,?,'DE','DE','sub_de',? FROM checkout_consents WHERE id=?`)
      .bind(NOW + 1000, NOW + 2000, NOW + 3000, fr).run();
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ billingCountry: "FR", country: "FR" });
    // the home's billing row now belongs to a replacement subscription with no payment: the FR evidence stands
    await env.DB.prepare("UPDATE billing_subscriptions SET subscription_id='sub_replacement', first_paid_at=NULL, status='incomplete' WHERE home_id=?").bind(homeId).run();
    expect(await (await call("/v1/account/cloud", "GET")).json()).toMatchObject({ billingCountry: "FR", country: "FR" });
  });
});

describe("WP4 r1: rules the review listed as unproven", () => {
  it("documentVersions is strict: an extra key such as euLine is 400 invalid_request, nothing written", async () => {
    const homeId = await reserve();
    const base = consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" });
    const res = await checkout({ ...base, documentVersions: { ...base.documentVersions, euLine: "EU, EEA and UK" } });
    expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(0);
  });

  it("the fingerprint changes with the country or the Stripe locale even when the shown text is identical", async () => {
    envOver = DIRECT_EVERYWHERE; useSellerEnv(() => baseEnv());
    const homeId = await reserve();
    const us = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", checkoutLanguage: "en" });
    const ca = consentFor("pro", NOW, { declaredCountry: "CA", billingCountry: "CA", checkoutLanguage: "en" });
    const caFr = consentFor("pro", NOW, { declaredCountry: "CA", billingCountry: "CA", checkoutLanguage: "fr" });   // its own token (r2-3)
    expect(ca.renewalText).toBe(us.renewalText);
    expect(caFr.renewalText).toBe(ca.renewalText);
    expect((await checkout(us)).status).toBe(200);
    expect(await (await checkout(us)).json()).toMatchObject({ reused: true });
    expect(sessionCalls()).toHaveLength(1);
    const second = await (await checkout(ca)).json() as { reused?: boolean };
    expect(second.reused).toBeUndefined(); expect(sessionCalls()).toHaveLength(2);
    const third = await (await checkout(caFr)).json() as { reused?: boolean; locale: string };
    expect(third.reused).toBeUndefined(); expect(third.locale).toBe("fr"); expect(sessionCalls()).toHaveLength(3);
    expect(await count("SELECT COUNT(*) AS n FROM checkout_consents WHERE home_id=?", homeId)).toBe(3);
  });

  it("checkout logs carry no personal data (email, IP, user agent, postal code, tax id), on success and on a Stripe failure", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x)).join(" ")); });
    }
    const homeId = await reserve();
    const body = consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US", postalCode: "10001-7788", taxId: "US-TAX-998877",
      client: { ip: "198.51.100.77", ipSource: "x-forwarded-for", userAgent: "PII-agent/9.9" } });
    expect((await checkout(body)).status).toBe(200);
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
    stripeDown = true;
    const fr = { ...body, checkoutLanguage: "fr" };
    expect((await checkout({ ...fr, disclosureToken: disclosureTokenFor("pro", fr, "ferrox", NOW) })).status).toBeGreaterThanOrEqual(500);
    const all = lines.join("\n");
    for (const pii of [`${USER}@example.test`, "198.51.100.77", "203.0.113.10", "PII-agent/9.9", "10001-7788", "US-TAX-998877"]) expect(all).not.toContain(pii);
  });

  it("migrations 0067 and 0068 apply over populated rows: nothing lost, the new columns NULL, one acceptance per consent", async () => {
    const homeId = await reserve();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "US", billingCountry: "US" }))).status).toBe(200);
    await env.DB.prepare("DELETE FROM open_checkouts WHERE home_id=?").bind(homeId).run();
    expect((await checkout(consentFor("pro", NOW, { declaredCountry: "FR", billingCountry: "FR", checkoutLanguage: "fr" }))).status).toBe(200);
    // Scratch copies shaped like the tables before 0067 (no start_request_at, no start_request_text), filled with real rows.
    for (const t of ["mig_cc", "mig_ta"]) await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    await env.DB.prepare("CREATE TABLE mig_cc AS SELECT * FROM checkout_consents WHERE 0").run();
    await env.DB.prepare("ALTER TABLE mig_cc DROP COLUMN start_request_text").run();
    await env.DB.prepare("ALTER TABLE mig_cc DROP COLUMN start_request_at").run();
    const cols = (await env.DB.prepare("PRAGMA table_info(mig_cc)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).not.toContain("start_request_at");
    await env.DB.prepare(`INSERT INTO mig_cc (${cols.join(",")}) SELECT ${cols.join(",")} FROM checkout_consents`).run();
    await env.DB.prepare("CREATE TABLE mig_ta AS SELECT * FROM terms_acceptances WHERE 0").run();
    const ids = (await env.DB.prepare("SELECT id FROM mig_cc ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toHaveLength(2);
    await env.DB.batch([...ids.map((id, i) => env.DB.prepare(`INSERT INTO mig_ta (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES (?,?,'c','t','p','checkout',?,'w',?,'{}')`).bind(`a${i}`, USER, id, NOW)),
      ...[0, 1].map((i) => env.DB.prepare(`INSERT INTO mig_ta (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES (?,?,'c','t','p','reaccept',NULL,'w',?,'{}')`).bind(`r${i}`, USER, NOW))]);
    const before = (await env.DB.prepare(`SELECT ${cols.join(",")} FROM mig_cc ORDER BY id`).all()).results;
    const run = async (sql: string) => {
      const stmts = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)
        .map((x) => x.replaceAll("checkout_consents", "mig_cc").replaceAll("terms_acceptances", "mig_ta"));
      for (const x of stmts) await env.DB.prepare(x).run();
    };
    await run(m0067); await run(m0068);
    expect((await env.DB.prepare(`SELECT ${cols.join(",")} FROM mig_cc ORDER BY id`).all()).results).toEqual(before);
    expect((await env.DB.prepare("SELECT start_request_at AS a, start_request_text AS t FROM mig_cc").all()).results).toEqual([{ a: null, t: null }, { a: null, t: null }]);
    expect(await one("SELECT COUNT(*) AS n FROM mig_ta")).toEqual({ n: 4 });
    // the partial unique index: a second acceptance for a consent is refused, rows without a consent are not limited
    await expect(env.DB.prepare(`INSERT INTO mig_ta (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES ('dup',?,'c','t','p','checkout',?,'w',?,'{}')`).bind(USER, ids[0], NOW).run()).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare(`INSERT INTO mig_ta (id,user_id,cloud_terms_version,tos_version,privacy_version,source,consent_id,wording,accepted_at,client_meta)
      VALUES ('r2',?,'c','t','p','reaccept',NULL,'w',?,'{}')`).bind(USER, NOW).run();
    for (const t of ["mig_cc", "mig_ta"]) await env.DB.prepare(`DROP TABLE ${t}`).run();
  });
});
