// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H settlement (CONTRACT-REQ noowner-1023 L5H settlement; settlement side owned by bld1023-hooks-lineage, producer side by
// bld1023-noown-l5h-producer): the host's turn-end hands (thread, generation, end) to AppTriggerDelivery.settleTurn. A run
// started through the real delivery start step settles once, only from its own root turn, into the terminal state the JOINT
// RULING STOP-VS-REFUSAL gives, and then owes exactly the result the results pass reads (a cancelled run owes none). The real
// AppTriggerStore and AppTriggerDelivery run here; the host turn-end call itself is the producer's seam (its W13).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import { AppTriggerDelivery, appRunDisplay, createFluxAppEventsClient, type AppTurnEnd } from "./app-trigger-delivery.ts";
import { AppTriggerStore } from "./app-trigger-store.ts";
import { appResultSource } from "./event-results.ts";
import { FakeFluxAppEvents, capabilitiesReply } from "./testing/fake-flux-app-events.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const BILLING = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const RUN = "00000000-0000-4000-8000-0000000000c1";
const THREAD = "app-run-thread";
const RUN_B = "00000000-0000-4000-8000-0000000000c2";
const THREAD_B = "app-run-thread-b";
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

/** A run started through the delivery's own start step (reserved thread, origin row, root turn bound before the engine). */
async function started(onRenew?: (runId: string) => Promise<void>) {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  const store = new AppTriggerStore(db);
  store.putBinding({
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: BILLING, botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  }, T0);
  const flux = new FakeFluxAppEvents();
  const replyFor = (runId: string, revision: number) => ({ version: 1, runId, state: "working", revision, subscriptionId: SUB,
    deliveryIds: ["00000000-0000-4000-8000-0000000000d1"], billingRef: BILLING, leaseExpiresAt: "2099-01-01T00:00:00Z",
    startedAt: "2026-11-22T12:00:00Z", finishedAt: null, outcome: null });
  const runIdOf = (path: string) => path.split("/")[4]!;
  flux.always("POST", /\/start$/, ({ path }) => ({ status: 200, body: { ...replyFor(runIdOf(path), 2), newlyStarted: true } }));
  flux.always("POST", /\/renew$/, async ({ path }) => {
    const runId = runIdOf(path);
    await onRenew?.(runId);
    return { status: 200, body: replyFor(runId, 3) };
  });
  flux.always("GET", /\/capabilities$/, () => capabilitiesReply());
  let now = T0;
  const delivery = new AppTriggerDelivery({
    store, client: createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: flux.fetch, accessToken: () => "test-home-access" }),
    home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => now,
    submit: { reserveThreadId: run => run.runId === RUN ? THREAD : THREAD_B, thread: (_run, prepared) => prepared ?? "unexpected",
      allocateGeneration: () => "gen-root", start: () => ({ generation: "gen-root" }) },
  });
  const start = async (runId: string, batchId: string, threadId: string) => {
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES (?,'trg-1','sealed',1,2)").run(batchId);
    store.createRunForBatch({ runId, batchId, triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: bodyDigest("policy"), billingRef: BILLING, now });
    store.update(runId, { state: "starting", retryAt: now }, now);
    await delivery.runPass();
    expect(store.findById(runId)).toMatchObject({ state: "running", threadId, generation: "gen-root" });
  };
  expect(await delivery.loadLimits()).not.toBeNull();
  await start(RUN, "b1", THREAD);
  /** The host's turn-end hand-off; absent on a consumer without settlement, which then settles nothing. */
  const settle = (generation: string, end: AppTurnEnd) =>
    (delivery as unknown as { settleTurn?: (t: string, g: string, e: AppTurnEnd) => unknown }).settleTurn?.(THREAD, generation, end) ?? null;
  const owedText = () => appResultSource(store, HOME, run => appRunDisplay({ state: run.state as never, waitReason: store.findById(RUN)!.waitReason })).owed(10).map(o => o.text);
  return { db, store, flux, delivery, start, settle, owedText, advance: (ms: number) => { now += ms; } };
}

describe("L5H settlement: the root turn's end settles its run once", () => {
  it("S1 done: the run completes, its root turn row closes and it owes one result", async () => {
    const w = await started();
    w.settle("gen-root", {});
    expect(w.store.findById(RUN)!.state).toBe("completed");
    expect(w.store.findById(RUN)!.resultState).toBe("owed");
    expect(w.store.turnOwner(THREAD, "gen-root")!.closedAt).not.toBeNull();
    expect(w.owedText()).toHaveLength(1);
  });

  it("S2 failed: the run fails and owes the failed card", async () => {
    const w = await started();
    w.settle("gen-root", { failed: true });
    expect(w.store.findById(RUN)!.state).toBe("failed");
    expect(w.store.findById(RUN)!.resultState).toBe("owed");
  });

  it("S3 (W7 settlement leg) a refusal froze while the owner Stop was HELD: the refusal is shown, the run is refused with its card", async () => {
    const w = await started();
    w.settle("gen-root", { refusalFrozenAt: T0 + 5, stopConfirmedAt: null });
    expect(w.store.findById(RUN)!.state).toBe("refused");
    expect(w.owedText()).toEqual([expect.stringContaining("Needs your review")]);
  });

  it("S4 (W7 settlement leg) a Stop confirmed before the refusal froze: cancelled and silent, no result owed", async () => {
    const w = await started();
    w.settle("gen-root", { refusalFrozenAt: T0 + 9, stopConfirmedAt: T0 + 5 });
    expect(w.store.findById(RUN)!.state).toBe("cancelled");
    expect(w.owedText()).toEqual([]);
  });

  it("S5 a Stop confirmed only after the refusal froze is not a fact at the freeze: refused", async () => {
    const w = await started();
    w.settle("gen-root", { refusalFrozenAt: T0 + 5, stopConfirmedAt: T0 + 9 });
    expect(w.store.findById(RUN)!.state).toBe("refused");
  });

  it("S6 an owner follow-up turn bound while the run is running settles nothing; the root turn still settles it", async () => {
    const w = await started();
    expect(w.store.bindTurn(THREAD, "gen-follow", RUN, T0 + 1).role).toBe("run");
    expect(w.settle("gen-follow", {})).toBeNull();
    expect(w.store.findById(RUN)!.state).toBe("running");
    w.settle("gen-root", {});
    expect(w.store.findById(RUN)!.state).toBe("completed");
  });

  it("S7 a replayed turn-end only counts once: a later different end changes nothing", async () => {
    const w = await started();
    w.settle("gen-root", {});
    expect(w.settle("gen-root", { failed: true })).toBeNull();
    expect(w.store.findById(RUN)!.state).toBe("completed");
  });

  it("S8 after settlement the pass sends no renewal for the run (no Flux capacity held by a finished run)", async () => {
    const w = await started();
    expect(await w.delivery.loadLimits()).not.toBeNull();
    w.settle("gen-root", {});
    w.advance(60_000);
    await w.delivery.runPass();
    expect(w.flux.calls("POST", /\/renew$/)).toHaveLength(0);
  });

  it("S11 after awaiting one renewal the pass skips a later run that settled in the meantime", async () => {
    const w = await started(async runId => {
      if (runId === RUN) {
        await Promise.resolve();
        w.delivery.settleTurn(THREAD_B, "gen-root", {});
      }
    });
    w.advance(1);
    await w.start(RUN_B, "b2", THREAD_B);
    w.advance(60_000);
    await w.delivery.runPass();
    expect(w.flux.calls("POST", /\/renew$/).map(call => call.path.split("/")[4])).toEqual([RUN]);
    expect(w.store.findById(RUN_B)?.state).toBe("completed");
  });

  it("S9 a Stop confirmed at the same moment the refusal froze was not confirmed before it: refused", async () => {
    const w = await started();
    w.settle("gen-root", { refusalFrozenAt: T0 + 5, stopConfirmedAt: T0 + 5 });
    expect(w.store.findById(RUN)!.state).toBe("refused");
  });

  it("S10 the ship gate: a delivery whose submit binds the root turn before the engine can settle; one without it cannot", async () => {
    const w = await started();
    const gate = (d: unknown) => (d as { canSettle?: () => boolean }).canSettle?.() ?? false;
    expect(gate(w.delivery)).toBe(true);
    const unbound = new AppTriggerDelivery({ store: w.store, client: createFluxAppEventsClient({ baseUrl: "https://flux.example.test", fetch: w.flux.fetch, accessToken: () => "test-home-access" }),
      home: { ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1 }, consumerId: "home-1", now: () => T0, submit: { thread: () => THREAD, start: () => ({ generation: "g" }) } });
    expect(gate(unbound)).toBe(false);
  });
});
