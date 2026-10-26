// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S1 writers (DESIGN-WRITETIME 2): every message writer records its lineage row and its cross-thread carries in the message's transaction;
// a reply written after a mark is born marked (inheritance at write, through revoke-commit.ts inheritMarks); an unrecorded line has no
// row (it reads "checking"); and the write's cost is flat in the thread's history (same statements, same rows read, index seeks only).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

// Inheritance at write is S3's body (revoke-commit.ts). Until it lands, this stand-in implements the contract's one rule the writer relies on:
// a child whose carried parent line holds a deny_line mark gets one too, with the same revoke id, in the writer's transaction. The setup file
// has already loaded the real modules, so this file takes fresh copies of the whole graph with the stand-in in place.
vi.resetModules();
vi.doMock("./revoke-commit.ts", () => ({
  commitRevoke: vi.fn(() => 0),
  undoRevoke: vi.fn(),
  // DRAIN-104 2.11's late-edge inheritance (capture.ts and the record writers call it): not this file's subject
  inheritEdge: vi.fn(),
  inheritEdges: vi.fn(),
  // a stand-in for S3's inheritMarks: a marked line inside a carried range marks the child (a line, or a turn: its turn_lsn position)
  inheritMarks: vi.fn((tx: import("node:sqlite").DatabaseSync, child: { kind: string; threadId?: string; lsn: number }, _refs: unknown[], ranges: Array<{ threadId: string; from: number; to: number }> = []) => {
    if (!child.threadId) return;
    for (const range of ranges)
      for (const mark of tx.prepare("SELECT revoke_id FROM memory_deny_line WHERE thread_id=? AND lsn BETWEEN ? AND ?").all(range.threadId, range.from, range.to) as Array<{ revoke_id: number }>)
        tx.prepare("INSERT OR IGNORE INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?,'inherited')").run(child.threadId, child.lsn, mark.revoke_id, child.lsn);
  }),
}));

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database, transaction } = await import("../database.ts");
const { appendMessage, closeMessageDb, deleteThread, insertMessage, lineAuthor, readThread, setActiveLeaf, updateMessage } = await import("../message-db.ts");
const { commitRevoke, inheritMarks } = await import("./revoke-commit.ts");
const { COPY_ORIGINS, FIRST_LSN, FOOTPRINT_STAR, decodeCarryChild, lineChildRef, turnChildRef } = await import("./lineage-types.ts");
const {
  LINEAGE_WRITE_SQL, UNKNOWN_PARENT_LSN, addTurnParents, closeTurnLineage, currentLsn, currentTurnLineage, internFootprint, lineageWriteStats,
  markThreadNotReady, memberTurnId, openTurnLineage, readyImportedThread, readyImportedThreads, reserveLsns, resetLineageWriteStats, runningTurnFor, supersedeMemberTurns, writeCaptureLineage, writeLineage,
  writeRecordLineage, writeSessionLineage,
} = await import("./lineage-write.ts");
const { quoteLineageRefs, steerQuoteRefused } = await import("../steer-lineage.ts");
import type { Message } from "../store.ts";
import type { LineageRef } from "./lineage-types.ts";
const { testThreadNo } = await import("./testing/writetime-fixture.ts");
afterAll(() => closeMessageDb());

type Row = Record<string, unknown>;
const db = () => database();
/** A line's lineage row (generated = it has a turn_lsn). */
const lineage = (threadId: string, messageId: string) =>
  db().prepare("SELECT l.lsn,(l.turn_lsn IS NOT NULL) AS generated,l.turn_lsn,l.mem_lsn,l.footprint FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?").get(threadId, messageId) as Row | undefined;
/** The carries onto children of a thread (lines, turns, sessions), with their parent thread by name. */
const carries = (childThread: string) => db().prepare("SELECT p.thread_id AS parent_thread,c.from_lsn,c.to_lsn,c.child_kind,c.child_ref FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no JOIN memory_thread_no k ON k.no=c.child_thread_no WHERE k.thread_id=? ORDER BY 1,2,4,5").all(childThread) as Row[];
const flows = (to: string) => db().prepare("SELECT from_thread,first_lsn FROM memory_thread_flow WHERE to_thread=? ORDER BY from_thread").all(to) as Row[];
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string, extra: Partial<Message> = {}): Message => msg(id, { role: "user", ...extra });

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const thread of ["chat", "other", "room", "asker", "worker", "big"]) { let turn; while ((turn = currentTurnLineage(thread))) closeTurnLineage(turn); }
  vi.mocked(inheritMarks).mockClear();
  vi.mocked(commitRevoke).mockClear();
});

describe("each writer records its lineage row in the message's transaction", () => {
  it("insertMessage and appendMessage: owner lines generated=0, bot lines generated=1, lsns in write order", () => {
    appendMessage("chat", owner("o1"));
    appendMessage("chat", msg("b1", { parentId: "o1" }));
    insertMessage("chat", msg("b2"));
    const [o1, b1, b2] = ["o1", "b1", "b2"].map(id => lineage("chat", id)!);
    expect(o1).toMatchObject({ generated: 0, turn_lsn: null });
    expect(b1).toMatchObject({ generated: 1, turn_lsn: Number(o1.lsn) + 0 });
    expect(Number(b1.lsn)).toBe(Number(o1.lsn) + 1);
    expect(Number(b2.lsn)).toBe(Number(b1.lsn) + 1);
    expect(currentLsn(db())).toBe(Number(b2.lsn) + 1);
  });

  it("a redelivered write keeps its lsn (INSERT OR REPLACE of the same message)", () => {
    insertMessage("chat", msg("b1"));
    const first = lineage("chat", "b1")!.lsn;
    insertMessage("chat", msg("b1", { text: "again" }));
    expect(lineage("chat", "b1")!.lsn).toBe(first);
    expect(currentLsn(db())).toBe(Number(first) + 1);
  });

  it("a rolled-back message write leaves no lineage row and no lsn taken", () => {
    const before = currentLsn(db());
    expect(() => appendMessage("chat", msg("b1"), () => { throw new Error("refused"); })).toThrow("refused");
    expect(lineage("chat", "b1")).toBeUndefined();
    expect(currentLsn(db())).toBe(before);
  });

  it("the legacy-file import: every line gets a row in time order, and the thread is ready once its rows are in that order (the certificate is ready on a new file)", () => {
    const file = join(DATA_DIR, "messages-legacy.json");
    writeFileSync(file, JSON.stringify({ messages: [owner("l1", { at: 10 }), msg("l2", { parentId: "l1", at: 20 }), owner("l3", { parentId: "l2", at: 30 })], activeLeafId: "l3" }));
    expect(readThread("legacy", file).messages.map(m => m.id)).toEqual(["l1", "l2", "l3"]);
    const rows = ["l1", "l2", "l3"].map(id => lineage("legacy", id)!);
    expect(rows.map(row => row.generated)).toEqual([0, 1, 0]);
    expect(Number(rows[1]!.lsn)).toBe(Number(rows[0]!.lsn) + 1);
    expect(db().prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='legacy'").get()).toEqual({ ready: 1 });
  });

  it("a legacy file written out of time order is re-sequenced at the import: lsn order is time order (a forget of an early line then reads the thread as it was)", () => {
    const file = join(DATA_DIR, "messages-legacy-unsorted.json");
    // the file lists the later reply first (a hand-merged file); the two lines of the same time keep their place
    writeFileSync(file, JSON.stringify({ messages: [msg("late", { at: 300 }), owner("early", { at: 100 }), msg("tie-a", { at: 200 }), msg("tie-b", { at: 200 })], activeLeafId: "late" }));
    readThread("unsorted", file);
    const lsns = ["early", "tie-a", "tie-b", "late"].map(id => Number(lineage("unsorted", id)!.lsn));
    expect(lsns).toEqual([...lsns].sort((a, b) => a - b));
    expect(new Set(lsns).size).toBe(4);
    expect(db().prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='unsorted'").get()).toEqual({ ready: 1 });
  });

  it("an import while the upgrade has not certified the file stays not ready, and the transaction that drains U2 readies it", () => {
    db().prepare("UPDATE memory_lineage_cert SET phase='u1',ready=0 WHERE id=1").run();
    const file = join(DATA_DIR, "messages-legacy-early.json");
    writeFileSync(file, JSON.stringify({ messages: [owner("e1", { at: 1 }), msg("e2", { parentId: "e1", at: 2 })] }));
    readThread("early", file);
    expect(db().prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='early'").get()).toEqual({ ready: 0 });
    db().prepare("UPDATE memory_lineage_cert SET phase='done',ready=1 WHERE id=1").run();
    expect(readyImportedThreads(db())).toBe(1);
    expect(db().prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='early'").get()).toEqual({ ready: 1 });
  });

  it("a thread whose rows are NOT in time order (written before the re-sequence) is never made ready", () => {
    appendMessage("odd", msg("a", { at: 500 }));
    appendMessage("odd", msg("b", { at: 100 })); // written after, older: its lsn is later than its time says
    markThreadNotReady(db(), "odd");
    expect(readyImportedThread(db(), "odd")).toBe(false);
    expect(db().prepare("SELECT ready FROM memory_lineage_thread_ready WHERE thread_id='odd'").get()).toEqual({ ready: 0 });
  });

  it("a bot reply carries what its running turn was shown from other threads: point carries, flow edges, inheritance asked", () => {
    appendMessage("other", owner("x1"));
    appendMessage("other", msg("x2", { parentId: "x1" }));
    const x2 = Number(lineage("other", "x2")!.lsn);
    appendMessage("chat", owner("o1"));
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x2" }, { kind: "line", threadId: "chat", messageId: "o1" }]);
    appendMessage("chat", msg("r1", { parentId: "o1" }));
    const r1 = lineage("chat", "r1")!;
    expect(Number(r1.turn_lsn)).toBe(turn.turnLsn);
    // one range carry, child = the TURN (not the line): every line of the turn finds it through its turn_lsn
    expect(carries("chat")).toEqual([{ parent_thread: "other", from_lsn: x2, to_lsn: x2, child_kind: 1, child_ref: turnChildRef(turn.turnLsn) }]);
    expect(decodeCarryChild(1, String(carries("chat")[0]!.child_ref), "chat")).toEqual({ kind: "turn", threadId: "chat", turnLsn: turn.turnLsn });
    expect(flows("chat")).toEqual([{ from_thread: "other", first_lsn: Number(r1.lsn) }]);
    expect(inheritMarks).toHaveBeenCalledWith(expect.anything(), { kind: "turn", threadId: "chat", lsn: turn.turnLsn, line: Number(r1.lsn), holdFrom: Number(r1.lsn) }, [], [{ threadId: "other", from: x2, to: x2 }]);
    // a second reply of the same turn writes no new carry row
    appendMessage("chat", msg("r1b", { parentId: "r1" }));
    expect(carries("chat")).toHaveLength(1);
  });

  it("a reply patched inside its turn gains the parents its turn was shown since; a line with no row is never given one by a patch", () => {
    appendMessage("other", msg("x1"));
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    appendMessage("chat", msg("r1"));
    expect(carries("chat")).toEqual([]);
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x1" }]);
    updateMessage("chat", msg("r1", { text: "longer" }));
    expect(carries("chat").map(row => row.parent_thread)).toEqual(["other"]);
    // a row written before v10 (no lineage row) stays without one: a row made now would take a position later than the line has
    db().prepare("DELETE FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id='chat') AND message_id='r1'").run();
    updateMessage("chat", msg("r1", { text: "longer still" }));
    expect(lineage("chat", "r1")).toBeUndefined();
  });

  it("a room member's reply takes that member's turn; a line no member owns is attached to no turn (1.0.3 lifecycle card)", () => {
    appendMessage("other", msg("a")); appendMessage("asker", msg("b"));
    const ann = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("ann") });
    const bob = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("bob") });
    addTurnParents(ann, [{ kind: "line", threadId: "other", messageId: "a" }]);
    addTurnParents(bob, [{ kind: "line", threadId: "asker", messageId: "b" }]);
    expect(runningTurnFor("room", "ann")!.parents).toEqual([{ kind: "line", threadId: "other", messageId: "a" }]);
    // (both turns opened at the same head: their turn children share a position; ann's line carries ann's parents only. A line no member
    // owns is no one actor's turn output: Murage's own line carries nothing, and a bot line naming no member carries every open turn's
    // parents as its own refs, so no write makes another member's turn its inherit child)
    const parentsOf = () => carries("room").filter(row => row.child_kind === 1 && row.child_ref === turnChildRef(ann.turnLsn)).map(row => row.parent_thread).sort();
    const lineParents = (id: string) => carries("room").filter(row => row.child_kind === 0 && row.child_ref === lineChildRef(Number(lineage("room", id)!.lsn))).map(row => row.parent_thread).sort();
    appendMessage("room", msg("ra", { from: { botId: "ann", name: "Ann", color: "red" } }));
    expect(parentsOf()).toEqual(["other"]);
    appendMessage("room", msg("rm", { actorKind: "murage", parentId: "ra" }));
    expect(parentsOf()).toEqual(["other"]);
    expect(lineParents("rm")).toEqual([]);
    appendMessage("room", msg("ru", { parentId: "rm" }));
    expect(parentsOf()).toEqual(["other"]);
    expect(lineParents("ru")).toEqual(["asker", "other"]);
    // a new dispatch of ann replaces ann's earlier turn only
    const ann2 = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("ann") });
    supersedeMemberTurns(ann2);
    expect(runningTurnFor("room", "ann")).toBe(ann2);
    expect(runningTurnFor("room", "bob")).toBe(bob);
  });

  it("a line written over a merged turn (several open turns, no member named) takes the lowest turn lsn (1.0.3 rw-cap)", () => {
    // ann's prompt was built first; lines land in between; bob's prompt later. A bot line naming no member is written over both turns: its
    // turn began when ann's did, so a pending window capped between the two still holds it (deny-read.ts lookupPage)
    appendMessage("other", msg("a"));
    const ann = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("ann") });
    appendMessage("other", msg("b")); appendMessage("other", msg("c"));
    const bob = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("bob") });
    expect(bob.turnLsn).toBeGreaterThan(ann.turnLsn);
    appendMessage("room", msg("merged"));
    expect(Number(lineage("room", "merged")!.turn_lsn)).toBe(ann.turnLsn);
    // a member's own line keeps its own turn
    appendMessage("room", msg("bobs", { from: { botId: "bob", name: "Bob", color: "blue" } }));
    expect(Number(lineage("room", "bobs")!.turn_lsn)).toBe(bob.turnLsn);
    closeTurnLineage(ann); closeTurnLineage(bob);
  });

  it("a turn whose prompt was built at head 0 keeps turn_lsn 0 on its lines, never a later lsn (Astra delta Medium 9)", () => {
    // the first turn of a new file: its prompt was built before any line was written, so its turn lsn is 0 (openTurnLineage permits it)
    const ann = openTurnLineage(db(), { threadId: "room", turnId: memberTurnId("ann") });
    expect(ann.turnLsn).toBe(0);
    // lines land elsewhere before ann's reply: a turn lsn of lsn - 1 would place ann's turn after them, outside a window capped between
    appendMessage("other", msg("a")); appendMessage("other", msg("b"));
    appendMessage("room", msg("annReply", { from: { botId: "ann", name: "Ann", color: "blue" } }));
    expect(Number(lineage("room", "annReply")!.lsn)).toBeGreaterThan(1);
    expect(Number(lineage("room", "annReply")!.turn_lsn)).toBe(0);
    closeTurnLineage(ann);
  });

  it("copies carry their originals; a copy past COPY_ORIGINS gets no row (withheld); an unrecorded original is carried at the unknown position", () => {
    appendMessage("other", msg("x1"));
    insertMessage("chat", msg("c1", { copyOf: { threadId: "other", messageIds: ["x1", "ghost"] } }));
    const rows = carries("chat");
    const x1 = Number(lineage("other", "x1")!.lsn);
    expect(rows.map(row => [row.parent_thread, row.from_lsn, row.to_lsn, row.child_kind])).toEqual([["other", x1, x1, 0], ["other", UNKNOWN_PARENT_LSN, UNKNOWN_PARENT_LSN, 0]]);
    expect(lineage("chat", "c1")).toMatchObject({ generated: 1, mem_lsn: 0, footprint: FOOTPRINT_STAR });
    insertMessage("chat", msg("c2", { copyOf: { threadId: "other", messageIds: Array.from({ length: COPY_ORIGINS + 1 }, (_, i) => `m${i}`) } }));
    expect(lineage("chat", "c2")).toBeUndefined();
  });

  it("a hand-off prompt is generated and carries the asking conversation (prefix at its head) and the asking turn's parents", () => {
    appendMessage("other", msg("x1"));
    appendMessage("asker", owner("q1"));
    const turn = openTurnLineage(db(), { threadId: "asker", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x1" }]);
    appendMessage("worker", owner("h1", { handoffFrom: "asker", automation: { kind: "delegation" } }));
    expect(lineAuthor(owner("h1", { handoffFrom: "asker" }))).toBe("generated");
    const x1 = Number(lineage("other", "x1")!.lsn);
    expect(carries("worker").map(row => [row.parent_thread, row.from_lsn, row.to_lsn])).toEqual([
      ["asker", FIRST_LSN, Number(lineage("asker", "q1")!.lsn)], ["other", x1, x1]]);
  });

  it("rule 7: a hand-off prompt with handoffOf carries only the line that handed it over: no prefix, no asking turn's parents at drain", () => {
    appendMessage("other", msg("x1"));
    appendMessage("asker", owner("q1"));
    appendMessage("asker", msg("sent", { kind: "activity" }));
    appendMessage("asker", owner("q2"));
    const turn = openTurnLineage(db(), { threadId: "asker", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x1" }]);
    appendMessage("worker", owner("h2", { handoffFrom: "asker", handoffOf: { threadId: "asker", messageId: "sent" }, automation: { kind: "delegation" } }));
    expect(lineAuthor(owner("h2", { handoffOf: { threadId: "asker", messageId: "sent" } }))).toBe("generated");
    const sent = Number(lineage("asker", "sent")!.lsn);
    expect(carries("worker").map(row => [row.parent_thread, row.from_lsn, row.to_lsn])).toEqual([["asker", sent, sent]]);
    closeTurnLineage(turn);
  });

  it("receipts fold the oldest receipt lsn and the scopes; more than the cap interns to *; the running values flow to the next line", () => {
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "receipt", bundleId: "b1", lsn: 7, scopeIds: ["s1", "s2"] }, { kind: "receipt", bundleId: "b2", lsn: 9, scopeIds: ["s2"] }]);
    appendMessage("chat", msg("r1"));
    const r1 = lineage("chat", "r1")!;
    expect(r1.mem_lsn).toBe(7);
    expect(db().prepare("SELECT scope_id FROM memory_scope_sets WHERE set_id=? ORDER BY scope_id").all(Number(r1.footprint))).toEqual([{ scope_id: "s1" }, { scope_id: "s2" }]);
    expect(flows("chat").map(row => row.from_thread)).toEqual(["scope:s1", "scope:s2"]);
    closeTurnLineage(turn);
    appendMessage("chat", owner("o2")); appendMessage("chat", msg("r2"));
    expect(lineage("chat", "o2")).toMatchObject({ generated: 0, mem_lsn: 7, footprint: r1.footprint });
    expect(lineage("chat", "r2")).toMatchObject({ mem_lsn: 7, footprint: r1.footprint });
    expect(internFootprint(db(), Array.from({ length: 33 }, (_, i) => `s${i}`))).toBe(FOOTPRINT_STAR);
    expect(internFootprint(db(), ["s2", "s1", "s1"])).toBe(r1.footprint);
  });

  it("records, captures and sessions: the prefix carry from the turn, the capture row, the session row with the turn's carries", () => {
    appendMessage("other", msg("x1"));
    appendMessage("chat", owner("o1"));
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x1" }]);
    transaction(tx => {
      writeRecordLineage(tx, { kind: "record", id: "rec", version: 2 }, turn);
      writeCaptureLineage(tx, { threadId: "chat", messageId: "o1" }, "src");
      writeSessionLineage(tx, { threadId: "chat", driverInstance: "claude", nativeSession: "S" }, turn);
    });
    const rec = db().prepare("SELECT p.thread_id AS parent_thread,c.from_lsn,c.to_lsn FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_kind=3 ORDER BY 1").all() as Row[];
    const x1 = Number(lineage("other", "x1")!.lsn);
    expect(rec).toEqual([{ parent_thread: "chat", from_lsn: FIRST_LSN, to_lsn: turn.turnLsn }, { parent_thread: "other", from_lsn: x1, to_lsn: x1 }]);
    expect(db().prepare("SELECT c.lsn,c.source_id FROM memory_line_capture c JOIN memory_thread_no t ON t.no=c.thread_no WHERE t.thread_id='chat' AND c.source_id='src'").all()).toEqual([{ lsn: Number(lineage("chat", "o1")!.lsn), source_id: "src" }]);
    expect(db().prepare("SELECT first_lsn,last_lsn FROM memory_session_lineage").get()).toEqual({ first_lsn: turn.turnLsn, last_lsn: turn.turnLsn });
    expect(db().prepare("SELECT p.thread_id AS parent_thread FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_kind=2").all()).toEqual([{ parent_thread: "other" }]);
    expect(reserveLsns(db(), 5)).toBe(currentLsn(db()) - 5);
  });

  it("edits, branch switches, regenerate and conversation deletion are revoke roots", () => {
    appendMessage("chat", owner("o1"));
    appendMessage("chat", msg("b1", { parentId: "o1" }));
    updateMessage("chat", owner("o1", { text: "changed" }));
    expect(commitRevoke).toHaveBeenLastCalledWith(expect.anything(), { kind: "line", threadId: "chat", messageIds: ["o1"], cause: "edit" });
    appendMessage("chat", msg("b2", { parentId: "o1" }));
    expect(commitRevoke).toHaveBeenLastCalledWith(expect.anything(), { kind: "line", threadId: "chat", messageIds: ["b1"], cause: "regenerate" }, { until: expect.any(Number) }); // the range stops at the new branch's turn
    setActiveLeaf("chat", "b1");
    expect(commitRevoke).toHaveBeenLastCalledWith(expect.anything(), { kind: "line", threadId: "chat", messageIds: ["b2"], cause: "branch-switch" });
    // a streamed patch of a bot line is no revoke
    vi.mocked(commitRevoke).mockClear();
    updateMessage("chat", msg("b1", { text: "more" }));
    expect(commitRevoke).not.toHaveBeenCalled();
    deleteThread("chat");
    expect(commitRevoke).toHaveBeenLastCalledWith(expect.anything(), { kind: "thread", threadId: "chat", cause: "delete-conversation" });
  });
});

describe("a reply written after a mark is born marked", () => {
  it("a reply whose running turn carries a marked line inherits the mark in its own transaction", () => {
    appendMessage("other", msg("x1"));
    const x1 = Number(lineage("other", "x1")!.lsn);
    db().prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('other',?,42,?,'forget')").run(x1, x1);
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    addTurnParents(turn, [{ kind: "line", threadId: "other", messageId: "x1" }]);
    appendMessage("chat", msg("r1"));
    // the turn child inherits at its position (the marker's range from there denies every line of the turn)
    expect(db().prepare("SELECT revoke_id FROM memory_deny_line WHERE thread_id='chat' AND lsn=?").all(turn.turnLsn)).toEqual([{ revoke_id: 42 }]);
    expect(inheritMarks).toHaveBeenCalledWith(expect.anything(), { kind: "turn", threadId: "chat", lsn: turn.turnLsn, line: Number(lineage("chat", "r1")!.lsn), holdFrom: Number(lineage("chat", "r1")!.lsn) }, [], [{ threadId: "other", from: x1, to: x1 }]);
    // and a line written outside any turn, with no carried parent, inherits nothing
    closeTurnLineage(turn);
    appendMessage("chat", msg("r2"));
    expect(db().prepare("SELECT count(*) AS n FROM memory_deny_line WHERE thread_id='chat' AND lsn=?").get(Number(lineage("chat", "r2")!.lsn))).toEqual({ n: 0 });
  });

  it("a steer quote joins the running turn's parents; the fence refuses every verdict but a proven allow, the S0 not-built answer and a failed lookup included", () => {
    const turn = openTurnLineage(db(), { threadId: "chat", turnId: memberTurnId("bot") });
    const refs = quoteLineageRefs({ threadId: "chat", id: "q", copyOf: { threadId: "other", messageIds: ["x"] } });
    expect(refs).toEqual([{ kind: "line", threadId: "chat", messageId: "q" }, { kind: "line", threadId: "other", messageId: "x" }]);
    addTurnParents(turn, refs);
    addTurnParents(turn, refs);
    expect(turn.parents).toHaveLength(2);
    expect(turn.turnLsn).toBe(currentLsn(db()) - 1);
    for (const reason of ["no-lineage", "thread-not-ready", "pending", "footprint-wide", "lookup-error"] as const) expect(steerQuoteRefused({ state: "checking", reason })).toBe(true);
    expect(steerQuoteRefused({ state: "withheld", reason: "deny-line" })).toBe(true);
    expect(steerQuoteRefused({ state: "shown" })).toBe(false);
    expect(steerQuoteRefused({ state: "checking", reason: "not-built" })).toBe(true);
    expect(steerQuoteRefused(undefined)).toBe(true);
  });
});

describe("write cost is flat in history", () => {
  /** Message ids the length of the app's (a UUID, 36 characters), so bytes per message are the real ones. */
  const hId = (i: number) => `h${String(i).padStart(35, "0")}`, pId = (i: number) => `p${String(i).padStart(35, "0")}`;
  /** A thread `big` with `n` lines of history (the cross-thread parent's thread has as many), written straight into the lineage table. */
  function history(n: number) {
    const tx = db();
    tx.exec("BEGIN");
    const insert = tx.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
    const big = testThreadNo(tx, "big"), other = testThreadNo(tx, "other");
    for (let i = 1; i <= n; i++) { insert.run(big, 2 * i - 1, hId(i), i % 2 ? 2 * i - 2 : null); insert.run(other, 2 * i, pId(i), 2 * i - 1); }
    tx.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(2 * n + 1);
    tx.exec("COMMIT");
  }
  function measure(n: number) {
    history(n);
    const turn = openTurnLineage(db(), { threadId: "big", turnId: memberTurnId("bot") });
    const refs: LineageRef[] = [{ kind: "line", threadId: "other", messageId: pId(1) }, { kind: "line", threadId: "other", messageId: pId(n) },
      { kind: "prefix", threadId: "other" }, { kind: "receipt", bundleId: "b", lsn: 3, scopeIds: ["s1"] }, { kind: "line", threadId: "big", messageId: hId(1) }];
    addTurnParents(turn, refs);
    resetLineageWriteStats();
    transaction(tx => {
      writeLineage(tx, { threadId: "big", messageId: "reply", author: "generated" }, { turn });
      writeLineage(tx, { threadId: "big", messageId: "owner", author: "owner" }, {});
      writeLineage(tx, { threadId: "big", messageId: "reply", author: "generated" }, { turn, refs: [{ kind: "line", threadId: "other", messageId: pId(2) }] });
      writeSessionLineage(tx, { threadId: "big", driverInstance: "claude", nativeSession: "S" }, turn);
      writeRecordLineage(tx, { kind: "record", id: "n", version: 1 }, turn);
      writeCaptureLineage(tx, { threadId: "big", messageId: "owner" }, "src");
    });
    closeTurnLineage(turn);
    return lineageWriteStats();
  }
  it("the same statements and rows read at 1k and 100k lines of history", () => {
    const small = measure(1_000);
    closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const large = measure(100_000);
    expect(large).toEqual(small);
    expect(small.statements).toBeGreaterThan(0);
  }, 120_000);

  /** Bytes the named b-trees take (dbstat), or null when this SQLite has no dbstat. */
  function btreeBytes(names: readonly string[]): number | null {
    try { return Number(db().prepare(`SELECT coalesce(sum(pgsize),0) AS b FROM dbstat WHERE name IN (${names.map(() => "?").join(",")})`).get(...names)!.b); }
    catch { return null; }
  }
  /** A room turn on `big` shown the last 600 lines of `other` (one contiguous run) and 10 lines quoted further back, apart from each other;
   * it writes 20 replies. Returns the carry rows the turn added and the lineage bytes per stored line. */
  function roomTurn(n: number) {
    history(n);
    const carryRows = () => Number(db().prepare("SELECT count(*) AS n FROM memory_lineage_carry").get()!.n);
    const before = carryRows();
    const turn = openTurnLineage(db(), { threadId: "big", turnId: memberTurnId("bot") });
    const shown: LineageRef[] = Array.from({ length: 600 }, (_, k) => ({ kind: "line" as const, threadId: "other", messageId: pId(n - 599 + k) }));
    for (let k = 0; k < 10; k++) shown.push({ kind: "line", threadId: "other", messageId: pId(1 + k * Math.floor((n - 700) / 10)) });
    addTurnParents(turn, shown);
    transaction(tx => { for (let k = 0; k < 20; k++) writeLineage(tx, { threadId: "big", messageId: `room-reply-${k}`, author: "generated" }, { turn }); });
    closeTurnLineage(turn);
    const rows = Number(db().prepare("SELECT count(*) AS n FROM memory_line_lineage").get()!.n);
    const bytes = btreeBytes(["memory_line_lineage", "memory_line_lineage_msg"]);
    const carryBytes = btreeBytes(["memory_lineage_carry"]);
    return { carries: carryRows() - before, lineBytes: bytes === null ? null : bytes / rows, carryBytesPerReply: carryBytes === null ? null : carryBytes / 20 };
  }
  it("a room turn shown 600 cross-thread lines writes a handful of range carries once, and lineage bytes per message stay flat (1k and 100k lines)", () => {
    const small = roomTurn(1_000);
    closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const large = roomTurn(100_000);
    console.log(`WRITETIME-STORAGE carries per turn ${small.carries}/${large.carries}; line_lineage+index bytes per message ${small.lineBytes?.toFixed(1)}/${large.lineBytes?.toFixed(1)}; carry bytes per reply ${small.carryBytesPerReply?.toFixed(1)}/${large.carryBytesPerReply?.toFixed(1)}`);
    // 1 run of 600 lines + 10 lines apart from each other = 11 rows, for 20 replies (point carries per line would be 20 x 610)
    expect(small.carries).toBe(11);
    expect(large.carries).toBe(small.carries);
    if (small.lineBytes !== null && large.lineBytes !== null) {
      expect(large.lineBytes).toBeLessThanOrEqual(small.lineBytes * 1.3);
      expect(large.lineBytes).toBeLessThan(120);
    }
  }, 120_000);

  it("every writer statement is an index seek: no lineage table is scanned", () => {
    for (const [name, sql] of Object.entries(LINEAGE_WRITE_SQL)) {
      if (!/^\s*(SELECT|UPDATE|DELETE)/i.test(sql)) continue;
      const args = (sql.match(/\?/g) ?? []).map(() => 1);
      const plan = (db().prepare(`EXPLAIN QUERY PLAN ${sql.replace(/ RETURNING .*$/, "")}`).all(...args) as Array<{ detail: string }>).map(row => row.detail);
      for (const step of plan) expect(step, `${name}: ${step}`).not.toMatch(/^SCAN (memory_line_lineage|memory_lineage_carry|memory_thread_flow|memory_scope_sets|memory_scope_set_keys|memory_line_capture|memory_session_lineage)\b(?!.*USING)/);
    }
  });
});
