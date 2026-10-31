// A run started by an event may hand off or create a few times on its own. At
// that limit the owner is asked instead of the bot hitting a dead end.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { admitEventWithOwner, decodeHandoffReceipt, eventActionId, runEventAction, type EventActionHandle, type EventActionSpec, type EventLimitContext } from "./event-limit.ts";
import { formatHandoff, type HandoffVia } from "./handoff-outcome.ts";
import { dismissStalePeerCards, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { closeMessageDb } from "./message-db.ts";
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";
import { EVENT_MAX_LIMIT, RoutineManager } from "./routines.ts";
import { coordinationRefusalText } from "./coordination-budget.ts";
import { Store, type BotRecord } from "./store.ts";
import { released } from "./testing/released.ts";
import type { BotName } from "./murage-status.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const roots: string[] = [];
const PLAIN = /—|budget|admission|cumulative|\bsafe|safety|unsafe|COORDINATION_/i;

describe("event run limits ask the owner", () => {
  let store: Store;
  let bus: ApprovalBus;
  let ops: BotRecord;
  let options: ConstructorParameters<typeof RoutineManager>[0];
  let manager: RoutineManager;
  let eventId: string;

  beforeEach(() => {
    store = new Store(selection);
    ops = store.patchBot(store.createBot().id, { name: "Ops" })!;
    bus = { store, broadcast: () => {} };
    const root = mkdtempSync(join(tmpdir(), "murage-event-limit-")); roots.push(root);
    options = { file: join(root, "routines.json"), botState: () => "busy" as const, createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
    manager = new RoutineManager(options);
    eventId = manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", botId: "bot", prompt: "Fixture", runOn: "ember", deliveryId: "delivery", receivedAt: 1 }).id;
  });
  afterEach(() => {
    closeMessageDb();
    removeTempDirSync(DATA_DIR);
    for (const root of roots.splice(0)) removeTempDirSync(root);
  });

  const ctx = (over: Partial<EventLimitContext> = {}): EventLimitContext => ({
    routines: manager, bus, eventId, kind: "handoff", admissionId: "x", from: ops, fromThreadId: ops.threadId, targetName: "Kessler",
    fullAccess: () => false, stillActive: () => {}, ...over,
  });
  const fill = (kind: "create" | "handoff", n: number) => { for (let i = 0; i < n; i++) expect(manager.admitEventAction(eventId, `${kind}-${i}`, kind)).toBe(true); };
  const openCard = () => store.messagesFor(ops.threadId).find(m => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
  const answer = (behavior: "allow" | "deny") => { const card = openCard()!; expect(resolvePeerComms(bus, card.card!.requestId!, behavior)).toBe(true); };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it("limit reached: the owner gets a card in plain words, Allow extends the run by four and the hand-off goes ahead", async () => {
    fill("handoff", 4);
    const waiting = admitEventWithOwner(ctx({ admissionId: "fifth" }));
    await flush();
    const card = openCard()!.card!;
    expect(card.title).toBe("@Ops wants to hand off more work");
    expect(card.subtitle).toBe("This run has handed off 4 tasks, the most it can without you. Next it wants to ask @Kessler. Allow lets this run hand off up to 4 more. Not now stops hand-offs for the rest of this run. Work already handed off carries on.");
    expect(card.options).toEqual(["Allow", "Not now"]);
    expect(card.allowKey).toBeUndefined();
    expect(card.tool).toBe("more_handoffs");
    expect(`${card.title} ${card.subtitle}`).not.toMatch(PLAIN);
    answer("allow");
    await waiting;
    expect(manager.getEventBudget(eventId)).toMatchObject({ version: 2, limits: { create: 4, handoff: 8 }, closed: false });
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "handoff")).toHaveLength(5);
    // the extension is durable
    const restarted = new RoutineManager(options);
    expect(restarted.getEventBudget(eventId)?.limits).toEqual({ create: 4, handoff: 8 });
    expect(restarted.admitEventAction(eventId, "sixth", "handoff")).toBe(true);
    // creates were not widened by a hand-off answer
    for (let i = 0; i < 4; i++) expect(restarted.admitEventAction(eventId, `create-${i}`, "create")).toBe(true);
    expect(restarted.admitEventAction(eventId, "fifth-create", "create")).toBe(false);
  });

  it("Not now: the bot gets a clear result and nothing is spent or widened", async () => {
    fill("handoff", 4);
    const waiting = admitEventWithOwner(ctx({ admissionId: "fifth" }));
    const settled = waiting.then(() => "went", (error: Error & { status?: number }) => error);
    await flush();
    answer("deny");
    const error = await settled as Error & { status?: number };
    expect(error.message).toBe("The owner said not now to more hand-offs in this run. Nothing more was handed off. Tell them, and finish what you can yourself.");
    expect(error.message).not.toMatch(PLAIN);
    expect(error.status).toBe(409);
    expect(manager.getEventBudget(eventId)).toMatchObject({ limits: { create: 4, handoff: 4 } });
    expect(manager.getEventBudget(eventId)!.admissions).toHaveLength(4);
    expect(store.messagesFor(ops.threadId).find(m => m.card?.tool === "more_handoffs")?.card?.answered).toBe("deny");
  });

  it("retries of one hand-off reuse one admission and never spend more", async () => {
    const a = eventActionId("handoff", ["handoff", "ops", "kessler", "Please pay invoice 7"]);
    expect(eventActionId("handoff", ["handoff", "ops", "kessler", "Please pay invoice 7"])).toBe(a);
    expect(eventActionId("handoff", ["handoff", "ops", "kessler", "Please pay invoice 8"])).not.toBe(a);
    for (let attempt = 0; attempt < 6; attempt++) await admitEventWithOwner(ctx({ admissionId: a }));
    expect(manager.getEventBudget(eventId)!.admissions).toEqual([{ id: a, kind: "handoff" }]);
    // even at the limit, a retry of an already-admitted hand-off needs no card
    fill("handoff", 3);
    await admitEventWithOwner(ctx({ admissionId: a }));
    expect(openCard()).toBeUndefined();
  });

  it("Full access starts higher: no card until the raised cap, then the owner is asked", async () => {
    fill("handoff", 4);
    await admitEventWithOwner(ctx({ admissionId: "fifth", fullAccess: () => true }));
    expect(openCard()).toBeUndefined();
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(16);
    for (let i = 5; i < 16; i++) await admitEventWithOwner(ctx({ admissionId: `h${i}`, fullAccess: () => true }));
    const waiting = admitEventWithOwner(ctx({ admissionId: "seventeenth", fullAccess: () => true }));
    await flush();
    expect(openCard()!.card!.subtitle).toMatch(/handed off 16 tasks, the most it can without you/);
    answer("allow");
    await waiting;
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(20);
  });

  it("create asks the same way, in its own words", async () => {
    fill("create", 4);
    const waiting = admitEventWithOwner(ctx({ kind: "create", admissionId: "new", targetName: "Scout" }));
    await flush();
    const card = openCard()!.card!;
    expect(card.title).toBe("@Ops wants to add more bots");
    expect(card.subtitle).toBe("This run has added 4 bots, the most it can without you. Next it wants to add @Scout. Allow lets this run add up to 4 more. Not now stops new bots for the rest of this run.");
    expect(card.tool).toBe("more_new_bots");
    answer("allow");
    await waiting;
    expect(manager.getEventBudget(eventId)!.limits).toEqual({ create: 8, handoff: 4 });
  });

  it("two hand-offs at the limit share one card and one extension", async () => {
    fill("handoff", 4);
    const first = admitEventWithOwner(ctx({ admissionId: "a" }));
    const second = admitEventWithOwner(ctx({ admissionId: "b", targetName: "Other" }));
    await flush();
    expect(store.messagesFor(ops.threadId).filter(m => m.card?.tool === "more_handoffs")).toHaveLength(1);
    answer("allow");
    await Promise.all([first, second]);
    expect(manager.getEventBudget(eventId)).toMatchObject({ limits: { handoff: 8 } });
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "handoff")).toHaveLength(6);
  });

  it("a revoked connection is still refused, with words the bot can relay, and asks nothing", async () => {
    fill("handoff", 4);
    manager.closeEventBudget(eventId);
    const error = await admitEventWithOwner(ctx({ admissionId: "late" })).then(() => null, (e: Error) => e);
    expect(error?.message).toBe("The connection that started this run was turned off, so I can't hand work on from it.");
    expect(openCard()).toBeUndefined();
    const created = await admitEventWithOwner(ctx({ kind: "create", admissionId: "c" })).then(() => null, (e: Error) => e);
    expect(created?.message).toBe("The connection that started this run was turned off, so I can't add bots from it.");
    // and an owner extension cannot reopen it
    expect(manager.extendEventBudget(eventId, "handoff")).toBeNull();
  });

  it("a stopped run says it was stopped", async () => {
    await manager.cancelRun(eventId);
    const error = await admitEventWithOwner(ctx()).then(() => null, (e: Error) => e);
    expect(error?.message).toBe("This run was stopped, so I can't hand work on from it.");
  });

  it("an older stored run (version 1) loads as version 2 with its counts kept", () => {
    fill("handoff", 3);
    const disk = readRoutinesWithRuns(options.file!);
    disk.runs[0].eventBudget = { version: 1, limits: { create: 4, handoff: 4 }, admissions: [{ id: "old", kind: "handoff" }], closed: false };
    writeFileSync(options.file!, JSON.stringify(disk));
    const loaded = new RoutineManager(options);
    expect(loaded.getEventBudget(eventId)).toEqual({ version: 2, limits: { create: 4, handoff: 4 }, admissions: [{ id: "old", kind: "handoff" }], closed: false });
    expect(loaded.extendEventBudget(eventId, "handoff")?.limits.handoff).toBe(8);
  });

  it("after a restart a card nobody can answer is settled, and the run keeps what it had", async () => {
    fill("handoff", 4);
    const stale = store.appendMessage(ops.threadId, { role: "bot", kind: "options", card: { title: "t", subtitle: "s", options: ["Allow", "Not now"], requestId: "gone", tool: "more_handoffs" } });
    expect(dismissStalePeerCards(bus)).toBe(1);
    expect(store.messagesFor(ops.threadId).find(m => m.id === stale.id)?.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(new RoutineManager(options).getEventBudget(eventId)).toMatchObject({ limits: { handoff: 4 } });
  });

  // Review round 1 findings

  it("an admission carries the receipt of what it produced, saved with the run, so asking again returns it", async () => {
    await admitEventWithOwner(ctx({ admissionId: "h1" }));
    expect(manager.eventAdmissionReceipt(eventId, "h1")).toBeUndefined();
    expect(manager.recordEventAdmissionReceipt(eventId, "h1", "delegation:abc")).toBe(true);
    expect(manager.recordEventAdmissionReceipt(eventId, "never-admitted", "delegation:x")).toBe(false);
    // a retry is free and still sees the first receipt, also after a restart
    await admitEventWithOwner(ctx({ admissionId: "h1" }));
    expect(manager.eventAdmissionReceipt(eventId, "h1")).toBe("delegation:abc");
    expect(new RoutineManager(options).eventAdmissionReceipt(eventId, "h1")).toBe("delegation:abc");
    expect(manager.getEventBudget(eventId)!.admissions).toHaveLength(1);
  });

  it("one Allow on a card the run's turn had already left extends the limit once, not again on resume", async () => {
    fill("handoff", 4);
    // the routine run holds the card open and its turn ends while it waits
    const held = { ...bus, routineCard: { opened: () => true, closed: () => true } } as ApprovalBus;
    const waiting = admitEventWithOwner(ctx({ admissionId: "fifth", bus: held }));
    await flush();
    answer("allow");
    await waiting;
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(8);
    // the resumed turn spends the rest of the extension: 6th to 8th go through with no card
    for (let i = 5; i < 8; i++) await admitEventWithOwner(ctx({ admissionId: `resumed-${i}`, bus: held }));
    expect(openCard()).toBeUndefined();
    // the ninth is a new ask and needs a new card; the earlier Allow is not remembered
    const ninth = admitEventWithOwner(ctx({ admissionId: "ninth", bus: held }));
    await flush();
    expect(openCard()).toBeDefined();
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(8);
    answer("deny");
    await ninth.catch(() => {});
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(8);
  });

  it("Not now is kept for the kind: asking again, for anyone, gets the plain answer at once with no new card", async () => {
    fill("handoff", 4);
    const first = admitEventWithOwner(ctx({ admissionId: "turn-1" })).catch((e: Error) => e);
    await flush();
    answer("deny");
    expect((await first as Error).message).toMatch(/said not now to more hand-offs/);
    const cardsBefore = store.messagesFor(ops.threadId).filter(m => m.card?.tool === "more_handoffs").length;
    // a later turn, and a different recipient: same answer, no card
    for (const [admissionId, targetName] of [["turn-2", "Kessler"], ["turn-3", "Other"]] as const) {
      const again = await admitEventWithOwner(ctx({ admissionId, targetName })).then(() => null, (e: Error & { status?: number }) => e);
      expect(again?.message).toBe("The owner said not now to more hand-offs in this run. Nothing more was handed off. Tell them, and finish what you can yourself.");
      expect(again?.status).toBe(409);
    }
    expect(store.messagesFor(ops.threadId).filter(m => m.card?.tool === "more_handoffs")).toHaveLength(cardsBefore);
    expect(openCard()).toBeUndefined();
    // it is saved with the run, and bots are a different kind
    expect(new RoutineManager(options).eventKindDeclined(eventId, "handoff")).toBe(true);
    expect(new RoutineManager(options).eventKindDeclined(eventId, "create")).toBe(false);
    expect(manager.getEventBudget(eventId)!.declined).toEqual(["handoff"]);
  });

  it("the same bot name in two sections is two creations, each counted", () => {
    const a = eventActionId("create", ["create", "sales", "scout"]);
    const b = eventActionId("create", ["create", "support", "scout"]);
    expect(a).not.toBe(b);
    expect(manager.admitEventAction(eventId, a, "create")).toBe(true);
    expect(manager.admitEventAction(eventId, b, "create")).toBe(true);
    expect(manager.getEventBudget(eventId)!.admissions).toHaveLength(2);
    expect(manager.recordEventAdmissionReceipt(eventId, a, "bot:one")).toBe(true);
    expect(manager.recordEventAdmissionReceipt(eventId, b, "bot:two")).toBe(true);
    expect(manager.eventAdmissionReceipt(eventId, b)).toBe("bot:two");
  });

  it("at the most a run can do there is no card: plain words for the bot and the owner", async () => {
    manager.raiseEventLimit(eventId, "handoff", EVENT_MAX_LIMIT);
    fill("handoff", EVENT_MAX_LIMIT);
    const error = await admitEventWithOwner(ctx({ admissionId: "one-more" })).then(() => null, (e: Error & { status?: number }) => e);
    expect(error?.message).toBe("This run has already handed off as many tasks as one run can. Tell the owner, and ask them to start a new run for the rest.");
    expect(error?.message).not.toMatch(PLAIN);
    expect(error?.status).toBe(409);
    expect(openCard()).toBeUndefined();
    manager.raiseEventLimit(eventId, "create", EVENT_MAX_LIMIT);
    fill("create", EVENT_MAX_LIMIT);
    const created = await admitEventWithOwner(ctx({ kind: "create", admissionId: "one-more-bot" })).then(() => null, (e: Error) => e);
    expect(created?.message).toBe("This run has already added as many bots as one run can. Tell the owner, and ask them to start a new run for the rest.");
    expect(openCard()).toBeUndefined();
  });

  it("hand-off allowance refusals reach the bot in plain words, never the internal code", () => {
    for (const code of ["COORDINATION_BUDGET_EXHAUSTED: this owner task has used its handoff allowance", "COORDINATION_DEPTH_LIMIT: x", "COORDINATION_CYCLE: x",
      "COORDINATION_ROOT_LIMIT: x", "COORDINATION_ALLOWANCE_UNAVAILABLE: start a new owner task", "COORDINATION_ANCESTRY_INVALID", "COORDINATION_OWNER_MISMATCH",
      "COORDINATION_CAPACITY: wait for a running handoff"]) {
      const text = coordinationRefusalText(new Error(code))!;
      expect(text).toBeTruthy();
      expect(text).not.toMatch(PLAIN);
    }
    expect(coordinationRefusalText(new Error("COORDINATION_CAPACITY: wait for a running handoff"))).toBe("Other hand-offs are still running, so this one can't start yet. Try again in a minute, or do it yourself.");
    // anything else is not rewritten
    expect(coordinationRefusalText(new Error("disk full"))).toBeUndefined();
  });

  it("the route boundary turns an allowance refusal into plain words once, with no scattered wrappers and no internal wording in any reply", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toContain("plainCoordinationRefusal");
    expect(source).not.toMatch(/automation budget/i);
    // the code only ever appears where the server throws it; the outer catch translates it for the reply
    for (const line of source.split("\n").filter(l => /["'`]COORDINATION_/.test(l))) expect(line).toMatch(/throw new Error\(/);
    expect(source).toMatch(/const plain = coordinationRefusalText\(e\);\n\s+if \(plain !== undefined\) return json\(res, 409, \{ error: plain \}\);/);
  });
});

// Review round 3: one ledger owns identity, counting and execution for every event hand-off and create.
describe("event run action ledger", () => {
  type Reply = { status: number; body: Record<string, unknown> };
  const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
  let store: Store;
  let bus: ApprovalBus;
  let ops: BotRecord;
  let options: ConstructorParameters<typeof RoutineManager>[0];
  let manager: RoutineManager;
  let eventId: string;

  beforeEach(() => {
    store = new Store(selection);
    ops = store.patchBot(store.createBot().id, { name: "Ops" })!;
    bus = { store, broadcast: () => {} };
    const root = mkdtempSync(join(tmpdir(), "murage-event-actions-")); roots.push(root);
    options = { file: join(root, "routines.json"), botState: () => "busy" as const, createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
    manager = new RoutineManager(options);
    eventId = manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", botId: "bot", prompt: "Fixture", runOn: "ember", deliveryId: "delivery", receivedAt: 1 }).id;
  });
  afterEach(() => {
    closeMessageDb();
    removeTempDirSync(DATA_DIR);
    for (const root of roots.splice(0)) removeTempDirSync(root);
  });

  const act = (over: Partial<EventActionSpec<Reply>>, step: (handle: EventActionHandle) => Promise<Reply>) => runEventAction<Reply>({
    routines: manager, bus, eventId, kind: "handoff", identity: ["handoff", "ops", "kessler", "pay invoice 7"], from: ops, fromThreadId: ops.threadId, targetName: "Kessler",
    fullAccess: () => false, stillActive: () => {}, revalidate: () => undefined, orphan: "next",
    replay: receipt => receipt.startsWith("delegation:") ? reply(200, { queued: true, taskId: receipt.slice("delegation:".length) }) : undefined, ...over,
  }, step);
  const fill = (kind: "create" | "handoff", n: number) => { for (let i = 0; i < n; i++) expect(manager.admitEventAction(eventId, `${kind}-fill-${i}`, kind)).toBe(true); };
  const cards = (tool = "more_handoffs") => store.messagesFor(ops.threadId).filter(m => m.card?.tool === tool);
  const openCard = () => store.messagesFor(ops.threadId).find(m => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
  const answer = (behavior: "allow" | "deny") => { expect(resolvePeerComms(bus, openCard()!.card!.requestId!, behavior)).toBe(true); };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const handoffs = () => manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "handoff").length;
  const delegating = (message: string, state = { tasks: 0 }) => ({
    state,
    run: () => act({ identity: ["handoff", "ops", "kessler", message] }, async ({ charge, record }) => {
      await charge(); state.tasks++; const taskId = `task-${state.tasks}`; record(`delegation:${taskId}`); return reply(200, { queued: true, taskId });
    }),
  });

  it("16 identical delegates, at once and one after another, make one task and one charge", async () => {
    const d = delegating("pay invoice 7");
    const together = await Promise.all(Array.from({ length: 16 }, () => d.run()));
    for (let i = 0; i < 16; i++) together.push(await d.run());
    expect(d.state.tasks).toBe(1);
    expect(new Set(together.map(r => r.body.taskId))).toEqual(new Set(["task-1"]));
    expect(handoffs()).toBe(1);
  });

  it("a late Allow moves the limit from 4 to 8 once, and the ninth action asks again", async () => {
    fill("handoff", 4);
    const held = { ...bus, routineCard: { opened: () => true, closed: () => true } } as ApprovalBus;
    const fifth = delegating("m5");
    const first = act({ bus: held, identity: ["handoff", "ops", "kessler", "m5"] }, async ({ charge, record }) => { await charge(); record("delegation:t5"); return reply(200, { taskId: "t5" }); });
    await flush();
    answer("allow");
    await first;
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(8);
    for (let i = 6; i <= 8; i++) await act({ bus: held, identity: ["handoff", "ops", "kessler", `m${i}`] }, async ({ charge, record }) => { await charge(); record(`delegation:t${i}`); return reply(200, {}); });
    expect(openCard()).toBeUndefined();
    const ninth = act({ bus: held, identity: ["handoff", "ops", "kessler", "m9"] }, async ({ charge }) => { await charge(); return reply(200, {}); }).catch((e: Error) => e);
    await flush();
    expect(openCard()).toBeDefined();
    expect(manager.getEventBudget(eventId)!.limits.handoff).toBe(8);
    answer("deny");
    await ninth;
    expect(fifth.state.tasks).toBe(0);
  });

  it("after Not now there is no new card for that kind, in this turn, in a later turn and after a reload", async () => {
    fill("handoff", 4);
    const asking = act({ identity: ["handoff", "ops", "kessler", "m5"] }, async ({ charge }) => { await charge(); return reply(200, {}); }).catch((e: Error & { status?: number }) => e);
    await flush();
    expect(openCard()!.card!.subtitle).toContain("Not now stops hand-offs for the rest of this run.");
    answer("deny");
    const refused = await asking as Error & { status?: number };
    expect(refused.message).toBe("The owner said not now to more hand-offs in this run. Nothing more was handed off. Tell them, and finish what you can yourself.");
    expect(refused.status).toBe(409);
    const reloaded = new RoutineManager(options);
    for (const [routines, target] of [[manager, "Kessler"], [manager, "Other"], [reloaded, "Third"]] as const) {
      const again = await act({ routines, targetName: target, identity: ["handoff", "ops", target.toLowerCase(), "something else"] }, async ({ charge }) => { await charge(); return reply(200, {}); }).catch((e: Error) => e);
      expect((again as Error).message).toMatch(/said not now to more hand-offs in this run/);
    }
    expect(cards()).toHaveLength(1);
    expect(openCard()).toBeUndefined();
  });

  it("the same bot name in two sections is two charged creations", async () => {
    for (const section of ["sales", "support"]) {
      await act({ kind: "create", identity: ["create", section, "scout"], targetName: "Scout", replay: () => undefined }, async ({ charge, record }) => { await charge(); record(`bot:${section}-scout`); return reply(201, {}); });
    }
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "create")).toHaveLength(2);
  });

  it("six identical synchronous asks dispatch once, charge once and return the same answer", async () => {
    const answers = new Map<string, string>();
    let dispatches = 0;
    const replay = (receipt: string) => {
      const text = answers.get(receipt.replace(/^answer:/, ""));
      return text === undefined ? undefined : reply(200, { text: `You already asked @Kessler this in this run. Their answer: ${text}` });
    };
    const ask = () => act({ replay }, async ({ charge, record }) => {
      await charge(); dispatches++; answers.set("thread:m1", "Paid"); record("answer:thread:m1"); return reply(200, { text: "Paid" });
    });
    const results = [await ask(), ...await Promise.all(Array.from({ length: 5 }, ask))];
    expect(dispatches).toBe(1);
    expect(handoffs()).toBe(1);
    expect(results[0].body.text).toBe("Paid");
    for (const again of results.slice(1)) expect(again.body.text).toBe("You already asked @Kessler this in this run. Their answer: Paid");
    // an ask that timed out into a task returns that same task every time
    const slow = (message: string) => act({ identity: ["handoff", "ops", "kessler", message], replay: receipt => receipt.startsWith("timeout:") ? reply(200, { timeout: true, taskId: receipt.slice("timeout:".length) }) : undefined }, async ({ charge, record }) => { await charge(); dispatches++; record("timeout:slow-1"); return reply(200, { timeout: true, taskId: "slow-1" }); });
    const timed = [await slow("long"), await slow("long"), await slow("long")];
    expect(dispatches).toBe(2);
    expect(new Set(timed.map(r => r.body.taskId))).toEqual(new Set(["slow-1"]));
    expect(timed.every(r => r.body.timeout === true)).toBe(true);
  });

  describe("one outcome for a hand-off asked both ways at once (review round 4 #5)", () => {
    const present = (via: HandoffVia) => (receipt: string, joined: boolean): Reply | undefined => {
      const outcome = decodeHandoffReceipt(receipt);
      return outcome ? formatHandoff(outcome, via, { targetName: "Kessler" as BotName, resolvable: () => true, answerText: () => released("Paid") }, joined) as Reply | undefined : undefined;
    };
    const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; };
    const route = (via: HandoffVia, message: string, step: (handle: EventActionHandle) => Promise<Reply>) =>
      act({ identity: ["handoff", "ops", "kessler", message], replay: present(via) }, step);

    it.each([["ask", "delegate"], ["delegate", "ask"]] as const)("%s then %s at the same time: one execution, one charge, each caller its own route's shape", async (first, second) => {
      for (const outcome of ["answer", "queued"] as const) {
        const message = `${first}-${second}-${outcome}`;
        const held = gate();
        let runs = 0;
        const before = handoffs();
        const one = route(first, message, async ({ charge, record }) => {
          await charge(); runs++; await held.wait;
          record(outcome === "answer" ? "answer:channel:m1:req-1" : "delegation:task-9");
          return outcome === "answer" ? reply(200, { botName: "Kessler", text: "Paid" }) : reply(200, { queued: true, taskId: "task-9" });
        });
        await flush();
        const two = route(second, message, async ({ charge }) => { await charge(); runs++; return reply(200, { error: "must not run" }); });
        await flush();
        held.open();
        const [a, b] = await Promise.all([one, two]);
        expect(runs, message).toBe(1);
        expect(handoffs() - before, message).toBe(1);
        expect(a.status).toBe(200);
        // the joiner speaks its own route's shape, exactly as a call made later would
        const later = await route(second, message, async () => reply(200, { error: "must not run" }));
        expect(b, message).toEqual(later);
        if (outcome === "answer") {
          expect(b.body).toEqual(second === "ask" ? { botName: "Kessler", text: "You already asked @Kessler this in this run. Their answer: Paid" } : { message: "You already asked @Kessler this in this run. Their answer: Paid" });
        } else {
          expect(b.body).toEqual(second === "ask" ? { busy: true, taskId: "task-9", toBotName: "Kessler", note: "already asked in this run; the answer comes back to you" }
            : { queued: true, taskId: "task-9", message: "Already handed to @Kessler in this run: their result comes back to you." });
        }
        expect(b.body).not.toHaveProperty("error");
      }
    });

    it("a joiner after an ended first gets the ended outcome in its own shape, with no second charge", async () => {
      for (const second of ["ask", "delegate"] as const) {
        const message = `ended-${second}`;
        const held = gate();
        const before = handoffs();
        let ranSecond = false;
        const one = route("ask", message, async ({ charge }) => { await charge(); await held.wait; throw new Error("provider failed"); }).catch((e: Error) => e);
        await flush();
        const two = route(second, message, async ({ charge }) => { ranSecond = true; await charge(); return reply(200, {}); });
        await flush();
        held.open();
        expect(((await one) as Error).message).toBe("provider failed");
        const joined = await two;
        expect(ranSecond).toBe(false);
        expect(handoffs() - before).toBe(1);
        const line = "This was already handed to @Kessler in this run, and it ended: it could not start.";
        expect(joined.body).toEqual(second === "ask" ? { botName: "Kessler", text: line } : { message: line });
        expect(JSON.stringify(joined.body)).not.toMatch(PLAIN);
      }
    });

    it("a first that was refused and given its charge back leaves the joiner to run its own attempt", async () => {
      const held = gate();
      let secondRuns = 0;
      const before = handoffs();
      // refused after the charge (the bot left the roster while the owner's card was open): the charge is given back and nothing is recorded
      const first = act({ identity: ["handoff", "ops", "kessler", "refused"], revalidate: async () => { await held.wait; return reply(409, { error: "no longer on your roster" }); } }, async ({ charge }) => { await charge(); return reply(200, {}); });
      await flush();
      const joiner = route("delegate", "refused", async ({ charge, record }) => { secondRuns++; await charge(); record("delegation:own-1"); return reply(200, { queued: true, taskId: "own-1" }); });
      await flush();
      held.open();
      expect((await first).status).toBe(409);
      expect((await joiner).body.taskId).toBe("own-1");
      expect(secondRuns).toBe(1);
      expect(handoffs() - before).toBe(1);
    });
  });

  it("an answer that can no longer be read counts as ended: asking again is a new, charged attempt", async () => {
    let dispatches = 0;
    const ask = () => act({ replay: () => undefined }, async ({ charge, record }) => { await charge(); dispatches++; record(`answer:thread:m${dispatches}`); return reply(200, { n: dispatches }); });
    await ask();
    const second = await ask();
    expect(second.body.n).toBe(2);
    expect(handoffs()).toBe(2);
  });

  it("four concurrent identical creates while the card waits make one bot, one charge and three replays", async () => {
    fill("create", 4);
    const bots: string[] = [];
    let cap = 10;
    const revalidate = (name: string) => () => bots.length >= cap ? reply(409, { error: "limit" }) : bots.includes(name) ? reply(409, { error: "exists" }) : undefined;
    const create = (name: string) => act({ kind: "create", identity: ["create", "sales", name], targetName: name, revalidate: revalidate(name),
      replay: receipt => receipt === `bot:${name}` && bots.includes(name) ? reply(201, { name, replayed: true }) : undefined, orphan: "reuse" }, async ({ charge, record }) => {
      await charge(); bots.push(name); record(`bot:${name}`); return reply(201, { name });
    });
    const four = Promise.all([create("scout"), create("scout"), create("scout"), create("scout")]);
    await flush();
    expect(cards("more_new_bots")).toHaveLength(1);
    answer("allow");
    const results = await four;
    expect(bots).toEqual(["scout"]);
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "create")).toHaveLength(5);
    expect(results.map(r => r.status)).toEqual([201, 201, 201, 201]);
    // a different name after the extension is checked again against the workspace and is not charged when refused
    for (let i = 0; i < 3; i++) expect(manager.admitEventAction(eventId, `create-more-${i}`, "create")).toBe(true);
    cap = bots.length;
    const other = create("other");
    await flush();
    answer("allow");
    expect((await other).body.error).toBe("limit");
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "create")).toHaveLength(8);
    expect(manager.eventAdmissionExists(eventId, eventActionId("create", ["create", "sales", "other"]))).toBe(false);
  });

  it("a Not now that arrives after the turn ended is still saved, and the resumed turn is not asked again", async () => {
    fill("handoff", 4);
    let ended = false;
    const late = act({ identity: ["handoff", "ops", "kessler", "m5"], stillActive: () => { if (ended) throw new Error("turn ended"); } }, async ({ charge }) => { await charge(); return reply(200, {}); }).catch((e: Error) => e);
    await flush();
    ended = true;
    answer("deny");
    expect(((await late) as Error).message).toBe("turn ended");
    expect(manager.eventKindDeclined(eventId, "handoff")).toBe(true);
    const resumed = await act({ identity: ["handoff", "ops", "kessler", "m5"] }, async ({ charge }) => { await charge(); return reply(200, {}); }).catch((e: Error) => e);
    expect((resumed as Error).message).toMatch(/said not now/);
    expect(cards()).toHaveLength(1);
  });

  it("a receipt is found after a reload with nothing about the turn in its identity", async () => {
    const first = delegating("pay invoice 7");
    expect((await first.run()).body.taskId).toBe("task-1");
    const reloaded = new RoutineManager(options);
    let ran = false;
    const again = await act({ routines: reloaded }, async ({ charge }) => { ran = true; await charge(); return reply(200, {}); });
    expect(again.body.taskId).toBe("task-1");
    expect(ran).toBe(false);
  });

  it("the allowance refusing during the approval wait is plain words, and nothing is charged for it", async () => {
    const error = await act({}, async ({ charge, unrun }) => {
      await charge();
      unrun();
      throw new Error("COORDINATION_CAPACITY: wait for a running handoff");
    }).then(() => null, (e: Error) => e);
    expect(coordinationRefusalText(error)).toBe("Other hand-offs are still running, so this one can't start yet. Try again in a minute, or do it yourself.");
    expect(handoffs()).toBe(0);
    const retry = delegating("pay invoice 7");
    expect((await retry.run()).body.taskId).toBe("task-1");
    expect(handoffs()).toBe(1);
  });

  it("a revalidation refusal after the owner's OK gives the charge back", async () => {
    const refused = await act({ revalidate: () => reply(404, { error: "no such bot" }) }, async ({ charge }) => { await charge(); return reply(200, { shouldNotRun: true }); });
    expect(refused.status).toBe(404);
    expect(handoffs()).toBe(0);
  });

  it("an action that ended without an answer can be tried again, as a new charged attempt", async () => {
    let runs = 0;
    const attempt = (status: "failed" | "ok") => act({}, async ({ charge, record }) => {
      await charge(); runs++;
      if (status === "failed") { record("ended:failed"); return reply(200, { failed: true }); }
      record("delegation:task-b"); return reply(200, { taskId: "task-b" });
    });
    expect((await attempt("failed")).body.failed).toBe(true);
    expect((await attempt("ok")).body.taskId).toBe("task-b");
    expect(handoffs()).toBe(2);
    expect((await attempt("ok")).body.taskId).toBe("task-b");
    expect(runs).toBe(2);
  });

  it("after a crash between the charge and the receipt a create keeps its charge, a hand-off asks again as a new attempt", async () => {
    const createId = eventActionId("create", ["create", "sales", "scout"]);
    manager.admitEventAction(eventId, createId, "create");
    const kept = await act({ kind: "create", identity: ["create", "sales", "scout"], orphan: "reuse", replay: () => undefined }, async ({ charge, record }) => { await charge(); record("bot:b1"); return reply(201, {}); });
    expect(kept.status).toBe(201);
    expect(manager.getEventBudget(eventId)!.admissions.filter(a => a.kind === "create")).toHaveLength(1);
    const handoffId = eventActionId("handoff", ["handoff", "ops", "kessler", "pay invoice 7"]);
    manager.admitEventAction(eventId, handoffId, "handoff");
    const again = await act({}, async ({ charge, record }) => { await charge(); record("delegation:task-z"); return reply(200, { taskId: "task-z" }); });
    expect(again.body.taskId).toBe("task-z");
    expect(handoffs()).toBe(2);
  });

  // Review round 4 #2: a refund can leave capacity under the limit, but a Not now still stops every new action of that kind.
  it("after Not now, capacity freed by refunds never lets a new action through", async () => {
    fill("handoff", 4);
    let ran = 0;
    const waiter = (message: string, targetStillThere: boolean) => act({ identity: ["handoff", "ops", "kessler", message], revalidate: () => targetStillThere ? undefined : reply(404, { error: "no such bot" }) },
      async ({ charge, record }) => { await charge(); ran++; record(`delegation:${message}`); return reply(200, { taskId: message }); });
    // five distinct hand-offs wait on one card; their target disappears while it waits
    const gone = ["m1", "m2", "m3", "m4"].map(message => waiter(message, false));
    const fifth = waiter("m5", true).then(() => "ran" as const, (error: Error & { status?: number }) => error);
    await flush();
    answer("allow");
    // Allow raises the limit to 8; the four charge and give their charges back, while the fifth meets the full limit and opens another card
    await flush();
    answer("deny");
    expect((await Promise.all(gone)).map(item => item.status)).toEqual([404, 404, 404, 404]);
    expect(await fifth).toMatchObject({ status: 409 });
    expect(manager.getEventBudget(eventId)).toMatchObject({ limits: { handoff: 8 }, declined: ["handoff"] });
    expect(handoffs()).toBe(4);
    // room under the limit, but the owner said not now: a new hand-off to someone else is refused, with nothing charged and nothing run
    const later = await waiter("m6", true).then(() => "ran" as const, (error: Error & { status?: number }) => error);
    expect(later).toMatchObject({ status: 409, message: expect.stringMatching(/said not now to more hand-offs/) });
    expect(ran).toBe(0);
    expect(handoffs()).toBe(4);
    expect(cards()).toHaveLength(2);
  });

  // Review round 4 #7
  it("a timeout receipt whose task is gone becomes interrupted at boot, so the next identical ask is a new, charged attempt", async () => {
    const id = eventActionId("handoff", ["handoff", "ops", "kessler", "pay invoice 7"]);
    manager.admitEventAction(eventId, id, "handoff");
    manager.recordEventAdmissionReceipt(eventId, id, "timeout:dead-task");
    manager.admitEventAction(eventId, "live", "handoff");
    manager.recordEventAdmissionReceipt(eventId, "live", "timeout:live-task");
    expect(manager.interruptUnresolvedEventTimeouts(taskId => taskId === "live-task")).toBe(1);
    expect(manager.eventAdmissionReceipt(eventId, id)).toBe("ended:interrupted");
    expect(manager.eventAdmissionReceipt(eventId, "live")).toBe("timeout:live-task");
    expect(new RoutineManager(options).eventAdmissionReceipt(eventId, id)).toBe("ended:interrupted");
    const again = await act({}, async ({ charge, record }) => { await charge(); record("delegation:fresh"); return reply(200, { taskId: "fresh" }); });
    expect(again.body.taskId).toBe("fresh");
    expect(handoffs()).toBe(3);
  });
});

