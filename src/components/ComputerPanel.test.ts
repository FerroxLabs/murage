import { describe, expect, it, vi } from "vitest";

import { transitionComputerControlLease } from "../lib/computer-control";

// ComputerPanel's import graph reads `window` at module scope
// (DesktopCapabilities asks the desktop shell what it is running on), and
// this suite runs in node. A bare object is the honest answer: no shell.
(globalThis as unknown as { window?: unknown }).window ??= {};
const { planComputerDestinationChange } = await import("./ComputerPanel");

const snap = (held: boolean) => ({ held, helpReason: null });

describe("computer/browser control transition ordering", () => {
  it("gates Electron before taking the server lease", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(true); },
    });
    expect(calls).toEqual(["native:true", "server:take"]);
  });

  it("releases the server before clearing Electron", async () => {
    const calls: string[] = [];
    await transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl: async (held) => { calls.push(`native:${held}`); return true; },
      requestControl: async (action) => { calls.push(`server:${action}`); return snap(false); },
    });
    expect(calls).toEqual(["server:release", "native:false"]);
  });

  it("never clears the private gate when the server did not release", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await expect(transitionComputerControlLease({
      action: "release",
      syncNativeBrowser: true,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    })).rejects.toThrow(/could not release/i);
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });

  it("does not contact the server if the private take gate fails", async () => {
    const requestControl = vi.fn(async () => snap(true));
    await expect(transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: true,
      setNativeBrowserControl: async () => false,
      requestControl,
    })).rejects.toThrow(/pause.*browser/i);
    expect(requestControl).not.toHaveBeenCalled();
  });

  it("leaves BrowserPanel to perform its own native choreography", async () => {
    const setNativeBrowserControl = vi.fn(async () => true);
    await transitionComputerControlLease({
      action: "take",
      syncNativeBrowser: false,
      setNativeBrowserControl,
      requestControl: async () => snap(true),
    });
    expect(setNativeBrowserControl).not.toHaveBeenCalled();
  });
});

// AUTOOP2 verifier follow-up: the "Runs on" grid used to decide the local-Auto
// warning with `!isLinux && localSelectable`, so on a Mac whose provider lacks
// local-computer capability (localSelectable false) an Auto-on bot moved to
// the Auto destination fired PATCH {computer:null} with no acknowledgement
// and got a bare 400 from the server rule, which does not consult provider
// support. The grid now decides with the shared rule, which takes no
// provider-support input at all: every case below holds whether or not
// "This computer" is clickable.
describe("ComputerPanel destination change on an Auto-on bot", () => {
  const capabilities = (platform: "darwin" | "linux" | "win32" | "other") => ({ host: { platform, label: "", homeDir: "" } } as never);
  it("opens the warning on a Mac even when the provider cannot use this computer", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "off",
      next: "local",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "local" });
  });
  it("patches straight through where Auto mounts nothing, and never re-warns an already granted desktop", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("linux"),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "local",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "browser",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: "browser", browser: true } });
  });
  it("is a no-op for the current destination and never warns a bot in Ask", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: undefined,
      next: "auto",
      autoApprove: true,
    })).toBeNull();
    expect(planComputerDestinationChange({
      capabilities: capabilities("darwin"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "local",
      autoApprove: false,
    })).toEqual({ kind: "patch", patch: { computer: "local" } });
  });
  it("reads the Mac through the browser door the way the settings switch does", () => {
    // host.platform "other" (a plain browser) on a Mac UA is still this Mac
    // while the harness has not announced itself
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
  });
  // FOLLOW5: the harness's own platform (announced on /api/config) decides,
  // not the browser's UA — a Linux tab through the browser door on a Mac
  // harness must get the dialog, and a Mac tab on a Linux harness must not.
  it("decides on the platform the harness announced, not the browser UA", () => {
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      harness: { platform: "darwin" },
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "auto" });
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      harness: { platform: "linux" },
      current: "cloud",
      next: "auto",
      autoApprove: true,
    })).toEqual({ kind: "patch", patch: { computer: null } });
    // an explicit "local" on a Linux harness still mounts it there
    expect(planComputerDestinationChange({
      capabilities: capabilities("other"),
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      harness: { platform: "linux" },
      current: "cloud",
      next: "local",
      autoApprove: true,
    })).toEqual({ kind: "warn", choice: "local" });
  });
});
