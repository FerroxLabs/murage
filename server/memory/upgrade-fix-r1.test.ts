// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fix round for the upgrade-fast review (lanes/upgfast-review/r1/REPORT.md). One test (or more) per finding, each written to fail on
// aaf4d5e60 first.
import { existsSync, mkdirSync } from "node:fs";
import { beforeEach, expect, it, afterEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { legacyFile, restartLegacy } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { collectRootSets } from "./root-set-compaction.ts";
import { validateMemorySchema } from "./schema.ts";
import { lineageRepairPending, repairOutputRootBackfillSteps, rootSetMembers } from "./schema.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

/** A conversation of `n` question/answer pairs, a receipt on every answer. Returns the answers' ids. */
function longChat(n: number): string[] {
  const db = database();
  const put = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,?,'text','t',?)");
  const answers: string[] = [];
  for (let i = 0; i < n; i++) {
    const user = `U${i}`, bot = `B${i}`;
    put.run(user, i * 10, "user", JSON.stringify({ id: user, at: i * 10, role: "user", kind: "text", text: "t", parentId: i ? `B${i - 1}` : null }));
    put.run(bot, i * 10 + 1, "bot", JSON.stringify({ id: bot, at: i * 10 + 1, role: "bot", kind: "text", text: "t", parentId: user }));
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?, 'chat','engine','S','[]','[]',?,0,0,0,'delivered',1)")
      .run(`R${i}`, JSON.stringify([bot]));
    answers.push(bot);
  }
  return answers;
}
const unprovable = () => {
  const db = database();
  return db.prepare("SELECT thread_id,message_id,set_id FROM memory_output_roots WHERE thread_id='chat'").all()
    .filter(row => String(row.set_id) !== "" && rootSetMembers(db, String(row.set_id)) === null).length;
};

it("F1: root-set collection never runs while a lineage repair is unfinished, so no reply loses its set (600 replies)", () => {
  const db = legacyFile(database()); // v10 never has a repair pending (lineageRepairPending); a 1.0.1-shaped connection does
  longChat(600);
  db.exec("DELETE FROM memory_output_roots; DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-lineage-backfill%'");
  expect(lineageRepairPending(db)).toBe(true);
  let collected = 0;
  const steps = repairOutputRootBackfillSteps(db, { sliceMs: 0, waitBusy: true });
  for (let step = steps.next(); !step.done; step = steps.next()) collected += collectRootSets(db, 10_000); // an idle sweep between two yields
  expect(collected).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM memory_output_roots WHERE thread_id='chat'").get()!.n).toBeGreaterThan(0);
  expect(unprovable()).toBe(0);
  // once the repair has finished the sets that nothing points at are collected as before
  db.exec("INSERT INTO memory_root_sets(set_id,size) VALUES('orphan',0)");
  expect(lineageRepairPending(db)).toBe(false);
  expect(collectRootSets(db, 10_000)).toBeGreaterThan(0);
});

it("F1: a repair stopped by a restart still protects its sets (the pending state is persisted, not cached)", () => {
  const db = legacyFile(database());
  longChat(600);
  db.exec("DELETE FROM memory_output_roots; DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-lineage-backfill%'");
  const steps = repairOutputRootBackfillSteps(db, { sliceMs: 0, waitBusy: true });
  for (let i = 0; i < 3; i++) steps.next();
  const again = restartLegacy();
  expect(collectRootSets(again, 10_000)).toBe(0);
  const resumed = repairOutputRootBackfillSteps(again, { sliceMs: 0, waitBusy: true });
  for (let step = resumed.next(); !step.done; step = resumed.next()) collectRootSets(again, 10_000);
  expect(unprovable()).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// shared: a v6 (1.0.1) file in the data directory, opened by the current build
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { finishBackgroundUpgradeWorkNow } from "../database.ts";
import { replayExclusions, ancestryWithheld } from "./replay-lineage.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
const FILE = () => join(DATA_DIR, "messages.db");
const SHAPE = { threads: 30, perThread: 40, payloadBytes: 200, receiptsPerThread: 3, setThreads: 3, repliesPerSetThread: 10 };
function v6(edit: (db: DatabaseSync) => void = () => {}) {
  const built = buildSyntheticV6(FILE(), SHAPE);
  const raw = new DatabaseSync(FILE());
  try { raw.exec("PRAGMA foreign_keys=OFF"); edit(raw); } finally { raw.close(); }
  return built;
}

it("F2: while the integrity pass is unfinished replay is withheld for every thread, even where the unproven output index holds no row", () => {
  // the index lost every entry of thread t0 (what the pass is there to find)
  v6(raw => raw.exec("DROP TRIGGER IF EXISTS memory_disclosure_outputs_d; DELETE FROM memory_disclosure_outputs WHERE thread_id='t0'"));
  const db = database();
  expect(db.prepare("SELECT 1 FROM memory_disclosure_outputs WHERE thread_id='t0'").get()).toBeUndefined();
  expect(ancestryWithheld(db, "t0")).toBe(true);
  expect(ancestryWithheld(db, "no-such-thread")).toBe(true);
  // an initial reply (receipt output, no independent root dependency) is not shown
  const lines = [{ id: "m0-1", role: "bot" }, { id: "m0-0", role: "user" }];
  expect([...replayExclusions(LineageAllowance.tool(), "t0", lines, null, { failClosed: true })]).toEqual(["m0-1"]);
  expect([...replayExclusions(LineageAllowance.tool(), "t5", [{ id: "m5-1", role: "bot" }], null)]).toEqual(["m5-1"]);
  // the pass rebuilds the index from the receipts and passes: replay opens
  finishBackgroundUpgradeWorkNow();
  expect(ancestryWithheld(db, "t0")).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { addLesson, renderLearnedBlock, insertLesson } from "./lessons.ts";
import { recordFeedback } from "./feedback.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { readIntegrityPass } from "./integrity-state.ts";
import { pinLearnedForTurn } from "../bot-shapes.ts";

const LEARNING = { enabled: true, askFirst: false } as never;
const render = (db: DatabaseSync) => renderLearnedBlock(db, { botId: "bot1", threadId: "t0", ownerAudience: true });
/** An active note made before the upgrade, with its ledger event, written the way 1.0.1 left it. */
function oldLesson(raw: DatabaseSync, id: string, text: string, event: boolean) {
  const scope = "scope-bot1";
  raw.exec(`INSERT OR IGNORE INTO memory_scopes VALUES('${scope}','bot','bot1','[]',0)`);
  if (event) raw.exec(`INSERT INTO memory_learning_events(id,scope_id,kind,bot_id,detail,created_at) VALUES('ev-${id}','${scope}','lesson-learned','bot1','{"lessonId":"${id}","lessonVersion":1,"lessonKind":"note","origin":"typed"}',1000)`);
  raw.exec(`INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,learning_event_id,created_at,decided_at) VALUES('${id}',1,'bot1','bot','note','${text}','typed','active','ev-${id}',1000,1000)`);
}

it("F3: until the pass has passed, a lesson that predates the upgrade is not shown, one made after it is, and the proof opens them", () => {
  v6(raw => oldLesson(raw, "old", "Always greet me by name.", true));
  const db = database();
  expect(readIntegrityPass(db)!.finishedAt).toBeNull();
  expect(render(db).text).not.toContain("greet me by name");
  const made = addLesson(db, { botId: "bot1", origin: "typed", learning: LEARNING, text: "Keep answers short.", scope: "bot", now: readIntegrityPass(db)!.startedAt + 1 });
  expect(made.status).toBe("applied");
  const during = render(db).text;
  expect(during).toContain("Keep answers short.");
  expect(during).not.toContain("greet me by name");
  // the room-turn / channel reading follows the same rule
  expect(renderLearnedBlock(db, { botId: "bot1", threadId: "t0", ownerAudience: false }).text).not.toContain("greet me by name");
  finishBackgroundUpgradeWorkNow();
  expect(readIntegrityPass(db)!.result).toBe("passed");
  expect(render(db).text).toContain("greet me by name");
});

it("F3: when the pass holds memory no learned block renders, and lessons, feedback and learning events are refused; chats are unaffected", () => {
  // an active lesson whose learning event is gone: the proof finds it
  v6(raw => oldLesson(raw, "orphan", "Never use bullet points.", false));
  const db = database();
  finishBackgroundUpgradeWorkNow();
  expect(readIntegrityPass(db)!.result).toBe("held:INVALID_MEMORY_LESSON_EVENT");
  expect(render(db)).toMatchObject({ text: "" });
  const lessons = () => Number(db.prepare("SELECT count(*) AS n FROM memory_lessons").get()!.n);
  const events = () => Number(db.prepare("SELECT count(*) AS n FROM memory_learning_events").get()!.n);
  const before = { lessons: lessons(), events: events() };
  expect(addLesson(db, { botId: "bot1", origin: "typed", learning: LEARNING, text: "New note.", scope: "bot" })).toMatchObject({ status: "refused", reason: "memory-held" });
  expect(() => insertLesson(db, { id: "x", botId: "bot1", scope: "bot", kind: "note", text: "x", origin: "typed", state: "active", evidence: null, prospectDerived: false, learningEventId: null, createdAt: 1, decidedAt: 1 })).toThrow(/set memory aside/);
  expect(() => recordLearningEvent(db, { kind: "lesson-learned", scopeId: "scope-bot1", botId: "bot1", detail: {} })).toThrow(/set memory aside/);
  expect(recordFeedback(db, { id: "fb1", botId: "bot1", threadId: "t0", messageId: "m0-0", turn: null, decision: { target: { action: "reply" }, polarity: "-", strength: 2, correction: "no", confidence: 1, state: "detected" } as never, now: 5 })).toBe(false);
  expect({ lessons: lessons(), events: events() }).toEqual(before);
  // a turn being prepared when the hold appears: the block pinned earlier is not served again
  let allowed = true;
  const pinned = pinLearnedForTurn("held-turn", () => ({ text: "<what-it-learned>x</what-it-learned>", lessonIds: ["a"], feedbackIds: [], digest: "d" }), () => allowed);
  expect(pinned.text).toContain("what-it-learned");
  allowed = false;
  expect(pinLearnedForTurn("held-turn", () => pinned, () => allowed).text).toBe("");
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { memoryState } from "./repository.ts";
import { memoryIntegrityStatus } from "../database.ts";

it("F4: the background pass makes the shape checks the second validation used to make: an old marked scope whose audience became {} holds memory", () => {
  // the 1.0.1 shape marker already covers the scope (it was written at the last open), so the incremental open cannot see the edit
  v6(raw => { raw.exec("UPDATE memory_scopes SET audience='{}' WHERE id='scope-workspace'"); });
  const db = database();
  expect(readIntegrityPass(db)!.finishedAt).toBeNull();
  finishBackgroundUpgradeWorkNow({ integrity: { shapeSlice: 1 } });
  expect(readIntegrityPass(db)!.result).toBe("held:INVALID_MEMORY_JSON_SHAPE");
  expect(memoryState().mode).toBe("paused");
  expect(memoryIntegrityStatus().hold).toBe("INVALID_MEMORY_JSON_SHAPE");
  expect(memoryIntegrityStatus().holdMessage).toMatch(/set memory aside/);
  // nothing was deleted
  expect(db.prepare("SELECT audience FROM memory_scopes WHERE id='scope-workspace'").get()!.audience).toBe("{}");
});

it("F4: an untouched file passes the shape, assertion and details checks in slices and the pass ends passed", () => {
  v6();
  const db = database();
  finishBackgroundUpgradeWorkNow({ integrity: { shapeSlice: 1 } });
  expect(readIntegrityPass(db)!.result).toBe("passed");
  expect(memoryIntegrityStatus().hold).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { prepareMessageSearchBackfill, stepMessageSearchBackfill } from "../message-search-index.ts";

it("F5: a restart resumes the persisted unfinished search fill; a live write beyond the history never moves the cursor past rows 2 and 3", () => {
  const db = database();
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  for (let r = 1; r <= 4; r++) db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?, 'ts', ?, ?, 'user', 'text', ?, '{}')").run(r, `s${r}`, r, `searchable words ${r}`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  expect(stepMessageSearchBackfill(db, 1).more).toBe(true); // row 1 indexed
  db.prepare("INSERT INTO messages_fts(rowid, t) VALUES (4, 'searchable words 4')").run(); // a live write of this run indexed row 4 itself
  // restart: the preparation at open
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  const state = db.prepare("SELECT done,cursor FROM transcript_index_state WHERE name='search_fts'").get()!;
  expect(Number(state.done)).toBe(0);
  expect(Number(state.cursor)).toBe(1);
  for (let guard = 0; guard < 20 && stepMessageSearchBackfill(db, 1).more; guard++);
  expect(db.prepare("SELECT id FROM messages_fts_docsize ORDER BY id").all().map(r => Number(r.id))).toEqual([1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { downgradeMemorySchema, UPGRADE_DERIVED_TABLES } from "./schema.ts";
import { closeDatabase as closeDb } from "../database.ts";

// git archive d950cbf67 (1.0.1) into the gitignored .murage-scratch/v101; the test is skipped where it is absent
const V101 = resolve(process.cwd(), ".murage-scratch/v101/server");
const INSPECT = resolve(process.cwd(), ".murage-scratch/tools/inspect101.mjs");
it.skipIf(!existsSync(V101))("F6: a file taken back to v6 passes the real 1.0.1 inspector: no new table, marker or completion state is left behind", () => {
  v6();
  const db = database();
  finishBackgroundUpgradeWorkNow();
  // everything the 1.0.2 build derives is present before the downgrade
  // (the conversion's worklist exists only while a conversion has sets to go through)
  for (const table of UPGRADE_DERIVED_TABLES.filter(name => name !== "upgrade_root_set_worklist")) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table), table).toBeTruthy();
  closeDb();
  const raw = new DatabaseSync(FILE());
  try {
    raw.exec("PRAGMA foreign_keys=ON");
    expect(downgradeMemorySchema(raw, 6).status).toBe("downgraded");
    for (const table of UPGRADE_DERIVED_TABLES) expect(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    // (owner_sends and project_card_delivery_owed are other 1.0.2 lanes' tables and hold owner data: the downgrade keeps them, so the
    // inspector comparison sets them aside)
    raw.exec("DROP TABLE IF EXISTS owner_sends; DROP TABLE IF EXISTS project_card_delivery_owed");
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { raw.close(); }
  const out = execFileSync("node", [INSPECT, V101, FILE()], { env: { ...process.env, MURAGE_DATA_DIR: join(DATA_DIR, "inspector-home") }, encoding: "utf8" });
  const result = JSON.parse(out.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
  expect(result).toMatchObject({ ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { compactRootSetsStep, COMPACTION_MAX_CUT_ROWS } from "./root-set-compaction.ts";

/** Two full sets of one thread: `small` members, and `big` members that include them. */
function twoFullSets(small: number, big: number) {
  const db = legacyFile(database()); // the compaction is a no-op on a v10 file (see the v10 test below)
  db.exec("DELETE FROM memory_root_set_compaction");
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES('p-set',?),('s-set',?)").run(small, big);
  db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'p-set','big-thread','m'||printf('%08d',i) FROM n").run(small);
  db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 's-set','big-thread','m'||printf('%08d',i) FROM n").run(big);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('big-thread','r1','p-set'),('big-thread','r2','s-set')").run();
  db.prepare("INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,2,0,'',1)").run();
  return db;
}
it("F7 (v10): on a v10 file the compaction step does nothing: no set is converted or cut, and no row is read", () => {
  const db = database();
  db.exec("DELETE FROM memory_root_set_compaction");
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES('p-set',2),('s-set',4)").run();
  db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES('p-set','t','a'),('p-set','t','b'),('s-set','t','a'),('s-set','t','b'),('s-set','t','c'),('s-set','t','d')").run();
  db.prepare("INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,2,0,'',1)").run();
  expect(compactRootSetsStep(db, { maxMs: 5 })).toEqual({ remaining: false, examined: 0, converted: 0, rows: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id='s-set'").get()!.n).toBe(4);
  expect(db.prepare("SELECT 1 FROM memory_root_set_parents WHERE set_id='s-set'").get()).toBeUndefined();
});
function runSteps(db: DatabaseSync, budget: { maxMs: number; chunkRows?: number }) {
  const times: number[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const began = performance.now();
    const step = compactRootSetsStep(db, budget);
    times.push(performance.now() - began);
    if (!step.remaining) return times;
  }
  throw new Error("the conversion did not finish");
}
const members = (db: DatabaseSync, id: string) => Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id=?").get(id)!.n);

it("F7: a huge single set is read in chunks under the budget (no step holds the thread for long) and a set within the cut bound is converted to what it adds", () => {
  // (r8: the cut bound is 20,000 rows; the predecessor sits within it)
  const db = twoFullSets(18_000, 36_000);
  const times = runSteps(db, { maxMs: 5, chunkRows: 2_000 });
  // the work was cut into many steps, each ending within a chunk or two of the budget
  expect(times.length).toBeGreaterThan(10);
  expect(Math.max(...times)).toBeLessThan(400);
  expect(members(db, "s-set")).toBe(18_000);
  expect(db.prepare("SELECT parent_id FROM memory_root_set_parents WHERE set_id='s-set'").get()!.parent_id).toBe("p-set");
  expect(members(db, "p-set")).toBe(18_000);
});

it("F7 (r3): a set whose predecessor is past the cutting bound stays full, decided before any member is read: no step spends time on it and the temporary table never holds a row", () => {
  const db = twoFullSets(COMPACTION_MAX_CUT_ROWS + 10_000, COMPACTION_MAX_CUT_ROWS + 20_000);
  let tempRows = 0;
  for (let guard = 0; guard < 1_000; guard++) {
    const step = compactRootSetsStep(db, { maxMs: 5, chunkRows: 2_000 });
    // the table exists once a step has reached the conversion; on a slow runner the first steps end in the enumeration, before it is made (absent reads as no rows)
    if (db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='memory_root_set_below'").get()) tempRows = Math.max(tempRows, Number(db.prepare("SELECT count(*) AS n FROM temp.memory_root_set_below").get()?.n ?? 0));
    if (!step.remaining) break;
  }
  expect(tempRows).toBe(0);
  expect(members(db, "s-set")).toBe(COMPACTION_MAX_CUT_ROWS + 20_000);
  expect(db.prepare("SELECT 1 FROM memory_root_set_parents WHERE set_id='s-set'").get()).toBeUndefined();
  expect(db.prepare("SELECT finished_at FROM memory_root_set_compaction WHERE id=1").get()!.finished_at).not.toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { openRequestCardsStatus, OPEN_CARD_SLICE_ROWS } from "../message-db.ts";
import { prioritizeThread, readIndexState, stepPriorityThreads, writeIndexState } from "../transcript-backfill.ts";
import { walkMessagesChunk } from "../message-walker.ts";
import { BROWSER_CHECKING_REASON, browserUnavailableActivityName } from "../../shared/browser-unavailable.ts";
import { backgroundJobsPending } from "./upgrade-background.ts";
import { runBackgroundUpgradeWorkToEnd } from "./upgrade-background.ts";

function longThread(db: DatabaseSync, thread: string, rows: number, cardAt: number[]) {
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= rows; i++) {
    const card = cardAt.includes(i);
    const message = { id: `${thread}-${i}`, at: i, role: "bot", kind: card ? "options" : "text", text: "t", parentId: i > 1 ? `${thread}-${i - 1}` : null, turnId: `turn-${Math.ceil(i / 10)}`,
      ...(card ? { card: { requestId: `req-${i}`, options: [] } } : {}) };
    put.run(thread, message.id, i, "bot", message.kind, "t", JSON.stringify(message));
  }
  db.exec("COMMIT");
}
const unfinishedIndexes = (db: DatabaseSync) => db.exec("DELETE FROM open_card; DELETE FROM browser_check_pending; DELETE FROM turn_first; DELETE FROM transcript_index_state WHERE name IN ('open_card','browser_check','turn_first')");

it("F8: while the card index is unfinished a long thread is read through a bounded look at its newest rows, flagged incomplete, and prepared first by the walker", () => {
  const db = database();
  longThread(db, "long", 3000, [40, 2900]);
  unfinishedIndexes(db);
  const sql: string[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (text: string) => unknown }).prepare = (text: string) => { sql.push(text); return real(text); };
  const first = openRequestCardsStatus("long", 10);
  (db as unknown as { prepare: unknown }).prepare = real;
  // only the newest card is in the look; the older one is not claimed, and the answer says so
  expect(first.cards.map(card => card.message.id)).toEqual(["long-2900"]);
  expect(first.incomplete).toBe(true);
  // the look is a bounded read of the thread (a LIMIT), never the whole history
  expect(sql.some(text => /FROM messages WHERE thread_id = \? ORDER BY rowid DESC LIMIT \?/.test(text))).toBe(true);
  expect(OPEN_CARD_SLICE_ROWS).toBeLessThan(3000);
  // the walker prepares that thread before the rest of the history
  while (stepPriorityThreads(db, 1000)) { /* chunks */ }
  const second = openRequestCardsStatus("long", 10);
  expect(second.cards.map(card => card.message.id)).toEqual(["long-2900", "long-40"]);
  expect(second.incomplete).toBe(false);
  expect(readIndexState(db, "open_card").done).toBe(0); // the rest of the history is still to walk
  // a thread short enough to be seen whole is complete at once
  longThread(db, "short", 30, [3]);
  prioritizeThread(db, "short");
  expect(openRequestCardsStatus("short", 10)).toMatchObject({ incomplete: false });
  expect(openRequestCardsStatus("short", 10).cards).toHaveLength(1);
});

it("F8: one walker reads the messages once for the open cards, the pending browser notes and the first row of every turn, and the background runs it first", () => {
  const db = database();
  longThread(db, "w", 500, [7, 450]);
  const note = JSON.stringify({ id: "chk", at: 9999, role: "bot", kind: "activity", tool: { name: browserUnavailableActivityName(BROWSER_CHECKING_REASON), ok: true } });
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('w','chk',9999,'bot','activity','',?)").run(note);
  unfinishedIndexes(db);
  const sql: string[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (text: string) => unknown }).prepare = (text: string) => { sql.push(text); return real(text); };
  let chunks = 0, completed: string[] = [];
  for (let step = walkMessagesChunk(db, 100); ; step = walkMessagesChunk(db, 100)) { chunks++; completed = [...completed, ...step.completed]; if (!step.more) break; }
  (db as unknown as { prepare: unknown }).prepare = real;
  // one read of the rows per window, not one per structure
  expect(sql.filter(text => /FROM messages WHERE rowid > \? AND rowid <= \?/.test(text)).length).toBe(chunks);
  expect(completed.sort()).toEqual(["browser_check", "open_card", "turn_first"]);
  expect(db.prepare("SELECT id FROM open_card ORDER BY id").all().map(row => String(row.id))).toEqual(["w-450", "w-7"]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM turn_first").get()!.n)).toBe(50);
  expect(Number(db.prepare("SELECT first_rowid AS r FROM turn_first WHERE turn_id='turn-3'").get()!.r)).toBe(21);
  for (const name of ["open_card", "browser_check", "turn_first"]) expect(readIndexState(db, name).done).toBe(1);
  // the walker leads the queue of background jobs, and a browser-check completion starts the recovery that waited for it
  unfinishedIndexes(db);
  expect(backgroundJobsPending(db)[0]).toBe("message-index");
  let recovered = 0;
  runBackgroundUpgradeWorkToEnd(db, { onBrowserChecksIndexed: () => { recovered++; } });
  expect(recovered).toBe(1);
  expect(Number(db.prepare("SELECT count(*) AS n FROM browser_check_pending").get()!.n)).toBe(1);
  writeIndexState(db, "open_card", { done: 1, cursor: 0, skipped: 0 });
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { UpgradeProgressTracker, upgradeCounts } from "./upgrade-progress.ts";
import { overallWriter, readOverallFloor, clearOverall, STARTING_SHARE, UPGRADE_OVERALL_FILE } from "./upgrade-overall.ts";
import { startBackgroundUpgrade } from "../database.ts";

it("F9: starting the background work issues no checkpoint at all (no synchronous wal_checkpoint(TRUNCATE) after listen)", () => {
  v6();
  const db = database();
  const statements: string[] = [];
  const realExec = db.exec.bind(db), realPrepare = db.prepare.bind(db);
  (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => { statements.push(sql); return realExec(sql); };
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { statements.push(sql); return realPrepare(sql); };
  try {
    const handle = startBackgroundUpgrade();
    handle.stop();
  } finally { (db as unknown as { exec: unknown }).exec = realExec; (db as unknown as { prepare: unknown }).prepare = realPrepare; }
  expect(statements.filter(sql => /wal_checkpoint/i.test(sql))).toEqual([]);
});

it("F12: overall is one monotone launch-wide value: the blocking stage owns its share, the background work the rest, and a restart never shows a lower number", () => {
  let clock = 1_000_000;
  const now = () => clock;
  const saved: number[] = [];
  const start = new UpgradeProgressTracker("starting", upgradeCounts(null), [{ id: "checking", weight: 1 }, { id: "migrating", weight: 3 }], now, {}, { from: 0, to: STARTING_SHARE, persist: value => { saved.push(value); } });
  start.update("checking", 0, 10);
  start.update("migrating", 3, 4);
  const startSnap = start.snapshot(true);
  expect(startSnap.overall).toBeGreaterThan(0);
  expect(startSnap.overall).toBeLessThanOrEqual(STARTING_SHARE);
  // the background stage begins from where the blocking stage ended, and its own fraction starting at zero does not pull the value back
  const background = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "message-index", weight: 1 }, { id: "integrity", weight: 1 }], now, {}, { from: STARTING_SHARE, to: 1, floor: startSnap.overall });
  const first = background.snapshot(true);
  expect(first.overall).toBeGreaterThanOrEqual(startSnap.overall);
  background.update("message-index", 50, 100);
  const half = background.snapshot(true);
  expect(half.overall).toBeGreaterThan(first.overall);
  // a stage that learns its true size later (a phase total that grows) never lowers it
  background.update("message-index", 50, 400);
  expect(background.snapshot(true).overall).toBeGreaterThanOrEqual(half.overall);
  // a restart: a new tracker over what is left starts from the persisted mark (kept in a file), and grows from there to 1
  const restarted = new UpgradeProgressTracker("background", upgradeCounts(null), [{ id: "integrity", weight: 1 }], now, {}, { from: STARTING_SHARE, to: 1, floor: half.overall });
  expect(restarted.snapshot(true).overall).toBeGreaterThanOrEqual(half.overall);
  restarted.update("integrity", 1, 2);
  const mid = restarted.snapshot(true).overall;
  expect(mid).toBeGreaterThan(half.overall);
  restarted.finishAll();
  expect(restarted.snapshot(false).overall).toBe(1);
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.every((value, i) => i === 0 || value >= saved[i - 1]!)).toBe(true);
});

it("F12: the high-water mark is kept in a file, read back for the same upgrade only, and cleared when the upgrade is complete", () => {
  const dir = join(DATA_DIR, "overall");
  mkdirSync(dir, { recursive: true });
  const write = overallWriter(dir, 8, () => 5_000_000);
  write(0.4, true);
  expect(readOverallFloor(dir, 8, 5_000_100)).toBeCloseTo(0.4);
  expect(readOverallFloor(dir, 9, 5_000_100)).toBe(0); // another memory version: another upgrade
  expect(readOverallFloor(dir, 8, 5_000_000 + 15 * 24 * 3600 * 1000)).toBe(0); // given up long ago
  clearOverall(dir);
  expect(existsSync(join(dir, UPGRADE_OVERALL_FILE))).toBe(false);
  expect(readOverallFloor(dir, 8)).toBe(0);
});

it("F12: the upgrade reports overall in the health answer's memoryIntegrity and in the note's progress, and the counts are null with exact false until counted", () => {
  v6();
  const db = database();
  const handle = startBackgroundUpgrade();
  try {
    const status = memoryIntegrityStatus();
    expect(typeof status.overall).toBe("number");
    expect(status.overall).toBeGreaterThanOrEqual(0);
    expect(status.overall).toBeLessThanOrEqual(1);
    expect(status.progress).toMatchObject({ stage: "background" });
    expect(typeof status.progress!.overall).toBe("number");
    expect(status.complete).toBe(false);
    expect(status.progress!.counts).toHaveProperty("exact");
    expect(status.progress!.counts).not.toHaveProperty("approximate");
  } finally { handle.stop(); }
  finishBackgroundUpgradeWorkNow();
  expect(memoryIntegrityStatus().complete).toBe(true);
  expect(readIntegrityPass(db)!.result).toBe("passed");
});

it("F12: a held pass is finished but not complete", () => {
  v6(raw => raw.exec("INSERT INTO memory_scope_bindings VALUES('orphan2','no-such-scope','system','x',0,'granted','{}')"));
  database();
  finishBackgroundUpgradeWorkNow();
  expect(memoryIntegrityStatus()).toMatchObject({ complete: false, hold: "INVALID_MEMORY_REFERENCE" });
});

// ---------------------------------------------------------------------------------------------------------------------------------
import { createCountsBlock, readCountsBlock, startExactCounts, UPGRADE_COUNTS_FILE } from "./upgrade-counts.ts";
import { installWriteRevisionTriggers } from "../app-write-revision.ts";

const waitFor = async <T>(read: () => T | null, ms = 10_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) { const value = read(); if (value !== null) return value; if (Date.now() > until) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
};

it("exact counts: a worker counts on its own read-only connection, publishes nothing until exact, caches for an untouched file, and recounts after a write", async () => {
  v6();
  database();
  closeDatabase();
  const cacheFile = join(DATA_DIR, UPGRADE_COUNTS_FILE);
  // the server's own connection stays open while the worker reads (as it does in the server)
  const main = new DatabaseSync(FILE());
  main.exec("PRAGMA journal_mode=WAL");
  installWriteRevisionTriggers(main); // as the server's own connection does: every counted write moves the revision the figures are keyed to
  // rowids 1 and 1,200,000: a high-water mark is not a count
  main.exec("DELETE FROM messages; DELETE FROM thread_state");
  main.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(1,'a','x1',5,'user','text','one','{}'),(1200000,'a','x2',9,'user','text','two','{}')").run();
  main.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES('a',NULL)").run();
  try {
    const first = createCountsBlock();
    expect(readCountsBlock(first)).toBeNull(); // nothing is published before it is counted
    const worker = startExactCounts(FILE(), cacheFile, first);
    const counted = await waitFor(() => readCountsBlock(first));
    worker.stop();
    expect(counted).toMatchObject({ messages: 2, conversations: 1, firstMessageAt: 5 });
    // untouched since: a second launch reads the figures from the cache at once
    await waitFor(() => (existsSync(cacheFile) ? true : null));
    const cachedBlock = createCountsBlock();
    const second = startExactCounts(FILE(), cacheFile, cachedBlock);
    expect(await waitFor(() => readCountsBlock(cachedBlock))).toMatchObject({ messages: 2 });
    second.stop();
    // any write since: the cache is not trusted, the figures are counted again
    main.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('a','x3',11,'user','text','three','{}')").run();
    const thirdBlock = createCountsBlock();
    const third = startExactCounts(FILE(), cacheFile, thirdBlock);
    expect(await waitFor(() => readCountsBlock(thirdBlock))).toMatchObject({ messages: 3 });
    third.stop();
  } finally { main.close(); }
});

it("probe: the blocking upgrade drops no index and builds none over the receipts (both measured at minutes on a real history), and the result passes the structure check", () => {
  v6();
  const db = database();
  const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(name));
  expect(has("memory_root_set_members_root")).toBe(true);   // the v6 member index stays until the owner's space hand-back
  expect(has("memory_disclosures_state")).toBe(false);      // optional: building it reads every receipt row through its overflow pages
  expect(() => validateMemorySchema(db)).not.toThrow();
  // a fresh installation still gets the index (its table is empty)
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  expect(Boolean(database().prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='memory_disclosures_state'").get())).toBe(true);
});
