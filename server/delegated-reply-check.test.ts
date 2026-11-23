// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A delegated reply the result gate is still checking is waited for, then delivered (1.0.5, DELEGATED-REPLY-WITHHELD.md). Sean's 1.0.5 report:
// a hand-off's reply came back as the checking placeholder while the work sat in the worker's conversation. Before this lane the finalizer
// (handoff-boundary.ts) made the checking verdict final at the worker's turn end (the asker read the no-answer line, the room the checking
// line); now the hand-off waits, bounded, re-runs its gate, and the asker gets the real reply once the check clears, or a line that names the
// worker and where the words are. The fixture is delegation-nohold.test.ts's: a leader hands off to a researcher whose reply lands inside an
// install-wide pending revoke window (the gate reads "checking: pending" until the marker has walked it).
import fs, { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { botRows, botViewer, doorEgress } from "./bot-read.ts";
import { configureBotEgress, RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { AskerWakes, type AskerWakeIntent, type AskerWakeSnapshot } from "./asker-wake.ts";
import { _loadPending, findDelegationReceipt, FINALIZER_WRITES, forgetDelegationsForThreads, handoffRow, onDelegationReceipt, onOwedHandoffReply, startedTicket } from "./delegations.ts";
import { DELEGATED_REPLY_CHECK_WAIT_MS, DELEGATED_REPLY_RECHECK_MS, DelegatedReplyChecks } from "./delegated-reply-check.ts";
import { checkDelegationRoute, runFinalizeDelegationWatch, type AskerWakePort, type CheckDelegationRouteContext, type FinalizeDelegationWatchPorts } from "./handoff-boundary.ts";
import { handoffReplyId, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerDeletedThread, recordOwnerDeletion } from "./owner-deletions.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { COPY_ORIGINS } from "./memory/lineage-types.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker, INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { capturedMessageVerdict, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { configureStatusRoster, outboundWords, status, type Outbound } from "./murage-status.ts";
import { configureResultEgress, writetimeLinesShown, type ReleasedResult, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { handoffLinkGroups, handoffReplyCopyOf, releaseHandoffLink, turnReplyCopyOf } from "./turn-reply-copy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WORDS_A = "RBA cash rate 3.60 percent, last changed 2026-02-18, rba.gov.au (RESEARCHER_A_WORDS)";
const WITHHELD = `[${ROOM_REPLY_WITHHELD}]`;
const CHECKING = `[${ROOM_REPLY_CHECKING}]`;
const NO_ANSWER = "(no answer: that memory is still being checked, try again later)";
let inlineMs: number;

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  inlineMs = INLINE_REVOCATION.ms;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  _loadPending();
});
afterEach(() => {
  INLINE_REVOCATION.ms = inlineMs;
  onOwedHandoffReply(undefined); onDelegationReceipt(undefined);
  configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); vi.useRealTimers();
});

/** A hand-made clock and timer queue: the scheduler's re-checks fire only when a test says so. */
function clock() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setTimer: (run: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    /** Fire every timer that is due (after the clock moved). */
    fire: () => { for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    pending: () => timers.size,
  };
}

function world(options: { waitMs?: number } = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const leader = store.createBot({ name: "Team Leader", section: "Research" }, { seedMessages: false });
  const a = store.createBot({ name: "Researcher A", section: "Research" }, { seedMessages: false });
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: copy => copyOriginVerdict(LineageAllowance.tool(), copy),
    capturedMessageWithheld: (thread, id) => capturedMessageVerdict(LineageAllowance.tool(), thread, id),
    messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    withheldLine: WITHHELD, checkingLine: CHECKING, linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  const finalizing = new Set<string>();
  onOwedHandoffReply(receipt => finalizing.has(receipt.id) ? FINALIZER_WRITES : replayOwedReply(store, receipt));
  const delegationWatch: FinalizeDelegationWatchPorts["delegationWatch"] = new Map();
  const marked = vi.fn<(bot: BotRecord, threadId: string, messageId: string) => void>();
  const comms = { reply: vi.fn(() => undefined), activity: vi.fn(), clearFinishing: vi.fn(), murageLine: vi.fn() };
  const time = clock();
  const checks = new DelegatedReplyChecks({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, waitMs: options.waitMs, log: () => undefined });
  const hurried = vi.fn<(threadId: string) => void>();
  /** A dependency a re-run reads (the source conversation's lookup) failing on demand, with a count of the failed calls. */
  const fault = { source: false, thrown: 0 };
  const ports: FinalizeDelegationWatchPorts = {
    comms: comms as never, delegationWatch,
    delegationSource: threadId => { if (fault.source) { fault.thrown++; throw new Error("database is busy"); } return threadId === leader.threadId ? { kind: "bot", bot: leader } : null; },
    sourceDeleted: threadId => ownerDeletedThread(database(), threadId),
    finalizingDelegations: finalizing, handoffRequestId: () => undefined, markTaskContextExternallyUpdated: marked, completeRoomAsk: () => undefined,
    afterRoomCompletion: () => undefined, owedReply: input => owedReplyOf({ ok: input.ok, reply: input.reply ? outboundWords(input.reply) : "", targetName: input.targetName, failureName: outboundWords(input.failureName), stopped: input.stopped }),
    store: boundaryStore(store), rows: new RowSink(store), replyChecks: checks, hurryReplyCheck: hurried,
  };
  /** A researcher's reply written inside its own turn (its lineage row carries the turn and its parents). */
  const begin = (bot: BotRecord, parents: Parameters<typeof addTurnParents>[1] = []) => {
    const turn = openTurnLineage(database(), { threadId: bot.threadId, turnId: `turn-${bot.id}-${Math.random().toString(36).slice(2)}` });
    if (parents.length) addTurnParents(turn, parents);
    return (text: string) => {
      const message = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text });
      closeTurnLineage(turn);
      return message;
    };
  };
  const reply = (bot: BotRecord, text: string, parents: Parameters<typeof addTurnParents>[1] = []) => begin(bot, parents)(text);
  /** A reply whose turn began before a revoke the owner commits mid-turn: the reply is inside the revoke's pending window. */
  const heldReply = (bot: BotRecord, text: string, parents: Parameters<typeof addTurnParents>[1] = []) => { const write = begin(bot, parents); openPendingWindow(); return write(text); };
  /** The hand-off's own started row, as the dispatch leaves it while the worker's turn runs (delegations.ts): what check_delegation and a
   * deletion of the asker's conversation act on. */
  const startedRow = (taskId: string, bot: BotRecord) => {
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id, started_at, submitted_at, accepted_turn_id) VALUES(?,?,?,?,'started',NULL,'{}','owner',?,?,?,?,?)")
      .run(taskId, leader.threadId, bot.id, leader.id, `dlg-${taskId}`, bot.threadId, Date.now(), Date.now(), `turn-${taskId}`);
  };
  /** The leader's hand-off to `bot` finishing with `message` as its reply (the finalizer, as the turn engine calls it at the turn's end). */
  const finish = (bot: BotRecord, message: Message, taskId: string, extra: Partial<{ channelId: string }> = {}) => {
    delegationWatch.set(bot.threadId, { toBotId: bot.id, toBotName: bot.name, taskId, sourceThreadId: leader.threadId, ...extra });
    return runFinalizeDelegationWatch(ports, bot.threadId, true, { text: new WorkerText(message.text ?? ""), present: true }, undefined, false, { threadId: bot.threadId, messageIds: [message.id] });
  };
  const saved = new Map<string, AskerWakeSnapshot>();
  const wakes = new AskerWakes((_bot, threadId, snapshot) => { if (snapshot) saved.set(threadId, JSON.parse(JSON.stringify(snapshot))); else saved.delete(threadId); });
  const wakeCalls: string[] = [];
  const askerWake: AskerWakePort = {
    register: (taskId, asker) => wakes.register(taskId, asker as AskerWakeIntent),
    consume: taskId => wakes.consume(taskId),
    returned: (taskId, threadId, result) => { if (wakes.deliver(taskId, result)) wakeCalls.push(`${taskId}:${result.messageId}`); return wakes.durable(threadId); },
  };
  ports.askerWake = askerWake;
  const asked = (taskId: string) => askerWake.register(taskId, { botId: leader.id, threadId: leader.threadId, depth: 0, notOwnerAudience: false, unattended: false });
  /** check_delegation / wait_delegation as the leader calls it: the body it is sent. */
  const check = async (taskId: string) => {
    const sent: Array<{ status: number; body: { status?: string; result?: string } }> = [];
    configureBotEgress((_res, code, body) => { sent.push({ status: code, body: body as never }); });
    await checkDelegationRoute({
      askerWake, connectorThread: () => ({ bot: leader, group: undefined }), delegationMatch: ["", taskId] as unknown as RegExpMatchArray,
      internalClaim: { botId: leader.id, threadId: leader.threadId, generation: "g", depth: 0, kind: "handoff", skillAuthoring: false, expiresAt: Date.now() + 60_000 },
      requireActiveInternal: () => undefined, res: {} as never, resultEgressDeps: deps, store: boundaryStore(store),
      taskResolutionDeps: { receipt: (id: string) => findDelegationReceipt(id), pending: () => null, request: () => null, requestSourceThread: () => null, delivered: "delivered", watches: () => [], started: (id: string) => startedTicket(id) },
      url: new URL(`http://127.0.0.1/api/internal/delegations/${taskId}?fromBotId=${leader.id}&fromThreadId=${leader.threadId}&wait_ms=0`),
    } as unknown as CheckDelegationRouteContext);
    configureBotEgress(undefined);
    expect(sent).toHaveLength(1);
    return sent[0].body;
  };
  const row = (taskId: string) => store.messageById(leader.threadId, handoffReplyId(taskId));
  const botReads = (message: Message) => botRows(database(), botViewer(leader.id), leader.threadId, [message], { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true }).map(r => r.text).join("\n");
  const verdictOf = (bot: BotRecord, messageId: string) => denyLookup(database(), { threadId: bot.threadId, lines: [{ messageId, author: "generated" }] }, { audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true }).get(messageId);
  const mirrored = () => (comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound));
  return { store, leader, a, ports, deps, marked, comms, time, checks, hurried, fault, reply, heldReply, startedRow, finish, row, botReads, verdictOf, wakeCalls, asked, saved, check, mirrored };
}

/** An install-wide pending window: a revoke with a root marks every generated line written after it "checking" until the marker has walked it. */
function openPendingWindow() {
  INLINE_REVOCATION.ms = 0;
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const other = store.bots.find(bot => bot.name === "Elsewhere") ?? store.createBot({ name: "Elsewhere", section: "Other" }, { seedMessages: false });
  const line = store.appendMessage(other.threadId, { role: "bot", kind: "text", text: "an earlier answer the owner regenerated" });
  commitRevoke(database(), { kind: "line", threadId: other.threadId, messageIds: [line.id], cause: "regenerate" });
}

/** Every store a bot could be handed words from: files under the data dir (not the databases), the saved wakes, the leader's rows. */
function storesText(w: ReturnType<typeof world>): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = entries.map(entry => entry.name);
    const journals = new Set(names.filter(name => /\.(db|sqlite)$/.test(name) && statSync(join(dir, name)).isFile()).map(name => name + "-journal"));
    for (const entry of entries) {
      const name = entry.name;
      const excluded = /\.(db|sqlite)(-wal|-shm)?$/.test(name);
      // SQLite can remove excluded database sidecars before stat or read.
      if (journals.has(name) || (!entry.isDirectory() && !entry.isSymbolicLink() && excluded)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else if (!excluded) files.push(path);
    }
  };
  walk(DATA_DIR);
  return [...files.map(file => readFileSync(file, "utf8")), JSON.stringify([...w.saved]), ...w.store.messagesFor(w.leader.threadId).map(m => JSON.stringify(m))].join("\n");
}

it.each(["after enumeration", "before read"])("storesText completes when SQLite removes its rollback journal %s", when => {
  const w = world();
  const file = join(DATA_DIR, "census.db"), journal = file + "-journal";
  const db = new DatabaseSync(file);
  const originalList = fs.readdirSync, originalRead = fs.readFileSync;
  try {
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE fixture(words TEXT); BEGIN IMMEDIATE; INSERT INTO fixture VALUES('database words')");
    expect(fs.existsSync(journal)).toBe(true);
    fs.writeFileSync(join(DATA_DIR, "reply.json"), "CENSUS_TEXT_WORDS");
    let committed = false;
    const list = vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) => {
      const entries = Reflect.apply(originalList, fs, args);
      if (String(args[0]) === DATA_DIR) {
        expect(entries.map((entry: string | fs.Dirent) => typeof entry === "string" ? entry : entry.name)).toContain("census.db-journal");
        if (when === "after enumeration") { db.exec("COMMIT"); committed = true; }
      }
      return entries;
    }) as typeof fs.readdirSync);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
      if (when === "before read" && !committed) {
        db.exec("COMMIT"); committed = true;
      }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      let text = "";
      expect(() => { text = storesText(w); }).not.toThrow();
      expect(committed).toBe(true);
      expect(fs.existsSync(journal)).toBe(false);
      expect(text).toContain("CENSUS_TEXT_WORDS");
    } finally {
      list.mockRestore(); read.mockRestore(); syncBuiltinESMExports();
    }
  } finally { db.close(); }
});

it("storesText completes when SQLite removes its WAL and SHM after enumeration", () => {
  const w = world(), file = join(DATA_DIR, "census.db");
  const db = new DatabaseSync(file);
  const originalList = fs.readdirSync;
  let closed = false;
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(words TEXT); INSERT INTO fixture VALUES('database words')");
    expect(fs.existsSync(file + "-wal")).toBe(true);
    expect(fs.existsSync(file + "-shm")).toBe(true);
    fs.writeFileSync(join(DATA_DIR, "reply.json"), "CENSUS_TEXT_WORDS");
    const list = vi.spyOn(fs, "readdirSync").mockImplementation(((...args: unknown[]) => {
      const entries = Reflect.apply(originalList, fs, args);
      if (String(args[0]) === DATA_DIR) {
        expect(entries.map((entry: string | fs.Dirent) => typeof entry === "string" ? entry : entry.name)).toContain("census.db-wal");
        expect(entries.map((entry: string | fs.Dirent) => typeof entry === "string" ? entry : entry.name)).toContain("census.db-shm");
        db.close(); closed = true;
      }
      return entries;
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    try {
      let text = "";
      expect(() => { text = storesText(w); }).not.toThrow();
      expect(closed).toBe(true);
      expect(fs.existsSync(file + "-wal")).toBe(false);
      expect(fs.existsSync(file + "-shm")).toBe(false);
      expect(text).toContain("CENSUS_TEXT_WORDS");
    } finally { list.mockRestore(); syncBuiltinESMExports(); }
  } finally { if (!closed) db.close(); }
});

it("storesText propagates a disappearing ordinary text file", () => {
  const w = world(), file = join(DATA_DIR, "reply.json");
  fs.writeFileSync(file, "CENSUS_TEXT_WORDS");
  const originalRead = fs.readFileSync;
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
    if (String(args[0]) === file) fs.unlinkSync(file);
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  try { expect(() => storesText(w)).toThrowError(expect.objectContaining({ code: "ENOENT", path: file })); }
  finally { read.mockRestore(); syncBuiltinESMExports(); }
});

it.each(["x-journal", "orphan.db-journal", "orphan.sqlite-journal"])("storesText includes deleted text in a non-sidecar file named %s", name => {
  const w = world();
  fs.writeFileSync(join(DATA_DIR, name), "DELETED_REPLY_WORDS");
  expect(storesText(w)).toContain("DELETED_REPLY_WORDS");
});

it.each(["archive.db", "archive.sqlite", "archive.db-wal", "archive.db-shm", "archive.sqlite-wal", "archive.sqlite-shm"])("storesText traverses a directory and its symlink named %s", name => {
  const w = world(), directory = join(DATA_DIR, name);
  mkdirSync(directory);
  fs.writeFileSync(join(directory, "reply.json"), "DIRECTORY_REPLY_WORDS");
  expect(storesText(w)).toContain("DIRECTORY_REPLY_WORDS");
  fs.renameSync(directory, join(DATA_DIR, "archive"));
  fs.symlinkSync(join(DATA_DIR, "archive"), directory, "dir");
  expect(storesText(w).split("DIRECTORY_REPLY_WORDS")).toHaveLength(3);
});

it.each(["archive.db", "archive.sqlite", "archive.db-wal", "archive.db-shm", "archive.sqlite-wal", "archive.sqlite-shm"])("storesText excludes a file symlink named %s", name => {
  const w = world(), file = join(DATA_DIR, "reply.json");
  fs.writeFileSync(file, "FILE_REPLY_WORDS");
  fs.symlinkSync(file, join(DATA_DIR, name));
  expect(storesText(w).split("FILE_REPLY_WORDS")).toHaveLength(2);
});

it("a reply the gate is still checking is waited for: nothing is written or woken, the memory side is hurried, and when the window closes the asker gets the real reply once", async () => {
  const w = world();
  w.asked("task-a");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "checking", reason: "pending" });
  expect(w.finish(w.a, replyA, "task-a")).toBe(true);
  // the hand-off is not settled: no row, no receipt, no wake, no mirror; a check is owed for it and the worker's thread was hurried
  expect(w.row("task-a")).toBeUndefined();
  expect(findDelegationReceipt("task-a")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(w.mirrored()).toEqual([]);
  expect(w.checks.has("task-a")).toBe(true);
  expect(w.hurried).toHaveBeenCalledWith(w.a.threadId);
  expect(w.ports.delegationWatch.has(w.a.threadId)).toBe(false);
  // a re-check while the window is still open changes nothing and keeps waiting
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.row("task-a")).toBeUndefined();
  expect(w.checks.has("task-a")).toBe(true);
  expect(w.hurried).toHaveBeenCalledTimes(2);
  // the marker walks the revoke: the window closes, and the next re-check delivers the words as any clean delegation would
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  const row = w.row("task-a")!;
  expect(row.text).toContain("replied to the delegated task");
  expect(row.text).toContain(WORDS_A);
  expect(w.botReads(row)).toContain("RESEARCHER_A_WORDS");
  expect(row.copyOf).toEqual({ threadId: w.a.threadId, messageIds: [replyA.id] });
  const receipt = findDelegationReceipt("task-a")!;
  expect(receipt).toMatchObject({ status: "done", copyOf: { threadId: w.a.threadId, messageIds: [replyA.id] } });
  expect(receipt.held).toBeUndefined();
  expect(w.marked).toHaveBeenCalledTimes(1);
  expect(w.wakeCalls).toEqual([`task-a:${row.id}`]);
  expect(w.checks.has("task-a")).toBe(false);
  expect((await w.check("task-a")).result).toContain("RESEARCHER_A_WORDS");
  // nothing before the delivery carried the words anywhere a bot reads
  expect(w.mirrored().join("\n")).not.toContain(CHECKING);
});

/** The server's own finalizeDelegationWatch (index.ts), run over this world's ports: the wiring the shipped build uses, not a hand-built port set. */
function shippedFinalizer(w: ReturnType<typeof world>) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  let node: ts.FunctionDeclaration | undefined;
  const visit = (n: ts.Node) => { if (ts.isFunctionDeclaration(n) && n.name?.text === "finalizeDelegationWatch") node = n; else ts.forEachChild(n, visit); };
  visit(ast);
  expect(node, "index must define finalizeDelegationWatch").toBeDefined();
  const p = w.ports;
  const env: Record<string, unknown> = {
    runFinalizeDelegationWatch, WorkerText, rows: p.rows, askerWakePort: p.askerWake, boundaryCommsPort: p.comms, delegationSource: p.delegationSource,
    delegationWatch: p.delegationWatch, finalizingDelegations: p.finalizingDelegations, handoffRequestId: p.handoffRequestId,
    markTaskContextExternallyUpdated: p.markTaskContextExternallyUpdated, completeRoomAsk: p.completeRoomAsk, afterRoomCompletion: p.afterRoomCompletion,
    boundaryOwedReply: p.owedReply, boundaryStoreView: p.store, hurryDelegatedReplyCheck: p.hurryReplyCheck, delegatedReplyChecks: w.checks,
    ownerDeletedThread, database,
  };
  const code = ts.transpileModule(`${node!.getText(ast)}; return finalizeDelegationWatch;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as (threadId: string, succeeded: boolean, recordedReply?: string, failure?: unknown, stopped?: boolean, recordedCopyOf?: Message["copyOf"]) => boolean;
}

it("1.0.20: through the server's own finalizer, a delegated reply held while memory is checked never posts the no-answer placeholder to the asker; it waits and is delivered when checking clears", () => {
  const w = world();
  const finalize = shippedFinalizer(w);
  w.asked("task-s");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "checking", reason: "pending" });
  w.ports.delegationWatch.set(w.a.threadId, { toBotId: w.a.id, toBotName: w.a.name, taskId: "task-s", sourceThreadId: w.leader.threadId });
  expect(finalize(w.a.threadId, true, replyA.text ?? "", undefined, false, { threadId: w.a.threadId, messageIds: [replyA.id] })).toBe(true);
  // the asker's conversation shows no bubble at all while the check runs: never the internal placeholder
  const leaderText = () => w.store.messagesFor(w.leader.threadId).map(m => m.text ?? "").join("\n");
  expect(leaderText()).not.toContain(NO_ANSWER);
  expect(w.row("task-s")).toBeUndefined();
  expect(findDelegationReceipt("task-s")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(w.checks.has("task-s")).toBe(true);
  // checking clears: the next re-check delivers the real reply once
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  const row = w.row("task-s")!;
  expect(row.text).toContain(WORDS_A);
  expect(w.wakeCalls).toEqual([`task-s:${row.id}`]);
  expect(leaderText()).not.toContain(NO_ANSWER);
});

it("a reply still checking when the wait runs out ends with a line that names the worker and where the words are: final, one wake, read by bots, the words in no store, the room told the same", async () => {
  const w = world();
  const pair = w.store.createGroup("Pair room", [w.leader.id, w.a.id]);
  w.asked("task-b");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-b", { channelId: pair.id })).toBe(true);
  // re-checks up to the bound keep waiting (the window never closes here)
  for (let waited = 0; waited + DELEGATED_REPLY_RECHECK_MS < DELEGATED_REPLY_CHECK_WAIT_MS; waited += DELEGATED_REPLY_RECHECK_MS) {
    w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
    expect(w.row("task-b")).toBeUndefined();
  }
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  const line = outboundWords(status("no_answer_check_timed_out", { name: w.ports.store.nameOf(w.a.id) }));
  expect(line).toContain("@Researcher A finished");
  expect(line).toContain("Read it in @Researcher A's own conversation");
  const row = w.row("task-b")!;
  expect(row.text).toBe(line);
  expect(row.copyOf).toBeUndefined();
  expect(w.botReads(row)).toBe(line);
  const receipt = findDelegationReceipt("task-b")!;
  expect(receipt).toMatchObject({ status: "done", result: line });
  expect(receipt.resultStatus?.key).toBe("no_answer_check_timed_out");
  expect(receipt.copyOf).toBeUndefined();
  expect(w.wakeCalls).toEqual([`task-b:${row.id}`]);
  expect(w.checks.has("task-b")).toBe(false);
  expect((await w.check("task-b")).result).toBe(line);
  // the pair room reads the same line, never the bare checking placeholder, never the words
  expect(w.mirrored()).toEqual([line]);
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain(NO_ANSWER);
  // final: the window closing later changes nothing and wakes nobody again
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.row("task-b")!.text).toBe(line);
  expect(w.wakeCalls).toHaveLength(1);
});

it("a reply that really used a line the owner forgot is withheld at once with its own reason: no wait, one wake", () => {
  const w = world();
  w.asked("task-w");
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "the owner's private plan" });
  const replyA = w.reply(w.a, WORDS_A, [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }]);
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  drainRevokeMarker(database());
  w.finish(w.a, replyA, "task-w");
  expect(w.checks.has("task-w")).toBe(false);
  expect(w.hurried).not.toHaveBeenCalled();
  expect(findDelegationReceipt("task-w")).toMatchObject({ result: WITHHELD });
  expect(w.botReads(w.row("task-w")!)).not.toContain(WORDS_A);
  expect(w.wakeCalls).toEqual([`task-w:${handoffReplyId("task-w")}`]);
});

it("a clean reply is delivered at the turn's end as before: no wait, no hurry", () => {
  const w = world();
  w.asked("task-c");
  const replyA = w.reply(w.a, WORDS_A);
  w.finish(w.a, replyA, "task-c");
  expect(w.checks.has("task-c")).toBe(false);
  expect(w.hurried).not.toHaveBeenCalled();
  expect(w.botReads(w.row("task-c")!)).toContain("RESEARCHER_A_WORDS");
  expect(w.wakeCalls).toEqual([`task-c:${handoffReplyId("task-c")}`]);
});

// 1.0.21 cause15 (rig-realsize RED item 2): a long delegated turn writes a text line at every step, and the hand-off's result named every
// one of them as its originals. A copy may name at most COPY_ORIGINS (64) anywhere in the lineage, so a turn with more read "checking" for
// good in the result gate (its walk gave up): no memory check was owed, the 180 s wait could not clear it, and the asker got the no-answer
// line. The finalizer now judges every line of the turn in groups the gate can walk and the delivered copy names the newest lines up to
// the bound (turn-reply-copy.ts releaseHandoffLink).
// r2 (Astra BLOCK on 582d6c8b11 + this lane's own review): the first fix shortened the link BEFORE the gate saw it, choosing the lines
// with a lookup of its own; the tests below that pinned the shortened link's shape now pin the whole link handed over and the outcome.
/** One worker turn that writes `count` text lines (a step line each, then the final words): every line carries the turn's id and lineage. */
function longTurn(w: ReturnType<typeof world>, count: number, options: { parents?: Parameters<typeof addTurnParents>[1]; midTurn?: () => void } = {}) {
  const turnId = `turn-long-${count}-${Math.random().toString(36).slice(2)}`;
  const turn = openTurnLineage(database(), { threadId: w.a.threadId, turnId });
  if (options.parents?.length) addTurnParents(turn, options.parents);
  options.midTurn?.();
  const lines = Array.from({ length: count }, (_, i) => w.store.appendMessage(w.a.threadId, { role: "bot", kind: "text", turnId, text: i === count - 1 ? WORDS_A : `Step ${i + 1} of ${count - 1} done.` }));
  closeTurnLineage(turn);
  return { turnId, lines };
}
/** The finalizer at the long turn's end, as the turn engine calls it (index.ts): the last line's words, and the hand-off's link (the same
 * handoffReplyCopyOf call index.ts makes; the finalizer keeps what it is handed for every re-check). */
const finishLong = (w: ReturnType<typeof world>, turn: ReturnType<typeof longTurn>, taskId: string) => {
  w.ports.delegationWatch.set(w.a.threadId, { toBotId: w.a.id, toBotName: w.a.name, taskId, sourceThreadId: w.leader.threadId });
  const copyOf = handoffReplyCopyOf(w.store, w.a.threadId, turn.turnId);
  return { copyOf, done: runFinalizeDelegationWatch(w.ports, w.a.threadId, true, { text: new WorkerText(turn.lines.at(-1)!.text ?? ""), present: true }, undefined, false, copyOf) };
};

it("cause15: the reply of a long delegated turn (121 text lines, the rig's 120 steps) is delivered at the turn's end: no wait, no no-answer line, and the asking bot can read it", () => {
  const w = world();
  w.asked("task-long");
  const turn = longTurn(w, 121);
  const { copyOf, done } = finishLong(w, turn, "task-long");
  expect(done).toBe(true);
  // the finalizer is handed every line of the turn (r2: was the newest 64 only); the delivered copy names the newest 64, the reply last
  expect(copyOf?.messageIds).toEqual(turn.lines.map(line => line.id));
  expect(w.row("task-long")!.copyOf?.messageIds).toEqual(turn.lines.slice(-COPY_ORIGINS).map(line => line.id));
  expect(w.checks.has("task-long")).toBe(false);
  expect(w.hurried).not.toHaveBeenCalled();
  const row = w.row("task-long")!;
  expect(row.text).toContain("RESEARCHER_A_WORDS");
  expect(row.copyOf?.messageIds.at(-1)).toBe(turn.lines.at(-1)!.id);
  // the delivered row has its own lineage row (a copy past the bound gets none and reads withheld to every bot)
  expect(w.verdictOf(w.leader, row.id)).toEqual({ state: "shown" });
  expect(w.botReads(row)).toContain("RESEARCHER_A_WORDS");
  expect(w.store.messagesFor(w.leader.threadId).map(m => m.text ?? "").join("\n")).not.toMatch(/no answer|withheld/i);
  expect(w.wakeCalls).toEqual([`task-long:${handoffReplyId("task-long")}`]);
});

it("cause15: nothing is left waiting after a long turn's reply: the whole bound passes and no no-answer line is ever written", () => {
  const w = world();
  w.asked("task-long2");
  finishLong(w, longTurn(w, 121), "task-long2");
  expect(w.time.pending()).toBe(0);
  w.time.advance(DELEGATED_REPLY_CHECK_WAIT_MS + DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(findDelegationReceipt("task-long2")?.result ?? "").toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("still being checked");
});

it("cause15 privacy: a long turn that read a line the owner then forgot is withheld at once with the withheld line: never delivered, never the no-answer line", () => {
  const w = world();
  w.asked("task-long-w");
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "the owner's private plan" });
  const turn = longTurn(w, 121, { parents: [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }] });
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  drainRevokeMarker(database());
  finishLong(w, turn, "task-long-w");
  expect(w.checks.has("task-long-w")).toBe(false);
  expect(findDelegationReceipt("task-long-w")).toMatchObject({ result: WITHHELD });
  expect(w.botReads(w.row("task-long-w")!)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("still being checked");
  expect(w.wakeCalls).toEqual([`task-long-w:${handoffReplyId("task-long-w")}`]);
});

it("cause15 privacy: every named line is judged, not only the reply: the owner's flag on a step line among the named ones withholds the reply", () => {
  const w = world();
  w.asked("task-long-m");
  const turn = longTurn(w, 121);
  w.store.patchMessage(w.a.threadId, turn.lines[99]!.id, { withheldFromBots: "forgotten" });
  finishLong(w, turn, "task-long-m");
  expect(w.checks.has("task-long-m")).toBe(false);
  expect(findDelegationReceipt("task-long-m")).toMatchObject({ result: WITHHELD });
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15: a long turn's reply inside a real pending window still waits, and is delivered when the window closes (the wait is for memory, never for size)", () => {
  const w = world();
  w.asked("task-long-p");
  const turn = longTurn(w, 121, { midTurn: openPendingWindow });
  finishLong(w, turn, "task-long-p");
  expect(w.checks.has("task-long-p")).toBe(true);
  expect(w.row("task-long-p")).toBeUndefined();
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.row("task-long-p")!.text).toContain("RESEARCHER_A_WORDS");
});

it("cause15 privacy: a mark on an OLDER line of the turn, one the newest 64 leave out, still withholds the reply: that line is kept in the link and judged", () => {
  const w = world();
  w.asked("task-long-o");
  const turn = longTurn(w, 121);
  // line 10 of 121 carries the owner's flag: a real mark the newest 64 lines do not carry
  w.store.patchMessage(w.a.threadId, turn.lines[9]!.id, { withheldFromBots: "forgotten" });
  // (r2: this pinned the shortened link's shape, the flagged line moved to its front; the link is whole now and the gate judges line 10 in its group)
  const { copyOf } = finishLong(w, turn, "task-long-o");
  expect(copyOf?.messageIds).toHaveLength(121);
  expect(w.checks.has("task-long-o")).toBe(false);
  expect(findDelegationReceipt("task-long-o")).toMatchObject({ result: WITHHELD });
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("still being checked");
});

it("cause15: the hand-off's link and an ask's link both name every line of the turn; the fallback without the turn's rows names every reply since the hand-off began", () => {
  const w = world();
  const short = longTurn(w, COPY_ORIGINS);
  expect(handoffReplyCopyOf(w.store, w.a.threadId, short.turnId)?.messageIds).toEqual(short.lines.map(line => line.id));
  const long = longTurn(w, 121);
  // an ask's answer joins every line of the turn: every one stays named (the gate judges all the words it delivers)
  expect(turnReplyCopyOf(w.store, w.a.threadId, long.turnId)?.messageIds).toEqual(long.lines.map(line => line.id));
  // (r2: the hand-off's link was shortened here, by a lookup; it is whole now and the finalizer judges it in groups)
  expect(handoffReplyCopyOf(w.store, w.a.threadId, long.turnId)?.messageIds).toEqual(long.lines.map(line => line.id));
  const since = longTurn(w, 70);
  const copy = handoffReplyCopyOf(w.store, w.a.threadId, "no-such-turn", since.lines[0]!.at);
  expect(copy?.messageIds).toEqual(since.lines.map(line => line.id));
});

// 1.0.21 cause15 r2 (Astra BLOCK on 582d6c8b11, turn-reply-copy.ts:47): keeping an older still-checking line took a place from the newest
// 64, so a flagged line among them fell out of the link; the re-check reused that shortened link, and once the older check cleared the
// reply was released though the omitted flag should withhold it. Now the gate judges every line of the turn, in groups, at every run.
it("cause15 r2: the groups a link is judged in hold every line exactly once, the newest 64 last, none larger than the gate can walk", () => {
  for (const count of [0, 1, 63, 64, 65, 121, 128, 129, 200, 1000]) {
    const ids = Array.from({ length: count }, (_, i) => `m${i}`);
    const groups = handoffLinkGroups(ids);
    expect(groups.flat()).toEqual(ids);
    for (const group of groups) expect(group.length).toBeLessThanOrEqual(COPY_ORIGINS);
    expect(groups.at(-1)).toEqual(ids.slice(-COPY_ORIGINS));
    if (count > COPY_ORIGINS) expect(groups.at(-1)).toHaveLength(COPY_ORIGINS);
  }
  // 65 lines, the oldest still being checked and the next flagged (the blocked case): both are judged, in their groups
  expect(handoffLinkGroups(Array.from({ length: 65 }, (_, i) => `m${i}`)).map(group => group[0])).toEqual(["m0", "m1"]);
});

it("cause15 r2: a long link releases only when every group reads text; one withheld, gone, refused or checking group decides, and a held group's words are not carried", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `m${i}`);
  const line = status("withheld");
  const text = (messageIds: string[]): ReleasedResult => ({ kind: "text", text: "T" as never, copyOf: { threadId: "t", messageIds } });
  const withAnswers = (answer: (group: string[]) => ReleasedResult) => { const asked: string[][] = []; return { asked, result: releaseHandoffLink(ids, group => { asked.push(group); return answer(group); }) }; };
  // every group text: the newest group's answer, and every line was put to the gate
  const clean = withAnswers(text);
  expect(clean.asked.flat()).toEqual(ids);
  expect(clean.result).toEqual(text(ids.slice(-COPY_ORIGINS)));
  // one group, any group, not text: never text
  for (const bad of ["m0", "m70", "m135", "m136", "m199"]) for (const kind of ["withheld", "checking", "gone", "refused", "status"] as const) {
    const answer = (group: string[]): ReleasedResult => !group.includes(bad) ? text(group)
      : kind === "withheld" ? { kind, line } : kind === "checking" ? { kind, line, held: { text: "HELD" as never, copyOf: { threadId: "t", messageIds: group } } }
      : kind === "refused" ? { kind, line, code: "no" } : { kind };
    const { asked, result } = withAnswers(answer);
    expect(asked.flat()).toEqual(ids);
    expect(result.kind).toBe(kind);
    expect("held" in result).toBe(false);
  }
  // withheld in one group wins over checking in another, whichever comes first
  for (const [held, marked] of [["m0", "m199"], ["m199", "m0"]] as const) {
    expect(releaseHandoffLink(ids, group => group.includes(marked) ? { kind: "withheld", line } : group.includes(held) ? { kind: "checking", line } : text(group)).kind).toBe("withheld");
  }
  // a link the gate can walk in one go is asked about once, whole, and its answer is the answer
  const once: string[][] = [];
  const held: ReleasedResult = { kind: "checking", line, held: { text: "HELD" as never, copyOf: { threadId: "t", messageIds: [] } } };
  expect(releaseHandoffLink(ids.slice(0, COPY_ORIGINS), group => { once.push(group); return held; })).toBe(held);
  expect(once).toEqual([ids.slice(0, COPY_ORIGINS)]);
});

/** Every line the gate read (its `message` reader) since the last `take()`, for one world. */
function gateReads(w: ReturnType<typeof world>) {
  const read = w.deps.message;
  let seen = new Set<string>();
  w.deps.message = (thread, id) => { seen.add(id); return read(thread, id); };
  return { take: () => { const out = seen; seen = new Set(); return out; } };
}
/** 100 lines, then an install-wide pending window opens, then 21 more: only the last 21 are being checked at the turn's end. */
function turnWithLateWindow(w: ReturnType<typeof world>, turnId: string) {
  const lineage = openTurnLineage(database(), { threadId: w.a.threadId, turnId });
  const write = (i: number) => w.store.appendMessage(w.a.threadId, { role: "bot", kind: "text", turnId, text: i === 120 ? WORDS_A : `Step ${i + 1} of 120 done.` });
  const lines = Array.from({ length: 100 }, (_, i) => write(i));
  openPendingWindow();
  for (let i = 100; i < 121; i++) lines.push(write(i));
  closeTurnLineage(lineage);
  return { turnId, lines };
}

it("cause15 r2 privacy: 65 lines inside a pending window (the oldest still being checked), the second one flagged: the reply is withheld, and the window closing never releases it", () => {
  const w = world();
  w.asked("task-r2-65");
  const turn = longTurn(w, COPY_ORIGINS + 1, { midTurn: openPendingWindow });
  w.store.patchMessage(w.a.threadId, turn.lines[1]!.id, { withheldFromBots: "forgotten" });
  const reads = gateReads(w);
  finishLong(w, turn, "task-r2-65");
  // the gate read every line of the turn, the flagged one included
  expect(reads.take()).toEqual(new Set(turn.lines.map(line => line.id)));
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  // the window closes (the older check clears) and any re-check owed runs; then the whole bound passes
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  w.time.advance(DELEGATED_REPLY_CHECK_WAIT_MS + DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.checks.has("task-r2-65")).toBe(false);
  expect(findDelegationReceipt("task-r2-65")).toMatchObject({ result: WITHHELD });
  expect(w.botReads(w.row("task-r2-65")!)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15 r2 privacy: 121 lines inside a pending window, a flagged line among the newest 64: withheld, never released when the window closes", () => {
  const w = world();
  w.asked("task-r2-121");
  const turn = longTurn(w, 121, { midTurn: openPendingWindow });
  w.store.patchMessage(w.a.threadId, turn.lines[80]!.id, { withheldFromBots: "forgotten" });
  finishLong(w, turn, "task-r2-121");
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  w.time.advance(DELEGATED_REPLY_CHECK_WAIT_MS + DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.checks.has("task-r2-121")).toBe(false);
  expect(findDelegationReceipt("task-r2-121")).toMatchObject({ result: WITHHELD });
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15 r2 privacy: a flagged line among the newest 64 with older lines of the turn still to judge and newer ones being checked: withheld", () => {
  const w = world();
  w.asked("task-r2-fit");
  const turn = turnWithLateWindow(w, "turn-r2-fit");
  w.store.patchMessage(w.a.threadId, turn.lines[59]!.id, { withheldFromBots: "forgotten" });
  finishLong(w, turn, "task-r2-fit");
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_CHECK_WAIT_MS + DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(findDelegationReceipt("task-r2-fit")).toMatchObject({ result: WITHHELD });
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15 r2 privacy: every re-check judges the whole link again: an older line that read shown at the turn's end, flagged while the hand-off waited, withholds the reply", () => {
  const w = world();
  w.asked("task-r2-late");
  const turn = turnWithLateWindow(w, "turn-r2-late");
  const reads = gateReads(w);
  finishLong(w, turn, "task-r2-late");
  expect(reads.take()).toEqual(new Set(turn.lines.map(line => line.id)));
  // the newest lines are being checked: the hand-off waits, nothing is written
  expect(w.checks.has("task-r2-late")).toBe(true);
  expect(w.row("task-r2-late")).toBeUndefined();
  // while it waits, the owner flags line 11 (older than the newest 64); then the window closes
  w.store.patchMessage(w.a.threadId, turn.lines[10]!.id, { withheldFromBots: "forgotten" });
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  // the re-check read every line again, line 11 included
  expect(reads.take()).toEqual(new Set(turn.lines.map(line => line.id)));
  expect(w.checks.has("task-r2-late")).toBe(false);
  expect(findDelegationReceipt("task-r2-late")).toMatchObject({ result: WITHHELD });
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15 r2: the same turn with nothing flagged is delivered once the window closes, the copy naming the newest 64 lines", () => {
  const w = world();
  w.asked("task-r2-clean");
  const turn = turnWithLateWindow(w, "turn-r2-clean");
  finishLong(w, turn, "task-r2-clean");
  expect(w.checks.has("task-r2-clean")).toBe(true);
  expect(drainRevokeMarker(database()).pending).toBe(false);
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  const row = w.row("task-r2-clean")!;
  expect(row.text).toContain("RESEARCHER_A_WORDS");
  expect(row.copyOf?.messageIds).toEqual(turn.lines.slice(-COPY_ORIGINS).map(line => line.id));
  expect(w.verdictOf(w.leader, row.id)).toEqual({ state: "shown" });
});

it("cause15 r2 privacy: an older line only one of the gate's own rules marks (no lookup beside the gate reads it) withholds the reply at once", () => {
  const w = world();
  w.asked("task-r2-rule");
  const turn = longTurn(w, 121);
  // line 6 of 121, older than the newest 64, rests on a source the owner forgot: a rule of the gate (result-egress.ts step 3), not a line mark
  w.deps.messageSourceForgotten = (_thread, id) => id === turn.lines[5]!.id;
  finishLong(w, turn, "task-r2-rule");
  expect(w.checks.has("task-r2-rule")).toBe(false);
  expect(findDelegationReceipt("task-r2-rule")).toMatchObject({ result: WITHHELD });
  expect(w.botReads(w.row("task-r2-rule")!)).not.toContain("RESEARCHER_A_WORDS");
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("cause15 r2: a long turn whose check never clears is judged whole at every re-check and ends in the no-answer line, never the worker's words", () => {
  const w = world();
  w.asked("task-r2-full");
  const turn = longTurn(w, 121, { midTurn: openPendingWindow });
  const reads = gateReads(w);
  finishLong(w, turn, "task-r2-full");
  let runs = 0;
  for (let waited = 0; waited < DELEGATED_REPLY_CHECK_WAIT_MS + DELEGATED_REPLY_RECHECK_MS && w.checks.has("task-r2-full"); waited += DELEGATED_REPLY_RECHECK_MS) {
    expect(reads.take()).toEqual(new Set(turn.lines.map(line => line.id)));
    runs++;
    w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  }
  expect(runs).toBeGreaterThan(2);
  expect(w.checks.has("task-r2-full")).toBe(false);
  const row = w.row("task-r2-full")!;
  expect(row.text).toBe(outboundWords(status("no_answer_check_timed_out", { name: w.ports.store.nameOf(w.a.id) })));
  expect(row.copyOf).toBeUndefined();
  expect(findDelegationReceipt("task-r2-full")?.resultStatus?.key).toBe("no_answer_check_timed_out");
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("a stopped turn whose reply reads checking finalizes at once as before (it restarts nobody)", () => {
  const w = world();
  w.asked("task-s");
  const replyA = w.heldReply(w.a, WORDS_A);
  w.ports.delegationWatch.set(w.a.threadId, { toBotId: w.a.id, toBotName: w.a.name, taskId: "task-s", sourceThreadId: w.leader.threadId });
  runFinalizeDelegationWatch(w.ports, w.a.threadId, true, { text: new WorkerText(WORDS_A), present: true }, undefined, true, { threadId: w.a.threadId, messageIds: [replyA.id] });
  expect(w.checks.has("task-s")).toBe(false);
  expect(findDelegationReceipt("task-s")).toBeDefined();
  expect(w.wakeCalls).toEqual([]);
});

it("F5: while the check is owed, check_delegation answers running from the started row: no terminal state, no words", async () => {
  const w = world();
  w.asked("task-r");
  w.startedRow("task-r", w.a);
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-r")).toBe(true);
  expect(w.checks.has("task-r")).toBe(true);
  const polled = await w.check("task-r");
  expect(polled.status).toBe("running");
  expect(JSON.stringify(polled)).not.toContain("RESEARCHER_A_WORDS");
  expect(w.wakeCalls).toEqual([]);
  // the row stays until the check settles; the first owed wake is still owed
  expect(handoffRow("task-r")?.phase).toBe("started");
});

it("F13: the asker's conversation is deleted while the check is owed: the re-run writes nothing, wakes nobody, and forgets the check", () => {
  const w = world();
  w.asked("task-d");
  w.startedRow("task-d", w.a);
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-d")).toBe(true);
  // the owner deletes the asker's conversation: its hand-offs and receipts go with it (delegations.ts forgetDelegationsForThreads)
  forgetDelegationsForThreads([w.leader.threadId]);
  expect(handoffRow("task-d")).toBeUndefined();
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.checks.has("task-d")).toBe(false);
  expect(w.row("task-d")).toBeUndefined();
  expect(findDelegationReceipt("task-d")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(w.mirrored()).toEqual([]);
  expect(w.time.pending()).toBe(0);
});

it("F3: a real mark landing while the check is owed withholds the reply at the re-check, with its reason, once", () => {
  const w = world();
  w.asked("task-m");
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "the owner's private plan" });
  const replyA = w.heldReply(w.a, WORDS_A, [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }]);
  expect(w.finish(w.a, replyA, "task-m")).toBe(true);
  expect(w.checks.has("task-m")).toBe(true);
  // during the wait the owner forgets the plan the reply rested on
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.checks.has("task-m")).toBe(false);
  expect(findDelegationReceipt("task-m")).toMatchObject({ result: WITHHELD });
  expect(w.botReads(w.row("task-m")!)).not.toContain(WORDS_A);
  expect(w.wakeCalls).toEqual([`task-m:${handoffReplyId("task-m")}`]);
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("F6: a second turn in the worker's thread settles on its own while the first reply waits; the first still lands when its check clears", () => {
  const w = world();
  w.asked("task-1"); w.asked("task-2");
  const first = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, first, "task-1")).toBe(true);
  expect(w.ports.delegationWatch.has(w.a.threadId)).toBe(false);
  // a new hand-off to the same worker: its own watch, its own clean reply, delivered at once
  const second = w.reply(w.a, "SECOND_REPLY_WORDS");
  expect(w.finish(w.a, second, "task-2")).toBe(true);
  expect(w.botReads(w.row("task-2")!)).toContain("SECOND_REPLY_WORDS");
  expect(w.wakeCalls).toEqual([`task-2:${handoffReplyId("task-2")}`]);
  expect(w.row("task-1")).toBeUndefined();
  expect(w.checks.has("task-1")).toBe(true);
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.botReads(w.row("task-1")!)).toContain("RESEARCHER_A_WORDS");
  expect(w.wakeCalls).toEqual([`task-2:${handoffReplyId("task-2")}`, `task-1:${handoffReplyId("task-1")}`]);
});

it("F15: the owner deletes the asker's conversation while the worker's turn still runs: the checking reply never lands there, at once or after the wait", () => {
  const w = world();
  w.asked("task-x");
  w.startedRow("task-x", w.a);
  const replyA = w.heldReply(w.a, WORDS_A);
  // the deletion commits during the worker's turn: its tombstone is written and the started row goes with it (owner-deletions.ts)
  recordOwnerDeletion(database(), w.leader.threadId);
  expect(handoffRow("task-x")).toBeUndefined();
  expect(w.finish(w.a, replyA, "task-x")).toBe(true);
  expect(w.checks.has("task-x")).toBe(false);
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.row("task-x")).toBeUndefined();
  expect(findDelegationReceipt("task-x")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(w.mirrored()).toEqual([]);
  expect(w.time.pending()).toBe(0);
});

it("F15: a deletion landing during the wait of a hand-off that never had a started row still ends it with nothing written", () => {
  const w = world();
  w.asked("task-y");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-y")).toBe(true);
  expect(w.checks.has("task-y")).toBe(true);
  recordOwnerDeletion(database(), w.leader.threadId);
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.checks.has("task-y")).toBe(false);
  expect(w.row("task-y")).toBeUndefined();
  expect(findDelegationReceipt("task-y")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(w.time.pending()).toBe(0);
});

it("F15: a clean reply whose asking conversation the owner deleted mid-turn is not written into it either", () => {
  const w = world();
  w.asked("task-z");
  const clean = w.reply(w.a, "CLEAN_REPLY_WORDS");
  recordOwnerDeletion(database(), w.leader.threadId);
  expect(w.finish(w.a, clean, "task-z")).toBe(true);
  expect(w.row("task-z")).toBeUndefined();
  expect(findDelegationReceipt("task-z")).toBeFalsy();
  expect(w.wakeCalls).toEqual([]);
  expect(storesText(w)).not.toContain("CLEAN_REPLY_WORDS");
});

it("F16: a re-run that keeps failing past the wait stays owed, a full gap apart, and gives the asker one final line once it recovers, without a restart", () => {
  const w = world();
  w.asked("task-f");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-f")).toBe(true);
  w.fault.source = true;
  // well past the bound and its old one-gap grace: every re-run throws, nothing is written, the check stays owed
  for (let waited = 0; waited < DELEGATED_REPLY_CHECK_WAIT_MS + 6 * DELEGATED_REPLY_RECHECK_MS; waited += DELEGATED_REPLY_RECHECK_MS) { w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire(); }
  const thrown = w.fault.thrown;
  expect(thrown).toBeGreaterThan(36);
  expect(w.checks.has("task-f")).toBe(true);
  expect(w.time.pending()).toBe(1);
  expect(w.row("task-f")).toBeUndefined();
  // past the bound the next try is a full gap away, never a tight loop
  w.time.advance(1); w.time.fire();
  w.time.advance(DELEGATED_REPLY_RECHECK_MS - 2); w.time.fire();
  expect(w.fault.thrown).toBe(thrown);
  // the dependency recovers: the next re-run is past the bound, so the asker gets the timed-out line, once
  w.fault.source = false;
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  const line = outboundWords(status("no_answer_check_timed_out", { name: w.ports.store.nameOf(w.a.id) }));
  expect(w.row("task-f")!.text).toBe(line);
  expect(findDelegationReceipt("task-f")).toMatchObject({ status: "done", result: line });
  expect(w.wakeCalls).toEqual([`task-f:${handoffReplyId("task-f")}`]);
  expect(w.checks.has("task-f")).toBe(false);
  expect(w.time.pending()).toBe(0);
});

it("F17: a re-run that commits and then fails in a follow-up (the room mirror) is not delivered twice", () => {
  const w = world();
  const pair = w.store.createGroup("Pair room", [w.leader.id, w.a.id]);
  w.asked("task-g");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.finish(w.a, replyA, "task-g", { channelId: pair.id })).toBe(true);
  w.comms.reply.mockImplementation(() => { throw new Error("the room is busy"); });
  drainRevokeMarker(database());
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.botReads(w.row("task-g")!)).toContain("RESEARCHER_A_WORDS");
  expect(w.wakeCalls).toEqual([`task-g:${handoffReplyId("task-g")}`]);
  expect(w.comms.reply).toHaveBeenCalledTimes(1);
  // the scheduler retries the throwing run; the retry finds the end committed and delivers nothing again
  w.time.advance(DELEGATED_REPLY_RECHECK_MS); w.time.fire();
  expect(w.comms.reply).toHaveBeenCalledTimes(1);
  expect(w.marked).toHaveBeenCalledTimes(1);
  expect(w.wakeCalls).toHaveLength(1);
  expect(w.checks.has("task-g")).toBe(false);
  expect(w.time.pending()).toBe(0);
});

describe("the scheduler", () => {
  it("a re-check that throws stays owed in the bound and past it, armed a full gap apart from its original beginning, until a run returns", () => {
    const time = clock();
    const log: string[] = [];
    const checks = new DelegatedReplyChecks({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, waitMs: 20_000, recheckMs: 5_000, log: line => log.push(line) });
    let runs = 0;
    let broken = true;
    const settled: number[] = [];
    const began = checks.defer("k", "thread-1", () => { runs++; if (broken) throw new Error("database is busy"); settled.push(time.now()); });
    time.advance(5_000); time.fire();
    expect(runs).toBe(1);
    expect(checks.has("k")).toBe(true);
    expect(time.pending()).toBe(1);
    expect(log.some(line => line.includes("trying again"))).toBe(true);
    // re-armed with the same beginning: the bound is measured from the first defer, not from the failure
    for (let i = 0; i < 3; i++) { time.advance(5_000); time.fire(); }
    expect(runs).toBe(4);
    expect(checks.expired(began)).toBe(true);
    // past the bound and far past its old grace it is never dropped, and each try is a full gap after the last (no 1 ms loop)
    for (let i = 0; i < 30; i++) { time.advance(5_000); time.fire(); }
    expect(runs).toBe(34);
    expect(checks.has("k")).toBe(true);
    time.advance(1); time.fire(); time.advance(4_998); time.fire();
    expect(runs).toBe(34);
    // the logs are throttled: the first failure, then one in twelve
    expect(log.filter(line => line.includes("failed")).length).toBeLessThanOrEqual(4);
    // the dependency recovers: one run returns, and nothing stays owed or armed
    broken = false;
    time.advance(1); time.fire();
    expect(runs).toBe(35);
    expect(settled).toHaveLength(1);
    expect(checks.has("k")).toBe(false);
    expect(time.pending()).toBe(0);
  });
  it("re-arms one owed check per key, measures the whole wait from the first defer, and forgets a cancelled or run check", () => {
    const time = clock();
    const checks = new DelegatedReplyChecks({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, waitMs: 20_000, recheckMs: 5_000, log: () => undefined });
    const runs: number[] = [];
    const began = checks.defer("k", "thread-1", () => runs.push(1));
    expect(checks.has("k")).toBe(true);
    expect(checks.threads()).toEqual(["thread-1"]);
    expect(time.pending()).toBe(1);
    // deferred again (the finalizer re-ran and still read checking): the same check, one timer, the first moment kept
    time.advance(5_000); time.fire();
    expect(runs).toEqual([1]);
    expect(checks.defer("k", "thread-1", () => runs.push(2), began)).toBe(began);
    expect(time.pending()).toBe(1);
    expect(checks.expired(began)).toBe(false);
    time.advance(15_000);
    expect(checks.expired(began)).toBe(true);
    // the last re-arm never waits past the bound
    checks.cancel("k");
    expect(checks.has("k")).toBe(false);
    expect(time.pending()).toBe(0);
    checks.defer("k2", "thread-2", () => runs.push(3), time.now() - 18_000);
    expect(time.pending()).toBe(1);
    time.advance(2_000); time.fire();
    expect(runs).toEqual([1, 3]);
    expect(checks.has("k2")).toBe(false);
    // runNow fires every owed check at once
    checks.defer("k3", "thread-3", () => runs.push(4));
    checks.runNow();
    expect(runs).toEqual([1, 3, 4]);
    expect(checks.has("k3")).toBe(false);
    checks.stop();
  });
  it("once stopped (the server is closing) it drops every owed check and arms none again, so no finalizer runs during cleanup", () => {
    const time = clock();
    const checks = new DelegatedReplyChecks({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, waitMs: 20_000, recheckMs: 5_000, log: () => undefined });
    const runs: string[] = [];
    checks.defer("k", "thread-1", () => { runs.push("k"); checks.defer("k", "thread-1", () => runs.push("again")); });
    checks.stop();
    expect(checks.stopped).toBe(true);
    expect(checks.has("k")).toBe(false);
    expect(time.pending()).toBe(0);
    // a finalizer that runs late (its turn ended during cleanup) defers again: nothing is armed
    checks.defer("late", "thread-2", () => runs.push("late"));
    expect(checks.has("late")).toBe(false);
    expect(time.pending()).toBe(0);
    time.advance(60_000); time.fire(); checks.runNow();
    expect(runs).toEqual([]);
  });
  it("the real defaults: a three minute wait, a five second re-check gap", () => {
    expect(DELEGATED_REPLY_CHECK_WAIT_MS).toBe(180_000);
    expect(DELEGATED_REPLY_RECHECK_MS).toBe(5_000);
  });
});

it("the copy of this lane carries no em dash in the files it wrote, and none of the three words the house rules ban", () => {
  const written = ["server/delegated-reply-check.ts", "server/delegated-reply-check.test.ts"];
  const emDash = String.fromCharCode(0x2014);
  const banned = new RegExp(`\\b(${["un" + "sa" + "fe", "sa" + "fe" + "ty", "sa" + "fe"].join("|")})\\b`, "i");
  const offenders: string[] = [];
  for (const file of written) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    if (text.includes(emDash)) offenders.push(`${file}: em dash`);
    for (const line of text.split("\n")) if (banned.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
  }
  // the new status line itself
  const line = outboundWords(status("no_answer_check_timed_out", { name: "Sable" as never }));
  if (line.includes(emDash) || banned.test(line)) offenders.push(`status: ${line}`);
  expect(offenders).toEqual([]);
});
