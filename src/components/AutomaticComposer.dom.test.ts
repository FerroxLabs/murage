// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// F33 (MAIN RULINGS, Sean reference 11-27): the REAL Composer mounted in jsdom. A fresh install's one Automatic notice is an inline
// card directly above the message box, not a modal: one short paragraph, a Learn more link and one Got it button. Learn more only
// opens the help; Got it stores the answer and closes only once it is stored. The level chip under the box reads Automatic or Ask
// first and one click switches it; going up shows the confirm card only for a first acknowledgement or a bot on this computer. Expected copy is literal (not imported from the notice).
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { initialState, type Bot } from "../state/store";
import { Composer } from "./Composer";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ automaticNotice: { pending: false } })),
  desktop: true as boolean | undefined,
}));
vi.mock("../state/store", async (original) => ({
  ...(await original<typeof import("../state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshAfterKey: vi.fn() }),
  api: fixture.api,
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshAfterKey: vi.fn() }),
  api: fixture.api,
}));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<typeof import("@/lib/use-surface")>()), useDesktopSurface: () => fixture.desktop }));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...(await original<typeof import("./DesktopCapabilities")>()),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { platform: "darwin" } } }),
}));
vi.mock("./PendingApprovalQueue", () => ({ PendingApprovalQueue: () => null }));
vi.mock("./PushToTalk", () => ({ PushToTalk: () => null, browserPushToTalkFacts: () => ({}) }));

const LEAD = "Automatic is now the default.";
const BODY = "Murage checks risky actions (deleting a lot at once, money a web page, email or file pushes it to spend, messaging new people, posting where others will see it) and asks first; otherwise your bot just gets on with it. Switch a bot to Ask first any time.";
const HELP_FIRST_LINE = "Automatic lets a bot read, write and run things in its own folders and on your computer without stopping to ask you.";
const ANSWERED = { type: "automaticNoticeAnswered" };
const FULL = { autoApprove: true, fullAccess: true, fullAccessAcknowledgedAt: 1 };
const ASK = { autoApprove: false, fullAccess: false };

let seq = 0;
let current: Bot;
let compact: { placeholder: string; sendLabel: string } | undefined;
const bot = (patch: Record<string, unknown>) => ({ id: `ab${seq}`, name: "Fixture", threadId: "th1", busy: false, messages: [], modelSelection: { instanceId: "inst1" }, ...patch }) as unknown as Bot;
const tree = () => h(Composer, { key: current.threadId, bot: current, compact });
let app: ReturnType<typeof mount>;
let restore: () => void;
const rerender = () => act(() => app.rerender(tree()));
const answeredMark = (action: { type: string }) => {
  if (action.type === "automaticNoticeAnswered") fixture.state = { ...fixture.state, config: { automaticNotice: { pending: false } } };
};
const notice = () => document.querySelector<HTMLElement>("[data-composer] [data-automatic-notice]");
const noticeButton = (label: string) => [...(notice()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
const learnMore = () => [...(notice()?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Learn more");
const posts = () => fixture.api.mock.calls.filter(([path]) => path === "/api/automatic-notice").length;
const levelUpdates = () => fixture.dispatch.mock.calls.map(([a]) => a as { type: string; patch?: Record<string, unknown> }).filter((a) => a.type === "updateTask");
const chip = () => document.querySelector<HTMLButtonElement>('[data-composer] [data-coach="level-chip"]');
const start = (level: Record<string, unknown>, config: unknown = { automaticNotice: { pending: true } }) => {
  current = bot(level);
  fixture.state = { ...initialState, instances: [], bots: [current], config };
  app = mount(tree());
};

beforeAll(() => {
  restore = installDOMHarness();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterAll(() => restore());
beforeEach(() => {
  seq += 1;
  compact = undefined;
  fixture.desktop = true;
  fixture.api.mockReset();
  fixture.api.mockImplementation(async () => ({ automaticNotice: { pending: false } }));
  fixture.dispatch.mockReset();
  fixture.dispatch.mockImplementation(answeredMark);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows the notice inline directly above the message box, one paragraph, a Learn more link and one Got it button", () => {
  start(FULL);
  const card = notice();
  expect(card, "the notice shows inside the composer, above the message box").not.toBeNull();
  const box = document.querySelector("[data-composer] textarea")!;
  expect(card!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING, "the notice comes before the message box").toBeTruthy();
  expect(card!.closest('[role="dialog"], [aria-modal="true"]'), "the notice is not a modal").toBeNull();
  expect(card!.querySelectorAll("p")[0]!.textContent).toBe(`${LEAD} ${BODY} Learn more`);
  expect([...card!.querySelectorAll("button")].map((b) => b.textContent), "one button: Got it").toEqual(["Got it"]);
  expect([...card!.querySelectorAll("a")].map((a) => a.textContent), "Learn more is a link").toEqual(["Learn more"]);
});

it("Learn more only opens the help; Got it stores the answer once and closes", async () => {
  start(FULL);
  expect(notice(), "the notice shows inside the composer").not.toBeNull();
  await act(async () => { learnMore()!.click(); });
  expect(posts(), "Learn more does not answer the notice").toBe(0);
  expect(notice()!.querySelector("[data-automatic-help]")?.textContent).toContain(HELP_FIRST_LINE);
  await act(async () => { noticeButton("Got it")!.click(); });
  expect(posts()).toBe(1);
  expect(fixture.api).toHaveBeenCalledWith("/api/automatic-notice", expect.objectContaining({ method: "POST", body: JSON.stringify({ acknowledged: true }) }));
  expect(fixture.dispatch).toHaveBeenCalledWith(ANSWERED);
  rerender();
  expect(notice(), "answered: the notice is gone").toBeNull();
});

it("a Got it whose save fails keeps the notice open and unanswered", async () => {
  start(FULL);
  expect(notice(), "the notice shows inside the composer").not.toBeNull();
  fixture.api.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { noticeButton("Got it")!.click(); });
  expect(posts()).toBe(1);
  expect(fixture.dispatch, "nothing stored, so the store is not told it was answered").not.toHaveBeenCalledWith(ANSWERED);
  rerender();
  expect(notice(), "a failed save keeps the notice open").not.toBeNull();
});

it("never shows once answered, on an upgraded install, before the config loads, away from the desktop, or in Today's small box", () => {
  for (const config of [{ automaticNotice: { pending: false } }, {}, null]) {
    start(FULL, config);
    expect(notice()).toBeNull();
    cleanup();
  }
  for (const desktop of [false, undefined]) {
    fixture.desktop = desktop;
    start(FULL);
    expect(notice()).toBeNull();
    cleanup();
  }
  fixture.desktop = true;
  compact = { placeholder: "Tell", sendLabel: "Send" };
  start(FULL);
  expect(notice()).toBeNull();
});

it("the chip under the box reads Automatic, and one click switches the conversation to Ask first", async () => {
  start(FULL, {});
  expect(chip()?.textContent, "the chip names the level Automatic").toBe("Automatic");
  await act(async () => { chip()!.click(); });
  expect(levelUpdates().map((a) => a.patch), "one click switches to Ask first").toEqual([{ autoApprove: false, fullAccess: false }]);
});

const confirmCard = async () => {
  // the confirm card is a lazy chunk: give it a moment to load
  for (let i = 0; i < 100 && !document.querySelector('[data-level-confirm="full"]'); i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return document.querySelector('[data-level-confirm="full"]');
};

it("the chip reads Ask first, and one click switches a bot that already acknowledged Full access back to Automatic", async () => {
  start({ ...ASK, fullAccessAcknowledgedAt: 1, computer: "cloud" }, {});
  expect(chip()?.textContent, "the chip names the level Ask first").toBe("Ask first");
  await act(async () => { chip()!.click(); });
  expect(levelUpdates().map((a) => a.patch), "one click switches to Automatic, no card").toEqual([{ fullAccess: true }]);
});

it("an acknowledged bot that drives this computer still gets the confirm card on the way up (guard)", async () => {
  start({ ...ASK, fullAccessAcknowledgedAt: 1, computer: "local" }, {});
  await act(async () => { chip()!.click(); });
  expect(await confirmCard(), "the this-computer warning is never skipped").not.toBeNull();
  expect(levelUpdates()).toEqual([]);
});

it("a bot that never acknowledged Full access gets the confirm card from the Ask first chip (guard)", async () => {
  start(ASK, {});
  expect(chip()?.textContent, "the chip names the level Ask first").toBe("Ask first");
  await act(async () => { chip()!.click(); });
  expect(await confirmCard(), "the first Full access acknowledgement is the confirm card").not.toBeNull();
  expect(levelUpdates(), "going up to Automatic is never saved without it").toEqual([]);
});
