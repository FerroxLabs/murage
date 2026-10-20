// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP2 (plan r13c Test 2 / Test 8, §2, §3.2, §3.3, parameter guard): the session builder sends exactly the allowed parameters per path.
// 2026-10-14 (owner decision, plan §3.2, option 1): the direct path has NO dropdown; its submit message (always visible above the Pay button)
// opens with the renewal sentence (cadence, the plan's price + tax, how to end it), then the acceptance links. The Managed Payments path keeps
// the required dropdown, the statement in its always-shown label, one action option, never a default. Both name the journaled consent, the
// renewal hash and the price in their metadata.
import { describe, expect, it } from "vitest";
import { PLANS } from "../src/b5-config";
import { BUTTON_WORDS, checkoutLocale, STRIPE_LOCALES } from "../src/checkout-policy";
import { directSubmitMessage, renewalField, stringsFor, submitText } from "../src/checkout-strings";
import { renewalSha256 } from "../src/disclosure-token";
import {
  assertDirectForm, assertManagedForm, assertNoNeverKeys, DIRECT_FORBIDDEN, DIRECT_PATH, MANAGED_FORBIDDEN, MANAGED_PATH, NEVER_FORBIDDEN, RENEWAL_FIELD_KEY,
  RENEWAL_LABEL_MAX, RENEWAL_OPTION_VALUE, SUBMIT_TEXT_MAX, SUBMIT_TEXT_VARIANT, sessionParams, type SessionInput,
} from "../src/seller";

const HASH = renewalSha256("Pro: US$99 a month plus tax\nCharged today, then on the same date each month until you cancel.");
const LINKS = { terms: "https://c.test/cloud-terms", tos: "https://c.test/terms-of-service", privacy: "https://c.test/privacy-policy" };
const input = (over: Partial<SessionInput> = {}): SessionInput => ({ customerId: "cus_1", homeId: "home-1", plan: "pro", priceId: "price_1", fpTid: "tid_1",
  successUrl: "https://c.test/ok", cancelUrl: "https://c.test/no", consentId: "consent-1", renewalSha256: HASH, expiresAtSeconds: 1_900_000_000, locale: "en", submitLinks: LINKS, ...over });
const keys = (f: Record<string, unknown>) => Object.entries(f).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
const matches = (f: Record<string, unknown>, k: string) => keys(f).filter((x) => x === k || x.startsWith(`${k}[`));
const LOCALES = ["en", "de", ...STRIPE_LOCALES.filter((l) => l in BUTTON_WORDS), "ja"];

describe("both paths (§B WP2)", () => {
  it.each(["ferrox", "link"] as const)("%s: the fixed parameters", (seller) => {
    const f = sessionParams(seller, input({ replaces: "sub_old" }));
    expect(f).toMatchObject({ mode: "subscription", customer: "cus_1", "line_items[0][price]": "price_1", "line_items[0][quantity]": 1,
      billing_address_collection: "required", client_reference_id: "home-1", expires_at: 1_900_000_000, success_url: "https://c.test/ok", cancel_url: "https://c.test/no",
      "metadata[home_id]": "home-1", "metadata[plan]": "pro", "metadata[fp_tid]": "tid_1", "metadata[consent_id]": "consent-1", "metadata[replaces]": "sub_old",
      "metadata[price_id]": "price_1", "metadata[renewal_sha256]": HASH,
      "metadata[seller]": seller, "subscription_data[metadata][home_id]": "home-1", "subscription_data[metadata][plan]": "pro",
      "subscription_data[metadata][fp_tid]": "tid_1", "subscription_data[metadata][consent_id]": "consent-1", "subscription_data[metadata][replaces]": "sub_old" });
  });
  it.each(["ferrox", "link"] as const)("%s: replaces is omitted when not a replacement", (seller) => {
    const f = sessionParams(seller, input());
    expect(matches(f, "metadata[replaces]")).toEqual([]); expect(matches(f, "subscription_data[metadata][replaces]")).toEqual([]);
  });
  it.each(["ferrox", "link"] as const)("%s: never submit_type, never a trial_end", (seller) => {
    const f = sessionParams(seller, input());
    for (const k of NEVER_FORBIDDEN) expect(matches(f, k)).toEqual([]);
  });
  it("direct: no custom_fields at all; Managed Payments: exactly the one required dropdown, no default value", () => {
    expect(matches(sessionParams("ferrox", input()), "custom_fields")).toEqual([]);
    expect(DIRECT_FORBIDDEN).toContain("custom_fields"); expect(NEVER_FORBIDDEN).not.toContain("custom_fields");
    const f = sessionParams("link", input({ submitLinks: undefined }));
    expect(matches(f, "custom_fields").sort()).toEqual(["custom_fields[0][dropdown][options][0][label]", "custom_fields[0][dropdown][options][0][value]",
      "custom_fields[0][key]", "custom_fields[0][label][custom]", "custom_fields[0][label][type]", "custom_fields[0][optional]", "custom_fields[0][type]"]);
    expect(f).toMatchObject({ "custom_fields[0][key]": RENEWAL_FIELD_KEY, "custom_fields[0][type]": "dropdown", "custom_fields[0][optional]": false,
      "custom_fields[0][label][type]": "custom", "custom_fields[0][dropdown][options][0][value]": RENEWAL_OPTION_VALUE });
    expect(keys(f).some((k) => k.includes("default_value"))).toBe(false);
  });
  it.each(["ferrox", "link"] as const)("%s: refuses to build a session that does not name its consent record and renewal hash", (seller) => {
    expect(() => sessionParams(seller, input({ consentId: "" }))).toThrow("session_consent_binding_missing");
    expect(() => sessionParams(seller, input({ renewalSha256: "" }))).toThrow("session_consent_binding_missing");
    expect(() => sessionParams(seller, input({ renewalSha256: "not-a-hash" }))).toThrow("session_consent_binding_missing");
  });
  it("a custom_fields key slipped into a direct form is refused by the direct guard; the managed form may carry it", () => {
    expect(() => assertDirectForm({ ...DIRECT_PATH.sessionForm(input()), "custom_fields[0][key]": "x" })).toThrow("direct_forbidden_param:custom_fields");
    expect(() => assertNoNeverKeys(MANAGED_PATH.sessionForm(input({ submitLinks: undefined })))).not.toThrow();
  });
  it.each(["ferrox", "link"] as const)("%s: an unknown plan is refused", (seller) => {
    expect(() => sessionParams(seller, input({ plan: "gold" }))).toThrow("session_plan_unknown");
  });
});

describe("Test 8: every path x locale", () => {
  describe.each(LOCALES)("locale %s", (locale) => {
    for (const plan of PLANS) {
      it(`direct ${plan}: locale, no dropdown in ${locale}, renewal sentence + acceptance links above the Pay button, direct-only parameters`, () => {
        const f = sessionParams("ferrox", input({ plan, locale }));
        expect(f.locale).toBe(locale);
        expect(matches(f, "custom_fields")).toEqual([]);
        expect(f).toMatchObject({ "metadata[plan]": plan, "metadata[consent_id]": "consent-1", "metadata[renewal_sha256]": HASH });
        const msg = f["custom_text[submit][message]"] as string;
        expect(msg).toBe(`${stringsFor(locale).renewalSubmit(({ starter: 49, pro: 99, max: 149 } as const)[plan])} ${submitText(locale, SUBMIT_TEXT_VARIANT, LINKS)}`);
        expect(msg).toBe(directSubmitMessage(locale, plan, SUBMIT_TEXT_VARIANT, LINKS));
        expect(msg.length).toBeLessThanOrEqual(SUBMIT_TEXT_MAX); expect(msg).toContain("](https://c.test/");
        expect(f).toMatchObject({ "managed_payments[enabled]": false, "adaptive_pricing[enabled]": false, "automatic_tax[enabled]": true,
          "tax_id_collection[enabled]": true, "customer_update[address]": "auto", "customer_update[name]": "auto" });
        expect(matches(f, "submit_type")).toEqual([]);
      });
      it(`managed ${plan}: locale, the dropdown with the statement label in ${locale}, no forbidden key and no custom_text`, () => {
        const f = sessionParams("link", input({ plan, locale, submitLinks: undefined }));
        expect(f.locale).toBe(locale); expect(f["managed_payments[enabled]"]).toBe(true);
        expect(f["custom_fields[0][label][custom]"]).toBe(renewalField(locale).label);
        expect(f["custom_fields[0][dropdown][options][0][label]"]).toBe(renewalField(locale).option);
        expect((f["custom_fields[0][label][custom]"] as string).length).toBeLessThanOrEqual(RENEWAL_LABEL_MAX);
        expect(f).toMatchObject({ "metadata[plan]": plan, "metadata[consent_id]": "consent-1", "metadata[renewal_sha256]": HASH });
        for (const k of MANAGED_FORBIDDEN) expect(matches(f, k)).toEqual([]);
        expect(matches(f, "custom_text")).toEqual([]); expect(matches(f, "submit_type")).toEqual([]);
        expect(matches(f, "managed_payments")).toEqual(["managed_payments[enabled]"]);
      });
    }
  });
  it("the exact direct sentences (EN per plan, DE) and the exact Managed Payments label and option (EN, DE)", () => {
    for (const [plan, usd] of [["starter", 49], ["pro", 99], ["max", 149]] as const)
      expect(sessionParams("ferrox", input({ plan }))["custom_text[submit][message]"]).toBe(`Renews each month at US$${usd} + tax until you cancel in your account. `
        + "By submitting your order you agree to the [Murage Cloud terms](https://c.test/cloud-terms) and [Terms of Service](https://c.test/terms-of-service). [Privacy Policy](https://c.test/privacy-policy).");
    expect(sessionParams("ferrox", input({ locale: "de" }))["custom_text[submit][message]"]).toMatch(/^Verlängert sich monatlich für 99 US\$ zzgl\. Steuern, bis Sie im Konto kündigen\. Mit dem Absenden/);
    const en = sessionParams("link", input({ submitLinks: undefined })); const de = sessionParams("link", input({ locale: "de", submitLinks: undefined }));
    expect([en["custom_fields[0][label][custom]"], en["custom_fields[0][dropdown][options][0][label]"]]).toEqual(["Your plan renews each month at the total shown until you cancel in your account.", "OK, renew monthly until I cancel (in my currency with tax; exchange rates can change the amount)"]);
    expect([de["custom_fields[0][label][custom]"], de["custom_fields[0][dropdown][options][0][label]"]]).toEqual(["Ihr Plan verlängert sich monatlich zum angezeigten Gesamtbetrag, bis Sie im Konto kündigen.", "OK, monatlich verlängern, bis ich kündige (in meiner Währung inkl. Steuern, je nach Wechselkurs)"]);
    expect([(en["custom_fields[0][label][custom]"] as string).length, (de["custom_fields[0][label][custom]"] as string).length]).toEqual([80, 91]);
    expect(renewalField("ja")).toEqual(renewalField("en"));
  });
  it("US + de on the direct path: German submit text, no dropdown", () => {
    const f = sessionParams("ferrox", input({ locale: checkoutLocale("US", "de") }));
    expect(f.locale).toBe("de");
    expect(matches(f, "custom_fields")).toEqual([]);
    expect(f["custom_text[submit][message]"]).toContain("Mit dem Absenden Ihrer Bestellung stimmen Sie den [Murage-Cloud-Bedingungen](https://c.test/cloud-terms) und den [Nutzungsbedingungen](https://c.test/terms-of-service) zu. [Datenschutzerklärung](https://c.test/privacy-policy).");
  });
  it("DE and AT: the forced locale reaches both paths whatever language was asked for", () => {
    for (const country of ["DE", "AT"]) for (const seller of ["ferrox", "link"] as const)
      expect(sessionParams(seller, input({ locale: checkoutLocale(country, "fr") })).locale).toBe("de");
  });
  it("another locale (ja) falls back to the English submit text", () => {
    const f = sessionParams("ferrox", input({ locale: "ja" }));
    expect(f.locale).toBe("ja"); expect(f["custom_text[submit][message]"]).toBe(directSubmitMessage("en", "pro", SUBMIT_TEXT_VARIANT, LINKS));
  });
  it("direct names the full submit variant by default and honours the short one", () => {
    expect(SUBMIT_TEXT_VARIANT).toBe("full");
    expect(sessionParams("ferrox", input({ submitVariant: "short" }))["custom_text[submit][message]"]).toBe("Renews each month at US$99 + tax until you cancel in your account. You also agree to the [Terms of Service](https://c.test/terms-of-service).");
  });
  it("direct refuses to build without the submit links", () => {
    expect(() => DIRECT_PATH.sessionForm(input({ submitLinks: undefined }))).toThrow("session_submit_links_missing");
  });
});

describe("managed-path guard", () => {
  const base = () => MANAGED_PATH.sessionForm(input({ submitLinks: undefined }));
  it("lists every key of MP-DISALLOWED-PARAMS.md, custom_text and submit_type included", () => {
    for (const k of ["automatic_tax", "tax_id_collection", "subscription_data[default_tax_rates]", "payment_method_collection", "payment_method_configuration",
      "payment_method_options", "payment_method_types", "saved_payment_method_options", "customer_update[name]", "customer_update[address]",
      "shipping_address_collection", "shipping_options", "subscription_data[application_fee_percent]", "subscription_data[on_behalf_of]",
      "subscription_data[transfer_data]", "subscription_data[invoice_settings]", "adaptive_pricing", "invoice_creation", "custom_text", "submit_type"])
      expect(MANAGED_FORBIDDEN).toContain(k);
  });
  it.each(MANAGED_FORBIDDEN)("rejects a managed params object carrying %s (exact and nested)", (k) => {
    expect(() => assertManagedForm({ ...base(), [k]: "x" })).toThrow("managed_forbidden_param");
    expect(() => assertManagedForm({ ...base(), [`${k}[enabled]`]: true })).toThrow("managed_forbidden_param");
  });
  it("rejects the custom_text submit message on a managed object", () => {
    expect(() => assertManagedForm({ ...base(), "custom_text[submit][message]": "hi" })).toThrow("managed_forbidden_param:custom_text");
  });
  it("an undefined or null value is not sent, so it does not trip the guard", () => {
    expect(() => assertManagedForm({ ...base(), automatic_tax: undefined, "custom_text[submit][message]": null })).not.toThrow();
  });
  it("trial_end is refused on either path", () => {
    expect(() => assertManagedForm({ ...base(), "subscription_data[trial_end]": 1 })).toThrow("forbidden_param");
  });
  it("does not trip on look-alike keys (managed_payments)", () => {
    expect(() => assertManagedForm(base())).not.toThrow();
  });
});
