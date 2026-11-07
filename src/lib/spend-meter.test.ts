// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { configAfterFluxKeyChange, formatDollars, matchedSpend, parseLimitInput, spendState, SUGGESTED_MONTHLY_LIMIT_USD } from "./spend-meter";

const resetsAt = "2026-12-01T00:00:00Z";
const total = (spentUsd: number) => ({ state: "ok" as const, spentUsd, asOf: "2026-11-04T10:00:00Z", resetsAt });

describe("matchedSpend (a figure only for the current key)", () => {
  const answer = (fingerprint: string | null, t: unknown = total(12)) => ({ fingerprint, total: t });
  it("shows the figure only when the answer's fingerprint equals the config's", () => {
    expect(matchedSpend(answer("fp-new"), "fp-new")).toEqual(total(12));
  });
  it("a key changed mid-request: an answer read under the old key never shows", () => {
    expect(matchedSpend(answer("fp-old", total(99)), "fp-new")).toEqual({ state: "pending" });
  });
  it("a settings save never brings an old figure back: the copied config has no fingerprint", () => {
    const before = { flux: { configured: true }, spend: { monthlyLimitUsd: 100, headsUpLeft: null, keyFingerprint: "fp-old" }, language: "en" };
    const copy = configAfterFluxKeyChange(before, true);
    expect(copy.spend.keyFingerprint).toBeNull();
    expect(copy.spend.monthlyLimitUsd).toBe(100);
    expect(copy.language).toBe("en");
    expect(before.spend.keyFingerprint).toBe("fp-old");
    expect(matchedSpend(answer("fp-old", total(99)), copy.spend.keyFingerprint)).toEqual({ state: "pending" });
    expect(configAfterFluxKeyChange({ flux: { configured: true } }, false)).toEqual({ flux: { configured: false } });
  });
  it("404, 503, no answer or anything malformed is pending, never $0", () => {
    for (const bad of [undefined, null, 5, "x", {}, { error: "not found" }, answer(null), answer("fp", { state: "ok", spentUsd: -1, asOf: "x", resetsAt }),
      answer("fp", { state: "ok", spentUsd: 3 }), answer("fp", { state: "pending" })]) {
      expect(matchedSpend(bad, "fp")).toEqual({ state: "pending" });
    }
    expect(matchedSpend(answer("fp"), null)).toEqual({ state: "pending" });
    expect(matchedSpend(answer("fp"), undefined)).toEqual({ state: "pending" });
  });
  it("keeps the multi-key state for a matched answer", () => {
    expect(matchedSpend(answer("fp", { state: "multiKey" }), "fp")).toEqual({ state: "multiKey" });
  });
  it("the heads-up comes only from a matched answer", () => {
    const config = { monthlyLimitUsd: 100, headsUpLeft: null };
    expect(spendState(matchedSpend(answer("fp", total(90)), "fp"), config).headsUp).toBe("warn");
    expect(spendState(matchedSpend(answer("fp-old", total(150)), "fp"), config).headsUp).toBeNull();
  });
});

describe("spendState", () => {
  const limit = { monthlyLimitUsd: 100, headsUpLeft: null };
  it("heads-up at 80% and at the limit, keyed to Flux's resets_at", () => {
    expect(spendState(total(79.99), limit)).toMatchObject({ level: "ok", headsUp: null });
    expect(spendState(total(80), limit)).toMatchObject({ level: "warn", headsUp: "warn", leaveKey: `${resetsAt}@80` });
    expect(spendState(total(100), limit)).toMatchObject({ level: "limit", headsUp: "limit", leaveKey: `${resetsAt}@100` });
  });
  it("a left heads-up stays left for that Flux month and level only", () => {
    expect(spendState(total(85), { monthlyLimitUsd: 100, headsUpLeft: `${resetsAt}@80` }).headsUp).toBeNull();
    expect(spendState(total(100), { monthlyLimitUsd: 100, headsUpLeft: `${resetsAt}@80` }).headsUp).toBe("limit");
    expect(spendState({ ...total(85), resetsAt: "2027-01-01T00:00:00Z" }, { monthlyLimitUsd: 100, headsUpLeft: `${resetsAt}@80` }).headsUp).toBe("warn");
  });
  it("no total (pending or several keys) means no heads-up and no percent", () => {
    expect(spendState({ state: "pending" }, limit)).toMatchObject({ level: "none", percent: null, headsUp: null, limitUsd: 100 });
    expect(spendState({ state: "multiKey" }, limit)).toMatchObject({ level: "none", percent: null, headsUp: null });
  });
});

describe("limit field and dollars", () => {
  it("parses and formats", () => {
    expect(parseLimitInput("$1,000")).toBe(1000);
    expect(parseLimitInput("")).toBeNull();
    expect(parseLimitInput("abc")).toBeUndefined();
    expect(formatDollars(812)).toBe("$812");
    expect(formatDollars(12.4)).toBe("$12.40");
    expect(SUGGESTED_MONTHLY_LIMIT_USD).toBe(1000);
  });
});
