// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP1 (plan r13c Test 1 policy rows, Test 2 geo-blocking, kill switch, migration guard).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import {
  BUTTON_WORDS, buttonWordsFor, checkoutLocale, CONSUMER_WITHDRAWAL_COUNTRIES, countrySwitch, currentPolicyVersion, EU27, FORCED_LOCALE,
  GEO_BLOCKING_AREA, isPaymentExplicit, POLICY_VERSION, setCountrySwitch, STRIPE_LOCALES,
} from "../src/checkout-policy";
import { renderDisclosure } from "../src/checkout-strings";

const ADMIN = "test-only-b5-admin-no-real-access";
const NOW = 1_800_000_000_000;

describe("policy constants", () => {
  it("has the plan's country sets", () => {
    expect(EU27).toHaveLength(27);
    expect(POLICY_VERSION).toBe("2026-10-14.r9");
    for (const c of [...EU27, "IS", "LI", "NO", "GB"]) expect(CONSUMER_WITHDRAWAL_COUNTRIES.has(c)).toBe(true);
    expect(CONSUMER_WITHDRAWAL_COUNTRIES.size).toBe(31);
    expect(GEO_BLOCKING_AREA.size).toBe(30);
    expect(GEO_BLOCKING_AREA.has("GB")).toBe(false);
    expect(GEO_BLOCKING_AREA.has("CH")).toBe(false);
    expect(CONSUMER_WITHDRAWAL_COUNTRIES.has("CH")).toBe(false);
    expect(CONSUMER_WITHDRAWAL_COUNTRIES.has("US")).toBe(false);
    expect(FORCED_LOCALE).toEqual({ DE: "de", AT: "de" });
  });
});

// Test 1: the policy rows. The locale is what the server sends to Stripe, whatever the client says.
describe("checkoutLocale (Test 1 rows)", () => {
  const rows: [string, string, string][] = [
    ["DE", "de", "de"], ["DE", "en", "de"], ["AT", "en", "de"], ["AT", "fr", "de"], ["de", "en", "de"],
    ["FR", "fr", "fr"], ["FR", "de", "de"], ["GB", "en", "en"], ["CH", "fr", "fr"], ["US", "de", "de"], ["US", "en", "en"],
    ["NL", "nl", "nl"], ["IT", "FR", "fr"], ["FR", "fr_CA", "fr-CA"], ["GB", "en-gb", "en-GB"],
  ];
  it.each(rows)("%s + %s sends locale %s", (country, language, locale) => expect(checkoutLocale(country, language)).toBe(locale));
  it("never leaves the locale to the browser or to a garbage value", () => {
    for (const bad of ["auto", "", "xx", "../", undefined, null]) expect(checkoutLocale("FR", bad as string)).toBe("en");
    expect(checkoutLocale("DE", "auto")).toBe("de");
  });
  it("only Stripe locales come out", () => {
    for (const c of ["FR", "US", "GB", "CH", "TH"]) for (const l of ["fr", "ja", "zz", "en-GB"]) expect(STRIPE_LOCALES).toContain(checkoutLocale(c, l));
  });
});

describe("disclosure rows (Test 1: strings follow the site locale, the locale sent follows the policy)", () => {
  const at = (country: string, site: string, checkout?: string, seller: "ferrox" | "link" = "link") => renderDisclosure("pro", country, site, seller, checkout);
  it("DE + de: German page, locale de, German explanation", () => {
    const d = at("DE", "de", "de");
    expect(d.locale).toBe("de"); expect(d.language).toBe("de");
    expect(d.lines.price).toBe("Pro: 99 US$ pro Monat zzgl. Steuern");
    expect(d.lines.deat).toBe("In Deutschland muss die Bestellschaltfläche die Zahlungspflicht nennen. Stripe bietet das nur auf Deutsch an, deshalb ist die Zahlungsseite auf Deutsch.");
  });
  it("DE + en (site en): English page and English explanation, locale de forced", () => {
    const d = at("DE", "en", "en");
    expect(d.locale).toBe("de"); expect(d.language).toBe("en");
    expect(d.lines.price).toBe("Pro: US$99 a month plus tax");
    expect(d.lines.deat).toBe("In Germany, the law needs an order button that says you must pay. Stripe only has that in German, so the payment page is in German.");
  });
  it("AT + en: Austria named, locale de", () => {
    const d = at("AT", "en", "en");
    expect(d.locale).toBe("de"); expect(d.lines.deat).toContain("In Austria,");
    expect(at("AT", "de").lines.deat).toContain("In Österreich muss");
  });
  it("FR + fr: locale fr, our strings in English (fallback), no DE/AT line", () => {
    const d = at("FR", "fr", "fr");
    expect(d.locale).toBe("fr"); expect(d.language).toBe("en"); expect(d.lines.deat).toBeUndefined();
    expect(d.lines.price).toBe("Pro: US$99 a month plus tax");
  });
  it("FR + de: locale de, same price and terms as DE", () => {
    const fr = at("FR", "de", "de"); const de = at("DE", "de", "de");
    expect(fr.locale).toBe("de");
    for (const k of ["price", "renewal", "refund", "mp", "eu", "acceptance"] as const) expect(fr.lines[k]).toBe(de.lines[k]);
    expect(fr.lines.deat).toBeUndefined();
  });
  it("GB + en and CH + fr: open; GB gets the EU/EEA/UK line, CH does not", () => {
    expect(at("GB", "en", "en").locale).toBe("en"); expect(at("GB", "en", "en").lines.eu).toBeDefined();
    expect(at("CH", "fr", "fr").locale).toBe("fr"); expect(at("CH", "fr", "fr").lines.eu).toBeUndefined();
  });
  it("US + de on the direct path: locale de, German terms, no MP line", () => {
    const d = at("US", "de", "de", "ferrox");
    expect(d.locale).toBe("de"); expect(d.path).toBe("direct"); expect(d.lines.mp).toBeUndefined(); expect(d.lines.eu).toBeUndefined();
    expect(d.lines.renewal.startsWith("Heute fällig")).toBe(true);
  });
  it("conditional lines: MP iff managed; EU line iff declared in CONSUMER_WITHDRAWAL_COUNTRIES; renewalText joins the lines in order", () => {
    const fr = at("FR", "en"); const us = at("US", "en", undefined, "ferrox");
    expect(fr.lines.mp).toBeDefined(); expect(us.lines.mp).toBeUndefined();
    expect(fr.lines.eu).toBeDefined(); expect(us.lines.eu).toBeUndefined();
    expect(fr.renewalText).toBe([fr.lines.price, fr.lines.renewal, fr.lines.refund, fr.lines.mp, fr.lines.eu, fr.lines.acceptance].join("\n"));
    const de = at("DE", "en");
    expect(de.renewalText.split("\n")).toEqual([de.lines.price, de.lines.renewal, de.lines.refund, de.lines.mp, de.lines.eu, de.lines.deat, de.lines.acceptance]);
    expect(us.renewalText.split("\n")).toHaveLength(4);
    for (const c of CONSUMER_WITHDRAWAL_COUNTRIES) expect(at(c, "en").lines.eu).toBeDefined();
  });
  it("is deterministic: the same inputs give the same bytes (checkout compares byte for byte)", () => {
    expect(at("FR", "de", "de").renewalText).toBe(at("fr", "de-AT", "de").renewalText);
  });
});

// Test 2: with every switch open (the default) no residence-based refusal exists in this module.
describe("geo-blocking (Test 2, all switches open)", () => {
  it("every GEO_BLOCKING_AREA country is open and gets the same price and terms in every language", async () => {
    const base = renderDisclosure("pro", "FR", "en", "link");
    for (const c of GEO_BLOCKING_AREA) {
      expect(await countrySwitch(env, c)).toBe("open");
      for (const lang of ["en", "de", "fr", "ja"]) {
        const d = renderDisclosure("pro", c, lang, "link", lang);
        expect(d.lines.price).toBe(renderDisclosure("pro", "FR", lang, "link").lines.price);
        expect(d.lines.refund).toBe(renderDisclosure("pro", "FR", lang, "link").lines.refund);
      }
    }
    expect(base.lines.price).toBe("Pro: US$99 a month plus tax");
  });
});

describe("button words (Q21)", () => {
  it("has the 26 rendered locales; only de is payment-explicit", () => {
    expect(Object.keys(BUTTON_WORDS)).toHaveLength(26);
    expect(BUTTON_WORDS.de).toBe("Zahlungspflichtig abonnieren");
    expect(BUTTON_WORDS.fr).toBe("S'abonner"); expect(BUTTON_WORDS["en-GB"]).toBe("Subscribe"); expect(BUTTON_WORDS.bg).toBe("Абонамент");
    expect(Object.keys(BUTTON_WORDS).filter(isPaymentExplicit)).toEqual(["de"]);
    expect(buttonWordsFor("ja")).toBeNull();
    for (const l of Object.keys(BUTTON_WORDS)) expect(STRIPE_LOCALES).toContain(l);
  });
  it("DE and AT always get the payment-explicit label", () => {
    for (const lang of ["en", "fr", "ja", undefined]) expect(buttonWordsFor(checkoutLocale("DE", lang))).toBe("Zahlungspflichtig abonnieren");
    expect(buttonWordsFor(checkoutLocale("AT", "en"))).toBe("Zahlungspflichtig abonnieren");
  });
});

describe("kill switch", () => {
  const reason = "regulator letter 2026-11-01, ticket OPS-1";
  it("defaults to open and the base policy version", async () => {
    expect(await countrySwitch(env, "FR")).toBe("open");
    expect(await currentPolicyVersion(env)).toBe(POLICY_VERSION);
  });
  it("a change writes one audit row, bumps the version and flips the switch in one go", async () => {
    const r = await setCountrySwitch(env, { country: "FR", state: "paused", reason, advice: "counsel call booked", endsAt: NOW + 86_400_000 }, NOW);
    expect(r).toEqual({ country: "FR", old: "open", new: "paused", policyVersion: `${POLICY_VERSION}+s1` });
    expect(await countrySwitch(env, "FR")).toBe("paused");
    expect(await countrySwitch(env, "DE")).toBe("open");
    expect(await currentPolicyVersion(env)).toBe(`${POLICY_VERSION}+s1`);
    const rows = (await env.DB.prepare("SELECT * FROM checkout_policy_audit").all()).results;
    expect(rows).toEqual([{ id: expect.any(Number), country: "FR", old: "open", new: "paused", reason, advice: "counsel call booked", ends_at: NOW + 86_400_000,
      actor: "operator", at: NOW, policy_version: `${POLICY_VERSION}+s1` }]);
    const back = await setCountrySwitch(env, { country: "FR", state: "open", reason: "letter withdrawn, see OPS-1" }, NOW + 1);
    expect(back).toMatchObject({ old: "paused", new: "open", policyVersion: `${POLICY_VERSION}+s2` });
    expect((await env.DB.prepare("SELECT old,new,policy_version FROM checkout_policy_audit ORDER BY id").all()).results)
      .toEqual([{ old: "open", new: "paused", policy_version: `${POLICY_VERSION}+s1` }, { old: "paused", new: "open", policy_version: `${POLICY_VERSION}+s2` }]);
  });
  it("refuses a change to the state it already has, with no audit row and no bump", async () => {
    await expect(setCountrySwitch(env, { country: "FR", state: "open", reason }, NOW)).rejects.toMatchObject({ status: 409, code: "no_change" });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM checkout_policy_audit").first<{ n: number }>())!.n).toBe(0);
    expect(await currentPolicyVersion(env)).toBe(POLICY_VERSION);
  });
  it("a pause never reads or touches subscriptions", async () => {
    await setCountrySwitch(env, { country: "DE", state: "paused", reason }, NOW);
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'billing_subscriptions'").all()).results;
    expect(tables).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM billing_subscriptions").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("POST /v1/admin/checkout-switch", () => {
  const send = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN}` }, method = "POST") => {
    const ctx = createExecutionContext();
    const response = await createWorker().fetch(new Request("https://admin.murage.test/v1/admin/checkout-switch", {
      method, body: method === "GET" ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10", ...headers } }),
      { ...env, CLOUD_ADMIN_TOKEN: ADMIN } as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const audits = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM checkout_policy_audit").first<{ n: number }>())!.n;
  it("is operator only", async () => {
    expect((await send({ country: "FR", state: "paused", reason: "ten chars or more" }, {})).status).toBe(401);
    expect((await send({ country: "FR", state: "paused", reason: "ten chars or more" }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(await audits()).toBe(0);
  });
  it("is POST only", async () => expect((await send({}, undefined, "GET")).status).toBeGreaterThanOrEqual(400));
  it("validates the body (country, state, reason of 10+ characters, no extra keys)", async () => {
    for (const body of [{ state: "paused", reason: "long enough reason" }, { country: "FRA", state: "paused", reason: "long enough reason" },
      { country: "FR", state: "closed", reason: "long enough reason" }, { country: "FR", state: "paused", reason: "short" },
      { country: "FR", state: "paused", reason: "long enough reason", extra: 1 }, { country: "FR", state: "paused", reason: "long enough reason", endsAt: -1 }]) {
      expect((await send(body)).status).toBe(400);
    }
    expect(await audits()).toBe(0);
  });
  it("one change writes one audit row; the same change again is 409 no_change", async () => {
    const res = await send({ country: "fr", state: "paused", reason: "regulator letter, OPS-9", advice: "counsel booked", endsAt: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ country: "FR", old: "open", new: "paused", policyVersion: `${POLICY_VERSION}+s1` });
    expect(await audits()).toBe(1);
    const again = await send({ country: "FR", state: "paused", reason: "regulator letter, OPS-9" });
    expect(again.status).toBe(409); expect(await again.json()).toEqual({ error: "no_change" });
    expect(await audits()).toBe(1);
    expect(await countrySwitch(env, "FR")).toBe("paused");
  });
});

describe("migrations", () => {
  it("has no duplicate or malformed migration numbers (MERGE-PLAN Q6)", () => {
    const names = env.TEST_MIGRATIONS.map((m) => m.name);
    const numbers = names.map((n) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(n)?.[1]);
    expect(names.filter((_n, i) => numbers[i] === undefined)).toEqual([]);
    const dup = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(dup).toEqual([]);
    expect(names).toContain("0059_checkout_policy.sql");
  });
  it("adds the policy fields to checkout_consents", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(checkout_consents)").all<{ name: string }>()).results.map((c) => c.name);
    for (const c of ["declared_country", "checkout_language", "policy_version", "ip_country_hint", "button_text", "site_language"]) expect(cols).toContain(c);
  });
});
