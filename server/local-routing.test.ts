import { describe, expect, it } from "vitest";
import { autoMountsLocalComputer, shouldMountLocalComputer } from "./local-routing.ts";

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
