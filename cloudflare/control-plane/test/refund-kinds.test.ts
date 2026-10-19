// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP3: the pure rules of the new refund kinds (amounts, the "Your refund" line) and the one-per-person constants.
import { describe, expect, it } from "vitest";
import { apiAmountCents, checkoutRefundTarget, CHECKOUT_REFUND_KINDS, isCheckoutRefundKind, refundLine, refundState, unusedFraction, utcDate,
  type RefundStateFields } from "../src/refund-kinds";
import { NOT_A_FIRST_PAYMENT_KINDS, REFUND_LIMIT_V2_CLOUD_TERMS_IDS, refundLimitVersions } from "../src/refund-identity";
import { LEGAL_DOCS } from "../src/legal-docs.generated";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const fields = (over: Partial<RefundStateFields> = {}): RefundStateFields => ({ refund_submitted_at: null, stripe_refund_status: null, refunded_at: null, attempts: 0, done_at: null, ...over });

describe("WP3 amounts", () => {
  it("knows exactly the six new kinds", () => {
    expect([...CHECKOUT_REFUND_KINDS].sort()).toEqual(["cancellation_late", "country_paused", "cutover", "extraordinary", "mismatch", "rejected_consent"]);
    expect(isCheckoutRefundKind("cutover")).toBe(true);
    expect(isCheckoutRefundKind("withdrawal")).toBe(false);
  });
  it("API amount = round(amount_paid x fraction) in USD cents, tax never added on top", () => {
    expect(apiAmountCents(4900, 20, 30)).toBe(3267); // 3266.67
    expect(apiAmountCents(4900, 1, 2)).toBe(2450);
    expect(apiAmountCents(9900, 0, 30)).toBe(0);
    expect(apiAmountCents(0, 20, 30)).toBe(0);
    expect(apiAmountCents(4900, 30, 30)).toBe(4900);
  });
  it("mismatch, country_paused, rejected_consent and cancellation_late refund the whole invoice", () => {
    for (const k of ["mismatch", "country_paused", "rejected_consent", "cancellation_late"] as const)
      expect(checkoutRefundTarget(k, 4900, { cutoverAt: null, oldPeriodStart: null, oldPeriodEnd: null })).toBe(4900);
  });
  it("cutover and extraordinary use the frozen fraction (old_period_end - cutover_at) / (old_period_end - old_period_start)", () => {
    const frozen = { cutoverAt: T0 + 10 * DAY, oldPeriodStart: T0, oldPeriodEnd: T0 + 30 * DAY };
    expect(unusedFraction(frozen)).toEqual({ num: 20 * DAY, den: 30 * DAY });
    expect(checkoutRefundTarget("cutover", 4900, frozen)).toBe(3267);
    expect(checkoutRefundTarget("extraordinary", 9900, { ...frozen, cutoverAt: T0 + 15 * DAY })).toBe(4950);
  });
  it("the fraction is clamped: a cutover before the period refunds all of it, one after the period refunds nothing", () => {
    expect(checkoutRefundTarget("cutover", 4900, { cutoverAt: T0 - DAY, oldPeriodStart: T0, oldPeriodEnd: T0 + 30 * DAY })).toBe(4900);
    expect(checkoutRefundTarget("cutover", 4900, { cutoverAt: T0 + 31 * DAY, oldPeriodStart: T0, oldPeriodEnd: T0 + 30 * DAY })).toBe(0);
  });
  it("missing or nonsensical frozen values give no amount (the operation waits, it never guesses)", () => {
    expect(checkoutRefundTarget("cutover", 4900, { cutoverAt: null, oldPeriodStart: T0, oldPeriodEnd: T0 + DAY })).toBeNull();
    expect(checkoutRefundTarget("cutover", 4900, { cutoverAt: T0, oldPeriodStart: null, oldPeriodEnd: T0 + DAY })).toBeNull();
    expect(checkoutRefundTarget("extraordinary", 4900, { cutoverAt: T0, oldPeriodStart: T0, oldPeriodEnd: T0 })).toBeNull();
    expect(checkoutRefundTarget("extraordinary", 4900, { cutoverAt: T0, oldPeriodStart: T0 + DAY, oldPeriodEnd: T0 })).toBeNull();
  });
});

describe("WP3 refund states are kept apart", () => {
  it("being prepared until Stripe has the refund", () => {
    expect(refundState(fields(), "direct")).toEqual({ status: "being_prepared", path: "direct" });
    expect(refundLine(fields(), "en", "direct")).toBe("Your refund: being prepared.");
    expect(refundLine(fields(), "de", "direct")).toBe("Ihre Erstattung: wird vorbereitet.");
  });
  it("submitted is 'sent on' (direct) and 'sent to your payment provider' (Managed Payments only), never 'processed'", () => {
    const f = fields({ refund_submitted_at: T0, stripe_refund_status: "pending" });
    expect(refundState(f, "direct")).toEqual({ status: "sent", date: T0, path: "direct" });
    expect(refundLine(f, "en", "direct")).toBe(`Your refund: sent on ${utcDate(T0)}.`);
    expect(refundLine(f, "en", "mp")).toBe(`Your refund: sent to your payment provider on ${utcDate(T0)}.`);
    expect(refundLine(f, "de", "direct")).toBe(`Ihre Erstattung: am ${utcDate(T0)} gesendet.`);
    expect(refundLine(f, "de", "mp")).toBe(`Ihre Erstattung: am ${utcDate(T0)} an Ihren Zahlungsanbieter gesendet.`);
    expect(refundLine(f, "en", "direct")).not.toMatch(/mp|payment provider|confirmed/);
  });
  it("succeeded is 'processed on' with the bank caveat, and never promises arrival", () => {
    const f = fields({ refund_submitted_at: T0, stripe_refund_status: "succeeded", refunded_at: T0 + DAY });
    expect(refundState(f, "mp")).toEqual({ status: "processed", date: T0 + DAY, path: "mp" });
    expect(refundLine(f, "en", "mp")).toBe(`Your refund: processed on ${utcDate(T0 + DAY)}; your bank may take 5 to 10 business days to show it.`);
    expect(refundLine(f, "de", "direct")).toBe(`Ihre Erstattung: am ${utcDate(T0 + DAY)} verarbeitet; Ihre Bank kann 5 bis 10 Werktage brauchen, bis sie sichtbar ist.`);
    expect(refundLine(f, "en", "direct")).not.toMatch(/confirmed|arrive/i);
  });
  it("failed or canceled is delayed, whatever was submitted before; so is an operation stuck for 3 attempts", () => {
    for (const st of ["failed", "canceled"]) expect(refundState(fields({ stripe_refund_status: st, refund_submitted_at: T0 }), "direct").status).toBe("delayed");
    expect(refundState(fields({ attempts: 3 }), "direct").status).toBe("delayed");
    expect(refundState(fields({ attempts: 2 }), "direct").status).toBe("being_prepared");
    expect(refundLine(fields({ stripe_refund_status: "failed" }), "en", "mp")).toBe("Your refund: delayed; we are trying again.");
    // Astra WP3-6 #3: a held operation never reads "processed", whatever success its row shows.
    const held = fields({ stripe_refund_status: "succeeded", refunded_at: T0, refund_submitted_at: T0, attribution_hold: 1 });
    expect(refundState(held, "direct")).toEqual({ status: "delayed", path: "direct" });
    expect(refundLine(held, "en", "direct")).toBe("Your refund: delayed; we are trying again.");
    expect(refundLine(held, "de", "mp")).toBe("Ihre Erstattung: verzögert; wir versuchen es erneut.");
    expect(refundState({ ...held, attribution_hold: 0 }, "direct").status).toBe("processed");
    expect(refundLine(fields({ stripe_refund_status: "failed" }), "de", "mp")).toBe("Ihre Erstattung: verzögert; wir versuchen es erneut.");
  });
});

describe("WP3 one-per-person constants (Test 7 additions)", () => {
  it("a payment refunded in full because it never started a plan (mismatch, paused country, rejected consent) is not a first payment", () => {
    for (const k of ["mismatch", "country_paused", "rejected_consent"]) expect(NOT_A_FIRST_PAYMENT_KINDS).toContain(k);
  });
  it("the Cloud terms ids carrying the limit are behind the launch flag: off until REFUND_LIMIT_V2_LIVE=1", () => {
    const id = "cloud-terms-964155e36e8b";
    expect(REFUND_LIMIT_V2_CLOUD_TERMS_IDS).toEqual([id]);
    expect(refundLimitVersions({} as Env)).toEqual([]);
    expect(refundLimitVersions({ REFUND_LIMIT_V2_LIVE: "0" } as Env)).toEqual([]);
    expect(refundLimitVersions({ REFUND_LIMIT_V2_LIVE: "1" } as Env)).toEqual([id]);
    expect(refundLimitVersions({ REFUND_LIMIT_V2_LIVE: "1", REFUND_LIMIT_TERMS_VERSIONS: "x,y" } as Env).sort()).toEqual([id, "x", "y"]);
    // The site page's display label is never a version id: no acceptance row carries it.
    expect(refundLimitVersions({ REFUND_LIMIT_V2_LIVE: "1" } as Env)).not.toContain("2026-10-11.1");
  });
  it("GUARD: the current generated Cloud terms id is listed and its text carries the one-per-person limit", () => {
    // If this fails after regenerating legal-docs.generated.ts: the Cloud terms id changed. If the new text still carries the limit,
    // APPEND the new id to REFUND_LIMIT_V2_CLOUD_TERMS_IDS (refund-identity.ts) and KEEP the old ones; never list the page label.
    expect(LEGAL_DOCS.cloudTerms.versionId).toMatch(/^cloud-terms-[0-9a-f]{12}$/);
    expect(REFUND_LIMIT_V2_CLOUD_TERMS_IDS).toContain(LEGAL_DOCS.cloudTerms.versionId);
    expect(LEGAL_DOCS.cloudTerms.text).toContain("once per person or payment method");
    for (const v of REFUND_LIMIT_V2_CLOUD_TERMS_IDS) expect(v).toMatch(/^cloud-terms-[0-9a-f]{12}$/);
  });
});

describe("WP3 amounts at the edges (Astra WP3-1 untested rules)", () => {
  const P = { oldPeriodStart: T0, oldPeriodEnd: T0 + 30 * DAY };
  it("exact period endpoints: a cutover at the start refunds all of it, at the end nothing; one millisecond inside rounds to the nearest cent", () => {
    expect(checkoutRefundTarget("cutover", 4900, { ...P, cutoverAt: T0 })).toBe(4900);
    expect(checkoutRefundTarget("cutover", 4900, { ...P, cutoverAt: T0 + 30 * DAY })).toBe(0);
    expect(checkoutRefundTarget("extraordinary", 4900, { ...P, cutoverAt: T0 + 1 })).toBe(4900);
    expect(checkoutRefundTarget("extraordinary", 4900, { ...P, cutoverAt: T0 + 30 * DAY - 1 })).toBe(0);
    expect(unusedFraction({ ...P, cutoverAt: T0 })).toEqual({ num: 30 * DAY, den: 30 * DAY });
    expect(unusedFraction({ ...P, cutoverAt: T0 + 30 * DAY })).toEqual({ num: 0, den: 30 * DAY });
  });
  it("half a cent rounds up (round half up), never truncated", () => {
    expect(apiAmountCents(4901, 1, 2)).toBe(2451); // 2450.5
    expect(apiAmountCents(4899, 1, 2)).toBe(2450); // 2449.5
    expect(apiAmountCents(3, 1, 2)).toBe(2); // 1.5
    expect(apiAmountCents(1, 1, 2)).toBe(1); // 0.5
    expect(checkoutRefundTarget("cutover", 4901, { ...P, cutoverAt: T0 + 15 * DAY })).toBe(2451);
  });
  it("a period crossing a daylight-saving change is measured in elapsed time, not calendar days", () => {
    // Europe/Berlin: 2026-03-15 00:00 to 2026-04-15 00:00 local is 31 days less one hour (clocks go forward on 2026-03-29); the cutover is
    // 2026-03-31 00:00 local, so exactly 15 x 24 hours of the 743 remain. A calendar count (15/31) would give 2371.
    const spring = { oldPeriodStart: Date.UTC(2026, 2, 14, 23), oldPeriodEnd: Date.UTC(2026, 3, 14, 22), cutoverAt: Date.UTC(2026, 2, 30, 22) };
    expect(unusedFraction(spring)).toEqual({ num: 360 * 3_600_000, den: 743 * 3_600_000 });
    expect(checkoutRefundTarget("cutover", 4900, spring)).toBe(2374); // 4900 x 360 / 743 = 2374.16
    // 2026-10-15 to 2026-11-15 local is 31 days and one hour (clocks go back on 2026-10-25).
    const autumn = { oldPeriodStart: Date.UTC(2026, 9, 14, 22), oldPeriodEnd: Date.UTC(2026, 10, 14, 23), cutoverAt: Date.UTC(2026, 9, 30, 23) };
    expect(unusedFraction(autumn)).toEqual({ num: 360 * 3_600_000, den: 745 * 3_600_000 });
    expect(checkoutRefundTarget("extraordinary", 4900, autumn)).toBe(2368); // 4900 x 360 / 745 = 2367.79
  });
});
