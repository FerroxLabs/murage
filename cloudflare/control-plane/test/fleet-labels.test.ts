// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { claimFleetLabels, fleetValue, poolFleetLabels } from "../src/fleet-labels";

const NOW = Date.parse("2026-11-11T00:00:00Z");
describe("1019 fleet label values", () => {
  it("every generated value matches [A-Za-z0-9._-]{1,63}; production maps to prod", () => {
    for (const env of ["staging", "production"]) for (const v of Object.values(poolFleetLabels(env, NOW))) expect(v).toMatch(/^[A-Za-z0-9._-]{1,63}$/);
    expect(poolFleetLabels("production", NOW)).toEqual({ owner: "MurageCloud", purpose: "prod-warm-pool", expires_at: "2027-02-09" });
    expect(() => fleetValue("has space")).toThrow();
    expect(() => fleetValue("a:b")).toThrow();
    expect(() => fleetValue("")).toThrow();
    expect(() => fleetValue("x".repeat(64))).toThrow();
  });
  it("claim drops expires_at and the warm-pool purpose, keeps murage/*", () => {
    expect(claimFleetLabels({ "murage/role": "pool", owner: "x", purpose: "prod-warm-pool", expires_at: "2027-01-01" })).toEqual({ "murage/role": "pool", owner: "MurageCloud", purpose: "customer-home" });
  });
});
