// @vitest-environment jsdom
// W16 (TEACH-ENTRY 1.0.23 D9.2-D9.4): the Teach card, entered through the real Composer send in a
// mounted ChatView. Only external I/O, the call surfaces and the header are replaced; the gate inputs
// (desktop app, Cloud, host platform, switch) are set at their boundaries.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, press, settle } from "../testing/dom-harness";
import { initialState, type AppState, type Bot, type Group } from "../state/store";
import { TEACH_GATE_OFF, teachConfig, teachGateOn, type TeachGate } from "../testing/teach-gate-fixture";

const fixture = vi.hoisted(() => ({
  state: {} as AppState, dispatch: vi.fn(), gate: null as unknown as TeachGate,
  api: vi.fn(async () => ({ connections: [], outcomes: [], items: [] })),
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("../state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: vi.fn(async () => {}), refreshAfterKey: vi.fn() }),
  useStoreActions: () => ({ dispatch: fixture.dispatch }),
  useStoreSelector: (select: (state: AppState) => unknown) => select(fixture.state),
  useStoreSnapshot: () => () => fixture.state,
  api: fixture.api,
}));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<typeof import("@/lib/use-surface")>()), useDesktopSurface: () => fixture.gate.desktop }));
vi.mock("@/lib/cloud-workspace", async (original) => ({ ...(await original<typeof import("@/lib/cloud-workspace")>()), isCloudOrigin: () => fixture.gate.cloud }));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...(await original<typeof import("./DesktopCapabilities")>()),
  useDesktopCapabilities: () => ({ ready: true, capabilities: { dictation: { available: false }, host: { platform: fixture.gate.platform } } }),
}));
vi.mock("./CallControls", () => ({ CallBarStrip: () => null, GroupCallButton: () => null, CallOverlaySlot: () => null, CallOverlay: () => null, CallButton: () => null, CallStatus: () => null }));
vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./PendingApprovalQueue", () => ({ PendingApprovalQueue: () => null }));
vi.mock("./PushToTalk", () => ({ PushToTalk: () => null, browserPushToTalkFacts: () => ({}) }));
const { ChatView } = await import("./ChatView");
const { DRAFT_VERIFY_WINDOW_MS, settleDraftSend } = await import("../lib/drafts");
const { GroupView } = await import("./GroupView");
const { TellChiefBox } = await import("./today/TellChiefBox");

let restore: () => void;
let bot: Bot;
beforeAll(() => {
  restore = installDOMHarness();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
});
afterAll(() => { restore(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fixture.gate = teachGateOn();
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } })));
  bot = {
    id: "dax", name: "Dax", threadId: `t-${Math.random().toString(36).slice(2)}`, color: "blue", title: "Dax", description: "", notifications: false, unread: false,
    activity: "idle", busy: false, tasks: [], modelSelection: { instanceId: "engine", model: "m" }, messages: [],
  } as unknown as Bot;
  fixture.state = { ...initialState, bots: [bot], instances: [], config: teachConfig(fixture.gate) as AppState["config"] };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const box = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(box(), text); box().dispatchEvent(new Event("input", { bubbles: true })); });
}
async function send(text: string) {
  await type(text);
  press("Enter", box());
  // The draft journal is written and read back (lib/drafts.ts verify window) before the send is dispatched.
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, DRAFT_VERIFY_WINDOW_MS * 3)); });
}
const sends = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "send" || action.type === "sendGroup");
const recorderOpens = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "showSkillRecorder");
const card = () => document.querySelector<HTMLElement>('section[aria-label="Teach Dax a skill"]');
const startButton = () => [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Start");
function openChat(gate: Partial<TeachGate> = {}) {
  fixture.gate = { ...teachGateOn(), ...gate };
  fixture.state = { ...fixture.state, config: teachConfig(fixture.gate) as AppState["config"] };
  return mount(h(ChatView, { bot }));
}

describe("W16 Teach card in a direct chat", () => {
  it("a bare offer is sent with teachCard, draws the card with the task, and starts only on the Start click, once", async () => {
    openChat();
    await send("Let me show you how I file the weekly expense report");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ botId: "dax", text: "Let me show you how I file the weekly expense report", teachCard: true });
    expect(card()).not.toBeNull();
    expect(card()!.querySelector("input")!.value).toBe("File the weekly expense report");
    expect(recorderOpens()).toEqual([]);
    await act(async () => { startButton()!.click(); });
    expect(recorderOpens()).toEqual([{ type: "showSkillRecorder", via: "entry", forBotId: "dax", task: "File the weekly expense report", start: true }]);
    expect(startButton()).toBeUndefined();
    expect(card()!.textContent).toContain("Recorder opened");
  });

  it("Not now collapses the card and a second phrase in the same chat shows none", async () => {
    openChat();
    await send("I want to teach you something");
    const notNow = [...card()!.querySelectorAll("button")].find((b) => b.textContent === "Not now")!;
    await act(async () => { notNow.click(); });
    expect(document.body.textContent).toContain("Not now. Type /teach any time.");
    // The server acknowledges the first send (what the store does on its receipt), so the box takes the next one.
    await act(async () => { await settleDraftSend(undefined, sends()[0].sendId, undefined, "acked"); });
    for (let i = 0; i < 3; i += 1) await settle();
    await send("Let me teach you how to file invoices");
    expect(sends()).toHaveLength(2);
    expect(card()).toBeNull();
    expect(sends()[1]).not.toHaveProperty("teachCard");
  });

  it.each([
    "teach me how to file expenses",
    "Remember how I do the expense report? Do it again for October.",
    "Let me show you how I fixed the login bug: the token expired. Now do the same in billing.",
    "Let me show you how I want the report formatted: Title, Date, Total",
    "I'll show you how we close the month: 1. export 2. reconcile",
    "Can you remember how to get to my office?",
    "Remember how I do the expense report?",
    "let me show you the error",
    "Let me teach you something about Acme",
  ])("%j: sent unchanged, no card, no teachCard", async (text) => {
    openChat();
    await send(text);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].text).toBe(text);
    expect(sends()[0]).not.toHaveProperty("teachCard");
    expect(card()).toBeNull();
  });

  it.each(TEACH_GATE_OFF)("%s: no card, no teachCard, the message is still sent", async (_name, off) => {
    openChat(off);
    await send("Let me show you how I file the weekly expense report");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).not.toHaveProperty("teachCard");
    expect(card()).toBeNull();
  });

  it("/teach invoices on the recorder: nothing is sent and the card has the task", async () => {
    openChat();
    await send("/teach invoices");
    expect(sends()).toEqual([]);
    expect(card()!.querySelector("input")!.value).toBe("Invoices");
    expect(box().value).toBe("");
  });

  it("/teach invoices where the recorder is unavailable is sent as typed", async () => {
    openChat({ platform: "win32" });
    await send("/teach invoices");
    expect(sends().map((action) => action.text)).toEqual(["/teach invoices"]);
    expect(card()).toBeNull();
  });

  it("the slash menu lists /teach only where the recorder is available", async () => {
    openChat();
    await type("/te");
    expect(document.body.textContent).toContain("Show Dax a task on your screen");
    cleanup();
    // Another conversation, so the first one's kept draft does not open this box with "/te" already typed.
    bot = { ...bot, threadId: `${bot.threadId}-win` } as Bot;
    fixture.state = { ...fixture.state, bots: [bot] };
    openChat({ platform: "win32" });
    await type("/te");
    expect(document.body.textContent).not.toContain("Show Dax a task on your screen");
  });

  it("Describe it in words instead shows only when skill authoring is on", async () => {
    openChat();
    await send("I want to teach you something");
    expect(card()!.textContent).toContain("Describe it in words instead");
  });
});

describe("W16 surfaces without the Teach hook (rooms, Today)", () => {
  // The room's and Today's own callers (GroupView.tsx Composer, today/TellChiefBox.tsx Composer) are mounted, not a bare Composer.
  const surfaces: Array<[string, () => void]> = [
    ["room (GroupView)", () => {
      const group = { id: "room1", name: "Room", threadId: `room-${Math.random().toString(36).slice(2)}`, memberIds: [bot.id], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, setupCompletedAt: 1, messages: [], section: "", createdAt: 1 } as unknown as Group;
      fixture.state = { ...fixture.state, groups: [group] };
      mount(h(GroupView, { group }));
    }],
    ["Today (TellChiefBox)", () => { mount(h(TellChiefBox, { chief: bot, onOpenChat: vi.fn() })); }],
  ];
  it.each(surfaces.flatMap(([name, open]) => ["/teach invoices", "Let me show you how I file receipts"].map((text) => [name, text, open] as const)))(
    "%s sends %j as typed, no flag, no card", async (_name, text, open) => {
      fixture.gate = teachGateOn();
      fixture.state = { ...fixture.state, config: teachConfig(fixture.gate) as AppState["config"] };
      open();
      expect(box()).not.toBeNull();
      await send(text);
      expect(sends().map((action) => action.text)).toEqual([text]);
      expect(sends()[0]).not.toHaveProperty("teachCard");
      expect(card()).toBeNull();
    });
});
