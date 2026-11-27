// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import type { Bot } from "../state/store";
import type { RuntimeEvent } from "../../server/contracts";
import { InspectorPanel } from "./InspectorPanel";
const live = vi.hoisted(() => ({ onFrame: (_frame: unknown) => {}, close: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: live.dispatch }) }));
vi.mock("@/lib/live-events", () => ({
  desktopSurfaceHeaders: () => ({}), ensureDesktopSurfaceSecret: async () => {},
  openLiveEvents: (options: { onFrame: (frame: unknown) => void }) => { live.onFrame = options.onFrame; return live.close; },
}));
vi.mock("@/hooks/use-window-drag", () => ({ useWindowDrag: () => ({}) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); live.close.mockClear(); });
it("retains only 400 live rows through a slow initial load, eviction and thread switch", async () => {
  const restore = installDOMHarness();
  try {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const bot = { id: "inspector-bot", threadId: "inspector-thread", messages: [] } as unknown as Bot;
    const view = mount(h(InspectorPanel, { bot }));
    await settle();
    const frame = (i: number, threadId = bot.threadId) => live.onFrame({ kind: "runtime", event: {
      threadId, provider: "claudeAgent", eventId: `live${i}`, createdAt: "2026-08-17T10:00:00.000Z", type: "turn.started",
    } satisfies RuntimeEvent });
    act(() => { for (let i = 0; i < 5_000; i++) frame(i); });
    await act(async () => finish(new Response(JSON.stringify({ entries: [], total: { runtime: 0, native: 0 } }))));
    await settle();
    const rowButtons = () => Array.from(view.container.querySelectorAll("button")).filter(button => button.textContent?.includes("turn.started"));
    expect(rowButtons()).toHaveLength(400);
    expect(view.container.textContent).toContain("400 recent records; total not fully counted");
    act(() => rowButtons()[0]!.click());
    expect(view.container.querySelectorAll("pre")).toHaveLength(1);
    act(() => { for (let i = 5_000; i < 10_000; i++) frame(i); });
    await settle();
    expect(rowButtons()).toHaveLength(400);
    expect(view.container.querySelectorAll("pre")).toHaveLength(0);
    // Reintroducing an evicted record by reload must not resurrect its expansion.
    act(() => view.container.querySelector<HTMLButtonElement>('button[title="Reload from disk"]')!.click());
    await settle();
    await act(async () => finish(new Response(JSON.stringify({ entries: [{ kind: "runtime", at: "2026-08-17T10:00:00.000Z", data: { threadId: bot.threadId, provider: "claudeAgent", eventId: "live4600", createdAt: "2026-08-17T10:00:00.000Z", type: "turn.started" } }], total: { runtime: 1, native: 0 } }))));
    await settle();
    expect(rowButtons()).toHaveLength(1);
    expect(view.container.querySelectorAll("pre")).toHaveLength(0);
    view.rerender(h(InspectorPanel, { bot: { ...bot, threadId: "other-thread" } }));
    await settle();
    expect(live.close).toHaveBeenCalledTimes(1);
    act(() => frame(10_001)); // old thread cannot cross into the new page
    await act(async () => finish(new Response(JSON.stringify({ entries: [], total: { runtime: 0, native: 0 } }))));
    await settle();
    expect(rowButtons()).toHaveLength(0);
    view.unmount();
    expect(live.close).toHaveBeenCalledTimes(2);
  } finally { restore(); }
});


it("M1: a full retention window keeps following the tail as replacement records arrive", async () => {
  const restore = installDOMHarness();
  const heightOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  try {
    let height = 1_000;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => height });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [], total: { runtime: 0, native: 0 } }))));
    const bot = { id: "follow-bot", threadId: "follow-thread", messages: [] } as unknown as Bot;
    const view = mount(h(InspectorPanel, { bot }));
    await settle();
    const frame = (i: number) => live.onFrame({ kind: "runtime", event: { threadId: bot.threadId, provider: "claudeAgent", eventId: `tail${i}`, createdAt: "2026-08-17T10:00:00.000Z", type: "turn.started" } satisfies RuntimeEvent });
    act(() => { for (let i = 0; i < 400; i++) frame(i); });
    await settle();
    const list = view.container.querySelector<HTMLDivElement>(".overflow-y-auto")!;
    expect(list.scrollTop).toBe(1_000);
    // Retention is full: one record in, one out, so no count changes.
    height = 2_000;
    act(() => frame(400));
    await settle();
    expect(list.scrollTop).toBe(2_000);
  } finally {
    if (heightOf) Object.defineProperty(HTMLElement.prototype, "scrollHeight", heightOf); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    restore();
  }
});

it("R73-H1: the initial inspector fetch carries the desktop surface header and the retention limit", async () => {
  const restore = installDOMHarness();
  try {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ entries: [], total: { runtime: 0, native: 0 } })));
    vi.stubGlobal("fetch", fetchMock);
    const bot = { id: "surface-bot", threadId: "surface-thread", messages: [] } as unknown as Bot;
    mount(h(InspectorPanel, { bot }));
    await settle();
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/threads/surface-thread/events?limit=400");
    expect((init?.headers as Record<string, string> | undefined)?.["x-murage-surface"]).toBe("desktop");
  } finally {
    restore();
  }
});
