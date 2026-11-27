// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner: ctxrev-selfheal (this one-time 1.0.21 repair and its after-listen step). Producer of the stuck data: the tracked notebook
// re-import (import.ts commitImportItems, import / ctxrev-h1 owners). Consumers it unblocks: the retained fence and session lookup
// (deny-read.ts, send-fence.ts, fence owners). The undo and the paced walk it hands work to stay the revoke-marker owners'
// (revoke-commit.ts undoRevoke, memory-revocation.ts runner).
//
// The 1.0.21 repair of a data dir that 1.0.20 left refusing every turn (MEMORY_CONTEXT_REVOKED, ctxrev). No setting: it runs at start, in
// bounded slices, and a start after it finished does nothing. What 1.0.20 left behind, and what each step does with it:
//  S1. A tracked notebook's re-import supersedes every chunk, its unchanged words included. A receipt still citing such a chunk version read
//      withheld/deny-memory at the retained fence and refused every turn holding it. Its cited version is re-pointed to the active version
//      with the same words. No record changes state; a revoked receipt is never touched.
//  S2. Write-time revokes of such unchanged chunk versions (builds before reclaim-n6 queued one per chunk per re-import) each held a pending
//      window over every thread: resumed sessions read checking:pending until the marker walked them all. Each is undone through the owner
//      Undo path (undoRevoke), whose walk the existing runner paces under the revoke and io budgets. A folded, audience or deletion revoke is
//      never undone (foldRefusesUndo).
// Both steps act ONLY on what UNCHANGED_REIMPORT proves: every newer version of the chunk has its exact words, kind and scope, one of them
// active, none missing (a notebook revision that dropped the chunk leaves a gap), and nothing withdrew it: no record tombstone, scope deny, deny mark still standing on the cited version, ended or denied source,
// and no import tombstone on the contents (forget.ts writes those by scope and content hash). S1 moves the receipt's notebook revisions with
// its chunks, and only when every chunk resting on them moved; a receipt with anything else stale is left whole. S2 undoes a revoke only when
// it carries nothing but its own root: no receipt or other node queued, no mark walked, no receipt job naming it (revocation.ts hands a
// batch's receipt hits to its first revoke). Each predicate is re-read inside the writing transaction, so an owner's delete or edit between
// two slices is honoured, and every write is idempotent. Each rewritten receipt is logged for the session proof (a retained session over it
// replays fresh). The walk reads rows in key order, a bounded number per slice and per run (rows examined, not rows matched), with its
// cursors kept in memory-repairs.json after each run (in memory-repairs-selfheal.json while that one cannot be read, never overwriting it):
// a restart carries on where it stopped. The pass is complete once both cursors reached
// the ends taken at its start; the flag keeps the memory_records mark of that start, so data a later 1.0.20 (a rollback) left stuck is walked
// again at the next start.
import { anchorRevokesSql, evidenceRevokesSql } from "./deny-rule.ts";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "../counted-fs.ts";
import { beginBackground, FOREGROUND_GATE_MAX_MS, isDatabaseBusy } from "../db-busy.ts";
import { ioBudget } from "../io-budget.ts";
import { MEMORY_REPAIRS_FILE, raceCeiling } from "./keepall-unwedge.ts";
import { DENIED_SOURCE } from "./deny.ts";
import { REVOCATION_JOB_SUBJECT } from "./memory-revocation.ts";
import { undoRevoke } from "./revoke-commit.ts";
import { foldRefusesUndo } from "./revoke-marker.ts";

export const SELFHEAL_1021 = "selfheal1021";
/** Per run: receipt rows and job rows examined (matched or not), rows per read, one slice's time. Past a bound the run ends "bounded"; its
 * cursors are kept, and the next run (after `restMs` in the same process, else at the next start) carries on. */
export interface SelfHealLimits { receipts: number; jobs: number; sliceRows: number; sliceMs: number }
export const SELFHEAL_LIMITS: Readonly<SelfHealLimits> = Object.freeze({ receipts: 4096, jobs: 1024, sliceRows: 32, sliceMs: 20 });
/** A receipt citing more than this is left to the fences (deny-read.ts walks at most RECEIPT_ANCHORS). */
const RECEIPT_REFS_MAX = 256;

/** A deny mark that still stands: its revoke is not being (or was not) undone. ?3: the revoke judged, whose own marks do not count. */
const STANDING = "k.revoke_id IS NOT ?3 AND (kj.revoke_id IS NULL OR kj.state NOT IN ('undoing','undone'))";
/** (1.0.23: an explicit row, or the deny rule's rows under the same revoke ids, deny-rule.ts: a source's anchor line, a record's evidence) */
const STANDING_MARK = (kind: "record" | "source", id: string, version: string) => `(EXISTS (SELECT 1 FROM memory_deny_object k LEFT JOIN memory_revoke_jobs kj ON kj.revoke_id=k.revoke_id
    WHERE k.kind='${kind}' AND k.id=${id} AND k.version IN (0,${version}) AND ${STANDING})
  OR EXISTS (SELECT 1 FROM (${kind === "source" ? anchorRevokesSql(id) : evidenceRevokesSql(id, version)}) k LEFT JOIN memory_revoke_jobs kj ON kj.revoke_id=k.revoke_id WHERE ${STANDING}))`;
/** The active version of record (?1, version ?2) when that version is an import chunk superseded only by versions with its exact words,
 * kind and scope (exactly one of them active), with no version missing between them (import.ts writes a chunk at the notebook revision, so a
 * gap is a revision that dropped it: the words came back, they were not kept), and nothing withdrew it: no tombstone on the record (any revision), no deny on its scope, no
 * standing deny mark on the record (whole or this version) other than revoke ?3's, and every evidence source of it and of the target active,
 * not denied, without a standing mark or a source tombstone, and no import tombstone on its scope for its contents (forget.ts: by scope
 * and content hash, the cited revisions' and the current one). No row otherwise. */
const UNCHANGED_REIMPORT = `SELECT n.version AS target FROM memory_records o JOIN memory_records n ON n.id=o.id AND n.version>o.version AND n.state='active'
  WHERE o.id=?1 AND o.version=?2 AND o.state='superseded' AND o.kind='evidence' AND o.assertion='unverified-import'
  AND (SELECT count(*) FROM memory_records a WHERE a.id=o.id AND a.state='active')=1
  AND NOT EXISTS (SELECT 1 FROM memory_records m WHERE m.id=o.id AND m.version>o.version
    AND (m.text IS NOT o.text OR m.kind IS NOT o.kind OR m.scope_id IS NOT o.scope_id OR m.state NOT IN ('active','superseded')))
  AND (SELECT count(*) FROM memory_records g WHERE g.id=o.id AND g.version>o.version)=(SELECT max(g.version) FROM memory_records g WHERE g.id=o.id)-o.version
  AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=o.id)
  AND NOT EXISTS (SELECT 1 FROM memory_deny d WHERE d.kind='scope' AND d.id=o.scope_id)
  AND NOT ${STANDING_MARK("record", "o.id", "o.version")}
  AND EXISTS (SELECT 1 FROM memory_evidence e WHERE e.record_id=o.id AND e.record_version=o.version)
  AND EXISTS (SELECT 1 FROM memory_evidence e WHERE e.record_id=n.id AND e.record_version=n.version)
  AND NOT EXISTS (SELECT 1 FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id LEFT JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
    WHERE e.record_id=o.id AND e.record_version IN (o.version,n.version)
    AND (s.id IS NULL OR s.state IS NOT 'active' OR v.source_id IS NULL OR ${DENIED_SOURCE("s")}
      OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type IN ('source','import') AND t.target_id=e.source_id)
      OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='import' AND t.target_id=s.scope_id AND t.content_hash IN (v.content_hash,s.content_hash))
      OR ${STANDING_MARK("source", "e.source_id", "e.source_revision")}))`;
/** Whether revoke ?1 (root: record ?2 version ?3) carries nothing but that root: no node queued but the root's (the marker keeps its own
 * encoding of the version), no line, range or session mark,
 * no deny mark on anything else, and no receipt job that will hand it more receipts (memory-revocation.ts job.revokeId). */
const ROOT_ONLY = `SELECT NOT EXISTS (SELECT 1 FROM memory_revoke_frontier f WHERE f.revoke_id=?1 AND f.seq>0
      AND (NOT json_valid(f.node) OR json_extract(f.node,'$.kind') IS NOT 'record' OR json_extract(f.node,'$.id') IS NOT ?2))
  AND NOT EXISTS (SELECT 1 FROM memory_deny_point WHERE revoke_id=?1) AND NOT EXISTS (SELECT 1 FROM memory_deny_range WHERE revoke_id=?1)
  AND NOT EXISTS (SELECT 1 FROM memory_deny_session WHERE revoke_id=?1)
  AND NOT EXISTS (SELECT 1 FROM memory_deny_object WHERE revoke_id=?1 AND NOT (kind='record' AND id=?2 AND version=?3))
  AND NOT EXISTS (SELECT 1 FROM memory_scope_bindings b WHERE b.subject_id='${REVOCATION_JOB_SUBJECT}' AND json_valid(b.intent) AND json_extract(b.intent,'$.revokeId')=?1) AS ok`;

export interface SelfHealCounts { receiptsScanned: number; receiptsRepointed: number; refsRepointed: number; jobsScanned: number; jobsUndone: number; jobsKept: number }
type Ref = Record<string, unknown>;
const parseList = (text: unknown): Ref[] | null => { try { const v = JSON.parse(String(text)); return Array.isArray(v) ? v : null; } catch { return null; } };
const versionOf = (v: unknown) => (Number.isSafeInteger(v) && Number(v) >= 1 ? Number(v) : null);

/** The session proof's change log, when the file has it: a rewritten receipt is a change a retained check must see (session-proof.ts reads
 * `receipt:` as relevant for its session and replays fresh). */
export function logReceiptRewrite(db: DatabaseSync, bundleId: string): void {
  if (db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='memory_session_change_log'").get())
    db.prepare("INSERT INTO memory_session_change_log(id) VALUES(?)").run(`receipt:${bundleId}`);
}

/** The receipt's lists with every stale reference repaired, or null when anything stale is not provably the same words (left whole). */
function repairedLists(db: DatabaseSync, recordsText: unknown, sourcesText: unknown, target: (id: string, v: number) => number | null): { records: Ref[]; sources: Ref[]; moved: number } | null {
  const records = parseList(recordsText), sources = parseList(sourcesText);
  if (!records || !sources || records.length + sources.length > RECEIPT_REFS_MAX) return null;
  const state = db.prepare("SELECT state,kind,assertion FROM memory_records WHERE id=? AND version=?");
  const moves = new Map<string, { from: number; to: number }>();
  const outRecords: Ref[] = [], seen = new Set<string>();
  for (const record of records) {
    const v = record && typeof record.id === "string" ? versionOf(record.version) : null;
    if (v === null) return null;
    const id = String(record.id), row = state.get(id, v);
    let out = record;
    if (row?.state !== "active") {
      const to = row?.state === "superseded" && row.kind === "evidence" && row.assertion === "unverified-import" ? target(id, v) : null;
      if (to === null) return null;
      out = { ...record, version: to }; moves.set(`${id}\u0000${v}`, { from: v, to });
    }
    const key = `${id}\u0000${String(out.version)}`;
    if (!seen.has(key)) { seen.add(key); outRecords.push(out); }
  }
  if (!moves.size) return null;
  // A notebook revision the receipt names beside its chunks moves to the source's current revision only when every cited chunk version
  // resting on it moved and its target rests on that current revision (the evidence says which); one resting on nothing cited stays.
  const current = db.prepare("SELECT revision FROM memory_sources WHERE id=?");
  const resting = db.prepare("SELECT 1 AS x FROM memory_evidence WHERE record_id=? AND record_version=? AND source_id=? AND source_revision=? LIMIT 1");
  const restsOn = (sourceId: string, revision: number, id: string, v: number) => Boolean(resting.get(id, v, sourceId, revision));
  const outSources: Ref[] = [], seenSources = new Set<string>();
  for (const source of sources) {
    const r = source && typeof source.id === "string" ? versionOf(source.revision) : null;
    if (r === null) return null;
    const id = String(source.id), now = current.get(id)?.revision;
    let out = source;
    if (Number(now) !== r) {
      if (!versionOf(now)) return null;
      let rested = 0;
      for (const record of records) {
        const v = Number(record.version), move = moves.get(`${String(record.id)}\u0000${v}`);
        if (!restsOn(id, r, String(record.id), v)) continue;
        if (!move || !restsOn(id, Number(now), String(record.id), move.to)) return null;
        rested++;
      }
      if (!rested) return null;
      out = { ...source, revision: Number(now) };
    }
    const key = `${id}\u0000${String(out.revision)}`;
    if (!seenSources.has(key)) { seenSources.add(key); outSources.push(out); }
  }
  return { records: outRecords, sources: outSources, moved: moves.size };
}

/** Up to `rows` receipts after rowid `after` (key order, every row counted), inside the caller's transaction, stopping early at `until`.
 * Each live receipt whose stale references are all provably unchanged is rewritten (compare-and-set on what was read) and logged. */
export function healReceiptsSlice(db: DatabaseSync, after: number, rows: number, counts: SelfHealCounts, until: () => boolean = () => false): { after: number; exhausted: boolean } {
  const unchanged = db.prepare(UNCHANGED_REIMPORT), memo = new Map<string, number | null>();
  const target = (id: string, v: number) => {
    const key = `${id}\u0000${v}`;
    if (!memo.has(key)) { const to = unchanged.get(id, v, null)?.target; memo.set(key, typeof to === "number" && to > v ? to : null); }
    return memo.get(key)!;
  };
  const update = db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE rowid=? AND state IN ('prepared','delivered') AND record_versions=? AND source_versions=?");
  const read = db.prepare("SELECT rowid AS rid,bundle_id,state,record_versions,source_versions FROM memory_disclosures WHERE rowid>? ORDER BY rowid LIMIT ?");
  let cursor = after, n = 0;
  for (const row of read.all(after, rows)) {
    n++; counts.receiptsScanned++; cursor = Number(row.rid);
    if (row.state === "prepared" || row.state === "delivered") {
      const next = repairedLists(db, row.record_versions, row.source_versions, target);
      if (next && Number(update.run(JSON.stringify(next.records), JSON.stringify(next.sources), cursor, String(row.record_versions), String(row.source_versions)).changes)) {
        logReceiptRewrite(db, String(row.bundle_id));
        counts.receiptsRepointed++; counts.refsRepointed += next.moved;
      }
    }
    if (until()) return { after: cursor, exhausted: false };
  }
  return { after: cursor, exhausted: n < rows };
}
/** Up to `rows` revoke jobs after `after` (key order, every row counted). An active write-time revoke of one unchanged chunk version that
 * carries nothing but that root is undone through the owner Undo. */
export function healJobsSlice(db: DatabaseSync, after: number, rows: number, counts: SelfHealCounts, until: () => boolean = () => false): { after: number; exhausted: boolean } {
  const unchanged = db.prepare(UNCHANGED_REIMPORT), rootOnly = db.prepare(ROOT_ONLY);
  const read = db.prepare("SELECT revoke_id,kind,state,root FROM memory_revoke_jobs WHERE revoke_id>? ORDER BY revoke_id LIMIT ?");
  let cursor = after, n = 0;
  for (const row of read.all(after, rows)) {
    n++; counts.jobsScanned++; cursor = Number(row.revoke_id);
    let root: { kind?: unknown; cause?: unknown; ref?: { kind?: unknown; id?: unknown; version?: unknown } } | null = null;
    if (row.state === "active" && row.kind === "memory") { try { root = JSON.parse(String(row.root)); } catch { root = null; } }
    const id = root?.ref?.id, v = versionOf(root?.ref?.version);
    if (root?.kind === "memory" && root.cause === "revise" && root.ref?.kind === "record" && typeof id === "string" && v !== null
      && unchanged.get(id, v, cursor) && Number(rootOnly.get(cursor, id, v)?.ok) === 1 && !foldRefusesUndo(db, cursor)) { undoRevoke(db, cursor); counts.jobsUndone++; }
    else if (row.state === "active") counts.jobsKept++;
    if (until()) return { after: cursor, exhausted: false };
  }
  return { after: cursor, exhausted: n < rows };
}

function installationId(db: DatabaseSync): string | null {
  try { const id = db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()?.installation_id; return typeof id === "string" ? id : null; }
  catch { return null; }
}
/** Where a pass's cursors go while memory-repairs.json cannot be read: that file is never overwritten (the other repairs' flags in it are
 * not lost), and a pass that kept no cursors would start from zero at every run and never end. */
export const SELFHEAL_SIDE_FILE = "memory-repairs-selfheal.json";
/** A JSON object file: {} when absent, null when it exists but cannot be read. */
function readObject(file: string): Record<string, unknown> | null {
  try { if (!existsSync(file)) return {}; const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
  catch { return null; }
}
const readRepairs = (dataDir: string) => readObject(join(dataDir, MEMORY_REPAIRS_FILE));
/** What memory-repairs.json keeps for this file: a pass in progress (its cursors and the ends and records mark taken at its start), or done. */
interface HealState { installationId: string; done: boolean; records: number; receipts: number; jobs: number; receiptsEnd: number; jobsEnd: number; at?: number }
/** This file's state from memory-repairs.json, else from the side file (written while memory-repairs.json could not be read). */
function readState(db: DatabaseSync, dataDir: string): HealState | null {
  const id = installationId(db);
  if (id === null) return null;
  const mine = (v: unknown) => { const raw = v as Partial<HealState> | undefined; return raw && typeof raw === "object" && raw.installationId === id ? raw : undefined; };
  const raw = mine(readRepairs(dataDir)?.[SELFHEAL_1021]) ?? mine(readObject(join(dataDir, SELFHEAL_SIDE_FILE))?.[SELFHEAL_1021]);
  if (!raw) return null;
  const n = (v: unknown) => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : 0);
  return { installationId: id, done: raw.done === true, records: n(raw.records), receipts: n(raw.receipts), jobs: n(raw.jobs), receiptsEnd: n(raw.receiptsEnd), jobsEnd: n(raw.jobsEnd) };
}
/** Written beside the target and renamed over it; the temp's name (`<name>.<pid>.<uuid>.tmp`) is a classified leftover
 * (data-dir-inventory.ts), so a start stopped before the rename never leaves a name that stops a backup. */
function writeState(dataDir: string, state: HealState): void {
  const repairs = readRepairs(dataDir);
  const file = join(dataDir, repairs === null ? SELFHEAL_SIDE_FILE : MEMORY_REPAIRS_FILE), tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...repairs, [SELFHEAL_1021]: { ...state, at: Date.now() } }));
  renameSync(tmp, file);
}
const maxKey = (db: DatabaseSync, sql: string) => Number(db.prepare(sql).get()?.m ?? 0);
/** Import chunk versions written after the records mark (a re-import since, e.g. by 1.0.20 after a rollback): a new pass is due. */
const importedSince = (db: DatabaseSync, mark: number) => Boolean(db.prepare("SELECT 1 AS x FROM memory_records WHERE rowid>? AND kind='evidence' AND assertion='unverified-import' AND version>1 LIMIT 1").get(mark));
/** Whether this memory file was healed and nothing was re-imported since. */
export function selfHealed1021(db: DatabaseSync, dataDir: string): boolean {
  const state = readState(db, dataDir);
  return Boolean(state?.done) && !importedSince(db, state!.records);
}
const hasTables = (db: DatabaseSync) => ["memory_disclosures", "memory_records", "memory_revoke_jobs", "memory_evidence", "memory_tombstones", "memory_deny", "memory_sources", "memory_source_versions", "memory_scope_bindings"]
  .every(name => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name)));

export type SelfHealOutcome = "healed" | "bounded" | "gave-up" | "stopped" | "already";
export interface SelfHealDeps {
  limits?: Partial<SelfHealLimits>;
  begin?: (db: DatabaseSync, op: string) => void;
  /** Between slices: the next task, the writer gate, the owner's turns. False ends the run ("stopped"; the cursors are kept). */
  yieldSlice?: () => Promise<boolean>;
  /** Set: a bounded run is followed by the next after this rest, in the same process, until the pass ends. Unset: the next start carries on. */
  restMs?: number;
  /** Called once, when the first run ends (the turn admission's courtesy wait). */
  onFirstRun?: (outcome: SelfHealOutcome) => void;
  /** Held-lock attempts before the run gives up (the next start carries on). */
  attempts?: number;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Test seam: runs inside each slice's transaction, after its writes. */
  onSlice?: (db: DatabaseSync) => void;
}

/** The turn admission's courtesy wait (index.ts): the first admission waits for the first run, once, at most FOREGROUND_GATE_MAX_MS, so a
 * turn sent right after start meets the healed state; later admissions never wait (a step that never ran cannot hold every turn). */
export function createSelfHealGate() {
  let pending = true, done: () => void = () => {};
  const first = new Promise<void>(resolve => { done = resolve; });
  return {
    first,
    firstRunEnded(): void { pending = false; done(); },
    async barrier(ms = FOREGROUND_GATE_MAX_MS): Promise<void> { if (!pending) return; pending = false; await raceCeiling(first, ms); },
  };
}

/** The after-listen step: never throws, always resolves (with the last run's outcome). */
export function startSelfHeal1021(db: DatabaseSync, dataDir: string, deps: SelfHealDeps = {}): Promise<SelfHealOutcome> {
  const warn = deps.warn ?? console.warn;
  let first = deps.onFirstRun;
  const ended = (outcome: SelfHealOutcome) => { const f = first; first = undefined; f?.(outcome); return outcome; };
  const once = () => {
    let run: Promise<SelfHealOutcome>;
    try { run = ioBudget.withSource("startup", () => runSelfHeal(db, dataDir, deps)); }
    catch (error) { run = Promise.reject(error); }
    return run.catch(error => { warn(`[memory] 1.0.21 self-heal: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); return "gave-up" as const; });
  };
  return (async () => {
    for (;;) {
      const outcome = ended(await once());
      if (outcome !== "bounded" || deps.restMs === undefined) return outcome;
      await new Promise<void>(resolve => { const t = setTimeout(resolve, deps.restMs); t.unref?.(); });
      if (deps.yieldSlice && !await deps.yieldSlice()) return "stopped";
    }
  })();
}

async function runSelfHeal(db: DatabaseSync, dataDir: string, deps: SelfHealDeps): Promise<SelfHealOutcome> {
  if (!hasTables(db) || installationId(db) === null) return "already";
  const kept = readState(db, dataDir);
  if (kept?.done && !importedSince(db, kept.records)) return "already";
  // a pass in progress carries on from its cursors; otherwise a new one, its ends and records mark taken now (rows after them are newer than
  // the pass: a re-import meanwhile moves the records mark on and the next start walks again)
  const state: HealState = kept && !kept.done ? kept : {
    installationId: installationId(db)!, done: false, receipts: 0, jobs: 0,
    records: maxKey(db, "SELECT max(rowid) AS m FROM memory_records"),
    receiptsEnd: maxKey(db, "SELECT max(rowid) AS m FROM memory_disclosures"), jobsEnd: maxKey(db, "SELECT max(revoke_id) AS m FROM memory_revoke_jobs"),
  };
  const limits = { ...SELFHEAL_LIMITS, ...deps.limits };
  const begin = deps.begin ?? beginBackground, now = deps.now ?? (() => performance.now());
  const yieldSlice = deps.yieldSlice ?? (() => new Promise<boolean>(resolve => setImmediate(() => resolve(true))));
  let attempts = deps.attempts ?? 5;
  const counts: SelfHealCounts = { receiptsScanned: 0, receiptsRepointed: 0, refsRepointed: 0, jobsScanned: 0, jobsUndone: 0, jobsKept: 0 };
  // S2 first (the windows it retires are what holds resumed sessions, and S1 reads its undone marks as no longer standing), then S1
  const jobsDone = () => state.jobs >= state.jobsEnd, receiptsDone = () => state.receipts >= state.receiptsEnd;
  const spent = () => (jobsDone() ? counts.receiptsScanned >= limits.receipts : counts.jobsScanned >= limits.jobs);
  const line = () => `[memory] 1.0.21 self-heal: receipts re-pointed=${counts.receiptsRepointed} refs=${counts.refsRepointed} scanned=${counts.receiptsScanned} revokes undone=${counts.jobsUndone} kept=${counts.jobsKept} scanned=${counts.jobsScanned}`;
  try {
    while (!(jobsDone() && receiptsDone())) {
      if (spent()) { writeState(dataDir, state); (deps.log ?? console.log)(`${line()} bounded; it carries on`); return "bounded"; }
      if (!await yieldSlice()) { writeState(dataDir, state); return "stopped"; }
      const start = now(), before = { ...counts }, at = { jobs: state.jobs, receipts: state.receipts };
      const late = () => now() - start >= limits.sliceMs;
      try {
        begin(db, "selfheal-1021");
        try {
          // rows read in key order, every row counted; the clock is read after every row, so one slice holds the writer about sliceMs
          while (!(jobsDone() && receiptsDone()) && !spent() && !late()) {
            if (!jobsDone()) {
              const r = healJobsSlice(db, state.jobs, Math.min(limits.sliceRows, limits.jobs - counts.jobsScanned), counts, late);
              state.jobs = r.exhausted ? Math.max(r.after, state.jobsEnd) : Math.min(r.after, state.jobsEnd);
            } else {
              const r = healReceiptsSlice(db, state.receipts, Math.min(limits.sliceRows, limits.receipts - counts.receiptsScanned), counts, late);
              state.receipts = r.exhausted ? Math.max(r.after, state.receiptsEnd) : Math.min(r.after, state.receiptsEnd);
            }
          }
          deps.onSlice?.(db);
          db.exec("COMMIT");
        } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } } throw error; }
      } catch (error) {
        // rolled back: the slice's counters and cursors are not kept
        Object.assign(counts, before); state.jobs = at.jobs; state.receipts = at.receipts;
        if (isDatabaseBusy(error) && --attempts > 0) continue;
        throw error;
      }
    }
  } catch (error) { try { writeState(dataDir, state); } catch { /* the next start walks again from the last kept cursors */ } throw error; }
  writeState(dataDir, { ...state, done: true });
  (deps.log ?? console.log)(line());
  return "healed";
}
