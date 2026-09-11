import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoMountsThisComputer,
  autoNeedsLocalComputerWarning,
  autoSelectsLocalComputer,
  computerSwitchNeedsLocalAutoWarning,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localAutoHostPlatform,
  localComputerDisabledReason,
  localComputerSelectable,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: "cloud",
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });
});

describe("autoNeedsLocalComputerWarning", () => {
  const cases: Array<[string, Parameters<typeof autoNeedsLocalComputerWarning>[0], boolean]> = [
    ["a fresh Mac bot (no computer chosen) hands Auto this Mac", { platform: "darwin", computer: undefined, autoApprove: false }, true],
    ["an explicit local computer on macOS", { platform: "darwin", computer: "local", autoApprove: false }, true],
    ["an explicit local computer on Linux", { platform: "linux", computer: "local", autoApprove: false }, true],
    ["a fresh Linux bot mounts nothing by default", { platform: "linux", computer: undefined, autoApprove: false }, false],
    ["a fresh Windows bot mounts nothing", { platform: "win32", computer: undefined, autoApprove: false }, false],
    ["a cloud box is not this computer", { platform: "darwin", computer: "cloud", autoApprove: false }, false],
    ["computer off is not this computer", { platform: "darwin", computer: "off", autoApprove: false }, false],
    ["a VM is not this computer", { platform: "darwin", computer: "vm", autoApprove: false }, false],
    ["the browser is not this computer", { platform: "darwin", computer: "browser", autoApprove: false }, false],
    ["already on Auto: nothing to acknowledge", { platform: "darwin", computer: "local", autoApprove: true }, false],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(autoNeedsLocalComputerWarning(input)).toBe(expected);
    });
  }
});

describe("computerSwitchNeedsLocalAutoWarning (AUTOOP2 verifier follow-up)", () => {
  // The destination switch on an Auto-on bot needs the acknowledgement
  // exactly when the server's profile PATCH would refuse it without one:
  // the new destination mounts this computer and the current one did not.
  const cases: Array<[string, Parameters<typeof computerSwitchNeedsLocalAutoWarning>[0], boolean]> = [
    ["Auto-on Mac bot leaving a cloud box for the Auto destination", { platform: "darwin", from: "cloud", to: undefined, autoApprove: true }, true],
    ["Auto-on Mac bot leaving off for this computer", { platform: "darwin", from: "off", to: "local", autoApprove: true }, true],
    ["Auto-on Mac bot leaving a VM for the Auto destination", { platform: "darwin", from: "vm", to: undefined, autoApprove: true }, true],
    ["Auto-on Linux bot picking this computer explicitly", { platform: "linux", from: undefined, to: "local", autoApprove: true }, true],
    ["Auto-on Linux bot moving to the Auto destination mounts nothing", { platform: "linux", from: "cloud", to: undefined, autoApprove: true }, false],
    ["Auto-on Windows bot moving to the Auto destination mounts nothing", { platform: "win32", from: "cloud", to: undefined, autoApprove: true }, false],
    ["already granted: Auto on this Mac moving local → Auto is the same desktop", { platform: "darwin", from: "local", to: undefined, autoApprove: true }, false],
    ["already granted: Auto on this Mac moving Auto → local is the same desktop", { platform: "darwin", from: undefined, to: "local", autoApprove: true }, false],
    ["leaving this computer never warns", { platform: "darwin", from: "local", to: "cloud", autoApprove: true }, false],
    ["a bot in Ask never warns on a destination change", { platform: "darwin", from: "cloud", to: undefined, autoApprove: false }, false],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(computerSwitchNeedsLocalAutoWarning(input)).toBe(expected);
    });
  }
  it("is the same rule the Auto switch uses (server autoMountsLocalComputer), independent of provider support", () => {
    // The server rule hard-codes providerSupportsLocal (server/local-routing.ts),
    // so a Mac bot on a provider with no local-computer capability still needs
    // the acknowledgement; the renderer must not gate the warning on it.
    expect(autoMountsThisComputer({ platform: "darwin", computer: undefined })).toBe(true);
    expect(autoMountsThisComputer({ platform: "darwin", computer: "local" })).toBe(true);
    expect(autoMountsThisComputer({ platform: "linux", computer: "local" })).toBe(true);
    expect(autoMountsThisComputer({ platform: "linux", computer: undefined })).toBe(false);
    expect(autoMountsThisComputer({ platform: "darwin", computer: "browser" })).toBe(false);
    for (const platform of ["darwin", "linux", "win32", "other"] as const) {
      for (const computer of [undefined, "cloud", "vm", "local", "browser", "off"] as const) {
        expect(autoNeedsLocalComputerWarning({ platform, computer, autoApprove: false })).toBe(autoMountsThisComputer({ platform, computer }));
        expect(computerSwitchNeedsLocalAutoWarning({ platform, from: "off", to: computer, autoApprove: true })).toBe(autoMountsThisComputer({ platform, computer }));
      }
    }
  });
});

describe("localAutoHostPlatform", () => {
  const host = (platform: "darwin" | "linux" | "win32" | "other") => ({ host: { platform, label: "", homeDir: "" } } as never);
  it("uses the announced desktop platform", () => {
    expect(localAutoHostPlatform(host("darwin"), "Mozilla/5.0 (X11; Linux x86_64)")).toBe("darwin");
    expect(localAutoHostPlatform(host("linux"), "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("linux");
  });
  it("lets the UA stand in for a plain browser on a Mac, where the harness is on the same machine", () => {
    expect(localAutoHostPlatform(host("other"), "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("darwin");
    expect(localAutoHostPlatform(host("other"), "Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
  });
});
