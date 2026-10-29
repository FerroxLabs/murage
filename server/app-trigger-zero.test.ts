// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-10 subset, R3-H2: a run started by a connected-app event never creates a bot, asks a bot or hands work to
// one. Immediate, queued, owner-approved and recovered attempts are refused before any card, ledger, queue write or
// child submission; the run gets exactly one explanation card with navigation only; Full access, an approval and a
// restart cannot widen zero; and an ordinary routine keeps its budget of 4. The failure prevented: someone outside the
// owner's control (whoever sends the event) starting a chain of other bots.
import type { ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import { APP_RUN_CONTEXT, type AppRunContext, type AppTriggerBinding } from "../shared/app-triggers.ts";
import { AppTriggerStore } from "./app-trigger-store.ts";
import {
  APP_CHILD_CARD_ACTIONS, APP_CHILD_CARD_TEXT, APP_CHILD_NOT_ALLOWED, AppChildNotAllowed, assertNotAppChild, isAppChildContext, rebuildOwedCards, refuseAppChild,
  wireAppChildGuard, writeOwedCard,
} from "./app-trigger-zero.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { askBotRoute, delegateBotRoute } from "./handoff-boundary.ts";
import { EVENT_BASE_LIMIT, RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => { wireAppChildGuard(null); configureBotEgress(undefined); for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function setup() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const store = new AppTriggerStore(db);
  const binding: AppTriggerBinding = {
    triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", homeId: "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10", homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
    subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
    policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
    filter: { all: [] }, syncState: "active", activatedAt: T0, childCreates: 0, childHandoffs: 0,
  };
  store.putBinding(binding, T0);
  db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b1','trg-1','sealed',1,2)").run();
  const run = store.createRunForBatch({ runId: "00000000-0000-4000-8000-000000000001", batchId: "b1", triggerId: "trg-1", routineId: "r-1", botId: "bot-a", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: binding.policyDigest, billingRef: binding.billingRef, now: T0 });
  store.update(run.runId, { state: "running", submitted: true, threadId: "app-thread", generation: "gen-1" }, T0);
  const cards: unknown[] = [];
  const deferred: Array<() => void> = [];
  wireAppChildGuard({ lineage: store, now: () => T0, onCard: card => cards.push(card), defer: work => deferred.push(work) });
  const flush = () => { for (const work of deferred.splice(0)) work(); };
  return { db, store, run: store.findById(run.runId)!, cards, flush };
}

describe("the refusal", () => {
  it("create, ask and delegate from an app run all refuse with app_child_not_allowed", () => {
    const h = setup();
    for (const kind of ["create", "ask", "delegate"] as const) {
      expect(refuseAppChild({ threadId: "app-thread", generation: "gen-1" }, kind)).toMatchObject({ code: APP_CHILD_NOT_ALLOWED, runId: h.run.runId });
    }
    expect(h.store.findById(h.run.runId)!.childRefusal).toMatchObject({ code: APP_CHILD_NOT_ALLOWED, kind: "create", attempts: 3 });
  });
  it("a turn that is not app-origin is untouched", () => {
    const h = setup();
    expect(refuseAppChild({ threadId: "ordinary-thread", generation: "gen-1" }, "ask")).toBeNull();
    expect(isAppChildContext("ordinary-thread")).toBe(false);
    expect(() => assertNotAppChild("ordinary-thread", "delegate")).not.toThrow();
    expect(h.store.findById(h.run.runId)!.childRefusal).toBeNull();
  });
  it("queued and recovered attempts (thread lineage only) throw before the step", () => {
    setup();
    let queueWrites = 0;
    const queue = (thread: string) => { assertNotAppChild(thread, "ask"); queueWrites++; };
    expect(() => queue("app-thread")).toThrow(AppChildNotAllowed);
    expect(refuseAppChild({ threadId: "app-thread" }, "recovered")).not.toBeNull();
    expect(queueWrites).toBe(0);
  });
  it("an unreadable lineage store fails closed", () => {
    setup();
    wireAppChildGuard({ lineage: { findByThread: () => { throw new Error("disk"); }, findById: () => null, recordChildRefusal: () => ({ first: false }), markCardWritten: () => false, cardsOwed: () => [] } });
    expect(refuseAppChild({ threadId: "any-thread" }, "create")).toMatchObject({ code: APP_CHILD_NOT_ALLOWED });
  });
});

describe("exactly one explanation card per run", () => {
  it("is written after the refusal returns, from the receipt, with navigation only", () => {
    const h = setup();
    refuseAppChild({ threadId: "app-thread", generation: "gen-1" }, "delegate");
    expect(h.cards).toHaveLength(0); // not before the refusal has returned
    h.flush();
    refuseAppChild({ threadId: "app-thread", generation: "gen-1" }, "create");
    refuseAppChild({ threadId: "app-thread", generation: "gen-1" }, "ask");
    h.flush();
    expect(h.cards).toEqual([{ id: `app-child-refusal:${h.run.runId}`, runId: h.run.runId, routineId: "r-1", text: APP_CHILD_CARD_TEXT, actions: ["open_routine", "ask_my_bot"] }]);
    expect([...APP_CHILD_CARD_ACTIONS]).toEqual(["open_routine", "ask_my_bot"]);
    expect(JSON.stringify(h.cards)).not.toMatch(/allow|approve|retry|pending|resume/i);
    expect(APP_CHILD_CARD_TEXT).not.toMatch(/—/);
    expect(writeOwedCard(h.run.runId)).toBeNull();
  });
  it("a restart between the receipt and the card rebuilds it once, running nothing", () => {
    const h = setup();
    refuseAppChild({ threadId: "app-thread", generation: "gen-1" }, "ask"); // the deferred card write is lost with the process
    const cards: unknown[] = [];
    wireAppChildGuard({ lineage: h.store, now: () => T0, onCard: card => cards.push(card) });
    expect(rebuildOwedCards()).toBe(1);
    expect(rebuildOwedCards()).toBe(0);
    expect(cards).toHaveLength(1);
    expect(h.store.findById(h.run.runId)).toMatchObject({ state: "running", childCardWritten: true });
  });
});

describe("the real child entries refuse before touching anything", () => {
  function recordingPorts(internalClaim: Record<string, unknown>) {
    const touched: string[] = [];
    const replies: Array<{ status: number; body: unknown }> = [];
    configureBotEgress((_res, status, body) => { replies.push({ status, body }); });
    const spy = (name: string) => new Proxy(() => undefined, {
      apply: () => { touched.push(name); return undefined; },
      get: (_target, key) => (key === "then" ? undefined : spy(`${name}.${String(key)}`)),
    });
    // Full access on, an approval already granted: neither may widen zero.
    const known: Record<string, unknown> = { internalClaim, res: {} as ServerResponse, fullAccessSkipsPeerCard: () => { touched.push("fullAccessSkipsPeerCard"); return true; } };
    const bx = new Proxy(known, { get: (target, key) => (typeof key === "string" && key in target ? target[key] : spy(String(key))) });
    return { bx, touched, replies };
  }
  for (const [name, route] of [["ask-bot", askBotRoute], ["delegate-bot", delegateBotRoute]] as const) {
    it(`${name}: refused before the body, the cards, the event ledger and the queue`, async () => {
      setup();
      const { bx, touched, replies } = recordingPorts({ botId: "bot-a", threadId: "app-thread", generation: "gen-1", depth: 0, kind: "routine", skillAuthoring: false, expiresAt: T0 + 60_000 });
      await route(bx as never);
      expect(touched).toEqual([]); // readInternalBody, eventAction, comms.queueDelegation, approvalBus: none ran
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ status: 403, body: { code: APP_CHILD_NOT_ALLOWED } });
    });
  }
});

describe("zero never widens; ordinary routines keep their budget", () => {
  it("the app run context and rows hold literal zeros (and 1 does not type-check)", () => {
    // @ts-expect-error the run context's child ceilings are the literal 0
    const widened: AppRunContext = { ...APP_RUN_CONTEXT, childCreates: 1 };
    // @ts-expect-error a binding row's handoff ceiling is the literal 0
    const binding: Pick<AppTriggerBinding, "childHandoffs"> = { childHandoffs: 4 };
    expect([widened.childCreates, binding.childHandoffs]).toEqual([1, 4]);
    const h = setup();
    expect(h.run).toMatchObject({ childCreates: 0, childHandoffs: 0 });
  });
  it("an app routine never gets a legacy run or an EventActionBudget; a scheduled routine still gets 4", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-app-zero-"));
    dirs.push(dir);
    const manager = new RoutineManager({
      file: join(dir, "routines.json"), now: () => T0, botState: () => "ready", goalState: () => "ready",
      createTask: () => ({ threadId: "t-1" }), taskExists: () => true, startTurn: async () => {},
    });
    const base = { name: "n", prompt: "p", botId: "bot-a", target: "bot", runOn: "ember", enabled: true } as const;
    const app = manager.create({ ...base, schedule: { type: "app_event", triggerId: "trg-1" } } as never, undefined, { appEventSetup: true });
    expect(() => manager.runNow(app.id)).toThrow();
    expect(manager.listRuns()).toHaveLength(0);
    const scheduled = manager.create({ ...base, schedule: { type: "daily", time: "09:00", weekdays: [1] } } as never);
    const run = manager.runNow(scheduled.id)!;
    expect(manager.getEventBudget(run.id)?.limits).toEqual({ create: EVENT_BASE_LIMIT, handoff: EVENT_BASE_LIMIT });
    expect(EVENT_BASE_LIMIT).toBe(4);
  });
});

beforeEach(() => { wireAppChildGuard(null); });
