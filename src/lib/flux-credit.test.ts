// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/engine-health read as a route credit for the Fuigo and Flux rows: never an endless "Checking".
import { describe, expect, it } from "vitest";

import "@/lib/settings-copy";
import type { EngineHealthAnswer } from "@/components/shell/shell-contract";
import { FLUX_WATCH_PCT } from "@/components/health/health-findings";
import { creditFromHealth } from "./flux-credit";
import { routeState, type RouteInstance } from "./route-state";

const NOW = 1_800_000_000_000;
const CHECKED = NOW - 20_000;
const answer = (flux: EngineHealthAnswer["flux"], spendPct: number | null | undefined = undefined, checkedAt = CHECKED): EngineHealthAnswer => ({
  engines: [], primary: null, flux, fluxInfo: spendPct === undefined ? null : { spendPct, expires: null }, checkedAt,
} as EngineHealthAnswer);
const fuigo: RouteInstance = { instanceId: "fuigo", driverKind: "fuigoAgent", displayName: "Fuigo", enabled: true, snapshot: { state: "available", authenticated: true } };
const line = (a: EngineHealthAnswer | null) => routeState(null, fuigo, null, creditFromHealth(a, NOW), NOW);

describe("creditFromHealth", () => {
  it("allowance-used-up is out, ok is ok, and the time is the answer's own checkedAt", () => {
    expect(creditFromHealth(answer("allowance-used-up"), NOW)).toEqual({ state: "out", asOf: CHECKED });
    expect(creditFromHealth(answer("ok", 10), NOW)).toEqual({ state: "ok", asOf: CHECKED });
  });
  it("spend at the watch threshold (80, the one Health uses) is low; just under is ok", () => {
    expect(FLUX_WATCH_PCT).toBe(80);
    expect(creditFromHealth(answer("ok", 80), NOW)?.state).toBe("low");
    expect(creditFromHealth(answer("ok", 79), NOW)?.state).toBe("ok");
    expect(creditFromHealth(answer("ok", null), NOW)?.state).toBe("ok");
  });
  it("no key and a refused key are their own readings; no answer at all is no reading", () => {
    expect(creditFromHealth(answer("none"), NOW)).toEqual({ state: "noKey", asOf: CHECKED });
    expect(creditFromHealth(answer("key-problem"), NOW)).toEqual({ state: "keyProblem", asOf: CHECKED });
    expect(creditFromHealth(null, NOW)).toBeNull();
  });
  it("ok with no figures (a slow, failed or skipped Flux check) is no reading, never Ready", () => {
    expect(creditFromHealth(answer("ok"), NOW)).toBeNull();
    expect(line(answer("ok")).line).toBe("Credit is not available right now.");
  });
  it("an answer with no usable checkedAt is stamped with the fetch time", () => {
    expect(creditFromHealth({ ...answer("ok", 5), checkedAt: undefined as unknown as number }, NOW)?.asOf).toBe(NOW);
  });
});

describe("the Fuigo row from the health answer", () => {
  it("reads out, low and ready in the route words", () => {
    expect(line(answer("allowance-used-up"))).toMatchObject({ state: "addCredit", line: "Your Flux credit has run out." });
    expect(line(answer("ok", 85))).toMatchObject({ state: "lowCredit" });
    expect(line(answer("ok", 5))).toMatchObject({ state: "ready", line: "Ready · on Flux credit" });
  });
  it("none, a refused key and no answer say so plainly and never say Checking", () => {
    const none = line(answer("none")); const bad = line(answer("key-problem")); const gone = line(null);
    expect(none.line).toBe("Fuigo needs a Flux key.");
    expect(bad.line).toBe("Flux did not accept your key.");
    expect(gone.line).toBe("Credit is not available right now.");
    for (const r of [none, bad, gone]) { expect(r.line).not.toMatch(/checking/i); expect(r.selectable).toBe(true); }
  });
});
