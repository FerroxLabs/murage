import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoNeedsLocalComputerWarning,
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
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
