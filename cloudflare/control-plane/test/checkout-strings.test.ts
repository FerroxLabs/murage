// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP1: the customer strings (plan r13c §3.1, §3.2, §3.3, top-up), en and de, and the missing-German list.
import { describe, expect, it } from "vitest";
import { PLANS, PLAN_MONTHLY_USD } from "../src/b5-config";
import { PLAN_NAMES, TOPUP_DEFAULTS, topupBoxText, topupChargeText, WORDING } from "../src/legal-flows";
import {
  countryFor, directSubmitMessage, fillTopup, langOf, MISSING_DE, planLabel, renderDisclosure, RENEWAL_LABEL_MAX, renewalField, STRINGS, stringsFor, STRIPE_PAGE_VERSION,
  stripePageOf, submitText, topupWording,
} from "../src/checkout-strings";

describe("languages", () => {
  it("falls back to en for anything but de", () => {
    expect(langOf("de")).toBe("de"); expect(langOf("de-AT")).toBe("de"); expect(langOf("DE_ch")).toBe("de");
    for (const l of ["en", "fr", "ja", "", null, undefined, "deu", "dex"]) expect(langOf(l)).toBe("en");
    expect(stringsFor("fr")).toBe(STRINGS.en); expect(stringsFor("de")).toBe(STRINGS.de);
  });
  it("keeps plan labels equal to the ones legal-flows shows", () => {
    for (const p of PLANS) expect(planLabel(p)).toBe(PLAN_NAMES[p]);
  });
});

describe("renewal wording on Stripe's page (§3.2, owner decision 2026-10-14, option 1)", () => {
  it("direct: the renewal sentence per plan in en and de (+ tax / zzgl. Steuern), other locales en; no dropdown strings for the direct path", () => {
    for (const p of PLANS) {
      expect(stringsFor("en").renewalSubmit(PLAN_MONTHLY_USD[p])).toBe(`Renews each month at US$${PLAN_MONTHLY_USD[p]} + tax until you cancel in your account.`);
      expect(stringsFor("de").renewalSubmit(PLAN_MONTHLY_USD[p])).toBe(`Verlängert sich monatlich für ${PLAN_MONTHLY_USD[p]} US$ zzgl. Steuern, bis Sie im Konto kündigen.`);
      for (const l of ["en", "de", "fr", "ja"]) for (const v of ["short", "full"] as const) {
        const msg = directSubmitMessage(l, p, v, { terms: "https://t.example/terms", tos: "https://t.example/tos", privacy: "https://t.example/privacy" });
        expect(msg.startsWith(stringsFor(l).renewalSubmit(PLAN_MONTHLY_USD[p]))).toBe(true);
        expect(msg.length).toBeLessThanOrEqual(1200);
      }
    }
    expect(directSubmitMessage("fr", "pro", "full")).toBe(directSubmitMessage("en", "pro", "full"));
    for (const l of ["en", "de"] as const) expect("renewalLabelDirect" in STRINGS[l]).toBe(false);
  });
  it("Managed Payments: a statement label (<=100) and one action option; en and de exact, others en", () => {
    expect(renewalField("en")).toEqual({ label: "Your plan renews each month at the total shown until you cancel in your account.", option: "OK, renew monthly until I cancel (in my currency with tax; exchange rates can change the amount)" });
    expect(renewalField("de")).toEqual({ label: "Ihr Plan verlängert sich monatlich zum angezeigten Gesamtbetrag, bis Sie im Konto kündigen.", option: "OK, monatlich verlängern, bis ich kündige (in meiner Währung inkl. Steuern, je nach Wechselkurs)" });
    expect(renewalField("en").label).toHaveLength(80); expect(renewalField("de").label).toHaveLength(91);
    for (const l of ["en", "de", "fr", "ja", "de-AT"]) expect(renewalField(l).label.length).toBeLessThanOrEqual(RENEWAL_LABEL_MAX);
    // Astra DROPDOWN-DIRECT-1 (6): Stripe's option label is <=100 too; the option states the currency, tax and exchange-rate basis
    for (const l of ["en", "de", "fr", "ja", "de-AT"]) expect(renewalField(l).option.length).toBeLessThanOrEqual(RENEWAL_LABEL_MAX);
    // Fable's re-check (2026-10-12): "the amount" is what exchange rates change (never "it", which reads as the plan); 96 characters
    expect(renewalField("en").option).toMatch(/in my currency with tax; exchange rates can change the amount\)$/);
    expect(renewalField("en").option).toHaveLength(96);
    expect(renewalField("en").option).not.toMatch(/change it\b/);
    expect(renewalField("de").option).toMatch(/in meiner Währung inkl\. Steuern, je nach Wechselkurs/);
    // the German price is written as the site writes it (number first), never "US$99"
    expect(stringsFor("de").renewalSubmit(99)).not.toMatch(/US\$\d/);
    expect(STRIPE_PAGE_VERSION).toBe("2026-10-14.sp2");
    expect(renewalField("fr")).toEqual(renewalField("en"));
  });
  it("the archived Stripe-page variant names what the customer saw, with its version, and never a dropdown answer", () => {
    expect(stripePageOf("direct", "pro", "en", "full")).toEqual({ variant: "direct_text", version: STRIPE_PAGE_VERSION, locale: "en", renewalDropdown: false,
      submitMessage: directSubmitMessage("en", "pro", "full") });
    expect(stripePageOf("managed", "pro", "de", "full")).toEqual({ variant: "mp_dropdown", version: STRIPE_PAGE_VERSION, locale: "de", renewalDropdown: true,
      dropdownLabel: renewalField("de").label, dropdownOption: renewalField("de").option, dropdownDefault: null });
  });
});

describe("direct submit text (§3.3)", () => {
  it("has the four plan strings", () => {
    expect(submitText("en", "short")).toBe("You also agree to the [Terms of Service].");
    expect(submitText("de", "short")).toBe("Sie stimmen außerdem den [Nutzungsbedingungen] zu.");
    expect(submitText("en", "full")).toBe("By submitting your order you agree to the [Murage Cloud terms] and [Terms of Service]. [Privacy Policy].");
    expect(submitText("de", "full")).toBe("Mit dem Absenden Ihrer Bestellung stimmen Sie den [Murage-Cloud-Bedingungen] und den [Nutzungsbedingungen] zu. [Datenschutzerklärung].");
  });
  it("US + de gets German; unknown locales get English", () => {
    expect(submitText(/* locale sent */ "de", "full")).toContain("Mit dem Absenden");
    expect(submitText("fr", "full")).toBe(submitText("en", "full"));
  });
  it("links turn each bracket into a Markdown link and stay under 1200 chars", () => {
    const links = { terms: "https://t.example/terms", tos: "https://t.example/tos", privacy: "https://t.example/privacy" };
    expect(submitText("en", "full", links)).toBe(
      "By submitting your order you agree to the [Murage Cloud terms](https://t.example/terms) and [Terms of Service](https://t.example/tos). [Privacy Policy](https://t.example/privacy).");
    expect(submitText("de", "full", links)).toBe(
      "Mit dem Absenden Ihrer Bestellung stimmen Sie den [Murage-Cloud-Bedingungen](https://t.example/terms) und den [Nutzungsbedingungen](https://t.example/tos) zu. [Datenschutzerklärung](https://t.example/privacy).");
    expect(submitText("de", "short", links)).toBe("Sie stimmen außerdem den [Nutzungsbedingungen](https://t.example/tos) zu.");
    for (const l of ["en", "de"]) for (const v of ["short", "full"] as const) expect(submitText(l, v, links).length).toBeLessThan(1200);
  });
});

describe("the §3.1 disclosure box", () => {
  it("English, Pro, MP, DE: every line verbatim", () => {
    const d = renderDisclosure("pro", "DE", "en", "link");
    expect(d.lines).toEqual({
      price: "Pro: US$99 a month plus tax",
      renewal: "Charged today, then on the same date each month until you cancel. Cancel any time in your account.",
      refund: "Not right for you? Ask within 7 days of the day your server is ready and we refund your first month in full. One refund per person or payment method.",
      mp: "Link (by Stripe) takes your payment for us, in your currency. The amount can change with exchange rates.",
      eu: "EU, EEA and UK: your server starts as soon as you pay, at your request. You can still change your mind within 14 days of it starting and we refund you in full.",
      deat: "In Germany, the law needs an order button that says you must pay. Stripe only has that in German, so the payment page is in German.",
      acceptance: "You accept the [Murage Cloud terms] and [Terms of Service] when you submit your order on the payment page. [Privacy Policy].",
    });
  });
  it("German, Pro, MP, AT: every line verbatim", () => {
    const d = renderDisclosure("pro", "AT", "de", "link");
    expect(d.lines).toEqual({
      price: "Pro: 99 US$ pro Monat zzgl. Steuern",
      renewal: "Heute fällig, danach am selben Tag jeden Monats, bis Sie kündigen. Kündigung jederzeit in Ihrem Konto.",
      refund: "Nicht das Richtige für Sie? Melden Sie sich innerhalb von 7 Tagen, nachdem Ihr Server bereit ist, und wir erstatten Ihren ersten Monat vollständig. Einmal pro Person oder Zahlungsmittel.",
      mp: "Link (by Stripe) nimmt Ihre Zahlung für uns entgegen, in Ihrer Währung. Der Betrag kann sich mit dem Wechselkurs ändern.",
      eu: "EU, EWR und UK: Ihr Server startet auf Ihren Wunsch sofort nach der Zahlung. Sie können sich innerhalb von 14 Tagen nach dem Start anders entscheiden und erhalten alles zurück.",
      deat: "In Österreich muss die Bestellschaltfläche die Zahlungspflicht nennen. Stripe bietet das nur auf Deutsch an, deshalb ist die Zahlungsseite auf Deutsch.",
      acceptance: "Mit dem Absenden Ihrer Bestellung auf der Zahlungsseite akzeptieren Sie die [Murage-Cloud-Bedingungen] und die [Nutzungsbedingungen]. [Datenschutzerklärung].",
    });
  });
  it("US direct has price, renewal, refund, acceptance only; the price follows the plan", () => {
    const d = renderDisclosure("max", "US", "en", "ferrox");
    expect(Object.keys(d.lines)).toEqual(["price", "renewal", "refund", "acceptance"]);
    expect(d.lines.price).toBe("Max: US$149 a month plus tax"); expect(d.path).toBe("direct");
  });
  it("never carries the top-up text, the phone or the country line in renewalText", () => {
    for (const lang of ["en", "de"]) {
      const t = renderDisclosure("pro", "DE", lang, "link").renewalText;
      expect(t).not.toMatch(/Flux|Legal notices|Telefon|\{|\}|Buying as|Kauf als|\+\d{6}/);
    }
  });
  it("page strings around the box (country line, button, legal notices from a passed-in phone)", () => {
    expect(STRINGS.en.disclosure.countryLine("France", "Français")).toBe("Buying as a consumer in France · Checkout language Français · [change]");
    expect(STRINGS.en.disclosure.countryLineForcedGerman("Germany")).toBe("Buying as a consumer in Germany · Checkout language Deutsch · [change country]");
    expect(STRINGS.de.disclosure.countryLine("Frankreich", "Français")).toBe("Kauf als Verbraucher in Frankreich · Sprache der Zahlungsseite Français · [ändern]");
    expect(STRINGS.de.disclosure.countryLineForcedGerman("Deutschland")).toBe("Kauf als Verbraucher in Deutschland · Sprache der Zahlungsseite Deutsch · [Land ändern]");
    expect(STRINGS.en.disclosure.button).toBe("Start my server and continue to payment");
    expect(STRINGS.de.disclosure.button).toBe("Server starten und weiter zur Zahlung");
    expect(STRINGS.en.disclosure.legalNotices("PHONE")).toBe("Legal notices: PHONE");
    expect(STRINGS.de.disclosure.legalNotices("PHONE")).toBe("Telefon für rechtliche Mitteilungen: PHONE");
  });
});

describe("top-up strings (r13c)", () => {
  const v = { amount: TOPUP_DEFAULTS.amountUsd, threshold: TOPUP_DEFAULTS.thresholdUsd, cap: TOPUP_DEFAULTS.capUsd, totalText: "$21.50 including tax" };
  it("English templates are the ones legal-flows ships", () => {
    expect(STRINGS.en.topupBox).toBe(WORDING.topupBox); expect(STRINGS.en.topupCharge).toBe(WORDING.topupCharge);
    const n = { amount: v.amount, threshold: v.threshold, cap: v.cap };
    expect(topupWording("en", { ...v, totalText: "$20 plus tax where it applies" })).toEqual({ topupBox: topupBoxText(n), topupCharge: topupChargeText(n) });
  });
  it("German text is the plan's, filled with the numbers", () => {
    expect(topupWording("de", v).topupBox).toBe(
      "Meine Flux-Guthaben automatisch aufladen: $20 hinzufügen, sobald mein Guthaben unter $5 fällt, bis zu einer monatlichen Obergrenze von $100. Ich kann den Betrag oder die Obergrenze jederzeit ändern oder dies jederzeit ausschalten.");
    expect(topupWording("de", v).topupCharge).toBe(
      "Wenn mein Flux-Guthaben unter $5 fällt, ermächtige ich Ferrox Labs, LLC, meine Zahlungsmethode mit $21.50 including tax für Flux-Guthaben im Wert von $20 zu belasten, bis zu $100 pro Kalendermonat. Die Obergrenze wird am ersten Tag jedes Monats um 00:00 UTC zurückgesetzt. Sie gilt nur für automatische Aufladungen, nicht für meinen Plan oder manuelle Käufe.");
  });
  it("leaves no placeholder behind and other locales get English", () => {
    for (const l of ["en", "de", "fr"]) for (const s of Object.values(topupWording(l, v))) expect(s).not.toMatch(/\$\{/);
    expect(topupWording("fr", v)).toEqual(topupWording("en", v));
    expect(fillTopup("a ${amount} b ${amount}", v)).toBe("a $20 b $20");
  });
});

describe("German coverage", () => {
  it("lists every missing German string (launch gate; printed, not translated)", () => {
    console.log(`MISSING GERMAN (WP1, launch gate): ${MISSING_DE.length}\n${MISSING_DE.map((m) => `  - ${m}`).join("\n")}`);
    expect(Array.isArray(MISSING_DE)).toBe(true);  // WP1 left the top-up phrase; WP4 supplied it ("inklusive Steuern", "zzgl. Steuern, wo sie anfallen"), so the list is empty until the e-mails land
  });
  it("every English string has a German one of the same shape", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]);
    expect(keys(STRINGS.de)).toEqual(keys(STRINGS.en));
    expect(STRINGS.de.disclosure.deat("X")).not.toBe(STRINGS.en.disclosure.deat("X"));
  });
  it("never uses the 'Vom Vertrag zurücktreten' wording", () => {
    expect(JSON.stringify([STRINGS.de, STRINGS.de.disclosure.deat("x")])).not.toContain("zurücktreten");
  });
});

describe("countryFor (German recipients read Deutschland/Österreich)", () => {
  it("DE/AT in German use the disclosure table; everything else stays the code", () => {
    expect(countryFor("DE", "de")).toBe("Deutschland");
    expect(countryFor("AT", "de")).toBe("Österreich");
    expect(countryFor("DE", "en")).toBe("DE");
    expect(countryFor("FR", "de")).toBe("FR");
    expect(countryFor("DE", null)).toBe("DE");
  });
});
