// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP5: the pure rules of the completion step (plan r13c §1.1, §3.2, §3.3, §4.1, §4.4).
import { describe, expect, it } from "vitest";
import { aoeDate, aoeEnd, consentAuthorizes, consentRefusal, deadlinesFor, euUkFullDeadline, guardVerdict, hasLegacyRenewalDropdown, isLegacySession, LEGACY_SESSION_CUTOFF_S, MISSING_DE, ORDER_WORDS,
  orderWords, refund7Deadline, renewalAnswer, renewalAuthorized, RENEWAL_FIELD_KEY, RENEWAL_OPTION_VALUE, withdrawalDeadlines, withdrawalEndsAt, withdrawalOpen,
  type ConsentBinding, type SessionLineItem } from "../src/checkout-moments";
import { RENEWAL_FIELD_KEY as SESSION_KEY, RENEWAL_OPTION_VALUE as SESSION_VALUE } from "../src/seller";
import { BUTTON_WORDS } from "../src/checkout-policy";
import { renewalSha256 } from "../src/disclosure-token";
import { stripePageProvenance } from "../src/checkout-strings";

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 11, 15, 30, 0); // 2026-10-11 15:30 UTC

describe("deadlines are inclusive days ending 23:59:59 UTC-12 (AoE)", () => {
  it("aoeEnd is the last second of the day in UTC-12, date(moment)+n", () => {
    expect(aoeEnd(T, 14)).toBe(Date.UTC(2026, 9, 25, 23, 59, 59) + 12 * 3_600_000);
    expect(aoeDate(aoeEnd(T, 14))).toBe("2026-10-25");
    expect(aoeEnd(T, 0) - T).toBeGreaterThan(0);
  });
  it("original purchase: the guarantee runs from service_start_at, the 7-day refund too; a replacement's guarantee runs from paid_at", () => {
    const started = T + 2 * DAY, paid = T + 5 * DAY;
    const orig = deadlinesFor({ resident: true, completedAt: T, paidAt: paid, serviceStartAt: started, replacement: false });
    expect(orig).toEqual({ statutoryWithdrawUntil: aoeEnd(T, 14), guaranteeWithdrawUntil: aoeEnd(started, 14), refund7Until: aoeEnd(started, 7) });
    const repl = deadlinesFor({ resident: true, completedAt: T, paidAt: paid, serviceStartAt: started, replacement: true });
    expect(repl.guaranteeWithdrawUntil).toBe(aoeEnd(paid, 14));
    expect(repl.statutoryWithdrawUntil).toBe(aoeEnd(T, 14));
  });
  it("unpaid: only the statutory deadline exists; a non-resident has no statutory or guarantee deadline, but a 7-day refund once started", () => {
    expect(deadlinesFor({ resident: true, completedAt: T, paidAt: null, serviceStartAt: null, replacement: false }))
      .toEqual({ statutoryWithdrawUntil: aoeEnd(T, 14), guaranteeWithdrawUntil: null, refund7Until: null });
    expect(deadlinesFor({ resident: false, completedAt: T, paidAt: T, serviceStartAt: T, replacement: false }))
      .toEqual({ statutoryWithdrawUntil: null, guaranteeWithdrawUntil: null, refund7Until: aoeEnd(T, 7) });
  });
  it("withdrawal is open until max(statutory, guarantee); unbounded while the server has not started; a pre-0061 consent uses the AoE fallback", () => {
    const c = { statutory_withdraw_until: aoeEnd(T, 14), guarantee_withdraw_until: null as number | null, contract_made_at: T, completed_at: T };
    expect(withdrawalOpen(c, null, T + 400 * DAY)).toBe(true); // payment/provisioning pending or failed: still open
    expect(withdrawalOpen(c, T, aoeEnd(T, 14))).toBe(true);
    expect(withdrawalOpen(c, T, aoeEnd(T, 14) + 1)).toBe(false);
    expect(withdrawalOpen({ ...c, guarantee_withdraw_until: aoeEnd(T + 3 * DAY, 14) }, T + 3 * DAY, aoeEnd(T + 3 * DAY, 14))).toBe(true);
    // pre-0061 (nothing stored), unpaid: AoE end of date(contract)+14, the guarantee unbounded while the server has not started
    expect(withdrawalOpen({ ...c, statutory_withdraw_until: null }, T, aoeEnd(T, 14))).toBe(true);
    expect(withdrawalOpen({ ...c, statutory_withdraw_until: null }, T, aoeEnd(T, 14) + 1)).toBe(false);
  });

  it("Astra WP5-2 #3: a pre-0061 consent gets the SAME AoE fallback for availability, the shown date and the full refund (from its own paid_at)", () => {
    const legacy = { statutory_withdraw_until: null, guarantee_withdraw_until: null, contract_made_at: T, completed_at: T, paid_at: T + 5 * DAY };
    const refundEnds = euUkFullDeadline(legacy, legacy.paid_at);
    expect(refundEnds).toBe(aoeEnd(T + 5 * DAY, 14));
    // the old rule closed at completion + 336 h; the refund is still owed then, so withdrawal must be open too
    expect(withdrawalOpen(legacy, T + 5 * DAY, T + 14 * DAY + 1)).toBe(true);
    expect(withdrawalOpen(legacy, T + 5 * DAY, refundEnds)).toBe(true);
    expect(withdrawalOpen(legacy, T + 5 * DAY, refundEnds + 1)).toBe(false);
    expect(withdrawalEndsAt(legacy)).toBe(refundEnds);
    expect(withdrawalDeadlines(legacy)).toEqual({ statutory: aoeEnd(T, 14), guarantee: refundEnds, legacy: true });
    // stored deadlines win, untouched
    expect(withdrawalEndsAt({ ...legacy, statutory_withdraw_until: aoeEnd(T, 14) })).toBe(aoeEnd(T, 14));
  });
});

describe("the guard (plan §1.1) and the renewal dropdown (§3.2)", () => {
  const ok = { authorized: true, collectedCountry: "DE", declaredCountry: "DE", pathCoversCountry: true, declaredCountryPaused: false };
  it("accepts a matching, covered, unpaused, authorized order", () => expect(guardVerdict(ok)).toBeNull());
  it("an order without the renewal authorization is rejected_consent, before anything else", () => {
    expect(guardVerdict({ ...ok, authorized: false, collectedCountry: "AT", declaredCountryPaused: true })).toBe("rejected_consent");
  });
  it("billing country different from the declared one, missing, or a wrong path is a mismatch", () => {
    expect(guardVerdict({ ...ok, collectedCountry: "AT" })).toBe("mismatch");
    expect(guardVerdict({ ...ok, collectedCountry: null })).toBe("mismatch");
    expect(guardVerdict({ ...ok, pathCoversCountry: false })).toBe("mismatch");
  });
  it("a country paused after the session was created is country_paused; with every switch open nothing refuses by residence", () => {
    expect(guardVerdict({ ...ok, declaredCountryPaused: true })).toBe("country_paused");
    for (const c of ["DE", "AT", "FR", "IS", "NO", "GB", "US"]) expect(guardVerdict({ ...ok, collectedCountry: c, declaredCountry: c })).toBeNull();
  });
  it("renewalAnswer reads custom_fields by key", () => {
    expect(renewalAnswer({ custom_fields: [{ key: "other", dropdown: { value: "x" } }, { key: "renewalconsent", type: "dropdown", dropdown: { value: "renewalyes" } }] })).toBe("renewalyes");
    expect(renewalAnswer({ custom_fields: [{ key: "renewalconsent", dropdown: { value: null } }] })).toBeNull();
    expect(renewalAnswer({})).toBeNull();
  });
});

describe("order emails: English where German is missing (BUILD-PLAN §D)", () => {
  it("every order string has German (the launch gate is empty), and a German recipient gets it whole", () => {
    expect(MISSING_DE).toEqual([]);
    for (const k of Object.keys(ORDER_WORDS) as (keyof typeof ORDER_WORDS)[]) expect(ORDER_WORDS[k].de).not.toBeNull();
    expect(orderWords("orderReceivedUnpaid", "de")).toBe("Wir haben Ihre Bestellung erhalten. Ihr Server startet, sobald die Zahlung eingeht.");
    expect(orderWords("orderReceivedUnpaid", "en")).toBe("We got your order. Your server starts as soon as your payment clears.");
    expect(orderWords("mismatch", "en", { country: "AT", declared: "DE" })).toContain("(AT) doesn't match the country you chose (DE)");
    for (const k of Object.keys(ORDER_WORDS) as (keyof typeof ORDER_WORDS)[]) {
      expect(orderWords(k, "de", { country: "Österreich", declared: "Deutschland", money: "M.", refund: "R.", date: "2026-10-25" })).not.toMatch(/\{\w+\}/);
    }
  });
});

describe("the legacy renewal dropdown in every locale (sessions created before 2026-10-14)", () => {
  it("one field key and one option value whatever the locale; only the value counts as consent; a localised key is not the field", () => {
    for (const locale of [...Object.keys(BUTTON_WORDS), "de-AT", "de-CH", "de_DE", "en-US", "auto", ""]) {
      const session = { locale, custom_fields: [{ key: RENEWAL_FIELD_KEY, type: "dropdown", dropdown: { value: RENEWAL_OPTION_VALUE } }] };
      expect(renewalAnswer(session)).toBe(RENEWAL_OPTION_VALUE);
      expect(hasLegacyRenewalDropdown(session)).toBe(true);
      expect(renewalAnswer({ custom_fields: [{ key: `${RENEWAL_FIELD_KEY}_${locale}`, dropdown: { value: RENEWAL_OPTION_VALUE } }] })).toBeNull();
      expect(hasLegacyRenewalDropdown({ custom_fields: [{ key: `${RENEWAL_FIELD_KEY}_${locale}`, dropdown: { value: RENEWAL_OPTION_VALUE } }] })).toBe(false);
    }
  });
});

describe("the renewal authorization is the journaled consent record (plan §3.2, owner decision 2026-10-14, option 1)", () => {
  const TEXT = "Pro: US$99 a month plus tax\nCharged today, then on the same date each month until you cancel. Cancel any time in your account.";
  const consent: NonNullable<ConsentBinding["consent"]> = { id: "consent-1", home_id: "home-1", user_id: "user-1", recurring_authorized: 1, renewal_text: TEXT, plan: "pro",
    created_at: T, price_cents: 9900, stripe_price_id: "price_pro", stripe_session_id: "cs_1" };
  const ITEM: SessionLineItem = { priceId: "price_pro", currency: "usd", interval: "month", intervalCount: 1, quantity: 1, unitAmount: 9900 };
  const binding = (over: Partial<ConsentBinding> = {}, c: Partial<typeof consent> | null = {}): ConsentBinding =>
    ({ consent: c === null ? null : { ...consent, ...c }, homeId: "home-1", ownerId: "user-1", consentSeller: "ferrox", configuredPriceId: "price_pro",
      lineItems: [ITEM], sha256: renewalSha256, ...over });
  const session = (meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ object: "checkout.session", id: "cs_1", created: Math.floor(T / 1000) + 2,
    metadata: { home_id: "home-1", plan: "pro", price_id: "price_pro", seller: "ferrox", consent_id: "consent-1", renewal_sha256: renewalSha256(TEXT), ...meta }, ...over });
  const DROPDOWN = (value: string | null) => [{ key: RENEWAL_FIELD_KEY, type: "dropdown", dropdown: { value } }];
  /** The archive of a consent written by the current code: the Stripe page it was issued with (prepareConsent). */
  const PROVENANCE = JSON.stringify({ stripePage: { variant: "mp_dropdown", version: "2026-10-14.sp2" } });
  it("direct: a matching record authorizes the session (no dropdown on the page)", () => {
    expect(consentRefusal(session(), binding())).toBeNull();
    expect(renewalAuthorized(session(), binding())).toBe(true);
    // a consent written in the same second as the session is still before it (Stripe's created is whole seconds)
    expect(consentAuthorizes(session({}, { created: Math.floor(T / 1000) }), binding())).toBe(true);
    // a consent with no stored session price is checked against the configured price of its plan
    expect(consentAuthorizes(session(), binding({}, { stripe_price_id: null }))).toBe(true);
  });
  it("Managed Payments: needs BOTH the dropdown answered and the record", () => {
    const mp = (value: string | null, meta: Record<string, unknown> = {}) => session({ seller: "link", ...meta }, { custom_fields: DROPDOWN(value) });
    expect(renewalAuthorized(mp(RENEWAL_OPTION_VALUE), binding({ consentSeller: "link" }))).toBe(true);
    for (const v of [null, "", "renewalno"]) expect(consentRefusal(mp(v), binding({ consentSeller: "link" }))).toBe("dropdown_rule");
    expect(consentRefusal(session({ seller: "link" }), binding({ consentSeller: "link" }))).toBe("dropdown_rule");
    // answered, but the record does not cover it: refused
    expect(renewalAuthorized(mp(RENEWAL_OPTION_VALUE, { renewal_sha256: renewalSha256("other") }), binding({ consentSeller: "link" }))).toBe(false);
    expect(renewalAuthorized(mp(RENEWAL_OPTION_VALUE), binding({ consentSeller: "link" }, { home_id: "home-2" }))).toBe(false);
  });
  it("missing, mismatched, foreign-home, other-owner, other-plan, other-price, unauthorized or later consent: refused", () => {
    const refused: [string, Record<string, unknown>, Record<string, unknown>, Partial<ConsentBinding>, Partial<typeof consent> | null][] = [
      ["no consent record", {}, {}, {}, null],
      ["metadata names another consent", { consent_id: "consent-2" }, {}, {}, {}],
      ["metadata has no consent id", { consent_id: undefined }, {}, {}, {}],
      ["foreign home", {}, {}, {}, { home_id: "home-2" }],
      ["another account's consent", {}, {}, {}, { user_id: "user-2" }],
      ["home owner unknown", {}, {}, { ownerId: null }, {}],
      ["recurring not authorized", {}, {}, {}, { recurring_authorized: 0 }],
      ["session not bound to the consent", {}, {}, {}, { stripe_session_id: "cs_other" }],
      ["session without an id", {}, { id: undefined }, {}, {}],
      ["no hash", { renewal_sha256: undefined }, {}, {}, {}],
      ["hash of other words", { renewal_sha256: renewalSha256(`${TEXT} `) }, {}, {}, {}],
      ["stored words differ", {}, {}, {}, { renewal_text: TEXT.replace("99", "49") }],
      ["other seller path in the session", { seller: "link" }, {}, {}, {}],
      ["no seller in the session", { seller: undefined }, {}, {}, {}],
      ["consent sold on the other path", {}, {}, { consentSeller: "link" }, {}],
      ["other plan in metadata", { plan: "max" }, {}, {}, {}],
      ["consent for another plan", {}, {}, {}, { plan: "starter" }],
      ["other price in metadata", { price_id: "price_max" }, {}, {}, {}],
      ["no price in metadata", { price_id: undefined }, {}, {}, {}],
      ["price changed from the sold one", {}, {}, {}, { stripe_price_id: "price_old" }],
      ["no price known at all", {}, {}, { configuredPriceId: null }, { stripe_price_id: null }],
      ["line items not read", {}, {}, { lineItems: null }, {}],
      ["no line item", {}, {}, { lineItems: [] }, {}],
      ["two line items", {}, {}, { lineItems: [ITEM, ITEM] }, {}],
      ["the real line item is another price (metadata says pro)", {}, {}, { lineItems: [{ ...ITEM, priceId: "price_max" }] }, {}],
      ["the real line item is yearly", {}, {}, { lineItems: [{ ...ITEM, interval: "year" }] }, {}],
      ["the real line item is every two months", {}, {}, { lineItems: [{ ...ITEM, intervalCount: 2 }] }, {}],
      ["the real line item is in another currency", {}, {}, { lineItems: [{ ...ITEM, currency: "eur" }] }, {}],
      ["the real line item has quantity 2", {}, {}, { lineItems: [{ ...ITEM, quantity: 2 }] }, {}],
      ["the real line item has another amount", {}, {}, { lineItems: [{ ...ITEM, unitAmount: 4900 }] }, {}],
      ["consent written after the session", {}, { created: Math.floor(T / 1000) - 1 }, {}, {}],
      ["session without a creation time", {}, { created: undefined }, {}, {}],
      ["a dropdown on a direct session (never sent by our server)", {}, { custom_fields: DROPDOWN(RENEWAL_OPTION_VALUE) }, {}, {}],
    ];
    for (const [why, meta, over, b, c] of refused) {
      expect([why, consentAuthorizes(session(meta, over), binding(b, c))]).toEqual([why, false]);
      expect([why, guardVerdict({ authorized: renewalAuthorized(session(meta, over), binding(b, c)), collectedCountry: "US", declaredCountry: "US",
        pathCoversCountry: true, declaredCountryPaused: false })]).toEqual([why, "rejected_consent"]);
    }
  });
  it("an empty custom_fields list is not the dropdown: judged by the record", () => {
    expect(renewalAuthorized(session({}, { custom_fields: [] }), binding())).toBe(true);
    expect(renewalAuthorized(session({ renewal_sha256: undefined }, { custom_fields: [] }), binding())).toBe(false);
  });
  it("one dropdown key and option value for sessions old and new (seller.ts sends exactly these)", () => {
    expect(SESSION_KEY).toBe(RENEWAL_FIELD_KEY); expect(SESSION_VALUE).toBe(RENEWAL_OPTION_VALUE);
  });
  it("TRANSITION: a session created before the change (dropdown, no hash, consent without Stripe-page provenance, before the cutoff) is judged by the old rule; with a hash it never is", () => {
    const before = LEGACY_SESSION_CUTOFF_S - 3600;
    const legacy = (value: string | null, meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ object: "checkout.session", id: "cs_1", created: before,
      metadata: { home_id: "home-1", plan: "pro", consent_id: "consent-1", ...meta }, custom_fields: DROPDOWN(value), ...over });
    // the default consent of this block was written by the pre-change code: no stripePage in its archive
    expect(isLegacySession(legacy(RENEWAL_OPTION_VALUE), binding())).toBe(true);
    expect(hasLegacyRenewalDropdown(legacy(RENEWAL_OPTION_VALUE))).toBe(true);
    // answered: accepted without the new metadata (no hash, no price, no line items read)
    expect(renewalAuthorized(legacy(RENEWAL_OPTION_VALUE), binding({ lineItems: null }))).toBe(true);
    // unanswered or a foreign value: refused, as before
    for (const v of [null, "", "renewalno"]) expect(renewalAuthorized(legacy(v), binding())).toBe(false);
    // the metadata does not name this home's consent: refused
    expect(renewalAuthorized(legacy(RENEWAL_OPTION_VALUE), binding({}, null))).toBe(false);
    // a session carrying a hash is a new session (Managed Payments): never the old rule, the record must cover it
    expect(isLegacySession(legacy(RENEWAL_OPTION_VALUE, { renewal_sha256: renewalSha256(TEXT) }), binding())).toBe(false);
    expect(renewalAuthorized(legacy(RENEWAL_OPTION_VALUE, { renewal_sha256: renewalSha256(TEXT) }), binding({ consentSeller: "link", lineItems: null }))).toBe(false);
    // created at or after the cutoff, or with no creation second: never the old rule
    expect(isLegacySession(legacy(RENEWAL_OPTION_VALUE, {}, { created: LEGACY_SESSION_CUTOFF_S }), binding())).toBe(false);
    expect(isLegacySession(legacy(RENEWAL_OPTION_VALUE, {}, { created: undefined }), binding())).toBe(false);
    // a consent whose archive holds the Stripe page it was issued with (every consent since the change): never the old rule
    expect(isLegacySession(legacy(RENEWAL_OPTION_VALUE), binding({}, { disclosure: PROVENANCE }))).toBe(false);
  });
  it("Astra DROPDOWN-DIRECT-2 (3): absent provenance may be legacy; a PRESENT but invalid stripePage (no version) refuses the session, never legacy", () => {
    const before = LEGACY_SESSION_CUTOFF_S - 3600;
    const legacy = { object: "checkout.session", id: "cs_1", created: before, metadata: { home_id: "home-1", plan: "pro", consent_id: "consent-1" },
      custom_fields: DROPDOWN(RENEWAL_OPTION_VALUE) };
    // absent: no archive, or an archive without the key (the pre-change code)
    for (const disclosure of [undefined, null, "", JSON.stringify({ tax: { source: "none" } })]) {
      expect(stripePageProvenance(disclosure)).toBe("absent");
      expect(isLegacySession(legacy, binding({}, { disclosure }))).toBe(true);
      expect(renewalAuthorized(legacy, binding({ lineItems: null }, { disclosure }))).toBe(true);
    }
    expect(stripePageProvenance(PROVENANCE)).toBe("valid");
    // invalid: present without its version (or not an object, or an unreadable archive)
    for (const disclosure of [JSON.stringify({ stripePage: { variant: "mp_dropdown" } }), JSON.stringify({ stripePage: { variant: "mp_dropdown", version: "" } }),
      JSON.stringify({ stripePage: null }), JSON.stringify({ stripePage: "mp_dropdown" }), JSON.stringify({ stripePage: [] }), "{not json", "[]"]) {
      expect(stripePageProvenance(disclosure)).toBe("invalid");
      expect(isLegacySession(legacy, binding({}, { disclosure }))).toBe(false);
      expect(renewalAuthorized(legacy, binding({ lineItems: null }, { disclosure }))).toBe(false);
      // and a session the record would otherwise authorize is refused on the provenance alone
      expect(consentRefusal(session({}, { custom_fields: [] }), binding({}, { disclosure }))).toBe("provenance_invalid");
      expect(renewalAuthorized(session({}, { custom_fields: [] }), binding({}, { disclosure }))).toBe(false);
    }
  });
  it("Astra DROPDOWN-DIRECT-2 (3): the legacy cutoff is frozen at the staging deployment hour, 2026-10-14T16:00:00Z", () => {
    expect(LEGACY_SESSION_CUTOFF_S).toBe(Date.parse("2026-10-14T16:00:00Z") / 1000);
    expect(Number.isInteger(LEGACY_SESSION_CUTOFF_S)).toBe(true);
  });
  it("Astra DROPDOWN-DIRECT-1 (1): a NEW Managed Payments session with its hash missing is judged by the record, never downgraded to legacy", () => {
    // issued by the current code (its consent archives the Stripe page), the hash dropped: wrong owner, recurring not authorized, quantity 2
    const s = session({ renewal_sha256: undefined, seller: "link" }, { custom_fields: DROPDOWN(RENEWAL_OPTION_VALUE), created: Math.floor(T / 1000) + 2 });
    const b = binding({ consentSeller: "link", ownerId: "user-other", lineItems: [{ ...ITEM, quantity: 2 }] }, { recurring_authorized: 0, disclosure: PROVENANCE });
    expect(isLegacySession(s, b)).toBe(false);
    expect(renewalAuthorized(s, b)).toBe(false);
    expect(consentRefusal(s, b)).toBe("consent_other_account");
    expect(guardVerdict({ authorized: renewalAuthorized(s, b), collectedCountry: "FR", declaredCountry: "FR", pathCoversCountry: true, declaredCountryPaused: false })).toBe("rejected_consent");
    // each defect alone, with the right owner, still refuses
    expect(consentRefusal(s, binding({ consentSeller: "link" }, { recurring_authorized: 0, disclosure: PROVENANCE }))).toBe("recurring_not_authorized");
    expect(consentRefusal(s, binding({ consentSeller: "link" }, { disclosure: PROVENANCE }))).toBe("renewal_text_mismatch");
    expect(consentRefusal(session({ seller: "link" }, { custom_fields: DROPDOWN(RENEWAL_OPTION_VALUE) }), binding({ consentSeller: "link", lineItems: [{ ...ITEM, quantity: 2 }] },
      { disclosure: PROVENANCE }))).toBe("line_items_mismatch");
  });
});

describe("frozen deadlines (Astra WP5-1 #5)", () => {
  it("a later stored deadline wins; a consent without one gets the AoE rule from the payment, never +168 h / +336 h", () => {
    expect(refund7Deadline(aoeEnd(T + 3 * DAY, 7), T)).toBe(aoeEnd(T + 3 * DAY, 7));
    // Astra JOURNEY-B-1 #8: an earlier frozen value (a replacement inheriting September's start) never hides an October payment's own rule.
    expect(refund7Deadline(T + 3 * DAY, T)).toBe(aoeEnd(T, 7));
    expect(refund7Deadline(aoeEnd(T - 30 * DAY, 7), T)).toBe(aoeEnd(T, 7));
    expect(refund7Deadline(aoeEnd(T - 30 * DAY, 7), T, T + 2 * DAY)).toBe(aoeEnd(T + 2 * DAY, 7));
    expect(refund7Deadline(null, T)).toBe(aoeEnd(T, 7));
    expect(refund7Deadline(null, T)).toBeGreaterThan(T + 7 * DAY);
    expect(euUkFullDeadline({ statutory_withdraw_until: aoeEnd(T, 14), guarantee_withdraw_until: aoeEnd(T + 2 * DAY, 14) }, T)).toBe(aoeEnd(T + 2 * DAY, 14));
    expect(euUkFullDeadline({ statutory_withdraw_until: aoeEnd(T, 14), guarantee_withdraw_until: null }, T)).toBe(aoeEnd(T, 14));
    expect(euUkFullDeadline({}, T)).toBe(aoeEnd(T, 14));
  });
});
