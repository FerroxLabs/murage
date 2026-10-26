// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-time scrub of bank, card, account and personal id numbers that 1.0.3 and earlier kept in memory (PASTE-CAPTURE-FIX 5, r2.5 to
// r2.9). It runs as a background upgrade job after the integrity pass, in slices, and rewrites in place with the length-keeping mask of
// shared/financial-ids.ts, so every evidence span over a rewritten cell stays valid. Nothing keeps the originals: no journal, no copy
// (S2 as decided). The read-time masks (bundle, recall, the owner's list) cover a row the scrub has not reached yet.
//
// Phases, each a rowid walk that ends when a slice reads no row (no max(rowid) snapshot: a row born during the scrub is written masked by
// record-write.ts, and reaching it writes nothing):
//   versions  memory_source_versions: $.text, $.action.label, $.action.detail; the content hash beside a changed payload is recomputed
//             in the form that made it (Grok r2 H5), on the version row and on its source
//   records   memory_records.text, every kind and state but deleted; a changed record's projection receipt goes back to pending
//   details   memory_record_details.entities
//   feedback  memory_feedback.correction
//   settle    once the projection receipts have drained: one optimize and one log TRUNCATE in the index file (the helper), then a TRUNCATE
//             of messages.db; skipped when nothing changed
// The place lives in one row of messages.db outside the memory schema (its name does not start with memory_, like the integrity pass's).
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beginBackground } from "../db-busy.ts";
import { scrubWalAfterDelete } from "../wal-maintenance.ts";
import { FINANCIAL_RULE_VERSION, maskFinancialIdentifiers, passesFinancialFastPath } from "../../shared/financial-ids.ts";
import { integrityHoldOf, integrityRunning, readIntegrityPass } from "./integrity-state.ts";
import { SCRUB_PASS_TABLE, SCRUB_PHASES, ensureScrubPassTable, readScrubPass, type ScrubPassRow, type ScrubPhase } from "./scrub-state.ts";

export { SCRUB_PASS_TABLE, readScrubPass, scrubPassPending, seedScrubPassDone } from "./scrub-state.ts";

/** Rows one slice reads at most; the slice's time stops it sooner. */
export const SCRUB_SLICE_ROWS = 64;
/** How long settle waits for the receipts to drain and the helper to finish the rewrite before the pass ends anyway (D15, D16): the
 * records are masked in this file already, the merge the rewrite owes is durable in the index file, and its ordinary checkpoints carry on. */
export const SCRUB_SETTLE_MAX_MS = 60 * 60_000;
/** The pause between settle slices that wait. */
export const SCRUB_SETTLE_RETRY_MS = 1_000;

export interface ScrubStep { more: boolean; phase: ScrubPhase; done: number; total: number; /** wait this long before the next slice (a hold, settle) */ retryMs?: number }
export interface ScrubOptions { budgetMs?: number; rows?: number; now?: () => number; clock?: () => number }

/** The helper that owns the index writer finishes the rewrite (MemoryIndex.finishRewrite): true once it has. Set by the worker controller
 * while the helper runs. */
let finisher: (() => Promise<boolean>) | null = null;
export function setScrubRewriteFinisher(fn: (() => Promise<boolean>) | null): void { finisher = fn; }
/** Clears messages.db's log once the pass row is written (wal-maintenance: the checkpointer thread, never the server thread). Swapped only by tests. */
let clearLog: () => Promise<boolean> = scrubWalAfterDelete;
export function setScrubLogClearer(fn: (() => Promise<boolean>) | null): void { clearLog = fn ?? scrubWalAfterDelete; }
let finishing: { done: boolean; ok: boolean } | null = null;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The content hash capture.ts writes: over the payload without its metadata (origin, engine, actionCheck). */
function captureHash(payload: Record<string, unknown>): string {
  const content = { ...payload }; delete content.origin; delete content.engine; delete content.actionCheck;
  return sha(JSON.stringify(content));
}
type HashForm = "capture" | "payload" | "text";
/** Which of the three writers made this hash: capture (content without metadata), bring-in (the payload as stored), import (the text). */
function hashForm(stored: string, raw: string, payload: Record<string, unknown>): HashForm | null {
  if (captureHash(payload) === stored) return "capture";
  if (sha(raw) === stored) return "payload";
  if (typeof payload.text === "string" && sha(payload.text) === stored) return "text";
  return null;
}
function hashOf(form: HashForm, raw: string, payload: Record<string, unknown>): string {
  return form === "capture" ? captureHash(payload) : form === "payload" ? sha(raw) : sha(String(payload.text ?? ""));
}

/** One cell masked, or null when it holds nothing to mask. Null too (and counted) when the mask would change its byte length (D5). */
function maskCell(text: string): { masked: string } | { skip: true } | null {
  if (!passesFinancialFastPath(text)) return null;
  const masked = maskFinancialIdentifiers(text);
  if (masked === text) return null;
  if (Buffer.byteLength(masked) !== Buffer.byteLength(text)) return { skip: true };
  return { masked };
}

interface Tally { changed: number; skipped: number }

function scrubVersion(db: DatabaseSync, row: Record<string, unknown>, tally: Tally): void {
  const raw = String(row.payload);
  let payload: Record<string, unknown>;
  // D4: a payload that is not an object, or whose fields are not strings, is the integrity pass's to judge
  try { payload = JSON.parse(raw); } catch { tally.skipped++; return; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) { tally.skipped++; return; }
  const action = payload.action && typeof payload.action === "object" && !Array.isArray(payload.action) ? payload.action as Record<string, unknown> : null;
  const cells: Array<[Record<string, unknown>, string]> = [[payload, "text"], ...(action ? [[action, "label"], [action, "detail"]] as Array<[Record<string, unknown>, string]> : [])];
  let touched = false;
  for (const [holder, key] of cells) {
    const value = holder[key];
    if (typeof value !== "string") continue;
    const cell = maskCell(value);
    if (!cell) continue;
    if ("skip" in cell) { tally.skipped++; return; }
    holder[key] = cell.masked; touched = true;
  }
  if (!touched) return;
  const sourceId = String(row.source_id), revision = Number(row.revision), stored = String(row.content_hash);
  // the hash is worked out on the original before the payload is rewritten (the original stays only in this function's memory)
  const original = JSON.parse(raw) as Record<string, unknown>;
  const form = hashForm(stored, raw, original);
  // an imported notebook's payload names its own hash (import.ts)
  if (form === "text" && payload.originalHash === stored) payload.originalHash = sha(String(payload.text ?? ""));
  const next = JSON.stringify(payload);
  // a hash no writer's form reproduces is recomputed in capture's form: the hash of the original never stays beside the masked payload
  const fresh = hashOf(form ?? "capture", next, payload);
  db.prepare("UPDATE memory_source_versions SET payload=?,content_hash=? WHERE rowid=?").run(next, fresh, Number(row.rid));
  // the source names its current revision's hash
  db.prepare("UPDATE memory_sources SET content_hash=? WHERE id=? AND revision=? AND content_hash=?").run(fresh, sourceId, revision, stored);
  if (form === "text") {
    // an imported notebook: its link compares the hash of the text it reads now (import.ts), which is the masked one
    db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.hash',?) WHERE id=? AND json_valid(intent) AND json_extract(intent,'$.hash')=?").run(fresh, `notebook-link:${sourceId}`, stored);
    // a forgotten earlier copy of the same notebook stays refused under the new hash as well
    const scope = db.prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(sourceId)?.scope_id;
    if (typeof scope === "string" && db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=?").get(scope, stored)
      && !db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='import' AND target_id=? AND content_hash=?").get(scope, fresh)) {
      const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()?.deletion_epoch ?? 0);
      db.prepare("INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(), scope, fresh, epoch, Date.now());
    }
  }
  tally.changed++;
}

function scrubRecord(db: DatabaseSync, row: Record<string, unknown>, tally: Tally): void {
  if (String(row.state) === "deleted" || typeof row.text !== "string") return;
  const cell = maskCell(row.text);
  if (!cell) return;
  if ("skip" in cell) { tally.skipped++; return; }
  db.prepare("UPDATE memory_records SET text=? WHERE rowid=?").run(cell.masked, Number(row.rid));
  // the projection copies (entries, the word index, the vectors) are rewritten from the new text when the receipt drains (D12)
  db.prepare(`UPDATE memory_projection_receipts SET lexical_status=CASE WHEN ?='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending'
    WHERE record_id=? AND record_version=? AND lexical_status NOT IN ('delete-pending','deleted')`).run(String(row.state), String(row.id), Number(row.version));
  tally.changed++;
}

function scrubDetail(db: DatabaseSync, row: Record<string, unknown>, tally: Tally): void {
  if (row.kind === "entities") {
    // a details row's entities are the strings the extractor pulled out of the text
    let entities: unknown;
    try { entities = JSON.parse(String(row.value)); } catch { tally.skipped++; return; }
    if (!Array.isArray(entities)) { tally.skipped++; return; }
    let touched = false;
    const next = entities.map(entity => {
      if (typeof entity !== "string") return entity;
      const cell = maskCell(entity);
      if (!cell || "skip" in cell) { if (cell) tally.skipped++; return entity; }
      touched = true; return cell.masked;
    });
    if (!touched) return;
    db.prepare("UPDATE memory_record_details SET entities=? WHERE rowid=?").run(JSON.stringify(next), Number(row.rid));
    tally.changed++;
    return;
  }
  if (typeof row.value !== "string") return;
  const cell = maskCell(row.value);
  if (!cell) return;
  if ("skip" in cell) { tally.skipped++; return; }
  db.prepare("UPDATE memory_feedback SET correction=? WHERE rowid=?").run(cell.masked, Number(row.rid));
  tally.changed++;
}

const maxRowid = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT COALESCE(MAX(rowid),0) AS m FROM ${table}`).get()?.m ?? 0);
const hasTableNamed = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));

const PHASE_TABLE: Partial<Record<ScrubPhase, string>> = { versions: "memory_source_versions", records: "memory_records", details: "memory_record_details", feedback: "memory_feedback" };

/** The rows of a walking phase after `cursor`, at most `limit`. */
function readSlice(db: DatabaseSync, phase: ScrubPhase, cursor: number, limit: number): Array<Record<string, unknown>> {
  if (phase === "versions") return db.prepare("SELECT rowid AS rid,source_id,revision,content_hash,payload FROM memory_source_versions WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, limit);
  if (phase === "records") return db.prepare("SELECT rowid AS rid,id,version,state,text FROM memory_records WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, limit);
  if (phase === "details") return db.prepare("SELECT rowid AS rid,'entities' AS kind,entities AS value FROM memory_record_details WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, limit);
  return hasTableNamed(db, "memory_feedback") ? db.prepare("SELECT rowid AS rid,'correction' AS kind,correction AS value FROM memory_feedback WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, limit) : [];
}

function walkSlice(db: DatabaseSync, pass: ScrubPassRow, options: Required<Pick<ScrubOptions, "rows">> & { deadline: number; now: () => number; clock: () => number }): ScrubStep {
  const phase = pass.phase, tally: Tally = { changed: 0, skipped: 0 };
  let cursor = pass.cursor;
  const scrub = phase === "versions" ? scrubVersion : phase === "records" ? scrubRecord : scrubDetail;
  beginBackground(db, "memory-scrub");
  try {
    const rows = readSlice(db, phase, cursor, options.rows);
    for (const row of rows) {
      scrub(db, row, tally);
      cursor = Number(row.rid);
      if (options.now() >= options.deadline) break;
    }
    // a phase ends on a slice that read no row (r2.7: no snapshot); its total is the table's newest rowid, read again each slice, for the strip only
    const ended = rows.length === 0;
    const table = PHASE_TABLE[phase]!;
    const total = hasTableNamed(db, table) ? maxRowid(db, table) : 0;
    const nextPhase: ScrubPhase = ended ? SCRUB_PHASES[SCRUB_PHASES.indexOf(phase) + 1]! : phase;
    // settle keeps the time it began in the cursor (SCRUB_SETTLE_MAX_MS)
    db.prepare(`UPDATE ${SCRUB_PASS_TABLE} SET phase=?,cursor=?,changed=changed+?,skipped=skipped+?,total=? WHERE id=1`)
      .run(nextPhase, ended ? (nextPhase === "settle" ? options.clock() : 0) : cursor, tally.changed, tally.skipped, total);
    db.exec("COMMIT");
    // D4: a count only, never an id's content
    if (tally.skipped) console.warn(`[memory] scrub ${phase}: ${tally.skipped} row(s) left as they are (shape not readable)`);
    const done = ended ? total : Math.min(total, cursor);
    return { more: true, phase: nextPhase, done, total: Math.max(total, done, 1) };
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}

function finish(db: DatabaseSync): ScrubStep {
  beginBackground(db, "memory-scrub");
  try {
    db.prepare(`UPDATE ${SCRUB_PASS_TABLE} SET phase='done',cursor=0,finished_at=? WHERE id=1`).run(Date.now());
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  finishing = null;
  return { more: false, phase: "done", done: 1, total: 1 };
}

/** settle: the rewrite of the projection copies is done when no receipt is pending; then the helper optimizes its word index and truncates its
 * log, and this file's log is cleared (r2.6). Waits are slices that return more with a retry; past SCRUB_SETTLE_MAX_MS the pass ends anyway. */
function settleSlice(db: DatabaseSync, pass: ScrubPassRow, clock: () => number): ScrubStep {
  const waiting: ScrubStep = { more: true, phase: "settle", done: 0, total: 1, retryMs: SCRUB_SETTLE_RETRY_MS };
  if (pass.changed === 0) return finish(db);
  const overdue = clock() - pass.cursor >= SCRUB_SETTLE_MAX_MS;
  const pending = Boolean(db.prepare("SELECT 1 FROM memory_projection_receipts WHERE lexical_status IN ('pending','pending-archive') LIMIT 1").get());
  if (pending && !overdue) return waiting;
  if (!finishing?.ok && !overdue) {
    if (finishing && !finishing.done) return waiting;
    const ask = finisher;
    if (!ask) return waiting;
    const asked = { done: false, ok: false };
    finishing = asked;
    void ask().then(ok => { asked.done = true; asked.ok = ok; if (!ok && finishing === asked) finishing = null; }, () => { asked.done = true; if (finishing === asked) finishing = null; });
    return waiting;
  }
  // the helper has finished its file (or the wait is over): the pass row is written, then this file's log is cleared the way a deletion's
  // is (wal-maintenance: the checkpointer thread runs it, never the server thread; a reader that holds it off leaves it owed and the idle
  // retry and the start-up TRUNCATE settle it, D15)
  const step = finish(db);
  void clearLog().catch(() => false);
  return step;
}

/** One slice of the scrub. A file with nothing owed answers more: false. Throws on a database error (busy: DatabaseBusyError, a full disk):
 * the place is committed after every slice, so the queue tries again later and nothing is half written (D1, D2, D6). */
export function stepScrubPass(db: DatabaseSync, options: ScrubOptions = {}): ScrubStep {
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? Date.now;
  let pass = readScrubPass(db);
  if (pass === null || pass.ruleVersion < FINANCIAL_RULE_VERSION) {
    // the start is a background write like every slice: a busy file is "try later" (D2)
    beginBackground(db, "memory-scrub");
    try {
      ensureScrubPassTable(db);
      db.prepare(`INSERT OR REPLACE INTO ${SCRUB_PASS_TABLE}(id,rule_version,phase,cursor,changed,skipped,total,started_at,finished_at) VALUES(1,?,'versions',0,0,0,0,?,NULL)`).run(FINANCIAL_RULE_VERSION, clock());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
    finishing = null;
    pass = readScrubPass(db)!;
  }
  if (pass.phase === "done") return { more: false, phase: "done", done: 1, total: 1 };
  // D7: nothing is rewritten while the integrity pass runs or holds (rows not yet proven are left as they are)
  let integrity = null;
  try { integrity = readIntegrityPass(db); } catch { integrity = null; }
  if (integrityRunning(integrity) || integrityHoldOf(integrity) !== null) return { more: true, phase: pass.phase, done: 0, total: 1, retryMs: SCRUB_SETTLE_RETRY_MS };
  if (pass.phase === "settle") return settleSlice(db, pass, clock);
  return walkSlice(db, pass, { rows: options.rows ?? SCRUB_SLICE_ROWS, deadline: now() + (options.budgetMs ?? 20), now, clock });
}
