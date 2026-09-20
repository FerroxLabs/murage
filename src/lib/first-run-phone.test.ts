import { describe, expect, it } from "vitest";

import type { CompanionState } from "@/components/PhoneSetupFlow";
import {
  firstRunPhoneVariant,
  firstRunTailscaleStep,
  firstRunTailscaleTrouble,
  tailnetReachable,
} from "./first-run-phone";

const base: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 4321,
  devices: [],
  pairing: null,
};

const remote = (patch: Partial<NonNullable<CompanionState["remoteAccess"]>>) => ({
  on: false, desired: false, url: null, available: null, reason: null, problem: null, ...patch,
});

describe("deciding which phone card is honest", () => {
  it("offers the QR only when there is a tailnet address to put in it", () => {
    expect(tailnetReachable({ ...base, tailscale: "mac-mini.tail1234.ts.net" })).toBe(true);
    expect(tailnetReachable({
      ...base,
      endpoints: [{ kind: "tailnet", priority: 1, url: "http://mac-mini.tail1234.ts.net:4321" }],
    })).toBe(true);
    expect(firstRunPhoneVariant({ ...base, tailscale: "mac-mini.tail1234.ts.net" })).toBe("phone");
  });

  it("never offers a QR on a machine that cannot answer one", () => {
    expect(tailnetReachable(null)).toBe(false);
    expect(tailnetReachable(base)).toBe(false);
    expect(tailnetReachable({ ...base, tailscale: "   " })).toBe(false);
    expect(tailnetReachable({ ...base, endpoints: [{ kind: "lan", priority: 2, url: "http://192.168.0.4:4321" }] })).toBe(false);
    // An endpoint the sidecar labelled tailnet but could not name is not an
    // address; a QR built from it is the dead button this rule exists for.
    expect(tailnetReachable({ ...base, endpoints: [{ kind: "tailnet", priority: 1, url: "" }] })).toBe(false);
    for (const state of [null, base]) expect(firstRunPhoneVariant(state)).toBe("phone-needs-tailscale");
  });

  it("does not read a running sidecar as a working tailnet", () => {
    // The sidecar being up says the door is open on this machine, which is a
    // different question from whether a phone can reach it.
    expect(firstRunPhoneVariant({ ...base, enabled: true, addresses: ["http://127.0.0.1:4321"] })).toBe("phone-needs-tailscale");
  });
});

describe("what to tell someone whose phone cannot be paired yet", () => {
  it("says nothing is wrong when pairing is possible", () => {
    expect(firstRunTailscaleTrouble({ ...base, tailscale: "mac.tail.ts.net" })).toBeNull();
  });

  it("separates not installed from not signed in", () => {
    expect(firstRunTailscaleTrouble({ ...base, remoteAccess: remote({ available: false, reason: "missing" }) })).toBe("missing");
    expect(firstRunTailscaleTrouble({ ...base, remoteAccess: remote({ available: true, reason: "missing" }) })).toBe("missing");
    expect(firstRunTailscaleTrouble({ ...base, remoteAccess: remote({ available: true, reason: "logged-out" }) })).toBe("signed-out");
  });

  it("admits it does not know rather than guessing", () => {
    expect(firstRunTailscaleTrouble(null)).toBe("unknown");
    expect(firstRunTailscaleTrouble(base)).toBe("unknown");
    expect(firstRunTailscaleTrouble({ ...base, remoteAccess: remote({ available: null }) })).toBe("unknown");
    // Certificates are a `tailscale serve` problem. Plain tailnet pairing
    // does not need them, so this is never a reason to send someone to a
    // download page they do not need.
    expect(firstRunTailscaleTrouble({ ...base, remoteAccess: remote({ available: true, reason: "no-certificates" }) })).toBe("unknown");
  });

  it("starts the walkthrough where the person actually is", () => {
    expect(firstRunTailscaleStep({ ...base, remoteAccess: remote({ available: false, reason: "missing" }) })).toBe(0);
    expect(firstRunTailscaleStep(null)).toBe(0);
    expect(firstRunTailscaleStep({ ...base, remoteAccess: remote({ available: true, reason: "logged-out" }) })).toBe(1);
  });
});
