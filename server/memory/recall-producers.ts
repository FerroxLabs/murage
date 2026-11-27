// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory V2 lane A, design 4.2 A10 (AF-H8, F19). Owner of this file and of both sides of it: lane A (these producers write the receipt
// flips; the recall applier in recall-view.ts reads the journal rows they make). Callers: worker-controller.ts oweReceiptsToNewIndex (an
// index reset) and settings.ts downloadModel (a model adoption through Settings).
//
// A producer of bulk receipt changes used to be one statement over every receipt: one journal row per receipt, in one transaction, with
// no regard for the views that then have to read them. Here it writes pages:
//   - one page = at most RECALL_CHANGE_SET (256) receipts, in key order, ending on a whole (record, version) key, in ONE transaction,
//     through coverReceiptChanges, so the page is one 'receipts' range row in the journal instead of one row per receipt;
//   - before each page the producer asks recallJournalRoom: while the journal head is more than RECALL_PRODUCER_ROOM rows above the
//     applied mark or above a build in flight it waits on whenRecallJournalRoom, which the applier's own commit settles (no timer);
//   - owner writes never pass through here.
// A model adoption keeps its place in a marker row `memory-v2:model-adoption` of memory_scope_bindings (design 3.5: subject `system` /
// `memory-v2`, written in the page's own transaction, removed with the last page), so a crash in the middle is finished by the next
// start: one single-row read at every open (onWakeInstall) raises the adoption's topic when the marker is there. No persisted object is
// added, dropped or edited (schema v13 text-exact).
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { coverReceiptChanges, RECALL_CHANGE_SET } from "./recall-view-schema.ts";
import { recallJournalRoom, whenRecallJournalRoom } from "./recall-view.ts";
import { onWake, onWakeInstall, raise, WAKE_PRIORITY, type WakeContext, type WakeResult } from "./wake.ts";

export type ReceiptKey = readonly [string, number];
interface RawReceipt { record_id: string; record_version: number; rid: number; lexical_status: string; embedding_status: string; state: string | null }
interface KeyPage { raw: RawReceipt[]; hi: ReceiptKey | null; done: boolean }
const FIRST: ReceiptKey = ["", Number.MIN_SAFE_INTEGER];
const stats = { pages: 0, waits: 0, resumed: 0, widestPage: 0, receipts: 0 };
/** Counters for the witnesses: pages written, times a producer found no room and waited, adoptions picked up from a marker at an open,
 * the most receipts one page changed, receipts changed in all. */
export function recallProducerStats(): Readonly<typeof stats> { return { ...stats }; }
export function resetRecallProducerStatsForTest(): void { for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0; }

/** At most `rows` receipts after `after` in key order. A page ends on a whole (record, version) key: receipts of several index
 * generations share one, and a range row names keys. `indexed` reads only receipts whose lexical status is 'indexed', by the pending index. */
function keyPage(db: DatabaseSync, after: ReceiptKey | null, rows: number, indexed: boolean): KeyPage {
  const from = after ?? FIRST;
  const sql = `SELECT p.record_id,p.record_version,p.rowid AS rid,p.lexical_status,p.embedding_status,
    (SELECT r.state FROM memory_records r WHERE r.id=p.record_id AND r.version=p.record_version) AS state
    FROM memory_projection_receipts p ${indexed ? "INDEXED BY memory_projection_pending WHERE p.lexical_status='indexed' AND" : "WHERE"}
    (p.record_id,p.record_version)>(?,?) ORDER BY p.record_id,p.record_version LIMIT ?`;
  let raw = db.prepare(sql).all(from[0], from[1], rows + 1) as unknown as RawReceipt[];
  const done = raw.length <= rows;
  if (!done) {
    const last = raw[raw.length - 1]!, same = (row: RawReceipt) => row.record_id === last.record_id && Number(row.record_version) === Number(last.record_version);
    const whole = raw.filter(row => !same(row));
    // (more generations of one key than a page holds: that key alone is the page, every receipt of it)
    raw = whole.length ? whole : raw;
  }
  const end = raw[raw.length - 1];
  return { raw, hi: end ? [String(end.record_id), Number(end.record_version)] : null, done };
}
function distinctKeys(rows: readonly RawReceipt[]): ReceiptKey[] {
  const keys = new Map<string, ReceiptKey>();
  for (const row of rows) keys.set(`${row.record_id}\u0000${row.record_version}`, [String(row.record_id), Number(row.record_version)]);
  return [...keys.values()];
}
function wrote(changed: number): void { stats.pages++; stats.receipts += changed; stats.widestPage = Math.max(stats.widestPage, changed); }

// ── an index reset: every receipt is owed to the rebuilt index again ───────────────────────────────────────────────────────────────
export const OWE_RECEIPTS_SQL = "UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending' AND lexical_status!='deleted'";
/** One page of an index reset, in the caller's transaction: the receipts after `after` (key order) up to rowid `through` are owed again.
 * Returns where the next page starts and whether this was the last one. Idempotent: a page run twice changes nothing the second time. */
export function oweReceiptsPage(db: DatabaseSync, after: ReceiptKey | null, through: number, rows = RECALL_CHANGE_SET): { after: ReceiptKey | null; done: boolean } {
  const page = keyPage(db, after, Math.max(1, Math.min(rows, RECALL_CHANGE_SET)), false);
  if (!page.hi) return { after, done: true };
  const from = after ?? FIRST;
  // What the journal has to hear of: a receipt whose lexical status really moves (an unchanged one fires nothing, I5).
  const moving = page.raw.filter(row => Number(row.rid) <= through && row.lexical_status !== "delete-pending" && row.lexical_status !== "deleted"
    && row.lexical_status !== (row.state === "active" ? "pending" : "pending-archive"));
  const run = () => {
    const changed = Number(db.prepare(`${OWE_RECEIPTS_SQL} AND (record_id,record_version)>(?,?) AND (record_id,record_version)<=(?,?) AND rowid<=?`)
      .run(from[0], from[1], page.hi![0], page.hi![1], through).changes);
    wrote(changed);
  };
  if (moving.length) coverReceiptChanges(db, distinctKeys(moving), run); else run();
  return { after: page.hi, done: page.done };
}

// ── a model adoption through Settings: receipts indexed without a model are indexed again ──────────────────────────────────────────
export const MODEL_ADOPTION_MARKER = "memory-v2:model-adoption";
/** The marker's subject: the one lane I's migration cursors use (noisy-subjects.ts), so a cursor write never moves an authority stamp. */
const MARKER_SUBJECT = "memory-v2";
export const MODEL_ADOPTION_TOPIC = "model-adoption";
const ADOPT_SQL = "UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending' WHERE embedding_status='unavailable' AND lexical_status='indexed'";
type Marker = { after: ReceiptKey | null };
function readMarker(db: DatabaseSync): Marker | undefined {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(MODEL_ADOPTION_MARKER);
  if (!row) return undefined;
  // A marker that cannot be read starts the adoption again from the first key: every page is idempotent.
  try {
    const cursor = (JSON.parse(String(row.intent)) as { cursor?: unknown }).cursor;
    if (Array.isArray(cursor) && typeof cursor[0] === "string" && Number.isSafeInteger(cursor[1])) return { after: [cursor[0], Number(cursor[1])] };
  } catch { /* from the start */ }
  return { after: null };
}
/** True when an adoption was started and its last page has not committed (one single-row read by primary key). */
export function modelAdoptionPending(db: DatabaseSync): boolean { return readMarker(db) !== undefined; }
function writeMarker(db: DatabaseSync, marker: Marker): boolean {
  // The binding needs a scope row (its foreign key); a file without one holds no record and so no receipt.
  const scope = db.prepare("SELECT id FROM memory_scopes ORDER BY id LIMIT 1").get()?.id;
  if (scope === undefined) return false;
  db.prepare(`INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?)
    ON CONFLICT(id) DO UPDATE SET intent=excluded.intent WHERE intent IS NOT excluded.intent`)
    .run(MODEL_ADOPTION_MARKER, String(scope), MARKER_SUBJECT, JSON.stringify({ cursor: marker.after, done: false }));
  return true;
}
/** One page of the adoption and its cursor, in ONE transaction. True when the adoption is finished (the marker is gone). */
function adoptionPage(db: DatabaseSync): boolean {
  return transaction(() => {
    const marker = readMarker(db);
    if (!marker) return true;
    const page = keyPage(db, marker.after, RECALL_CHANGE_SET, true);
    if (page.hi) {
      const from = marker.after ?? FIRST, moving = page.raw.filter(row => row.embedding_status === "unavailable");
      const run = () => wrote(Number(db.prepare(`${ADOPT_SQL} AND (record_id,record_version)>(?,?) AND (record_id,record_version)<=(?,?)`).run(from[0], from[1], page.hi![0], page.hi![1]).changes));
      if (moving.length) coverReceiptChanges(db, distinctKeys(moving), run);
    }
    if (page.done || !page.hi) { db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(MODEL_ADOPTION_MARKER); return true; }
    writeMarker(db, { after: page.hi });
    return false;
  }, { op: "memory-model-adoption" });
}
/** The model is on disk and verified: start the adoption. The marker and the first page commit together, so a store of at most one page
 * is adopted before this returns (as the one statement was); a longer one goes on in the background, page by page, and is finished by
 * the next start if this process dies. Returns true when nothing is left. */
export function startModelAdoption(db: DatabaseSync = database()): boolean {
  installModelAdoption();
  const marked = transaction(() => writeMarker(db, readMarker(db) ?? { after: null }), { op: "memory-model-adoption" });
  // No scope row: no receipt can exist; the statement of old is run for what it is worth (it changes nothing).
  if (!marked) { db.prepare(ADOPT_SQL).run(); return true; }
  if (recallJournalRoom(db) && adoptionPage(db)) return true;
  raise(MODEL_ADOPTION_TOPIC);
  return false;
}
/** The adoption's subscriber: one page a slice; with no room it names the gate it waits on (the applier's commit), never a timer. */
function adoptionSlice(context: WakeContext): WakeResult {
  const db = database();
  // (never inside a writer's transaction still open on this turn: the page is its own transaction)
  if (db.isTransaction) { context.armDeadline(Date.now() + 250); return { more: true }; }
  if (!modelAdoptionPending(db)) return false;
  if (!recallJournalRoom(db)) { stats.waits++; context.until(whenRecallJournalRoom(db)); return { more: true }; }
  if (adoptionPage(db)) return false;
  context.until(Promise.resolve());
  return { more: true };
}
let uninstall: (() => void) | null = null;
/** Subscribes the adoption to its topic and to every open of the main connection (the resume probe). Idempotent. */
export function installModelAdoption(): void {
  if (uninstall) return;
  const off = onWake(MODEL_ADOPTION_TOPIC, adoptionSlice, { priority: WAKE_PRIORITY.background, name: "model-adoption" });
  const unhook = onWakeInstall(db => {
    let pending = false;
    try { pending = modelAdoptionPending(db); } catch { /* a file without the memory tables yet: nothing was started */ }
    if (pending) { stats.resumed++; raise(MODEL_ADOPTION_TOPIC); }
  });
  uninstall = () => { off(); unhook(); };
}
/** Tests (after resetWakeForTest forgot every subscriber): subscribe again. */
export function reinstallModelAdoptionForTest(): void { uninstall?.(); uninstall = null; installModelAdoption(); }
installModelAdoption();
