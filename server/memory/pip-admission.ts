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
let epochsWarned = false;
/** Makes the counters and their triggers on this connection (once; outside a transaction, so a rollback never takes them away unseen).
 *  False when they are not there: every stamp then compares as moved (fail closed). */
export function ensureAdmissionEpochs(db: DatabaseSync): boolean {
  const known = epochsReady.get(db);
  if (known !== undefined) return known && present(db);
  if (db.isTransaction) return false;
  let ready = false;
  try {
    db.exec(ADMISSION_EPOCH_SQL);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny'").get()) db.exec(ADMISSION_DENY_SQL);
    ready = true;
  } catch (error) {
    if (!epochsWarned) { epochsWarned = true; console.warn(`[memory] pip admission epochs could not be installed; reflection reads compare as moved (${error instanceof Error ? error.message : String(error)})`); }
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
const counters = (db: DatabaseSync) => db.prepare("SELECT (SELECT global FROM temp.memory_admission_epoch WHERE id=1) AS g, (SELECT data_version FROM pragma_data_version) AS v").get();
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
export function stampMoved(db: DatabaseSync, deps: StampDeps, botId: string, stamp: AdmissionStamp): StampAnswer {
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
