// Owners: nl-backup-b owns this replay regression fixture; recall-scope owns prepared recall views.
import fs, { existsSync, mkdirSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as walMaintenance from "../wal-maintenance.ts";
import * as searchIndex from "../message-search-index.ts";
import * as handles from "../test-handle-registry.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { botRowOf, botViewer } from "../bot-read.ts";
import type { Message } from "../store.ts";
import { buildTurnContext, transcriptForDriver, type TranscriptEntry } from "../turn-context.ts";
import { createOpenAIChatRuntime } from "../drivers/openai-chat.ts";
import { recordEvents } from "../testing/events.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { prepareRecallContextSync } from "./recall-view.ts";
import { filterDirectReplay, filterMemoryReplay } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { turnReplayInputs } from "./turn-replay-inputs.ts";
import * as lineage from "./replay-lineage.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { afterUpdate } from "../branch-store.ts";
import { appendMessage, updateMessage } from "../message-db.ts";

const thread = "f7-chat", bot = "f7-bot";
const roster = { memoryRosterRevision: 1, bots: [{ id: bot, threadId: thread }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  // Frozen I0 schema, fixture-only: B2 does not register or mutate A1's schema.
  database().exec(`CREATE TABLE IF NOT EXISTS send_replay_exclusions (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, attempt_id TEXT,
    reason TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(thread_id,message_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS send_replay_epochs(thread_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL);`);
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
useOutsideStoreFixture();

function row(id: string, copyOf?: Message["copyOf"], target = thread): Message {
  const message: Message = { id, role: "user", kind: "text", text: `WORDS-${id}`, at: 1, ...(copyOf ? { copyOf } : {}) };
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text',?,?)")
    .run(target, id, message.text!, JSON.stringify(message));
  return message;
}
function exclude(id: string, target = thread, reason = "not_submitted") {
  database().prepare("INSERT OR REPLACE INTO send_replay_exclusions VALUES(?,?,NULL,?,1)").run(target, id, reason);
  database().prepare("INSERT INTO send_replay_epochs VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1").run(target);
}
function selection(messages: Message[], minLines = 40) {
  return turnReplayInputs({ threadId: thread, botId: bot,
    store: { activeTextLines: (_thread, limit) => ({ messages: messages.slice(-limit), hasMore: messages.length > limit, exact: true }) },
    routeHasTools: false, externalUpdates: undefined, floor: null, projectCardRun: false, skip: new Set(),
    replayOptions: { minLines }, windowStart: 2 });
}
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, kind: "memory", depth: 0, skillAuthoring: false });
  // Prepare the real train-5 view before admitting this fixture reader.
  prepareRecallContextSync(bot, thread, roster);
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function transcript(messages: Message[]): TranscriptEntry[] {
  return messages.map(message => ({ id: message.id, role: "user", text: message.text!, source: botRowOf(message, botViewer(bot))! }));
}
async function providerInput(entries: TranscriptEntry[], native: boolean, resumed = false, rebuilt = false): Promise<string> {
  const context = buildTurnContext({ text: "NEXT-EXPLICIT-INPUT", transcript: entries,
    rewound: false, fresh: !resumed, memoryRefreshed: rebuilt, externallyUpdated: false, replaysNatively: native });
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(String(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  // A newly constructed real runtime has no retained session: F7-REPLAY must
  // exercise actual replay, rather than accidentally pass by resuming context.
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "f7-engine", displayName: "F7", enabled: true, environment: {}, config: {} },
    driverKind: "openai-compat", apiKey: "fixture-key", apiUrl: "https://fixture.invalid/v1",
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 10_000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text }) => ({ text }) },
  });
  const events = recordEvents(runtime.adapter);
  try {
    await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: thread, text: context.turnText,
      ...(native ? { transcript: transcriptForDriver(entries) } : {}) });
    await events.until(event => event.type === "turn.completed");
    expect(requests, JSON.stringify(events.events)).toHaveLength(1);
    return requests[0]!;
  } finally { events.stop(); await runtime.dispose(); vi.unstubAllGlobals(); }
}

it.each([false, true])("F7-REPLAY: fresh real adapter input excludes ordinary, late-refused and uncertain lines (native=%s)", async native => {
  const messages = [row("legacy"), row("failed"), row("refused"), row("uncertain")];
  exclude("failed"); exclude("refused"); exclude("uncertain", thread, "uncertain");
  const selected = selection(messages);
  const input = await providerInput(transcript(selected.replayedMessages), native);
  expect(input).toContain("WORDS-legacy");
  for (const id of ["failed", "refused", "uncertain"]) expect(input).not.toContain(`WORDS-${id}`);
  expect(input.match(/NEXT-EXPLICIT-INPUT/g)).toHaveLength(1);
});

it("F7-REPLAY: exclusion precedes budgeting and every widening iteration", () => {
  const messages = [row("old1"), row("old2"), row("failed1"), row("failed2")];
  exclude("failed1"); exclude("failed2");
  expect(selection(messages, 2).replayedMessages.map(m => m.id)).toEqual(["old1", "old2"]);
});

it("F7-COPY: cross-thread excerpts and nested copies cannot reintroduce excluded inputs", () => {
  row("original", undefined, "source"); exclude("original", "source");
  row("middle", { threadId: "source", messageIds: ["original"] }, "middle-thread");
  const copy = row("copy", { threadId: "middle-thread", messageIds: ["middle"] });
  expect(selection([copy]).replayedMessages).toEqual([]);
  expect(lineage.copyOriginWithheld(LineageAllowance.tool(), { threadId: "source", messageIds: ["original"] })).toBe(true);
});

it("F7-REPLAY: memory and direct readers omit excluded text even with withheld placeholders and quotes", () => {
  const failed = row("failed"), safe = { ...row("safe"), replyToId: failed.id };
  exclude(failed.id);
  expect(filterMemoryReplay(LineageAllowance.tool(), thread, [failed, safe], access()).map(m => m.id)).toEqual(["safe"]);
  const direct = filterDirectReplay(LineageAllowance.tool(), thread, [failed, safe], access(), new Set(), { withheldLine: () => "withheld" });
  expect(direct.replayed.map(m => m.id)).toEqual(["safe"]);
  expect(direct.allowed.map(m => m.id)).toEqual(["safe"]);
});

it("F7-LEGACY (GUARD): ordinary historical context without attempts survives fresh and rebuilt replay", async () => {
  const messages = [row("history"), row("another")];
  const selected = transcript(selection(messages).replayedMessages);
  for (const rebuilt of [false, true]) {
    const input = await providerInput(selected, false, false, rebuilt);
    expect(input).toContain("WORDS-history"); expect(input).toContain("WORDS-another");
  }
});

it("F7-PRUNE/RESTORE: durable exclusions survive queue payload removal and database reopen", () => {
  const messages = [row("history"), row("failed")]; exclude("failed");
  // Queue lifetime is deliberately irrelevant to the replay reader. Reopening
  // models the reader of a restored snapshot; actual archive wiring is Slice I.
  database().exec("CREATE TABLE fixture_queue(id TEXT); INSERT INTO fixture_queue VALUES('failed'); DELETE FROM fixture_queue;");
  closeDatabase(); database();
  expect(selection(messages).replayedMessages.map(m => m.id)).toEqual(["history"]);
});

it("F7-ML6-QUERY-PLAN / F7-ML6-FAILED-ROWS-INVARIANT: candidate lookup work ignores 0, 10000 and 100000 failed rows", () => {
  const messages = [row("one"), row("two")], db = database();
  const prepare = db.prepare.bind(db), queries: string[] = [];
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (/FROM send_replay_exclusions\b/i.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { queries.push(sql); return Reflect.apply(get, statement, args); };
    }
    return statement;
  });
  const counts: number[] = [];
  let previous = 0;
  for (const size of [0, 10000, 100000]) {
    db.exec("BEGIN");
    const add = prepare("INSERT INTO send_replay_exclusions VALUES(?,?,NULL,'not_submitted',1)");
    for (let i = previous; i < size; i++) add.run(thread, `unrelated-${i}`);
    db.exec("COMMIT"); previous = size;
    queries.length = 0;
    expect(selection(messages).replayedMessages.map(m => m.id)).toEqual(["one", "two"]);
    counts.push(queries.length);
    expect(queries.length, "replay consults the durable eligibility index").toBeGreaterThan(0);
    for (const sql of queries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(thread, "one").map(r => String(r.detail)).join("\n");
      expect(plan).toContain("SEARCH send_replay_exclusions USING PRIMARY KEY");
      expect(plan).not.toMatch(/SCAN /);
    }
  }
  expect(counts).toEqual([counts[0], counts[0], counts[0]]);
  expect(counts).toEqual([2, 2, 2]);
});

it("F7-BATCH: long replay candidates retain durable exclusions and recheck later commits", () => {
  const messages = Array.from({ length: 80 }, (_, i) => row(`batch-${i}`));
  exclude('batch-73');
  const selected = selection(messages, 128);
  expect(selected.replayedMessages.map(message => message.id)).toEqual(messages.filter(message => message.id !== 'batch-73').map(message => message.id));
  expect([...selected.replayProof.excludedIds]).toEqual(['batch-73']);
  exclude('batch-1');
  expect(() => lineage.assertSendReplayProof(selected.replayProof)).toThrow('SEND_REPLAY_CHANGED');
  expect(selection(messages, 128).replayedMessages.map(message => message.id)).not.toContain('batch-1');
});

it("F7-REPLAY: stale proof holds native/text rendering and the write fence; retained context starts fresh", () => {
  const messages = [row("history"), row("uncertain")];
  const before = selection(messages), entries = transcript(before.replayedMessages);
  exclude("uncertain", thread, "uncertain");
  expect(() => transcriptForDriver(entries, undefined, before.replayProof)).toThrow("SEND_REPLAY_CHANGED");
  expect(() => lineage.assertSendReplayProof(before.replayProof)).toThrow("SEND_REPLAY_CHANGED");
  const next = selection(messages);
  const result = buildTurnContext({ text: "NEW", transcript: entries, replayProof: next.replayProof,
    retainedReplayProof: before.replayProof, fresh: false, rewound: false, externallyUpdated: false, replaysNatively: false });
  expect(result.resume).toBe(false);
  expect(result.turnText).toContain("WORDS-history");
  expect(result.turnText).not.toContain("WORDS-uncertain");
  expect(transcriptForDriver(entries, undefined, next.replayProof).map(m => m.text)).toEqual(["WORDS-history"]);
});

it("F7-COPY: proof sees raw source changes, cycles, missing roots and replacement ancestry", () => {
  const original = row("original", undefined, "source");
  const copy = row("copy", { threadId: "source", messageIds: [original.id] });
  const proof = lineage.captureSendReplayProof(thread, [copy.id], lineage.replayCopyRoots([copy]));
  expect([...proof.excludedIds]).toEqual([]);
  exclude(original.id, "source");
  expect(lineage.sendReplayEpochsCurrent(proof.epochs)).toBe(false);
  expect(() => lineage.assertSendReplayProof(proof)).toThrow("SEND_REPLAY_CHANGED");
  const missing = row("missing", { threadId: "source", messageIds: ["gone"] });
  const cycle = row("cycle", { threadId: thread, messageIds: ["cycle"] });
  expect([...lineage.captureSendReplayProof(thread, [missing.id, cycle.id]).excludedIds]).toEqual(["missing", "cycle"]);
  const changed = { ...copy, copyOf: undefined };
  const db = database();
  db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify(changed), thread, copy.id);
  const mrow = Number(db.prepare("SELECT rowid FROM messages WHERE thread_id=? AND id=?").get(thread, copy.id)!.rowid);
  afterUpdate(db, thread, changed, mrow, false, false, "text");
  expect(lineage.sendReplayEpochsCurrent(proof.epochs)).toBe(false);
});

it("F7-COPY: streaming preserves a retained proof, changing existing copy ancestry invalidates it", () => {
  const original = row("stream-source", undefined, "source");
  const copy = row("stream-copy", { threadId: "source", messageIds: [original.id] });
  const proof = lineage.captureSendReplayProof(thread, [copy.id], lineage.replayCopyRoots([copy]));
  lineage.confirmFreshReplaySession(thread, "engine", "stream-session", proof);
  updateMessage(thread, { ...copy, text: "A growing reply" });
  expect(lineage.sendReplayEpochsCurrent(proof.epochs)).toBe(true);
  expect(lineage.sendReplaySessionCurrent(thread, "engine", "stream-session")).toBe(true);
  appendMessage(thread, { ...copy, id: "new-copy", parentId: copy.id });
  expect(lineage.sendReplayEpochsCurrent(proof.epochs)).toBe(true);
  expect(lineage.sendReplaySessionCurrent(thread, "engine", "stream-session")).toBe(true);
  updateMessage(thread, { ...copy, copyOf: undefined });
  expect(lineage.sendReplayEpochsCurrent(proof.epochs)).toBe(false);
  expect(lineage.sendReplaySessionCurrent(thread, "engine", "stream-session")).toBe(false);
});

it("F7-COPY: recall and checkpoint source readers cannot recover an excluded owner's input", () => {
  row("failed"); exclude("failed");
  const source = { thread_id: thread, message_id: "failed", speaker: "owner" };
  expect(lineage.capturedSourceWithheld(LineageAllowance.tool(), source)).toBe(true);
  expect(lineage.sourceIsWithheldMessage(LineageAllowance.tool(), source)).toBe(true);
});

async function restoreSnapshot(snapshot: string, file: string): Promise<void> {
  // The search worker reads this file through a read-only connection, and a read-only last closer cannot checkpoint or
  // remove the WAL. It leaves first, so the checkpointer's read-write connection is the last one to close.
  expect(await searchIndex.stopSearchIndex()).toBe(true);
  closeDatabase();
  // Close every registered connection, including the message writer, before replacing its SQLite file.
  await handles.settleTestHandles(DATA_DIR);
  expect(await Promise.all([walMaintenance.stopWalMaintenance(), searchIndex.stopSearchIndex()])).toEqual([true, true]);
  // Shutdown precondition, never a cleanup: a WAL left behind would be replayed onto the snapshot.
  expect(existsSync(`${file}-wal`) || existsSync(`${file}-shm`)).toBe(false);
  fs.copyFileSync(snapshot, file);
}

it("F7-RESTORE waits for all fixture handles before copying the snapshot", async () => {
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const settle = vi.spyOn(handles, "settleTestHandles").mockReturnValueOnce(closed);
  vi.spyOn(walMaintenance, "stopWalMaintenance").mockResolvedValue(true);
  vi.spyOn(searchIndex, "stopSearchIndex").mockResolvedValue(true);
  const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
  const restoring = restoreSnapshot(join(DATA_DIR, "order-snapshot.sqlite"), join(DATA_DIR, "order-restored.sqlite"));
  try {
    for (let turn = 0; turn < 4; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(settle).toHaveBeenCalledWith(DATA_DIR);
    expect(copy).not.toHaveBeenCalled();
  } finally {
    release();
    try { await restoring; expect(copy).toHaveBeenCalledTimes(1); }
    finally { vi.restoreAllMocks(); await handles.settleTestHandles(DATA_DIR); }
  }
});

it("F7-RESTORE refuses to copy over a WAL that shutdown left behind, and does not delete it", async () => {
  vi.spyOn(handles, "settleTestHandles").mockResolvedValue(undefined);
  vi.spyOn(walMaintenance, "stopWalMaintenance").mockResolvedValue(true);
  vi.spyOn(searchIndex, "stopSearchIndex").mockResolvedValue(true);
  const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);
  const target = join(DATA_DIR, "leftover-restored.sqlite");
  try {
    for (const suffix of ["-wal", "-shm"]) {
      fs.writeFileSync(`${target}${suffix}`, "stale");
      await expect(restoreSnapshot(join(DATA_DIR, "leftover-snapshot.sqlite"), target)).rejects.toThrow();
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(`${target}${suffix}`)).toBe(true);
      fs.rmSync(`${target}${suffix}`);
    }
    await restoreSnapshot(join(DATA_DIR, "leftover-snapshot.sqlite"), target);
    expect(copy).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); await handles.settleTestHandles(DATA_DIR); }
});

it("F7-RESTORE mechanism: only a read-write last closer removes the WAL", () => {
  const leftover = (readerLast: boolean): boolean => {
    const file = join(DATA_DIR, `last-closer-${readerLast}.sqlite`);
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v); INSERT INTO t VALUES(1)");
    const reader = new DatabaseSync(file, { readOnly: true });
    reader.prepare("SELECT count(*) FROM t").get();
    if (readerLast) { writer.close(); reader.close(); } else { reader.close(); writer.close(); }
    return existsSync(`${file}-wal`);
  };
  expect(leftover(true)).toBe(true);
  expect(leftover(false)).toBe(false);
});

it("F7-RESTORE: the search worker's read-only source reader has left before the server connection closes", async () => {
  const db = database(), file = String(db.prepare("PRAGMA database_list").all().find(r => r.name === "main")!.file);
  row("order");
  const snapshot = join(DATA_DIR, "f7-order-snapshot.sqlite");
  await backup(db, snapshot);
  const events: string[] = [];
  const stopSearch = searchIndex.stopSearchIndex, stopWal = walMaintenance.stopWalMaintenance;
  vi.spyOn(searchIndex, "stopSearchIndex").mockImplementation(async () => {
    events.push("search-stop"); const left = await stopSearch(); events.push(`search-left:${left}`); return left;
  });
  // closeDatabase asks the checkpointer to leave immediately after it closes the server connection.
  vi.spyOn(walMaintenance, "stopWalMaintenance").mockImplementation((...args) => { events.push("server-closed"); return stopWal(...args); });
  await restoreSnapshot(snapshot, file);
  expect(events.slice(0, 3)).toEqual(["search-stop", "search-left:true", "server-closed"]);
  expect(existsSync(`${file}-wal`) || existsSync(`${file}-shm`)).toBe(false);
  expect(database().prepare("SELECT id FROM messages WHERE thread_id=?").all(thread).map(r => r.id)).toEqual(["order"]);
});

it("F7-RESTORE: SQLite backup restores exclusions and source epochs before reader reuse", async () => {
  const messages = [row("history"), row("failed")]; exclude("failed");
  const db = database(), file = String(db.prepare("PRAGMA database_list").all().find(r => r.name === "main")!.file);
  const snapshot = join(DATA_DIR, "f7-snapshot.sqlite");
  await backup(db, snapshot);
  db.exec("DELETE FROM send_replay_exclusions; UPDATE send_replay_epochs SET revision=revision+1");
  await restoreSnapshot(snapshot, file);
  expect(selection(messages).replayedMessages.map(m => m.id)).toEqual(["history"]);
});

it("F7-REPLAY: proof and candidate reads use one SQLite snapshot; a concurrent exclusion invalidates dispatch", () => {
  const message = row("concurrent"), db = database();
  const file = String(db.prepare("PRAGMA database_list").all().find(r => r.name === "main")!.file);
  const other = new DatabaseSync(file);
  try {
    db.exec("BEGIN");
    db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(thread, message.id);
    other.exec("BEGIN; INSERT INTO send_replay_exclusions VALUES('f7-chat','concurrent',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('f7-chat',1); COMMIT");
    const proof = lineage.captureSendReplayProof(thread, [message.id], new Map(), db);
    expect(proof.excludedIds.size).toBe(0);
    db.exec("COMMIT");
    expect(() => lineage.assertSendReplayProof(proof)).toThrow("SEND_REPLAY_CHANGED");
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); other.close(); }
});
