// q1022-disk item 7: settled connected-app event history (inbox, tombstones, batches, members, runs) leaves after 30 days.
// Entry point: AppTriggerDelivery.batchPass, the pass that writes these rows, on a real store and the fake Flux.
// The aged history is seeded in the shape the delivery leaves it (custody committed and acknowledged, batch sealed, run settled).
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import type { AppTriggerBinding } from "../shared/app-triggers.ts";
import { AppTriggerDelivery, createFluxAppEventsClient } from "./app-trigger-delivery.ts";
import { AppTriggerStore } from "./app-trigger-store.ts";
import { refuseAppChild, wireAppChildGuard } from "./app-trigger-zero.ts";
import { FakeFluxAppEvents, capabilitiesReply } from "./testing/fake-flux-app-events.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23", HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10", BILL = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
let db: DatabaseSync | null = null;
afterEach(() => { wireAppChildGuard(null); db?.close(); db = null; });

function seedRun(d: DatabaseSync, id: string, at: number, state: string, opts: { thread?: string; members?: number; acked?: number; cardOwed?: boolean } = {}) {
  const batch = `b-${id}`;
  d.prepare("INSERT INTO app_event_batches (batch_id,trigger_id,state,opened_at,seal_due_at,member_count,member_bytes,run_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(batch, "trg-1", "sealed", at, at + 30_000, opts.members ?? 3, 30, id);
  for (let p = 0; p < (opts.members ?? 3); p++) {
    const del = `d-${id}-${p}`;
    d.prepare(`INSERT INTO app_event_inbox (delivery_id,owner_account_id,trigger_id,subscription_id,source_key,event_type,occurred_at,deadline_at,catch_up,digest,projection,bytes,disposition,claim_id,acked,received_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?, 'batched','c',?,?)`).run(del, "acct_owner_a", "trg-1", SUB, `slack:${del}`, "slack.channel.message", new Date(at).toISOString(),
      new Date(at + DAY).toISOString(), bodyDigest(del), JSON.stringify({ text: "x".repeat(400) }), 410, opts.acked ?? 1, at);
    d.prepare("INSERT INTO app_event_run_events (batch_id,delivery_id,position) VALUES (?,?,?)").run(batch, del, p);
  }
  d.prepare(`INSERT INTO app_event_runs (run_id,batch_id,trigger_id,routine_id,bot_id,owner_account_id,subscription_id,policy_digest,billing_ref,state,thread_id,child_refusal,child_card_written,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(id, batch, "trg-1", "r-1", "bot-a", "acct_owner_a", SUB, bodyDigest("policy"), BILL, state, opts.thread ?? null,
    opts.cardOwed ? JSON.stringify({ code: "app_child_not_allowed", kind: "create", at, attempts: 1 }) : null, at, at);
}
const n = (sql: string, ...a: Array<string | number>) => Number((db!.prepare(sql).get(...a) as { n: number }).n);

it("Q22DISK-APP the delivery's batch pass removes settled history older than 30 days and keeps everything still owed", async () => {
  db = new DatabaseSync(":memory:");
  const store = new AppTriggerStore(db);
  const binding: AppTriggerBinding = {
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: BILL, botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  };
  store.putBinding(binding, T0);
  const now = T0 + 45 * DAY;
  for (let i = 0; i < 40; i++) seedRun(db, `old-${i}`, T0 + i * 60_000, i % 2 ? "completed" : "failed");
  seedRun(db, "old-thread", T0, "completed", { thread: "app-thread-old" });
  seedRun(db, "old-running", T0, "running");
  seedRun(db, "old-card", T0, "refused", { cardOwed: true });
  seedRun(db, "young", now - 10 * DAY, "completed");
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO app_event_tombstones (delivery_id,owner_account_id,trigger_id,source_key,digest,disposition,claim_id,acked,at) VALUES (?,?,?,?,?,'filtered','c',?,?)")
    .run(`t-${i}`, "acct_owner_a", "trg-1", `slack:t-${i}`, bodyDigest(`t${i}`), i === 0 ? 0 : 1, i < 25 ? T0 : now - DAY);
  wireAppChildGuard({ lineage: store, now: () => now, defer: () => undefined });
  const flux = new FakeFluxAppEvents();
  flux.always("GET", /\/capabilities$/, capabilitiesReply());
  const client = createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: flux.fetch, accessToken: () => "test-home-access" });
  const delivery = new AppTriggerDelivery({ store, client, home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => now,
    submit: { thread: () => "t", start: () => ({ generation: "g" }) } });
  expect(await delivery.loadLimits()).not.toBeNull();
  const before = { inbox: n("SELECT count(*) AS n FROM app_event_inbox"), runs: n("SELECT count(*) AS n FROM app_event_runs") };
  delivery.batchPass();
  const left = {
    inbox: n("SELECT count(*) AS n FROM app_event_inbox"), members: n("SELECT count(*) AS n FROM app_event_run_events"),
    batches: n("SELECT count(*) AS n FROM app_event_batches"), runs: n("SELECT count(*) AS n FROM app_event_runs"), tombstones: n("SELECT count(*) AS n FROM app_event_tombstones"),
  };
  expect(before).toEqual({ inbox: 44 * 3, runs: 44 });
  // kept: old-running, old-card and young (3 runs with batches and 3 members each), old-thread's run row (its batch rows go),
  // the unacknowledged tombstone and the 5 young ones.
  expect(left, "Q22DISK-APP settled history left after the pass").toEqual({ inbox: 9, members: 9, batches: 3, runs: 4, tombstones: 6 });
  for (const id of ["old-running", "old-card", "young", "old-thread"]) expect(store.findById(id)?.runId).toBe(id);
  // the child guard still finds the old run by its thread: a later turn there is refused, never let through
  expect(refuseAppChild({ threadId: "app-thread-old", generation: "gen-later" }, "create")).not.toBeNull();
  delivery.batchPass();
  expect(n("SELECT count(*) AS n FROM app_event_runs")).toBe(4);
});
