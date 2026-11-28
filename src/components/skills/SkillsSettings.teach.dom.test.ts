// @vitest-environment jsdom
// W2 (TEACH-ENTRY 1.0.23 D2): Settings -> Skills has a secondary "Teach a skill" button directly
// before the one primary Import skill button, only where the recorder is available, opening the
// recorder with no bot (All my bots).
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../../testing/dom-harness";
import { TEACH_GATE_OFF, teachConfig, teachGateOn, type TeachGate } from "../../testing/teach-gate-fixture";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), gate: null as unknown as TeachGate, state: { bots: [], groups: [], instances: [], config: {} as unknown } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("../LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => fixture.gate.desktop }));
vi.mock("@/lib/cloud-workspace", async (original) => ({ ...(await original<typeof import("@/lib/cloud-workspace")>()), isCloudOrigin: () => fixture.gate.cloud }));
vi.mock("../DesktopCapabilities", async (original) => {
  const real = await original<typeof import("../DesktopCapabilities")>();
  return { ...real, useDesktopCapabilities: () => ({ ready: true, capabilities: { ...real.useDesktopCapabilities().capabilities, host: { platform: fixture.gate.platform } } }) };
});
const { SkillsSettings } = await import("./SkillsSettings");

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.gate = teachGateOn();
  fixture.api.mockImplementation(async () => ({ yours: [], library: [], categories: [], libraryReady: true, pagination: { offset: 0, limit: 60, total: 0 } }));
  fixture.dispatch.mockClear();
});
afterEach(() => cleanup());

const render = () => { fixture.state.config = teachConfig(fixture.gate); mount(h(SkillsSettings)); };
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("section[aria-labelledby=skills-library-title] button")];
const teach = () => buttons().find((b) => b.textContent?.trim() === "Teach a skill");

describe("W2 Settings -> Skills Teach a skill", () => {
  it("sits immediately before Import skill, is not the accent button, and opens the recorder with no bot", () => {
    render();
    const list = buttons();
    const at = list.findIndex((b) => b.textContent?.trim() === "Teach a skill");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(list[at + 1]?.textContent?.trim()).toBe("Import skill");
    expect(list[at]!.className).not.toContain("bg-accent");
    expect(list[at + 1]!.className).toContain("bg-accent");
    act(() => list[at]!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showSkillRecorder", via: "entry" });
  });
  it.each(TEACH_GATE_OFF)("%s: hidden, Import skill stays", (_name, off) => {
    fixture.gate = { ...teachGateOn(), ...off };
    render();
    expect(teach()).toBeUndefined();
    expect(buttons().some((b) => b.textContent?.trim() === "Import skill")).toBe(true);
  });
});
