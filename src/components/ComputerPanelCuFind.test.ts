import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The real ComputerPanel, server-rendered. Its two inputs (the store and the
// desktop shell's capabilities) and the first Phase it starts in are the only
// things set from here; every string asserted comes out of the panel's own JSX.
(globalThis as unknown as { window?: unknown }).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const memory = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
(globalThis as unknown as { localStorage?: unknown }).localStorage ??= memory;
(globalThis as unknown as { sessionStorage?: unknown }).sessionStorage ??= memory;
const forced = vi.hoisted(() => ({ localOn: true, platform: "win32", phase: "checking", bot: {} as Record<string, unknown>, storeConfig: {} as Record<string, unknown> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((init: unknown) => actual.useState(init === "checking" ? forced.phase : init)) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...actual,
    useDesktopCapabilities: () => ({
      ready: true,
      capabilities: {
        host: { platform: forced.platform, label: "Desktop", homeDir: "" },
        localComputer: { available: forced.localOn, enabled: forced.localOn, reasonCode: undefined },
      },
    }),
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const state = () => ({
    ...actual.initialState,
    config: forced.storeConfig,
    instances: [{ instanceId: "inst", driverKind: "claude", snapshot: { state: "available" }, capabilities: { localComputerMcp: true, computerMcp: true } }],
  });
  return { ...actual, useStore: () => ({ state: state(), dispatch: () => undefined }) };
});

const { ComputerPanel } = await import("./ComputerPanel");
const { LinuxLocalControl } = await import("./LinuxLocalControl");

const render = (platform: string, phase: string, bot: Record<string, unknown> = {}) => {
  forced.platform = platform;
  forced.phase = phase;
  forced.storeConfig = { harness: { platform }, box: { configured: false } };
  const full = { id: "b1", name: "Kessler", color: "orange", messages: [], threadId: "t1", busy: false, modelSelection: { instanceId: "inst" }, ...bot };
  return renderToStaticMarkup(createElement(ComputerPanel, { bot: full as never })).replace(/&#x27;/g, "'");
};

describe("Computer panel: Auto never reaches the desktop it was not granted (Windows CU review)", () => {
  beforeEach(() => { forced.phase = "checking"; });

  it("Windows: the Runs on card does not say Auto may use this computer, nor show the Auto-on-this-computer consent row", () => {
    const html = render("win32", "unconfigured");
    expect(html).toContain("Runs on");
    expect(html).toContain("Auto uses a cloud box when one is configured; otherwise computer use stays off.");
    expect(html).not.toMatch(/otherwise this computer/);
    expect(html).not.toContain("Using this computer on Auto");
    expect(html).not.toContain("first time this bot would use your screen");
  });

  it("macOS keeps its one-time ask wording and consent row (unchanged)", () => {
    const html = render("darwin", "unconfigured");
    expect(html).toContain("asks you once before it first uses this computer");
    expect(html).toContain("Using this computer on Auto");
  });
});

describe("Computer panel: the screen heading names the real screen owner", () => {
  it("this computer's screen is the owner's, not the bot's (Windows This computer)", () => {
    const html = render("win32", "windows-computer", { computer: "local" });
    expect(html).toContain("<span>Your screen</span>");
    expect(html).not.toContain("Kessler's screen");
  });

  it("a Mac bot on this computer reads as the owner's screen too", () => {
    const html = render("darwin", "local", { computer: "local" });
    expect(html).toContain("<span>Your screen</span>");
    expect(html).not.toContain("Kessler's screen");
  });

  it("a bot's own cloud box or Local VM keeps the bot's name", () => {
    expect(render("win32", "vm", { computer: "vm" })).toContain("<span>Kessler's screen</span>");
    expect(render("win32", "ready", { computer: "cloud" })).toContain("<span>Kessler's screen</span>");
  });
});

describe("Computer panel: the Windows This computer box and the Local control card tell the truth (Windows CU review)", () => {
  it("a Windows bot on This computer with Local control Ready is not told bots only work on a cloud computer or Local VM", () => {
    const html = render("win32", "windows-computer", { computer: "local" });
    expect(html).not.toContain("bots work on a cloud computer or a local VM");
    expect(html).toContain("Local control is ready. This bot can work on this computer.");
  });

  it("the Local control card never claims every local action asks first", () => {
    forced.platform = "win32";
    forced.localOn = false;
    const html = renderToStaticMarkup(createElement(LinuxLocalControl)).replace(/&#x27;/g, "'");
    forced.localOn = true;
    expect(html).toContain("Enabling lets bots you explicitly assign to");
    // The shipped 1.0.23 copy (MAIN-RULING 2026-11-27T10:00:17Z): every local action asks only at Ask.
    expect(html).toContain("At Ask, every local action asks you first;");
    expect(html).not.toContain("Every local action asks you first");
  });
});
