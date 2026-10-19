import { describe, expect, it } from "vitest";
import { classifyReplacedInvoice, cutoverEstimate, invoiceCoveringPaidAt, MISSING_DE_REPLACEMENT, NONE_SELLER, pathCoverage, periodEndFallback, REPLACEMENT_WORDS, replacementWords, routeExpiresAt, routeIsValid, ROUTE_GRACE_MS, usdFor, type RetryRoute } from "../src/checkout-replacement";
import { sellerSettings } from "../src/seller";

const DAY = 86_400_000;
describe("Cloud checkout WP6: pure rules (plan r13d §1.3)", () => {
  const managed = sellerSettings({ CLOUD_NONUS_SELLER: "managed_payments", FERROX_TAX_COUNTRIES: "US" });
  it("path coverage: same path covered, other path named, nobody -> uncovered, malformed -> unknown (a renewal is never touched on a guess)", () => {
    expect(pathCoverage(managed, "ferrox", "us")).toEqual({ kind: "covered" });
    expect(pathCoverage(managed, "link", "FR")).toEqual({ kind: "covered" });
    expect(pathCoverage(managed, "ferrox", "FR")).toEqual({ kind: "other_path", seller: "link" });
    expect(pathCoverage(managed, "link", "US")).toEqual({ kind: "other_path", seller: "ferrox" });
    expect(pathCoverage(managed, "link", "ZZ")).toEqual({ kind: "uncovered" });
    for (const bad of [null, undefined, "", "USA", "1"]) expect(pathCoverage(managed, "link", bad)).toEqual({ kind: "unknown" });
  });
  it("r1-3: coverage is the RETAINED seller's, independent of new-purchase routing; another seller only when it no longer covers", () => {
    const direct = sellerSettings({ CLOUD_NONUS_SELLER: "direct", FERROX_TAX_COUNTRIES: "US" });
    expect(pathCoverage(direct, "link", "FR")).toEqual({ kind: "covered" }); // new signups go direct; Link still covers FR
    expect(pathCoverage(direct, "link", "US")).toEqual({ kind: "other_path", seller: "ferrox" });
    expect(pathCoverage(direct, "ferrox", "FR")).toEqual({ kind: "uncovered" }); // no Ferrox registration there, and direct sells no one else
    const registered = sellerSettings({ CLOUD_NONUS_SELLER: "managed_payments", FERROX_TAX_COUNTRIES: "US,FR" });
    expect(pathCoverage(registered, "ferrox", "FR")).toEqual({ kind: "covered" }); // Ferrox's own FR registration keeps a direct plan covered
  });
  it("r1-5/r1-6: an old invoice is judged against the frozen boundary; the frozen invoice is the one covering paidAt", () => {
    const b = { cutoverAt: 10 * DAY, oldInvoiceId: "in_1" };
    expect(classifyReplacedInvoice(b, { id: "in_1", periodStart: 0, periodEnd: 30 * DAY })).toBe("frozen");
    expect(classifyReplacedInvoice(b, { id: "in_0", periodStart: -30 * DAY, periodEnd: 0 })).toBe("served");
    expect(classifyReplacedInvoice(b, { id: "in_0", periodStart: -20 * DAY, periodEnd: 10 * DAY })).toBe("served");
    expect(classifyReplacedInvoice(b, { id: "in_3", periodStart: 30 * DAY, periodEnd: 60 * DAY })).toBe("unserved");
    expect(classifyReplacedInvoice(b, { id: "in_3", periodStart: 10 * DAY, periodEnd: 40 * DAY })).toBe("unserved");
    expect(classifyReplacedInvoice(b, { id: "in_2", periodStart: 0, periodEnd: 30 * DAY })).toBe("overlap");
    expect(classifyReplacedInvoice({ cutoverAt: 10 * DAY, oldInvoiceId: null }, { id: "in_1", periodStart: 0, periodEnd: 30 * DAY })).toBe("overlap");
    for (const [s, e] of [[null, 30 * DAY], [0, null], [30 * DAY, 30 * DAY]] as const) expect(classifyReplacedInvoice(b, { id: "x", periodStart: s, periodEnd: e })).toBe("unclassified");
    const p = [{ id: "a", start: 0, end: 30 * DAY }, { id: "b", start: 30 * DAY, end: 60 * DAY }];
    expect(invoiceCoveringPaidAt(p, 2 * DAY)?.id).toBe("a"); // never simply the greatest period end
    expect(invoiceCoveringPaidAt(p, 30 * DAY)?.id).toBe("b");
    expect(invoiceCoveringPaidAt(p, 61 * DAY)).toBeNull();
  });
  it("the cutover estimate is the unused fraction of the FROZEN period, rounded in cents; nothing owed after the period", () => {
    const f = { cutoverAt: 2 * DAY, oldPeriodStart: 0, oldPeriodEnd: 30 * DAY };
    expect(cutoverEstimate(4900, f)).toEqual({ days: 28, cents: Math.round(4900 * 28 / 30) });
    expect(cutoverEstimate(4900, { ...f, cutoverAt: 31 * DAY })).toBeNull();
    expect(cutoverEstimate(0, f)).toBeNull();
    expect(cutoverEstimate(4900, { ...f, oldPeriodEnd: 0 })).toBeNull();
  });
  it("a route lets a running home check out again only when it is an unexpired address_change route for THIS subscription with a path that can sell", () => {
    const r: RetryRoute = { account_id: "u", seller: "link", collected_country: "FR", reason: "address_change", replaces_subscription_id: "sub_1", expires_at: 1000 };
    expect(routeIsValid(r, "sub_1", 999)).toBe(true);
    expect(routeIsValid(r, "sub_1", 1000)).toBe(false);
    expect(routeIsValid(r, "sub_2", 999)).toBe(false);
    expect(routeIsValid({ ...r, reason: "mismatch" }, "sub_1", 999)).toBe(false);
    expect(routeIsValid({ ...r, seller: NONE_SELLER }, "sub_1", 999)).toBe(false);
    expect(routeIsValid(null, "sub_1", 999)).toBe(false);
    expect(routeExpiresAt(5000, 1000)).toBe(5000 + ROUTE_GRACE_MS);
    expect(routeExpiresAt(null, 1000)).toBe(1000 + ROUTE_GRACE_MS);
  });
  it("every WP6 customer string has German (the launch gate is empty); English is unchanged; no refund is claimed before the ledger says so", () => {
    expect(MISSING_DE_REPLACEMENT).toEqual([]);
    expect(replacementWords("replacementUnpaid", "de")).toBe("Wir haben Ihre Bestellung erhalten. Wir stellen Ihren Plan um, sobald die Zahlung eingeht.");
    expect(replacementWords("replacementUnpaid", "en")).toBe("We got your order. We'll switch your plan as soon as your payment clears.");
    expect(usdFor(1250, "de")).toBe("12,50 US$");
    expect(usdFor(1250, "en")).toBe("US$12.50");
    expect(replacementWords("replacementDone", "en", { amount: "US$1.00", days: "3" })).not.toMatch(/we refunded/i);
  });
  it("null period end: the fallback is chosen by language, and the German templates read as German with it", () => {
    const en = periodEndFallback("en");
    expect(en).toBe("the end of the period you paid for");
    expect(periodEndFallback(null)).toBe(en);
    const de = periodEndFallback("de");
    expect(de).toBe("Ende des bezahlten Zeitraums");
    for (const key of ["addressChangeA", "addressChangeB", "replacementFailed"] as const) {
      const out = replacementWords(key, "de", { country: "Frankreich", payee: "Ferrox", periodEnd: de });
      expect(out).toContain("Ende des bezahlten Zeitraums");
      expect(out).not.toMatch(/\b(the|end|period|you|paid|for)\b/);
      expect(out).not.toMatch(/\bam dem\b/);
      expect(out).not.toContain("{");
    }
    expect(replacementWords("addressChangeA", "de", { country: "X", payee: "Y", periodEnd: de })).toContain("vor dem Ende des bezahlten Zeitraums");
    expect(replacementWords("addressChangeB", "de", { country: "X", periodEnd: de })).toContain("endet Ihr Plan am Ende des bezahlten Zeitraums");
    expect(replacementWords("replacementFailed", "de", { periodEnd: de })).toContain("endet weiterhin am Ende des bezahlten Zeitraums");
    // English path is unchanged
    expect(replacementWords("replacementFailed", "en", { periodEnd: en })).toContain("still ends on the end of the period you paid for");
  });
});
