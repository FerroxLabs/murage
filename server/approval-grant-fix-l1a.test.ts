// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L1A-1013 round 1 fixes, one test per High (Astra r1 1 to 5, Fable r1
// H1 and H2) plus Astra item 7:
//  A1  a payment is never written for good by ANY store write: the desktop
//      PATCH (patchBot), a task patch, and the grant choke point's plan;
//  A2  the routine route saves only from a routine row the card's fold shows
//      (a guard card of a routine's run carries no offer, and an older card
//      that still carries one is refused before staging);
//  A3  Undo removes only what a save added: the bot save reports additions
//      by holder, its Undo route removes each from its own holder and leaves
//      what the bot or other tasks already held;
//  A7  a task row is checked before delivery and its receipt names only an
//      allowance this answer added.
// The phone reach of task-allow (A5, Fable H1) is in route-policy-l1a.test.ts
// and companion/test/task-allow-routes.test.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { approvalCardGrants } from "./approval-card-grants.ts";
import { grantRequestFor } from "./approval-grant-request.ts";
import { botAlwaysAllowSave, botAlwaysAllowUndo, routineSaveRefusal, taskGrantRefusal, type BotGrantDeps, type BotUndoDeps, type GrantCard } from "./approval-grant-routes.ts";
import { PendingGrants, rememberAndAnswer, type GrantChokeDeps } from "./grant-choke.ts";
import { TaskAllowances } from "./stop-line-state.ts";
import type { StopHit } from "./stop-line.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const PAY = "stop:pay:stripe:brightline";
const DELETE: StopHit = { kind: "delete", place: "/Users/alex/old", what: "Delete" };

describe("A1: a payment is never written for good, whoever writes", () => {
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("the bot PATCH path (patchBot) drops it from the bot and its tasks; the rest is kept", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { alwaysAllow: [PAY, "Bash:git", "stop:delete:/Users/alex/site"] });
    expect(store.bot(bot.id)?.alwaysAllow).toEqual(["Bash:git", "stop:delete:/Users/alex/site"]);
    // the one task mirrors the bot's list, without the payment
    expect(store.tasks(bot.id)[0]?.alwaysAllow).toEqual(["Bash:git", "stop:delete:/Users/alex/site"]);
    const tasks = store.bot(bot.id)!.tasks!.map((task) => ({ ...task, alwaysAllow: [PAY, "Read"] }));
    store.patchBot(bot.id, { tasks });
    expect(store.tasks(bot.id).map((task) => task.alwaysAllow)).toEqual([["Read"]]);
  });

  it("a task patch drops it", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { alwaysAllow: [PAY, "Read"] });
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow).toEqual(["Read"]);
  });

  it("the choke point's plan refuses it with a status before anything is staged", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(() => store.planBotGrants(bot.id, bot.threadId, ["Read", PAY])).toThrow(/only be allowed once/);
    try { store.planBotGrants(bot.id, undefined, [PAY]); } catch (error) { expect((error as { status?: number }).status).toBe(400); }
    expect(() => store.rememberBotGrants(bot.id, bot.threadId, [PAY])).toThrow();
    expect(store.bot(bot.id)?.alwaysAllow ?? []).toEqual([]);
  });
});

describe("A2: the routine route saves only from the card's own routine row", () => {
  const routine = { routineId: "r1", routineName: "Cleanup" };
  const offer = () => grantRequestFor({ ask: { tool: "Bash", summary: "rm -rf old" }, stopHit: DELETE, inputCut: false, routine })!;

  it("a guard card of a routine's run carries no routine offer at all", () => {
    expect(offer().routine?.eligible).toBe(true);
    for (const source of ["sensitive-guard", "destructive-guard", "unread-call"] as const) {
      const card = approvalCardGrants({
        permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "rm -rf old", stopHit: DELETE,
        routineAllowCard: { routineId: "r1" }, verdict: { source }, grantCard: { grantRequest: offer() }, automated: true,
      });
      expect(card.grantRequest?.routine, source).toBeUndefined();
      expect(card.cardClass?.keys).not.toContain("routineOffer");
    }
    // the eligible stop card keeps it
    const plain = approvalCardGrants({
      permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "rm -rf old", stopHit: DELETE,
      routineAllowCard: { routineId: "r1" }, verdict: { source: "stop-line" }, grantCard: { grantRequest: offer() }, automated: true,
    });
    expect(plain.grantRequest?.routine?.routineId).toBe("r1");
  });

  it("an older card that still carries the offer on a guard class is refused (400) before staging", () => {
    const stored: GrantCard = {
      routineId: "r1", grantRequest: offer(),
      cardClass: { reason: "sensitive-guard", routine: { routineId: "r1" }, unattended: false, automated: true, keys: ["routineOffer"] },
    };
    const keys = [...offer().routine!.actionKeys, ...offer().routine!.stopKeys.map((stop) => stop.key)];
    expect(routineSaveRefusal(stored, "r1", keys)).toEqual({ status: 400, error: "This approval can only be allowed once." });
  });

  it("on a card that shows the row: its keys pass, a key it does not offer is refused (409)", () => {
    const card = approvalCardGrants({
      permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "rm -rf old", stopHit: DELETE,
      routineAllowCard: { routineId: "r1" }, verdict: { source: "stop-line" }, grantCard: { grantRequest: offer() }, automated: true,
    });
    const stopKey = card.grantRequest!.routine!.stopKeys[0]!.key;
    expect(routineSaveRefusal(card, "r1", [stopKey])).toBeUndefined();
    expect(routineSaveRefusal(card, "r1", ["stop:delete:/Users/alex"])?.status).toBe(409);
    // another routine's id never matches this card's row
    expect(routineSaveRefusal(card, "r2", [stopKey])?.status).toBe(400);
  });
});

function pendingGrants(): PendingGrants {
  const dir = mkdtempSync(join(tmpdir(), "murage-l1a-fix-"));
  return new PendingGrants(join(dir, "pending.json"), (path, json) => writeFileSync(path, json));
}

describe("A3: Undo removes only what the save added, by holder", () => {
  beforeEach(() => { removeTempDirSync(DATA_DIR); });

  it("the bot save reports additions by holder; Undo removes each from its own holder and nothing else", async () => {
    const store = new Store(selection);
    const created = store.createBot();
    const bot = { id: created.id, name: created.name, threadId: created.threadId };
    const other = store.createTask(bot.id, undefined, false)!;
    // the bot's defaults already hold Read (and so does the other task); this task does not
    store.patchBot(bot.id, { alwaysAllow: ["Read"] }, { preserveTaskSettings: true });
    store.patchTask(bot.id, other.threadId, { alwaysAllow: ["Read"] });
    store.patchTask(bot.id, bot.threadId, { alwaysAllow: [] });
    const card: GrantCard = { requestId: "r-1", ...approvalCardGrants({ permission: true, questionAsk: false, inputCut: false, tool: "Read", summary: "Read a.txt", routineAllowCard: {}, verdict: { source: "no-grant" } }) };
    expect(card.allowKey).toBe("Read");
    const choke: GrantChokeDeps = {
      cardOpen: () => true, holder: () => ({ kind: "engine", instanceId: "claude" }), inFlight: () => false,
      pending: pendingGrants(), attempt: () => {}, answer: vi.fn(async () => "allowed-once" as const), warn: () => {},
    };
    const deps: BotGrantDeps = {
      desktop: true, readBody: async () => ({ allowKey: "Read", threadId: bot.threadId, requestId: "r-1", answer: true }),
      botName: () => bot.name, isTask: (_bot, thread) => thread === bot.threadId || thread === other.threadId, roomHas: () => false,
      directThread: () => bot.threadId, pendingCard: () => card, routineName: () => undefined,
      remember: (input) => rememberAndAnswer(choke, input),
      plan: (id, task, keys) => store.planBotGrants(id, task, keys).added,
      write: (id, task, keys) => store.rememberBotGrants(id, task, keys),
      publish: (id) => ({ id }),
    };
    const saved = await botAlwaysAllowSave(deps, bot.id, {});
    expect(saved).toMatchObject({ status: 200, body: { saved: ["Read"], added: { bot: [], task: ["Read"] }, taskThreadId: bot.threadId } });

    let body: Record<string, unknown> = { threadId: bot.threadId, ...(saved.body.added as object) };
    const undoDeps: BotUndoDeps = {
      desktop: true, readBody: async () => body, botName: () => bot.name,
      isTask: (_bot, thread) => thread === bot.threadId || thread === other.threadId,
      remove: (id, task, keys) => store.removeBotGrants(id, task, keys), publish: (id) => ({ id }),
    };
    expect(await botAlwaysAllowUndo(undoDeps, bot.id)).toMatchObject({ status: 200, body: { removed: { bot: [], task: ["Read"] } } });
    // the bot's own Read and the other task's copy stay
    expect(store.bot(bot.id)?.alwaysAllow).toEqual(["Read"]);
    expect(store.taskByThread(bot.id, other.threadId)?.alwaysAllow).toEqual(["Read"]);
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow).toEqual([]);

    // the computer only, a task key needs its own thread, bad lists are refused
    expect(await botAlwaysAllowUndo({ ...undoDeps, desktop: false }, bot.id)).toEqual({ status: 404, body: { error: "no such route" } });
    body = { bot: [], task: ["Read"] };
    expect((await botAlwaysAllowUndo(undoDeps, bot.id)).status).toBe(404);
    body = { bot: "Read", task: [] };
    expect((await botAlwaysAllowUndo(undoDeps, bot.id)).status).toBe(400);
  });

  it("removeBotGrants takes bot keys from the defaults only and is one write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createTask(bot.id, undefined, false)!;
    store.patchBot(bot.id, { alwaysAllow: ["Grep", "Read"] }, { preserveTaskSettings: true });
    store.patchTask(bot.id, other.threadId, { alwaysAllow: ["Grep"] });
    expect(store.removeBotGrants(bot.id, undefined, { bot: ["Grep"], task: [] }).removed).toEqual({ bot: ["Grep"], task: [] });
    expect(store.bot(bot.id)?.alwaysAllow).toEqual(["Read"]);
    expect(store.taskByThread(bot.id, other.threadId)?.alwaysAllow).toEqual(["Grep"]);
    // a key the holder does not have is not reported as removed
    expect(store.removeBotGrants(bot.id, undefined, { bot: ["Grep"], task: [] }).removed).toEqual({ bot: [], task: [] });
  });
});

describe("A7: the task row is checked before delivery and its receipt is exact", () => {
  const stopCard = (extra: Partial<Parameters<typeof approvalCardGrants>[0]> = {}): GrantCard => approvalCardGrants({
    permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "rm -rf old", stopHit: DELETE,
    routineAllowCard: {}, verdict: { source: "stop-line" }, ...extra,
  });

  it("refuses a card whose fold shows no task row", () => {
    expect(taskGrantRefusal(stopCard())).toBeUndefined();
    // an unattended card offers no task row, and a card with no task key none either
    expect(taskGrantRefusal(stopCard({ unattended: true }))).toBe("This approval can only be allowed once.");
    expect(taskGrantRefusal({ allowKey: "Read" })).toBe("This approval can only be allowed once.");
    expect(taskGrantRefusal(undefined)).toBe("This approval can only be allowed once.");
    // a card an older build stored with a task key it would not offer now (F18)
    expect(taskGrantRefusal({ taskAllowKey: "stop:delete:/Users/alex/old" })).toBe("This approval can only be allowed once.");
  });

  it("grant says whether the allowance is new, so a second card's Undo never takes back the first", () => {
    const allowances = new TaskAllowances();
    expect(allowances.grant("b", "t", "stop:delete:/a")).toBe(true);
    expect(allowances.grant("b", "t", "stop:delete:/a")).toBe(false);
    expect(allowances.grant("b", "t2", "stop:delete:/a")).toBe(true);
    expect(allowances.keys("b", "t")).toEqual(["stop:delete:/a"]);
  });
});
