import { describe, expect, it } from "vitest";
import { autoMountsLocalComputer, botUsesHostComputer, shouldMountLocalComputer } from "./local-routing.ts";

describe("local computer routing", () => {
  it("never lets Linux Auto fall back to the user's desktop", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit local selection and an approval-capable provider on Linux", () => {
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "linux",
        providerSupportsLocal: false,
      }),
    ).toBe(false);
  });

  it("preserves the established macOS Auto fallback", () => {
    expect(
      shouldMountLocalComputer({
        requested: undefined,
        hostPlatform: "darwin",
        providerSupportsLocal: true,
      }),
    ).toBe(true);
  });

  it("never mounts the local desktop for explicit cloud/off or on an unsupported host", () => {
    for (const requested of ["cloud", "off"] as const) {
      expect(
        shouldMountLocalComputer({
          requested,
          hostPlatform: "darwin",
          providerSupportsLocal: true,
        }),
      ).toBe(false);
    }
    expect(
      shouldMountLocalComputer({
        requested: "local",
        hostPlatform: "win32",
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });
});

describe("autoMountsLocalComputer (the one Auto-consent rule for both PATCH routes)", () => {
  it("treats a bot that never chose a computer as this Mac, like an explicit local", () => {
    expect(autoMountsLocalComputer(undefined, "darwin")).toBe(true);
    expect(autoMountsLocalComputer("local", "darwin")).toBe(true);
    expect(autoMountsLocalComputer("local", "linux")).toBe(true);
  });

  it("never mounts the desktop for a default destination off macOS, or for any other destination", () => {
    expect(autoMountsLocalComputer(undefined, "linux")).toBe(false);
    expect(autoMountsLocalComputer(undefined, "win32")).toBe(false);
    expect(autoMountsLocalComputer("local", "win32")).toBe(false);
    for (const computer of ["cloud", "vm", "browser", "off"] as const) {
      expect(autoMountsLocalComputer(computer, "darwin"), computer).toBe(false);
      expect(autoMountsLocalComputer(computer, "linux"), computer).toBe(false);
    }
  });
});

describe("botUsesHostComputer (the one \"is this bot on my desktop?\" rule)", () => {
  // The panic sweep and the host RPC gate both ask this, and they used to
  // spell it out separately: the gate folded `undefined` in, the sweep did
  // not, and the sweep missed every bot that never chose a computer — the
  // default for every bot an owner creates. One function now answers both.
  it("counts the unassigned default as this machine on macOS, exactly as the gate always did", () => {
    expect(botUsesHostComputer(undefined, "darwin")).toBe(true);
    expect(botUsesHostComputer("local", "darwin")).toBe(true);
    expect(botUsesHostComputer("local", "linux")).toBe(true);
  });

  it("does not sweep in a whole workspace on a platform where Auto never reaches the desktop", () => {
    expect(botUsesHostComputer(undefined, "linux")).toBe(false);
    expect(botUsesHostComputer(undefined, "win32")).toBe(false);
    expect(botUsesHostComputer("local", "win32")).toBe(false);
  });

  it("never counts a destination that is not the person's own machine", () => {
    for (const computer of ["cloud", "vm", "browser", "off"] as const) {
      expect(botUsesHostComputer(computer, "darwin"), computer).toBe(false);
      expect(botUsesHostComputer(computer, "linux"), computer).toBe(false);
    }
  });

  it("is the same implementation the Auto acknowledgement uses, so the two cannot drift", () => {
    expect(autoMountsLocalComputer).toBe(botUsesHostComputer);
  });
});
