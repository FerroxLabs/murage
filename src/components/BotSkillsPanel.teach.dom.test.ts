// @vitest-environment jsdom
// W3 (TEACH-ENTRY 1.0.23 D3): each bot's Skills section has "Teach {bot} a skill" in both the empty
// and the list state, only where the recorder is available, opening the recorder for that bot. The
// "teach in chat" sentence keeps the switch-only gate (it is about /learn, true on Windows too).
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { TEACH_GATE_OFF, teachConfig, teachGateOn, type TeachGate } from "../testing/teach-gate-fixture";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), gate: null as unknown as TeachGate, skills: [] as unknown[], state: { bots: [], groups: [], instances: [], config: {} as unknown } }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), useStoreIfAny: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("./LayerSlot", () => ({ useLayerContainer: () => {}, useLayerOwner: () => null }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => fixture.gate.desktop }));
vi.mock("@/lib/cloud-workspace", async (original) => ({ ...(await original<typeof import("@/lib/cloud-workspace")>()), isCloudOrigin: () => fixture.gate.cloud }));
vi.mock("./DesktopCapabilities", async (original) => {
  const real = await original<typeof import("./DesktopCapabilities")>();
  return { ...real, useDesktopCapabilities: () => ({ ready: true, capabilities: { ...real.useDesktopCapabilities().capabilities, host: { platform: fixture.gate.platform } } }) };
});
const { BotSkillsPanel } = await import("./BotSkillsPanel");

const skill = { name: "file-receipts", description: "Files receipts.", enabled: true, editable: true, source: "learn:x", sha256: "a", importedAt: "2026-11-01T00:00:00.000Z", warnings: [], skippedFiles: [] };
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.gate = teachGateOn();
  fixture.skills = [];
  fixture.api.mockImplementation(async (path: string) => (path === "/api/bots/dax/skills" ? { skills: fixture.skills, staged: [] } : path.startsWith("/api/skills/preview") ? { inEveryMessage: [], lookedUp: [], omitted: 0, reason: null } : {}));
  fixture.dispatch.mockClear();
});
afterEach(() => cleanup());

async function render() {
  fixture.state.config = teachConfig(fixture.gate);
  mount(h(BotSkillsPanel, { bot: { id: "dax", name: "Dax", threadId: "t", modelSelection: { instanceId: "e", model: "m" }, messages: [], createdAt: 1 } as never }));
  await settle(); await settle();
}
const teach = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Teach Dax a skill");

describe("W3 bot Skills section Teach button", () => {
  it.each([["empty", [] as unknown[]], ["list", [skill]]])("%s state: opens the recorder for this bot", async (_state, skills) => {
    fixture.skills = skills;
    await render();
    expect(document.body.textContent).toContain(skills.length ? "1 of 1 on" : "Dax has no skills yet");
    const button = teach();
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showSkillRecorder", via: "entry", forBotId: "dax" });
  });
  it.each(TEACH_GATE_OFF)("%s: no Teach button", async (_name, off) => {
    fixture.gate = { ...teachGateOn(), ...off };
    await render();
    expect(document.body.textContent).toContain("Dax has no skills yet");
    expect(teach()).toBeUndefined();
  });
  it("on Windows the /learn sentence stays while the Teach button is hidden", async () => {
    fixture.gate = { ...teachGateOn(), platform: "win32" };
    await render();
    expect(document.body.textContent).toContain("A skill you teach Dax in chat is switched on once you confirm it.");
    expect(teach()).toBeUndefined();
  });
});
