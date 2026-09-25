// When the computer is held awake for the phones.
//
// The setting reads "Keep this computer awake while a phone is paired", so
// that is the rule: the owner asked, the sidecar is really up, and there is a
// phone to serve. Holding a laptop awake for a fleet of zero is a battery bill
// for nothing, and a sidecar that failed serves nobody.
import { describe, expect, it } from "vitest";

import { companionShouldStayAwake } from "./companion-keep-awake.mjs";

const phone = { id: "p", name: "Phone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false };
const state = (over = {}) => ({ enabled: true, keepAwake: true, devices: [phone], ...over });

describe("keeping the computer awake", () => {
  it("holds it awake when asked, running, and a phone is paired", () => {
    expect(companionShouldStayAwake(state())).toBe(true);
  });

  it("lets it sleep when the owner has not asked", () => {
    expect(companionShouldStayAwake(state({ keepAwake: false }))).toBe(false);
  });

  it("lets it sleep when no phone is paired", () => {
    expect(companionShouldStayAwake(state({ devices: [] }))).toBe(false);
  });

  it("lets it sleep when the sidecar is off or failed", () => {
    expect(companionShouldStayAwake(state({ enabled: false }))).toBe(false);
    expect(companionShouldStayAwake(state({ error: "sidecar stopped responding" }))).toBe(false);
  });

  it("fails towards sleep on anything it cannot read", () => {
    expect(companionShouldStayAwake(null)).toBe(false);
    expect(companionShouldStayAwake(undefined)).toBe(false);
    expect(companionShouldStayAwake(state({ keepAwake: "yes" }))).toBe(false);
    expect(companionShouldStayAwake(state({ devices: undefined }))).toBe(false);
  });
});
