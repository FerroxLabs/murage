// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { initialState, type AppState, type Bot } from "../state/store";
import { redactSecretsInText } from "../../server/redact";
import { ChatView } from "./ChatView";

const fixture = vi.hoisted(() => ({ state: {} as AppState, dispatch: vi.fn() }));
vi.mock("@/state/store", async original => ({
  ...await original<typeof import("../state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  useStoreActions: () => ({ dispatch: fixture.dispatch }),
  useStoreSelector: (select: (state: AppState) => unknown) => select(fixture.state),
  useStoreSnapshot: () => () => fixture.state,
  api: vi.fn(async () => ({ connections: [], outcomes: [], items: [] })),
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {}, ready: true }) }));
vi.mock("./CallControls", () => ({ CallBarStrip: () => null, CallOverlaySlot: () => null, CallOverlay: () => null, CallButton: () => null, CallStatus: () => null }));
let restore: () => void;
beforeAll(() => {
  restore = installDOMHarness();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value() {} });
});
afterAll(() => { restore(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); });
beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([false, true])("opens masked source in the real chat at phone width %s", async narrow => {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: narrow, media, addEventListener() {}, removeEventListener() {} }));
  const hidden = ["neutral", "fixture", "private", "value"].join("_");
  const text = redactSecretsInText(`| Name | Count |\n| Apples | 2 |\n\napi_key=${hidden}`);
  expect(text).not.toContain(hidden);
  const bot: Bot = {
    id: "reading-bot", name: "Fixture", threadId: "reading-thread", color: "blue",
    title: "Fixture", description: "", notifications: false, unread: false, activity: "idle", busy: false, tasks: [],
    modelSelection: { instanceId: "fixture", model: "fixture" },
    messages: [{ id: "answer", at: 1, role: "bot", kind: "text", text }],
  };
  fixture.state = { ...initialState, bots: [bot] };
  const { container } = mount(h(ChatView, { bot }));
  await settle();
  expect(container.querySelector("table")).not.toBeNull();
  expect(container.textContent).not.toContain(hidden);
  const toggle = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Markdown text");
  expect(toggle).toBeDefined();
  act(() => toggle!.click());
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(container.textContent).not.toContain(hidden);
  act(() => toggle!.click());
  expect(container.querySelector("table")).not.toBeNull();
  expect(bot.messages[0]!.text).toBe(text);
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
it("toggles masked prose independently of table repair", async () => {
  const hidden = ["neutral", "fixture", "private", "value"].join("_");
  const text = redactSecretsInText(`**Safe**\r\napi_key=${hidden}\n`);
  const bot: Bot = {
    id: "reading-bot", name: "Fixture", threadId: "reading-thread", color: "blue",
    title: "Fixture", description: "", notifications: false, unread: false, activity: "idle", busy: false, tasks: [],
    modelSelection: { instanceId: "fixture", model: "fixture" },
    messages: [{ id: "answer", at: 1, role: "bot", kind: "text", text }],
  };
  fixture.state = { ...initialState, bots: [bot] };
  const { container } = mount(h(ChatView, { bot }));
  await settle();
  expect(container.querySelector("strong")?.textContent).toBe("Safe");
  const toggle = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Markdown text");
  expect(toggle).toBeDefined();
  act(() => toggle!.click());
  expect(container.querySelector("pre")?.textContent).toBe(text);
  expect(container.textContent).not.toContain(hidden);
  act(() => toggle!.click());
  expect(container.querySelector("strong")?.textContent).toBe("Safe");
  expect(bot.messages[0]!.text).toBe(text);
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
