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
import { AppTriggerStore } from "./app-trigger-store.ts";
import { FakeFluxAppEvents, appEventError, capabilitiesReply, claimItemFromCatalog } from "./testing/fake-flux-app-events.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const BILL = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

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
  const submitted: Array<{ runId: string; deliveryIds: readonly string[] }> = [];
  const client = createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: flux.fetch, accessToken: () => "test-home-access" });
  const delivery = new AppTriggerDelivery({
    store, client, home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => now, newId: uuid,
    submit: (run, deliveryIds) => { submitted.push({ runId: run.runId, deliveryIds }); return { threadId: `app-thread-${submitted.length}`, generation: "gen-1" }; },
  });
  const item = (extra: Partial<Parameters<typeof claimItemFromCatalog>[1]> = {}) => claimItemFromCatalog("slack.channel.message", { subscriptionId: SUB, sourceKey: `slack:C1:${uuid()}`, ...extra });
  /** One full pass: claim, batch, let the 30-second window pass, seal, then advance runs. */
  const cycle = async () => { await delivery.pollOnce(); delivery.batchPass(); now += 30_000; delivery.batchPass(); await delivery.runPass(); };
  return { db, store, binding, flux, client, delivery, submitted, item, cycle, advance: (ms: number) => (now += ms), now: () => now };
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
    h.flux.claimOnce([event, dropped]);
    h.flux.ackEcho();
    expect(await h.delivery.pollOnce()).toMatchObject({ acked: true });
    const acks = h.flux.calls("POST", /\/deliveries\/ack$/).map(call => (call.body as { receipts: unknown }).receipts);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
    expect(acks[0]).toEqual([{ deliveryId: event.deliveryId, disposition: "accepted" }, { deliveryId: dropped.deliveryId, disposition: "dropped" }]);
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
    await h.client.finish(runId, { expectedRevision: sent.expectedRevision, outcome: "succeeded", usage }, operationKey("finish", runId));
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
});
