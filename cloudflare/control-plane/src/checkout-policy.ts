// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout policy (STRIPE-HOSTED-PLAN r13c §1, §1.4, §1.5): who may buy, in which language Stripe's page is shown, and the audited
// per-country kill switch for NEW purchases. The decision functions are pure; only the switch helpers touch D1. Customer strings live in
// checkout-strings.ts. Running subscriptions are never read through this module (a pause never touches a renewal, an invoice or an address change).
import { z } from "zod";
import { HTTPError } from "./http";

/** The effective policy version is this base until the first switch change, then "<base>+s<revision>" (see policyVersionOf).
 *  r9 (2026-10-14, owner decision option 1; plan §3.2, §3.4: a change of the words on Stripe's page bumps the version): the direct page has no
 *  dropdown and shows the renewal sentence above the Pay button; the Managed Payments dropdown carries the statement in its label. The
 *  clickwrap page is unchanged, so SCREEN_VERSION is not bumped. */
export const POLICY_VERSION = "2026-10-14.r9";

const list = (s: string) => s.split(" ");
export const EU27: readonly string[] = list("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE");
/** Consumer withdrawal right (CRD / UK regs): EU27 + IS, LI, NO + GB. */
export const CONSUMER_WITHDRAWAL_COUNTRIES: ReadonlySet<string> = new Set([...EU27, "IS", "LI", "NO", "GB"]);
/** Geo-blocking Regulation (EU) 2018/302 area: EU27 + IS, LI, NO. IS/LI/NO are treated as in until the EEA incorporation is confirmed
 *  (the stricter choice). GB and CH are outside it. */
export const GEO_BLOCKING_AREA: ReadonlySet<string> = new Set([...EU27, "IS", "LI", "NO"]);
/** Countries whose Stripe page is always German (Art 3(3) first subparagraph; §312j(3) BGB, FAGG §8(2)). */
export const FORCED_LOCALE: Readonly<Record<string, string>> = { DE: "de", AT: "de" };

export const isConsumerWithdrawalCountry = (country: string) => CONSUMER_WITHDRAWAL_COUNTRIES.has(country.toUpperCase());
export const isGeoBlockingArea = (country: string) => GEO_BLOCKING_AREA.has(country.toUpperCase());

/** Stripe Checkout locales ("auto" is never sent: the browser must not decide). */
export const STRIPE_LOCALES: readonly string[] = list(
  "bg cs da de el en en-GB es es-419 et fi fil fr fr-CA hr hu id it ja ko lt lv ms mt nb nl pl pt pt-BR ro ru sk sl sv th tr vi zh zh-HK zh-TW");
const LOCALE_BY_LOWER = new Map(STRIPE_LOCALES.map((l) => [l.toLowerCase(), l]));
/** A Stripe locale from client input (case-insensitive, "_" tolerated), or null when it is not one. */
export const stripeLocaleOf = (language: unknown): string | null =>
  typeof language === "string" ? LOCALE_BY_LOWER.get(language.trim().replace("_", "-").toLowerCase()) ?? null : null;

/** The `locale` sent to Stripe: forced by the declared country (DE, AT), else the confirmed language when Stripe has it, else "en". */
export function checkoutLocale(declaredCountry: string, language: string | null | undefined): string {
  const forced = FORCED_LOCALE[declaredCountry.trim().toUpperCase()];
  return forced ?? stripeLocaleOf(language) ?? "en";
}
export const isForcedLocale = (declaredCountry: string) => declaredCountry.trim().toUpperCase() in FORCED_LOCALE;

/** The words Stripe renders on the subscription button per locale (evidence/BUTTON-WORDS.md, rendered 2026-10-10; identical on both paths).
 *  Any change of words bumps POLICY_VERSION. A locale not listed has not been rendered: its words are unknown (buttonWordsFor returns null). */
export const BUTTON_WORDS: Readonly<Record<string, string>> = {
  bg: "Абонамент", cs: "Předplatit", da: "Abonnér", de: "Zahlungspflichtig abonnieren", el: "Εγγραφή", en: "Subscribe", "en-GB": "Subscribe",
  es: "Suscribirse", et: "Telli", fi: "Tilaa", fr: "S'abonner", "fr-CA": "S'abonner", hr: "Pretplati se", hu: "Előfizetés", it: "Abbonati",
  lt: "Užsisakyti", lv: "Abonēt", mt: "Abbona", nb: "Abonner", nl: "Abonneren", pl: "Subskrybuj", pt: "Assinar", ro: "Abonare", sk: "Predplatiť",
  sl: "Naroči se", sv: "Abonnera",
};
export const buttonWordsFor = (locale: string): string | null => BUTTON_WORDS[locale] ?? null;
/** Only German names the payment obligation in the button's own words. */
export const isPaymentExplicit = (locale: string) => locale === "de";

// ---- kill switch (D1) ---------------------------------------------------------------------------------------------------------

export type SwitchState = "open" | "paused";
type Db = { DB: D1Database };

/** "open" unless a row says "paused". Used by reserve and the completion guard for a NEW or replacement purchase only. */
export async function countrySwitch(env: Db, country: string): Promise<SwitchState> {
  const row = await env.DB.prepare("SELECT state FROM checkout_country_switch WHERE country=?").bind(country.trim().toUpperCase())
    .first<{ state: SwitchState }>();
  return row?.state === "paused" ? "paused" : "open";
}
export const policyVersionOf = (revision: number) => revision > 0 ? `${POLICY_VERSION}+s${revision}` : POLICY_VERSION;
/** The policy version in force now (stored with each consent). */
export async function currentPolicyVersion(env: Db): Promise<string> {
  const row = await env.DB.prepare("SELECT revision FROM checkout_policy_state WHERE id=1").first<{ revision: number }>();
  return policyVersionOf(row?.revision ?? 0);
}

export const switchBody = z.object({
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  state: z.enum(["open", "paused"]),
  reason: z.string().trim().min(10).max(2000),
  advice: z.string().trim().min(1).max(2000).optional(),
  endsAt: z.number().int().positive().optional(),
}).strict();
export type SwitchChange = z.infer<typeof switchBody>;

/** Change one country's switch. One D1 batch (atomic): the revision bump, the audit row (old value read inside the batch) and the switch row.
 *  A change to the state it already has is refused (409 no_change): one audit row per real change. Pausing an EU/EEA country is a
 *  residence-based restriction (plan §1.5): the audit row carries reason, advice and end date; that is all this code can do about it. */
export async function setCountrySwitch(env: Db, change: SwitchChange, now: number, actor = "operator") {
  const old = await countrySwitch(env, change.country);
  if (old === change.state) throw new HTTPError(409, "no_change");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO checkout_policy_state (id,revision) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1"),
    env.DB.prepare(`INSERT INTO checkout_policy_audit (country,old,new,reason,advice,ends_at,actor,at,policy_version)
      SELECT ?, COALESCE((SELECT state FROM checkout_country_switch WHERE country=?),'open'), ?, ?, ?, ?, ?, ?, ? || '+s' || revision
      FROM checkout_policy_state WHERE id=1`)
      .bind(change.country, change.country, change.state, change.reason, change.advice ?? null, change.endsAt ?? null, actor, now, POLICY_VERSION),
    env.DB.prepare(`INSERT INTO checkout_country_switch (country,state,updated_at) VALUES (?,?,?)
      ON CONFLICT(country) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`).bind(change.country, change.state, now),
  ]);
  return { country: change.country, old, new: change.state, policyVersion: await currentPolicyVersion(env) };
}
