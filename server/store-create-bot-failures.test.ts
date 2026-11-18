// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fault = vi.hoisted(() => ({ step: "", hit: false, restore: false, restoreOnce: false }));
vi.mock("./atomic.ts", async original => {
  const atomic = await original<typeof import("./atomic.ts")>();
  return { ...atomic, writeFileAtomic: (...args: Parameters<typeof atomic.writeFileAtomic>) => {
    if (basename(String(args[0])) !== "bots.json") return atomic.writeFileAtomic(...args);
    if (!fault.step) {
      if (fault.restore) { if (fault.restoreOnce) fault.restore = false; throw new Error("injected:restore"); }
      return atomic.writeFileAtomic(...args);
    }
    const step = fault.step;
    fault.step = ""; fault.hit = true;
    const fail = () => { throw new Error(`injected:${step}`); };
    if (step === "after-rename") { atomic.writeFileAtomic(...args); fail(); }
    atomic.writeFileAtomic(args[0], args[1], { ...args[2],
      ...(step === "rename" ? { rename: fail } : {}),
      ops: { ...(step === "open" ? { open: fail } : {}), ...(step === "write" ? { write: fail } : {}), ...(step === "fsync" ? { fsync: fail } : {}) },
    });
  } };
});

vi.resetModules();
const { DATA_DIR } = await import("./config.ts");
const { closeDatabase, database, transaction } = await import("./database.ts");
const { flushCoalesced } = await import("./atomic.ts");
const { BotOutsideWrites } = await import("./bot-outside-writes.ts");
const { botReviewNotice } = await import("./bot-review-notices.ts");
const { readBotRecords } = await import("./bot-turn-state.ts");
const { Store } = await import("./store.ts");
const { afterCommit } = await import("./tx-scope.ts");
const { murageLine } = await import("./murage-line.ts");
const { RoutineManager } = await import("./routines.ts");
const { RoutineRunsJournal } = await import("./routine-runs-journal.ts");
const { eventActionId, runEventAction } = await import("./event-limit.ts");

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { fault.step = ""; fault.restore = false; fault.restoreOnce = false; vi.restoreAllMocks(); flushCoalesced(); });
const selection = () => ({ instanceId: "fixture", model: "model" });
const bytes = () => existsSync(join(DATA_DIR, "bots.json")) ? readFileSync(join(DATA_DIR, "bots.json")) : null;
const staging = () => ({ rev: 1, at: 1, generation: "fixture-generation", byThreadId: "fixture-thread", byBotId: "fixture-bot", reason: "outside" as const,
  intended: { autoApprove: false, fullAccess: false, noLimits: false, lead: false }, heldWork: [] });

for (const step of ["open", "write", "fsync", "rename", "after-rename", "commit"]) for (const fresh of [false, true]) {
  it(`failed ${fresh ? "first" : "subsequent"} create at ${step} restores exact bytes and leaves no partial file`, () => {
    const store = new Store(selection);
    if (!fresh) store.createBot({ name: "Existing" });
    const before = bytes(), ids = store.bots.map(b => b.id), changes: StoreChange[] = [];
    store.onChange(e => changes.push(e));
    if (step === "commit") {
      const db = database(), exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("injected:commit"); return exec(sql); });
    } else { fault.step = step; fault.hit = false; }
    expect(() => store.createBot({ name: "Rejected" })).toThrow(`injected:${step}`);
    vi.restoreAllMocks();
    if (step !== "commit") expect(fault.hit).toBe(true);
    expect(store.bots.map(b => b.id)).toEqual(ids);
    expect(bytes()).toEqual(before);
    flushCoalesced();
    expect(bytes()).toEqual(before);
    expect(changes).toEqual([]);
    expect(readdirSync(DATA_DIR).filter(name => name.endsWith(".tmp") || name.startsWith(".bot-create-"))).toEqual([]);
    expect(new Store(selection).bots.map(b => b.id)).toEqual(ids);
    const retry = store.createBot({ name: "Rejected" });
    expect(store.bots.filter(b => b.name === "Rejected").map(b => b.id)).toEqual([retry.id]);
  });
}

it("a refused staged review notice rolls back the bot, roster bytes, messages and memory bindings", () => {
  const store = new Store(selection), existing = store.createBot({ name: "Existing" });
  const writes = new BotOutsideWrites(store, () => null, { reviewNeeded: bot => { expect(botReviewNotice(store, bot)?.card?.botReviewId).toBe(bot.id); throw new Error("injected:review"); } });
  const before = bytes(), rows = database().prepare("SELECT * FROM memory_scope_bindings ORDER BY id").all();
  const changes: StoreChange[] = []; store.onChange(e => changes.push(e));
  expect(() => store.createBot({ name: "Rejected" }, { staged: staging(), seedMessages: false, beforeCreate: id => writes.record(id) })).toThrow();
  expect(store.bots.map(b => b.id)).toEqual([existing.id]);
  expect(bytes()).toEqual(before);
  expect(database().prepare("SELECT * FROM memory_scope_bindings ORDER BY id").all()).toEqual(rows);
  expect(changes).toEqual([]);
  expect(new Store(selection).bots.map(b => b.id)).toEqual([existing.id]);
});

it("a staged review notification waits for the outer commit and never escapes a rolled-back create", () => {
  const store = new Store(selection), events: string[] = [];
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const hook = source.split("\n").find(line => line.trimStart().startsWith("reviewNeeded: bot =>"));
  expect(hook).toBeDefined();
  const expression = hook!.trim().replace(/^reviewNeeded: /, "").replace(/,$/, "").replace("row.card!.", "row.card.");
  const values = { store, afterCommit, botReviewNotice: () => ({ id: "fixture-message", card: { requestId: "fixture-review" } }),
    announceInboxChanged: () => events.push("inbox"), notify: () => events.push("notify"), buildNotification: () => ({}) };
  const reviewNeeded = new Function(...Object.keys(values), `return (${expression});`)(...Object.values(values));
  const writes = new BotOutsideWrites(store, () => null, { reviewNeeded });
  const create = () => store.createBot({ name: "Reviewed" }, { staged: staging(), seedMessages: false, beforeCreate: id => writes.record(id) });
  expect(() => transaction(() => { create(); throw new Error("outer failure"); })).toThrow("outer failure");
  expect(events).toEqual([]);
  transaction(() => { create(); expect(events).toEqual([]); });
  expect(events).toEqual(["inbox", "notify"]);
});

it("the staged bot mapping is announced before a message written by its create callback", () => {
  const store = new Store(selection), changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  const bot = store.createBot({ name: "Reviewed" }, { staged: staging(), seedMessages: false, beforeCreate: id => {
    store.appendMessage(store.bot(id)!.threadId, murageLine({ role: "bot", kind: "text", text: "Fixture notice" }));
  } });
  const owner = changes.findIndex(change => change.type === "bot" && change.botId === bot.id);
  const message = changes.findIndex(change => change.type === "message" && change.threadId === bot.threadId);
  expect(owner).toBeGreaterThanOrEqual(0);
  expect(message).toBeGreaterThan(owner);
});

it("rolling back a create preserves generation-bound task deltas and later live writes", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Existing" });
  store.addTaskUsage(bot.id, bot.threadId, { input: 17, costUsd: 0.2 }, "fixture-turn");
  const before = bytes(), held = readBotRecords(DATA_DIR);
  expect(() => transaction(() => { store.createBot({ name: "Rejected" }); throw new Error("outer failure"); })).toThrow("outer failure");
  expect(bytes()).toEqual(before);
  expect(readBotRecords(DATA_DIR)).toEqual(held);
  store.addTaskUsage(bot.id, bot.threadId, { input: 3, costUsd: 0.1 }, "fixture-next");
  expect(readBotRecords(DATA_DIR)[0]?.tasks?.[0]?.usage?.input).toBe(20);
});

it("failed creation keeps a pre-existing deferred cursor clear pending", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Existing" }, { seedMessages: false });
  store.setResumeCursor(bot.id, "fixture", "prior", bot.threadId);
  store.checkpointTurnState();
  const before = bytes();
  expect(store.clearResumeCursors([{ botId: bot.id, instanceId: "fixture", threadId: bot.threadId, cursor: "prior", incarnation: undefined }]).cleared).toBe(1);
  expect(bytes()).toEqual(before);
  expect(() => store.createBot({ name: "Rejected" }, { staged: staging(), seedMessages: false, beforeCreate: () => { throw new Error("injected:callback"); } })).toThrow("injected:callback");
  expect(bytes()).toEqual(before);
  flushCoalesced();
  expect(readBotRecords(DATA_DIR)[0]?.tasks?.[0]?.resumeCursors.fixture).toBeUndefined();
  expect(store.bots.map(b => b.id)).toEqual([bot.id]);
});

it("an inner rollback preserves the earlier create and its exact file until the outer commit", () => {
  const store = new Store(selection); store.createBot({ name: "Existing" });
  transaction(() => {
    store.createBot({ name: "Kept" }); const before = bytes();
    expect(() => transaction(() => { store.createBot({ name: "Rejected" }); throw new Error("inner failure"); })).toThrow("inner failure");
    expect(bytes()).toEqual(before);
  });
  expect(new Store(selection).bots.map(b => b.name)).toEqual(["Kept", "Existing"]);
});

it("checkpoint cleanup retains a task delta written under the new generation before commit", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Existing" });
  transaction(() => {
    store.createBot({ name: "New" });
    store.patchTask(bot.id, bot.threadId, { title: "Kept title" });
  });
  expect(readBotRecords(DATA_DIR).find(b => b.id === bot.id)?.tasks?.[0]?.title).toBe("Kept title");
});

it("a failed compensation retains its journal and fences writes until recovery succeeds", () => {
  new Store(selection).createBot({ name: "Existing" });
  const store = new Store(selection), before = bytes();
  fault.step = "after-rename"; fault.restore = true;
  expect(() => store.createBot({ name: "Rejected" })).toThrow("injected:after-rename");
  expect(readdirSync(DATA_DIR).filter(name => name.startsWith(".bot-create-"))).toHaveLength(1);
  fault.restore = false;
  expect(() => store.createBot({ name: "Too soon" })).toThrow("BOT_CREATE_RECOVERY_REQUIRED");
  expect(new Store(selection).bots.map(b => b.name)).toEqual(["Existing"]);
  expect(bytes()).toEqual(before);
  expect(store.createBot({ name: "Retried" }).name).toBe("Retried");
});

it("failed inner compensation keeps the older undo journal needed to recover both creates", () => {
  new Store(selection).createBot({ name: "Existing" });
  const store = new Store(selection), before = bytes();
  expect(() => transaction(() => {
    store.createBot({ name: "First rejected" });
    fault.step = "after-rename"; fault.restore = true; fault.restoreOnce = true;
    store.createBot({ name: "Second rejected" });
  })).toThrow("injected:after-rename");
  expect(readdirSync(DATA_DIR).filter(name => name.startsWith(".bot-create-"))).toHaveLength(2);
  fault.restore = false;
  expect(new Store(selection).bots.map(b => b.name)).toEqual(["Existing"]);
  expect(bytes()).toEqual(before);
});

it("malformed recovery journals refuse startup before changing the roster", () => {
  const store = new Store(selection); store.createBot({ name: "Existing" }); const before = bytes();
  const id = "11111111-1111-4111-8111-111111111111", path = join(DATA_DIR, `.bot-create-${id}.json`);
  const valid = { version: 1, id, order: 1, files: { "bots.json": before!.toString("base64"), "groups.json": null } };
  for (const invalid of [{ ...valid, version: 2 }, { ...valid, files: { ...valid.files, "../other": "" } },
    { ...valid, files: { ...valid.files, "bots.json": "invalid bytes" } }, { ...valid, id: "22222222-2222-4222-8222-222222222222" },
    { ...valid, run: { id: "", routineId: "fixture" } }, { ...valid, run: { id: "fixture", routineId: "fixture", $del: "fixture" } },
    { ...valid, run: [] }]) {
    writeFileSync(path, JSON.stringify(invalid));
    expect(() => new Store(selection)).toThrow();
    expect(bytes()).toEqual(before);
    unlinkSync(path);
  }
});

it("both staged create routes register their review before createBot commits", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const creates = [...source.matchAll(/const created = store\.createBot\([\s\S]*?\n        \);/g)].map(m => m[0]).filter(s => s.includes("staged: staged"));
  expect(creates).toHaveLength(2);
  for (const create of creates) expect(create.slice(create.indexOf("beforeCreate:"))).toContain("botOutsideWrites.record(");
});

it("each route's actual synchronous staged-create block leaves no bot when review recording refuses", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const blocks = [...source.matchAll(/const created = store\.createBot\([\s\S]*?\/\/ The new seat keeps/g)].map(m => m[0].replace("// The new seat keeps", ""));
  expect(blocks).toHaveLength(2);
  for (const block of blocks) {
    const store = new Store(selection), existing = store.createBot({ name: "Existing" });
    const before = bytes(), changes: StoreChange[] = []; store.onChange(e => changes.push(e));
    const writes = new BotOutsideWrites(store, () => null, { reviewNeeded: bot => { expect(botReviewNotice(store, bot)?.card?.botReviewId).toBe(bot.id); throw new Error("injected:review"); } });
    const values = { store, name: "Rejected", role: "Helper", instructions: "Fixture", modelSelection: undefined,
      targetSection: "Studio", staged: staging(), chief: existing, createdByLead: true, internalClaim: { threadId: existing.threadId },
      ownCreatedBot: () => {}, before: () => {}, ownWriteCommit: () => true, createSlot: { commit: () => {} },
      // A real writer lets this witness detect review moved after commit; receipt I/O faults have the real-manager cases below.
      record: (receipt: string) => writeFileSync(join(DATA_DIR, "fixture-create-receipt"), receipt, { mode: 0o600 }),
      botOutsideWrites: writes, eventReply: (status: number, body: unknown) => ({ status, body }), createdBody: (bot: unknown) => bot };
    // Execute the route's source, including its callback and post-create work, against the real Store and review refusal.
    expect(() => new Function(...Object.keys(values), block)(...Object.values(values))).toThrow();
    expect(store.bots.map(b => b.id)).toEqual([existing.id]);
    expect(bytes()).toEqual(before);
    expect(changes).toEqual([]);
    expect(existsSync(join(DATA_DIR, "fixture-create-receipt"))).toBe(false);
    store.deleteBot(existing.id);
  }
});

for (const phase of ["before-append", "after-append", "missing-admission", "commit", "outer-rollback", "commit-refund-failure", "success"]) {
  it(`event-triggered staged create keeps bot, notice and receipt atomic at ${phase}`, async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const blocks = [...source.matchAll(/const created = store\.createBot\([\s\S]*?\/\/ The new seat keeps/g)].map(m => m[0].replace("// The new seat keeps", ""));
    expect(blocks).toHaveLength(2);
    const block = blocks[1]!; // The internal route uses runEventAction; the owner-held route has no event receipt.
    const store = new Store(selection), existing = store.createBot({ name: "Existing" }, { seedMessages: false });
    const options = { file: join(DATA_DIR, "routines.json"), botState: () => "busy" as const,
      createTask: () => ({ threadId: "unused" }), startTurn: async () => {} };
    const manager = new RoutineManager(options);
    onTestFinished(() => manager.stop());
    const eventId = manager.enqueueWebhook({ webhookId: "fixture-hook", webhookName: "Fixture", botId: existing.id,
      prompt: "Fixture", runOn: "ember", deliveryId: "fixture-delivery", receivedAt: 1 }).id;
    const identity = ["create", "Studio", "reviewed"], actionId = eventActionId("create", identity);
    const before = bytes(), messages = database().prepare("SELECT * FROM messages ORDER BY id").all();
    const bindings = database().prepare("SELECT * FROM memory_scope_bindings ORDER BY id").all();
    const changes: StoreChange[] = [], notifications: string[] = []; store.onChange(e => changes.push(e));
    // Use a valid informational notice so this witness reaches receipt I/O independently of approval-card admission.
    const writes = new BotOutsideWrites(store, () => null, { reviewNeeded: bot => {
      store.appendMessage(bot.threadId, murageLine({ role: "bot", kind: "text", text: "Fixture review notice" }));
      afterCommit(() => notifications.push(bot.id));
    } });
    const append = RoutineRunsJournal.prototype.append;
    let hit = false, wroteReceipt = false, refundHit = false;
    vi.spyOn(RoutineRunsJournal.prototype, "append").mockImplementation(function(this: InstanceType<typeof RoutineRunsJournal>, input) {
      const receipt = input.runs.some(run => (run as { eventBudget?: { admissions: Array<{ receipt?: string }> } }).eventBudget?.admissions.some(a => a.receipt?.startsWith("bot:")));
      if (!hit && receipt && (phase === "before-append" || phase === "after-append")) {
        hit = true;
        if (phase === "after-append") append.call(this, input);
        throw new Error("injected:receipt-write");
      }
      if (phase === "commit-refund-failure" && wroteReceipt && !receipt) { refundHit = true; throw new Error("injected:refund-write"); }
      const result = append.call(this, input);
      if (receipt) wroteReceipt = true;
      return result;
    });
    if (phase === "missing-admission") vi.spyOn(manager, "recordEventAdmissionReceipt").mockReturnValue(false);
    if (phase === "commit" || phase === "commit-refund-failure") {
      const db = database(), exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("injected:commit"); return exec(sql); });
    }
    const invoke = (rejectOuter = phase === "outer-rollback") => runEventAction({ routines: manager, bus: { store, broadcast: () => {} }, eventId, kind: "create", identity,
      from: existing, fromThreadId: existing.threadId, fullAccess: () => false, stillActive: () => {}, revalidate: () => undefined,
      replay: () => undefined, orphan: "reuse" }, async ({ charge, record, unrun }) => {
      await charge();
      const values = { store, name: "Reviewed", role: "Helper", instructions: "Fixture", modelSelection: undefined,
        targetSection: "Studio", staged: staging(), chief: existing, createdByLead: false, internalClaim: { threadId: existing.threadId },
        ownCreatedBot: () => {}, createSlot: { commit: () => {} }, record, unrun,
        botOutsideWrites: writes, eventReply: (status: number, body: unknown) => ({ status, body }), createdBody: (bot: { id: string }) => ({ id: bot.id, staged: true }) };
      if (rejectOuter) return transaction(() => {
        new Function(...Object.keys(values), block)(...Object.values(values));
        throw new Error("injected:outer-rollback");
      });
      return new Function(...Object.keys(values), block)(...Object.values(values));
    });
    if (phase === "success") {
      const result = await invoke();
      expect(result).toMatchObject({ status: 201, body: { staged: true } });
      const bot = store.bots.find(bot => bot.name === "Reviewed")!;
      expect(notifications).toEqual([bot.id]);
      expect(new Store(selection).bots.find(row => row.id === bot.id)?.staged).toBeDefined();
      expect(new RoutineManager(options).eventAdmissionReceipt(eventId, actionId)).toBe(`bot:${bot.id}`);
    } else {
      await expect(invoke()).rejects.toThrow(phase === "missing-admission" ? "That bot could not be added" : phase === "commit-refund-failure" ? "injected:commit" : phase === "commit" || phase === "outer-rollback" ? `injected:${phase}` : "injected:receipt-write");
      if (phase === "before-append" || phase === "after-append") expect(hit).toBe(true);
      vi.restoreAllMocks();
      if (phase === "commit-refund-failure") {
        expect(refundHit).toBe(true);
        expect(manager.eventAdmissionReceipt(eventId, actionId)).toBeUndefined();
        expect(manager.eventAdmissionExists(eventId, actionId)).toBe(false);
        expect(readdirSync(DATA_DIR).filter(name => name.startsWith(".bot-create-"))).toHaveLength(2);
        expect(() => store.createBot({ name: "Too soon" })).toThrow("BOT_CREATE_RECOVERY_REQUIRED");
        new RoutineManager(options).stop();
      }
      expect(store.bots.map(bot => bot.id)).toEqual([existing.id]);
      expect(bytes()).toEqual(before);
      expect(database().prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(messages);
      expect(database().prepare("SELECT * FROM memory_scope_bindings ORDER BY id").all()).toEqual(bindings);
      expect(changes).toEqual([]); expect(notifications).toEqual([]);
      expect(new Store(selection).bots.map(bot => bot.id)).toEqual([existing.id]);
      expect(manager.eventAdmissionReceipt(eventId, actionId)).toBeUndefined();
      expect(manager.eventAdmissionExists(eventId, actionId)).toBe(false);
      if (phase === "before-append" || phase === "after-append") expect(() => manager.admitEventAction(eventId, "fixture-next", "create")).toThrow("Routine persistence requires quiescent lifecycle recovery");
      const restarted = new RoutineManager(options);
      expect(restarted.eventAdmissionReceipt(eventId, actionId)).toBeUndefined();
      expect(restarted.eventAdmissionExists(eventId, actionId)).toBe(false);
      expect(readdirSync(DATA_DIR).filter(name => name.endsWith(".tmp") || name.startsWith(".bot-create-"))).toEqual([]);
      if (phase === "commit" || phase === "outer-rollback") {
        expect(await invoke(false)).toMatchObject({ status: 201, body: { staged: true } });
        const created = store.bots.filter(bot => bot.name === "Reviewed");
        expect(created).toHaveLength(1);
        expect(new RoutineManager(options).eventAdmissionReceipt(eventId, actionId)).toBe(`bot:${created[0]!.id}`);
        expect(new RoutineManager(options).eventAdmissionExists(eventId, `${actionId}#2`)).toBe(false);
      }
    }
  });
}
