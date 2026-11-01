// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 tests 3 and 4 (gate tier) and test 8 (the phone
// surface, at module level): the bot "Always" save is the computer's only
// (404 before the body is read); a routine's card is refused on the bot route
// (409, scalar, exact and action set); a refused key never reaches delivery;
// an action set is saved whole and the reply names what was added; the task
// row's Undo takes back one allowance and leaves the rest; the routine route
// refuses a payment however it is sent; the routine card's live check is the
// exact run.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { approvalCardGrants } from "./approval-card-grants.ts";
import { grantRequestFor, routineDecisionKeys } from "./approval-grant-request.ts";
import { assertBotGrantAllowed, botAlwaysAllowSave, routineGrantRefusal, routineRunLive, taskAllowClear, taskAllowRemove, taskAllowanceWire, registerTaskAllowances, type BotGrantDeps, type GrantCard, type TaskAllowDeps } from "./approval-grant-routes.ts";
import { PendingGrants, rememberAndAnswer, type GrantChokeDeps } from "./grant-choke.ts";
import { isRoutineGrantKey } from "./routine-permissions.ts";
import { TaskAllowances } from "./stop-line-state.ts";
import type { StopHit } from "./stop-line.ts";
import { exactCommandKey } from "../shared/exact-command.ts";

const EXACT = exactCommandKey({ engine: "claude", cwd: "/Users/alex/site", command: "git push" })!;
const SET = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"];

function pendingGrants(): PendingGrants {
  const dir = mkdtempSync(join(tmpdir(), "murage-l1a-routes-"));
  return new PendingGrants(join(dir, "pending.json"), (path, json) => writeFileSync(path, json));
}

/** A bot route over one stored card, the choke point real, delivery stubbed. */
function botRoute(card: GrantCard, options: { desktop?: boolean; held?: string[] } = {}) {
  const answer = vi.fn(async () => "allowed-once" as const);
  const readBody = vi.fn(async () => body);
  let body: Record<string, unknown> = {};
  const held = [...(options.held ?? [])];
  const choke: GrantChokeDeps = {
    cardOpen: () => true, holder: () => ({ kind: "engine", instanceId: "claude" }), inFlight: () => false,
    pending: pendingGrants(), attempt: () => {}, answer, warn: () => {},
  };
  const deps: BotGrantDeps = {
    desktop: options.desktop ?? true,
    readBody,
    botName: (id) => (id === "bot-a" ? "Nova" : undefined),
    isTask: () => true,
    roomHas: () => false,
    directThread: () => "t-1",
    pendingCard: (_thread, requestId) => (requestId === "r-1" ? card : undefined),
    routineName: () => "Morning brief",
    remember: (input) => rememberAndAnswer(choke, input),
    plan: (_bot, _task, keys) => ({ bot: keys.filter((key) => !held.includes(key)), task: [] }),
    write: (_bot, _task, keys) => {
      const added = keys.filter((key) => !held.includes(key));
      held.push(...added);
      return { added: { bot: added, task: [] } };
    },
    publish: () => ({ id: "bot-a" }),
  };
  return { deps, answer, readBody, held, send: (next: Record<string, unknown>) => { body = next; return botAlwaysAllowSave(deps, "bot-a", {}); } };
}

const ownerCard = (extra: Partial<Parameters<typeof approvalCardGrants>[0]> = {}): GrantCard => ({
  requestId: "r-1",
  ...approvalCardGrants({ permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "git push", routineAllowCard: {}, verdict: { source: "no-grant" }, exactAllowKey: EXACT, ...extra }),
});

describe("test 3: POST /api/bots/:id/always-allow", () => {
  it("404 off the computer, before the body is read", async () => {
    const route = botRoute(ownerCard(), { desktop: false });
    expect(await route.send({ allowKey: "Bash:git", requestId: "r-1", answer: true })).toEqual({ status: 404, body: { error: "no such route" } });
    expect(route.readBody).not.toHaveBeenCalled();
    expect(route.answer).not.toHaveBeenCalled();
  });

  it("409 for a routine's card: the scalar key, the exact key and the action set", async () => {
    // a card an older build stored, still carrying bot-level keys beside its routine
    const legacy: GrantCard = { requestId: "r-1", allowKey: "Bash:git", exactAllowKey: EXACT, allowKeys: SET, routineId: "r1", routineAllowKey: EXACT };
    for (const sent of [{ allowKey: "Bash:git" }, { allowKey: EXACT }, { allowKeys: SET }]) {
      const route = botRoute(legacy);
      const reply = await route.send({ ...sent, requestId: "r-1", answer: true });
      expect(reply).toEqual({ status: 409, body: { error: "This approval belongs to the routine Morning brief. Choose Always, when it runs." } });
      expect(route.answer).not.toHaveBeenCalled();
    }
  });

  it("400 for a key the card's fold refuses, before delivery", async () => {
    // an old pay card with an always key; a guard card an older build gave a program key
    for (const card of [
      { requestId: "r-1", allowKey: "stop:pay:stripe:brightline", taskAllowKey: "stop:pay:stripe:brightline" },
      { requestId: "r-1", allowKey: "Bash:rm", cardClass: { reason: "destructive-guard" as const, unattended: false, automated: false, keys: ["allowKey" as const] } },
    ] satisfies GrantCard[]) {
      const route = botRoute(card);
      const reply = await route.send({ allowKey: card.allowKey, requestId: "r-1", answer: true });
      expect(reply.status).toBe(400);
      expect(route.answer).not.toHaveBeenCalled();
    }
  });

  it("refuses a key that is not on the card (409), a question key (400)", async () => {
    const route = botRoute(ownerCard());
    expect((await route.send({ allowKey: "Bash:curl", requestId: "r-1", answer: true })).status).toBe(409);
    expect(await route.send({ allowKey: "AskUserQuestion", requestId: "r-1", answer: true })).toEqual({ status: 400, body: { error: "questions cannot be always allowed" } });
    expect(route.answer).not.toHaveBeenCalled();
  });

  it("saves an action set whole and reports only what it added", async () => {
    const card = ownerCard({ tool: "mcp__murage_connectors__COMPOSIO_MULTI_EXECUTE_TOOL", summary: "x", exactAllowKey: undefined, grantCard: { allowKeys: SET } });
    expect(card.allowKeys).toEqual(SET);
    const route = botRoute(card, { held: [SET[0]!] });
    const reply = await route.send({ allowKeys: SET, requestId: "r-1", answer: true });
    expect(reply).toMatchObject({ status: 200, body: { saved: SET, added: { bot: [SET[1]], task: [] }, outcome: "allowed-once" } });
    expect(route.answer).toHaveBeenCalledTimes(1);
    expect(route.held).toEqual(SET);
    // one key of the set is not a row the card offers
    const partial = botRoute(card);
    expect((await partial.send({ allowKeys: [SET[0]], requestId: "r-1", answer: true })).status).toBe(409);
  });

  it("saves a program key and an exact key from an owner's card", async () => {
    for (const allowKey of ["Bash:git", EXACT]) {
      const route = botRoute(ownerCard());
      expect(await route.send({ allowKey, requestId: "r-1", answer: true })).toMatchObject({ status: 200, body: { saved: [allowKey], added: { bot: [allowKey], task: [] } } });
    }
  });

  it("names the bot when it stopped waiting (2.3.9)", async () => {
    const route = botRoute(ownerCard());
    route.answer.mockResolvedValueOnce("unavailable" as never);
    expect(await route.send({ allowKey: "Bash:git", requestId: "r-1", answer: true })).toEqual({ status: 409, body: { error: "Nova stopped waiting for this. Ask it again.", outcome: "unavailable" } });
    expect(route.held).toEqual([]);
  });
});

function taskRoute(options: { mayApprove?: boolean; owner?: boolean } = {}) {
  const allowances = new TaskAllowances();
  let body: Record<string, unknown> = {};
  const deps: TaskAllowDeps = {
    mayApprove: options.mayApprove ?? true,
    readBody: async () => body,
    botExists: (id) => id === "bot-a",
    botThread: (_bot, thread) => thread === "t-1" || thread === "t-2",
    ownerThread: () => options.owner ?? true,
    allowances,
  };
  return { allowances, deps, send: (next: Record<string, unknown>) => { body = next; return taskAllowRemove(deps, "bot-a"); } };
}

describe("test 3: POST /api/bots/:id/task-allow/remove and /clear", () => {
  it("takes back one allowance and leaves the rest", async () => {
    const route = taskRoute();
    route.allowances.grant("bot-a", "t-1", "stop:delete:/a");
    route.allowances.grant("bot-a", "t-1", "stop:public:github:o/r");
    route.allowances.grant("bot-a", "t-2", "stop:delete:/a");
    expect(await route.send({ threadId: "t-1", key: "stop:delete:/a" })).toEqual({ status: 200, body: { removed: true, taskAllowanceCount: 2 } });
    expect(route.allowances.keys("bot-a", "t-1")).toEqual(["stop:public:github:o/r"]);
    expect(route.allowances.keys("bot-a", "t-2")).toEqual(["stop:delete:/a"]);
    expect(await route.send({ threadId: "t-1", key: "stop:delete:/a" })).toMatchObject({ status: 200, body: { removed: false } });
  });

  it("refuses a browser pairing, another conversation, a missing field", async () => {
    expect((await taskRoute({ mayApprove: false }).send({ threadId: "t-1", key: "k" })).status).toBe(403);
    expect((await taskRoute({ owner: false }).send({ threadId: "t-1", key: "k" })).status).toBe(403);
    expect((await taskRoute().send({ threadId: "t-9", key: "k" })).status).toBe(404);
    expect((await taskRoute().send({ threadId: "t-1" })).status).toBe(400);
  });

  it("Clear takes back every allowance of the bot, and the wire count follows", async () => {
    const route = taskRoute();
    registerTaskAllowances(route.allowances);
    route.allowances.grant("bot-a", "t-1", "stop:delete:/a");
    route.allowances.grant("bot-a", "t-2", "stop:delete:/b");
    route.allowances.grant("bot-b", "t-3", "stop:delete:/c");
    expect(taskAllowanceWire("bot-a")).toEqual({ taskAllowanceCount: 2 });
    expect(await taskAllowClear(route.deps, "bot-a")).toEqual({ status: 200, body: { cleared: 2, taskAllowanceCount: 0 } });
    expect(taskAllowanceWire("bot-a")).toEqual({ taskAllowanceCount: 0 });
    expect(taskAllowanceWire("bot-b")).toEqual({ taskAllowanceCount: 1 });
  });
});

describe("test 4: the routine route never remembers a payment", () => {
  const pay = "stop:pay:stripe:brightline";
  it("refuses it as the legacy scalar, as a chosen stop key and inside the set", () => {
    expect(routineGrantRefusal(pay, undefined)).toBe("This approval can only be allowed once.");
    expect(routineGrantRefusal(undefined, [pay])).toBe("This approval can only be allowed once.");
    expect(routineGrantRefusal(undefined, ["stop:delete:/a"])).toBeUndefined();
    expect(isRoutineGrantKey(pay)).toBe(false);
    expect(routineDecisionKeys(undefined, pay, undefined)).toBe("This approval can only be allowed once.");
  });

  it("the card's offer lists the pay finding as not remembered and saves the rest", () => {
    const pay: StopHit = { kind: "pay", place: "stripe:brightline", what: "Pay" };
    const offer = grantRequestFor({ ask: { tool: "Bash", summary: "x" }, stopHit: pay, inputCut: false, routine: { routineId: "r1", routineName: "Bills" } })!.routine!;
    expect(offer).toMatchObject({ eligible: false, notRemembered: ["Paying asks on every run."] });
    expect(typeof routineDecisionKeys(offer, undefined, ["stop:pay:stripe:brightline"])).toBe("string");
  });

  it("the routine card's live check is the exact run that raised it", () => {
    let run: { runId: string; routineId: string } | null = { runId: "run-1", routineId: "r1" };
    const live = routineRunLive(() => run, "t-1", "r1");
    expect(live()).toBe(true);
    run = { runId: "run-2", routineId: "r1" };
    expect(live()).toBe(false);
    run = null;
    expect(live()).toBe(false);
    expect(routineRunLive(() => ({ runId: "run-1", routineId: "r2" }), "t-1", "r1")()).toBe(false);
  });
});

describe("test 8: the phone surface, at module level", () => {
  it("the bot route is the computer's; task Undo and Clear go from the paired app", async () => {
    expect((await botRoute(ownerCard(), { desktop: false }).send({})).status).toBe(404);
    const phone = taskRoute({ mayApprove: true });
    phone.allowances.grant("bot-a", "t-1", "stop:delete:/a");
    expect((await phone.send({ threadId: "t-1", key: "stop:delete:/a" })).status).toBe(200);
    expect((await taskRoute({ mayApprove: false }).send({ threadId: "t-1", key: "k" })).status).toBe(403);
  });

  it("assertBotGrantAllowed refuses a routine card and a pay key with a status", () => {
    expect(() => assertBotGrantAllowed({ routineId: "r1" }, ["Bash:git"], () => "Bills")).toThrow(/belongs to the routine Bills/);
    expect(() => assertBotGrantAllowed({ allowKey: "stop:pay:x:y" }, ["stop:pay:x:y"], () => undefined)).toThrow(/only be allowed once/);
  });
});
