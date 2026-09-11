// "You have not set this up" and "I could not read your key" produce the same
// empty screen today. They are opposite situations: the first is the truth,
// the second is ignorance the UI must be told about so it can keep showing
// what it already knew.
import { describe, expect, it } from "vitest";

import { connectorAvailability, connectorPanelFields, resetManagedBrokerState } from "./composio.ts";
import type { AppConfig } from "./config.ts";

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...over }) as AppConfig;

describe("connectorAvailability", () => {
  it("is configured when a project key is present", () => {
    expect(connectorAvailability(cfg({ composio: { apiKey: "ak_live" } }), undefined)).toBe("configured");
  });

  it("is unconfigured when there is no key and the store read fine", () => {
    expect(connectorAvailability(cfg(), undefined)).toBe("unconfigured");
    expect(connectorAvailability(cfg({ composio: { apiKey: "" } }), "ok")).toBe("unconfigured");
  });

  it("is unreadable when the desktop shell could not open the credential store", () => {
    expect(connectorAvailability(cfg(), "unavailable")).toBe("unreadable");
  });

  it("prefers a working key over a store that failed earlier in the launch", () => {
    // the key arrived some other way (env, self-hosted config): what the user
    // can actually do matters more than how the shell felt about it
    expect(connectorAvailability(cfg({ composio: { apiKey: "ak_live" } }), "unavailable")).toBe("configured");
  });
});

// The unconfigured screen has to be able to tell three situations apart: this
// workspace never set connected apps up, FluxRouter is configured but its
// broker cannot be reached, and this build has no FluxRouter broker at all.
// Only the first one should offer to enable FluxRouter.
describe("what an unconfigured connectors response carries", () => {
  it("says whether FluxRouter is connected and whether this build can use it", () => {
    resetManagedBrokerState();
    const unconfigured = connectorPanelFields(cfg(), false);
    expect(unconfigured).toEqual({
      broker: null,
      migration: { state: "none", legacyUntil: null },
      fluxConfigured: false,
      fluxBrokerEnabled: false,
      freeRunsRemainingToday: null,
    });
    // `fluxConfigured` is a boolean the server computes; the key itself never
    // leaves the process.
    expect(connectorPanelFields(cfg(), true).fluxConfigured).toBe(true);
  });

  it("reports no free-run allowance while no FluxRouter broker is serving", () => {
    resetManagedBrokerState();
    expect(connectorPanelFields(cfg({ composio: { apiKey: "ak_live" } }), true).freeRunsRemainingToday).toBeNull();
  });
});
