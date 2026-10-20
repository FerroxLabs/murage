// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the seventh upgrade-ui review (lanes/upgui-review/r7/REPORT.md and FABLE-REPORT.md). Large root-set proofs live in this process only and
// are built by the recovery scheduler; a turn never walks a large set, and a session resting on one not yet proven resets ("checking"). Nothing proven
// before a restart is trusted after it. Then: a start reconciles an unchanged roster with no search by owner and reads one page of open cards before
// listen; a list completed during the rowid sweep is handed over explicitly; the sweep marks are durable insertion cursors; and the restart marker of an
// interrupted direct turn is a point check and a point append.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
// 1.0.2 S6: and the judge is kept deciding on the file (read-time-retired.ts forceReadTimeJudgeForTest): the subject is the retired root-set machinery,
// which stays in the tree until its mechanical deletion; the write-time behaviour is covered by the lookups' own tests.
beforeEach(() => { thawRootSetWritesForTest(true); forceReadTimeJudgeForTest(true); });
afterEach(() => { thawRootSetWritesForTest(false); forceReadTimeJudgeForTest(false); });
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { cardSweepThrough, deleteThread, insertMessage, keepCardSweepThrough, markDirectTurnsWalked, messagesHighWater, openCardPageRowsRead, openQuestionCardMessages, readMessage, setActiveLeaf, updateMessage } from "../message-db.ts";
import { dismissStalePeerCards, settleStaleCardPage, settleStaleCardsFromList, stalePeerCardKind, type ApprovalBus } from "../peer-approval.ts";
import { staleHostConsentCardKind } from "../host-computer-consent.ts";
import { Store, type Message } from "../store.ts";
import { ensureOpenCardIndex } from "../transcript-backfill.ts";
import { captureSource } from "./capture.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { LARGE_ROOT_SET, TURN_JUDGE_MAX, advanceRootSetProofs, capturedMessageWithheld, copyOriginVerdict, forgetKeptLineageForTest, rootSetProofsPending, setRootSetCeilingForTest, setVerdictLimitForTest } from "./replay-lineage.ts";
import { resetRootSetWork, rootSetWork } from "./root-set-handles.ts";
import { setMemoryMode } from "./repository.ts";
import { SCOPE_OWNER_INDEX, rebuildOutputIndexSlice } from "./schema.ts";
import { scopeLookups } from "./scope-id.ts";
import { stepIntegrityPass } from "./integrity-pass.ts";
import { startBackgroundUpgradeWork } from "./upgrade-background.ts";
import { COMPACTION_MAX_CUT_ROWS, collectCursorWriteCount, collectRootSetsSlice } from "./root-set-compaction.ts";
import { beginIntegrityPass, integrityHoldOf, readIntegrityPass } from "./integrity-state.ts";
import { forceReadTimeJudgeForTest } from "./read-time-retired.ts";
import { LineageAllowance, ROWS_PER_NODE, TURN_LINEAGE_NODES } from "./lineage-allowance.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";

const fresh = () => { closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); };
beforeEach(fresh);
afterEach(() => { setRootSetCeilingForTest(null); setVerdictLimitForTest(null); });

/** Rows handed back by every statement, counted at the SQL layer (the connection is opened after the wrapper is in place). */
const tally = { rows: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    own.get = (...args) => { const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });

// ── the root-set proofs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function bigSet(db: DatabaseSync, id: string, size: number, extra: Array<[string, string]> = []) {
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, size);
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?1,'th','m'||printf('%07d',i) FROM k").run(id, size - extra.length);
  for (const [t, m] of extra) db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES(?,?,?)").run(id, t, m);
}
/** Conversation C's retained engine session rests on `setId`. */
const retain = (db: DatabaseSync, setId: string) => {
  db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES('C','d','sess',?)").run(setId);
  // and the session's write-time lineage row, as index.ts retainSession writes it: without it the write-time session lookup answers "checking" once lines are stored
  markSessionKnown("C", "d", "sess");
};
const sessionCheck = () => { const why: { reason?: string } = {}; const bad = retainedSessionInvalid(LineageAllowance.tool(), "C", "d", "sess", why); return { bad, reason: why.reason }; };
/** The recovery scheduler's passes until no proof is asked for; the members each judged. */
function passes(limit = 200): number[] {
  const members: number[] = [];
  while (rootSetProofsPending() && members.length < limit) members.push(advanceRootSetProofs(4_000).members);
  return members;
}
/** C's reply-1, made under a receipt that cites `sourceId` at its current revision, is a member of a 20,001-member set C's session rests on. */
function citedReply(db: DatabaseSync, sourceId: string, size = 20_001) {
  const revision = Number(db.prepare("SELECT revision FROM memory_sources WHERE id=?").get(sourceId)!.revision);
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b1','C','d','[]',?,'[\"reply-1\"]',0,0,0,'delivered',9)")
    .run(JSON.stringify([{ id: sourceId, revision }]));
  bigSet(db, "big", size, [["C", "reply-1"]]);
  retain(db, "big");
}

it("r8 (r7 P1-1): a revised source a member's receipt cites ends the proof: the reply, the set and the retained session agree", () => {
  setMemoryMode("active");
  const db = database();
  captureSource(db, { id: "doc:secret", threadId: "C", kind: "text", speaker: "owner", outcome: "recorded", text: "the first words" });
  citedReply(db, "doc:secret");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" }); // not walked by the turn
  expect(passes()).toHaveLength(Math.ceil(20_001 / 4_000));
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
  captureSource(db, { id: "doc:secret", threadId: "C", kind: "text", speaker: "owner", outcome: "recorded", text: "other words entirely" });
  expect(capturedMessageWithheld(LineageAllowance.tool(), "C", "reply-1")).toBe(true);
  expect(sessionCheck().bad).toBe(true);
});

it("r8 (Fable P1, r7 P1-1): a branch switch in conversation A retires message:A:M, which a receipt in conversation C cites: C's retained session is invalid", () => {
  setMemoryMode("active");
  const db = database();
  insertMessage("A", { id: "M", at: 1, role: "user", kind: "text", text: "the words", parentId: null } as Message);
  insertMessage("A", { id: "N", at: 2, role: "user", kind: "text", text: "another branch", parentId: null } as Message);
  setActiveLeaf("A", "M");
  captureSource(db, { id: "message:A:M", threadId: "A", messageId: "M", kind: "text", speaker: "owner", outcome: "recorded", text: "the words" });
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:A:M'").get()?.state).toBe("active");
  citedReply(db, "message:A:M");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" }); // a turn asks for the proof
  passes();
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
  resetRootSetWork();
  expect(sessionCheck().bad).toBe(false); // proven: no member walked again
  expect(rootSetWork().members).toBe(0);
  setActiveLeaf("A", "N"); // production branch switch: M leaves the branch
  expect(db.prepare("SELECT state FROM memory_sources WHERE id='message:A:M'").get()?.state).toBe("retired");
  expect(capturedMessageWithheld(LineageAllowance.tool(), "C", "reply-1")).toBe(true);
  expect(sessionCheck().bad).toBe(true);
});

it("r8 (r7 P1-2): nothing proven before a restart is trusted after it, whatever was committed meanwhile; the turn walks nothing", () => {
  setMemoryMode("active");
  const db = database();
  captureSource(db, { id: "doc:secret", threadId: "C", kind: "text", speaker: "owner", outcome: "recorded", text: "the first words" });
  citedReply(db, "doc:secret");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" }); // a turn asks for the proof
  passes();
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
  // a committed change that no trigger of this connection saw, then the process ends
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='b1'").run(JSON.stringify([{ id: "doc:secret", revision: 9 }]));
  other.close();
  closeDatabase(); forgetKeptLineageForTest();
  database();
  resetRootSetWork();
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" });
  expect(rootSetWork().members).toBe(0);
  passes();
  expect(capturedMessageWithheld(LineageAllowance.tool(), "C", "reply-1")).toBe(true);
  expect(sessionCheck().bad).toBe(true); // never proven: the member does not hold
});

it("r8: a turn's look at an unproven set is bounded by its allowance at 20,001 and 200,000 members, walks no member, and the session resets", () => {
  const seen: Array<{ check: { bad: boolean; reason?: string }; rows: number; members: number }> = [];
  for (const n of [20_001, 200_000]) {
    fresh();
    setRootSetCeilingForTest(250_000);
    const db = database();
    bigSet(db, "big", n); retain(db, "big");
    resetRootSetWork();
    const before = tally.rows;
    const check = sessionCheck();
    seen.push({ check, rows: tally.rows - before, members: rootSetWork().members });
  }
  console.log(`R8-TURN ${JSON.stringify(seen)}`);
  expect([LARGE_ROOT_SET, TURN_JUDGE_MAX]).toEqual([20_000, 4_000]);
  // 1.0.2 lineage-cold: a check reads a cold chain within the turn's allowance (nodes x rows per node), and what it cannot read is unproven, not
  // past the ceiling. A huge set stays in the file (the metered handle), so the first check never reads its rows: at 20,001 and at 200,000 members
  // the large set is "not proven yet" ("checking"), withheld, and the recovery scheduler proves it. No member is judged and the read never exceeds the allowance.
  const allowanceRows = TURN_LINEAGE_NODES * ROWS_PER_NODE;
  expect(seen[0]!.check).toEqual({ bad: true, reason: "checking" });
  expect(seen[1]!.check).toEqual({ bad: true, reason: "checking" });
  for (const run of seen) { expect(run.members).toBe(0); expect(run.rows).toBeLessThanOrEqual(allowanceRows + 64); }
  expect(seen[1]!.rows).toBe(seen[0]!.rows); // flat: the size of the set does not change what a turn reads
});

it("r8: the background proves a large set within ceil(n/4,000) passes, each member once, and the session then resumes with no member walked", () => {
  const db = database();
  bigSet(db, "big", 24_001); retain(db, "big");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" });
  const members = passes();
  console.log(`R8-BACKGROUND n=24001 passes=${members.length} members=${JSON.stringify(members)}`);
  expect(members).toHaveLength(Math.ceil(24_001 / 4_000));
  expect(members.every((n) => n <= 4_000)).toBe(true);
  expect(members.reduce((a, b) => a + b, 0)).toBe(24_001);
  resetRootSetWork();
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
  expect(rootSetWork().members).toBe(0);
});

it("r8: a proof survives the eviction of the verdicts it rests on, and a change to one of them still ends it", () => {
  setVerdictLimitForTest(8_000);
  setMemoryMode("active");
  const db = database();
  captureSource(db, { id: "doc:secret", threadId: "C", kind: "text", speaker: "owner", outcome: "recorded", text: "the first words" });
  citedReply(db, "doc:secret");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" }); // a turn asks for the proof
  passes();
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
  captureSource(db, { id: "doc:secret", threadId: "C", kind: "text", speaker: "owner", outcome: "recorded", text: "changed" });
  expect(sessionCheck().bad).toBe(true);
});

// ── #4: the start's scope reconciliation and card discovery ────────────────────────────────────────────────────────────────────
it("r8 #4: reconciling an unchanged roster on a first upgrade (no owner index) makes no search by owner at 20,000 or 200,000 scopes; a new bot costs its own", () => {
  const roster = { bots: Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, threadId: `t${i}` })), groups: [] };
  const lookups: number[] = [], added: number[] = [];
  for (const n of [20_000, 200_000]) {
    fresh();
    setMemoryMode("active");
    const db = database();
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO memory_scopes SELECT 'c'||i,'conversation','conv'||i,'[]',0 FROM k").run(n);
    reconcileMemoryRoster(roster); // the last start of 1.0.1 granted this roster
    db.exec(`DROP INDEX IF EXISTS ${SCOPE_OWNER_INDEX}`); // the upgrade does not build the index before listen
    let before = scopeLookups();
    reconcileMemoryRoster(roster);
    lookups.push(scopeLookups() - before);
    before = scopeLookups();
    reconcileMemoryRoster({ bots: [...roster.bots, { id: "b-new", threadId: "t-new" }], groups: [] });
    added.push(scopeLookups() - before);
    expect(db.prepare("SELECT 1 FROM memory_scopes WHERE kind='conversation' AND owner_key='t-new'").get()).toBeTruthy();
  }
  console.log(`R8-SCOPES lookups=${JSON.stringify(lookups)} added=${JSON.stringify(added)}`);
  expect(lookups).toEqual([0, 0]);
  expect(added).toEqual([2, 2]); // the new bot and its conversation
});

const fakeBus = () => ({ store: { bots: [], groups: [], patchMessagePoint: (thread: string, id: string, patch: Partial<Message>) => { const current = readMessage(thread, id); if (!current) return null; const next = { ...current, ...patch } as Message; updateMessage(thread, next); return next; } } }) as unknown as ApprovalBus;
function openCards(db: DatabaseSync, n: number, tool: string) {
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 'other','c'||i,i,'bot','options','x',json_object('id','c'||i,'at',i,'role','bot','kind','options','text','x','parentId',NULL,'card',json_object('title','c','options',json_array(),'requestId','r'||i,'tool',?)) FROM k`).run(n, tool);
  db.exec("COMMIT");
}
it("r8 #4: before listen the start reads one page of the open-card list, the same at 20,000 and 200,000 unrelated open cards; the rest is settled after listen", { timeout: 300_000 }, async () => {
  const read: number[] = [], after: number[] = [];
  for (const n of [20_000, 200_000]) {
    fresh();
    const db = database();
    openCards(db, n, "Bash");
    insertMessage("zz-owned", { id: "dead", at: n + 1, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "c", options: [], requestId: "gone", tool: "ask_bot" } } as never);
    db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
    ensureOpenCardIndex(db);
    const owned = new Set(["zz-owned"]), kinds = [stalePeerCardKind(), staleHostConsentCardKind()], high = messagesHighWater();
    const before = openCardPageRowsRead();
    const page = settleStaleCardPage(fakeBus(), kinds, null, 2_000, high, owned)!;
    read.push(openCardPageRowsRead() - before);
    expect(page.next).not.toBeNull();
    after.push(page.dismissed + await settleStaleCardsFromList(fakeBus(), kinds, page.next, high, owned, async () => {}));
  }
  console.log(`R8-CARDS prelisten-rows=${JSON.stringify(read)} dismissed-after-listen=${JSON.stringify(after)}`);
  expect(read).toEqual([2_000, 2_000]);
  expect(after).toEqual([1, 1]); // the dead peer card, found after listen in both
});

// ── #5: the list completed during the rowid sweep is handed over explicitly ────────────────────────────────────────────────────
it("r8 #5: when the open-card list completes during the descending sweep, the old peer card is dismissed through the handoff (not orphaned), and a card of this run is untouched", async () => {
  const db = database();
  db.exec("BEGIN");
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  for (let i = 1; i <= 40_001; i++) {
    const card = i === 40 ? { title: "c", options: [], requestId: "gone", tool: "ask_bot" } : undefined;
    const message = { id: `m${i}`, at: i, role: "bot", kind: card ? "options" : "text", text: "x", parentId: null, ...(card ? { card } : {}) };
    put.run("room", message.id, i, "bot", message.kind, "x", JSON.stringify(message));
  }
  db.exec("COMMIT");
  db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'"); // the list is still being built at the start
  const owned = new Set(["room"]), bus = fakeBus(), high = messagesHighWater();
  // the first descending slice (the newest 20,000 rows) holds no card
  expect(dismissStalePeerCards(bus, { after: high - 20_000, upTo: high }, owned)).toBe(0);
  ensureOpenCardIndex(db); // the list completes now; the descending walk stops
  insertMessage("room", { id: "this-run", at: 50_000, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "c", options: [], requestId: "live", tool: "ask_bot" } } as never);
  expect(await settleStaleCardsFromList(bus, [stalePeerCardKind()], null, high, owned, async () => {})).toBe(1);
  expect(readMessage("room", "m40")?.card).toMatchObject({ answered: "deny", dismissed: true });
  expect(readMessage("room", "m40")?.card?.orphaned).toBeUndefined();
  expect(readMessage("room", "this-run")?.card?.dismissed).toBeUndefined();
});

// ── #6: the sweep marks are durable insertion cursors ──────────────────────────────────────────────────────────────────────────
it("r8 #6: deleting the newest conversation brings the sweep mark down with it, so a card that reuses a freed row number is swept (20,000 and 200,000 rows)", () => {
  const swept: number[] = [];
  for (const n of [20_000, 200_000]) {
    fresh();
    const db = database();
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'old','o'||i,i,'user','text','x',json_object('id','o'||i,'at',i,'role','user','kind','text','text','x','parentId',NULL) FROM k").run(n);
    for (let i = 1; i <= 50; i++) insertMessage("newest", { id: `n${i}`, at: n + i, role: "user", kind: "text", text: "x", parentId: null } as Message);
    keepCardSweepThrough(messagesHighWater()); // a start finished its sweep through the newest row
    deleteThread("newest");
    insertMessage("q", { id: "question", at: n + 100, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "q", options: ["a"], requestId: "dead-run" } } as never);
    const high = messagesHighWater();
    expect(high).toBe(n + 1); // the freed number is reused
    const from = cardSweepThrough(high);
    expect(from).toBe(n);
    swept.push(openQuestionCardMessages(from, high).length);
  }
  console.log(`R8-MARK swept=${JSON.stringify(swept)}`);
  expect(swept).toEqual([1, 1]);
});

// ── #7: the restart marker of an interrupted direct turn ───────────────────────────────────────────────────────────────────────
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
it("r8 #7: marking an interrupted direct turn reads the branch head and appends without loading the transcript, the same at 20,000 and 200,000 messages", async () => {
  const runs: Array<{ recovered: number; rows: number; loaded: boolean }> = [];
  for (const n of [20_000, 200_000]) {
    fresh();
    const db = database();
    const store = new Store(selection);
    const bot = store.createBot();
    const thread = store.createTask(bot.id, "Background", false)!.threadId;
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT ?1,'h'||i,i,'bot','text','x',json_object('id','h'||i,'at',i,'role','bot','kind','text','text','x','parentId',CASE WHEN i>1 THEN 'h'||(i-1) END) FROM k").run(thread, n);
    insertMessage(thread, { id: "ask", at: n + 1, role: "user", kind: "text", text: "still there?", parentId: `h${n}` } as Message);
    setActiveLeaf(thread, "ask"); // the turn was admitted: the thread's head is the person's message, kept as in flight
    markDirectTurnsWalked();
    const loaded = (store as unknown as { threads: Map<string, unknown> }).threads;
    loaded.delete(thread);
    const before = tally.rows;
    const recovered = await store.reconcileInterruptedDirectTurnsInBackground("interrupted", Date.now() + 60_000);
    runs.push({ recovered, rows: tally.rows - before, loaded: loaded.has(thread) });
    const marker = db.prepare("SELECT json FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(thread) as { json: string };
    expect(JSON.parse(marker.json)).toMatchObject({ kind: "activity", parentId: "ask" });
  }
  console.log(`R8-DIRECT ${JSON.stringify(runs)}`);
  for (const run of runs) expect(run).toMatchObject({ recovered: 1, loaded: false });
  expect(runs[0]!.rows).toBeLessThan(200);
  expect(runs[1]!.rows).toBeLessThanOrEqual(runs[0]!.rows + 2);
});

// ── the 48 GB rig, STALLS.md rank 3: the output-index slices of the integrity pass are sized by time ─────────────────────────────
it("r8 (rig rank 3): no slice of the output-index proof blocks over 50 ms on a 200,000-output fixture, heavy receipts included", { timeout: 300_000 }, () => {
  const db = database();
  const put = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','[]','[]',?,0,0,0,'delivered',1)");
  db.exec("BEGIN");
  let outputs = 0;
  for (let r = 0; r < 1_010; r++) {
    const count = r % 101 === 0 ? 5_000 : 150; // ten heavy receipts of 5,000 replies among ordinary ones
    put.run(`b${r.toString(16).padStart(8, "0")}`, `t${r % 40}`, JSON.stringify(Array.from({ length: count }, (_, i) => `r${r}-${i}`)));
    outputs += count;
  }
  db.exec("COMMIT");
  expect(outputs).toBeGreaterThanOrEqual(200_000);
  db.exec("BEGIN"); rebuildOutputIndexSlice(db, { lo: null, hi: null }); db.exec("COMMIT");
  beginIntegrityPass(db);
  const durations: number[] = [];
  for (let guard = 0; guard < 10_000; guard++) {
    const before = readIntegrityPass(db)!;
    if (before.phase !== "output-index") break;
    const started = performance.now();
    stepIntegrityPass(db, { budgetMs: 0 });
    durations.push(performance.now() - started);
  }
  const max = Math.max(...durations);
  console.log(`R8-INTEGRITY slices=${durations.length} max_ms=${max.toFixed(1)} total_ms=${durations.reduce((a, b) => a + b, 0).toFixed(0)}`);
  expect(readIntegrityPass(db)!.phase).not.toBe("output-index");
  expect(integrityHoldOf(readIntegrityPass(db))).toBeNull();
  expect(max).toBeLessThanOrEqual(50);
});

// ── the owner's preview (lanes/int102-gate/preview-live): background upgrade work never starts a slice in front of an owner turn, and pauses as long as it worked
it("r8 (preview-live): no background slice starts while an owner turn is live, and each pause is at least as long as the slice before it", async () => {
  const db = database();
  beginIntegrityPass(db);
  let live = true;
  const handle = startBackgroundUpgradeWork(db, { busy: () => live, busyPauseMs: 5, pauseMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(handle.slices).toBe(0); // an owner turn was live the whole time
  live = false;
  const began = performance.now();
  await handle.done;
  console.log(`R8-PACING slices=${handle.slices} wall_ms=${Math.round(performance.now() - began)}`);
  expect(handle.slices).toBeGreaterThan(0);
  expect(COMPACTION_MAX_CUT_ROWS).toBe(20_000);
});

// ── preview-live: the root-set collector writes its cursor once per slice, and each slice is short ───────────────────────────────
it("r8 (preview-live): one collect cursor write per slice and every slice under 50 ms, at 10,000 and 300,000 unused sets", { timeout: 300_000, ...windowsPerfBudget() }, () => {
  const seen: Array<{ sets: number; slices: number; writesPerSlice: number; maxMs: number; removed: number }> = [];
  for (const n of [10_000, 300_000]) {
    fresh();
    const db = database();
    db.prepare("INSERT INTO memory_scopes VALUES('ws','workspace','install','[]',0)").run();
    db.exec("BEGIN");
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO memory_root_sets(set_id,size) SELECT 'u'||printf('%07d',i),1 FROM k").run(n);
    db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'u'||printf('%07d',i),'t','m'||i FROM k").run(n);
    db.exec("COMMIT");
    let slices = 0, removed = 0, maxMs = 0, writes = 0;
    for (let i = 0; i < 60; i++) { // the first sixty slices of a lap
      const before = collectCursorWriteCount(), started = performance.now();
      const slice = collectRootSetsSlice(db);
      maxMs = Math.max(maxMs, performance.now() - started);
      writes = Math.max(writes, collectCursorWriteCount() - before);
      slices++; removed += slice.removed;
      if (slice.wrapped) break;
    }
    seen.push({ sets: n, slices, writesPerSlice: writes, maxMs: Math.round(maxMs), removed });
  }
  console.log(`R8-COLLECT ${JSON.stringify(seen)}`);
  for (const run of seen) { expect(run.writesPerSlice).toBe(1); expect(run.maxMs).toBeLessThanOrEqual(50); expect(run.removed).toBeGreaterThan(0); }
});

it("1.0.3 rw delta M6: a copy whose original rests on a set whose proof is still being built reads unproven (checking), never a mark", () => {
  setRootSetCeilingForTest(250_000);
  const db = database();
  insertMessage("W", { id: "o1", at: 1, role: "bot", kind: "text", text: "the worker's words", parentId: null } as Message);
  bigSet(db, "big", 20_001);
  db.prepare("INSERT OR REPLACE INTO memory_output_roots(thread_id,message_id,set_id) VALUES('W','o1','big')").run();
  // the nested root-set proof is deferred to the recovery scheduler: the copy's originals are not proven yet, which is checking (contract R1)
  expect(copyOriginVerdict(LineageAllowance.tool(), { threadId: "W", messageIds: ["o1"] })).toEqual({ withheld: true, unproven: true });
  // a real mark on the same original stays withheld and proven
  db.prepare("INSERT OR REPLACE INTO memory_output_roots(thread_id,message_id,set_id) VALUES('W','o1','')").run();
  expect(copyOriginVerdict(LineageAllowance.tool(), { threadId: "W", messageIds: ["o1"] })).toEqual({ withheld: true, unproven: false });
});
