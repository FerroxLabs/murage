// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H (designs/HOOKS-LINEAGE-1023.md r2, section 1 and section 4 W1-W6b, W18; Fable r2 H1; Opus r2 M1): every turn in a
// connected-app run's thread is tied by the host to the exact run that owns it. The origin row keeps the hard zero shut after
// run history is gone (C1); a refusal, and the No limits read, belong to the run of exactly that turn, never the newest run on
// the thread (C2, C3); a turn no run owns is still app-origin and its receipt lands on the thread. The real AppTriggerStore,
// guard and AppTriggerDelivery run here; the lineage producer's host turn-start seam is OPEN NO-OWNER, so its rows are written
// through the store's own P1/P2 calls (putOrigin, bindTurn, bindRootTurn).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import type { AppTriggerBinding } from "../shared/app-triggers.ts";
import { AppTriggerDelivery, createFluxAppEventsClient } from "./app-trigger-delivery.ts";
import { AppTriggerStore, fenceRestoredAppTriggers } from "./app-trigger-store.ts";
import { APP_CHILD_CARD_TEXT, APP_CHILD_NOT_ALLOWED, rebuildOwedCards, refuseAppChild, wireAppChildGuard } from "./app-trigger-zero.ts";
import { parsePendingItem } from "./delegations.ts";
import { recoveredHandoffRefused } from "./handoff-dispatch.ts";
import { FakeFluxAppEvents } from "./testing/fake-flux-app-events.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const T0 = Date.UTC(2026, 10, 22, 8, 0, 0);
const RUN_A = "00000000-0000-4000-8000-00000000000a";
const RUN_B = "00000000-0000-4000-8000-00000000000b";
const THREAD = "app-thread-1";
const dbs: DatabaseSync[] = [];
afterEach(() => { wireAppChildGuard(null); for (const db of dbs.splice(0)) db.close(); });

// The lineage tables as the producer leaves them. CREATE IF NOT EXISTS: a no-op where the store already made them.
const LINEAGE_DDL = `
CREATE TABLE IF NOT EXISTS app_origin_threads (thread_id TEXT PRIMARY KEY, kind TEXT NOT NULL, trigger_id TEXT, routine_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL, home_id TEXT NOT NULL, home_epoch INTEGER NOT NULL, first_run_id TEXT, child_refusal TEXT, child_card TEXT,
  child_card_written INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS app_event_turns (thread_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
  bound_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY (thread_id, generation));`;

function world() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const store = new AppTriggerStore(db);
  db.exec(LINEAGE_DDL);
  const binding: AppTriggerBinding = {
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  };
  store.putBinding(binding, T0);
  /** A run on THREAD, running, created at `at` (later = newer). */
  const run = (runId: string, batch: string, at: number) => {
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES (?,'trg-1','sealed',1,2)").run(batch);
    store.createRunForBatch({ runId, batchId: batch, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: binding.billingRef, now: at });
    store.update(runId, { state: "running", submitted: true, threadId: THREAD }, at);
  };
  const origin = (firstRunId: string | null, kind: "run" | "results" = "run", threadId = THREAD) =>
    db.prepare("INSERT INTO app_origin_threads (thread_id, kind, trigger_id, routine_id, owner_account_id, home_id, home_epoch, first_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(threadId, kind, "trg-1", "r-1", "acct_owner_a", HOME, 1, firstRunId, T0);
  const turn = (generation: string, runId: string | null, at: number, closedAt: number | null = null) =>
    db.prepare("INSERT INTO app_event_turns (thread_id, generation, run_id, role, bound_at, closed_at) VALUES (?,?,?,?,?,?)")
      .run(THREAD, generation, runId, runId ? "run" : "after", at, closedAt);
  const cards: Array<{ id: string; text: string }> = [];
  const deferred: Array<() => void> = [];
  const wire = (noLimits?: (runId: string) => boolean) => wireAppChildGuard({
    lineage: store, now: () => T0, onCard: card => cards.push(card), defer: work => deferred.push(work),
    ...(noLimits ? { noLimits: (r: { runId: string }) => noLimits(r.runId) } : {}),
  });
  const flush = () => { for (const work of deferred.splice(0)) work(); };
  const originReceipt = () => db.prepare("SELECT child_refusal, child_card_written FROM app_origin_threads WHERE thread_id=?").get(THREAD) as { child_refusal: string | null; child_card_written: number } | undefined;
  return { db, store, run, origin, turn, wire, cards, flush, originReceipt };
}

describe("C1: the origin row keeps the hard zero shut", () => {
  it("W1 run history removed, the next turn asks a bot: refused, one thread card, a second attempt only counts", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.origin(RUN_A);
    w.turn("gen-1", RUN_A, T0);
    w.store.update(RUN_A, { state: "completed" }, T0 + 10);
    w.db.prepare("DELETE FROM app_event_runs WHERE run_id=?").run(RUN_A);
    w.turn("gen-2", null, T0 + 20);
    w.wire();
    const refusal = refuseAppChild({ threadId: THREAD, generation: "gen-2" }, "ask");
    expect(refusal?.code).toBe(APP_CHILD_NOT_ALLOWED);
    w.flush();
    expect(w.cards.map(card => card.id)).toEqual([`app-child-refusal:thread:${THREAD}`]);
    expect(w.cards[0]!.text).toBe(APP_CHILD_CARD_TEXT);
    expect(refuseAppChild({ threadId: THREAD, generation: "gen-2" }, "ask")?.code).toBe(APP_CHILD_NOT_ALLOWED);
    w.flush();
    expect(w.cards).toHaveLength(1);
    expect(JSON.parse(w.originReceipt()!.child_refusal!)).toMatchObject({ attempts: 2, kind: "ask" });
  });
});

describe("C2: the run of exactly that turn", () => {
  it("W2 two runs on one thread, B newest at No limits: a refusal on A's generation is refused and lands on A", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.run(RUN_B, "b2", T0 + 100);
    w.origin(RUN_A);
    w.turn("gen-a", RUN_A, T0);
    w.turn("gen-b", RUN_B, T0 + 100);
    w.wire(runId => runId === RUN_B);
    const refusal = refuseAppChild({ threadId: THREAD, generation: "gen-a" }, "delegate");
    expect(refusal?.runId).toBe(RUN_A);
    expect(w.store.findById(RUN_A)!.childRefusal).toMatchObject({ kind: "delegate", attempts: 1 });
    expect(w.store.findById(RUN_B)!.childRefusal).toBeNull();
  });

  it("W3 an unknown generation in an app-origin thread credits no run: refused, thread receipt, the run's receipt untouched", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.origin(RUN_A);
    w.turn("gen-1", RUN_A, T0);
    w.wire(runId => runId === RUN_A);
    const refusal = refuseAppChild({ threadId: THREAD, generation: "gen-unknown" }, "ask");
    expect(refusal?.code).toBe(APP_CHILD_NOT_ALLOWED);
    expect(w.store.findById(RUN_A)!.childRefusal).toBeNull();
    expect(w.originReceipt()!.child_refusal).not.toBeNull();
  });

  it("W4 P2 CAS: a turn bound to a run that already completed is role=after, and its refusal writes the thread receipt", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.origin(RUN_A);
    w.store.update(RUN_A, { state: "completed" }, T0 + 10);
    const bound = w.store.bindTurn(THREAD, "gen-late", RUN_A, T0 + 20);
    expect(bound.role).toBe("after");
    w.wire();
    expect(refuseAppChild({ threadId: THREAD, generation: "gen-late" }, "ask")?.runId).toBe("");
    expect(w.store.findById(RUN_A)!.childRefusal).toBeNull();
    expect(w.originReceipt()!.child_refusal).not.toBeNull();
  });
});

describe("C3: No limits is read from the credited run only", () => {
  it("W6 unattended A, later B at No limits (newest): a turn of A asking a bot is refused", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.run(RUN_B, "b2", T0 + 100);
    w.origin(RUN_A);
    w.turn("gen-a", RUN_A, T0);
    w.turn("gen-b", RUN_B, T0 + 100);
    w.wire(runId => runId === RUN_B);
    expect(refuseAppChild({ threadId: THREAD, generation: "gen-a" }, "ask")).not.toBeNull();
  });

  it("W6b (pin) earlier A at No limits, later unattended B: a turn of B asking a bot is refused", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.run(RUN_B, "b2", T0 + 100);
    w.origin(RUN_A);
    w.turn("gen-a", RUN_A, T0);
    w.turn("gen-b", RUN_B, T0 + 100);
    w.wire(runId => runId === RUN_A);
    expect(refuseAppChild({ threadId: THREAD, generation: "gen-b" }, "ask")).not.toBeNull();
  });
});

describe("Fable r2 H1: a No limits run's queued hand-off survives settle and restart", () => {
  it("the recovered start reads the queueing turn's stored generation: No limits proceeds with no card, below No limits is refused", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.origin(RUN_A);
    w.store.bindTurn(THREAD, "gen-1", RUN_A, T0);
    // the boundary stores the authenticated generation on the queued item; the stored row keeps it through a parse
    const item = parsePendingItem({ toBotId: "bot-b", message: "do the next step", depth: 0, sourceGeneration: "gen-1" });
    const row = { source_thread_id: THREAD, item: JSON.stringify(item) };
    w.store.update(RUN_A, { state: "completed" }, T0 + 10); // P3 closes the turn row
    w.wire(runId => runId === RUN_A); // a restart: the guard is wired again
    expect(recoveredHandoffRefused(row)).toBe(false);
    w.flush();
    expect(rebuildOwedCards()).toBe(0);
    expect(w.cards).toHaveLength(0);
    w.wire(); // twin: the same run below No limits
    expect(recoveredHandoffRefused(row)).toBe(true);
  });
});

describe("P1: reaper after recover()", () => {
  it("W5 a crash between the origin row and the task: recover() settles the run, then the orphan row is reaped, never resubmitted", async () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.db.prepare("UPDATE app_event_runs SET thread_id=NULL WHERE run_id=?").run(RUN_A);
    w.origin(RUN_A, "run", "reserved-thread");
    w.origin(null, "results", "results-thread");
    const delivery = new AppTriggerDelivery({
      store: w.store, client: createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: new FakeFluxAppEvents().fetch, accessToken: () => "test-home-access" }),
      home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => T0 + 50,
      submit: { thread: () => { throw new Error("never resubmitted"); }, start: () => { throw new Error("never resubmitted"); } },
      turnAlive: () => false, taskExists: () => false,
    });
    await delivery.recover();
    expect(w.store.findById(RUN_A)!.state).toBe("outcome_unknown");
    expect(w.store.origin("reserved-thread")).toBeNull();
    expect(w.store.origin("results-thread")?.kind).toBe("results");
  });
});

describe("P3: the single choke point", () => {
  it("W18 recover() -> outcome_unknown owes a result and closes turn rows; the restore fence writes done; cancelled writes done", async () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.origin(RUN_A);
    w.store.bindTurn(THREAD, "gen-1", RUN_A, T0);
    const delivery = new AppTriggerDelivery({
      store: w.store, client: createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: new FakeFluxAppEvents().fetch, accessToken: () => "test-home-access" }),
      home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => T0 + 50,
      submit: { thread: () => THREAD, start: () => ({ generation: "x" }) }, turnAlive: () => false,
    });
    await delivery.recover();
    expect(w.store.findById(RUN_A)!.resultState).toBe("owed");
    expect(w.store.turnOwner(THREAD, "gen-1")!.closedAt).toBe(T0 + 50);
    w.run(RUN_B, "b2", T0 + 100);
    w.store.bindTurn(THREAD, "gen-2", RUN_B, T0 + 100);
    fenceRestoredAppTriggers(w.db);
    expect(w.store.findById(RUN_B)!.resultState).toBe("done");
    expect(w.store.turnOwner(THREAD, "gen-2")!.closedAt).not.toBeNull();
    w.db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b3','trg-1','sealed',1,2)").run();
    const queued = w.store.createRunForBatch({ runId: "00000000-0000-4000-8000-00000000000c", batchId: "b3", triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: "d", billingRef: null, now: T0 });
    w.store.update(queued.runId, { state: "cancelled" }, T0 + 200, "sealed");
    expect(w.store.findById(queued.runId)!.resultState).toBe("done");
  });
});

describe("P2 root turn (Opus r2 M1): bound before the engine begins", () => {
  it("W13b a root turn that ends inside start already has its role=run row naming the run, so its settlement is credited", async () => {
    const w = world();
    const flux = new FakeFluxAppEvents();
    let seenInsideStart: unknown = "not called";
    const delivery = new AppTriggerDelivery({
      store: w.store, client: createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: flux.fetch, accessToken: () => "test-home-access" }),
      home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => T0,
      submit: {
        reserveThreadId: () => THREAD,
        thread: (_run, prepared) => prepared ?? "unexpected",
        allocateGeneration: () => "gen-root",
        start: run => { seenInsideStart = w.store.turnOwner(run.threadId, "gen-root"); return { generation: "gen-root" }; },
      },
    });
    // drive start directly from a running run: the same private step the pass takes after the start receipt
    w.run(RUN_A, "b1", T0);
    w.db.prepare("UPDATE app_event_runs SET thread_id=NULL, state='starting', submitted=0 WHERE run_id=?").run(RUN_A);
    flux.always("POST", /\/start$/, () => ({ status: 200, body: { version: 1, runId: RUN_A, state: "working", revision: 2, subscriptionId: SUB, deliveryIds: ["00000000-0000-4000-8000-0000000000d1"],
      billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", leaseExpiresAt: "2099-01-01T00:00:00Z", startedAt: "2026-11-22T08:00:00Z", finishedAt: null, outcome: null, newlyStarted: true } }));
    await (delivery as unknown as { start(run: unknown): Promise<void> }).start(w.store.findById(RUN_A));
    expect(seenInsideStart).toMatchObject({ runId: RUN_A, role: "run" });
    expect(w.store.findById(RUN_A)!.generation).toBe("gen-root");
  });
});

describe("C2 result files", () => {
  it("W11 files window: B's turn starts just after A's closes, so A's result window ends where B's turn row begins, not 5 minutes later", () => {
    const w = world();
    w.run(RUN_A, "b1", T0);
    w.run(RUN_B, "b2", T0 + 100);
    w.origin(RUN_A);
    w.turn("gen-a", RUN_A, T0, T0 + 10);
    w.turn("gen-b", RUN_B, T0 + 100);
    expect(w.store.turnWindows(RUN_A, 5 * 60_000)).toEqual([{ threadId: THREAD, from: T0, to: T0 + 100 }]);
    expect(w.store.turnWindows(RUN_B, 5 * 60_000)).toEqual([{ threadId: THREAD, from: T0 + 100, to: Number.MAX_SAFE_INTEGER }]);
  });
});
