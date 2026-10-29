// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-08 and AT-09 subsets, against the fake Flux (no network, no Flux key): custody before ack, one submission
// per run, literal-zero child ceilings, a finish that settles once, and Flux's waits shown as states. The failures
// prevented: an event lost because it was acknowledged before it was saved, one event running twice after a restart,
// a run billed twice, and a capacity wait shown as an error that the owner cannot act on.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import type { AppTriggerBinding } from "../shared/app-triggers.ts";
import { AppTriggerDelivery, appRunDisplay, createFluxAppEventsClient, operationKey, type ReserveBody } from "./app-trigger-delivery.ts";
import { AppTriggerStore, type AppEventRun } from "./app-trigger-store.ts";
import { refuseAppChild, wireAppChildGuard } from "./app-trigger-zero.ts";
import { FakeFluxAppEvents, appEventError, capabilitiesReply, claimItemFromCatalog } from "./testing/fake-flux-app-events.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const BILL = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
const dbs: DatabaseSync[] = [];
afterEach(() => { wireAppChildGuard(null); for (const db of dbs.splice(0)) db.close(); });

let seq = 0;
beforeEach(() => { seq = 0; });
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function setup(options: { filter?: AppTriggerBinding["filter"]; capabilities?: Parameters<typeof capabilitiesReply>[0] } = {}) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const store = new AppTriggerStore(db);
  const binding: AppTriggerBinding = {
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: BILL, botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: options.filter ?? { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  };
  store.putBinding(binding, T0);
  const flux = new FakeFluxAppEvents();
  flux.always("GET", /\/capabilities$/, capabilitiesReply(options.capabilities));
  let now = T0;
  const submitted: Array<{ runId: string; deliveryIds: readonly string[]; threadId: string; childRefusedInTurn: boolean }> = [];
  const client = createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: flux.fetch, accessToken: () => "test-home-access" });
  // the hard zero reads the same store: a child attempt from inside the run's first turn must already be refused
  wireAppChildGuard({ lineage: store, now: () => now, defer: () => undefined });
  const make = (turnAlive?: (run: AppEventRun) => boolean) => new AppTriggerDelivery({
    store, client, home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => now, newId: uuid,
    submit: {
      thread: () => `app-thread-${submitted.length + 1}`,
      start: (run, deliveryIds) => {
        submitted.push({ runId: run.runId, deliveryIds, threadId: run.threadId, childRefusedInTurn: refuseAppChild({ threadId: run.threadId, generation: "gen-new" }, "ask") !== null });
        return { generation: "gen-1" };
      },
    },
    ...(turnAlive ? { turnAlive } : {}),
  });
  const delivery = make();
  const item = (extra: Partial<Parameters<typeof claimItemFromCatalog>[1]> = {}) => claimItemFromCatalog("slack.channel.message", { subscriptionId: SUB, sourceKey: `slack:C1:${uuid()}`, ...extra });
  /** One full pass: claim, batch, let the 30-second window pass, seal, then advance runs. */
  const cycle = async () => { await delivery.pollOnce(); delivery.batchPass(); now += 30_000; delivery.batchPass(); await delivery.runPass(); };
  return { db, store, binding, flux, client, delivery, make, submitted, item, cycle, advance: (ms: number) => (now += ms), now: () => now };
}
const onlyRun = (h: ReturnType<typeof setup>) => {
  const runs = h.store.history("r-1", { limit: 50 });
  expect(runs).toHaveLength(1);
  return runs[0]!;
};

describe("custody before acknowledgment", () => {
  it("a crash before the inbox commit sends no ack, and the redelivery is the same identity", async () => {
    const h = setup();
    h.flux.ackEcho();
    const event = h.item();
    h.flux.claimOnce([event]);
    const commit = h.store.commitClaim.bind(h.store);
    h.store.commitClaim = () => { throw new Error("disk full"); };
    await expect(h.delivery.pollOnce()).rejects.toThrow(/disk full/);
    expect(h.flux.calls("POST", /\/deliveries\/ack$/)).toHaveLength(0);
    expect(h.store.inboxRow(event.deliveryId)).toBeNull();
    h.store.commitClaim = commit;
    h.flux.claimOnce([event]); // the lease expired; Flux redelivers the same delivery id
    expect(await h.delivery.pollOnce()).toMatchObject({ claimed: 1, acked: true });
    expect(h.flux.calls("POST", /\/deliveries\/ack$/)[0]!.body).toMatchObject({ receipts: [{ deliveryId: event.deliveryId, disposition: "accepted" }] });
    expect(h.store.inboxRow(event.deliveryId)).toMatchObject({ disposition: "ready", acked: true });
  });
  it("an ack whose answer was lost is replayed identically", async () => {
    const h = setup();
    const event = h.item(), filtered = h.item();
    h.store.putBinding({ ...h.binding, filter: { all: [{ field: "channel_type", op: "eq", value: "channel" }] } }, T0);
    const dropped = { ...filtered, projection: { fields: { channel_type: "im" }, resourceRefs: [] }, digest: bodyDigest({ fields: { channel_type: "im" }, resourceRefs: [] }) };
    h.flux.claimOnce([event, dropped]);
    h.flux.on("POST", /\/deliveries\/ack$/, "reset");
    expect(await h.delivery.pollOnce()).toMatchObject({ acked: false });
    // the next poll replays the committed ack first, identically (same claim, receipts and key), then claims again
    h.flux.ackEcho();
    h.flux.claimOnce([]);
    await h.delivery.pollOnce();
    const acks = h.flux.calls("POST", /\/deliveries\/ack$/);
    expect(acks).toHaveLength(2);
    expect(acks[1]!.body).toEqual(acks[0]!.body);
    expect(acks[1]!.headers["idempotency-key"]).toBe(acks[0]!.headers["idempotency-key"]);
    expect(h.store.inboxRow(event.deliveryId)).toMatchObject({ disposition: "ready", acked: true });
    const ackBodies = acks.map(call => (call.body as { receipts: unknown }).receipts);
    // receipts go in delivery-id order, so the replay is byte-identical
    expect(ackBodies[0]).toEqual([{ deliveryId: event.deliveryId, disposition: "accepted" }, { deliveryId: dropped.deliveryId, disposition: "dropped" }].sort((a, b) => (a.deliveryId < b.deliveryId ? -1 : 1)));
    expect(h.store.inboxRow(dropped.deliveryId)).toMatchObject({ disposition: "dropped", tombstone: "filtered" });
  });
  it("a delivery for a subscription that is not this home's binding is not retained", async () => {
    const h = setup();
    h.flux.ackEcho();
    const foreign = h.item({ subscriptionId: "11111111-2222-4333-8444-555555555555" });
    h.flux.claimOnce([foreign]);
    await h.delivery.pollOnce();
    expect(h.flux.calls("POST", /\/deliveries\/ack$/)[0]!.body).toMatchObject({ receipts: [{ deliveryId: foreign.deliveryId, disposition: "dropped" }] });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM app_event_inbox").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT owner_account_id, source_key, digest FROM app_event_tombstones").get()).toEqual({ owner_account_id: null, source_key: null, digest: null });
  });
  it("filtered and stale are kept as dispositions, not errors", async () => {
    const h = setup({ filter: { all: [{ field: "channel_type", op: "eq", value: "private" }] } });
    h.flux.ackEcho();
    const filtered = h.item(), stale = h.item({ deadlineAt: "2026-10-29T07:00:00Z" });
    h.flux.claimOnce([filtered, stale]);
    expect(await h.delivery.pollOnce()).toMatchObject({ acked: true });
    expect(h.store.inboxRow(filtered.deliveryId)).toMatchObject({ disposition: "dropped", tombstone: "filtered" });
    expect(h.store.inboxRow(stale.deliveryId)).toMatchObject({ disposition: "dropped", tombstone: "stale" });
  });
  it("a missing limit holds admission before any claim", async () => {
    const h = setup({ capabilities: { drop: ["runLeaseSec"] } });
    expect(await h.delivery.pollOnce()).toMatchObject({ held: "limits" });
    expect(h.flux.calls("POST", /\/deliveries\/claim$/)).toHaveLength(0);
  });
});

describe("the run protocol", () => {
  it("reserve sends the literal zeros, the bot's billingRef and the sealed membership; start submits once", async () => {
    const h = setup();
    h.flux.ackEcho().runProtocol();
    const a = h.item(), b = h.item();
    h.flux.claimOnce([a, b]);
    await h.cycle();
    const reserve = h.flux.calls("POST", /\/reserve$/);
    expect(reserve).toHaveLength(1);
    expect(reserve[0]!.body).toEqual({ version: 1, subscriptionId: SUB, deliveryIds: [a.deliveryId, b.deliveryId], policyDigest: h.binding.policyDigest, billingRef: BILL, childCreates: 0, childHandoffs: 0 });
    expect(reserve[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await h.delivery.runPass();
    expect(h.submitted).toHaveLength(1);
    const run = onlyRun(h);
    expect(run).toMatchObject({ state: "running", submitted: true, threadId: "app-thread-1", generation: "gen-1", childCreates: 0, childHandoffs: 0 });
    // the run thread was recorded before the turn began: a child attempt from inside it, under any generation, is refused
    expect(h.submitted[0]).toMatchObject({ threadId: "app-thread-1", childRefusedInTurn: true });
    // later passes renew; nothing submits again
    for (let i = 0; i < 3; i++) { h.advance(30_000); await h.delivery.runPass(); }
    expect(h.submitted).toHaveLength(1);
    expect(h.flux.calls("POST", /\/renew$/).length).toBeGreaterThanOrEqual(3);
    expect(h.flux.unexpected).toEqual([]);
  });
  it("Flux refuses a non-zero child ceiling, whatever else is scripted", async () => {
    const h = setup();
    h.flux.runProtocol();
    const body = { version: 1, subscriptionId: SUB, deliveryIds: [uuid()], policyDigest: h.binding.policyDigest, billingRef: BILL, childCreates: 1, childHandoffs: 0 } as unknown as ReserveBody;
    await expect(h.client.reserve(uuid(), body, uuid())).rejects.toMatchObject({ code: "child_ceiling_not_zero", status: 422 });
    expect(h.flux.runs.size).toBe(0);
  });
  it("a start whose answer was lost replays newlyStarted:false and submits nothing", async () => {
    const h = setup();
    h.flux.ackEcho();
    // Flux starts the run, then the reply is lost
    h.flux.on("POST", /\/start$/, request => {
      const run = h.flux.runs.get(request.path.split("/")[4]!)!;
      run.state = "working"; run.revision++;
      return "reset";
    });
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    expect(onlyRun(h).state).toBe("starting");
    h.advance(30_000);
    await h.delivery.runPass();
    const run = onlyRun(h);
    expect(run.state).toBe("outcome_unknown");
    expect(appRunDisplay(run)).toBe("Review outcome");
    expect(h.submitted).toHaveLength(0);
    // its capacity is released once, with no usage
    expect(h.flux.settlements).toEqual([{ runId: run.runId, usage: { requests: 0, inputTokens: 0, outputTokens: 0 } }]);
  });
  it("finish settles once, however often it is asked", async () => {
    const h = setup();
    h.flux.ackEcho().runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    const usage = { requests: 1, inputTokens: 100, outputTokens: 50 };
    expect(await h.delivery.finish(runId, "succeeded", usage)).toMatchObject({ state: "completed", outcome: "succeeded" });
    await h.delivery.finish(runId, "succeeded", usage);
    // a replay of the same request at the wire returns the recorded receipt without settling
    const sent = h.flux.calls("POST", /\/finish$/)[0]!.body as { expectedRevision: number };
    await h.client.finish(runId, { expectedRevision: sent.expectedRevision, outcome: "succeeded", usage }, operationKey("finish", runId, sent.expectedRevision));
    expect(h.flux.settlements).toHaveLength(1);
    expect(h.flux.calls("POST", /\/finish$/)).toHaveLength(2);
  });
  it("429 capacity_exceeded waits exactly retryAfterSec and shows Waiting for allowance", async () => {
    const h = setup();
    h.flux.ackEcho();
    h.flux.on("POST", /\/reserve$/, appEventError("capacity_exceeded", { retryAfterSec: 45 }));
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    const waiting = onlyRun(h);
    expect(waiting).toMatchObject({ state: "budget_wait", waitReason: "capacity_exceeded" });
    expect(appRunDisplay(waiting)).toBe("Waiting for allowance");
    const at = h.now();
    expect(waiting.retryAt).toBe(at + 45_000);
    expect(h.delivery.pausedUntil).toBe(at + 45_000);
    h.advance(44_999);
    await h.delivery.runPass();
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(1);
    h.advance(1);
    await h.delivery.runPass();
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(2);
    expect(onlyRun(h).state).toBe("reserved");
    // the retry is the same operation: same key, same body
    const [first, second] = h.flux.calls("POST", /\/reserve$/);
    expect(second!.headers["idempotency-key"]).toBe(first!.headers["idempotency-key"]);
    expect(second!.body).toEqual(first!.body);
  });
  it("a 429 on the claim pauses every control call for retryAfterSec", async () => {
    const h = setup();
    h.flux.on("POST", /\/deliveries\/claim$/, appEventError("capacity_exceeded", { retryAfterSec: 20 }));
    expect(await h.delivery.pollOnce()).toMatchObject({ held: "capacity" });
    h.advance(19_000);
    expect(await h.delivery.pollOnce()).toMatchObject({ held: "capacity" });
    expect(h.flux.calls("POST", /\/deliveries\/claim$/)).toHaveLength(1);
  });
  it("a run without a billingRef is refused before reserve", async () => {
    const h = setup();
    h.flux.runProtocol();
    await h.delivery.loadLimits();
    h.db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b-nobill','trg-1','sealed',1,2)").run();
    const run = h.store.createRunForBatch({ runId: uuid(), batchId: "b-nobill", triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: h.binding.policyDigest, billingRef: null, now: h.now() });
    h.store.update(run.runId, { retryAt: h.now() }, h.now());
    await h.delivery.runPass();
    const refused = h.store.findById(run.runId)!;
    expect(refused).toMatchObject({ state: "refused", waitReason: "billing_missing" });
    expect(appRunDisplay(refused)).toBe("Bind the bot again");
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(0);
  });

  it("a finish whose reply is lost is persisted and replayed unchanged, the lease renewed meanwhile, settling once", async () => {
    const h = setup();
    h.flux.ackEcho();
    for (let i = 0; i < 3; i++) h.flux.on("POST", /\/finish$/, "reset");
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    const usage = { requests: 2, inputTokens: 10, outputTokens: 5 };
    await h.delivery.finish(runId, "succeeded", usage);
    expect(h.store.findById(runId)).toMatchObject({ state: "running", finishRequest: { outcome: "succeeded", usage }, finishReceipt: null });
    // a second, different ask keeps the first request
    await h.delivery.finish(runId, "failed", { requests: 0, inputTokens: 0, outputTokens: 0 });
    expect(h.store.findById(runId)!.finishRequest).toMatchObject({ outcome: "succeeded", usage });
    // the finish is still owed when renewal falls due: the lease is renewed so it outlives the wait (design R1)
    const renewsBefore = h.flux.calls("POST", /\/renew$/).length;
    h.advance(30_000);
    await h.delivery.runPass();
    expect(h.flux.calls("POST", /\/renew$/)).toHaveLength(renewsBefore + 1);
    h.advance(5_000);
    await h.delivery.runPass();
    const finishes = h.flux.calls("POST", /\/finish$/);
    expect(finishes).toHaveLength(4);
    expect(new Set(finishes.map(call => JSON.stringify([call.body, call.headers["idempotency-key"]]))).size).toBe(1);
    expect(h.store.findById(runId)).toMatchObject({ state: "completed", outcome: "succeeded" });
    expect(h.flux.settlements).toEqual([{ runId, usage }]);
  });
  it("a restart before the persisted finish was sent replays it", async () => {
    const h = setup();
    h.flux.ackEcho();
    h.flux.on("POST", /\/finish$/, "reset");
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    const usage = { requests: 1, inputTokens: 3, outputTokens: 4 };
    await h.delivery.finish(runId, "succeeded", usage);
    h.store.update(runId, { retryAt: null }, h.now()); // whatever schedule the stopped process left behind
    const restarted = h.make();
    await restarted.loadLimits();
    await restarted.recover();
    await restarted.runPass();
    expect(h.store.findById(runId)).toMatchObject({ state: "completed", finishReceipt: expect.anything() });
    expect(h.flux.settlements).toEqual([{ runId, usage }]);
    expect(h.submitted).toHaveLength(1);
  });
  it("a restart after Flux committed the finish but its reply was lost takes Flux's receipt and settles once", async () => {
    const h = setup();
    h.flux.ackEcho();
    const usage = { requests: 1, inputTokens: 7, outputTokens: 8 };
    h.flux.on("POST", /\/finish$/, request => {
      const run = h.flux.runs.get(request.path.split("/")[4]!)!;
      run.state = "finished"; run.revision++; run.outcome = "succeeded"; run.finishedAt = "2026-10-29T00:05:00Z";
      run.finishReceipt = { version: 1, runId: run.runId, outcome: "succeeded" };
      h.flux.settlements.push({ runId: run.runId, usage });
      return "reset";
    });
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    await h.delivery.finish(runId, "succeeded", usage);
    const restarted = h.make();
    await restarted.loadLimits();
    await restarted.recover();
    await restarted.runPass();
    expect(h.store.findById(runId)).toMatchObject({ state: "completed", outcome: "succeeded", finishReceipt: { runId, outcome: "succeeded" } });
    expect(h.flux.settlements).toHaveLength(1);
  });
  it("a finish Flux refuses for good is reread and held for review, keeping the request", async () => {
    const h = setup();
    h.flux.ackEcho();
    h.flux.on("POST", /\/finish$/, appEventError("run_expired"));
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    const usage = { requests: 1, inputTokens: 1, outputTokens: 1 };
    await h.delivery.finish(runId, "succeeded", usage);
    expect(h.flux.calls("GET", /\/runs\/[^/]+$/)).toHaveLength(1);
    const held = h.store.findById(runId)!;
    expect(held).toMatchObject({ state: "outcome_unknown", waitReason: "settlement_run_expired", finishRequest: { usage }, retryAt: null });
    expect(appRunDisplay(held)).toBe("Review outcome");
    expect(h.flux.settlements).toHaveLength(0);
  });
  it("no 429 pauses control calls longer than the rate-limit window; a long allowance wait stays on its own run", async () => {
    const h = setup();
    h.flux.ackEcho();
    h.flux.on("POST", /\/reserve$/, appEventError("allowance_exhausted", { retryAfterSec: 3_600 }));
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    const waiting = onlyRun(h);
    const at = h.now();
    expect(waiting).toMatchObject({ state: "budget_wait", waitReason: "allowance_exhausted", retryAt: at + 3_600_000 });
    expect(h.delivery.pausedUntil).toBeLessThanOrEqual(at + 60_000);
  });
  it("a finish under a 429 pause waits for retryAfterSec", async () => {
    const h = setup();
    h.flux.ackEcho();
    h.flux.on("POST", /\/finish$/, appEventError("capacity_exceeded", { retryAfterSec: 40 }));
    h.flux.runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const { runId } = onlyRun(h);
    await h.delivery.finish(runId, "succeeded", { requests: 1, inputTokens: 1, outputTokens: 1 });
    const at = h.now();
    h.advance(39_000);
    await h.delivery.runPass();
    expect(h.flux.calls("POST", /\/finish$/)).toHaveLength(1);
    h.advance(1_000);
    await h.delivery.runPass();
    expect(h.flux.calls("POST", /\/finish$/)).toHaveLength(2);
    expect(h.store.findById(runId)!.state).toBe("completed");
    expect(h.delivery.pausedUntil).toBe(at + 40_000);
  });
});

describe("an ack Flux never confirmed", () => {
  it("keeps its deliveries out of every batch and reserve until the ack is confirmed", async () => {
    const h = setup();
    const event = h.item();
    h.flux.claimOnce([event]);
    h.flux.on("POST", /\/deliveries\/ack$/, "reset");
    h.flux.runProtocol();
    await h.cycle();
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(0);
    expect(h.store.inboxRow(event.deliveryId)).toMatchObject({ disposition: "ready", acked: false });
    // the replay is confirmed: now it batches and reserves
    h.flux.ackEcho();
    h.flux.claimOnce([]);
    await h.cycle();
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(1);
    expect((h.flux.calls("POST", /\/reserve$/)[0]!.body as { deliveryIds: string[] }).deliveryIds).toEqual([event.deliveryId]);
  });
  it("lease_expired on the replay waits for Flux to redeliver, and the redelivery is acknowledged and runs", async () => {
    const h = setup();
    const event = h.item();
    h.flux.claimOnce([event]);
    h.flux.on("POST", /\/deliveries\/ack$/, "reset");
    await h.delivery.pollOnce();
    h.flux.on("POST", /\/deliveries\/ack$/, appEventError("lease_expired"));
    h.flux.claimOnce([]);
    await h.delivery.pollOnce();
    expect(h.store.unackedClaims(10)).toEqual([]); // not replayed again
    h.flux.ackEcho().runProtocol();
    h.flux.claimOnce([event]); // redelivered under a new claim
    await h.cycle();
    expect(h.store.inboxRow(event.deliveryId)).toMatchObject({ acked: true });
    expect(h.flux.calls("POST", /\/reserve$/)).toHaveLength(1);
  });
});

describe("startup reconciliation", () => {
  it("a run that was running when the process stopped is never renewed or resubmitted unless its turn is proven", async () => {
    const h = setup();
    h.flux.ackEcho().runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    expect(onlyRun(h).state).toBe("running");
    const restarted = h.make();
    await restarted.loadLimits();
    await restarted.recover();
    const run = onlyRun(h);
    expect(run).toMatchObject({ state: "outcome_unknown", waitReason: "restart_unproven" });
    expect(appRunDisplay(run)).toBe("Review outcome");
    const renews = h.flux.calls("POST", /\/renew$/).length;
    h.advance(120_000);
    await restarted.runPass();
    expect(h.flux.calls("POST", /\/renew$/)).toHaveLength(renews);
    expect(h.submitted).toHaveLength(1);
  });
  it("a run whose turn the host still holds is reattached and keeps renewing", async () => {
    const h = setup();
    h.flux.ackEcho().runProtocol();
    h.flux.claimOnce([h.item()]);
    await h.cycle();
    await h.delivery.runPass();
    const restarted = h.make(run => run.threadId === "app-thread-1");
    await restarted.loadLimits();
    await restarted.recover();
    expect(onlyRun(h).state).toBe("running");
    const renews = h.flux.calls("POST", /\/renew$/).length;
    h.advance(30_000);
    await restarted.runPass();
    expect(h.flux.calls("POST", /\/renew$/).length).toBe(renews + 1);
  });
});

describe("Flux replies are untrusted", () => {
  it("a claim with a duplicate member, a float or a body past the bound is never committed or acknowledged", async () => {
    for (const raw of [
      (event: ReturnType<ReturnType<typeof setup>["item"]>) => JSON.stringify({ version: 1, claimId: uuid(), leaseExpiresAt: "2099-01-01T00:00:00Z", deliveries: [event], more: false }).replace('"more":false', '"more":false,"more":true'),
      (event: ReturnType<ReturnType<typeof setup>["item"]>) => JSON.stringify({ version: 1, claimId: uuid(), leaseExpiresAt: "2099-01-01T00:00:00Z", deliveries: [event], more: false, retryAfterSec: 5 }).replace('"retryAfterSec":5', '"retryAfterSec":5.0'),
      (event: ReturnType<ReturnType<typeof setup>["item"]>) => JSON.stringify({ version: 1, claimId: uuid(), leaseExpiresAt: "2099-01-01T00:00:00Z", deliveries: [event], more: false, pad: "x".repeat(600_000) }),
    ]) {
      const h = setup();
      h.flux.ackEcho();
      const event = h.item();
      h.flux.on("POST", /\/deliveries\/claim$/, { status: 200, body: raw(event) });
      expect(await h.delivery.pollOnce()).toMatchObject({ claimed: 0, acked: false });
      expect(h.store.inboxRow(event.deliveryId)).toBeNull();
      expect(h.flux.calls("POST", /\/deliveries\/ack$/)).toHaveLength(0);
    }
  });
  it("a projection past the published depth or field count is dropped, not run", async () => {
    const h = setup();
    h.flux.ackEcho();
    const deep = { fields: { a: { b: { c: { d: { e: 1 } } } } }, resourceRefs: [] };
    const wide = { fields: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])), resourceRefs: [] };
    const events = [deep, wide].map(projection => ({ ...h.item(), projection, digest: bodyDigest(projection) }));
    h.flux.claimOnce(events);
    await h.delivery.pollOnce();
    for (const event of events) expect(h.store.inboxRow(event.deliveryId)).toMatchObject({ disposition: "dropped", tombstone: "rejected" });
  });
});
