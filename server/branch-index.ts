// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The branch index: which rows of a thread are on the branch that ends at a
// given row, answered by key and in work that follows the number of forks, never
// the length of the thread.
//
// A thread is cut into SEGMENTS, chains of rows where each row is the parent of
// the next. A row that continues its parent joins the parent's segment; a row
// whose parent already has a continuation (a fork, an edit) starts a segment of
// its own, hung from that parent. Inside a segment every row has an ORDER KEY
// (a byte string, compared bytewise) that grows along the chain. "X is on the
// branch ending at L" is then:
//   - same segment: key(X) <= key(L);
//   - otherwise: find the ancestor segment c of L's segment that hangs from X's
//     segment (skew-binary jump pointers, O(log forks) reads), and X is on the
//     branch exactly when key(X) <= key(the row c hangs from).
// A row spliced in front of another (insertMessageBefore/After) takes a key
// strictly between its neighbours and joins their segment, so no rowid order is
// ever assumed. Nothing here is ever a CREATE INDEX on messages: every table is
// small and keyed by integers.
//
// Cost per message: msg_branch holds one row (about 10 bytes) with NULL seg and
// NULL ord for an ordinary append (the root segment, key = the row's own rowid).
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Tables of the branch index and of the line index. Owned here so the schema list and the offline inspector share one definition. */
export const BRANCH_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS thread_key(key INTEGER PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, root_seg INTEGER, state INTEGER NOT NULL DEFAULT 0, fill_cursor INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS seg(seg INTEGER PRIMARY KEY, key INTEGER NOT NULL, parent_seg INTEGER, attach INTEGER, lvl INTEGER NOT NULL, jump INTEGER, head INTEGER NOT NULL, tail INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seg_attach ON seg(key, attach);
CREATE TABLE IF NOT EXISTS msg_branch(mrow INTEGER PRIMARY KEY, seg INTEGER, ord BLOB, next INTEGER);
CREATE TABLE IF NOT EXISTS fill_pending(key INTEGER NOT NULL, parent INTEGER NOT NULL, mrow INTEGER NOT NULL, PRIMARY KEY(key, parent, mrow)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS line(key INTEGER NOT NULL, cls INTEGER NOT NULL, mrow INTEGER NOT NULL, PRIMARY KEY(key, cls, mrow)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS branch_change(thread_id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT NOT NULL, leave_at TEXT, join_at TEXT, leave_done INTEGER NOT NULL DEFAULT 0, join_done INTEGER NOT NULL DEFAULT 0, all_cursor TEXT) WITHOUT ROWID;`;

export const THREAD_UNPREPARED = 0;
export const THREAD_PREPARED = 2;

/** Row classes kept in `line`: text lines (kind "text" with words), the owner's rows without words, rows that point at a teammate's
 * thread (a mirrored reply, a "Messaged" chip), and one class per kind of completed action a row records. */
export const LINE_TEXT = 1;
/** An owner row with no words (a picture or a file alone): a text line carries every other owner row. */
export const LINE_OWNER = 3;
export const LINE_DELEGATION = 4;
/** A card that carries a request id, answered or not (the open ones are also in open_card). */
export const LINE_REQUEST_CARD = 5;
/** A bot's text row that is not a copy and has no words yet (a placeholder a stream will fill): with the text lines, it is a bot's replies. */
export const LINE_BOT_EMPTY = 6;
export const LINE_ACTION_BASE = 10;
export const ACTION_CLASS_NAMES = ["send", "save", "schedule", "delegate", "pay", "delete", "run", "change"] as const;
export const ALL_LINE_CLASSES: readonly number[] = [LINE_TEXT, LINE_OWNER, LINE_DELEGATION, LINE_REQUEST_CARD, LINE_BOT_EMPTY, ...ACTION_CLASS_NAMES.map((_, i) => LINE_ACTION_BASE + i)];

export interface ThreadKey { key: number; threadId: string; rootSeg: number | null; state: number; cursor: number }

// ── order keys ──────────────────────────────────────────────────────────────
const be64 = (value: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const EMPTY = Buffer.alloc(0);

/** A key strictly between `a` and `b` (a < b; `b` null means no upper bound). Throws when the two are adjacent. */
export function midKey(a: Buffer, b: Buffer | null): Buffer {
  const out: number[] = [];
  let tight = b !== null; // the digits chosen so far equal those of b
  for (let i = 0; ; i++) {
    const lo = i < a.length ? a[i]! : 0;
    let hi: number;
    if (!tight) hi = 256;
    else if (i < b!.length) hi = b![i]!;
    else throw new Error("midKey: bounds are adjacent");
    if (lo > hi) throw new Error("midKey: bounds are inverted");
    if (lo + 1 < hi) { out.push((lo + hi) >> 1); return Buffer.from(out); }
    out.push(lo);
    if (lo < hi) tight = false;
  }
}

/** A key just after `a`, short, for a row that continues a chain whose own rowid key is not high enough. */
export function afterKey(a: Buffer): Buffer {
  if (a.length === 12) {
    const counter = a.readUInt32BE(8);
    if (counter < 0xffffffff) { const next = Buffer.from(a); next.writeUInt32BE(counter + 1, 8); return next; }
  }
  const out = Buffer.alloc(a.length + 4);
  a.copy(out); out.writeUInt32BE(1, a.length);
  return out;
}

// ── statements ──────────────────────────────────────────────────────────────
interface Statements {
  keyByThread: StatementSync; keyInsert: StatementSync; keySetRoot: StatementSync; keyState: StatementSync;
  segGet: StatementSync; segInsert: StatementSync; segTail: StatementSync; segHead: StatementSync; segAttachMove: StatementSync; segByAttach: StatementSync;
  rowGet: StatementSync; rowInsert: StatementSync; rowNext: StatementSync; rowReplace: StatementSync; rowDelete: StatementSync;
  lineAdd: StatementSync; lineDelete: StatementSync;
}
const cache = new WeakMap<DatabaseSync, Statements>();
function stmts(db: DatabaseSync): Statements {
  let s = cache.get(db);
  if (s) return s;
  s = {
    keyByThread: db.prepare("SELECT key, root_seg AS rootSeg, state, fill_cursor AS cursor FROM thread_key WHERE thread_id = ?"),
    keyInsert: db.prepare("INSERT OR IGNORE INTO thread_key(thread_id, state) VALUES (?, ?)"),
    keySetRoot: db.prepare("UPDATE thread_key SET root_seg = ? WHERE key = ?"),
    keyState: db.prepare("UPDATE thread_key SET state = ?, fill_cursor = ? WHERE key = ?"),
    segGet: db.prepare("SELECT seg, key, parent_seg AS parent, attach, lvl, jump, head, tail FROM seg WHERE seg = ?"),
    segInsert: db.prepare("INSERT INTO seg(key, parent_seg, attach, lvl, jump, head, tail) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    segTail: db.prepare("UPDATE seg SET tail = ? WHERE seg = ?"),
    segHead: db.prepare("UPDATE seg SET head = ? WHERE seg = ?"),
    segAttachMove: db.prepare("UPDATE seg SET attach = ? WHERE key = ? AND attach = ?"),
    segByAttach: db.prepare("SELECT head FROM seg WHERE key = ? AND attach = ? ORDER BY head"),
    rowGet: db.prepare("SELECT seg, ord, next FROM msg_branch WHERE mrow = ?"),
    rowInsert: db.prepare("INSERT OR REPLACE INTO msg_branch(mrow, seg, ord, next) VALUES (?, ?, ?, ?)"),
    rowNext: db.prepare("UPDATE msg_branch SET next = ? WHERE mrow = ?"),
    rowReplace: db.prepare("INSERT OR REPLACE INTO msg_branch(mrow, seg, ord, next) VALUES (?, ?, ?, ?)"),
    rowDelete: db.prepare("DELETE FROM msg_branch WHERE mrow = ?"),
    lineAdd: db.prepare("INSERT OR IGNORE INTO line(key, cls, mrow) VALUES (?, ?, ?)"),
    lineDelete: db.prepare("DELETE FROM line WHERE key = ? AND cls = ? AND mrow = ?"),
  };
  cache.set(db, s);
  return s;
}

export function threadKey(db: DatabaseSync, threadId: string): ThreadKey | undefined {
  const row = stmts(db).keyByThread.get(threadId) as { key: number; rootSeg: number | null; state: number; cursor: number } | undefined;
  return row ? { key: Number(row.key), threadId, rootSeg: row.rootSeg === null ? null : Number(row.rootSeg), state: Number(row.state), cursor: Number(row.cursor) } : undefined;
}

/** The thread's key, created on first write. A thread with no other row yet is prepared by construction. */
export function ensureThreadKey(db: DatabaseSync, threadId: string, hasEarlierRows: () => boolean): ThreadKey {
  const found = threadKey(db, threadId);
  if (found) return found;
  stmts(db).keyInsert.run(threadId, hasEarlierRows() ? THREAD_UNPREPARED : THREAD_PREPARED);
  return threadKey(db, threadId)!;
}

interface SegRow { seg: number; key: number; parent: number | null; attach: number | null; lvl: number; jump: number | null; head: number; tail: number }
interface BranchRow { seg: number | null; ord: Buffer | null; next: number | null }

/** Reads made by the oracle and the writers, for the tests that hold a question to a bound. */
export const indexStats = { rowReads: 0, segReads: 0 };
const readSegRow = (db: DatabaseSync, seg: number): SegRow => {
  indexStats.segReads++;
  const r = stmts(db).segGet.get(seg) as Record<string, number | null> | undefined;
  if (!r) throw new Error(`branch index: segment ${seg} is missing`);
  return { seg: Number(r.seg), key: Number(r.key), parent: r.parent === null ? null : Number(r.parent), attach: r.attach === null ? null : Number(r.attach), lvl: Number(r.lvl), jump: r.jump === null ? null : Number(r.jump), head: Number(r.head), tail: Number(r.tail) };
};
const readBranchRow = (db: DatabaseSync, mrow: number): BranchRow | undefined => {
  indexStats.rowReads++;
  const r = stmts(db).rowGet.get(mrow) as { seg: number | null; ord: Uint8Array | null; next: number | null } | undefined;
  return r ? { seg: r.seg === null ? null : Number(r.seg), ord: r.ord === null ? null : Buffer.from(r.ord), next: r.next === null ? null : Number(r.next) } : undefined;
};
const segOf = (tk: ThreadKey, row: BranchRow): number => row.seg ?? tk.rootSeg!;
const ordOf = (mrow: number, row: BranchRow): Buffer => row.ord ?? be64(mrow);
const storedSeg = (tk: ThreadKey, seg: number): number | null => (seg === tk.rootSeg ? null : seg);

function newSegment(db: DatabaseSync, tk: ThreadKey, parent: SegRow | null, attach: number | null, head: number): number {
  let lvl = 0, jump: number | null = null;
  if (parent) {
    lvl = parent.lvl + 1;
    const first = readSegRow(db, parent.jump ?? parent.seg);
    const second = readSegRow(db, first.jump ?? first.seg);
    jump = parent.lvl - first.lvl === first.lvl - second.lvl ? second.seg : parent.seg;
  }
  const result = stmts(db).segInsert.run(tk.key, parent ? parent.seg : null, attach, lvl, jump, head, head);
  return Number(result.lastInsertRowid);
}

// ── the writer ──────────────────────────────────────────────────────────────
/** Encode a row whose parent row (`parentMrow`, or null for a root) is already encoded. */
/** `before` is the lowest rowid of a row already known to be this row's child (a row stored earlier that a splice gave this row as its
 * parent): this row's key then goes below that child's own, so the child and everything after it keep the keys their rowids give. */
export function encodeRow(db: DatabaseSync, tk: ThreadKey, mrow: number, parentMrow: number | null, before?: number): void {
  const s = stmts(db);
  const parentRow = parentMrow === null ? undefined : readBranchRow(db, parentMrow);
  if (parentMrow === null || !parentRow) {
    if (tk.rootSeg === null) {
      const seg = newSegment(db, tk, null, null, mrow);
      s.keySetRoot.run(seg, tk.key); tk.rootSeg = seg;
      s.rowInsert.run(mrow, null, null, null);
    } else {
      const seg = newSegment(db, tk, null, null, mrow);
      s.rowInsert.run(mrow, seg, null, null);
    }
    return;
  }
  const parentSeg = readSegRow(db, segOf(tk, parentRow));
  if (parentRow.next === null && parentSeg.tail === parentMrow) {
    const parentOrd = ordOf(parentMrow, parentRow);
    const own = be64(mrow), limit = before === undefined ? null : be64(before);
    const ord = Buffer.compare(own, parentOrd) > 0 && (limit === null || Buffer.compare(own, limit) < 0) ? null
      : limit !== null && Buffer.compare(limit, parentOrd) > 0 ? midKey(parentOrd, limit)
      : afterKey(parentOrd);
    s.rowInsert.run(mrow, storedSeg(tk, parentSeg.seg), ord, null);
    s.rowNext.run(mrow, parentMrow);
    s.segTail.run(mrow, parentSeg.seg);
    return;
  }
  const seg = newSegment(db, tk, parentSeg, parentMrow, mrow);
  s.rowInsert.run(mrow, seg, null, null);
}

/** The new row `newMrow` sits directly before `targetMrow`, whose parent it took (`parentMrow`, null for a root). */
export function spliceBefore(db: DatabaseSync, tk: ThreadKey, newMrow: number, targetMrow: number, parentMrow: number | null): boolean {
  const s = stmts(db);
  const targetRow = readBranchRow(db, targetMrow);
  if (!targetRow) return false;
  const seg = readSegRow(db, segOf(tk, targetRow));
  const targetOrd = ordOf(targetMrow, targetRow);
  if (seg.head === targetMrow) {
    s.rowInsert.run(newMrow, storedSeg(tk, seg.seg), midKey(EMPTY, targetOrd), targetMrow);
    s.segHead.run(newMrow, seg.seg);
    return true;
  }
  if (parentMrow === null) return false;
  const parentRow = readBranchRow(db, parentMrow);
  if (!parentRow || segOf(tk, parentRow) !== seg.seg || parentRow.next !== targetMrow) return false;
  s.rowInsert.run(newMrow, storedSeg(tk, seg.seg), midKey(ordOf(parentMrow, parentRow), targetOrd), targetMrow);
  s.rowNext.run(newMrow, parentMrow);
  return true;
}

/** The children of `anchorMrow`: its continuation, then the heads of the segments hung from it. */
export function childrenOf(db: DatabaseSync, tk: ThreadKey, anchorMrow: number): number[] {
  const row = readBranchRow(db, anchorMrow);
  if (!row) return [];
  const out: number[] = [];
  if (row.next !== null) out.push(row.next);
  for (const head of stmts(db).segByAttach.all(tk.key, anchorMrow) as Array<{ head: number }>) out.push(Number(head.head));
  return out.sort((a, b) => a - b);
}

/** The new row `newMrow` takes every child of `anchorMrow` as its own (the anchor's children are moved onto it). */
export function spliceAfter(db: DatabaseSync, tk: ThreadKey, newMrow: number, anchorMrow: number): boolean {
  const s = stmts(db);
  const anchorRow = readBranchRow(db, anchorMrow);
  if (!anchorRow) return false;
  const seg = readSegRow(db, segOf(tk, anchorRow));
  if (anchorRow.next === null) {
    if (seg.tail !== anchorMrow) return false;
    encodeRow(db, tk, newMrow, anchorMrow);
  } else {
    const succRow = readBranchRow(db, anchorRow.next);
    if (!succRow) return false;
    s.rowInsert.run(newMrow, storedSeg(tk, seg.seg), midKey(ordOf(anchorMrow, anchorRow), ordOf(anchorRow.next, succRow)), anchorRow.next);
    s.rowNext.run(newMrow, anchorMrow);
  }
  s.segAttachMove.run(newMrow, tk.key, anchorMrow);
  return true;
}

/** A row stored again under a new rowid (INSERT OR REPLACE): everything that named the old one names the new one.
 * `parentMrow` is its parent's rowid (null for a root), which names it as its continuation when they share a segment. */
export function moveRow(db: DatabaseSync, tk: ThreadKey, oldMrow: number, newMrow: number, parentMrow: number | null): void {
  const s = stmts(db);
  const row = readBranchRow(db, oldMrow);
  if (!row) return;
  const seg = readSegRow(db, segOf(tk, row));
  const ord = row.ord ?? be64(oldMrow); // the old default no longer holds under the new rowid
  s.rowDelete.run(oldMrow);
  s.rowInsert.run(newMrow, row.seg, ord, row.next);
  if (seg.head === oldMrow) s.segHead.run(newMrow, seg.seg);
  if (seg.tail === oldMrow) s.segTail.run(newMrow, seg.seg);
  s.segAttachMove.run(newMrow, tk.key, oldMrow);
  if (seg.head !== oldMrow) {
    const parentRow = parentMrow === null ? undefined : readBranchRow(db, parentMrow);
    if (!parentRow || parentRow.next !== oldMrow) throw new Error("branch index: the row before a moved row is not known");
    s.rowNext.run(newMrow, parentMrow);
  }
  db.prepare("UPDATE line SET mrow = ? WHERE key = ? AND mrow = ?").run(newMrow, tk.key, oldMrow);
}

/** Forget the derived rows of a thread whose structure is no longer known (a parent changed outside a splice): it is filled again. */
export function invalidateThread(db: DatabaseSync, tk: ThreadKey): void {
  forgetLineMemo(db);
  db.prepare("DELETE FROM msg_branch WHERE mrow IN (SELECT rowid FROM messages WHERE thread_id = ?)").run(tk.threadId);
  db.prepare("DELETE FROM seg WHERE key = ?").run(tk.key);
  db.prepare("DELETE FROM fill_pending WHERE key = ?").run(tk.key);
  stmts(db).keySetRoot.run(null, tk.key);
  stmts(db).keyState.run(THREAD_UNPREPARED, 0, tk.key);
  tk.rootSeg = null; tk.state = THREAD_UNPREPARED; tk.cursor = 0;
}

/** Drop everything derived for a thread (it is being deleted). */
export function dropThread(db: DatabaseSync, threadId: string): void {
  forgetLineMemo(db);
  const tk = threadKey(db, threadId);
  db.prepare("DELETE FROM msg_branch WHERE mrow IN (SELECT rowid FROM messages WHERE thread_id = ?)").run(threadId);
  if (!tk) return;
  db.prepare("DELETE FROM seg WHERE key = ?").run(tk.key);
  db.prepare("DELETE FROM fill_pending WHERE key = ?").run(tk.key);
  db.prepare("DELETE FROM line WHERE key = ?").run(tk.key);
  db.prepare("DELETE FROM thread_key WHERE key = ?").run(tk.key);
}

// ── lines ───────────────────────────────────────────────────────────────────
const lastClasses = new WeakMap<DatabaseSync, Map<string, string>>();
/** Keep `line` in step with a written row: exactly the classes it has now. A row whose classes are the ones this handle
 * last wrote for it costs no statement (streamed patches rewrite a row many times with the same classes). */
export function syncLines(db: DatabaseSync, tk: ThreadKey, mrow: number, now: readonly number[], force = false): void {
  let memo = lastClasses.get(db);
  if (!memo) { memo = new Map(); lastClasses.set(db, memo); }
  const at = `${tk.key}:${mrow}`, signature = now.join(",");
  const s = stmts(db);
  // A remembered row is trusted only while the table still holds what was remembered: the write that remembered it may have been
  // rolled back (a failed append), and its rowid reused by another row. One keyed read, instead of the writes it saves.
  if (!force && memo.get(at) === signature && linesMatch(db, tk.key, mrow, now)) return;
  for (const cls of ALL_LINE_CLASSES) {
    if (now.includes(cls)) s.lineAdd.run(tk.key, cls, mrow); else s.lineDelete.run(tk.key, cls, mrow);
  }
  if (memo.size > 20_000) memo.clear();
  memo.set(at, signature);
}
const linesHeld = new WeakMap<DatabaseSync, StatementSync>();
function linesMatch(db: DatabaseSync, key: number, mrow: number, now: readonly number[]): boolean {
  let read = linesHeld.get(db);
  if (!read) { read = db.prepare(`SELECT cls FROM line WHERE key = ? AND mrow = ? AND cls IN (${ALL_LINE_CLASSES.join(",")}) ORDER BY cls`); linesHeld.set(db, read); }
  const held = (read.all(key, mrow) as Array<{ cls: number }>).map((r) => Number(r.cls));
  return held.length === now.length && [...now].sort((a, b) => a - b).every((cls, i) => cls === held[i]);
}
/** Forget what this handle remembers of its rows' classes (a thread was refilled or deleted). */
export function forgetLineMemo(db: DatabaseSync): void { lastClasses.get(db)?.clear(); }

// ── the oracle ──────────────────────────────────────────────────────────────
/** A membership test for the branch ending at `leafMrow`. Reads are memoised for the life of the test. */
export function branchOracle(db: DatabaseSync, tk: ThreadKey, leafMrow: number | null): (mrow: number) => boolean {
  if (leafMrow === null) return () => false;
  const segs = new Map<number, SegRow>();
  const seg = (id: number): SegRow => { let v = segs.get(id); if (!v) { v = readSegRow(db, id); segs.set(id, v); } return v; };
  const leafRow = readBranchRow(db, leafMrow);
  if (!leafRow) return () => false;
  const leafSeg = seg(segOf(tk, leafRow));
  const leafOrd = ordOf(leafMrow, leafRow);
  const hanging = new Map<number, SegRow | null>(); // by target level: the ancestor segment of the leaf at that level
  const ancestorAt = (lvl: number): SegRow | null => {
    if (lvl > leafSeg.lvl) return null;
    if (hanging.has(lvl)) return hanging.get(lvl)!;
    let cur = leafSeg;
    while (cur.lvl > lvl) {
      const j = cur.jump === null ? null : seg(cur.jump);
      cur = j && j.lvl >= lvl ? j : seg(cur.parent!);
    }
    hanging.set(lvl, cur);
    return cur;
  };
  return (mrow) => {
    if (mrow === leafMrow) return true;
    const row = readBranchRow(db, mrow);
    if (!row) return false;
    const mySeg = segOf(tk, row);
    const myOrd = ordOf(mrow, row);
    if (mySeg === leafSeg.seg) return Buffer.compare(myOrd, leafOrd) <= 0;
    const mine = seg(mySeg);
    const child = ancestorAt(mine.lvl + 1);
    if (!child || child.parent !== mySeg || child.attach === null) return false;
    const attachRow = readBranchRow(db, child.attach);
    if (!attachRow) return false;
    return Buffer.compare(myOrd, ordOf(child.attach, attachRow)) <= 0;
  };
}

/** Which of two rows that are both on one branch comes later on it: positive when `a` is after `b`. A deeper segment is
 * later on the path; inside one segment the order key decides. */
export function compareOnBranch(db: DatabaseSync, tk: ThreadKey, a: number, b: number): number {
  if (a === b) return 0;
  const ra = readBranchRow(db, a), rb = readBranchRow(db, b);
  if (!ra || !rb) return 0;
  const sa = segOf(tk, ra), sb = segOf(tk, rb);
  if (sa !== sb) return readSegRow(db, sa).lvl - readSegRow(db, sb).lvl;
  return Buffer.compare(ordOf(a, ra), ordOf(b, rb));
}

/** Whether a row keeps the key its rowid gives (an ordinary append); a spliced, moved or relabeled row does not. */
export function isPlainRow(db: DatabaseSync, mrow: number): boolean {
  return readBranchRow(db, mrow)?.ord === null;
}

/** The parent of a row as the thread's JSON gives it, resolved to a rowid: undefined = the row stored before it (a legacy row). */
export function parentRowid(db: DatabaseSync, threadId: string, mrow: number, parentId: string | null | undefined): number | null {
  if (parentId === null) return null;
  if (parentId === undefined) {
    const prev = db.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1").get(threadId, mrow) as { r: number } | undefined;
    return prev ? Number(prev.r) : null;
  }
  const found = db.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(threadId, parentId) as { r: number } | undefined;
  return found ? Number(found.r) : null;
}

// ── the fill ────────────────────────────────────────────────────────────────
export interface FillResult { done: boolean; rows: number }

export interface FillRow { mrow: number; id: string; role: string; kind: string; text: string | null; ptype: string | null; parent: string | null; turn: string | null; body: string | null }
/** What else a fill keeps for the rows it reads (lines, turns, images, keyed cards), batched per slice. */
export interface FillSink { row(row: FillRow, key: number): void; flush(): void }

/** Rows of a linear chain are written behind: each row is held until its child is known, so it is written once with its
 * continuation, in batches, and the segment's tail is set once per slice. Anything that is not the next link of the chain
 * flushes the buffer and goes the ordinary way. */
class ChainBuffer {
  private rows: Array<[number, number | null, Buffer | null, number | null]> = [];
  private last: { mrow: number; id: string; seg: number | null; segId: number; ord: Buffer | null } | null = null;
  private tails = new Map<number, number>();
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  /** Take `row` as the next link when its parent is the last row held (or it has none and follows it, as a legacy row does). */
  extend(parentId: string | null | undefined, mrow: number, id: string): boolean {
    const last = this.last;
    if (!last || !(parentId === undefined || parentId === last.id)) return false;
    const lastOrd = last.ord ?? be64(last.mrow);
    const ord = Buffer.compare(be64(mrow), lastOrd) > 0 ? null : afterKey(lastOrd);
    this.rows.push([last.mrow, last.seg, last.ord, mrow]);
    this.last = { mrow, id, seg: last.seg, segId: last.segId, ord };
    this.tails.set(last.segId, mrow);
    return true;
  }
  /** A row the ordinary way just encoded as the tail of its segment: the chain goes on from it. */
  start(db: DatabaseSync, tk: ThreadKey, mrow: number, id: string): void {
    const row = readBranchRow(db, mrow);
    this.last = row ? { mrow, id, seg: row.seg, segId: segOf(tk, row), ord: row.ord } : null;
  }
  flush(): void {
    if (this.last) this.rows.push([this.last.mrow, this.last.seg, this.last.ord, null]);
    for (let i = 0; i < this.rows.length; i += 250) {
      const chunk = this.rows.slice(i, i + 250);
      const sql = `INSERT OR REPLACE INTO msg_branch(mrow, seg, ord, next) VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}`;
      this.db.prepare(sql).run(...chunk.flatMap((r) => r));
    }
    const setTail = stmts(this.db).segTail;
    if (this.last) this.tails.set(this.last.segId, this.last.mrow);
    for (const [seg, tail] of this.tails) setTail.run(tail, seg);
    this.rows = []; this.tails.clear(); this.last = null;
  }
}

/** Fill one slice of a thread's derived rows, in rowid order, inside the caller's transaction. A row whose parent is
 * not encoded yet (a spliced parent stored later) waits in fill_pending until the parent lands. The slice that reaches
 * the end of the thread marks it prepared in the same transaction, so there is no moment when it is half-known and
 * called whole. A slice stops at `maxRows` rows or `budgetMs`, whichever comes first. */
export function fillSlice(db: DatabaseSync, threadId: string, maxRows: number, budgetMs: number, now: () => number = () => performance.now(), sink?: FillSink): FillResult {
  const tk = threadKey(db, threadId) ?? ensureThreadKey(db, threadId, () => true);
  if (tk.state === THREAD_PREPARED) return { done: true, rows: 0 };
  const s = stmts(db);
  const started = now();
  // `body` is the row's JSON only for the rows that can be more than a plain line: activity rows (tool outcomes), rows
  // naming a teammate's thread, saved files, pictures or steers; every other row is classified from its columns alone.
  const batch = db.prepare(
    `SELECT rowid AS mrow, id, role, kind, text,
      CASE WHEN json_valid(json) THEN json_type(json, '$.parentId') END AS ptype, CASE WHEN json_valid(json) THEN json_extract(json, '$.parentId') END AS parent,
      CASE WHEN json_valid(json) THEN json_extract(json, '$.turnId') END AS turn,
      CASE WHEN kind = 'activity' OR (role = 'user' AND (text IS NULL OR text = '')) OR instr(json, '"copyOf"') > 0 OR instr(json, '"comm"') > 0 OR instr(json, '"artifactIds"') > 0 OR instr(json, '"attachments"') > 0 OR instr(json, '<attached-image') > 0
        OR (kind = 'options' AND instr(json, '"requestId"') > 0) OR instr(json, '"steerUnconfirmed"') > 0 OR instr(json, '"setupEcho"') > 0 OR instr(json, '"routineRunPrompt"') > 0 OR instr(json, '"digestDay"') > 0 THEN json END AS body
     FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
  ).all(threadId, tk.cursor, maxRows) as unknown as FillRow[];
  const pendingOn = db.prepare("SELECT mrow FROM fill_pending WHERE key = ? AND parent = ? ORDER BY mrow");
  const unwait = db.prepare("DELETE FROM fill_pending WHERE key = ? AND parent = ? AND mrow = ?");
  const waitInsert = db.prepare("INSERT OR IGNORE INTO fill_pending(key, parent, mrow) VALUES (?, ?, ?)");
  // the rows some earlier row is waiting for: a row among them is never taken down the quick chain path
  const waiting = new Set((db.prepare("SELECT DISTINCT parent FROM fill_pending WHERE key = ?").all(tk.key) as Array<{ parent: number }>).map((r) => Number(r.parent)));
  const wait = { run: (key: number, parent: number, mrow: number) => { waitInsert.run(key, parent, mrow); waiting.add(parent); } };
  /** Encode a row, then every row that was waiting for it (iteratively: a wait can be as long as a thread). Returns how many rows it encoded. */
  const settle = (first: number, firstParent: number | null): number => {
    const queue: Array<[number, number | null]> = [[first, firstParent]];
    let encoded = 0;
    while (queue.length) {
      const [mrow, parent] = queue.pop()!;
      const children = waiting.has(mrow) ? pendingOn.all(tk.key, mrow) as Array<{ mrow: number }> : [];
      encodeRow(db, tk, mrow, parent, children.length ? Number(children[0]!.mrow) : undefined); encoded++;
      for (let i = children.length - 1; i >= 0; i--) { unwait.run(tk.key, mrow, children[i]!.mrow); queue.push([Number(children[i]!.mrow), mrow]); }
      waiting.delete(mrow);
    }
    return encoded;
  };
  const chain = new ChainBuffer(db);
  let cursor = tk.cursor, rows = 0;
  for (const row of batch) {
    const mrow = Number(row.mrow);
    sink?.row(row, tk.key);
    const parentId = row.ptype === null ? undefined : row.ptype === "null" ? null : typeof row.parent === "string" ? row.parent : null;
    if (waiting.has(mrow) || !chain.extend(parentId, mrow, row.id)) {
      chain.flush();
      const parent = parentRowid(db, threadId, mrow, parentId);
      if (parent === mrow) { settle(mrow, null); }
      else if (parent !== null && !readBranchRow(db, parent)) wait.run(tk.key, parent, mrow);
      else if (settle(mrow, parent) === 1) chain.start(db, tk, mrow, row.id);
    }
    cursor = mrow; rows++;
    if (now() - started >= budgetMs) break;
  }
  chain.flush();
  sink?.flush();
  if (!db.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? AND rowid > ? LIMIT 1").get(threadId, cursor)) {
    // rows whose parent never landed (a cycle among them) are roots
    for (;;) {
      const stuck = db.prepare("SELECT parent, mrow FROM fill_pending WHERE key = ? ORDER BY mrow LIMIT 1").get(tk.key) as { parent: number; mrow: number } | undefined;
      if (!stuck) break;
      unwait.run(tk.key, stuck.parent, stuck.mrow);
      settle(Number(stuck.mrow), null);
    }
    s.keyState.run(THREAD_PREPARED, cursor, tk.key);
    tk.state = THREAD_PREPARED; tk.cursor = cursor;
    return { done: true, rows };
  }
  s.keyState.run(THREAD_UNPREPARED, cursor, tk.key);
  tk.cursor = cursor;
  return { done: false, rows };
}

// ── a check that the derived rows still name the rows they were made for ────
/** The derived tables are keyed by messages.rowid. A rewrite of the file that renumbers rowids (a VACUUM on a build whose
 * messages table has no integer key, a restore) would leave them naming other rows. Sample some: when one names a row of
 * another thread, or of none, every thread is marked unprepared and filled again (the fill rebuilds all of it). Returns
 * whether they were found sound. */
export function verifyDerivedRows(db: DatabaseSync, samples = 24): boolean {
  const table = (name: string) => db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = ?").get(name) !== undefined;
  if (!table("line") || !table("thread_key")) return true;
  const threads = db.prepare("SELECT key, thread_id AS threadId FROM thread_key WHERE state = ? ORDER BY random() LIMIT ?").all(THREAD_PREPARED, samples) as Array<{ key: number; threadId: string }>;
  const newestLine = db.prepare("SELECT mrow FROM line WHERE key = ? AND cls = ? ORDER BY mrow DESC LIMIT 1");
  const threadOf = db.prepare("SELECT thread_id AS threadId FROM messages WHERE rowid = ?");
  let sound = true;
  for (const thread of threads) {
    const line = newestLine.get(thread.key, LINE_TEXT) as { mrow: number } | undefined;
    if (!line) continue;
    const stored = threadOf.get(line.mrow) as { threadId: string } | undefined;
    if (!stored || stored.threadId !== thread.threadId) { sound = false; break; }
  }
  if (sound) return true;
  db.exec("DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM turn_first; UPDATE thread_key SET state = 0, fill_cursor = 0, root_seg = NULL;");
  forgetLineMemo(db);
  return false;
}
