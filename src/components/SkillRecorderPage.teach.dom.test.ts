// @vitest-environment jsdom
// W18 + W5 (TEACH-ENTRY 1.0.23 D9.4, D5): the recorder page under the REAL store reducer. The bridge,
// the transcription status and getDisplayMedia are faked at the window boundary only. The card's
// one-shot start token is consumed before the page's own start() runs, at most once per click, and
// never by a remount; the page waits for readiness and fails closed to its own Start button.
import { StrictMode, act, createElement as h, useReducer } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { healthReturn } from "./shell/shell-nav";

const fixture = vi.hoisted(() => ({ current: null as null | { state: unknown; dispatch: (action: unknown) => void }, log: [] as string[] }));
vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("../state/store")>()), useStore: () => fixture.current }));
const { configStatusFromFrame, initialState, reducer } = await import("../state/store");
type AppState = import("../state/store").AppState;
type Action = import("../state/store").Action;
const { SkillRecorderPage, START_READY_WAIT_MS } = await import("./SkillRecorderPage");

// Narration goes to the engine (Flux), so the page's own Start works while the key status is still loading.
const config = { ...configStatusFromFrame({
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 5 }, localVm: { mode: "shared", maxInstances: 2 }, features: { skillRecorder: true },
}), tts: { routes: { transcribe: "fixture-engine" } } } as never;
const bots = [{ id: "dax", name: "Dax" }, { id: "ember", name: "Ember" }];
let store: { state: AppState; dispatch: (action: Action) => void };
let statusResolve: ((value: { configured: boolean }) => void) | null = null;
let displayMedia: ReturnType<typeof vi.fn>;
let permissions: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;

function Harness({ seed }: { seed: AppState }) {
  const [state, raw] = useReducer(reducer, seed);
  const dispatch = (action: Action) => { fixture.log.push(action.type); raw(action); };
  store = { state, dispatch };
  fixture.current = store as never;
  return state.activeView === "skill-recorder" ? h(SkillRecorderPage) : null;
}
const seedFrom = (...actions: Action[]): AppState => actions.reduce(reducer, { ...initialState, config, bots: bots as never, activeView: "today" });
const cardStart: Action = { type: "showSkillRecorder", via: "entry", forBotId: "dax", task: "File receipts", start: true };
const headerEntry: Action = { type: "showSkillRecorder", via: "entry", forBotId: "dax" };

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.log.length = 0;
  statusResolve = null;
  displayMedia = vi.fn(async () => { fixture.log.push("getDisplayMedia"); throw new DOMException("Permission denied", "NotAllowedError"); });
  permissions = vi.fn(async () => { fixture.log.push("permissions"); return { supported: true }; });
  save = vi.fn(async () => ({ id: "x", path: "/fixture/skills/x", events: 0 }));
  Object.defineProperty(window, "muragebox", { configurable: true, value: {
    skillRecorder: { permissions, start: vi.fn(), stop: vi.fn(async () => {}), save, onEvent: () => () => {}, onEnd: () => () => {} },
    beginScreenPreviewIntent: () => true,
    transcription: { status: () => new Promise((resolve) => { statusResolve = resolve; }) },
  } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia: displayMedia, getUserMedia: vi.fn() } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, "muragebox"); });

const ready = async () => { await act(async () => { statusResolve?.({ configured: true }); }); for (let i = 0; i < 4; i += 1) await settle(); };
const pickerCalls = () => fixture.log.filter((entry) => entry === "getDisplayMedia").length;
const text = () => document.body.textContent ?? "";

describe("W18 the card's start token on the recorder page", () => {
  it("token + ready: consumed before the first permissions() call, the picker reached exactly once", async () => {
    mount(h(Harness, { seed: seedFrom(cardStart) }));
    await ready();
    const consumed = fixture.log.indexOf("skillRecorderStartConsumed");
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(consumed).toBeLessThan(fixture.log.indexOf("permissions"));
    expect(pickerCalls()).toBe(1);
    expect(store.state.skillRecorderStart).toBeUndefined();
  });

  it("under StrictMode double effects: still exactly once", async () => {
    mount(h(StrictMode, null, h(Harness, { seed: seedFrom(cardStart) })));
    await ready();
    expect(pickerCalls()).toBe(1);
  });

  it("no token: never starts by itself", async () => {
    mount(h(Harness, { seed: seedFrom(headerEntry) }));
    await ready();
    expect(permissions).not.toHaveBeenCalled();
    expect(pickerCalls()).toBe(0);
  });

  it("status still loading: nothing until it resolves, then once", async () => {
    mount(h(Harness, { seed: seedFrom(cardStart) }));
    for (let i = 0; i < 3; i += 1) await settle();
    expect(permissions).not.toHaveBeenCalled();
    await ready();
    expect(pickerCalls()).toBe(1);
  });

  it("status never resolves in time: the token is spent, no start, and the page says to press Start", async () => {
    vi.useFakeTimers();
    mount(h(Harness, { seed: seedFrom(cardStart) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(START_READY_WAIT_MS + 10); });
    expect(store.state.skillRecorderStart).toBeUndefined();
    expect(permissions).not.toHaveBeenCalled();
    expect(text()).toContain("Press Start to begin recording.");
    vi.useRealTimers();
    await ready();
    expect(pickerCalls()).toBe(0);
  });

  it("the page's own Start before the status loads spends the token: one picker call in total", async () => {
    mount(h(Harness, { seed: seedFrom({ ...cardStart, task: undefined }) }));
    await settle();
    const start = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Start recording"))!;
    expect(start).toBeDefined();
    await act(async () => { start.click(); });
    for (let i = 0; i < 4; i += 1) await settle();
    expect(store.state.skillRecorderStart).toBeUndefined();
    await ready();
    expect(pickerCalls()).toBe(1);
    expect(fixture.log.filter((entry) => entry === "skillRecorderStartConsumed")).toHaveLength(1);
  });

  it("remount after consume, and a remount through the real healthReturn: no second start", async () => {
    const app = mount(h(Harness, { seed: seedFrom(cardStart) }));
    await ready();
    expect(pickerCalls()).toBe(1);
    const after = store.state;
    app.unmount();
    mount(h(Harness, { seed: after }));
    await ready();
    const viaHealth = [{ type: "showHealth" } as Action, healthReturn({ view: "skill-recorder" }, { bots: [], groups: [], needsYouTab: undefined }, true)].reduce(reducer, after);
    mount(h(Harness, { seed: viaHealth }));
    await ready();
    expect(pickerCalls(), "no second start after the remounts").toBe(1);
  });

  it("picker refused after the card's start: idle, the error and Press Start shown, no second call", async () => {
    mount(h(Harness, { seed: seedFrom(cardStart) }));
    await ready();
    expect(pickerCalls()).toBe(1);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).toContain("Press Start to begin recording.");
    expect(text()).toContain("Start recording");
  });

  it("permission unsupported: the existing error line and no picker call", async () => {
    permissions.mockImplementation(async () => ({ supported: false }));
    mount(h(Harness, { seed: seedFrom(cardStart) }));
    await ready();
    expect(text()).toContain("Skill recording is currently available in the macOS desktop app.");
    expect(pickerCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------- W5: Who can use it (D5)
/** A capture that works: a screen stream with a video track, a microphone and a MediaRecorder, all at the window boundary. */
function workingCapture() {
  const track = { stop: vi.fn(), kind: "video" };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] };
  displayMedia.mockImplementation(async () => { fixture.log.push("getDisplayMedia"); return stream; });
  (navigator.mediaDevices as unknown as { getUserMedia: unknown }).getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
  class FakeRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive"; mimeType = "audio/webm"; ondataavailable: unknown = null;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.dispatchEvent(new Event("stop")); }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} });
}
async function toReview(seed: AppState) {
  workingCapture();
  mount(h(Harness, { seed }));
  await ready();
  const start = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Start recording"));
  if (start) { await act(async () => { start.click(); }); for (let i = 0; i < 4; i += 1) await settle(); }
  const stop = [...document.querySelectorAll("button")].find((b) => /Stop|Finish/.test(b.textContent ?? ""));
  expect(stop, "a recording is running").toBeDefined();
  await act(async () => { stop!.click(); });
  for (let i = 0; i < 6; i += 1) await settle();
  expect(text()).toContain("Review what the bot learned");
}
const radio = (value: string) => document.querySelector<HTMLInputElement>(`input[name="skill-scope"][value="${value}"]`)!;
const botSelect = () => document.querySelector<HTMLSelectElement>('select[aria-label="Which bot can use it"]')!;
async function nameAndCreate(name = "File receipts") {
  const field = document.querySelector<HTMLInputElement>("#skill-name")!;
  if (!field.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, name); field.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  const create = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Create skill"))!;
  await act(async () => { create.click(); });
  for (let i = 0; i < 4; i += 1) await settle();
}

describe("W5 Who can use it on the review step", () => {
  afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLMediaElement.prototype, "play"); });

  it("opened from Dax: Only is chosen with Dax, the task names the skill, and the save sends bots [dax]", async () => {
    await toReview(seedFrom({ type: "showSkillRecorder", via: "entry", forBotId: "dax", task: "File receipts" }));
    expect(radio("only")?.checked).toBe(true);
    expect(botSelect()?.value).toBe("dax");
    expect(document.querySelector<HTMLInputElement>("#skill-name")!.value).toBe("File receipts");
    await nameAndCreate();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({ name: "File receipts", bots: ["dax"] });
    expect(text()).toContain("Only Dax can use File receipts. It loads when a request matches it.");
    expect(text()).toContain("Find it in Settings → Skills → Taught by you.");
  });

  it("opened from the You menu: All my bots, and the save has no bots", async () => {
    await toReview(seedFrom({ type: "showSkillRecorder", via: "entry" }));
    expect(radio("all").checked).toBe(true);
    await nameAndCreate();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).not.toHaveProperty("bots");
    expect(text()).toContain("All your bots can use File receipts. They load it when a request matches it.");
  });

  it("the chosen bot was deleted: the save is refused with the alert and never becomes All", async () => {
    await toReview(seedFrom({ type: "showSkillRecorder", via: "entry", forBotId: "dax" }));
    // Dax is deleted (the real stream action) while the review is open.
    await act(async () => { store.dispatch({ type: "botDeleted", source: "stream", botId: "dax", hidden: false }); });
    expect(store.state.bots.some((bot) => bot.id === "dax")).toBe(false);
    expect(radio("only").checked).toBe(true);
    expect(botSelect().value).toBe("");
    await nameAndCreate();
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Dax was deleted. Choose who can use this skill.");
  });
});
