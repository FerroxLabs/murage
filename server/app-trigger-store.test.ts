// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-08 and AT-15 subsets: the connected-app store keeps one admission per logical event, seals batches of at
// most 20, never stores a child ceiling above zero, and its per-event queries are index searches, so an owner with years
// of runs pays the same per event as one with none. The failures prevented: one event starting two runs, a batch too
// large for Flux to reserve, and event handling slowing down as history grows.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import type { AppClaimItem, AppTriggerBinding } from "../shared/app-triggers.ts";
import { APP_TRIGGER_TABLES, AppTriggerStore, PER_EVENT_SQL, fenceRestoredAppTriggers } from "./app-trigger-store.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const BILL = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function setup() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const store = new AppTriggerStore(db);
  const binding: AppTriggerBinding = {
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: BILL, botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  };
  store.putBinding(binding, T0);
  return { db, store, binding };
}
const projection = { fields: { channel_type: "channel" }, resourceRefs: [{ kind: "slack.channel", id: "C1" }] };
const item = (sourceKey: string, deliveryId = uuid()): AppClaimItem => ({
  deliveryId, subscriptionId: SUB, eventType: "slack.channel.message", sourceKey, occurredAt: "2026-10-29T08:00:00Z", deadlineAt: "2026-10-29T09:00:00Z",
  catchUp: false, digest: bodyDigest(projection), projection,
});
const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const bounds = { windowMs: 30_000, maxEvents: 20, maxBytes: 32 * 1024 };

describe("one admission per logical event", () => {
  it("the owner/trigger/source key is unique: a second delivery of the same event is a duplicate tombstone", () => {
    const { db, store, binding } = setup();
    const first = item("slack:C1:1"), again = item("slack:C1:1");
    expect(store.commitClaim("c1", [{ item: first, binding, disposition: "accept" }, { item: again, binding, disposition: "accept" }], T0))
      .toEqual([{ deliveryId: first.deliveryId, disposition: "accepted" }, { deliveryId: again.deliveryId, disposition: "dropped" }]);
    expect(count(db, "SELECT COUNT(*) AS n FROM app_event_inbox")).toBe(1);
    expect(store.inboxRow(again.deliveryId)).toMatchObject({ disposition: "dropped", tombstone: "duplicate" });
  });
  it("a replayed claim keeps each delivery's first disposition", () => {
    const { store, binding } = setup();
    const kept = item("slack:C1:2"), dropped = item("slack:C1:3");
    const first = store.commitClaim("c1", [{ item: kept, binding, disposition: "accept" }, { item: dropped, binding, disposition: "filtered" }], T0);
    // the same deliveries, redelivered under a new claim after a lost ack, even with other local decisions
    const replay = store.commitClaim("c2", [{ item: kept, binding, disposition: "filtered" }, { item: dropped, binding, disposition: "accept" }], T0 + 1);
    expect(replay).toEqual(first);
  });
  it("a foreign delivery keeps only its id: no owner, trigger, source or digest", () => {
    const { db, store } = setup();
    const foreign = { ...item("slack:C9:1"), subscriptionId: uuid() };
    store.commitClaim("c1", [{ item: foreign, binding: null, disposition: "rejected" }], T0);
    expect(db.prepare("SELECT owner_account_id, trigger_id, source_key, digest FROM app_event_tombstones WHERE delivery_id=?").get(foreign.deliveryId))
      .toEqual({ owner_account_id: null, trigger_id: null, source_key: null, digest: null });
    expect(count(db, "SELECT COUNT(*) AS n FROM app_event_inbox")).toBe(0);
  });
  it("a trigger never moves to another owner, subscription or routine", () => {
    const { store, binding } = setup();
    expect(() => store.putBinding({ ...binding, ownerAccountId: "acct_owner_b" }, T0)).toThrow(/new trigger/);
    expect(() => store.putBinding({ ...binding, routineId: "r-2" }, T0)).toThrow(/new trigger/);
    expect(store.binding("trg-1")!.ownerAccountId).toBe("acct_owner_a");
  });
  it("a policy revision never changes once written", () => {
    const { store } = setup();
    const policy = { policyId: "p-1", revision: 1, triggerId: "trg-1", bindingDigest: bodyDigest("b"), approvedAt: T0, revokedAt: null, childCreates: 0 as const, childHandoffs: 0 as const };
    store.putPolicy(policy, T0);
    store.putPolicy(policy, T0);
    expect(() => store.putPolicy({ ...policy, approvedAt: T0 + 1 }, T0)).toThrow(/never changes/);
  });
});

describe("batches", () => {
  it("at most 20 members: the 21st opens the next batch", () => {
    const { db, store, binding } = setup();
    const items = Array.from({ length: 25 }, (_, i) => item(`slack:C1:b${i}`));
    store.commitClaim("c1", items.map(entry => ({ item: entry, binding, disposition: "accept" as const })), T0);
    expect(store.readyDeliveries("trg-1", 50)).toHaveLength(0); // nothing batches before Flux confirms the ack
    store.markAcked("c1");
    for (const ready of store.readyDeliveries("trg-1", 50)) store.addToBatch("trg-1", ready.deliveryId, ready.bytes, T0, bounds, uuid);
    const batches = db.prepare("SELECT state, member_count FROM app_event_batches ORDER BY opened_at, member_count DESC").all() as Array<{ state: string; member_count: number }>;
    expect(batches).toEqual([{ state: "sealed", member_count: 20 }, { state: "open", member_count: 5 }]);
    expect(count(db, "SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM app_event_run_events GROUP BY batch_id)")).toBe(20);
  });
  it("the database itself refuses a 21st member and a second batch per delivery", () => {
    const { db } = setup();
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b1','trg-1','open',1,2)").run();
    expect(() => db.prepare("INSERT INTO app_event_run_events (batch_id, delivery_id, position) VALUES ('b1','d-x',20)").run()).toThrow();
    db.prepare("INSERT INTO app_event_run_events (batch_id, delivery_id, position) VALUES ('b1','d-1',0)").run();
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b2','trg-2','open',1,2)").run();
    expect(() => db.prepare("INSERT INTO app_event_run_events (batch_id, delivery_id, position) VALUES ('b2','d-1',0)").run()).toThrow();
  });
  it("the window seals a batch after 30 seconds and the run binds to it once", () => {
    const { store, binding } = setup();
    const one = item("slack:C1:w1");
    store.commitClaim("c1", [{ item: one, binding, disposition: "accept" }], T0);
    const batchId = store.addToBatch("trg-1", one.deliveryId, 10, T0, bounds, uuid);
    store.sealDue(T0 + 29_999, 10);
    expect(store.sealedWithoutRun(10)).toHaveLength(0);
    store.sealDue(T0 + 30_000, 10);
    expect(store.sealedWithoutRun(10)).toEqual([{ batchId, triggerId: "trg-1" }]);
    const input = { runId: uuid(), batchId, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: BILL, now: T0 };
    const run = store.createRunForBatch(input);
    // a lost reply asks again: the same run, never a replacement id
    expect(store.createRunForBatch({ ...input, runId: uuid() }).runId).toBe(run.runId);
  });
});

describe("the child ceiling is zero in the database", () => {
  it("rows CHECK child_creates and child_handoffs = 0", () => {
    const { db, store, binding } = setup();
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b1','trg-1','sealed',1,2)").run();
    const run = store.createRunForBatch({ runId: uuid(), batchId: "b1", triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: BILL, now: T0 });
    expect(run.childCreates).toBe(0);
    for (const sql of ["UPDATE app_event_runs SET child_creates=1", "UPDATE app_event_runs SET child_handoffs=4", "UPDATE app_trigger_bindings SET child_creates=1"]) expect(() => db.prepare(sql).run()).toThrow(/CHECK/);
  });
});

describe("per-event work does not grow with history (AT-15)", () => {
  it("every per-event query is an index search, with history at 0 and at 3,000 runs", () => {
    const { db, store, binding } = setup();
    // unbound parameters read as NULL; the plan does not depend on their values
    const plans = () => Object.fromEntries(Object.entries(PER_EVENT_SQL).map(([name, sql]) => [name, (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail)]));
    expect(Object.keys(plans()).length).toBeGreaterThan(10);
    for (let i = 0; i < 3_000; i++) {
      db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at, run_id) VALUES (?, 'trg-1', 'sealed', ?, ?, ?)").run(`hb${i}`, i, i, `hr${i}`);
      store.create({ runId: `hr${i}`, batchId: `hb${i}`, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: BILL, state: "completed", now: T0 + i });
    }
    db.exec("ANALYZE");
    const full = plans();
    for (const [name, details] of Object.entries(full)) {
      // never a bare table scan; a SCAN may only walk a partial index of pending rows; never a temp sort of history
      for (const detail of details) {
        expect(detail, `${name}: ${detail}`).not.toMatch(/^SCAN \w+$/);
        if (/^SCAN /.test(detail)) expect(detail, `${name}: ${detail}`).toMatch(/USING (?:COVERING )?INDEX app_\w+_(?:ready|unacked|card_owed|due|active|unrun)/);
        if (name.startsWith("history")) expect(detail).not.toMatch(/TEMP B-TREE/);
      }
    }
  });
  it("history pages by keyset, newest first, across 120 runs", () => {
    const { db, store, binding } = setup();
    for (let i = 0; i < 120; i++) {
      db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES (?, 'trg-1', 'sealed', 1, 2)").run(`kb${i}`);
      store.create({ runId: `kr${String(i).padStart(3, "0")}`, batchId: `kb${i}`, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: BILL, state: "completed", now: T0 + Math.floor(i / 2) });
    }
    const seen: string[] = [];
    let page = store.history("r-1", { limit: 50 });
    while (page.length) {
      seen.push(...page.map(run => run.runId));
      const last = page[page.length - 1]!;
      page = store.history("r-1", { limit: 50, before: { createdAt: last.createdAt, runId: last.runId } });
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe("kr119");
  });
});

describe("restore fence", () => {
  it("bindings need review, unstarted runs cancel, possibly-started runs keep an uncertain outcome, ready events go stale", () => {
    const { db, store, binding } = setup();
    const ready = item("slack:C1:f1");
    store.commitClaim("c1", [{ item: ready, binding, disposition: "accept" }], T0);
    for (const [i, state] of (["reserved", "running", "completed"] as const).entries()) {
      db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES (?, 'trg-1', 'sealed', 1, 2)").run(`fb${i}`);
      store.create({ runId: `fr${i}`, batchId: `fb${i}`, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: BILL, state, now: T0 });
    }
    expect(fenceRestoredAppTriggers(db)).toEqual({ bindings: 1, runs: 2, deliveries: 1 });
    expect(store.binding("trg-1")!.syncState).toBe("needs_review");
    expect([store.findById("fr0")!.state, store.findById("fr1")!.state, store.findById("fr2")!.state]).toEqual(["cancelled", "outcome_unknown", "completed"]);
    expect(store.inboxRow(ready.deliveryId)!.disposition).toBe("stale");
    expect(count(db, "SELECT COUNT(*) AS n FROM app_event_runs WHERE state IN ('sealed','budget_wait','reserved','starting','running')")).toBe(0);
  });
  it("creates exactly the seven listed tables", () => {
    const { db } = setup();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toEqual([...APP_TRIGGER_TABLES].sort());
  });
});
