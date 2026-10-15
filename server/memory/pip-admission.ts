// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP admission (design 3.1 "Two admission branches", I-1, I-2): which captured sources may ground or occasion
// a lived row. Owner turns and completed actions only; bot turns, tool failures and every memory_records row
// are never admitted. Re-exported from pip-reflect.ts.
import type { DatabaseSync } from "node:sqlite";
import { turnAudienceIsOwner } from "../owner-audience.ts";
import { heldStep } from "../observe.ts";
import { isLearnableSource } from "./learnable.ts";
import { learningSourceBot } from "./learning-guard.ts";
import { threadMemoryRoom } from "./capture-scope.ts";

export interface AdmittedSource {
  kind: "owner" | "action";
  sourceId: string; revision: number; messageId: string | null; threadId: string;
  /** The bytes a quote may point into: the message text, or for an action the label. */
  text: string;
  occurredAt: number;
}
export interface SpanQuery {
  threadId: string;
  /** Exclusive cursor: only sources after this (occurredAt, messageId). */
  afterAt?: number; afterMessageId?: string | null;
  /** Inclusive upper bound by occurredAt. */
  untilAt?: number;
  excludedThreads?: readonly string[];
  limit?: number;
}

const after = (at: number, id: string | null, q: SpanQuery) => {
  if (q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")))) return false;
  if (q.untilAt !== undefined && at > q.untilAt) return false;
  return true;
};

/** The thread belongs to this bot's own direct conversation (not a room or desk) and is not excluded. */
export function threadIsBotsOwn(botId: string, threadId: string, excluded: readonly string[] = []): boolean {
  if (excluded.includes(threadId)) return false;
  if (threadMemoryRoom(threadId) !== null) return false;
  return learningSourceBot(threadId)?.id === botId;
}

function rows(db: DatabaseSync, q: SpanQuery, kind: "text" | "tool-outcome") {
  return db.prepare(`SELECT s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id=? AND s.kind=? AND s.state='active'`).all(q.threadId, kind);
}
const sourceTombstoned = (db: DatabaseSync, id: string, revision: number) =>
  Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, revision));

type SourceRow = Record<string, unknown>;
/** I-1 for one row of `rows(…, "text")`: the admitted source, or null. */
function ownerRow(db: DatabaseSync, q: SpanQuery, r: SourceRow): AdmittedSource | null {
  if (r.speaker !== "owner") return null;
  let payload: { text?: unknown; occurredAt?: unknown };
  try { payload = JSON.parse(String(r.payload)); } catch { return null; }
  if (typeof payload.text !== "string") return null;
  const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
  if (!after(at, r.message_id === null ? null : String(r.message_id), q)) return null;
  if (!isLearnableSource(db, String(r.id), Number(r.revision)).learnable) return null;
  return { kind: "owner", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: payload.text, occurredAt: at };
}
/** I-2 for one row of `rows(…, "tool-outcome")`: the admitted source, or null. */
function actionRow(db: DatabaseSync, q: SpanQuery, r: SourceRow): AdmittedSource | null {
  if (r.speaker !== "tool" || r.outcome !== "completed") return null;
  if (sourceTombstoned(db, String(r.id), Number(r.revision))) return null;
  let payload: { occurredAt?: unknown; action?: { label?: unknown } };
  try { payload = JSON.parse(String(r.payload)); } catch { return null; }
  const label = payload.action?.label;
  if (typeof label !== "string" || !label) return null;
  const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
  if (!after(at, r.message_id === null ? null : String(r.message_id), q)) return null;
  return { kind: "action", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: label, occurredAt: at };
}
const finish = (out: AdmittedSource[], q: SpanQuery): AdmittedSource[] => {
  out.sort((a, b) => a.occurredAt - b.occurredAt || (a.messageId ?? "").localeCompare(b.messageId ?? ""));
  return q.limit ? out.slice(0, q.limit) : out;
};

/** I-1. speaker owner, kind text, learnable (attended or verified-owner channel origin), this bot's own thread. */
export function admissibleOwnerSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  const out: AdmittedSource[] = [];
  for (const r of rows(db, q, "text")) { const admitted = ownerRow(db, q, r); if (admitted) out.push(admitted); }
  return finish(out, q);
}

/** I-2. A completed tool outcome from this bot's own thread; the grounding bytes are the action label. */
export function admissibleActionSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return [];
  const out: AdmittedSource[] = [];
  for (const r of rows(db, q, "tool-outcome")) { const admitted = actionRow(db, q, r); if (admitted) out.push(admitted); }
  return finish(out, q);
}

/** Thread sources one page of a sliced walk reads. */
export const THREAD_SOURCE_PAGE_ROWS = 64;
/** The thread's sources in pages: each page is the next THREAD_SOURCE_PAGE_ROWS keys of the thread by rowid, read from the thread index alone
 *  (`memory_sources_thread` holds the rowid), then only those rows and their payloads; `between()` is awaited after each page. No statement reads
 *  more than one page of rows from the tables, however long the thread (rc13 real-data run, server3.log:27-31: ten whole-thread reads of the
 *  reflection run's candidate scan, about 103 ms each, held the loop 2292 ms in one turn). `order` "desc" walks newest first. */
export async function forEachThreadSourcePage(db: DatabaseSync, threadId: string, kind: "text" | "tool-outcome", between: () => Promise<void>,
  visit: (rows: SourceRow[]) => boolean | void, order: "asc" | "desc" = "asc", pageRows = THREAD_SOURCE_PAGE_ROWS): Promise<void> {
  const keys = db.prepare(order === "asc"
    ? "SELECT rowid AS pos FROM memory_sources WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT ?"
    : "SELECT rowid AS pos FROM memory_sources WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?");
  const page = db.prepare(`SELECT s.rowid AS pos,s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.rowid IN (SELECT value FROM json_each(?)) AND s.kind=? AND s.state='active' ORDER BY s.rowid ${order === "asc" ? "ASC" : "DESC"}`);
  for (let from = order === "asc" ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER; ;) {
    // each page is one named step, so a slow one is never unattributed on a stall line
    const rows = heldStep("memory.pip.threads", () => {
      const found = keys.all(threadId, from, pageRows).map(row => Number(row.pos));
      return { found, rows: found.length ? page.all(JSON.stringify(found), kind) as SourceRow[] : [] };
    });
    const found = rows.found;
    if (!found.length) return;
    if (visit(rows.rows) === true) return;
    if (found.length < pageRows) return;
    from = found[found.length - 1]!;
    await between();
  }
}
/** admissibleOwnerSources, the same list, read by forEachThreadSourcePage. */
export async function admissibleOwnerSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>): Promise<AdmittedSource[]> {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  const out: AdmittedSource[] = [];
  await forEachThreadSourcePage(db, q.threadId, "text", between, page => { for (const r of page) { const admitted = ownerRow(db, q, r); if (admitted) out.push(admitted); } });
  return finish(out, q);
}
/** admissibleActionSources, the same list, read by forEachThreadSourcePage. */
export async function admissibleActionSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>): Promise<AdmittedSource[]> {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return [];
  const out: AdmittedSource[] = [];
  await forEachThreadSourcePage(db, q.threadId, "tool-outcome", between, page => { for (const r of page) { const admitted = actionRow(db, q, r); if (admitted) out.push(admitted); } });
  return finish(out, q);
}

/** The pending check only: true when some source is admissible after the cursor of `q`. It reads the thread's sources newest first (capture order) and stops
 * at the first admissible one, or at the first one at or before the cursor, so it reads the rows after the cursor and one more, never the whole thread.
 * `onPayload` is a test seam counting the payloads read. The run itself keeps the full lists. */
/** Rows one page of the sliced pending check reads before it may hand the event loop back. */
export const ADMISSIBLE_PAGE_ROWS = 64;
/** hasAdmissibleAfter, the same answer, read in pages of ADMISSIBLE_PAGE_ROWS by rowid with `between()` awaited after each page (it hands the
 *  event loop back when the caller's slice is spent): a thread with a long history and no cursor yet (never reflected) walks every owner turn,
 *  which on a large store held the serving thread for hundreds of milliseconds (rc13 real-data boot, `memory.pip.pending:261ms`). */
export async function hasAdmissibleAfterSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>): Promise<boolean> {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return false;
  const beforeCursor = (at: number, id: string | null) => q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")));
  // newest first by forEachThreadSourcePage (the old page statement filtered kind and speaker in the table, so each page read every row of the thread)
  const walk = async (kind: "text" | "tool-outcome", where: (r: SourceRow) => boolean, admit: (r: SourceRow, payload: Record<string, unknown>, at: number) => boolean): Promise<boolean> => {
    let answer = false;
    await forEachThreadSourcePage(db, q.threadId, kind, between, page => {
      for (const r of page) {
        if (!where(r)) continue;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { continue; }
        const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
        const messageId = r.message_id === null ? null : String(r.message_id);
        if (beforeCursor(at, messageId)) return true;
        if (q.untilAt !== undefined && at > q.untilAt) continue;
        if (admit(r, payload, at)) { answer = true; return true; }
      }
      return false;
    }, "desc", ADMISSIBLE_PAGE_ROWS);
    return answer;
  };
  if (await walk("text", r => r.speaker === "owner", (r, payload) => typeof payload.text === "string" && isLearnableSource(db, String(r.id), Number(r.revision)).learnable)) return true;
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return false;
  return walk("tool-outcome", r => r.speaker === "tool" && r.outcome === "completed", (r, payload) => {
    const label = (payload.action as { label?: unknown } | undefined)?.label;
    return typeof label === "string" && label.length > 0 && !sourceTombstoned(db, String(r.id), Number(r.revision));
  });
}
export function hasAdmissibleAfter(db: DatabaseSync, botId: string, q: SpanQuery, onPayload?: () => void): boolean {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return false;
  const beforeCursor = (at: number, id: string | null) => q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")));
  const walk = (kind: "text" | "tool-outcome", where: string, admit: (r: Record<string, unknown>, payload: Record<string, unknown>, at: number) => boolean): boolean => {
    const statement = db.prepare(`SELECT s.id,s.revision,s.message_id,s.speaker,s.outcome,v.payload FROM memory_sources s
      JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
      WHERE s.thread_id=? AND s.kind=? AND s.state='active' AND ${where} ORDER BY s.rowid DESC`);
    for (const r of statement.iterate(q.threadId, kind) as Iterable<Record<string, unknown>>) {
      let payload: Record<string, unknown>;
      onPayload?.();
      try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { continue; }
      const at = Number.isSafeInteger(payload.occurredAt) ? Number(payload.occurredAt) : 0;
      const messageId = r.message_id === null ? null : String(r.message_id);
      if (beforeCursor(at, messageId)) return false;
      if (q.untilAt !== undefined && at > q.untilAt) continue;
      if (admit(r, payload, at)) return true;
    }
    return false;
  };
  if (walk("text", "s.speaker='owner'", (r, payload) => typeof payload.text === "string" && isLearnableSource(db, String(r.id), Number(r.revision)).learnable)) return true;
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return false;
  return walk("tool-outcome", "s.speaker='tool' AND s.outcome='completed'", (r, payload) => {
    const label = (payload.action as { label?: unknown } | undefined)?.label;
    return typeof label === "string" && label.length > 0 && !sourceTombstoned(db, String(r.id), Number(r.revision));
  });
}

/** Re-check one grounding handle: used inside the confirm transaction (I-1) and before an episode is written. */
export function ownerSourceStillAdmissible(db: DatabaseSync, botId: string, sourceId: string, revision: number, excluded: readonly string[] = []): boolean {
  const row = db.prepare("SELECT thread_id,speaker,kind,revision,state FROM memory_sources WHERE id=?").get(sourceId);
  if (!row || row.state !== "active" || Number(row.revision) !== revision || row.kind !== "text" || row.speaker !== "owner") return false;
  if (!threadIsBotsOwn(botId, String(row.thread_id), excluded)) return false;
  return isLearnableSource(db, sourceId, revision).learnable;
}

/** The exact bytes `[start, end)` of a source's text, or null when the span is not on code point boundaries or out of range. */
export function boundQuote(text: string, start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  const bytes = Buffer.from(text, "utf8");
  if (end > bytes.length) return null;
  const continuation = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
  if (continuation(start) || continuation(end)) return null;
  return bytes.subarray(start, end).toString("utf8");
}
