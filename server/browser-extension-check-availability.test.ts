// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "./contracts.ts";
import { checkerAvailability, checkerAvailabilityFor, FLUX_NO_RETAIN_DEPLOYED } from "./browser-extension-check-availability.ts";

const engine = (over: Record<string, unknown> = {}) => ({ instanceId: "e1", driverKind: "x", displayName: "E", enabled: true, reviewPermission: async () => "ALLOW", ...over }) as unknown as ProviderInstance;
const KEY = () => "flux_test_key_not_real";

describe("checkerAvailabilityFor (from the resolved connection)", () => {
  it("Flux live and connected: Flux, no fallback", () => {
    expect(checkerAvailabilityFor({ check: "flux", instances: [], readKey: KEY, noRetainDeployed: true })).toEqual({ checkerAvailable: true, checkerSource: "flux" });
  });
  it("Flux not live with a usable bot engine: falls back to the bot engine and says so", () => {
    expect(checkerAvailabilityFor({ check: "flux", instances: [engine()], readKey: KEY, noRetainDeployed: false })).toEqual({ checkerAvailable: true, checkerSource: "bot", checkerFallback: true });
    expect(FLUX_NO_RETAIN_DEPLOYED).toBe(true);
    expect(checkerAvailabilityFor({ check: "flux", instances: [engine()], readKey: () => null })).toMatchObject({ checkerAvailable: true, checkerSource: "bot", checkerFallback: true });
    expect(checkerAvailabilityFor({ check: "flux", instances: [engine()], readKey: KEY })).toEqual({ checkerAvailable: true, checkerSource: "flux" });
  });
  it("Flux not live and no bot engine: unavailable with the honest reason", () => {
    expect(checkerAvailabilityFor({ check: "flux", instances: [], readKey: KEY, noRetainDeployed: false })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoRetain" });
    expect(checkerAvailabilityFor({ check: "flux", instances: [engine({ enabled: false })], readKey: () => null })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoFlux" });
  });
  it("the bot switch needs a usable engine, whatever its name says", () => {
    expect(checkerAvailabilityFor({ check: "bot", instances: [engine()] })).toEqual({ checkerAvailable: true, checkerSource: "bot" });
    expect(checkerAvailabilityFor({ check: "bot", instances: [engine({ reviewPermission: undefined })], readKey: KEY, noRetainDeployed: true })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoBotEngine" });
    expect(checkerAvailabilityFor({ check: "bot", instances: [] })).toMatchObject({ checkerAvailable: false });
  });
  it("a configured engine id that is not usable is unavailable, not silently another engine", () => {
    expect(checkerAvailabilityFor({ check: "bot", instances: [engine()], botInstanceId: "other" }).checkerAvailable).toBe(false);
  });
});

describe("checkerAvailability (without the engine list)", () => {
  it("answers like checkerAvailabilityFor when told whether the engine is usable", () => {
    expect(checkerAvailability({ check: "flux", fluxConnected: true, noRetainDeployed: true })).toEqual({ checkerAvailable: true, checkerSource: "flux" });
    expect(checkerAvailability({ check: "flux", fluxConnected: true, noRetainDeployed: false, botEngineUsable: true })).toEqual({ checkerAvailable: true, checkerSource: "bot", checkerFallback: true });
    expect(checkerAvailability({ check: "flux", fluxConnected: true, noRetainDeployed: false, botEngineUsable: false })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoRetain" });
    expect(checkerAvailability({ check: "flux", fluxConnected: false, botEngineUsable: false })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoFlux" });
    expect(checkerAvailability({ check: "bot", fluxConnected: true, botEngineUsable: false })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoBotEngine" });
    expect(checkerAvailability({ check: "bot", fluxConnected: false, botEngineUsable: true })).toEqual({ checkerAvailable: true, checkerSource: "bot" });
  });
  it("callers that do not pass the engine fail closed: only a live Flux connection counts", () => {
    expect(checkerAvailability({ check: "bot", fluxConnected: false })).toEqual({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoBotEngine" });
    expect(checkerAvailability({ check: "bot", fluxConnected: true })).toMatchObject({ checkerAvailable: false });
    expect(checkerAvailability({ check: "flux", fluxConnected: true })).toEqual({ checkerAvailable: true, checkerSource: "flux" });
    expect(checkerAvailability({ check: "flux", fluxConnected: false })).toMatchObject({ checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoFlux" });
  });
});
