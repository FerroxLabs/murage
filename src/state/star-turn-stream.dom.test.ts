// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Row 50: the mounted store, fed live frames through the stream handler it hands to openLiveEvents, counts finished turns for the star card.
import { createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";

const fixture = vi.hoisted(() => ({ handlers: null as null | { onFrame: (frame: unknown, delivery?: { replayed: boolean }) => void }, computer: true as boolean | undefined }));
vi.mock("@/lib/live-events", async (original) => ({
  ...(await original<typeof import("@/lib/live-events")>()),
  ensureDesktopSurfaceSecret: async () => "fixture-secret",
  openLiveEvents: (handlers: never) => { fixture.handlers = handlers; return Object.assign(() => {}, { wake: () => {} }); },
}));
vi.mock("@/lib/surface", async (original) => ({
  ...(await original<typeof import("@/lib/surface")>()),
  knownComputer: () => fixture.computer,
  surface: async () => "desktop",
}));


let restore: () => void;
let star: typeof import("../lib/star-prompt");
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.handlers = null;
  fixture.computer = true;
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String((input as { url?: string })?.url ?? input);
    const body = url.includes("/api/bots") ? { bots: [], groups: [], computerControl: {} } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(async () => { cleanup(); await settle(); vi.unstubAllGlobals(); });

const turnDone = (ok: boolean) => ({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", ok } });

// The star state is one value per module instance, so each test loads a fresh store and star module that share it.
async function mounted() {
  vi.resetModules();
  const { StoreProvider } = await import("./store");
  star = await import("../lib/star-prompt");
  mount(h(StoreProvider, null, h("div")));
  await vi.waitFor(() => expect(fixture.handlers).not.toBeNull());
  // The store holds live frames until its first snapshot lands, then applies them.
  return fixture.handlers!;
}

describe("star prompt: the mounted store's live stream", () => {
  it("a finished turn on the computer counts a day; the last turn's result is kept", async () => {
    const live = await mounted();
    live.onFrame(turnDone(true), { replayed: false });
    await vi.waitFor(() => expect(star.getStarState().days).toHaveLength(1), { timeout: 5000 });
    expect(star.getStarState().lastTurnOk).toBe(true);
    live.onFrame(turnDone(false), { replayed: false });
    await vi.waitFor(() => expect(star.getStarState().lastTurnOk).toBe(false), { timeout: 5000 });
    expect(star.getStarState().days).toHaveLength(1);
  });

  // A base with no counting at all cannot fail a guard on its own, so the guard rows use the naive base (the store counts every turn: both guards off):
  // there the live control passes and each guard assertion below fails at its own line. See receipts.tsv in the lane dir.
  // The guard tests wait for their live turn without asserting (a store that never counts must fail at the guard assertion, not earlier).
  const counted = (days: number) => vi.waitFor(() => expect(star.getStarState().days).toHaveLength(days), { timeout: 5000 }).catch(() => undefined);

  it("a replayed turn after reconnect does not count", async () => {
    const live = await mounted();
    live.onFrame(turnDone(true), { replayed: false });
    await counted(1);
    // Once the store is applying frames, a failed turn replayed after a reconnect must not overwrite the last live result.
    live.onFrame(turnDone(false), { replayed: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(star.getStarState()).toMatchObject({ days: [expect.any(String)], lastTurnOk: true });
  });

  it("a phone or Cloud home (not the computer) counts nothing", async () => {
    const live = await mounted();
    live.onFrame(turnDone(true), { replayed: false });
    await counted(1);
    // The same window, now answering as a phone or Cloud home: its failed turn is not counted either.
    fixture.computer = false;
    live.onFrame(turnDone(false), { replayed: false });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(star.getStarState()).toMatchObject({ days: [expect.any(String)], lastTurnOk: true });
  });
});
