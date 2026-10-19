// SPDX-License-Identifier: AGPL-3.0-or-later
// Every customer string of the Stripe-hosted checkout, in en and de, verbatim from STRIPE-HOSTED-PLAN r13c (§3.1, §3.2, §3.3, top-up).
// §3.2 as decided by the owner on 2026-10-14 (option 1): the direct path has no dropdown; its renewal sentence is always visible in the submit
// message above the Pay button. The Managed Payments path (Stripe rejects custom_text there) keeps the required one-option dropdown, whose
// LABEL (always shown) carries the renewal statement (RENEWAL-DROPDOWN-WORDING.md, variant A). German reviewed by Fable 2026-10-12, except the
// option's currency/tax/exchange-rate clause (Astra DROPDOWN-DIRECT-1 (6)), pending re-check.
// Any other language falls back to en (stringsFor). Pure: no D1, no env. The legal phone is never here: it is passed in from the Worker secret.
// German is copied from the plan, never retyped; a string the plan gives no German for is listed in MISSING_DE (a launch gate, not translated).
import type { Plan } from "./b5-config";
import { PLAN_MONTHLY_USD } from "./b5-config";
import { checkoutLocale, isConsumerWithdrawalCountry } from "./checkout-policy";
import type { SellerKind } from "./seller";

export type Lang = "en" | "de";
export type CheckoutPath = "direct" | "managed";
/** The plan names shown on the page (same as PLAN_NAMES in legal-flows.ts; kept apart so this module stays free of that import cycle). */
const PLAN_LABEL: Record<Plan, string> = { starter: "Starter", pro: "Pro", max: "Max" };
export const planLabel = (plan: Plan) => PLAN_LABEL[plan];

/** "de", "de-AT", "DE_ch" are German; everything else is en. */
export const langOf = (lang: string | null | undefined): Lang => /^de([-_]|$)/i.test(lang ?? "") ? "de" : "en";

export interface DisclosureStrings {
  price: (name: string, usd: number) => string;
  renewal: string; refund: string; mp: string; eu: string;
  /** {country} is "Germany"/"Austria" (en) or "Deutschland"/"Österreich" (de). */
  deat: (country: string) => string;
  acceptance: string;
  countryLine: (country: string, language: string) => string;
  countryLineForcedGerman: (country: string) => string;
  button: string;
  legalNotices: (phone: string) => string;
}
export interface Strings {
  disclosure: DisclosureStrings;
  /** §3.2 direct path: the renewal sentence that opens the submit message (always visible, above the Pay button). */
  renewalSubmit: (usd: number) => string;
  /** §3.2 Managed Payments path: the dropdown label (always shown, <=100 chars) and its single option (the customer's action). */
  renewalLabelManaged: string;
  renewalOption: string;
  /** §3.3 direct submit text. "short" when Stripe's own agreement line already says "agree"; "full" otherwise (SUBMIT_TEXT_VARIANT in seller.ts decides). */
  submitShort: string;
  submitFull: string;
  /** Top-up switch (box) and the charge authorization; ${amount} ${threshold} ${cap} ${total} are filled by fillTopup. Not part of renewalText. */
  topupBox: string;
  topupCharge: string;
  /** The `${total}` phrase of the top-up charge text: "$21.50 including tax" once priced, "$20 plus tax where it applies" before. */
  topupTotal: { including: (money: string) => string; plus: (money: string) => string };
  /** Country names used by the DE/AT explanation line. */
  deatCountry: { DE: string; AT: string };
}

const en: Strings = {
  disclosure: {
    price: (name, usd) => `${name}: US$${usd} a month plus tax`,
    renewal: "Charged today, then on the same date each month until you cancel. Cancel any time in your account.",
    refund: "Not right for you? Ask within 7 days of the day your server is ready and we refund your first month in full. One refund per person or payment method.",
    mp: "Link (by Stripe) takes your payment for us, in your currency. The amount can change with exchange rates.",
    eu: "EU, EEA and UK: your server starts as soon as you pay, at your request. You can still change your mind within 14 days of it starting and we refund you in full.",
    deat: (c) => `In ${c}, the law needs an order button that says you must pay. Stripe only has that in German, so the payment page is in German.`,
    acceptance: "You accept the [Murage Cloud terms] and [Terms of Service] when you submit your order on the payment page. [Privacy Policy].",
    countryLine: (c, l) => `Buying as a consumer in ${c} · Checkout language ${l} · [change]`,
    countryLineForcedGerman: (c) => `Buying as a consumer in ${c} · Checkout language Deutsch · [change country]`,
    button: "Start my server and continue to payment",
    legalNotices: (phone) => `Legal notices: ${phone}`,
  },
  renewalSubmit: (usd) => `Renews each month at US$${usd} + tax until you cancel in your account.`,
  renewalLabelManaged: "Your plan renews each month at the total shown until you cancel in your account.",
  // Astra DROPDOWN-DIRECT-1 (6): the label keeps Fable's statement ("the total shown"); Managed Payments charges in local currency and
  // exchange rates can change that total, so the option (the customer's action, <=100) states the basis. Fable re-check pending.
  renewalOption: "OK, renew monthly until I cancel (in my currency with tax; exchange rates can change the amount)",
  submitShort: "You also agree to the [Terms of Service].",
  submitFull: "By submitting your order you agree to the [Murage Cloud terms] and [Terms of Service]. [Privacy Policy].",
  topupBox: "Top up my Flux credits automatically: add ${amount} whenever my balance falls below ${threshold}, up to a monthly cap of ${cap}. "
    + "I can change the amount or the cap, or turn this off, at any time.",
  topupCharge: "When my Flux balance falls below ${threshold}, I authorize Ferrox Labs, LLC to charge my payment method ${total} "
    + "for ${amount} of Flux credits, up to ${cap} per calendar month. The cap resets at 00:00 UTC on the first day of each month. "
    + "It covers automatic top-up charges only, not my plan or manual purchases.",
  topupTotal: { including: (m) => `${m} including tax`, plus: (m) => `${m} plus tax where it applies` },
  deatCountry: { DE: "Germany", AT: "Austria" },
};

const de: Strings = {
  disclosure: {
    price: (name, usd) => `${name}: ${usd} US$ pro Monat zzgl. Steuern`,
    renewal: "Heute fällig, danach am selben Tag jeden Monats, bis Sie kündigen. Kündigung jederzeit in Ihrem Konto.",
    refund: "Nicht das Richtige für Sie? Melden Sie sich innerhalb von 7 Tagen, nachdem Ihr Server bereit ist, und wir erstatten Ihren ersten Monat vollständig. Einmal pro Person oder Zahlungsmittel.",
    mp: "Link (by Stripe) nimmt Ihre Zahlung für uns entgegen, in Ihrer Währung. Der Betrag kann sich mit dem Wechselkurs ändern.",
    eu: "EU, EWR und UK: Ihr Server startet auf Ihren Wunsch sofort nach der Zahlung. Sie können sich innerhalb von 14 Tagen nach dem Start anders entscheiden und erhalten alles zurück.",
    deat: (c) => `In ${c} muss die Bestellschaltfläche die Zahlungspflicht nennen. Stripe bietet das nur auf Deutsch an, deshalb ist die Zahlungsseite auf Deutsch.`,
    acceptance: "Mit dem Absenden Ihrer Bestellung auf der Zahlungsseite akzeptieren Sie die [Murage-Cloud-Bedingungen] und die [Nutzungsbedingungen]. [Datenschutzerklärung].",
    countryLine: (c, l) => `Kauf als Verbraucher in ${c} · Sprache der Zahlungsseite ${l} · [ändern]`,
    countryLineForcedGerman: (c) => `Kauf als Verbraucher in ${c} · Sprache der Zahlungsseite Deutsch · [Land ändern]`,
    button: "Server starten und weiter zur Zahlung",
    legalNotices: (phone) => `Telefon für rechtliche Mitteilungen: ${phone}`,
  },
  // Owner decision 2026-10-14. Fable 2026-10-12 (DROPDOWN-DIRECT-WORDING-REVIEW §2): the price as the site writes it in German ("99 US$"),
  // "für", not "zu". The option's basis clause is new German (Fable re-check pending).
  renewalSubmit: (usd) => `Verlängert sich monatlich für ${usd} US$ zzgl. Steuern, bis Sie im Konto kündigen.`,
  renewalLabelManaged: "Ihr Plan verlängert sich monatlich zum angezeigten Gesamtbetrag, bis Sie im Konto kündigen.",
  renewalOption: "OK, monatlich verlängern, bis ich kündige (in meiner Währung inkl. Steuern, je nach Wechselkurs)",
  submitShort: "Sie stimmen außerdem den [Nutzungsbedingungen] zu.",
  submitFull: "Mit dem Absenden Ihrer Bestellung stimmen Sie den [Murage-Cloud-Bedingungen] und den [Nutzungsbedingungen] zu. [Datenschutzerklärung].",
  topupBox: "Meine Flux-Guthaben automatisch aufladen: ${amount} hinzufügen, sobald mein Guthaben unter ${threshold} fällt, bis zu einer monatlichen Obergrenze von ${cap}. "
    + "Ich kann den Betrag oder die Obergrenze jederzeit ändern oder dies jederzeit ausschalten.",
  topupCharge: "Wenn mein Flux-Guthaben unter ${threshold} fällt, ermächtige ich Ferrox Labs, LLC, meine Zahlungsmethode mit ${total} für Flux-Guthaben im Wert von ${amount} zu belasten, "
    + "bis zu ${cap} pro Kalendermonat. Die Obergrenze wird am ersten Tag jedes Monats um 00:00 UTC zurückgesetzt. "
    + "Sie gilt nur für automatische Aufladungen, nicht für meinen Plan oder manuelle Käufe.",
  // Main-session decision (BUILD-PLAN C.1, WP1 leftovers): Fable reviews these two phrases with the other r13c German before release.
  topupTotal: { including: (m) => `${m} inklusive Steuern`, plus: (m) => `${m} zzgl. Steuern, wo sie anfallen` },
  deatCountry: { DE: "Deutschland", AT: "Österreich" },
};

export const STRINGS: Readonly<Record<Lang, Strings>> = { en, de };
/** A country code as a German recipient reads it: Deutschland/Österreich from the same table as the disclosure line; any other code stays as it is. */
export const countryFor = (code: string, lang: string | null | undefined): string =>
  lang === "de" && (code === "DE" || code === "AT") ? STRINGS.de.deatCountry[code] : code;
/** Our own strings in the given language; anything but "de" falls back to en. */
export const stringsFor = (lang: string | null | undefined): Strings => STRINGS[langOf(lang)];

/** German strings the plan does not give (ship null, translate before launch; the test prints this list). */
export const MISSING_DE: readonly string[] = [];

// ---- top-up --------------------------------------------------------------------------------------------------------------------

export interface TopupFill { amount: number; threshold: number; cap: number; totalText: string }
/** Fill a top-up template. `totalText` is chosen by the caller (legal-flows topupTotalText: "$X including tax" once priced, else "$N plus tax where it applies"). */
export const fillTopup = (template: string, v: TopupFill) => template.replaceAll("${total}", v.totalText)
  .replaceAll("${amount}", `$${v.amount}`).replaceAll("${threshold}", `$${v.threshold}`).replaceAll("${cap}", `$${v.cap}`);
/** The server-owned top-up wording for GET /v1/legal/disclosure (`wording.topupBox`, `wording.topupCharge`), in the site locale. */
/** The `${total}` phrase for a top-up of `amount` dollars: with the total including tax when it is known (cents), else "plus tax where it applies". */
export function topupTotalPhrase(lang: string | null | undefined, amount: number, totalCents?: number | null): string {
  const t = stringsFor(lang).topupTotal;
  return typeof totalCents === "number" ? t.including(`$${(totalCents / 100).toFixed(2)}`) : t.plus(`$${amount}`);
}
export const topupWording = (lang: string | null | undefined, v: TopupFill) =>
  ({ topupBox: fillTopup(stringsFor(lang).topupBox, v), topupCharge: fillTopup(stringsFor(lang).topupCharge, v) });

// ---- Stripe page strings -----------------------------------------------------------------------------------------------------

export type SubmitVariant = "short" | "full";
/** Which Stripe-page variant a session shows and its words' version (archived with the consent; bump when any Stripe-page string changes).
 *  sp2: the Managed Payments option states currency, tax and exchange rates; the German direct sentence writes "für 99 US$". The EN option's
 *  wording ("exchange rates can change the amount", Fable 2026-10-12) is still sp2: no consent has archived sp2 yet (never deployed). */
export const STRIPE_PAGE_VERSION = "2026-10-14.sp2";
export const RENEWAL_LABEL_MAX = 100;
/** The legacy and Managed Payments dropdown key and its one option value (the value never changes with the words). */
export const RENEWAL_FIELD_KEY = "renewalconsent";
export const RENEWAL_OPTION_VALUE = "renewalyes";
/** The §3.2 Managed Payments dropdown in a Stripe locale (our strings: de or en, other locales en). No default value, ever. */
export function renewalField(locale: string) {
  const s = stringsFor(locale);
  return { label: s.renewalLabelManaged, option: s.renewalOption };
}
/** The §3.3 direct-only acceptance text in a Stripe locale. `links` turns each "[Label]" into a Markdown link "[Label](url)" (Stripe's custom_text). */
export function submitText(locale: string, variant: SubmitVariant, links?: { terms: string; tos: string; privacy: string }): string {
  const s = stringsFor(locale);
  const raw = variant === "short" ? s.submitShort : s.submitFull;
  if (!links) return raw;
  const urlFor = (label: string) => /Murage|Cloud/i.test(label) ? links.terms : /Privacy|Datenschutz/i.test(label) ? links.privacy : links.tos;
  return raw.replace(/\[([^\]]+)\]/g, (_m, label: string) => `[${label}](${urlFor(label)})`);
}
/** The direct path's whole submit message (custom_text.submit.message, directly above the Pay button): the renewal sentence for this plan
 *  (cadence, the plan's price plus tax as on our page, how to end it), then the acceptance sentence with its links. Our prices are always
 *  tax-exclusive (the disclosure's price line says "plus tax" in every country), so the sentence always says "+ tax" / "zzgl. Steuern". */
export function directSubmitMessage(locale: string, plan: Plan, variant: SubmitVariant, links?: { terms: string; tos: string; privacy: string }): string {
  return `${stringsFor(locale).renewalSubmit(PLAN_MONTHLY_USD[plan])} ${submitText(locale, variant, links)}`;
}
/** What Stripe's page shows for a consent of this path, plan and Stripe locale (archived with the consent, links left as labels). */
export function stripePageOf(path: CheckoutPath, plan: Plan, locale: string, variant: SubmitVariant) {
  return path === "direct"
    ? { variant: "direct_text" as const, version: STRIPE_PAGE_VERSION, locale, submitMessage: directSubmitMessage(locale, plan, variant), renewalDropdown: false }
    : { variant: "mp_dropdown" as const, version: STRIPE_PAGE_VERSION, locale, renewalDropdown: true, dropdownLabel: renewalField(locale).label,
      dropdownOption: renewalField(locale).option, dropdownDefault: null };
}
/** The Stripe-page provenance a consent's archived disclosure holds (prepareConsent writes `stripePage` with every consent since 2026-10-14:
 *  the variant, its version and the exact words), or null when it holds none: a consent written by the pre-change code, whose sessions
 *  carried the renewal dropdown. A malformed archive is no provenance. */
export function archivedStripePage(disclosure: string | null | undefined): ({ variant: string; version: string } & Record<string, unknown>) | null {
  let d: unknown;
  try { d = disclosure ? JSON.parse(disclosure) : null; } catch { return null; }
  const p = d && typeof d === "object" ? (d as Record<string, unknown>).stripePage : null;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  return typeof o.variant === "string" && o.variant && typeof o.version === "string" && o.version ? o as { variant: string; version: string } & Record<string, unknown> : null;
}
/** Astra DROPDOWN-DIRECT-2 (3): ABSENT provenance (no archive, or an archive with no `stripePage` key: a consent written by the pre-change
 *  code) is told apart from INVALID provenance (an archive that cannot be read, or a `stripePage` that is present but is not an object with
 *  its variant and version). Only absent provenance can make a session legacy; invalid provenance refuses the session (consentRefusal). */
export function stripePageProvenance(disclosure: string | null | undefined): "absent" | "invalid" | "valid" {
  if (disclosure === null || disclosure === undefined || disclosure === "") return "absent";
  let d: unknown;
  try { d = JSON.parse(disclosure); } catch { return "invalid"; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return "invalid";
  if (!Object.prototype.hasOwnProperty.call(d, "stripePage")) return "absent";
  return archivedStripePage(disclosure) ? "valid" : "invalid";
}

// ---- the §3.1 disclosure (contract C.1) --------------------------------------------------------------------------------------

export interface Disclosure {
  declaredCountry: string;
  /** The Stripe locale that will be sent (de for DE/AT). */
  locale: string;
  path: CheckoutPath;
  /** Display language of this box (the site locale: en or de). */
  language: Lang;
  lines: { price: string; renewal: string; refund: string; mp?: string; eu?: string; deat?: string; acceptance: string };
  /** The lines in order joined by "\n". The site sends it back unchanged; checkout recomputes it and compares byte for byte. */
  renewalText: string;
}
/** `screenVersion` is added by the route (SCREEN_VERSION in legal-flows.ts, WP4). */
export function renderDisclosure(plan: Plan, declaredCountry: string, siteLang: string | null | undefined, seller: SellerKind,
  checkoutLanguage?: string | null): Disclosure {
  const country = declaredCountry.trim().toUpperCase();
  const language = langOf(siteLang);
  const d = STRINGS[language].disclosure;
  const path: CheckoutPath = seller === "link" ? "managed" : "direct";
  // Built in the order they are shown and joined (contract C.1), so Object.values(lines) is the page order.
  const mp = path === "managed" ? { mp: d.mp } : {};
  const eu = isConsumerWithdrawalCountry(country) ? { eu: d.eu } : {};
  const deat = country === "DE" || country === "AT" ? { deat: d.deat(STRINGS[language].deatCountry[country]) } : {};
  const lines: Disclosure["lines"] = { price: d.price(PLAN_LABEL[plan], PLAN_MONTHLY_USD[plan]), renewal: d.renewal, refund: d.refund, ...mp, ...eu, ...deat,
    acceptance: d.acceptance };
  const ordered = Object.values(lines);
  return { declaredCountry: country, locale: checkoutLocale(country, checkoutLanguage ?? siteLang), path, language, lines, renewalText: ordered.join("\n") };
}
