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

const render = (platform: string, phase: string, bot: Record<string, unknown> = {}, backend = "") => {
  forced.platform = platform;
  forced.phase = phase;
  forced.storeConfig = { harness: { platform }, box: { configured: false } };
  const full = { ...(backend ? { cloudBackend: backend } : {}), id: "b1", name: "Kessler", color: "orange", messages: [], threadId: "t1", busy: false, modelSelection: { instanceId: "inst" }, ...bot };
  return renderToStaticMarkup(createElement(ComputerPanel, { bot: full as never })).replace(/&#x27;/g, "'");
};

describe("Windows Local control default ON: the copy stays true (MAIN-RULING 2026-11-27)", () => {
  beforeEach(() => { forced.phase = "checking"; forced.localOn = true; });

  it("Windows: the Runs on card says Auto never uses this computer and shows no Auto consent row", () => {
    const html = render("win32", "unconfigured");
    expect(html).toContain("Runs on");
    expect(html).toContain("Auto uses a cloud box when one is configured; otherwise computer use stays off.");
    expect(html).not.toMatch(/otherwise this computer/);
    expect(html).not.toContain("Using this computer on Auto");
  });

  it("Windows with a VPS backend: Auto is the VPS or off, never this computer", () => {
    const html = render("win32", "unconfigured", {}, "vps");
    expect(html).toContain("Auto reuses a ready VPS when one is configured; otherwise computer use stays off.");
    expect(html).not.toMatch(/otherwise this computer/);
  });

  it("macOS keeps its one-time ask wording and consent row (unchanged)", () => {
    const html = render("darwin", "unconfigured");
    expect(html).toContain("asks you once before it first uses this computer");
    expect(html).toContain("Using this computer on Auto");
  });

  it("a Windows bot on This computer with Local control Ready: the screen box does not say cloud or VM", () => {
    const html = render("win32", "windows-computer", { computer: "local" });
    expect(html).not.toMatch(/bots work on a cloud computer or a local VM/i);
    expect(html).toContain("Local control is ready. This bot can work on this computer.");
  });

  it("a Windows bot on This computer with Local control off says to switch it on, not cloud or VM", () => {
    forced.localOn = false;
    const html = render("win32", "windows-computer", { computer: "local" });
    expect(html).not.toMatch(/bots work on a cloud computer or a local VM/i);
    expect(html).toContain("Switch Local control on in Settings &gt; Computer first.");
  });

  it("the Local control card does not promise every action asks: it follows the bot's level (MAIN-RULING 2026-11-27T10:00:17Z)", () => {
    forced.platform = "win32";
    forced.localOn = false;
    const html = renderToStaticMarkup(createElement(LinuxLocalControl)).replace(/&#x27;/g, "'");
    expect(html).not.toContain("Every local action asks you first");
    expect(html).toContain("At Ask, every local action asks you first; Auto, Full access and No limits act without asking, except destructive or sensitive actions, which still ask.");
  });
});
