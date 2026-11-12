// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F5 staging fixtures (key-limits-v1, 2026-11-10): Flux's REAL response bodies, stored verbatim in
// server/fixtures/flux-key-limits-v1/. If Flux changes the contract (spend_basis included) these fail in CI, not in production.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFluxLimits, resetSpendBasisDriftLog } from "./flux-limits.ts";
import { decode402Body, decodeLimitsBody } from "./spend-gate.ts";

const load = (name: string): string => readFileSync(new URL(`./fixtures/flux-key-limits-v1/${name}.json`, import.meta.url), "utf8");
const body = (name: string): Record<string, unknown> => JSON.parse(load(name)) as Record<string, unknown>;

describe("F5 fixtures: 200 bodies parse as ok (meter parser)", () => {
  for (const name of ["01-regular-key", "02-email-bot-key-same-account", "03-account-total-null", "04-key-without-account", "11-regular-key-after", "13-bot-key-no-bot-budget"]) {
    it(`${name} -> ok`, () => {
      expect(parseFluxLimits(body(name))).toMatchObject({ state: "ok" });
    });
  }
});

describe("F5 fixtures: 200 bodies give key evidence (gate decoder)", () => {
  for (const name of ["01-regular-key", "02-email-bot-key-same-account", "03-account-total-null", "04-key-without-account", "11-regular-key-after", "13-bot-key-no-bot-budget"]) {
    it(`${name} -> key evidence present`, () => {
      expect(decodeLimitsBody(body(name))?.key).toBeDefined();
      expect(decodeLimitsBody(body(name))?.key).not.toBeNull();
    });
  }
  it("13: a null bot budget means no bot cap, not unknown", () => {
    const key = decodeLimitsBody(body("13-bot-key-no-bot-budget"))?.key;
    expect(key?.bot).toMatchObject({ budgetUsd: null });
    expect(parseFluxLimits(body("13-bot-key-no-bot-budget"))).toMatchObject({ state: "ok", bot: { spentUsd: 0.0001 } });
  });
});

describe("F5 fixtures: 12 is a 402 key_budget_reached", () => {
  it("decodes through the 402 decoder", () => {
    const d = decode402Body(JSON.parse(load("12-402-key-budget-reached")));
    expect(d).toMatchObject({ limit: "monthly_spend", budget: 0.001, spent: 0.0273, resetsAt: "2026-12-01T00:00:00Z", manageUrl: "https://fluxrouter.ai/home/keys" });
  });
});

describe("contract drift: an unknown spend_basis is pending and is said out loud", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => { resetSpendBasisDriftLog(); warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });
  const drifted = (v: unknown) => ({ ...body("01-regular-key"), spend_basis: v });

  it("pending in both parsers, with one support-bundle line carrying the field and value only", () => {
    expect(parseFluxLimits(drifted("billed_sale"))).toEqual({ state: "pending" });
    expect(decodeLimitsBody(drifted("billed_sale"))).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("spend_basis"));
    expect(lines).toEqual(['[flux-limits] contract drift: spend_basis="billed_sale" is not the accepted value; the spend meter stays pending']);
    expect(lines[0]).not.toMatch(/klv1|sk-|key_id|account/);
  });
  it("logs once per distinct value, not per request", () => {
    for (let i = 0; i < 5; i += 1) parseFluxLimits(drifted("net_sale"));
    parseFluxLimits(drifted("gross_sale"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("spend_basis"))).toHaveLength(2);
  });
  it("an id-shaped spend_basis is never printed, and dedupe is on the raw value", () => {
    const uuid = "3f2b8c1e-9d4a-4b7e-8a11-0c5d6e7f8a90";
    parseFluxLimits(drifted(uuid)); parseFluxLimits(drifted("sk-live-abcdef0123456789"));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("spend_basis"));
    expect(lines).toEqual([
      '[flux-limits] contract drift: spend_basis="<unrecognised, 36 chars>" is not the accepted value; the spend meter stays pending',
      '[flux-limits] contract drift: spend_basis="<unrecognised, 24 chars>" is not the accepted value; the spend meter stays pending',
    ]);
    expect(lines.join("")).not.toMatch(/3f2b|sk-live/);
  });
  it("two values sharing the same display text still each log once", () => {
    const a = "x".repeat(50) + "A"; const b = "x".repeat(50) + "B";
    parseFluxLimits(drifted(a)); parseFluxLimits(drifted(b)); parseFluxLimits(drifted(a));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("spend_basis"))).toHaveLength(2);
  });
  it("only a known Flux contract word is printed raw: acct_123456 and a lowercase letter-led uuid are not", () => {
    const uuid = "a3f2b8c19d4a4b7e8a110c5d6e7f8a90";
    parseFluxLimits(drifted("acct_123456")); parseFluxLimits(drifted(uuid)); parseFluxLimits(drifted("net_sale")); parseFluxLimits(drifted("billed_sale"));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("spend_basis"));
    expect(lines.map((l) => l.match(/spend_basis="([^"]*)"/)?.[1])).toEqual(["<unrecognised, 11 chars>", "<unrecognised, 32 chars>", "<unrecognised, 8 chars>", "billed_sale"]);
    expect(lines.join("")).not.toMatch(/acct_|a3f2|net_sale/);
  });
  it("lone surrogates and different types do not collide in the dedupe", () => {
    parseFluxLimits(drifted("bad\uD800")); parseFluxLimits(drifted("bad\uD801")); parseFluxLimits(drifted("bad\uD800"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("spend_basis"))).toHaveLength(2);
    resetSpendBasisDriftLog(); warn.mockRestore(); warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseFluxLimits(drifted(1)); parseFluxLimits(drifted("1"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("spend_basis"))).toHaveLength(2);
  });
  it("the retired bare billed_sale is not accepted", () => {
    expect(parseFluxLimits(drifted("billed_sale"))).toEqual({ state: "pending" });
  });
  it("the true value never logs", () => {
    parseFluxLimits(body("01-regular-key"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("spend_basis"))).toHaveLength(0);
  });
});
