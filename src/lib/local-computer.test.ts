import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  switchRevokesThisComputer,
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

  it("requires macOS 13 for This computer and explains the disabled control", () => {
    const capabilities = {
      host: { platform: "darwin" },
      localComputer: { available: false, reasonCode: "macos-version-unsupported" },
    } as DesktopCapabilities;
    const context = { capabilities, providerSupportsLocal: true };
    expect(localComputerSelectable(context)).toBe(false);
    expect(localComputerDisabledReason(context)).toContain("macOS 13");
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
  const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X)";
  const linuxUa = "Mozilla/5.0 (X11; Linux x86_64)";
  it("uses the announced desktop platform when the harness has not answered", () => {
    expect(localAutoHostPlatform(host("darwin"), { userAgent: linuxUa })).toBe("darwin");
    expect(localAutoHostPlatform(host("linux"), { userAgent: macUa })).toBe("linux");
  });
  it("lets the UA stand in for a plain browser only while the harness has not answered", () => {
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa })).toBe("darwin");
    expect(localAutoHostPlatform(host("other"), { userAgent: linuxUa })).toBe("other");
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: undefined })).toBe("darwin");
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: null })).toBe("darwin");
  });
  // FOLLOW5: the server decides local-Auto consent from ITS process.platform
  // (autoMountsLocalComputer in server/local-routing.ts). A plain-browser
  // client's UA is the browser's machine, not necessarily the harness's — a
  // Linux or Windows tab through the browser door talks to a Mac harness and
  // used to get a bare 400 with no dialog, and a Mac tab against a Linux
  // harness showed a dialog the server never asked for. The harness announces
  // its platform on /api/config and that wins over both the UA and the
  // desktop shell's own answer whenever it is present.
  it("prefers the platform the harness announced over the browser UA", () => {
    expect(localAutoHostPlatform(host("other"), { userAgent: linuxUa, harness: { platform: "darwin" } })).toBe("darwin");
    expect(localAutoHostPlatform(host("other"), { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", harness: { platform: "darwin" } })).toBe("darwin");
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: { platform: "linux" } })).toBe("linux");
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: { platform: "win32" } })).toBe("win32");
  });
  it("prefers the announced harness platform over the desktop shell's answer too — the harness is what refuses the PATCH", () => {
    expect(localAutoHostPlatform(host("darwin"), { userAgent: macUa, harness: { platform: "linux" } })).toBe("linux");
    expect(localAutoHostPlatform(host("linux"), { userAgent: linuxUa, harness: { platform: "darwin" } })).toBe("darwin");
  });
  it("folds a harness platform the renderer has no name for into 'other', never into a UA guess", () => {
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: { platform: "freebsd" } })).toBe("other");
    expect(localAutoHostPlatform(host("other"), { userAgent: macUa, harness: { platform: "" } })).toBe("darwin");
  });
  it("decides the warning from the harness platform, not the UA (the FOLLOW3 verifier cases)", () => {
    // non-Mac UA + darwin harness → the warning is required
    const darwinHarness = localAutoHostPlatform(host("other"), { userAgent: linuxUa, harness: { platform: "darwin" } });
    expect(autoNeedsLocalComputerWarning({ platform: darwinHarness, computer: undefined, autoApprove: false })).toBe(true);
    // Mac UA + linux harness + computer undefined → no warning
    const linuxHarness = localAutoHostPlatform(host("other"), { userAgent: macUa, harness: { platform: "linux" } });
    expect(autoNeedsLocalComputerWarning({ platform: linuxHarness, computer: undefined, autoApprove: false })).toBe(false);
    expect(computerSwitchNeedsLocalAutoWarning({ platform: linuxHarness, from: "cloud", to: undefined, autoApprove: true })).toBe(false);
    expect(computerSwitchNeedsLocalAutoWarning({ platform: darwinHarness, from: "cloud", to: undefined, autoApprove: true })).toBe(true);
  });
});

describe("Local VM driver version label", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../components/LocalComputerSection.tsx", import.meta.url)),
    "utf8",
  );

  it("never hard-codes a Cua Driver version the harness did not report", () => {
    // The Local VM pin lives in server/container-computer.ts (CUA_DRIVER_VERSION).
    // That module is node-only, so the renderer cannot import it; the defence is
    // that no version literal is written here at all. A literal silently lies the
    // moment the pin moves — it read "0.20.0" while the macOS bundle went to
    // 0.28.2.
    expect(source).not.toMatch(/\bdriver_version\s*\?\?\s*"[\d.]+"/);
    expect(source).toContain('status?.driver_version ?? "unknown"');
  });
});

describe("taking this screen away from a bot", () => {
  it("counts leaving Auto for Off on a Mac as a revoke, because Auto IS this desktop", () => {
    expect(switchRevokesThisComputer({ platform: "darwin", from: undefined, to: "off" })).toBe(true);
  });

  it("counts leaving an explicit This computer as a revoke on both desktops that mount it", () => {
    expect(switchRevokesThisComputer({ platform: "darwin", from: "local", to: "off" })).toBe(true);
    expect(switchRevokesThisComputer({ platform: "linux", from: "local", to: "off" })).toBe(true);
  });

  it("does not call moving between two forms of this same desktop a revoke", () => {
    expect(switchRevokesThisComputer({ platform: "darwin", from: undefined, to: "local" })).toBe(false);
    expect(switchRevokesThisComputer({ platform: "darwin", from: "local", to: undefined })).toBe(false);
  });

  it("is not a revoke when the bot was never on this screen", () => {
    expect(switchRevokesThisComputer({ platform: "darwin", from: "cloud", to: "off" })).toBe(false);
    expect(switchRevokesThisComputer({ platform: "darwin", from: "browser", to: "off" })).toBe(false);
    // Linux Auto never mounts the user's desktop, so Auto → Off takes nothing.
    expect(switchRevokesThisComputer({ platform: "linux", from: undefined, to: "off" })).toBe(false);
  });
});

describe("Windows computer wording", () => {
  it("states what Windows bots use, with no limit language", async () => {
    const { localComputerDisabledReason, WINDOWS_COMPUTER_TEXT } = await import("./local-computer");
    expect(WINDOWS_COMPUTER_TEXT).toBe("On Windows, bots work on a cloud computer or a local VM. Pick one in Computer settings.");
    expect(WINDOWS_COMPUTER_TEXT).not.toMatch(/—|safe|yet|cannot/i);
    // DESIGN 1022-cua-windows D7: the blanket text is now only for a platform reason (no Windows driver for this
    // build); a Windows PC with the driver shows the card's own reason (W-K1 below).
    const caps = { host: { platform: "win32", label: "Windows" }, localComputer: { available: false, enabled: false, reasonCode: "unsupported-platform" } } as never;
    expect(localComputerDisabledReason({ capabilities: caps, providerSupportsLocal: true })).toBe(WINDOWS_COMPUTER_TEXT);
  });
});

// DESIGN 1022-cua-windows R9b / W-C3: the renderer never shows Auto as this computer on win32, and its
// autoMountsThisComputer is the server's shouldMountLocalComputer on every (computer, platform).
describe("W-C3 win32 renderer routing", () => {
  it("Auto is never shown as this computer on win32", async () => {
    const { autoSelectsLocalComputer } = await import("./local-computer");
    expect(autoSelectsLocalComputer({ platform: "win32", computer: undefined, capabilitiesReady: true, localSelectable: true })).toBe(false);
  });
  it("an explicit This computer mounts this computer on win32 (warning and sweep cover Windows)", async () => {
    const { autoMountsThisComputer } = await import("./local-computer");
    expect(autoMountsThisComputer({ platform: "win32", computer: "local" })).toBe(true);
  });
  it("renderer autoMountsThisComputer == server shouldMountLocalComputer for every computer x platform", async () => {
    const { autoMountsThisComputer } = await import("./local-computer");
    const { shouldMountLocalComputer } = await import("../../server/local-routing");
    for (const computer of [undefined, "local", "cloud", "off"] as const) {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(autoMountsThisComputer({ platform, computer }), `${computer}/${platform}`)
          .toBe(shouldMountLocalComputer({ requested: computer, hostPlatform: platform, providerSupportsLocal: true }));
      }
    }
  });
});

// DESIGN 1022-cua-windows R18 / W-K1: the Windows card names every reason in plain words.
describe("W-K1 win32 card reasons", () => {
  const win = (reasonCode: string) => ({ host: { platform: "win32", label: "Windows" }, localComputer: { available: false, enabled: true, reasonCode } }) as never;
  const expected: Record<string, RegExp> = {
    "windows-elevated": /running as administrator, so Local control is off/,
    "windows-integrity-unknown": /couldn't confirm it is running without administrator rights/,
    "windows-arm64-unsupported": /isn't available on Windows on Arm yet/,
    "driver-integrity": /failed its integrity check/,
    "start-failed": /didn't start/,
    "driver-exited": /driver stopped/,
    "driver-stuck": /didn't stop when asked/,
  };
  for (const [code, copy] of Object.entries(expected)) {
    it(`${code} maps to its sentence`, async () => {
      const { localComputerDisabledReason } = await import("./local-computer");
      expect(localComputerDisabledReason({ capabilities: win(code), providerSupportsLocal: true })).toMatch(copy);
    });
  }
  it("an unknown code maps to a non-empty generic sentence", async () => {
    const { localComputerDisabledReason, WINDOWS_LOCAL_CONTROL_GENERIC } = await import("./local-computer");
    expect(WINDOWS_LOCAL_CONTROL_GENERIC.trim()).not.toBe("");
    expect(localComputerDisabledReason({ capabilities: win("something-new"), providerSupportsLocal: true })).toBe(WINDOWS_LOCAL_CONTROL_GENERIC);
  });
});
