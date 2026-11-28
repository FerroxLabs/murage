// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H results chat (designs/HOOKS-LINEAGE-1023.md r2, section 2 and W8-W10, W12, W14, W16, W17). The real EventResultRoutes table (SQLite),
// the real EventResults writer and replay pass run here; the Results chat's host is a small in-memory stand-in for the Store (a task
// map and a card map keyed by card id, so a replayed card patches). The Cloud port is a test implementation of ResultAudiencePort.
// W16 goes through the real AppTriggerStore origin table and the real hard-zero guard.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppTriggerStore } from "./app-trigger-store.ts";
import { APP_CHILD_NOT_ALLOWED, refuseAppChild, wireAppChildGuard } from "./app-trigger-zero.ts";
import { RoutineManager } from "./routines.ts";
import { routineRunsDir, routineRunsFileName } from "./routine-runs-journal.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import { appRunDisplay } from "./app-trigger-delivery.ts";
import { EventResultRoutes, appResultSource, EventResults, HELD_COPY, heldActions, runResultPass, type HostPorts, type OwedResult, type ResultAudiencePort, type ResultCard, type ThreadState } from "./event-results.ts";

const HOME = "0b8f5b4e-1f6a-4c1e-9d55-2b7a8c3e9f10";
const dbs: DatabaseSync[] = [];
const tmp: string[] = []; const managers: RoutineManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.stop(); for (const dir of tmp.splice(0)) removeTempDirSync(dir); wireAppChildGuard(null); for (const db of dbs.splice(0)) db.close(); });

function world(options: { cloud?: boolean; port?: ResultAudiencePort; crashAt?: "task" | "card" } = {}) {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  const routes = new EventResultRoutes(db);
  const tasks = new Map<string, { botId: string; resultsRoute?: string; ownUnshared: boolean }>();
  const cards = new Map<string, { threadId: string; card: ResultCard }>();
  const unread: Array<string | null> = [];
  const guarded: string[] = [];
  const bots = new Map<string, { shared: boolean }>([["bot-1", { shared: false }]]);
  let n = 0;
  const crash = { at: options.crashAt as "task" | "card" | undefined };
  const host: HostPorts = {
    newThreadId: () => `chat-${++n}`,
    bot: id => bots.get(id),
    thread: (_bot, threadId): ThreadState => { const t = tasks.get(threadId); return t ? { exists: true, resultsRoute: t.resultsRoute, ownUnshared: t.ownUnshared } : { exists: false }; },
    createResultsTask: (botId, _title, threadId, routeKey) => { if (crash.at === "task") { crash.at = undefined; throw new Error("crash after route row"); } tasks.set(threadId, { botId, resultsRoute: routeKey, ownUnshared: true }); return true; },
    guardResultsThread: threadId => { guarded.push(threadId); },
    writeCard: (_bot, threadId, card) => { cards.set(card.id, { threadId, card }); if (crash.at === "card") { crash.at = undefined; throw new Error("crash after card"); } },
    surfaceHeld: (_bot, threadId) => { unread.push(threadId); },
    now: () => 1_000,
  };
  const results = new EventResults(routes, host, options.port, options.cloud === true);
  return { db, routes, tasks, cards, unread, guarded, bots, host, results };
}
const owed = (runId: string, over: Partial<OwedResult> = {}): OwedResult =>
  ({ runId, kind: "webhook", automationId: "wh-deploy", automationTitle: "Deploy", botId: "bot-1", ownerAccountId: "acct_owner_a", homeId: HOME, text: `reply ${runId}`, runThreadId: `run-${runId}`, ...over });

function sourceOf(list: OwedResult[]) {
  const state = new Map<string, string>(list.map(item => [item.runId, "owed"]));
  return {
    state,
    source: {
      owed: () => list.filter(item => state.get(item.runId) === "owed" || state.get(item.runId)?.startsWith("held")),
      hold: (runId: string, reason: string) => { state.set(runId, `held:${reason}`); },
      clear: (runId: string, reason: string) => { state.set(runId, `done:${reason}`); },
    },
  };
}

describe("W8 results once: a kill at each crash point replays to one chat and one card", () => {
  it("W8 a settled run lands one evres card in its automation's chat", async () => {
    const w = world();
    const s = sourceOf([owed("r1"), owed("r2", { kind: "app_event", automationId: "r-1" })]);
    const tally = await runResultPass(w.results, s.source);
    expect(tally).toEqual({ written: 2, held: 0, gone: 0 });
    expect([...w.cards.keys()].sort()).toEqual(["evres-r1", "evres-r2"]);
    expect(w.tasks.size).toBe(2);
    expect(w.cards.get("evres-r1")!.card.link).toEqual({ type: "run", threadId: "run-r1" });
  });

  it("W8 crash point 2: after the route row and before the task, the chat is made once with the reserved id and its guard row", async () => {
    const w = world({ crashAt: "task" });
    const s = sourceOf([owed("r1", { kind: "app_event", automationId: "r-1" })]);
    await expect(runResultPass(w.results, s.source)).rejects.toThrow("crash after route row");
    const reserved = w.routes.get(JSON.stringify([HOME, "acct_owner_a", "app_event", "r-1"]))!;
    expect(w.tasks.size).toBe(0);
    await runResultPass(w.results, s.source);
    expect([...w.tasks.keys()]).toEqual([reserved.threadId]);
    expect(w.cards.size).toBe(1);
    expect(new Set(w.guarded)).toEqual(new Set([reserved.threadId]));
  });

  it("W8 crash point 3: after the task and before the card, the replay writes the card into the same chat", async () => {
    const w = world();
    const s = sourceOf([owed("r1")]);
    w.host.writeCard = () => { throw new Error("crash after task"); };
    await expect(runResultPass(w.results, s.source)).rejects.toThrow("crash after task");
    expect(w.tasks.size).toBe(1);
    const chat = [...w.tasks.keys()][0]!;
    w.host.writeCard = (_bot, threadId, card) => { w.cards.set(card.id, { threadId, card }); };
    await runResultPass(w.results, s.source);
    expect([...w.tasks.keys()]).toEqual([chat]);
    expect(w.cards.get("evres-r1")!.threadId).toBe(chat);
  });

  it("W8 crash point 4: after the card and before the clear, the replay patches the one card", async () => {
    const w = world({ crashAt: "card" });
    const s = sourceOf([owed("r1")]);
    await expect(runResultPass(w.results, s.source)).rejects.toThrow("crash after card");
    expect(w.cards.size).toBe(1);
    expect(s.state.get("r1")).toBe("owed");
    await runResultPass(w.results, s.source);
    expect(w.cards.size).toBe(1);
    expect(w.tasks.size).toBe(1);
    expect(s.state.get("r1")).toBe("done:written");
  });
});

describe("W8b a deleted chat", () => {
  it("W8b the owner deleted the results chat: the next result goes to a new chat at once, with a higher epoch, not HELD", async () => {
    const w = world();
    await runResultPass(w.results, sourceOf([owed("r1")]).source);
    const first = [...w.tasks.keys()][0]!;
    w.tasks.delete(first);
    const s = sourceOf([owed("r2")]);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r2")).toBe("done:written");
    expect(w.cards.get("evres-r2")!.threadId).not.toBe(first);
    expect(w.routes.get(JSON.stringify([HOME, "acct_owner_a", "webhook", "wh-deploy"]))!.routeEpoch).toBe(2);
  });
});

describe("W9 target_moved", () => {
  it("W9 a chat shared into a room: HELD, no card anywhere, the moved copy and Recreate; Recreate delivers", async () => {
    const w = world();
    await runResultPass(w.results, sourceOf([owed("r1")]).source);
    const first = [...w.tasks.keys()][0]!;
    w.tasks.get(first)!.ownUnshared = false;
    const s = sourceOf([owed("r2")]);
    const tally = await runResultPass(w.results, s.source);
    expect(tally.held).toBe(1);
    expect(s.state.get("r2")).toBe("held:target_moved");
    expect(w.cards.has("evres-r2")).toBe(false);
    expect(HELD_COPY.target_moved).toBe("Results waiting. The results chat was moved or shared.");
    expect(heldActions("target_moved")).toEqual(["Recreate results chat"]);
    expect(await w.results.recreate(owed("r2"))).toBe(true);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r2")).toBe("done:written");
    expect(w.cards.get("evres-r2")!.threadId).not.toBe(first);
  });
});

describe("W10 same-name automations", () => {
  it("W10 two webhooks named Deploy get two routes and two chats", async () => {
    const w = world();
    await runResultPass(w.results, sourceOf([owed("r1", { automationId: "wh-a" }), owed("r2", { automationId: "wh-b" })]).source);
    expect(w.tasks.size).toBe(2);
    expect(w.cards.get("evres-r1")!.threadId).not.toBe(w.cards.get("evres-r2")!.threadId);
  });
});

describe("W12 route epoch", () => {
  it("W12 the owner recreates the chat while a writer is checking: the writer re-resolves, no card in the old chat", async () => {
    const holder: { results?: EventResults } = {};
    let recreated = false;
    const port: ResultAudiencePort = { check: ({ threadId }) => {
      if (!recreated) { recreated = true; const key = JSON.stringify([HOME, "acct_owner_a", "webhook", "wh-deploy"]); const route = world_.routes.get(key)!; world_.routes.bump(key, route.routeEpoch, "chat-recreated"); old = threadId; }
      return "owner_only";
    } };
    let old = "";
    const world_ = world({ cloud: true, port });
    holder.results = world_.results;
    const s = sourceOf([owed("r1")]);
    await runResultPass(world_.results, s.source);
    expect(old).not.toBe("");
    expect(world_.cards.get("evres-r1")!.threadId).toBe("chat-recreated");
    expect(world_.cards.get("evres-r1")!.threadId).not.toBe(old);
  });
});

describe("W14 Cloud port", () => {
  it("W14 unavailable: HELD with the Cloud copy and no Recreate; owner_only on a later pass delivers with no owner action", async () => {
    let answer: "unavailable" | "owner_only" = "unavailable";
    let calls = 0;
    const w = world({ cloud: true, port: { check: () => { calls++; return answer; } } });
    const s = sourceOf([owed("r1")]);
    await runResultPass(w.results, s.source);
    expect(calls).toBe(1);
    expect(s.state.get("r1")).toBe("held:cloud_check_unavailable");
    expect(w.cards.size).toBe(0);
    expect(HELD_COPY.cloud_check_unavailable).toContain("Murage Cloud couldn't confirm");
    expect(heldActions("cloud_check_unavailable")).toEqual([]);
    answer = "owner_only";
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("done:written");
    expect(w.cards.size).toBe(1);
  });

  it("W14 a Cloud home with no port wired fails closed to HELD", async () => {
    const w = world({ cloud: true });
    const s = sourceOf([owed("r1")]);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("held:cloud_check_unavailable");
  });
});

describe("W16 the app_event Results chat is guarded", () => {
  it("W16 an owner turn in the results chat calls ask-bot below No limits and is refused", async () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const store = new AppTriggerStore(db);
    const w = world();
    w.host.guardResultsThread = (threadId, botId, automationId) => { store.putOrigin({ threadId, kind: "results", triggerId: null, routineId: automationId, ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, firstRunId: null, now: 1_000 }); void botId; };
    await runResultPass(w.results, sourceOf([owed("r1", { kind: "app_event", automationId: "r-1" })]).source);
    const chat = [...w.tasks.keys()][0]!;
    wireAppChildGuard({ lineage: store, now: () => 1_000, onCard: () => {}, defer: work => work() });
    expect(refuseAppChild({ threadId: chat, generation: "gen-owner-1" }, "ask")?.code).toBe(APP_CHILD_NOT_ALLOWED);
  });
});

describe("W17 bot_shared", () => {
  it("W17 a shared bot: HELD with the shared copy and no Recreate, the chat shows unread once, and the first pass after unsharing delivers", async () => {
    const w = world();
    w.bots.set("bot-1", { shared: true });
    const s = sourceOf([owed("r1")]);
    await runResultPass(w.results, s.source);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("held:bot_shared");
    expect(w.cards.size).toBe(0);
    expect(heldActions("bot_shared")).toEqual([]);
    expect(HELD_COPY.bot_shared).toContain("shared with a team");
    expect(w.unread).toHaveLength(1);
    w.bots.set("bot-1", { shared: false });
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("done:written");
  });

  it("W17 a bot that is gone ends the result as automation_deleted", async () => {
    const w = world();
    w.bots.delete("bot-1");
    const s = sourceOf([owed("r1")]);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("done:automation_deleted");
  });
});

describe("W8w the real RoutineManager journal feeds the writer", () => {
  it("W8w a settled webhook run that owes its result gets one card, then its marker is done; a held one stays held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-l5h-")); tmp.push(dir);
    const file = join(dir, "routines.json");
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [], routineRequestReceipts: [] }));
    mkdirSync(routineRunsDir(dir), { recursive: true });
    const at = Date.UTC(2026, 10, 22, 8, 0, 0);
    const line = (id: string) => JSON.stringify({ id, routineId: "wh-deploy", routineName: "Deploy", prompt: "p", attachments: [], target: "bot", botId: "bot-1", runOn: "ember", scheduledFor: at, dueAt: at,
      status: "completed", manual: false, triggerSource: "webhook", webhookId: "wh-deploy", deliveryId: `d-${id}`, createdAt: at, startedAt: at, finishedAt: at + 1, output: "done", threadId: `run-${id}`, eventResult: { state: "owed" } });
    writeFileSync(join(routineRunsDir(dir), routineRunsFileName("wh-deploy")), `${line("w1")}\n${line("w2")}\n`);
    const m = new RoutineManager({ file, now: () => at + 60_000, botState: () => "ready", createTask: () => null, startTurn: async () => {}, eventResultRouting: () => true });
    managers.push(m);
    const w = world();
    const source = {
      owed: () => m.eventResultsOwed().map((run): OwedResult => owed(run.id, { text: `reply ${run.id}`, runThreadId: run.threadId })),
      hold: (runId: string, reason: "target_moved" | "bot_shared" | "cloud_check_unavailable") => { m.holdEventResult(runId, reason); },
      clear: (runId: string, reason: "written" | "automation_deleted") => { m.clearEventResult(runId, reason); },
    };
    expect(source.owed().map(item => item.runId).sort()).toEqual(["w1", "w2"]);
    await runResultPass(w.results, source);
    expect(m.runById("w1")?.eventResult).toEqual({ state: "done", reason: "written" });
    expect(source.owed()).toEqual([]);
    expect([...w.cards.keys()].sort()).toEqual(["evres-w1", "evres-w2"]);
  });
});

describe("W14c the chat is re-checked after the Cloud await (Opus r3 H1)", () => {
  it("W14c the chat is shared while the port call is in flight: HELD target_moved, no card in the shared chat", async () => {
    let w: ReturnType<typeof world>;
    const port: ResultAudiencePort = { check: ({ threadId }) => { w.tasks.get(threadId)!.ownUnshared = false; return "owner_only"; } };
    w = world({ cloud: true, port });
    const s = sourceOf([owed("r1")]);
    await runResultPass(w.results, s.source);
    expect(s.state.get("r1")).toBe("held:target_moved");
    expect(w.cards.size).toBe(0);
  });
});

describe("W8a an app run's result reaches its Results chat through the real store", () => {
  it("W8a a run that settles owes its result; the pass writes one evres card in a guarded kind=results chat and the store row ends done(written)", async () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const store = new AppTriggerStore(db);
    const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23";
    store.putBinding({
      triggerId: "trg-1", routineId: "r-1", botId: "bot-1", ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, bindingRevision: 1, routineRevision: 1,
      subscriptionId: SUB, providerTriggerInstanceId: "ti_1", connectedAccountId: "ca_1", eventType: "slack.channel.message", instructionDigest: bodyDigest("i"),
      policyId: "p-1", policyRevision: 1, policyDigest: bodyDigest("policy"), billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", botKeyId: "bk-1", billingReceiptDigest: bodyDigest("r"),
      filter: { all: [] }, syncState: "active", activatedAt: 1, childCreates: 0, childHandoffs: 0,
    }, 1);
    db.prepare("INSERT INTO app_event_batches (batch_id, trigger_id, state, opened_at, seal_due_at) VALUES ('b1','trg-1','sealed',1,2)").run();
    store.createRunForBatch({ runId: "00000000-0000-4000-8000-0000000000a1", batchId: "b1", triggerId: "trg-1", routineId: "r-1", botId: "bot-1", ownerAccountId: "acct_owner_a", subscriptionId: SUB, policyDigest: bodyDigest("policy"), billingRef: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", now: 2 });
    const runId = "00000000-0000-4000-8000-0000000000a1";
    store.update(runId, { state: "running", submitted: true, threadId: "run-thread" }, 3);
    store.update(runId, { state: "completed" }, 4);
    expect(store.findById(runId)!.resultState).toBe("owed");
    const w = world();
    w.host.guardResultsThread = (threadId, _bot, automationId) => { store.putOrigin({ threadId, kind: "results", triggerId: null, routineId: automationId, ownerAccountId: "acct_owner_a", homeId: HOME, homeEpoch: 1, firstRunId: null, now: 5 }); };
    const tally = await runResultPass(w.results, appResultSource(store, HOME, run => appRunDisplay({ state: run.state as never, waitReason: null })));
    expect(tally.written).toBe(1);
    expect(w.cards.has(`evres-${runId}`)).toBe(true);
    expect(store.findById(runId)!.resultState).toBe("done");
    expect(store.origin([...w.tasks.keys()][0]!)?.kind).toBe("results");
  });
});
