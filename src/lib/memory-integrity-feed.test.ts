// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { createIntegrityFeed } from "./memory-integrity-feed";
import { DONE_SHOWN_MS, stripView, type StripView } from "./memory-integrity-view";
import { sampleState, type UpgradeState } from "../../shared/upgrade-contract.mjs";
import type { MachineContext } from "../../shared/upgrade-machine.mjs";

/** A clock and a timer list the test drives by hand, and a health source it answers one request at a time. */
function rig() {
  let clock = 1000;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  const pending: Array<{ resolve: (body: unknown) => void; reject: (error: Error) => void }> = [];
  let requests = 0;
  const feed = createIntegrityFeed({
    read: () => { requests += 1; return new Promise((resolve, reject) => { pending.push({ resolve, reject }); }); },
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: clock + ms, fn }); return id; },
    clearTimer: (handle) => { const i = timers.findIndex(timer => timer.id === handle); if (i >= 0) timers.splice(i, 1); },
    now: () => clock,
    hidden: () => false,
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    feed,
    timers: () => timers.length,
    requests: () => requests,
    inflight: () => pending.length,
    /** Answers the oldest open request. */
    async answer(body: unknown) { pending.shift()!.resolve(body); await flush(); },
    async fail() { pending.shift()!.reject(new Error("offline")); await flush(); },
    /** Runs the next timer, moving the clock to it. */
    async tick(by?: number) { if (by) clock += by; const next = timers.sort((a, b) => a.at - b.at).shift(); if (next) { clock = Math.max(clock, next.at); next.fn(); } await flush(); },
    advance(ms: number) { clock += ms; },
  };
}
const L = (c: string) => c.repeat(64);
let seq = 0;
const state = (over: Partial<UpgradeState> = {}): UpgradeState => sampleState({ launch: L("a"), seq: ++seq, step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false }, ...over });
const working = (overall: number, launch = L("a")) => ({ launch, upgrade: state({ launch, stage: "background", phase: "references", overall }) });
const idle = (over: Partial<UpgradeState> = {}, launch = L("a")) => ({ launch, upgrade: state({ launch, stage: "idle", phase: "none", complete: true, overall: 1, ...over }) });
/** Views a listener sees: the words for the context it is told about. */
const watch = (r: ReturnType<typeof rig>) => { const views: Array<StripView | null> = []; r.feed.subscribe((ctx: MachineContext) => views.push(stripView(ctx))); return views; };

describe("the shared health reader", () => {
  it("UX-12: a second subscriber that mounts while a request is in flight does not start another poll or another timer", async () => {
    const r = rig();
    const seen = watch(r);
    await r.tick();
    expect(r.requests()).toBe(1);
    const second: Array<StripView | null> = [];
    r.feed.subscribe(ctx => second.push(stripView(ctx)));
    expect(r.requests()).toBe(1);
    expect(r.timers()).toBe(0);
    await r.answer(working(0.3));
    expect(r.requests()).toBe(1);
    expect(r.timers()).toBe(1);
    expect(seen.at(-1)?.percent).toBe(30);
    expect(r.feed.state().inflight).toBe(false);
  });

  it("UX-12: after every request the feed has exactly one timer, however many listeners come and go", async () => {
    const r = rig();
    const stops = [r.feed.subscribe(() => undefined), r.feed.subscribe(() => undefined), r.feed.subscribe(() => undefined)];
    expect(r.timers()).toBe(1);
    await r.tick();
    await r.answer(working(0.1));
    expect(r.timers()).toBe(1);
    await r.tick();
    await r.answer(working(0.2));
    expect(r.timers()).toBe(1);
    for (const stop of stops) stop();
    expect(r.timers()).toBe(0);
  });

  it("UX-12: polling stops once the server says the work finished and the notice has gone, and a new subscriber wakes it", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer(working(0.9));
    await r.tick(); await r.answer(idle());
    expect(views.at(-1)?.kind).toBe("done");
    r.advance(DONE_SHOWN_MS + 1);
    await r.tick(); await r.answer(idle());
    expect(views.at(-1)).toBeNull();
    expect(r.feed.state().stopped).toBe(true);
    expect(r.timers()).toBe(0);
    const requestsBefore = r.requests();
    await r.tick();
    expect(r.requests()).toBe(requestsBefore);
    r.feed.subscribe(() => undefined);
    expect(r.timers()).toBe(1);
    await r.tick(); expect(r.requests()).toBe(requestsBefore + 1);
    await r.answer(idle());
    expect(r.feed.state().stopped).toBe(true);
  });

  it("r2-3: after completion, a server lifecycle event, a live-events reconnect or a return to view gives one poll, one timer and the new launch", async () => {
    for (const kind of ["LIFECYCLE", "RECONNECT", "VISIBLE"] as const) {
      const r = rig();
      const views = watch(r);
      await r.tick(); await r.answer(working(0.81));
      await r.tick(); await r.answer(idle());
      r.advance(DONE_SHOWN_MS + 1);
      await r.tick(); await r.answer(idle());
      expect(r.timers(), `${kind}: stopped`).toBe(0);
      const before = r.requests();
      r.feed.wake(kind);
      expect(r.timers(), `${kind}: one timer`).toBe(1);
      await r.tick();
      expect(r.requests(), `${kind}: one poll`).toBe(before + 1);
      await r.answer(working(0.02, L("b")));
      expect(views.at(-1)?.percent, `${kind}: the new launch starts from its own figures`).toBe(2);
      expect(r.feed.state().stopped).toBe(false);
      expect(r.timers()).toBe(1);
    }
  });

  it("UX-04 and r2-2: a new launch starts from its own figures; an empty reading in the same launch does not reset; the old launch is retired", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer(working(0.81));
    expect(views.at(-1)?.percent).toBe(81);
    await r.tick(); await r.answer({ launch: L("a"), upgrade: state({ stage: "idle", phase: "none", complete: "unknown", overall: "unknown" }) });
    expect(views.at(-1)?.percent).toBe(81);
    await r.tick(); await r.answer(working(0.02));
    expect(views.at(-1)?.percent, "81 -> {} -> 2 shows 81").toBe(81);
    await r.tick(); await r.answer(working(0.02, L("b")));
    expect(views.at(-1)?.percent).toBe(2);
    await r.tick(); await r.answer(working(0.7, L("a")));
    expect(views.at(-1)?.percent, "an answer from the earlier launch that arrives late is ignored").toBe(2);
    expect(r.feed.state().launch).toBe(L("b"));
  });

  it("an older server (no contract) still works as activity only and never claims it finished", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer({ memoryIntegrity: { pending: true, progress: { phaseId: "references", fraction: 0.4 } } });
    expect(views.some(view => view?.kind === "done")).toBe(false);
    await r.tick(); await r.answer({ memoryIntegrity: { pending: false, integrityPending: false } });
    expect(views.some(view => view?.kind === "done")).toBe(false);
    expect(r.feed.state().stopped).toBe(false);
    expect(r.timers()).toBe(1);
  });

  it("r2-6 / UX-10: the feed keeps reading while the storage converts, and stops when the offer is ready", async () => {
    const r = rig();
    r.feed.subscribe(() => undefined);
    await r.tick(); await r.answer(idle({ storage: "converting" }));
    expect(r.timers()).toBe(1);
    await r.tick(); await r.answer(idle({ storage: "converting" }));
    expect(r.timers()).toBe(1);
    await r.tick(); await r.answer(idle({ storage: "reclaim-available" }));
    expect(r.timers()).toBe(0);
    expect(r.feed.context().storage).toBe("reclaim-available");
  });

  it("a failed reading keeps what was shown and tries again", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer(working(0.4));
    await r.tick(); await r.fail();
    expect(views.at(-1)?.percent).toBe(40);
    expect(r.timers()).toBe(1);
  });

  it("r2-4: a failed reading after a long gap withdraws the time left, and repeated failures keep it withdrawn", async () => {
    const r = rig();
    const views = watch(r);
    const eta = (overall: number, awake: number) => ({ launch: L("a"), upgrade: state({ stage: "background", phase: "references", overall, eta: { stable: true, ms: 360_000 }, step: { awakeElapsedMs: awake, unit: "none" } }) });
    await r.tick(); await r.answer(eta(0.4, 9000));
    await r.tick(); await r.answer(eta(0.4, 11_000));
    expect(views.at(-1)?.left).toBe("about 6 minutes left");
    r.advance(40_000);
    await r.tick(); await r.fail();
    expect(views.at(-1)?.left ?? null).toBeNull();
    await r.tick(); await r.fail();
    expect(views.at(-1)?.left ?? null).toBeNull();
  });

  it("an answer to a question asked before one already used is dropped", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick();
    r.feed.wake("RECONNECT"); // a second ask while the first is out is held until the first returns
    await r.answer(working(0.6));
    expect(views.at(-1)?.percent).toBe(60);
    expect(r.requests()).toBe(1);
  });

  it("r3-3: one failed wake read does not leave the poller stopped: it tries again, with growing waits, until a good reading settles the server", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer(working(0.8));
    await r.tick(); await r.answer(idle());
    r.advance(DONE_SHOWN_MS + 1);
    await r.tick(); await r.answer(idle());
    expect(r.feed.state().stopped).toBe(true);
    r.feed.wake("RECONNECT");
    await r.tick(); await r.fail();
    expect(r.feed.state().stopped, "not stopped after one failed look").toBe(false);
    expect(r.timers(), "a retry is waiting").toBe(1);
    await r.tick(); await r.answer({ launch: L("a"), memoryIntegrity: {}, upgrade: { not: "a reading" } });
    expect(r.timers(), "an unreadable look is tried again too").toBe(1);
    await r.tick(); await r.answer(working(0.05, L("b")));
    expect(views.at(-1)?.percent).toBe(5);
    expect(r.timers()).toBe(1);
    await r.tick(); await r.answer(idle({}, L("b")));
    r.advance(DONE_SHOWN_MS + 1);
    await r.tick(); await r.answer(idle({}, L("b")));
    expect(r.feed.state().stopped, "a good reading settles it").toBe(true);
    expect(r.timers()).toBe(0);
  });

  it("r3-4: an old health answer with pending work and no upgrade field shows an indeterminate strip", async () => {
    const r = rig();
    const views = watch(r);
    await r.tick(); await r.answer({ app: "murage", memoryIntegrity: { pending: true, phase: "references", done: 3, total: 10 } });
    const view = views.at(-1);
    expect(view?.kind).toBe("working");
    expect(view?.percent).toBeNull();
    expect(view?.left).toBeNull();
  });
});
