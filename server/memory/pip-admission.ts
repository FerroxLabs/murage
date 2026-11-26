// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP admission (design 3.1 "Two admission branches", I-1, I-2): which captured sources may ground or occasion
// a lived row. Owner turns and completed actions only; bot turns, tool failures and every memory_records row
// are never admitted. Re-exported from pip-reflect.ts.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { connectionId } from "../database.ts";
import { audienceFingerprint, turnAudienceIsOwner } from "../owner-audience.ts";
import { heldStep } from "../observe.ts";
import { isDatabaseBusy } from "../db-busy.ts";
import { ioBudget } from "../io-budget.ts";
import { DENIED_PLACE, DENIED_RECORD_SCOPE, threadDenied } from "./deny.ts";
import { isLearnableSource } from "./learnable.ts";
import { learningSourceBot } from "./learning-guard.ts";
import { threadMemoryRoom } from "./capture-scope.ts";

export interface AdmittedSource {
  kind: "owner" | "action";
  sourceId: string; revision: number; messageId: string | null; threadId: string;
  /** The bytes a quote may point into: the message text, or for an action the label. */
  text: string;
  occurredAt: number;
  /** The source's rowid when it was read (capture order): the last tie-breaker of compareAdmitted. */
  pos?: number;
}
/** The one order of admitted sources, total and deterministic (3.10): occurredAt, then message id, then capture order (rowid), then id. */
export const compareAdmitted = (a: AdmittedSource, b: AdmittedSource): number =>
  a.occurredAt - b.occurredAt || (a.messageId ?? "").localeCompare(b.messageId ?? "") || (a.pos ?? 0) - (b.pos ?? 0) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
/** A payload's occurredAt, or null when it is missing or malformed (3.12): such a source has no place in time, so it is never admitted
 *  (mapping it to 0 sorted it before everything and put it inside every span). */
export const occurredAtOf = (payload: { occurredAt?: unknown }): number | null =>
  Number.isSafeInteger(payload.occurredAt) && Number(payload.occurredAt) >= 0 ? Number(payload.occurredAt) : null;
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

const sourceTombstoned = (db: DatabaseSync, id: string, revision: number) =>
  Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, revision));

type SourceRow = Record<string, unknown>;
const posOf = (r: SourceRow): { pos?: number } => r.pos === undefined || r.pos === null ? {} : { pos: Number(r.pos) };
/** I-1 for one row of `rows(…, "text")`: the admitted source, or null. */
function ownerRow(db: DatabaseSync, q: SpanQuery, r: SourceRow): AdmittedSource | null {
  if (r.speaker !== "owner") return null;
  let payload: { text?: unknown; occurredAt?: unknown };
  try { payload = JSON.parse(String(r.payload)); } catch { return null; }
  if (typeof payload.text !== "string") return null;
  const at = occurredAtOf(payload);
  if (at === null) return null;
  if (!after(at, r.message_id === null ? null : String(r.message_id), q)) return null;
  if (!isLearnableSource(db, String(r.id), Number(r.revision)).learnable) return null;
  return { kind: "owner", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: payload.text, occurredAt: at, ...posOf(r) };
}
/** I-2 for one row of `rows(…, "tool-outcome")`: the admitted source, or null. */
function actionRow(db: DatabaseSync, q: SpanQuery, r: SourceRow): AdmittedSource | null {
  if (r.speaker !== "tool" || r.outcome !== "completed") return null;
  if (sourceTombstoned(db, String(r.id), Number(r.revision))) return null;
  let payload: { occurredAt?: unknown; action?: { label?: unknown } };
  try { payload = JSON.parse(String(r.payload)); } catch { return null; }
  const label = payload.action?.label;
  if (typeof label !== "string" || !label) return null;
  const at = occurredAtOf(payload);
  if (at === null) return null;
  if (!after(at, r.message_id === null ? null : String(r.message_id), q)) return null;
  return { kind: "action", sourceId: String(r.id), revision: Number(r.revision), messageId: r.message_id === null ? null : String(r.message_id), threadId: q.threadId, text: label, occurredAt: at, ...posOf(r) };
}
const finish = (out: AdmittedSource[], q: SpanQuery): AdmittedSource[] => {
  out.sort(compareAdmitted);
  return q.limit ? out.slice(0, q.limit) : out;
};

/** Every page of threadSourcePager, read in this turn of the loop: no statement reads more than one page, but the caller holds the loop for
 *  the whole thread. Only for reads that must be one consistent read (inside a transaction) or that have no loop to hand back; a caller that
 *  can await uses the Sliced forms. */
export function eachPageNow(db: DatabaseSync, threadId: string, kind: "text" | "tool-outcome", visit: (row: SourceRow) => void): void {
  const next = threadSourcePager(db, threadId, kind, "asc", THREAD_SOURCE_PAGE_ROWS);
  for (let page = next(); page; page = page.more ? next() : null) for (const r of page.rows) visit(r);
}

/** I-1. speaker owner, kind text, learnable (attended or verified-owner channel origin), this bot's own thread. */
export function admissibleOwnerSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  const out: AdmittedSource[] = [];
  eachPageNow(db, q.threadId, "text", r => { const admitted = ownerRow(db, q, r); if (admitted) out.push(admitted); });
  return finish(out, q);
}

/** I-2. A completed tool outcome from this bot's own thread; the grounding bytes are the action label. */
export function admissibleActionSources(db: DatabaseSync, botId: string, q: SpanQuery): AdmittedSource[] {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return [];
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return [];
  const out: AdmittedSource[] = [];
  eachPageNow(db, q.threadId, "tool-outcome", r => { const admitted = actionRow(db, q, r); if (admitted) out.push(admitted); });
  return finish(out, q);
}

/** Thread sources one page of a sliced walk reads. */
export const THREAD_SOURCE_PAGE_ROWS = 64;
/** The two statements of one forEachThreadSourcePage page (r3 2.6: every page row is filtered by the deny facts of its own stored place,
 *  `s.thread_id` and `s.scope_id`, two primary-key seeks on memory_deny, so a deleted conversation's sources are never read as active while the
 *  revocation runner has not flipped them yet): `keys` (?1 thread, ?2 the last message id read or null on the first page, ?3 rows,
 *  ?4 the walk's far bound) reads only the thread index; `page` (?1 thread, ?2 the same, ?3 the page's last message id, ?4 kind) reads that range's rows. Both run in
 *  index order: neither sorts (pip-run-sliced.test.ts checks the plans). */
export function threadSourcePageSql(order: "asc" | "desc", first: boolean): { keys: string; page: string } {
  const dir = order === "asc" ? "ASC" : "DESC", past = order === "asc" ? ">" : "<", upTo = order === "asc" ? "<=" : ">=";
  const from = (column: string) => first ? `${column} IS NOT NULL AND ?2 IS NULL` : `${column}${past}?2`;
  return {
    keys: `SELECT message_id AS k FROM memory_sources WHERE thread_id=?1 AND ${from("message_id")} AND message_id${upTo}?4 ORDER BY message_id ${dir} LIMIT ?3`,
    page: `SELECT s.rowid AS pos,s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id=?1 AND ${from("s.message_id")} AND s.message_id${upTo}?3 AND s.kind=?4 AND s.state='active' AND NOT ${DENIED_PLACE("s")} ORDER BY s.message_id ${dir}`,
  };
}
/** The thread's sources in pages, in the order of the thread index `memory_sources_thread` (thread_id, message_id): each page is the next
 *  THREAD_SOURCE_PAGE_ROWS message ids of the thread after the last one read, found in the index alone, then the rows of that message id range
 *  (the last message id's rows whole) and their payloads, read in index order; `between()` is awaited after each page. No statement sorts and none
 *  reads more than one page of rows (with the rest of its last message id's rows) from the tables, however long the thread (rc13 real-data run, server3.log:27-31: ten whole-thread reads of the
 *  reflection run's candidate scan, about 103 ms each, held the loop 2292 ms in one turn). The cursor is a message id, never a rowid: a VACUUM
 *  between two pages (which may renumber rowids) neither skips nor repeats a row. Pages walk message ids, not capture order; a caller that needs
 *  capture order compares `pos` (rowid) values read in one page (newestThreadSource, hasAdmissibleAfterSliced). Rows without a message id are
 *  not walked: text and tool-outcome sources are captured only by captureMessage, keyed by their message id, so they always carry one.
 *  `order` "desc" walks message ids from the greatest. The walk's far end is the thread's greatest (least, for "desc") message id when it
 *  starts, read from the index: every row there at the start is walked, and rows that arrive after it with message ids past that bound are not,
 *  so a thread that keeps growing never keeps the walk going (nor starves the threads after it). `signal` ends the walk at the next page: an
 *  aborted walk returns without visiting more, and its caller discards the partial answer. */
export async function forEachThreadSourcePage(db: DatabaseSync, threadId: string, kind: "text" | "tool-outcome", between: () => Promise<void>,
  visit: (rows: SourceRow[]) => boolean | void, order: "asc" | "desc" = "asc", pageRows = THREAD_SOURCE_PAGE_ROWS, signal?: AbortSignal, check?: StampCheck): Promise<WalkAnswer> {
  if (signal?.aborted) return "aborted";
  const next = threadSourcePager(db, threadId, kind, order, pageRows);
  for (;;) {
    const page = next();
    if (!page) return "none";
    if (visit(page.rows) === true || !page.more) return "none";
    if (signal?.aborted) return "aborted";
    await between();
    if (signal?.aborted) return "aborted";
    // r3 2.3: the admission stamp after every hand-back; a read that moved is dead, so the walk ends here rather than reading on
    const answer = check?.();
    if (answer && answer !== "none") return answer;
  }
}
/** How a walk ended: "none" read to its end (or its visitor stopped it), "moved" / "off" the stamp check ended it, "aborted" the signal. */
export type WalkAnswer = StampAnswer | "aborted";
/** The pages of forEachThreadSourcePage, one per call: null when the walk is done, else the page's rows and whether more may follow. The far
 *  bound is read on the first call. Each page is one named step (`memory.pip.threads`), so a slow one is never unattributed on a stall line. */
export function threadSourcePager(db: DatabaseSync, threadId: string, kind: "text" | "tool-outcome", order: "asc" | "desc", pageRows: number): () => { rows: SourceRow[]; more: boolean } | null {
  const firstKeys = db.prepare(threadSourcePageSql(order, true).keys), nextKeys = db.prepare(threadSourcePageSql(order, false).keys);
  const firstPage = db.prepare(threadSourcePageSql(order, true).page), nextPage = db.prepare(threadSourcePageSql(order, false).page);
  let far: unknown, from: string | null = null, done = false, started = false;
  return () => {
    if (done) return null;
    return heldStep("memory.pip.threads", () => {
      if (!started) {
        started = true;
        far = db.prepare(`SELECT ${order === "asc" ? "max" : "min"}(message_id) AS k FROM memory_sources WHERE thread_id=?`).get(threadId)?.k;
        if (far === null || far === undefined) { done = true; return null; }
      }
      const found = (from === null ? firstKeys : nextKeys).all(threadId, from, pageRows, far as string).map(row => String(row.k));
      const last = found[found.length - 1];
      if (last === undefined) { done = true; return null; }
      const rows = (from === null ? firstPage : nextPage).all(threadId, from, last, kind) as SourceRow[];
      if (found.length < pageRows) done = true; else from = last;
      return { rows, more: !done };
    });
  };
}
/** A source's rowid now, or -Infinity when it is gone: a capture-order comparison across pages reads both sides in the same page step. */
const rowidNow = (db: DatabaseSync) => {
  const statement = db.prepare("SELECT rowid AS pos FROM memory_sources WHERE id=?");
  return (id: string | undefined) => id === undefined ? -Infinity : Number(statement.get(id)?.pos ?? -Infinity);
};
/** The thread's newest active source of `kind` by capture order: the row `... ORDER BY s.rowid DESC LIMIT 1` reads (the greatest rowid), found by
 *  forEachThreadSourcePage with no sort. The best row so far is kept by id and its rowid read again with each page, so a VACUUM between pages
 *  never compares two numberings. */
export async function newestThreadSource(db: DatabaseSync, threadId: string, kind: "text" | "tool-outcome", between: () => Promise<void>, signal?: AbortSignal): Promise<SourceRow | undefined> {
  const posOf = rowidNow(db);
  let newest: SourceRow | undefined;
  await forEachThreadSourcePage(db, threadId, kind, between, page => {
    let best = posOf(newest === undefined ? undefined : String(newest.id));
    for (const r of page) if (Number(r.pos) > best) { newest = r; best = Number(r.pos); }
  }, "desc", THREAD_SOURCE_PAGE_ROWS, signal);
  return newest;
}
/** The admitted sources of one kind of the span `q`, visited one at a time as the pages are read (no list is built): the thread's own
 *  checks first (bot's own, owner audience for actions, r3 2.6 the thread-level deny as a fast exit), then each page row. */
async function visitAdmittedSliced(db: DatabaseSync, botId: string, q: SpanQuery, kind: "owner" | "action", between: () => Promise<void>, signal: AbortSignal | undefined,
  check: StampCheck | undefined, visit: (source: AdmittedSource) => void): Promise<WalkAnswer> {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return "none";
  if (kind === "action" && !turnAudienceIsOwner(q.threadId, {}, db)) return "none";
  if (threadDenied(db, q.threadId)) return "none";
  const admit = kind === "owner" ? ownerRow : actionRow;
  return forEachThreadSourcePage(db, q.threadId, kind === "owner" ? "text" : "tool-outcome", between, page => { for (const r of page) { const admitted = admit(db, q, r); if (admitted) visit(admitted); } }, "asc", THREAD_SOURCE_PAGE_ROWS, signal, check);
}
/** visitAdmittedSliced for owner turns (I-1): the trace day read and the snapshot keep only what they need of each, never the whole list. */
export const visitAdmittedOwnerSourcesSliced = (db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal: AbortSignal | undefined, check: StampCheck | undefined, visit: (source: AdmittedSource) => void) =>
  visitAdmittedSliced(db, botId, q, "owner", between, signal, check, visit);
/** visitAdmittedSliced for completed actions (I-2). */
export const visitAdmittedActionSourcesSliced = (db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal: AbortSignal | undefined, check: StampCheck | undefined, visit: (source: AdmittedSource) => void) =>
  visitAdmittedSliced(db, botId, q, "action", between, signal, check, visit);
async function admissibleSliced(db: DatabaseSync, botId: string, q: SpanQuery, kind: "owner" | "action", between: () => Promise<void>, signal?: AbortSignal, check?: StampCheck): Promise<AdmittedSource[] | undefined> {
  const out: AdmittedSource[] = [];
  const answer = await visitAdmittedSliced(db, botId, q, kind, between, signal, check, admitted => { out.push(admitted); });
  if (answer === "moved" || answer === "off") return undefined;
  // the sort of a long thread's list is work of its own: it starts a slice when the walk spent one
  if (!signal?.aborted) await between();
  return finish(out, q);
}
/** admissibleOwnerSources, the same list, read by forEachThreadSourcePage. With `check` (the admission stamp), undefined when the read moved. */
export function admissibleOwnerSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal): Promise<AdmittedSource[]>;
export function admissibleOwnerSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal: AbortSignal | undefined, check: StampCheck): Promise<AdmittedSource[] | undefined>;
export function admissibleOwnerSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal, check?: StampCheck): Promise<AdmittedSource[] | undefined> {
  return admissibleSliced(db, botId, q, "owner", between, signal, check);
}
/** admissibleActionSources, the same list, read by forEachThreadSourcePage. With `check`, undefined when the read moved. */
export function admissibleActionSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal): Promise<AdmittedSource[]>;
export function admissibleActionSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal: AbortSignal | undefined, check: StampCheck): Promise<AdmittedSource[] | undefined>;
export function admissibleActionSourcesSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal, check?: StampCheck): Promise<AdmittedSource[] | undefined> {
  return admissibleSliced(db, botId, q, "action", between, signal, check);
}

/** The pending check only: true when some source is admissible after the cursor of `q`. It reads the thread's sources newest first (capture order) and stops
 * at the first admissible one, or at the first one at or before the cursor, so it reads the rows after the cursor and one more, never the whole thread.
 * `onPayload` is a test seam counting the payloads read. The run itself keeps the full lists. */
/** Rows one page of the sliced pending check reads before it may hand the event loop back. */
export const ADMISSIBLE_PAGE_ROWS = 64;
/** hasAdmissibleAfter, the same answer, read in pages of ADMISSIBLE_PAGE_ROWS (forEachThreadSourcePage) with `between()` awaited after each page (it hands the
 *  event loop back when the caller's slice is spent): a thread with a long history and no cursor yet (never reflected) walks every owner turn,
 *  which on a large store held the serving thread for hundreds of milliseconds (rc13 real-data boot, `memory.pip.pending:261ms`). */
export function hasAdmissibleAfterSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal): Promise<boolean>;
export function hasAdmissibleAfterSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal: AbortSignal | undefined, check: StampCheck): Promise<boolean | undefined>;
export async function hasAdmissibleAfterSliced(db: DatabaseSync, botId: string, q: SpanQuery, between: () => Promise<void>, signal?: AbortSignal, check?: StampCheck): Promise<boolean | undefined> {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return false;
  if (threadDenied(db, q.threadId)) return false;
  let moved = false;
  const beforeCursor = (at: number, id: string | null) => q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")));
  // The one-statement check walks newest first (rowid DESC) and answers at the first row that is either at or before the cursor (false) or
  // admissible (true): true exactly when the newest admissible row is newer than the newest row at or before the cursor. Pages come in message id
  // order (forEachThreadSourcePage, no sort), so both newest rows are kept by id and compared by rowids read in the same page step (a VACUUM
  // between pages never compares two numberings). A row no newer than both cannot change the answer, so only newer rows are parsed and admitted.
  const walk = async (kind: "text" | "tool-outcome", where: (r: SourceRow) => boolean, admit: (r: SourceRow, payload: Record<string, unknown>, at: number) => boolean): Promise<boolean> => {
    const posOf = rowidNow(db);
    let admitted: string | undefined, before: string | undefined;
    const answer = await forEachThreadSourcePage(db, q.threadId, kind, between, page => {
      let floor = Math.max(posOf(admitted), posOf(before));
      for (const r of page) {
        if (!where(r) || Number(r.pos) <= floor) continue;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { continue; }
        const at = occurredAtOf(payload);
        if (at === null) continue;
        const messageId = r.message_id === null ? null : String(r.message_id);
        if (beforeCursor(at, messageId)) { before = String(r.id); floor = Number(r.pos); continue; }
        if (q.untilAt !== undefined && at > q.untilAt) continue;
        if (admit(r, payload, at)) { admitted = String(r.id); floor = Number(r.pos); }
      }
    }, "desc", ADMISSIBLE_PAGE_ROWS, signal, check);
    if (answer === "moved" || answer === "off") { moved = true; return false; }
    return admitted !== undefined && posOf(admitted) > posOf(before);
  };
  if (await walk("text", r => r.speaker === "owner", (r, payload) => typeof payload.text === "string" && isLearnableSource(db, String(r.id), Number(r.revision)).learnable)) return true;
  if (moved) return undefined;
  if (!turnAudienceIsOwner(q.threadId, {}, db)) return false;
  const actions = await walk("tool-outcome", r => r.speaker === "tool" && r.outcome === "completed", (r, payload) => {
    const label = (payload.action as { label?: unknown } | undefined)?.label;
    return typeof label === "string" && label.length > 0 && !sourceTombstoned(db, String(r.id), Number(r.revision));
  });
  return moved ? undefined : actions;
}
export function hasAdmissibleAfter(db: DatabaseSync, botId: string, q: SpanQuery, onPayload?: () => void): boolean {
  if (!threadIsBotsOwn(botId, q.threadId, q.excludedThreads)) return false;
  const beforeCursor = (at: number, id: string | null) => q.afterAt !== undefined && (at < q.afterAt || (at === q.afterAt && (id ?? "") <= (q.afterMessageId ?? "")));
  const walk = (kind: "text" | "tool-outcome", where: string, admit: (r: Record<string, unknown>, payload: Record<string, unknown>, at: number) => boolean): boolean => {
    const statement = db.prepare(`SELECT s.id,s.revision,s.message_id,s.speaker,s.outcome,v.payload FROM memory_sources s
      JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
      WHERE s.thread_id=? AND s.kind=? AND s.state='active' AND NOT ${DENIED_PLACE("s")} AND ${where} ORDER BY s.rowid DESC`);
    for (const r of statement.iterate(q.threadId, kind) as Iterable<Record<string, unknown>>) {
      let payload: Record<string, unknown>;
      onPayload?.();
      try { payload = JSON.parse(String(r.payload)) as Record<string, unknown>; } catch { continue; }
      const at = occurredAtOf(payload);
      if (at === null) continue;
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
  // r3 2.6: a deny already in force on the source's own stored place (its thread, or the scope it was captured into), before the
  // revocation runner flips its state
  if (db.prepare(`SELECT 1 FROM memory_sources s WHERE s.id=? AND ${DENIED_PLACE("s")}`).get(sourceId)) return false;
  return isLearnableSource(db, sourceId, revision).learnable;
}
/** A commitment or self-trait the request shows the model as `current` passes the admission its sources do (Astra pip-build H1): active
 *  at `version`, not tombstoned, its scope not denied, and every evidence handle of that version still an admissible owner source
 *  (ownerSourceStillAdmissible: active at the cited revision, the bot's own thread, no deny on its stored place, learnable). A row with
 *  no evidence (an owner-written fact) rests on the owner's own bytes and needs only the first three. A handful of seeks per row. */
export function livedRowAdmissible(db: DatabaseSync, botId: string, id: string, version: number, excluded: readonly string[] = []): boolean {
  const row = db.prepare(`SELECT 1 FROM memory_records r WHERE r.id=? AND r.version=? AND r.state='active' AND NOT ${DENIED_RECORD_SCOPE("r")}`).get(id, version);
  return Boolean(row) && !recordTombstoned(db, id, version) && livedRowEvidenceAdmissible(db, botId, id, version, excluded);
}
const recordTombstoned = (db: DatabaseSync, id: string, version: number) =>
  Boolean(db.prepare("SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=? AND (t.revision IS NULL OR t.revision=?)").get(id, version));
/** Every evidence handle of record version `version` is still an admissible owner source (none for an owner-written fact). */
export function livedRowEvidenceAdmissible(db: DatabaseSync, botId: string, id: string, version: number, excluded: readonly string[] = []): boolean {
  for (const e of db.prepare("SELECT source_id,source_revision FROM memory_evidence WHERE record_id=? AND record_version=?").all(id, version))
    if (!ownerSourceStillAdmissible(db, botId, String(e.source_id), Number(e.source_revision), excluded)) return false;
  return true;
}
/** A `current` row the request showed at `version` is still what it showed, at publication (Astra pip-build H2, r2): some version of
 *  it is active in a scope not denied, the shown version is not tombstoned, and the shown version's evidence is still admissible. An
 *  owner edit since (a newer active version) is the "only targets changed" row and publishes partially, but never past evidence the
 *  shown words rested on that has since been retired, denied or excluded (r2: the newer-version shortcut). */
export function livedRowStillShown(db: DatabaseSync, botId: string, id: string, version: number, excluded: readonly string[] = []): boolean {
  const live = db.prepare(`SELECT MAX(r.version) AS v FROM memory_records r WHERE r.id=? AND r.state='active' AND NOT ${DENIED_RECORD_SCOPE("r")}`).get(id);
  if (live?.v === null || live?.v === undefined) return false;
  return !recordTombstoned(db, id, version) && livedRowEvidenceAdmissible(db, botId, id, version, excluded);
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

// ------------------------------------------------------- admission stamp ----
// PIP-REDESIGN r3 section 2. One value that moves whenever any input of admission moves, read in a handful of index seeks: taken before a
// read begins, compared after every page, after the read, inside each adapter immediately before the request leaves or the process starts,
// and inside every writing transaction. A read whose stamp moved is discarded whole; no list is ever re-validated element by element.

/** Two counters kept by triggers on the input tables themselves (2.1), so a writer added later moves them without knowing PIP exists:
 *  `global` for policy, deletion, mode, tombstones (every target type), the bindings admission reads, the learning settings and denies;
 *  one epoch per thread for its sources, their versions and payloads, and capture-job completion. Every UPDATE trigger carries an `IS NOT`
 *  guard, so a write that changes nothing moves nothing; a source with no thread (an import) moves no thread and aborts nothing.
 *  Temp objects of the shared connection, the way the lineage cache (replay-lineage.ts) and the procedure suggestions (procedure-landing.ts)
 *  keep their epochs: the file's schema is untouched (no version step, nothing for validation, restore or a downgrade to know), and a commit
 *  by any other connection moves the stamp too (`data_version`), so nothing written elsewhere is missed. */
const THREAD_BUMP = (thread: string) => `INSERT INTO memory_thread_admission(thread_id,epoch) SELECT ${thread},1 WHERE ${thread} IS NOT NULL ON CONFLICT(thread_id) DO UPDATE SET epoch=epoch+1;`;
const SOURCE_THREAD_BUMP = (sourceId: string) => `INSERT INTO memory_thread_admission(thread_id,epoch) SELECT s.thread_id,1 FROM memory_sources s WHERE s.id=${sourceId} AND s.thread_id IS NOT NULL ON CONFLICT(thread_id) DO UPDATE SET epoch=epoch+1;`;
const GLOBAL_BUMP = "UPDATE memory_admission_epoch SET global=global+1 WHERE id=1;";
const ADMISSION_BINDING = (row: "NEW" | "OLD") => `((${row}.subject_type='system' AND ${row}.subject_id='owner-settings') OR ${row}.subject_type IN ('source-origin','human-binding','human-thread','bot','room'))`;
const SOURCE_COLUMNS = ["state", "revision", "speaker", "outcome", "kind", "thread_id", "scope_id"] as const;
const changed = (columns: readonly string[]) => columns.map(c => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");
export const ADMISSION_EPOCH_SQL = `
CREATE TEMP TABLE IF NOT EXISTS memory_admission_epoch (id INTEGER PRIMARY KEY CHECK(id=1), global INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO temp.memory_admission_epoch VALUES(1,0);
CREATE TEMP TABLE IF NOT EXISTS memory_thread_admission (thread_id TEXT PRIMARY KEY NOT NULL, epoch INTEGER NOT NULL) WITHOUT ROWID;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_source_insert AFTER INSERT ON main.memory_sources WHEN NEW.thread_id IS NOT NULL BEGIN ${THREAD_BUMP("NEW.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_source_update AFTER UPDATE OF ${SOURCE_COLUMNS.join(",")} ON main.memory_sources WHEN NEW.thread_id IS OLD.thread_id AND OLD.thread_id IS NOT NULL AND (${changed(SOURCE_COLUMNS)})
 BEGIN ${THREAD_BUMP("OLD.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_source_move AFTER UPDATE OF thread_id ON main.memory_sources WHEN NEW.thread_id IS NOT OLD.thread_id
 BEGIN ${THREAD_BUMP("OLD.thread_id")} ${THREAD_BUMP("NEW.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_source_delete AFTER DELETE ON main.memory_sources WHEN OLD.thread_id IS NOT NULL BEGIN ${THREAD_BUMP("OLD.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_version_insert AFTER INSERT ON main.memory_source_versions BEGIN ${SOURCE_THREAD_BUMP("NEW.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_version_payload AFTER UPDATE OF payload ON main.memory_source_versions WHEN NEW.payload IS NOT OLD.payload BEGIN ${SOURCE_THREAD_BUMP("NEW.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_version_delete AFTER DELETE ON main.memory_source_versions BEGIN ${SOURCE_THREAD_BUMP("OLD.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_job_complete AFTER UPDATE OF status ON main.memory_jobs WHEN NEW.stage='capture' AND (NEW.status='complete') IS NOT (OLD.status='complete') BEGIN ${SOURCE_THREAD_BUMP("NEW.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_job_insert AFTER INSERT ON main.memory_jobs WHEN NEW.stage='capture' AND NEW.status='complete' BEGIN ${SOURCE_THREAD_BUMP("NEW.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_job_delete AFTER DELETE ON main.memory_jobs WHEN OLD.stage='capture' AND OLD.status='complete' BEGIN ${SOURCE_THREAD_BUMP("OLD.source_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_meta AFTER UPDATE OF policy_revision,deletion_epoch,mode ON main.memory_meta WHEN ${changed(["policy_revision", "deletion_epoch", "mode"])} BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_tombstone AFTER INSERT ON main.memory_tombstones BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_tombstone_update AFTER UPDATE ON main.memory_tombstones WHEN ${changed(["target_type", "target_id", "revision"])} BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_tombstone_delete AFTER DELETE ON main.memory_tombstones BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_binding AFTER INSERT ON main.memory_scope_bindings WHEN ${ADMISSION_BINDING("NEW")} BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_binding_update AFTER UPDATE ON main.memory_scope_bindings WHEN (${ADMISSION_BINDING("NEW")} OR ${ADMISSION_BINDING("OLD")})
 AND (${changed(["id", "scope_id", "subject_type", "subject_id", "revision", "state", "intent"])}) BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_binding_delete AFTER DELETE ON main.memory_scope_bindings WHEN ${ADMISSION_BINDING("OLD")} BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_learning AFTER UPDATE ON main.memory_learning_config WHEN ${changed(["revision", "settings"])} BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_learning_insert AFTER INSERT ON main.memory_learning_config BEGIN ${GLOBAL_BUMP} END;
`;
/** memory_deny is a late object (schema.ts REVOKE_LATE_SQL): its triggers are made only where the table is. */
export const ADMISSION_DENY_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_deny AFTER INSERT ON main.memory_deny BEGIN ${GLOBAL_BUMP} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_adm_deny_delete AFTER DELETE ON main.memory_deny BEGIN ${GLOBAL_BUMP} END;
`;
export const ADMISSION_TRIGGERS = [...ADMISSION_EPOCH_SQL.matchAll(/TRIGGER IF NOT EXISTS (\w+)/g), ...ADMISSION_DENY_SQL.matchAll(/TRIGGER IF NOT EXISTS (\w+)/g)].map(m => m[1]);
const epochsReady = new WeakMap<DatabaseSync, boolean>();
/** A "not now" refusal (the background budget's BG_DEFERRED, a lock wait that ran out) is never kept as the answer (sweep-1021 B2): the install is tried
 *  again on a later look, no sooner than this floor, doubling to the ceiling. Any other error keeps the fail-closed answer for the connection. */
const epochsRetry = new WeakMap<DatabaseSync, { at: number; delayMs: number }>();
export const ADMISSION_EPOCH_RETRY_FLOOR_MS = 250, ADMISSION_EPOCH_RETRY_CEILING_MS = 60_000;
let epochsWarned = false;
/** Makes the counters and their triggers on this connection (once; outside a transaction, so a rollback never takes them away unseen).
 *  False when they are not there: every stamp then compares as moved (fail closed). */
export function ensureAdmissionEpochs(db: DatabaseSync): boolean {
  const known = epochsReady.get(db);
  if (known !== undefined) return known && present(db);
  if (db.isTransaction) return false;
  const retry = epochsRetry.get(db);
  if (retry && retry.at > Date.now()) return false;
  let ready = false;
  try {
    // Temp objects write no page of the main file: the install is no background source's write, whichever source the first reflection read runs in.
    ioBudget.withSource("pip-epoch", () => {
      db.exec(ADMISSION_EPOCH_SQL);
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny'").get()) db.exec(ADMISSION_DENY_SQL);
    });
    ready = true;
    epochsRetry.delete(db);
  } catch (error) {
    if (!epochsWarned) { epochsWarned = true; console.warn(`[memory] pip admission epochs could not be installed; reflection reads compare as moved (${error instanceof Error ? error.message : String(error)})`); }
    if (isDatabaseBusy(error)) {
      const delayMs = Math.min(ADMISSION_EPOCH_RETRY_CEILING_MS, Math.max(ADMISSION_EPOCH_RETRY_FLOOR_MS, (retry?.delayMs ?? 0) * 2));
      epochsRetry.set(db, { at: Date.now() + delayMs, delayMs });
      return false;
    }
  }
  epochsReady.set(db, ready);
  return ready;
}
/** The temp table is still there (a downgrade or a test may drop main tables, which takes their triggers, never the counters). */
const present = (db: DatabaseSync) => { try { return Boolean(db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name='memory_admission_epoch'").get()); } catch { return false; } };

export type StampAnswer = "none" | "moved" | "off";
export type StampCheck = () => StampAnswer;
/** The roster fields of a bot the stamp digests (pip-reflect.ts ReflectBot). */
export interface StampBot { id: string; threadIds: readonly string[]; continuity: boolean; options?: { reflect?: boolean }; settingsGeneration?: number }
export interface StampDeps { bots(): StampBot[]; memoryMode(): string }
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** The in-process settings a reflection depends on: continuity, its options, the bot's threads and the continuity generation. */
export const settingsGen = (bot: StampBot) => digest([bot.continuity, bot.options, bot.threadIds, bot.settingsGeneration]);

export interface AdmissionStamp {
  conn: string; installed: boolean; version: number;
  /** memory_admission_epoch.global */
  global: number;
  /** memory_thread_admission.epoch per thread read or covered (0 when no row): a covered thread (the bot's other threads, where the
   *  evidence of the `current` rows the request shows may rest) moves the stamp like a read one but carries no own/excluded "off" rule */
  threads: Record<string, number>;
  mode: string;
  /** settingsGen of the bot as the roster has it */
  settings: string;
  /** digest of the reflect binding's excludedThreads (and, inside a run, the run's identity) */
  reflect: string;
  /** threads PIP-excluded when the stamp was taken */
  excluded: string[];
  /** per thread: audienceFingerprint and whether the thread is the bot's own direct conversation */
  audience: Record<string, string>;
  own: Record<string, boolean>;
  run?: { runId: string; family: string; attempt: number };
  needsReflect: boolean;
}
interface ReflectBits { excluded: string[]; run?: { runId?: string; families?: Record<string, { attempt?: number }> } }
function reflectBits(db: DatabaseSync, botId: string): ReflectBits {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get("pip-reflect:" + botId);
  if (!row) return { excluded: [] };
  try { const state = JSON.parse(String(row.intent)) as { excludedThreads?: unknown; run?: ReflectBits["run"] }; return { excluded: Array.isArray(state.excludedThreads) ? state.excludedThreads.map(String) : [], run: state.run }; }
  catch { return { excluded: [] }; }
}
const reflectDigest = (bits: ReflectBits, run?: AdmissionStamp["run"]) =>
  digest([[...bits.excluded].sort(), run ? [bits.run?.runId === run.runId, bits.run?.families?.[run.family]?.attempt === run.attempt] : null]);
const audienceOf = (botId: string, threadId: string) => `${audienceFingerprint(threadId)}|${threadIsBotsOwn(botId, threadId)}`;
// data_version by the PRAGMA statement on this connection only (the table-valued form can be shadowed by a table or view of that name),
// read after the global counter, so stampMoved still samples it last
const counters = (db: DatabaseSync) => {
  const g = db.prepare("SELECT global FROM temp.memory_admission_epoch WHERE id=1").get()?.global;
  return { g, v: db.prepare("PRAGMA data_version").get()?.data_version };
};
function threadEpochs(db: DatabaseSync, threadIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(threadIds.map(t => [t, 0]));
  for (const row of db.prepare("SELECT thread_id,epoch FROM temp.memory_thread_admission WHERE thread_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(threadIds))) out[String(row.thread_id)] = Number(row.epoch);
  return out;
}

/** The stamp of `threadIds` for bot `botId`, taken before a read begins. `run` ties it to one attempt of a run; `reflect` requires the
 *  bot's reflect option as well as Continuity (the run's reads; the trace needs Continuity only). `covered` names further threads whose
 *  epochs the stamp compares (moved) without the read threads' "off" rules. Outside a transaction. */
export function admissionStamp(db: DatabaseSync, deps: StampDeps, botId: string, threadIds: readonly string[], options: { run?: AdmissionStamp["run"]; reflect?: boolean; covered?: readonly string[] } = {}): AdmissionStamp {
  const installed = ensureAdmissionEpochs(db);
  const bot = deps.bots().find(b => b.id === botId);
  const bits = reflectBits(db, botId);
  const c = installed ? counters(db) : undefined;
  const epochThreads = [...new Set([...threadIds, ...(options.covered ?? [])])];
  return {
    conn: connectionId(db), installed, version: Number(c?.v ?? 0), global: Number(c?.g ?? 0), threads: installed ? threadEpochs(db, epochThreads) : {},
    mode: deps.memoryMode(), settings: bot ? settingsGen(bot) : "", reflect: reflectDigest(bits, options.run), excluded: threadIds.filter(t => bits.excluded.includes(t)),
    audience: Object.fromEntries(threadIds.map(t => [t, audienceOf(botId, t)])), own: Object.fromEntries(threadIds.map(t => [t, threadIsBotsOwn(botId, t)])),
    ...(options.run ? { run: options.run } : {}), needsReflect: options.reflect === true,
  };
}
/** The steps of stampMoved, in order; the test seam below is called after each so a probe can commit on another connection at every
 *  interleaving point and require "moved". */
export const STAMP_STEPS = ["bot", "bindings", "own", "present", "epochs", "settings", "audience"] as const;
export type StampStep = typeof STAMP_STEPS[number];
/** Test seam: called after each step of stampMoved, before the final counter sample. */
export const pipFenceHooks: { step?: (step: StampStep) => void } = {};
/** Three answers (2.2): "off" when the bot's Continuity (or, for a run, its reflect option) is off, memory is not capturing, a read thread
 *  became PIP-excluded or is no longer the bot's own; "moved" when anything else the stamp covers differs; "none" when nothing moved.
 *  Synchronous and a handful of seeks: it is also the adapter fence. Inside a transaction it reads that transaction's view.
 *  Sound against other connections: `data_version` is sampled as the very last statement, after every other read here, so a commit by
 *  another connection at any point between the stamp and that sample (including during the checks above it) answers "moved"; the
 *  counters this connection's own triggers keep cannot move while a synchronous function runs. The adapters call this after their last
 *  await and immediately before dispatch, so nothing can commit between the sample and the send. */
/** `held` (1.0.22 mem-strict): the caller sends only through a learning gate that holds every row the request shows (learning-send.ts
 *  HeldRefs) and re-checks those rows, and any withdrawal, whenever anything moved. Then the global counter and data_version (an unrelated
 *  tombstone, deny, Forget or another connection's commit) are that gate's to judge, never a refusal here; every bot, thread, mode,
 *  settings, exclusion and audience check above still applies. */
export function stampMoved(db: DatabaseSync, deps: StampDeps, botId: string, stamp: AdmissionStamp, options: { held?: boolean } = {}): StampAnswer {
  const step = pipFenceHooks.step;
  const bot = deps.bots().find(b => b.id === botId);
  if (!bot?.continuity || (stamp.needsReflect && !bot.options?.reflect)) return "off";
  const mode = deps.memoryMode();
  if (!["capture", "active"].includes(mode)) return "off";
  step?.("bot");
  const bits = reflectBits(db, botId), threads = Object.keys(stamp.own);
  step?.("bindings");
  for (const t of threads) {
    if (!stamp.excluded.includes(t) && bits.excluded.includes(t)) return "off";
    if (stamp.own[t] && !threadIsBotsOwn(botId, t)) return "off";
  }
  step?.("own");
  if (!stamp.installed || connectionId(db) !== stamp.conn || !present(db)) return "moved";
  step?.("present");
  const epochThreads = Object.keys(stamp.threads), now = threadEpochs(db, epochThreads);
  for (const t of epochThreads) if (now[t] !== stamp.threads[t]) return "moved";
  step?.("epochs");
  if (mode !== stamp.mode || settingsGen(bot) !== stamp.settings || reflectDigest(bits, stamp.run) !== stamp.reflect) return "moved";
  step?.("settings");
  for (const t of threads) if (audienceOf(botId, t) !== stamp.audience[t]) return "moved";
  step?.("audience");
  // last, after every read above: a commit elsewhere since the stamp, whenever it landed, shows here
  if (options.held) return "none";
  const c = counters(db);
  if (Number(c?.v ?? 0) !== stamp.version || Number(c?.g ?? 0) !== stamp.global) return "moved";
  return "none";
}
/** The stamp vector alone (pending memo key, 2.3): the global counter, data_version and every thread's epoch. */
export function admissionVector(db: DatabaseSync, threadIds: readonly string[]): string | null {
  if (!ensureAdmissionEpochs(db)) return null;
  const c = counters(db);
  const epochs = threadEpochs(db, threadIds);
  return JSON.stringify([connectionId(db), Number(c?.v ?? 0), Number(c?.g ?? 0), threadIds.map(t => epochs[t])]);
}

// ------------------------------------------------- pending change feed ----
// What the reflection pending check (pip-reflect.ts anyThreadPendingSliced) remembers per thread is kept true by this feed: the threads
// whose answer a write may have changed since the last call, and one generation that moves when a write may have changed every thread's.
// The check then reads only the threads named here, never every thread of every Continuity bot again (1.0.21 owner copy, 9.5 h idle:
// about 1,000 source pages a minute, the whole history once a minute and once more after every memory write anywhere).
//  - A thread is named when its admission epoch moves (its sources, their versions and payloads, capture-job completion: the triggers
//    above), when a tombstone names one of its sources, or when the origin binding of one of its sources changes. The pending check reads
//    tombstones and origin bindings by source id only, so those two never concern another thread.
//  - The generation moves with what the check reads for every thread alike: memory policy, deletion epoch and mode, the owner's settings
//    and the human, bot and room bindings, the learning settings, denies, a scope's kind.
//  - A commit by another connection (`PRAGMA data_version`) fires none of these triggers. It is placed by what it left in the file, in a
//    fixed number of seeks: rows added to the source, version, capture-job, tombstone and binding tables since the last look name their
//    threads (a row changed in place elsewhere is known by the revision its writer moves; no worker connection writes these tables); a memory revision, policy revision or deletion epoch that moved by more than this connection moved it, a changed mode or
//    learning settings, a deny added or removed, or a changed schema (a VACUUM renumbers rows) moves the generation. A commit that
//    touched none of these (a search index, a recall view, a root set) names nothing.
// an upsert, never INSERT OR IGNORE: inside a trigger the conflict rule of the statement that fired it replaces the trigger's own
// Each change row carries the feed's sequence number at the time of the change (the number moves first, so a later change is always a
// greater number): the reader keeps the last number it saw and reads the rows after it by the index on seq, never the whole table.
const NEXT_SEQ = "UPDATE memory_pending_feed SET seq=seq+1 WHERE id=1;";
const SEQ = "(SELECT seq FROM memory_pending_feed WHERE id=1)";
const DIRTY = (thread: string) => `${NEXT_SEQ} INSERT INTO memory_pending_dirty(thread_id,seq) SELECT ${thread},${SEQ} WHERE ${thread} IS NOT NULL ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq;`;
const SOURCE_DIRTY = (sourceId: string) => `${NEXT_SEQ} INSERT INTO memory_pending_dirty(thread_id,seq) SELECT s.thread_id,${SEQ} FROM memory_sources s WHERE s.id=${sourceId} AND s.thread_id IS NOT NULL ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq;`;
const WIDE = "UPDATE memory_pending_feed SET wide=wide+1 WHERE id=1;";
/** The tables whose greatest rowid tells the rows another connection added (ADDED_ROWS). A row this connection adds to or removes from
 *  one of them moves `own_rows`: the reader then knows its rowid marks are behind by rows of its own (pendingChanges). */
const ADDED_ROW_TABLES = ["memory_sources", "memory_source_versions", "memory_jobs", "memory_tombstones", "memory_scope_bindings"] as const;
const OWN_ROWS = "UPDATE memory_pending_feed SET own_rows=own_rows+1 WHERE id=1;";
const WIDE_BINDING = (row: string) => `(${ADMISSION_BINDING(row as "NEW")} AND ${row}.subject_type<>'source-origin')`;
const BINDING_COLUMNS = ["id", "scope_id", "subject_type", "subject_id", "revision", "state", "intent"] as const;
export const PENDING_FEED_SQL = `
CREATE TEMP TABLE IF NOT EXISTS memory_pending_dirty (thread_id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS temp.memory_pending_dirty_seq ON memory_pending_dirty(seq);
CREATE TEMP TABLE IF NOT EXISTS memory_pending_feed (id INTEGER PRIMARY KEY CHECK(id=1), wide INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
 own_data INTEGER NOT NULL DEFAULT 0, own_policy INTEGER NOT NULL DEFAULT 0, own_deletion INTEGER NOT NULL DEFAULT 0, own_rows INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO temp.memory_pending_feed(id) VALUES(1);
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_thread_insert AFTER INSERT ON temp.memory_thread_admission BEGIN ${DIRTY("NEW.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_thread_update AFTER UPDATE ON temp.memory_thread_admission BEGIN ${DIRTY("NEW.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_source_message AFTER UPDATE OF message_id ON main.memory_sources WHEN NEW.message_id IS NOT OLD.message_id BEGIN ${DIRTY("OLD.thread_id")} ${DIRTY("NEW.thread_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_tombstone AFTER INSERT ON main.memory_tombstones WHEN NEW.target_type='source' BEGIN ${SOURCE_DIRTY("NEW.target_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_tombstone_update AFTER UPDATE ON main.memory_tombstones WHEN (NEW.target_type='source' OR OLD.target_type='source') AND (${changed(["target_type", "target_id", "revision"])})
 BEGIN ${SOURCE_DIRTY("OLD.target_id")} ${SOURCE_DIRTY("NEW.target_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_tombstone_delete AFTER DELETE ON main.memory_tombstones WHEN OLD.target_type='source' BEGIN ${SOURCE_DIRTY("OLD.target_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_origin AFTER INSERT ON main.memory_scope_bindings WHEN NEW.subject_type='source-origin' BEGIN ${SOURCE_DIRTY("NEW.subject_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_origin_update AFTER UPDATE ON main.memory_scope_bindings WHEN (NEW.subject_type='source-origin' OR OLD.subject_type='source-origin') AND (${changed(BINDING_COLUMNS)})
 BEGIN ${SOURCE_DIRTY("OLD.subject_id")} ${SOURCE_DIRTY("NEW.subject_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_origin_delete AFTER DELETE ON main.memory_scope_bindings WHEN OLD.subject_type='source-origin' BEGIN ${SOURCE_DIRTY("OLD.subject_id")} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_binding AFTER INSERT ON main.memory_scope_bindings WHEN ${WIDE_BINDING("NEW")} BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_binding_update AFTER UPDATE ON main.memory_scope_bindings WHEN (${WIDE_BINDING("NEW")} OR ${WIDE_BINDING("OLD")}) AND (${changed(BINDING_COLUMNS)}) BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_binding_delete AFTER DELETE ON main.memory_scope_bindings WHEN ${WIDE_BINDING("OLD")} BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_meta AFTER UPDATE OF policy_revision,deletion_epoch,mode ON main.memory_meta WHEN ${changed(["policy_revision", "deletion_epoch", "mode"])} BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_meta_own AFTER UPDATE OF policy_revision,deletion_epoch,data_revision ON main.memory_meta BEGIN
 UPDATE memory_pending_feed SET own_data=own_data+NEW.data_revision-OLD.data_revision, own_policy=own_policy+NEW.policy_revision-OLD.policy_revision, own_deletion=own_deletion+NEW.deletion_epoch-OLD.deletion_epoch WHERE id=1; END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_learning AFTER UPDATE ON main.memory_learning_config WHEN ${changed(["revision", "settings"])} BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_learning_insert AFTER INSERT ON main.memory_learning_config BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_scope_kind AFTER UPDATE OF kind ON main.memory_scopes WHEN NEW.kind IS NOT OLD.kind BEGIN ${WIDE} END;
${ADDED_ROW_TABLES.map(table => `CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_own_insert_${table} AFTER INSERT ON main.${table} BEGIN ${OWN_ROWS} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_own_delete_${table} AFTER DELETE ON main.${table} BEGIN ${OWN_ROWS} END;`).join("\n")}
`;
/** memory_deny is a late object: its two triggers are made when the table is first seen (pendingChanges looks until it is there). */
export const PENDING_DENY_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_deny AFTER INSERT ON main.memory_deny BEGIN ${WIDE} END;
CREATE TEMP TRIGGER IF NOT EXISTS pip_pend_deny_delete AFTER DELETE ON main.memory_deny BEGIN ${WIDE} END;
`;
interface PendingFeed {
  /** `PRAGMA data_version` when another connection's commits were last placed */
  version: number;
  /** what a commit elsewhere may have changed for every thread, as last read */
  fingerprint: string;
  /** greatest rowid of each ADDED_ROWS table, as last read */
  marks: number[] | null;
  /** times a commit elsewhere, or the deny table arriving, moved the generation */
  elsewhere: number;
  deny: boolean;
  /** the feed's sequence number when the change rows were last read */
  seq: number;
  /** the feed's own row (everything this connection's writes move in it) when `fingerprint` and `marks` were last read */
  own: string;
}
/** The change rows after sequence number ?1: one range of the index on seq (EXPLAIN QUERY PLAN: SEARCH ... USING COVERING INDEX), so the
 *  read costs the rows that changed, whatever the number of threads. */
export const PENDING_CHANGED_SQL = "SELECT thread_id FROM temp.memory_pending_dirty WHERE seq>?";
const pendingFeeds = new WeakMap<DatabaseSync, PendingFeed | false>();
let feedWarned = false;
/** The tables a commit elsewhere may have added rows to, and the threads rows ?1 < rowid <= ?2 concern. */
const ADDED_ROWS: ReadonlyArray<{ table: (typeof ADDED_ROW_TABLES)[number]; threads: string }> = [
  { table: "memory_sources", threads: "SELECT DISTINCT a.thread_id AS t FROM main.memory_sources a WHERE a.rowid>?1 AND a.rowid<=?2 AND a.thread_id IS NOT NULL" },
  { table: "memory_source_versions", threads: "SELECT DISTINCT s.thread_id AS t FROM main.memory_source_versions a JOIN main.memory_sources s ON s.id=a.source_id WHERE a.rowid>?1 AND a.rowid<=?2 AND s.thread_id IS NOT NULL" },
  { table: "memory_jobs", threads: "SELECT DISTINCT s.thread_id AS t FROM main.memory_jobs a JOIN main.memory_sources s ON s.id=a.source_id WHERE a.rowid>?1 AND a.rowid<=?2 AND a.stage='capture' AND s.thread_id IS NOT NULL" },
  { table: "memory_tombstones", threads: "SELECT DISTINCT s.thread_id AS t FROM main.memory_tombstones a JOIN main.memory_sources s ON s.id=a.target_id WHERE a.rowid>?1 AND a.rowid<=?2 AND a.target_type='source' AND s.thread_id IS NOT NULL" },
  { table: "memory_scope_bindings", threads: "SELECT DISTINCT s.thread_id AS t FROM main.memory_scope_bindings a JOIN main.memory_sources s ON s.id=a.subject_id WHERE a.rowid>?1 AND a.rowid<=?2 AND a.subject_type='source-origin' AND s.thread_id IS NOT NULL" },
];
const ADDED_WIDE_BINDING = `SELECT 1 FROM main.memory_scope_bindings a WHERE a.rowid>?1 AND a.rowid<=?2 AND ${WIDE_BINDING("a")} LIMIT 1`;
/** Test seam: counts the times a commit by another connection was placed, and the times one moved the generation. */
export const pendingFeedStats = { placed: 0, wide: 0, ranges: 0, rebased: 0 };
/** What a commit elsewhere is compared against: what it may have changed for every thread (as one string, this connection's own moves of
 *  the revisions taken out), and the greatest rowid of each ADDED_ROWS table. A fixed number of seeks. */
function fileBaseline(db: DatabaseSync, feed: PendingFeed, own: Record<string, unknown>): { fingerprint: string; marks: number[] } {
  const meta = db.prepare("SELECT policy_revision AS p,deletion_epoch AS d,data_revision AS r,mode FROM main.memory_meta WHERE id=1").get();
  const learning = db.prepare("SELECT revision,settings FROM main.memory_learning_config WHERE id=1").get();
  const denies = feed.deny ? Number(db.prepare("SELECT COUNT(*) AS n FROM main.memory_deny").get()?.n ?? 0) : 0;
  const fingerprint = JSON.stringify([meta?.mode ?? null, Number(meta?.r ?? 0) - Number(own.own_data), Number(meta?.p ?? 0) - Number(own.own_policy), Number(meta?.d ?? 0) - Number(own.own_deletion),
    Number(db.prepare("PRAGMA schema_version").get()?.schema_version ?? 0), learning?.revision ?? null, learning?.settings ?? null, denies]);
  return { fingerprint, marks: ADDED_ROWS.map(({ table }) => Number(db.prepare(`SELECT MAX(rowid) AS n FROM main.${table}`).get()?.n ?? 0)) };
}
/** Places the commits of other connections since the last look (see the section note): adds the threads their new rows concern to
 *  `threads`, and counts one more `elsewhere` when they may have changed every thread's answer. A constant number of statements. */
function placeCommitsElsewhere(db: DatabaseSync, feed: PendingFeed, own: Record<string, unknown>, threads: Set<string>): void {
  pendingFeedStats.placed++;
  const { fingerprint, marks } = fileBaseline(db, feed, own);
  let wide = feed.marks !== null && fingerprint !== feed.fingerprint;
  if (feed.marks !== null) ADDED_ROWS.forEach(({ table, threads: sql }, i) => {
    const from = feed.marks![i], to = marks[i];
    // fewer rows than last time: rows went and their numbers may have been given again, so no range of new rows can be trusted
    if (to < from) { wide = true; return; }
    if (to === from) return;
    for (const row of db.prepare(sql).all(from, to)) threads.add(String(row.t));
    if (table === "memory_scope_bindings" && db.prepare(ADDED_WIDE_BINDING).get(from, to)) wide = true;
  });
  if (wide) { feed.elsewhere++; pendingFeedStats.wide++; }
  feed.fingerprint = fingerprint; feed.marks = marks;
}
export interface PendingChanges {
  /** differs from the last call's when a write may have changed every thread's answer (or the connection changed) */
  generation: string;
  /** threads whose answer a write may have changed since the last call */
  threads: string[];
}
/** The feed since the last call on this connection (the first call makes it: every thread is unknown then), or null when it cannot be kept
 *  (the counters are not installed) or taken now (inside a transaction): the caller then answers nothing from memory and reads every
 *  thread, as before. Synchronous. The mark is read first: the feed's own row (its sequence number and generation) and
 *  `PRAGMA data_version`. While neither moved nothing else is read and no thread is named: a fixed number of seeks whatever the number of
 *  threads. When the sequence number moved, the change rows after the last one seen are read by their index (PENDING_CHANGED_SQL); when
 *  another connection committed, its commits are placed (placeCommitsElsewhere). */
export function pendingChanges(db: DatabaseSync): PendingChanges | null {
  // the feed is temp rows: taken inside a transaction that rolls back, the rows it took would come back unread by anyone
  if (db.isTransaction || !ensureAdmissionEpochs(db)) return null;
  let feed = pendingFeeds.get(db);
  try {
    if (feed === undefined) {
      db.exec(PENDING_FEED_SQL);
      feed = { version: NaN, fingerprint: "", marks: null, elsewhere: 0, deny: false, seq: 0, own: "" };
      pendingFeeds.set(db, feed);
    }
    if (!feed) return null;
    if (!feed.deny && db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='memory_deny'").get()) {
      db.exec(PENDING_DENY_SQL);
      // denies written before the triggers were there; the table is new to the fingerprint too, which is read again below
      feed.deny = true; feed.elsewhere++; feed.own = "";
    }
    const version = Number(db.prepare("PRAGMA data_version").get()?.data_version);
    const own = db.prepare("SELECT wide,seq,own_data,own_policy,own_deletion,own_rows FROM temp.memory_pending_feed WHERE id=1").get();
    if (!own) return null;
    const threads = new Set<string>(), seq = Number(own.seq);
    if (seq !== feed.seq) {
      pendingFeedStats.ranges++;
      for (const row of db.prepare(PENDING_CHANGED_SQL).all(feed.seq)) threads.add(String(row.thread_id));
      feed.seq = seq;
    }
    // sampled before the file is read: a commit that lands during the reads below is placed again by the next call
    // the schema too: a table or an index this connection makes moves `schema_version`, which the fingerprint holds, and no row of the feed
    const ownMark = `${Number(own.wide)}:${seq}:${Number(own.own_data)}:${Number(own.own_policy)}:${Number(own.own_deletion)}:${Number(own.own_rows)}:${Number(db.prepare("PRAGMA schema_version").get()?.schema_version ?? 0)}`;
    if (version !== feed.version) { placeCommitsElsewhere(db, feed, own, threads); feed.version = version; feed.own = ownMark; }
    else if (ownMark !== feed.own) {
      // This connection wrote (or changed the schema) since the fingerprint and the rowid marks were read, and no other connection has committed since: what moved
      // in the file is this connection's own, and its triggers have named it already (the change rows read above, the generation below).
      // The fingerprint and the marks are read again here, so that the next commit elsewhere is placed from this point and is never asked
      // about rows and settings of this connection the check has consumed already (ASTRA 1977a62606: an unrelated commit elsewhere read
      // every thread this connection had written to again). They are kept only when `data_version` still stands after the reads: a commit
      // that landed among them is left to the next call, placed from the older point (wider, never narrower).
      const base = fileBaseline(db, feed, own);
      if (Number(db.prepare("PRAGMA data_version").get()?.data_version) === version) { feed.fingerprint = base.fingerprint; feed.marks = base.marks; feed.own = ownMark; pendingFeedStats.rebased++; }
    }
    return { generation: `${connectionId(db)}:${Number(own.wide)}:${feed.elsewhere}`, threads: [...threads] };
  } catch (error) {
    if (!feedWarned) { feedWarned = true; console.warn(`[memory] pip pending change feed is off; the pending check reads every thread (${error instanceof Error ? error.message : String(error)})`); }
    pendingFeeds.set(db, false);
    return null;
  }
}

// ---------------------------------------------- persisted window re-read ----

/** Ids one page of readShownSliced re-reads. */
export const SHOWN_PAGE_ROWS = 64;
export const SHOWN_PAGE_SQL = `SELECT s.rowid AS pos,s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,s.kind,v.payload FROM json_each(?1) j
  CROSS JOIN memory_sources s ON s.id=json_extract(j.value,'$[0]')
  JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
  WHERE s.state='active' AND s.revision=json_extract(j.value,'$[1]') AND s.thread_id=?2 AND NOT ${DENIED_PLACE("s")}`;
/** r3 2.7: the exact window a request showed (`f.shown`, at most a few hundred `[sourceId, revision]`), re-read by id in pages of
 *  SHOWN_PAGE_ROWS with the same admission as the span read (active at that revision, not denied by its own stored place, owner turn
 *  learnable / completed action, the bot's own thread). What is no longer admissible is simply absent, so the caller's digest of the result
 *  differs from the request's. Membership is by identity: no time range, no sort of a list. `rows` keeps the window's order. */
export async function readShownSliced(db: DatabaseSync, botId: string, threadId: string, shown: ReadonlyArray<readonly [string, number]>, excluded: readonly string[],
  between: () => Promise<void>, signal?: AbortSignal, check?: StampCheck): Promise<{ answer: WalkAnswer; rows: AdmittedSource[] }> {
  const rows: AdmittedSource[] = [];
  const page = shownPager(db, botId, threadId, excluded);
  if (!page) return { answer: "none", rows };
  const byId = new Map<string, AdmittedSource>();
  for (let i = 0; i < shown.length; i += SHOWN_PAGE_ROWS) {
    if (i > 0) {
      if (signal?.aborted) return { answer: "aborted", rows };
      await between();
      if (signal?.aborted) return { answer: "aborted", rows };
      const answer = check?.();
      if (answer && answer !== "none") return { answer, rows };
    }
    heldStep("memory.pip.threads", () => page(shown.slice(i, i + SHOWN_PAGE_ROWS), byId));
  }
  for (const [id] of shown) { const row = byId.get(id); if (row) rows.push(row); }
  return { answer: "none", rows };
}
/** One page of the window re-read, or undefined when the thread itself is no longer admitted (not the bot's own, excluded, denied). */
function shownPager(db: DatabaseSync, botId: string, threadId: string, excluded: readonly string[]) {
  if (!threadIsBotsOwn(botId, threadId, excluded) || threadDenied(db, threadId)) return undefined;
  const actionsAllowed = turnAudienceIsOwner(threadId, {}, db);
  const q: SpanQuery = { threadId };
  const statement = db.prepare(SHOWN_PAGE_SQL);
  return (ids: ReadonlyArray<readonly [string, number]>, byId: Map<string, AdmittedSource>) => {
    for (const r of statement.all(JSON.stringify(ids), threadId) as SourceRow[]) {
      const admitted = r.kind === "text" ? ownerRow(db, q, r) : r.kind === "tool-outcome" && actionsAllowed ? actionRow(db, q, r) : null;
      if (admitted) byId.set(admitted.sourceId, admitted);
    }
  };
}
/** readShownSliced in one synchronous pass, for a caller already inside a transaction (the stored-result revalidation, r6): the window a
 *  request showed is a few hundred ids at most, so this is a handful of pages of index seeks. Same admission, same order. */
export function readShownNow(db: DatabaseSync, botId: string, threadId: string, shown: ReadonlyArray<readonly [string, number]>, excluded: readonly string[]): AdmittedSource[] {
  const page = shownPager(db, botId, threadId, excluded);
  if (!page) return [];
  const byId = new Map<string, AdmittedSource>();
  for (let i = 0; i < shown.length; i += SHOWN_PAGE_ROWS) page(shown.slice(i, i + SHOWN_PAGE_ROWS), byId);
  return shown.flatMap(([id]) => { const row = byId.get(id); return row ? [row] : []; });
}
