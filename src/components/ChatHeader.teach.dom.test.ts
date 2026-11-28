// @vitest-environment jsdom
// W1 (TEACH-ENTRY 1.0.23 D1): the chat header's Teach button, mounted on the real
// ChatHeader. It shows only where the recorder is available (desktop app, macOS,
// not Cloud, switch on: the real skillRecorderAvailable over the four inputs),
// opens the recorder for THIS bot, and is a labelled More row when relocated.
import { act, createElement, createRef } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";

const fixture = vi.hoisted(() => ({
  desktop: true as boolean | undefined,
  cloud: false,
  platform: "darwin",
  relocated: [] as string[],
  dispatch: vi.fn(),
  menu: null as null | { items: Array<{ id: string; label: string; description?: string; onSelect: () => void }> },
  state: {
    config: { features: { skillRecorder: true } } as { features: { skillRecorder: boolean } },
    instances: [], computerOpen: false, inspectorOpen: false,
  },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => fixture.desktop }));
vi.mock("@/lib/cloud-workspace", async (original) => ({ ...(await original<typeof import("@/lib/cloud-workspace")>()), isCloudOrigin: () => fixture.cloud }));
vi.mock("./DesktopCapabilities", async (original) => {
  const real = await original<typeof import("./DesktopCapabilities")>();
  return { ...real, useDesktopCapabilities: () => ({ ready: true, capabilities: { ...real.useDesktopCapabilities().capabilities, host: { platform: fixture.platform } } }) };
});
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null }));
vi.mock("@/lib/chat-header-layout", async (original) => ({
  ...(await original<typeof import("@/lib/chat-header-layout")>()),
  useChatHeaderLayout: () => ({ layout: { twoRow: false, chips: "full", relocated: fixture.relocated.length }, slots: new Set(fixture.relocated), contentWidth: 960 }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./CallControls", () => ({ CallButton: () => null }));
vi.mock("./Files", () => ({ openFiles: vi.fn() }));
vi.mock("./MemoryLauncher", () => ({ MemoryLauncher: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("./RenameTitle", () => ({ RenameTitle: () => createElement("span", null, "Dax") }));
vi.mock("./RoleBadge", () => ({ RoleBadge: () => null }));
vi.mock("./TaskPicker", () => ({ TaskPicker: () => null }));
vi.mock("./ChatHeaderMenu", () => ({ ChatHeaderMenu: (props: NonNullable<typeof fixture.menu>) => { fixture.menu = props; return null; } }));

const { ChatHeader } = await import("./ChatHeader");
const { BotListDrawerProvider } = await import("./OpenBotListButton");

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  Object.assign(fixture, { desktop: true, cloud: false, platform: "darwin", relocated: [], menu: null });
  fixture.state.config = { features: { skillRecorder: true } };
  fixture.dispatch.mockClear();
});
afterEach(() => cleanup());

function renderHeader() {
  const bot = { id: "dax", name: "Dax", threadId: "t1", busy: false, modelSelection: { instanceId: "engine", model: "m" }, messages: [], createdAt: 1 };
  const control = { expanded: false, open: () => {}, buttonRef: createRef<HTMLButtonElement>(), takeFocusReturn: () => false };
  return mount(createElement(BotListDrawerProvider, {
    value: control,
    children: createElement(ChatHeader, { bot, messages: [], mascotMotion: null, findOpen: false, onToggleFind: () => {} } as never),
  }));
}
const teachButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Teach Dax a skill"]');

describe("W1 header Teach button", () => {
  it("available: named, with its tooltip, and opens the recorder for this bot", () => {
    renderHeader();
    const button = teachButton();
    expect(button).not.toBeNull();
    expect(button!.title).toBe("Teach Dax a skill: show it a task once, and it can do it again");
    expect(button!.textContent).toContain("Teach");
    act(() => button!.click());
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showSkillRecorder", via: "entry", forBotId: "dax" });
  });

  it("relocated: a labelled More row with the same action", () => {
    fixture.relocated = ["roleLabel", "usage", "inspector", "teach"];
    renderHeader();
    expect(teachButton()).toBeNull();
    const row = fixture.menu?.items.find((item) => item.id === "teach");
    expect(row?.label).toBe("Teach Dax a skill");
    expect(row?.description).toBe("Show it a task once");
    act(() => row!.onSelect());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showSkillRecorder", via: "entry", forBotId: "dax" });
  });

  const gates: Array<[string, () => void]> = [
    ["Cloud", () => { fixture.cloud = true; }],
    ["Windows", () => { fixture.platform = "win32"; }],
    ["not the desktop app", () => { fixture.desktop = false; }],
    ["switch off", () => { fixture.state.config = { features: { skillRecorder: false } }; }],
  ];
  it.each(gates)("%s: no button and no More row", (_name, apply) => {
    apply();
    fixture.relocated = [];
    renderHeader();
    expect(teachButton()).toBeNull();
    cleanup();
    fixture.relocated = ["roleLabel", "usage", "inspector", "teach"];
    renderHeader();
    expect(fixture.menu?.items.some((item) => item.id === "teach") ?? false).toBe(false);
  });
});
