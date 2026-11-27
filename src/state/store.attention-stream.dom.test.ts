// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// @vitest-environment jsdom
import { EventEmitter } from "node:events";
// @ts-expect-error Native ESM has no declaration file.
import { createAttentionMain } from "../../electron/attention-main.mjs";
// @ts-expect-error Native ESM has no declaration file.
import { createCloudTransport } from "../../electron/attention-transport.mjs";
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetAttentionOffer } from "../lib/attention-offer";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import { StoreProvider } from "./store";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
class Stream {
  static latest: Stream;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  constructor() { Stream.latest = this; }
  close() {}
  send(frame: object, lastEventId: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId }); }
}
const json = (body: unknown) => Response.json(body);
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const notice = vi.fn(function () {});
const hello = () => ({ ok: true, ledgerMax: 288, retired: [] });
function bridge(connected: () => Promise<ReturnType<typeof hello>> = async () => hello()) {
  const offer = vi.fn(async (_payload: { kind: string }) => ({ ok: true, decision: "counts", retired: [] }));
  vi.stubGlobal("muragebox", { attention: {
    hello: connected, onShow: () => () => {}, offer, visible: async () => ({ ok: true, retired: [] }),
  } });
  return offer;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("Notification", Object.assign(notice, { permission: "granted" }));
});
afterEach(() => { cleanup(); resetAttentionOffer(); notice.mockClear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const signal of ["settled", "config"]) {
  it(`R8/R11: a Cloud ${signal} control fences an open card before the replacement snapshot drains`, async () => {
    const submitted: string[] = [];
    const cards = [
      { botId: "bot-a", threadId: "thread-a", messageId: "message-a", requestId: "request-a", at: 2, notifyOk: true },
      ...(signal === "settled" ? [{ botId: "bot-b", threadId: "thread-b", messageId: "message-b", requestId: "request-b", at: 1, notifyOk: true }] : []),
    ];
    let focused = true, presenceReads = 0;
    let finishPresence: ((snap: { rev: number; locked: boolean }) => void) | undefined;
    const clear = { rev: 0, locked: false };
    const session = { home: "fixture-cloud", session: "", webContentsId: 1, alive: true, ledger: new Set() };
    const transport = createCloudTransport({
      homeId: session.home, windowId: () => 1,
      client: { sessionGeneration: () => 1, async fetch(_home: string, path: string, { beforeSend }: { beforeSend: () => void }) {
        beforeSend();
        const url = new URL(path, "http://fixture.invalid");
        expect(url.searchParams.get("recover")).toBe("1");
        if (!url.pathname.endsWith("/card")) return json({ mode: "recover", epoch: "run", items: cards });
        const card = cards.find(card => card.messageId === url.searchParams.get("messageId"));
        return card ? json({ ...card, epoch: "run", quietStartsInMs: null, words: { botName: "Fixture", title: card.messageId } }) : new Response(null, { status: 404 });
      } },
    });
    const main = createAttentionMain({
      isAppFocused: () => focused, prefsTrusted: () => true, prefs: () => ({ origin: "upgrade", surfaces: { notify: true } }),
      homes: () => [session.home], homeExpected: (home: string) => home === session.home,
      transportFor: (home: string) => home === session.home ? transport : null,
      presence: { rev: 0, refresh: async () => ++presenceReads === 2
        ? new Promise<typeof clear>(resolve => { finishPresence = resolve; }) : clear },
      readPreviews: async () => true,
      createNotice: (input: { body: string }) => Object.assign(new EventEmitter(), {
        show: () => { submitted.push(input.body); }, close() {},
      }),
    });
    const offer = vi.fn((payload: { kind: string }) => main.offer(session, payload));
    vi.stubGlobal("muragebox", { attention: {
      hello: async (payload: { session: string }) => { session.session = payload.session; return main.hello(session); },
      onShow: () => () => {}, offer, visible: async (payload: object) => main.visible(session, payload),
    } });
    let release: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).includes("/api/bots?view=sidebar")
      ? new Promise<Response>(resolve => { release = resolve; }) : json({}));
    try {
      mount(createElement(StoreProvider));
      await flush(50);
      const stream = Stream.latest;
      stream.onopen?.();
      stream.send({ kind: "hello", resumed: false, cursor: "s:1" }, "s:1");
      await flush(50);
      expect(release).toBeDefined();
      focused = false;
      main.focusChanged?.();
      await flush(1500);
      const controls = offer.mock.calls.map(([frame]) => frame);
      expect(controls.slice(0, 2)).toEqual(Array(2).fill(expect.objectContaining({ kind: "attention.resync", gen: expect.any(Number) })));
      expect(controls[0]).toEqual(controls[1]);
      if (signal === "settled") {
        cards.shift();
        stream.send({ kind: "attention.settled", threadId: "thread-a", requestId: "request-a" }, "s:2");
      } else {
        cards[0]!.notifyOk = false;
        stream.send({ kind: "config" }, "s:2");
      }
      await flush(0);
      const kind = `attention.${signal}`;
      expect(finishPresence).toBeDefined();
      finishPresence?.(clear);
      await flush(0);
      expect(submitted).toEqual(signal === "settled" ? ["message-b"] : []);
      expect(offer.mock.calls.filter(([frame]) => frame.kind === kind)).toHaveLength(1);
      release?.(json({ bots: [], groups: [] }));
      await flush(100);
      expect(offer.mock.calls.filter(([frame]) => frame.kind === kind)).toHaveLength(1);
      if (signal === "config") {
        cards[0]!.notifyOk = true;
        focused = true;
        main.focusChanged?.();
        focused = false;
        main.focusChanged?.();
        await flush(1500);
        expect(submitted).toEqual(["message-a"]);
      }
    } finally { main.stopRecovery?.(); }
  });
}

const notify = (kind: string) => ({
  kind: "notify", notification: { kind, botId: "bot-a", threadId: "thread-a", messageId: "message-a", requestId: "request-a", title: "Question", body: "Please review" },
});
it("R14: replayed questions and approvals stay out of a backlogged desktop bridge", async () => {
  let connect: ((value: ReturnType<typeof hello>) => void) | undefined;
  const offer = bridge(() => new Promise(resolve => { connect = resolve; }));
  vi.stubGlobal("fetch", async () => json({ bots: [], groups: [] }));
  mount(createElement(StoreProvider));
  await flush(1500);
  const stream = Stream.latest;
  stream.send({ kind: "hello", resumed: true, cursor: "s:6" }, "s:1");
  stream.send(notify("question"), "s:2");
  stream.send(notify("approval"), "s:3");
  stream.send({ kind: "config", notifications: { previewContent: false } }, "s:4");
  await flush(50);
  expect(connect).toBeDefined();
  connect?.(hello());
  await flush(50);
  expect(offer.mock.calls.map(([frame]) => frame.kind)).toEqual(["attention.config"]);
  expect(notice).toHaveBeenCalledTimes(0);
});

it("R14: a browser without a desktop bridge still presents a replayed question", async () => {
  vi.stubGlobal("fetch", async () => json({ bots: [], groups: [] }));
  mount(createElement(StoreProvider));
  await flush(1500);
  const stream = Stream.latest;
  stream.send({ kind: "hello", resumed: true, cursor: "s:6" }, "s:1");
  stream.send(notify("question"), "s:2");
  stream.send(notify("approval"), "s:3");
  await flush(50);
  expect(notice).toHaveBeenCalledTimes(1);
});
