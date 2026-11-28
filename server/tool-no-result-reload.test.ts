// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// E15-V3 (designs/E15-V3-RELOAD-NO-RESULT-1023.md, section 5): the open tool rows of a turn an engine reload ended read "No result" once
// THAT TURN'S OWN engine child has closed, rooms included, late old-fleet rows included, and never touch a turn that started later.
// Real parts: the EventBus (queue, detach tag, writer gate), ReloadEndedTurns, turnCloses (reload-retain.ts) and the Store rows. The
// adapters are fakes whose awaitTurnClose copies the real answers (a per-thread deferred; Claude's "never settles without a turn id").
// The production reloadProviders / reloadScopedProviders call order is pinned in reload-retain.test.ts (sliced source) and below.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { prepareThread } from "./branch-store.ts";
import { Store, type Message } from "./store.ts";
import { EventBus } from "./harness/bus.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ReloadEndedTurns } from "./reload-ended-turns.ts";
import { RetainedCloses, turnCloses } from "./reload-retain.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let store: Store;
let n = 0;
const deferred = () => { let resolve!: () => void; let reject!: (e: unknown) => void; const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

beforeAll(async () => {
  removeTempDirSync(DATA_DIR);
  store = new Store(selection);
}, 120_000);

async function newThread(): Promise<string> {
  const id = store.createBot({ name: `Bot${++n}` }).threadId;
  store.messagesFor(id);
  await prepareThread(id);
  return id;
}

const ev = (over: Record<string, unknown>) => ({ eventId: `e-${++n}`, provider: "fake", createdAt: new Date().toISOString(), ...over }) as unknown as RuntimeEvent;
type Rig = Awaited<ReturnType<typeof rig>>;
/** Instances X / Y whose awaitTurnClose answers per (thread, turn) from `open`. */
async function fleet() {
  const fake = makeFakeDriver();
  const make = async (instanceId: string) => {
    await fake.driver.create({ instanceId, displayName: undefined, environment: {}, enabled: true, config: {} });
    return fake.created.get(instanceId)!;
  };
  const x = await make("x"), y = await make("y");
  const open = new Map<string, ReturnType<typeof deferred>>();
  const asked: string[] = [];
  // the real adapters answer per (thread, turn); Claude's answer with no turn id never settles
  const patch = (instance: ProviderInstance, claude: boolean) => {
    (instance.adapter as { awaitTurnClose?: unknown }).awaitTurnClose = (threadId: string, turnId?: string) => {
      asked.push(`${instance.instanceId}:${threadId}:${turnId ?? ""}`);
      if (claude && !turnId) return new Promise<void>(() => undefined);
      return open.get(`${instance.instanceId}:${threadId}:${turnId ?? ""}`)?.promise ?? Promise.resolve();
    };
  };
  patch(x.instance, true); patch(y.instance, false);
  return { x, y, open, asked };
}

/** A bus, instances X / Y, the real record, and a fold stand-in that writes a row for each tool start (the real fold does the same). */
async function rig(options: { markThrows?: (threadId: string, turnId: string, call: number) => unknown; generation?: { value: number } } = {}) {
  const { x, y, open, asked } = await fleet();
  const bus = new EventBus();
  bus.omitLog(() => true); const seen: RuntimeEvent[] = []; bus.subscribe(e => { seen.push(e); }, { durable: false });
  let heldGate = false; let wake = deferred();
  bus.gateDeliveries({ held: () => heldGate, wait: () => wake.promise, isBusy: e => e === "busy" });
  const marks: string[] = [];
  const generation = options.generation ?? { value: 1 };
  let markCalls = 0;
  const ended = new ReloadEndedTurns({
    generation: () => generation.value,
    mark: (threadId, turnId) => { const call = ++markCalls; const boom = options.markThrows?.(threadId, turnId, call); if (boom) throw boom; marks.push(`${threadId}:${turnId}`); return store.markTurnToolsUnrecorded(threadId, turnId); },
    isBusy: e => e === "busy", waitGate: () => Promise.resolve(), queued: seq => bus.detachedQueued(seq), log: () => undefined,
  });
  bus.onDetachDrained(seq => ended.drained(seq));
  // the fold stand-in: one row per tool start, written under the event's turn id
  bus.subscribe(event => {
    const e = event as unknown as { type: string; itemType?: string; threadId: string; turnId?: string; itemId?: string; skip?: boolean };
    if (e.type === "item.started" && e.itemType === "tool" && e.turnId) store.appendMessage(e.threadId, { role: "bot", kind: "activity", turnId: e.turnId, tool: { name: e.itemId ?? "tool" } });
  });
  bus.subscribe(event => {
    const route = event as unknown as { type: string; threadId: string; turnId?: string; providerInstanceId?: string; itemType?: string; toolKind?: string };
    ended.observe({ type: route.type, threadId: route.threadId, turnId: route.turnId, instanceId: bus.instanceOf(event) ?? route.providerInstanceId,
      itemType: route.itemType, toolKind: route.toolKind, detachedSeq: bus.detachedSeq(event) });
  });
  bus.attach([x.instance, y.instance]);
  const reload = async (unconfirmed: ProviderInstance[], scope?: ReadonlySet<string>) => {
    if (scope) bus.detach(scope); else bus.detachAll();
    const capture = ended.capture(bus.detachCount(), scope);
    await ended.settle(capture, unconfirmed);
    // the new fleet (same instance ids, fresh adapters): attach again
    bus.attach([x.instance, y.instance].filter(i => !scope || scope.has(i.instanceId)));
    return capture;
  };
  return {
    bus, ended, x, y, open, asked, marks, generation, reload, seen,
    hold: () => { heldGate = true; wake = deferred(); },
    release: () => { heldGate = false; wake.resolve(); },
    close: (key: string) => { const d = open.get(key) ?? deferred(); open.set(key, d); return d; },
    started: (r: { emit: (e: RuntimeEvent) => void }, threadId: string, turnId: string) => r.emit(ev({ type: "turn.started", threadId, turnId })),
    tool: (r: { emit: (e: RuntimeEvent) => void }, threadId: string, turnId: string, itemId: string, over: Record<string, unknown> = {}) => r.emit(ev({ type: "item.started", itemType: "tool", threadId, turnId, itemId, title: itemId, ...over })),
  };
}
const rows = (threadId: string, turnId: string): Message[] => store.turnRows(threadId, turnId).filter(m => m.tool);
const state = (m: Message) => m.tool?.unrecorded ? "unrecorded" : m.tool?.ok === undefined ? "open" : "settled";
const states = (threadId: string, turnId: string) => rows(threadId, turnId).map(state);
const pending = (r: Pick<Rig, "open">, key: string) => r.open.set(key, deferred()).get(key)!;

describe("E15-V3: a reload-ended turn's open rows read No result when its own child closed", () => {
  it("W1: a kept child's turn is marked when its close is confirmed, not before, once, and only its open rows", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    store.appendMessage(t, { role: "bot", kind: "activity", turnId: "T", tool: { name: "Done", ok: true } });
    store.appendMessage(t, { role: "bot", kind: "activity", turnId: "T", tool: { name: "Fail", ok: false } });
    store.appendMessage(t, { role: "bot", kind: "activity", turnId: "T", tool: { name: "Note", notice: true } });
    await r.reload([r.x.instance]);
    expect(states(t, "T")).toEqual(["open", "settled", "settled", "open"]);
    hung.resolve(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded", "settled", "settled", "open"]);
    expect(rows(t, "T")[3]!.tool?.notice).toBe(true);
    expect(r.marks.filter(m => m === `${t}:T`)).toHaveLength(1);
  });

  it("W3b: a room's member whose own engine closed is marked at once while another member's engine child on the thread is still open", async () => {
    const r = await rig(); const t = await newThread();
    pending(r, `x:${t}:TA`);
    r.started(r.x, t, "TA"); r.tool(r.x, t, "TA", "A1");
    r.started(r.y, t, "TB"); r.tool(r.y, t, "TB", "B1");
    await r.reload([r.x.instance, r.y.instance]);
    expect(states(t, "TB")).toEqual(["unrecorded"]);
    expect(states(t, "TA")).toEqual(["open"]);
  });

  it("W3c: the close is asked per turn: Claude's no-turn-id answer never settles, so a closed turn on another thread is still marked at once", async () => {
    const r = await rig(); const stuck = await newThread(); const fine = await newThread();
    r.started(r.x, stuck, "S"); r.tool(r.x, stuck, "S", "A");
    r.started(r.x, fine, "F"); r.tool(r.x, fine, "F", "B");
    pending(r, `x:${stuck}:S`); // the stuck child; the other turn's proof is already closed
    await r.reload([r.x.instance]);
    expect(states(fine, "F")).toEqual(["unrecorded"]);
    expect(states(stuck, "S")).toEqual(["open"]);
    expect(r.asked.every(call => !call.endsWith(":"))).toBe(true);
  });

  it("W4: a turn the new fleet starts afterwards on the same thread is never touched by the old close", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([r.x.instance]);
    r.started(r.x, t, "T3"); r.tool(r.x, t, "T3", "C");
    hung.resolve(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded"]);
    expect(states(t, "T3")).toEqual(["open"]);
  });

  it("W5: a child that closed during the dispose is marked right after the reload returns", async () => {
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([]);
    expect(states(t, "T")).toEqual(["unrecorded"]);
  });

  it("W7: a new turn on another engine is decided by its own engine; an earlier reload's hung child marks only its own turn, once", async () => {
    const r = await rig(); const t = await newThread();
    const hungX = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([r.x.instance]);
    r.started(r.y, t, "T2"); r.tool(r.y, t, "T2", "B");
    await r.reload([]);
    expect(states(t, "T2")).toEqual(["unrecorded"]);
    expect(states(t, "T")).toEqual(["open"]);
    hungX.resolve(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded"]);
    expect(r.marks.filter(m => m === `${t}:T`)).toHaveLength(1);
  });

  it("W8a: a close that rejects still marks (display only)", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([r.x.instance]);
    expect(states(t, "T")).toEqual(["open"]);
    hung.reject(new Error("closed badly")); await tick();
    expect(states(t, "T")).toEqual(["unrecorded"]);
  });

  it("W8c: one turn's failing mark never stops the next turn's", async () => {
    const first = { turn: "" };
    const r = await rig({ markThrows: (_thread, turn) => { first.turn ||= turn; return turn === first.turn ? new Error("boom") : undefined; } });
    const a = await newThread(); const b = await newThread();
    r.started(r.x, a, "TA"); r.tool(r.x, a, "TA", "A");
    r.started(r.x, b, "TB"); r.tool(r.x, b, "TB", "B");
    await r.reload([]).catch(() => undefined);
    const done = [states(a, "TA")[0], states(b, "TB")[0]];
    expect(done.sort()).toEqual(["open", "unrecorded"]);
  });

  it("W8d: a busy database at settle keeps the turn pending and marks it when the writer comes back", async () => {
    let busy = 1;
    const r = await rig({ markThrows: () => (busy-- > 0 ? "busy" : undefined) });
    const t = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([]);
    expect(states(t, "T")).toEqual(["open"]);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(states(t, "T")).toEqual(["unrecorded"]);
  });

  it("W9: settled, failed and notice rows, another thread and a live turn are byte-equal", async () => {
    const r = await rig(); const t = await newThread(); const other = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    r.started(r.y, other, "O"); r.tool(r.y, other, "O", "OA");
    const before = JSON.stringify(rows(other, "O"));
    await r.reload([], new Set(["x"]));
    expect(states(t, "T")).toEqual(["unrecorded"]);
    expect(JSON.stringify(rows(other, "O"))).toBe(before);
    expect(r.ended.isLive(other, "O")).toBe(true);
  });

  it("W10: a wipe or restore between the capture and the close marks nothing in the new database", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([r.x.instance]);
    r.generation.value += 1;
    hung.resolve(); await tick();
    expect(r.marks).toEqual([]);
    expect(states(t, "T")).toEqual(["open"]);
  });

  it("M3: a scoped capture takes every live turn on a scoped instance, whichever thread, and leaves the other engine's turns alone", async () => {
    const r = await rig(); const t = await newThread(); const u = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    r.started(r.y, u, "U"); r.tool(r.y, u, "U", "B");
    r.bus.detach(new Set(["x"]));
    const capture = r.ended.capture(r.bus.detachCount(), new Set(["x"]));
    expect(capture.turns).toEqual([{ threadId: t, turnId: "T", instanceId: "x" }]);
    expect(r.ended.isLive(u, "U")).toBe(true);
  });

  it("M2: a throw while asking the adapters still settles every captured turn as closed", async () => {
    const fake = await rig(); const t = await newThread();
    fake.started(fake.x, t, "T"); fake.tool(fake.x, t, "T", "A");
    const throwing = new ReloadEndedTurns({ generation: () => 1, mark: (a, b) => store.markTurnToolsUnrecorded(a, b), isBusy: () => false, waitGate: async () => undefined, queued: () => 0,
      closes: () => { throw new Error("adapter threw"); } });
    throwing.observe({ type: "turn.started", threadId: t, turnId: "T", instanceId: "x" });
    const capture = throwing.capture(1);
    await throwing.settle(capture, [fake.x.instance]).catch(() => undefined);
    expect(states(t, "T")).toEqual(["unrecorded"]);
  });
});

describe("E15-V3: events the old fleet had queued when it was detached (r2 H1)", () => {
  it("W12: a tool start queued behind a held gate at the reload is marked with the first one after the close", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A1");
    r.hold(); r.tool(r.x, t, "T", "A2");
    await r.reload([r.x.instance]);
    r.release(); await tick();
    expect(states(t, "T")).toEqual(["open", "open"]);
    hung.resolve(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded", "unrecorded"]);
  });

  it("W12b: when the child closed during the reload, the late queued row is marked at write", async () => {
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A1");
    r.hold(); r.tool(r.x, t, "T", "A2");
    await r.reload([]);
    expect(states(t, "T")).toEqual(["unrecorded"]);
    r.release(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded", "unrecorded"]);
  });

  it("W12c: a turn whose own turn.started and tool start were still queued at the reload is marked, and a HELD group beside it is too", async () => {
    const r = await rig(); const t = await newThread();
    const hungY = pending(r, `y:${t}:TB`);
    r.started(r.y, t, "TB"); r.tool(r.y, t, "TB", "B1");
    r.hold();
    r.started(r.x, t, "TA"); r.tool(r.x, t, "TA", "A1");
    await r.reload([r.y.instance]);
    r.release(); await tick();
    expect(states(t, "TA")).toEqual(["unrecorded"]);
    expect(states(t, "TB")).toEqual(["open"]);
    hungY.resolve(); await tick();
    expect(states(t, "TB")).toEqual(["unrecorded"]);
  });

  it("W13: a turn whose start and first tool were both queued at the reload waits on its OWN child when its engine is unconfirmed", async () => {
    const r = await rig(); const t = await newThread();
    const hungQ = pending(r, `x:${t}:TQ`);
    r.hold();
    r.started(r.x, t, "TQ"); r.tool(r.x, t, "TQ", "Q1");
    await r.reload([r.x.instance]);
    r.release(); await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    hungQ.resolve(); await tick();
    expect(states(t, "TQ")).toEqual(["unrecorded"]);
  });

  it("W13b: a late turn joining a held group is not marked by the close of the turn it joined beside, only by its own", async () => {
    const r = await rig(); const t = await newThread();
    const hungA = pending(r, `x:${t}:TA`);
    const hungB = pending(r, `x:${t}:TB`);
    r.started(r.x, t, "TA"); r.tool(r.x, t, "TA", "A1");
    r.hold();
    r.started(r.x, t, "TB"); r.tool(r.x, t, "TB", "B1");
    await r.reload([r.x.instance]);
    r.release(); await tick();
    expect(states(t, "TA")).toEqual(["open"]);
    expect(states(t, "TB")).toEqual(["open"]);
    hungA.resolve(); await tick();
    expect(states(t, "TA")).toEqual(["unrecorded"]);
    expect(states(t, "TB")).toEqual(["open"]);
    hungB.resolve(); await tick();
    expect(states(t, "TB")).toEqual(["unrecorded"]);
  });

  it("W13c: a new turn's late row reaching an already MARKED group waits on that turn's own child", async () => {
    const r = await rig(); const t = await newThread();
    const hungC = pending(r, `x:${t}:TC`);
    r.started(r.x, t, "TA"); r.tool(r.x, t, "TA", "A1");
    r.hold();
    r.started(r.x, t, "TC"); r.tool(r.x, t, "TC", "C1");
    await r.reload([r.x.instance]);
    expect(states(t, "TA")).toEqual(["unrecorded"]);
    r.release(); await tick();
    expect(states(t, "TC")).toEqual(["open"]);
    hungC.resolve(); await tick();
    expect(states(t, "TC")).toEqual(["unrecorded"]);
  });

  it("W14: a second capture of the same detach count (a scoped reload of an unattached instance) keeps the first detach's unconfirmed set", async () => {
    const r = await rig(); const t = await newThread();
    const hungQ = pending(r, `x:${t}:TQ`);
    r.hold();
    r.started(r.x, t, "TQ"); r.tool(r.x, t, "TQ", "Q1");
    const capture = await r.reload([r.x.instance]);
    await r.ended.settle(r.ended.capture(capture.seq, new Set(["unattached"])), []);
    r.release(); await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    hungQ.resolve(); await tick();
    expect(states(t, "TQ")).toEqual(["unrecorded"]);
  });

  it("W15i: a capture joining a detach that already settled holds that detach's late turns until its own unconfirmed set is in", async () => {
    const r = await rig(); const t = await newThread();
    const hungQ = pending(r, `x:${t}:TQ`);
    r.hold();
    r.started(r.x, t, "TQ"); r.tool(r.x, t, "TQ", "Q1");
    const first = await r.reload([]);
    const second = r.ended.capture(first.seq, new Set(["unattached"]));
    r.release(); await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    await r.ended.settle(second, [r.x.instance]); await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    hungQ.resolve(); await tick();
    expect(states(t, "TQ")).toEqual(["unrecorded"]);
  });

  it("W14b: a late row of a turn its group already settled is marked while the group is held for another turn", async () => {
    const r = await rig(); const t = await newThread();
    const hungB = pending(r, `x:${t}:TB`);
    r.started(r.x, t, "TA"); r.tool(r.x, t, "TA", "A1");
    r.hold();
    r.started(r.x, t, "TB"); r.tool(r.x, t, "TB", "B1"); r.tool(r.x, t, "TA", "A2");
    await r.reload([r.x.instance]);
    r.release(); await tick();
    expect(states(t, "TA")).toEqual(["unrecorded", "unrecorded"]);
    expect(states(t, "TB")).toEqual(["open"]);
    hungB.resolve(); await tick();
    expect(states(t, "TB")).toEqual(["unrecorded"]);
  });

  it("W12d: a current-fleet turn that reuses the old turn's id is never marked by the old close", async () => {
    const r = await rig(); const t = await newThread();
    const hung = pending(r, `x:${t}:T`);
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    r.hold(); r.tool(r.x, t, "T", "A2");
    await r.reload([r.x.instance]);
    r.release(); await tick();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "C");
    hung.resolve(); await tick();
    expect(r.ended.isLive(t, "T")).toBe(true);
    expect(states(t, "T")).toEqual(["open", "open", "open"]);
  });

  it("W12e: an oversize event carries no providerInstanceId, yet the bus still tags it at detach", async () => {
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T");
    r.hold(); r.tool(r.x, t, "T", "A2", { input: "x".repeat(1_500_000) });
    await r.reload([]);
    r.release(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded"]);
    expect(r.ended.isLive(t, "T")).toBe(false);
  });
});

describe("E15-V3: bounds", () => {
  it("W11: the live set is empty after a turn.completed, a session.exited, a refused lease, a capture and a thread delete; groups leave at the next current-fleet event, a HELD one does not", async () => {
    const r = await rig(); const a = await newThread(), b = await newThread(), c = await newThread(), d = await newThread();
    r.started(r.x, a, "TA"); r.started(r.x, b, "TB"); r.started(r.x, c, "TC");
    expect(r.ended.sizes().liveTurns).toBe(3);
    r.x.emit(ev({ type: "turn.completed", threadId: a, turnId: "TA", ok: true }));
    r.x.emit(ev({ type: "session.exited", threadId: b, turnId: "TB" }));
    r.ended.ended(c, "TC");
    expect(r.ended.sizes().liveTurns).toBe(0);
    r.started(r.x, d, "TD"); r.tool(r.x, d, "TD", "D1");
    pending(r, `x:${d}:TD`);
    await r.reload([r.x.instance]);
    expect(r.ended.sizes()).toEqual({ liveTurns: 0, groups: 1 });
    // a HELD group stays when its thread folds a current-fleet event
    r.started(r.x, d, "TD2");
    expect(r.ended.sizes().groups).toBe(1);
    r.ended.forgetThreads([d]);
    expect(r.ended.sizes()).toEqual({ liveTurns: 0, groups: 0 });
  });

  it("W11b: a MARKED group leaves at the thread's next current-fleet event", async () => {
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A");
    await r.reload([]);
    expect(r.ended.sizes().groups).toBe(1);
    r.started(r.x, t, "T2");
    expect(r.ended.sizes().groups).toBe(0);
  });

  it("W11c: the terminal of a Stop-quarantined turn never reaches the fold's remove point, and still leaves the live set", async () => {
    // the record is its own listener: an event the fold returns early on is seen all the same
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T");
    r.x.emit(ev({ type: "turn.completed", threadId: t, turnId: "T", ok: false }));
    expect(r.ended.sizes().liveTurns).toBe(0);
  });

});

describe("E15-V3: production wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const full = source.slice(source.indexOf("async function reloadProviders("), source.indexOf("/** The instance a direct run dispatched on"));
  const scoped = source.slice(source.indexOf("async function reloadScopedProviders("), source.indexOf("// Config writes rebuild the whole provider registry"));
  it("the full reload captures after the detach and settles in a finally that follows the dispose, before the engines are reloaded", () => {
    const [detach, capture, dispose, fin, settle, load] = ["bus.detachAll()", "reloadEnded.capture(", "registry.disposeAll()", "}finally{", "reloadEnded.settle(", "registry.load("].map(text => full.indexOf(text));
    expect([detach, capture, dispose, fin, settle, load].every(at => at > -1)).toBe(true);
    expect(detach).toBeLessThan(capture);
    expect(capture).toBeLessThan(dispose);
    expect(dispose).toBeLessThan(fin);
    expect(fin).toBeLessThan(settle);
    expect(settle).toBeLessThan(full.indexOf("const retained=reloadRetained.snapshot()"));
    expect(settle).toBeLessThan(load);
  });
  it("the scoped reload settles inside the inner finally, so a rejected registry.reload still marks", () => {
    expect(scoped.indexOf("registry.reload(scope")).toBeLessThan(scoped.indexOf("} finally {"));
    expect(scoped.indexOf("} finally {")).toBeLessThan(scoped.indexOf("reloadEnded.settle("));
    expect(scoped.indexOf("reloadEnded.settle(")).toBeLessThan(scoped.indexOf("unconfirmedCloses(retiringThreads"));
  });
  it("the settle is not inside retainRetiredRun, releaseOnLateClose or releaseRetainedOnClose (an owns()==false run cannot skip it)", () => {
    const retain = source.slice(source.indexOf("function releaseRetainedOnClose("), source.indexOf("/** Rebuild the provider fleet after a config change"));
    expect(retain).not.toContain("reloadEnded");
  });
  it("the record listens after the fold and asks the object the bus delivers (never the fold's local copy)", () => {
    const fold = source.indexOf("bus.subscribeExecution(foldRuntimeEvent);");
    const listener = source.indexOf("reloadEnded.observe({");
    expect(fold).toBeGreaterThan(-1);
    expect(fold).toBeLessThan(listener);
    const body = source.slice(source.lastIndexOf("bus.subscribeExecution((event: RuntimeEvent) => {", listener), source.indexOf("});", listener));
    expect(body).toContain("bus.detachedSeq(event)");
    expect(body).toContain("bus.instanceOf(event)");
  });
});

describe("E15-V3: turnCloses", () => {
  it("decides per turn by the turn's own instance and this reload's unconfirmed set; an untracked turn is closed now", async () => {
    const hung = deferred();
    const adapter = { awaitTurnClose: (_t: string, turn?: string) => turn === "H" ? hung.promise : Promise.resolve(), turnChildTracked: (_t: string, turn: string) => turn !== "U" };
    const out = await turnCloses([
      { threadId: "t", turnId: "H", instanceId: "x" }, { threadId: "t", turnId: "U", instanceId: "x" }, { threadId: "t", turnId: "Z", instanceId: "other" },
    ], [{ instanceId: "x", adapter } as never]);
    expect(out.map(o => [o.turn.turnId, Boolean(o.close)])).toEqual([["H", true], ["U", false], ["Z", false]]);
  });
});

describe("E15-V3: review fixes", () => {
  it("W8e: a busy mark of a late row survives the group's release by the thread's next current-fleet event", async () => {
    const r = await rig({ markThrows: (_thread, _turn, call) => (call === 2 ? "busy" : undefined) });
    const t = await newThread();
    r.started(r.x, t, "T"); r.tool(r.x, t, "T", "A1");
    r.hold(); r.tool(r.x, t, "T", "A2");
    await r.reload([]);
    r.release(); await tick();
    expect(states(t, "T")).toEqual(["unrecorded", "open"]);
    r.started(r.x, t, "T2"); // releases the MARKED group while the retry waits
    expect(r.ended.sizes().groups).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(states(t, "T")).toEqual(["unrecorded", "unrecorded"]);
  });

  it("W12f: an event an earlier detach cut off keeps that detach's sequence when a second reload runs while it is still queued", async () => {
    const r = await rig(); const t = await newThread();
    r.started(r.x, t, "T");
    r.hold(); r.tool(r.x, t, "T", "A2");
    const late = r.seen.at(-1)!;
    await r.reload([]);
    const first = r.bus.detachedSeq(late);
    expect(first).toBeDefined();
    await r.reload([]);
    expect(r.bus.detachedSeq(late)).toBe(first);
    r.release();
  });
});

// r3 (ASTRA 2583, DESIGN-DELTA r3): the production reloadEnded wiring block and reloadProviders / reloadScopedProviders, sliced from
// server/index.ts and run with the real EventBus, ReloadEndedTurns, turnCloses and Store rows; only the adapters' awaitTurnClose, the
// registry and the services the reload calls on its way are fakes (every name not given is a no-op).
describe("E15-V3 r3: a detach's record lives until its last queued event and its own child close, whatever the number of later reloads", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    if (start < 0) throw new Error(`index.ts: ${from} not found`);
    return stripTypeScriptTypes(source.slice(start, source.indexOf(to, start)));
  };
  const code = [
    slice("const reloadEnded = new ReloadEndedTurns({", "\n// Delegated turns are fire-and-forget"),
    slice("async function reloadProviders(", "\n/** The instance a direct run dispatched on"),
    slice("async function reloadScopedProviders(", "\n// Config writes rebuild the whole provider registry."),
  ].join("\n");

  async function production() {
    const { x, y, open } = await fleet();
    const bus = new EventBus();
    bus.omitLog(() => true);
    let heldGate = false; let wake = deferred();
    bus.gateDeliveries({ held: () => heldGate, wait: () => wake.promise, isBusy: e => e === "busy" });
    // the fold stand-in, subscribed first as production subscribes foldRuntimeEvent before the record
    bus.subscribeExecution(event => {
      const e = event as unknown as { type: string; itemType?: string; threadId: string; turnId?: string; itemId?: string };
      if (e.type === "item.started" && e.itemType === "tool" && e.turnId) store.appendMessage(e.threadId, { role: "bot", kind: "activity", turnId: e.turnId, tool: { name: e.itemId ?? "tool" } });
    });
    const unconfirmed = { full: [] as ProviderInstance[], scoped: [] as ProviderInstance[], dispose: Promise.resolve() };
    const given: Record<string, unknown> = {
      ReloadEndedTurns, databaseGeneration: () => 1, isDatabaseBusy: () => false, awaitWriterGateForeground: async () => undefined, bus,
      store: { bots: [], markTurnToolsUnrecorded: (threadId: string, turnId: string) => store.markTurnToolsUnrecorded(threadId, turnId), retireFuigoResumeState: () => undefined },
      shellSessions: { retire: () => undefined }, providerFleetReady: true, browserSetup: undefined, browserExtension: undefined, cfg: {},
      directRuns: { forBot: () => [], current: () => false },
      projectTurnLeases: { generations: () => [], generationsForThreads: () => [], disposed: () => undefined, threadIds: () => [] },
      unconfirmedCloses: async () => new Map(), reloadRetained: new RetainedCloses(), threadsWithWorkInFlight: () => new Map(), localVmThreadTargets: new Map(),
      registry: {
        disposeAll: async () => { await unconfirmed.dispose; return unconfirmed.full; }, load: async () => undefined,
        reload: async () => unconfirmed.scoped, instances: () => [x.instance, y.instance], get: (id: string) => [x.instance, y.instance].find(i => i.instanceId === id),
      },
      scopedReloadUnsafe: () => false, Map, Set, Promise,
    };
    const context = new Proxy(given, {
      has: () => true,
      get: (target, key) => key in target ? target[key as string] : key === Symbol.unscopables ? undefined : (globalThis as Record<PropertyKey, unknown>)[key] ?? (() => undefined),
    });
    const made = runInNewContext(code + "\n({ reloadProviders, reloadEnded });", context) as { reloadProviders: (scope?: Set<string>) => Promise<void>; reloadEnded: ReloadEndedTurns };
    bus.attach([x.instance, y.instance]);
    return {
      ...made, bus, x, y, open, unconfirmed,
      // the detach records the production record holds (read at runtime: the same field on the pre-fix code)
      records: () => (made.reloadEnded as unknown as { epochs: Map<number, unknown> }).epochs.size,
      hold: () => { heldGate = true; wake = deferred(); },
      release: () => { heldGate = false; wake.resolve(); },
      started: (r: { emit: (e: RuntimeEvent) => void }, threadId: string, turnId: string) => r.emit(ev({ type: "turn.started", threadId, turnId })),
      tool: (r: { emit: (e: RuntimeEvent) => void }, threadId: string, turnId: string, itemId: string) => r.emit(ev({ type: "item.started", itemType: "tool", threadId, turnId, itemId, title: itemId })),
    };
  }

  /** Detach 1 is a full reload whose engine kept the child open; then `later` scoped reloads of the other engine, each a new detach,
   * all while detach 1's events are still queued behind a held writer gate. */
  async function reloads(p: Awaited<ReturnType<typeof production>>, later: number) {
    p.unconfirmed.full = [p.x.instance];
    await p.reloadProviders();
    for (let i = 0; i < later; i++) await p.reloadProviders(new Set(["y"]));
    expect(p.bus.detachCount()).toBe(later + 1);
  }

  for (const n of [17, 1000]) {
    it(`W15 N=${n}: a turn whose start and tool were both queued at detach 1 waits on its own child after ${n - 1} later detaches`, async () => {
      const p = await production(); const t = await newThread();
      const hung = pending(p, `x:${t}:TQ`);
      p.hold();
      p.started(p.x, t, "TQ"); p.tool(p.x, t, "TQ", "Q1");
      await reloads(p, n - 1);
      p.release(); await tick();
      expect(states(t, "TQ")).toEqual(["open"]);
      hung.resolve(); await tick();
      expect(states(t, "TQ")).toEqual(["unrecorded"]);
    }, 120_000);

    it(`W15b N=${n}: a late joiner of a captured group waits on its own child, not its neighbour's, after ${n - 1} later detaches`, async () => {
      const p = await production(); const t = await newThread();
      const hungA = pending(p, `x:${t}:TA`), hungB = pending(p, `x:${t}:TB`);
      p.started(p.x, t, "TA"); p.tool(p.x, t, "TA", "A1");
      p.hold();
      p.started(p.x, t, "TB"); p.tool(p.x, t, "TB", "B1");
      await reloads(p, n - 1);
      p.release(); await tick();
      expect(states(t, "TB")).toEqual(["open"]);
      hungA.resolve(); await tick();
      expect(states(t, "TA")).toEqual(["unrecorded"]);
      expect(states(t, "TB")).toEqual(["open"]);
      hungB.resolve(); await tick();
      expect(states(t, "TB")).toEqual(["unrecorded"]);
    }, 120_000);

    it(`W15e N=${n}: only the detach still waiting is held; it is released once its last queued event and its child close are delivered`, async () => {
      const p = await production(); const t = await newThread();
      const hung = pending(p, `x:${t}:TQ`);
      p.hold();
      p.started(p.x, t, "TQ"); p.tool(p.x, t, "TQ", "Q1");
      await reloads(p, n - 1);
      expect(p.records()).toBe(1);
      p.release(); await tick();
      expect(p.records()).toBe(1);
      hung.resolve(); await tick();
      expect(p.records()).toBe(0);
    }, 120_000);
  }

  it("W15f: a scoped reload that shares the full reload's detach count and settles first does not release the full reload's late turn", async () => {
    const p = await production(); const t = await newThread();
    const hung = pending(p, `x:${t}:TQ`);
    const disposing = deferred();
    p.unconfirmed.full = [p.x.instance]; p.unconfirmed.dispose = disposing.promise;
    p.hold();
    p.started(p.x, t, "TQ"); p.tool(p.x, t, "TQ", "Q1");
    const full = p.reloadProviders(); await tick();
    // x is already detached: this reload detaches nothing, so it captures under the same count and settles with no unconfirmed engine
    await p.reloadProviders(new Set(["x"]));
    expect(p.bus.detachCount()).toBe(1);
    p.release(); await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    disposing.resolve(); await full; await tick();
    expect(states(t, "TQ")).toEqual(["open"]);
    hung.resolve(); await tick();
    expect(states(t, "TQ")).toEqual(["unrecorded"]);
  });

  it("W15h: when every child closed during the dispose, the record is released by the delivery of the last event the detach had queued", async () => {
    const p = await production(); const t = await newThread();
    p.started(p.x, t, "TA"); p.tool(p.x, t, "TA", "A1");
    p.hold(); p.tool(p.x, t, "TA", "A2");
    p.unconfirmed.full = [];
    await p.reloadProviders();
    expect(states(t, "TA")).toEqual(["unrecorded"]);
    expect(p.records()).toBe(1);
    p.release(); await tick();
    expect(states(t, "TA")).toEqual(["unrecorded", "unrecorded"]);
    expect(p.records()).toBe(0);
  });

  it("W15g: deleting the thread of a turn whose child never closes releases its detach's record once the queue has drained", async () => {
    const p = await production(); const t = await newThread();
    pending(p, `x:${t}:TA`);
    p.started(p.x, t, "TA"); p.tool(p.x, t, "TA", "A1");
    await reloads(p, 0);
    expect(p.records()).toBe(1);
    p.reloadEnded.forgetThreads([t]);
    expect(p.records()).toBe(0);
  });
});
