// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test tree only. The proof the write-time differential asks of every RANGE-BASED withhold of a line the frozen RC judge shows (OVERWITHHOLD.md):
// proven positional, or a counted over-withhold, or unproven (null: it blocks). Computed from the legacy rows (messages, turn_first, tombstones) and
// the ranges, never from the lineage the U2 seed read to bound them.
import type { DatabaseSync } from "node:sqlite";

export type RangeClass = "positional" | "positional-branch" | "range-unplaced" | "range-coalesced";

export function rangeProof(db: DatabaseSync): { proveRange(threadId: string, messageId: string, revokes?: readonly number[]): RangeClass | null; diagnose(threadId: string, messageId: string): string; RANGE_RANK: Record<string, number>; reset(): void } {
  // ---- the proof of a range-based withhold (OVERWITHHOLD.md: positional, positional-branch, range-coalesced) ----
  // A range withholds a generated line L after the line `a` it starts at, whose turn was put together before the range ends. It is PROVEN
  // positional only when the reader of L could have seen `a`: `a` is an ancestor of L (the parent chain of the legacy rows; a flat file with
  // no parent names is one chain in write order), and, for a range the U2 seed bounded by the forget's time (reason `...:until`), L was
  // written before that forget or its turn began before it (an owner line the turn answered, or the parent of its first row, older than the
  // forget): computed here from the legacy rows, not from the lineage the seed read. When `a` is not an ancestor the range withholds a line
  // from another branch (revbound R2), counted as `positional-branch`; a range merged past DENY_RANGE_COALESCE is `range-coalesced`. Anything
  // else is unproven (null) and blocks.
  interface ThreadView { order: string[]; pos: Map<string, number>; at: Map<string, number>; role: Map<string, string>; parent: Map<string, string | null>; turn: Map<string, string | null>; firstOfTurn: Map<string, string>; explicit: boolean }
  const views = new Map<string, ThreadView>();
  const viewOf = (thread: string): ThreadView => {
    let view = views.get(thread);
    if (view) return view;
    view = { order: [], pos: new Map(), at: new Map(), role: new Map(), parent: new Map(), turn: new Map(), firstOfTurn: new Map(), explicit: false };
    const byRowid = new Map<number, string>();
    for (const row of db.prepare("SELECT rowid AS r,id,at,role,json_extract(json,'$.parentId') AS p,json_extract(json,'$.turnId') AS t FROM messages WHERE thread_id=? ORDER BY rowid").all(thread)) {
      const id = String(row.id);
      view.pos.set(id, view.order.length); view.order.push(id); byRowid.set(Number(row.r), id);
      view.at.set(id, Number(row.at)); view.role.set(id, String(row.role));
      view.parent.set(id, typeof row.p === "string" ? row.p : null); view.turn.set(id, typeof row.t === "string" ? row.t : null);
      if (typeof row.p === "string") view.explicit = true;
    }
    for (const row of db.prepare("SELECT turn_id,first_rowid FROM turn_first WHERE thread_id=?").all(thread)) { const first = byRowid.get(Number(row.first_rowid)); if (first) view.firstOfTurn.set(String(row.turn_id), first); }
    views.set(thread, view);
    return view;
  };
  const parentOf = (view: ThreadView, id: string): string | null => {
    const named = view.parent.get(id) ?? null;
    if (named !== null) return view.pos.has(named) ? named : null;
    if (view.explicit) return null;
    const at = view.pos.get(id);
    return at === undefined || at === 0 ? null : view.order[at - 1]!;
  };
  const isAncestor = (thread: string, line: string, origin: string): boolean => {
    const view = viewOf(thread);
    for (let cur = parentOf(view, line), hops = 0; cur !== null && hops <= view.order.length; cur = parentOf(view, cur), hops++) if (cur === origin) return true;
    return false;
  };
  /** Whether L's turn may have been put together before the forget at `forgetAt`: written before it, or begun before it (fail closed when unreadable). */
  const exposedByTime = (thread: string, line: string, forgetAt: number): boolean => {
    const view = viewOf(thread);
    if (Number(view.at.get(line)) < forgetAt) return true;
    const turn = view.turn.get(line) ?? null, first = turn === null ? undefined : view.firstOfTurn.get(turn);
    if (first === undefined) return true;
    const bound = view.role.get(first) === "user" ? view.at.get(first) : (() => { const parent = view.parent.get(first) ?? null; return parent === null ? undefined : view.at.get(parent); })();
    return bound === undefined || !Number.isFinite(bound) || bound < forgetAt;
  };
  /** What the proof saw for one withheld line (failure messages only). */
  const diagnose = (threadId: string, messageId: string): string => {
    const no = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId)?.no as number | undefined;
    const line = db.prepare("SELECT lsn,turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no ?? -1, messageId);
    const ranges = line ? db.prepare("SELECT from_lsn AS f,until_turn_lsn AS u,revoke_id AS r,reason FROM memory_deny_range WHERE thread_id=? AND from_lsn<? AND ?<until_turn_lsn").all(threadId, Number(line.lsn), Number(line.tl)) : [];
    return JSON.stringify({ line: line ? { ...line } : null, ranges: ranges.map(range => { const origin = db.prepare("SELECT message_id FROM memory_line_lineage WHERE thread_no=? AND lsn=?").get(no ?? -1, Number(range.f))?.message_id; return { ...range, origin, ancestor: typeof origin === "string" ? isAncestor(threadId, messageId, origin) : null }; }) });
  };
  const RANGE_RANK: Record<string, number> = { positional: 4, "positional-branch": 3, "range-unplaced": 2, "range-coalesced": 1 };
  /** Whether the thread holds a line with no lineage row (U1 found its ancestry unprovable and wrote none): a range that starts at no row
   * (the first lsn, for a root with no position, or the lsn of such a line reached through a carry) has no origin line to prove by. Proven from
   * the rows, once per thread. */
  const unplacedMemo = new Map<string, boolean>();
  const hasUnplacedRoot = (thread: string): boolean => {
    const kept = unplacedMemo.get(thread);
    if (kept !== undefined) return kept;
    const no = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(thread)?.no as number | undefined;
    const found = Boolean(db.prepare("SELECT 1 AS x FROM messages m WHERE m.thread_id=? AND NOT EXISTS (SELECT 1 FROM memory_line_lineage l WHERE l.thread_no=? AND l.message_id=m.id) LIMIT 1").get(thread, no ?? -1));
    unplacedMemo.set(thread, found);
    return found;
  };
  /** The class of the strongest range (of `revokes`, or any) that covers the line, or null when none proves it. */
  const proveRange = (threadId: string, messageId: string, revokes?: readonly number[]): string | null => {
    const no = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId)?.no as number | undefined;
    const line = no === undefined ? undefined : db.prepare("SELECT lsn,turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no, messageId);
    if (!line || line.tl === null) return null;
    let best: string | null = null;
    const rank = (cls: string | null) => cls === null ? 0 : RANGE_RANK[cls]!;
    for (const range of db.prepare("SELECT from_lsn AS f,revoke_id AS r,reason FROM memory_deny_range WHERE thread_id=? AND from_lsn<? AND ?<until_turn_lsn").all(threadId, Number(line.lsn), Number(line.tl))) {
      const revoke = Number(range.r);
      if (revokes && !revokes.includes(revoke) && revoke >= 0) continue;
      let cls: string | null;
      if (revoke < 0) cls = "range-coalesced";
      else {
        const origin = db.prepare("SELECT message_id FROM memory_line_lineage WHERE thread_no=? AND lsn=?").get(no!, Number(range.f))?.message_id;
        if (typeof origin !== "string") cls = hasUnplacedRoot(threadId) ? "range-unplaced" : null;
        else if (!isAncestor(threadId, messageId, origin)) cls = "positional-branch";
        else if (String(range.reason).endsWith(":until")) {
          const forgetAt = db.prepare("SELECT min(created_at) AS t FROM memory_tombstones WHERE target_id=?").get(`message:${threadId}:${origin}`)?.t;
          cls = typeof forgetAt === "number" && exposedByTime(threadId, messageId, forgetAt) ? "positional" : null;
        } else cls = "positional";
      }
        if (rank(cls) > rank(best)) best = cls;
    }
    return best;
  };
  return { proveRange: proveRange as (threadId: string, messageId: string, revokes?: readonly number[]) => RangeClass | null, diagnose, RANGE_RANK, reset: () => { views.clear(); unplacedMemo.clear(); } };
}
