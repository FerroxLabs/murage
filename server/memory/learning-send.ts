// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning send gate (designs/MEM-LEARNING-FENCE-R8.md, phase 1). A learning call reads memory words and may then wait in a queue.
// Its one gate decides, under the database write lock and with no await before the bytes leave, whether those words may still be sent:
// nothing that removes or changes them (a Forget, a delete, an owner edit, a scrub, a policy, roster or learning withdrawal) may have
// committed since they were read. A call still waiting is dropped unsent; a call the gate released is out of our hands (forget.ts:83).
//
// The fence counter is a TEMP table on the main connection moved by TEMP triggers, independent of deletion_epoch. Another connection's
// commit moves PRAGMA data_version, which the gate checks too. 1.0.22 (mem-strict): a gate that names the rows it read (HeldRefs) is
// fenced on THOSE rows only. When the counter or data_version moved, it re-reads its own rows under the lock and is refused only when one
// of them changed, or when a withdrawal (policy, mode, learning settings, a binding, a roster bump) moved the separate `withdrawal`
// counter or, for another connection's commit, the withdrawal stamp. An unrelated write never drops it. A gate with no refs keeps the
// global fence: it has no row list to re-check. `send` holds BEGIN IMMEDIATE from the check through the release and the
// write, so no other connection can commit in between. Busy waits at most BACKGROUND_BUSY_MS and defers the call (released unchanged).
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { connectionId, database } from "../database.ts";
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS, isDatabaseBusy, noteBusy, setBusy } from "../db-busy.ts";
import { releaseTransaction, assertReleaseContext, joinReleaseTransaction, ReleaseCommitFailed, type ReleaseContext } from "./release-transaction.ts";
import { noteIdentityEpoch } from "./provenance-stamp.ts";
import { bumpLearningFence } from "./authority-epoch.ts";
import { NOISY_SYSTEM_SUBJECTS } from "./noisy-subjects.ts";
import { memoryLookup } from "./deny-read.ts";
import { MemorySendFenced } from "./learning-send-fence.ts";

/** The lock was held by another connection past the background budget: nothing was released, the call is deferred, not dropped. */
export const MEMORY_SEND_BUSY = "MEMORY_SEND_BUSY";
export class MemorySendBusy extends Error {
  constructor() { super(MEMORY_SEND_BUSY); this.name = "memory-send-busy"; }
}
export const isMemorySendBusy = (error: unknown): boolean =>
  error instanceof MemorySendBusy || (error as { message?: unknown } | null)?.message === MEMORY_SEND_BUSY;
/** COMMIT failed after the gate released the call: the bytes may have left, so this attempt counts as released (never unsent). */
export class MemorySendCommitFailed extends ReleaseCommitFailed {
  constructor() { super(); this.message = "MEMORY_SEND_COMMIT_FAILED"; this.name = "memory-send-commit-failed"; }
}

// ---------------------------------------------------------------------------------------------------------------- counter (§3)
/** Accounting-only bindings that carry no memory words: the noisy system subjects, plus the procedure evaluator's charge binding, written
 * inside its own reservation (procedure-evaluator.ts:103) so an unchanged procedure lease never fences itself. */
export const LEARNING_FENCE_QUIET_SUBJECTS: readonly string[] = [...NOISY_SYSTEM_SUBJECTS, "procedure-evaluation-charges"];
const QUIET = (row: "NEW" | "OLD") => `${row}.subject_type='system' AND ${row}.subject_id IN (${LEARNING_FENCE_QUIET_SUBJECTS.map(s => `'${s}'`).join(",")})`;
/** r9 (designs/MEM-LEARNING-FENCE-R9.md): GEPA's own accounting writes, exempt by EXACT statement name, never by a subject pattern. Each
 * name is one fixed SQL text on memory_scope_bindings; `accountingWrite` runs exactly that statement with temp `quiet` set to its name.
 * The triggers skip the bump only for a granted system row whose id, scope, subject and revision do not change (only `intent` moves), so
 * a quiet write cannot revoke or remove a grant. Only gepa-ledger.ts `save` and gepa-evaluator.ts's 3 charge writes call it. */
const GEPA_UPSERT = "INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent WHERE memory_scope_bindings.subject_type='system' AND memory_scope_bindings.subject_id=excluded.subject_id AND memory_scope_bindings.scope_id=excluded.scope_id";
const GEPA_CHARGE_UPDATE = "UPDATE memory_scope_bindings SET intent=? WHERE id=? AND subject_type='system' AND subject_id=?";
export const LEARNING_FENCE_ACCOUNTING = Object.freeze({
  "gepa-ledger.call-save": GEPA_UPSERT,
  "gepa-evaluator.charge-reserve": GEPA_UPSERT,
  "gepa-evaluator.charge-release": GEPA_CHARGE_UPDATE,
  "gepa-evaluator.charge-settle": GEPA_CHARGE_UPDATE,
} as const);
export type LearningFenceAccountingName = keyof typeof LEARNING_FENCE_ACCOUNTING;
/** The one subject each name may write (GrokBuild r9 H): `gepa-job:` or `gepa-charges:` plus a sha256, checked exactly in JS before the
 * flag is set and stored on the fence row; the triggers require the written row's subject to equal it, so a write that touches any other
 * row (the owner's settings, a procedure grant) under the flag still moves the counter. */
const ACCOUNTING_SUBJECT: Readonly<Record<LearningFenceAccountingName, string>> = {
  "gepa-ledger.call-save": "gepa-job:", "gepa-evaluator.charge-reserve": "gepa-charges:", "gepa-evaluator.charge-release": "gepa-charges:", "gepa-evaluator.charge-settle": "gepa-charges:",
};
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ACCOUNTING = `(SELECT quiet FROM temp.memory_learning_fence WHERE id=1) IN (${Object.keys(LEARNING_FENCE_ACCOUNTING).map(n => `'${n}'`).join(",")}) AND NEW.subject_id IS (SELECT quiet_subject FROM temp.memory_learning_fence WHERE id=1)`;
const ACCT_INSERT = `${ACCOUNTING} AND NEW.subject_type='system' AND NEW.state='granted'`;
const ACCT_UPDATE = `${ACCOUNTING} AND NEW.subject_type='system' AND OLD.subject_type='system' AND NEW.state='granted' AND OLD.state='granted' AND NEW.id IS OLD.id AND NEW.scope_id IS OLD.scope_id AND NEW.subject_id IS OLD.subject_id AND NEW.revision IS OLD.revision`;
/** r10.1 (designs/MEM-LEARNING-FENCE-R10.md): binding writes that cannot change held words, matched by EXACT subject_type (and subject_id
 * where given) plus an allowed transition, never a pattern. `insert`: a new row with state 'granted' is quiet. `update`: quiet only when
 * every listed column is unchanged (subject_type and subject_id always are); null means no UPDATE is quiet. A DELETE is never quiet.
 * Q1 remember-action (authority.ts:387), Q2 human-binding (human-principals.ts save: a new row, or a same-revision display refresh),
 * Q3 human-delivery (:251), Q5 memory-evolution-corpus (evolution-policy.ts:49/:50: a new admission, or an identical-row rewrite). */
export interface LearningFenceQuietBinding { readonly type: string; readonly subject?: string; readonly insert: boolean; readonly update: readonly ("id" | "scope_id" | "revision" | "state" | "intent")[] | null }
export const LEARNING_FENCE_QUIET_BINDINGS: readonly LearningFenceQuietBinding[] = Object.freeze([
  Object.freeze({ type: "system", subject: "remember-action", insert: true, update: null }),
  Object.freeze({ type: "human-binding", insert: true, update: Object.freeze(["id", "scope_id", "revision", "state"] as const) }),
  Object.freeze({ type: "human-delivery", insert: true, update: null }),
  Object.freeze({ type: "system", subject: "memory-evolution-corpus", insert: true, update: Object.freeze(["id", "scope_id", "revision", "state", "intent"] as const) }),
]);
/** 1.0.22 mem-strict r5: a revocation job's queue row (subject `memory-revocation`). A Forget whose inline budget runs out writes it in the
 * Forget's own commit (memory-revocation.ts startRevocationJob) and the runner removes it when the job ends; it grants and withdraws
 * nothing, so writing or removing it moves the epoch, never the withdrawal counter (which no held-row re-check could ever clear). */
const REVOCATION_JOB = (row: "NEW" | "OLD" | "b") => `(${row}.subject_type='system' AND ${row}.subject_id='memory-revocation')`;
/** r6: the runner's in-place rewrite of that row (memory-revocation.ts stepJobRow `SET intent=?,state=...`): the same row id and scope, a
 * job row before and after. On this connection a row moved into or out of the job subject, or to another scope, is not this and still
 * withdraws; another connection's commit is judged by the stamp below, which leaves out every row whose current subject is the job's. */
const REVOCATION_JOB_REWRITE = `(${REVOCATION_JOB("NEW")} AND ${REVOCATION_JOB("OLD")} AND NEW.id IS OLD.id AND NEW.scope_id IS OLD.scope_id)`;
const LITERAL = /^[a-z][a-z-]*$/;
const lit = (value: string) => { if (!LITERAL.test(value)) throw new Error("LEARNING_FENCE_QUIET_LITERAL"); return `'${value}'`; };
const QUIET_BINDING_INSERT = LEARNING_FENCE_QUIET_BINDINGS.filter(q => q.insert).map(q =>
  `(NEW.subject_type IS ${lit(q.type)}${q.subject ? ` AND NEW.subject_id IS ${lit(q.subject)}` : ""} AND NEW.state IS 'granted')`).join(" OR ") || "0";
const QUIET_BINDING_UPDATE = LEARNING_FENCE_QUIET_BINDINGS.filter(q => q.update).map(q =>
  `(NEW.subject_type IS ${lit(q.type)} AND OLD.subject_type IS ${lit(q.type)}${q.subject ? ` AND NEW.subject_id IS ${lit(q.subject)}` : ""} AND NEW.subject_id IS OLD.subject_id${q.update!.map(c => ` AND NEW.${c} IS OLD.${c}`).join("")})`).join(" OR ") || "0";
const BUMP = "UPDATE memory_learning_fence SET epoch=epoch+1 WHERE id=1";
/** A withdrawal moves both counters: a gate with held refs still refuses on it, whatever rows it holds. */
const BUMP_WITHDRAWAL = "UPDATE memory_learning_fence SET epoch=epoch+1, withdrawal=withdrawal+1 WHERE id=1";
const trig = (name: string, event: string, table: string, when?: string, bump = BUMP) =>
  ({ name: `learning_fence_${name}`, sql: `CREATE TEMP TRIGGER IF NOT EXISTS learning_fence_${name} AFTER ${event} ON main.${table}${when ? ` WHEN ${when}` : ""} BEGIN ${bump}; END;` });
const all = (table: string, events: readonly string[] = ["INSERT", "UPDATE", "DELETE"], bump = BUMP) =>
  events.map(event => trig(`${table}_${event[0]!.toLowerCase()}`, event, table, undefined, bump));
const TRIGGER_DEFS = [
  ...all("memory_tombstones"), ...all("memory_deny"), ...all("memory_deny_line"), ...all("memory_deny_range"),
  // a Forget (forget.ts: deletion_epoch and policy_revision in one statement, plus its tombstone) is a row change: held refs re-check their own
  // rows through memoryLookup, which also withholds what rests on a forgotten row. A policy bump with no deletion, or a mode change, withdraws.
  trig("memory_meta_u", "UPDATE", "memory_meta", "OLD.deletion_epoch IS NOT NEW.deletion_epoch AND OLD.mode IS NEW.mode"),
  trig("memory_meta_w", "UPDATE", "memory_meta", "OLD.mode IS NOT NEW.mode OR (OLD.policy_revision IS NOT NEW.policy_revision AND OLD.deletion_epoch IS NEW.deletion_epoch)", BUMP_WITHDRAWAL),
  trig("bindings_i", "INSERT", "memory_scope_bindings", `NOT (${QUIET("NEW")}) AND NOT (${ACCT_INSERT}) AND NOT (${QUIET_BINDING_INSERT}) AND NOT (${REVOCATION_JOB("NEW")})`, BUMP_WITHDRAWAL),
  trig("bindings_u", "UPDATE", "memory_scope_bindings", `(NOT (${QUIET("NEW")}) OR NOT (${QUIET("OLD")})) AND NOT (${ACCT_UPDATE}) AND NOT (${QUIET_BINDING_UPDATE}) AND NOT ${REVOCATION_JOB_REWRITE}`, BUMP_WITHDRAWAL),
  trig("bindings_d", "DELETE", "memory_scope_bindings", `NOT (${QUIET("OLD")}) AND NOT (${REVOCATION_JOB("OLD")})`, BUMP_WITHDRAWAL),
  // a Forget's revocation job row (memory-revocation.ts createRevocationJob) is a deletion in progress, a row change like the Forget itself:
  // held refs re-check their rows (memoryLookup reads the job's pending window as "checking" until the marker resolves it), an unscoped
  // gate still refuses on the epoch. r6: the runner's bounded-slice rewrite of the row in place moves the epoch only, too.
  trig("bindings_job_i", "INSERT", "memory_scope_bindings", REVOCATION_JOB("NEW")),
  trig("bindings_job_u", "UPDATE", "memory_scope_bindings", REVOCATION_JOB_REWRITE),
  trig("bindings_job_d", "DELETE", "memory_scope_bindings", REVOCATION_JOB("OLD")),
  ...all("memory_learning_config", ["INSERT", "UPDATE"], BUMP_WITHDRAWAL),
  ...all("memory_sources", ["DELETE"]), ...all("memory_records", ["DELETE"]), ...all("memory_source_versions", ["DELETE"]), ...all("messages", ["DELETE"]),
];
/** Every trigger the counter rests on; `check` fails closed when any one is missing from temp.sqlite_master. */
export const LEARNING_FENCE_TRIGGERS: readonly string[] = TRIGGER_DEFS.map(t => t.name);
const installed = new WeakMap<object, boolean>();

/** Installs the counter on `db` (outside a transaction). False when any part could not be installed: every check then fails closed. */
export function installLearningFence(db: DatabaseSync = database()): boolean {
  if (installed.get(db) && fenceIntact(db)) return true;
  if (db.isTransaction) return false;
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS memory_learning_fence(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, token TEXT NOT NULL, quiet TEXT, quiet_subject TEXT, withdrawal INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT OR IGNORE INTO temp.memory_learning_fence(id,epoch,token) VALUES(1,0,?)").run(randomUUID());
    for (const t of TRIGGER_DEFS) db.exec(t.sql);
  } catch { installed.set(db, false); return false; }
  const ok = fenceIntact(db);
  installed.set(db, ok);
  return ok;
}
function fenceIntact(db: DatabaseSync): boolean {
  try {
    // the singleton row too: a dropped table makes install recreate it with a NEW token, so every sample taken before fails on the token
    // `quiet` too (r9): without it the binding triggers cannot run, so every check fails closed
    if (!db.prepare("SELECT 1 AS ok, quiet, quiet_subject, withdrawal FROM temp.memory_learning_fence WHERE id=1").get()) return false;
    const names = new Set(db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'learning_fence_%'").all().map(r => String(r.name)));
    return LEARNING_FENCE_TRIGGERS.every(name => names.has(name));
  } catch { return false; }
}
/** Runs the ONE registered statement `name` with temp `quiet` set to that name, synchronously, and clears it in a finally (r9). An
 * unknown name, or a call while `quiet` is already set, throws. Where the counter is not installed the statement runs unflagged. */
export function accountingWrite(db: DatabaseSync, name: LearningFenceAccountingName, ...params: Array<string | number | null>): { changes: number | bigint } {
  const sql = Object.prototype.hasOwnProperty.call(LEARNING_FENCE_ACCOUNTING, name) ? LEARNING_FENCE_ACCOUNTING[name] : undefined;
  if (!sql) throw new Error("LEARNING_FENCE_ACCOUNTING_UNKNOWN");
  // every registered statement takes its subject as the 3rd parameter
  const subject = params[2], prefix = ACCOUNTING_SUBJECT[name];
  if (typeof subject !== "string" || !subject.startsWith(prefix) || !SHA256_HEX.test(subject.slice(prefix.length))) throw new Error("LEARNING_FENCE_ACCOUNTING_SUBJECT");
  const statement = db.prepare(sql);
  let flagged = false;
  try {
    const row = db.prepare("SELECT quiet FROM temp.memory_learning_fence WHERE id=1").get();
    if (row && row.quiet !== null && row.quiet !== undefined) throw new Error("LEARNING_FENCE_ACCOUNTING_NESTED");
    if (row) { db.prepare("UPDATE temp.memory_learning_fence SET quiet=?,quiet_subject=? WHERE id=1").run(name, subject); flagged = true; }
  } catch (error) { if ((error as Error).message === "LEARNING_FENCE_ACCOUNTING_NESTED") throw error; /* no counter here: unflagged */ }
  try { return statement.run(...params); }
  finally { if (flagged) db.prepare("UPDATE temp.memory_learning_fence SET quiet=NULL,quiet_subject=NULL WHERE id=1").run(); }
}

/** An explicit move for a withdrawal no trigger sees (the roster is a quiet binding): authority-epoch.ts bumpAuthorityHard calls it first,
 * unconditionally. Where the counter is missing it is a no-op; every check fails closed there anyway. */
export { bumpLearningFence };

/** What the counter looked like when the words were read. `undefined` fields mean the sample failed: the gate then refuses. */
export interface LearningFenceSample { epoch: number; token: string; connection: string; dataVersion: number; withdrawal: number; stamp: string | undefined }
/** The withdrawal state as stored, read directly so another connection's commit is seen: policy and mode, the learning settings, and every
 * non-quiet binding row whole (id, scope, subject, revision, state, intent), so a revoke swapped for a grant at the same count and revision
 * still moves it. A new grant moves it too (fail closed). Policy is kept as policy_revision - deletion_epoch: a Forget moves both by one in
 * one statement (forget.ts), which is a row change the held refs judge; a policy bump with no deletion moves it. Undefined when unreadable. */
const BINDING_QUIET = `b.subject_type='system' AND b.subject_id IN (${LEARNING_FENCE_QUIET_SUBJECTS.map(s => `'${s}'`).join(",")})`;
/** r8 (ASTRA f443268f73): a revocation job's queue row is left out of the stamp, as its triggers move the epoch only (above): another
 * connection's runner ending a job (or a Forget writing one) between the sample and the send is a row change the held rows judge, never a
 * withdrawal. Only rows whose CURRENT subject is the job's are left out: a job row turned into a grant adds a line, a grant removed with
 * the job loses one, and both still withdraw. */
const BINDING_JOB = REVOCATION_JOB("b");
const STAMP_SQL = `SELECT (SELECT (policy_revision-deletion_epoch)||':'||mode FROM main.memory_meta WHERE id=1) AS meta,
 (SELECT revision||':'||settings FROM main.memory_learning_config WHERE id=1) AS config,
 (SELECT group_concat(row, char(10)) FROM (SELECT quote(b.id)||','||quote(b.scope_id)||','||quote(b.subject_type)||','||quote(b.subject_id)||','||quote(b.revision)||','||quote(b.state)||','||quote(b.intent) AS row
   FROM main.memory_scope_bindings b WHERE NOT (${BINDING_QUIET}) AND NOT ${BINDING_JOB} ORDER BY b.id)) AS bindings`;
function withdrawalStamp(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare(STAMP_SQL).get();
    return row ? digestOf(`${row.meta ?? "-"}\u0000${row.config ?? "-"}\u0000${row.bindings ?? "-"}`) : undefined;
  } catch { return undefined; }
}
function readCounter(db: DatabaseSync): LearningFenceSample | undefined {
  const row = db.prepare("SELECT (SELECT epoch FROM temp.memory_learning_fence WHERE id=1) AS epoch, (SELECT token FROM temp.memory_learning_fence WHERE id=1) AS token, (SELECT withdrawal FROM temp.memory_learning_fence WHERE id=1) AS withdrawal").get();
  if (!row || row.epoch === null || row.epoch === undefined || typeof row.token !== "string" || row.withdrawal === null || row.withdrawal === undefined) return undefined;
  const stamp = withdrawalStamp(db);
  // data_version last: nothing between this read and the gate's next step awaits
  const version = db.prepare("PRAGMA data_version").get();
  return { epoch: Number(row.epoch), token: row.token, connection: connectionId(db), dataVersion: Number(version?.data_version), withdrawal: Number(row.withdrawal), stamp };
}
/** Samples the counter before the call reads its words. Outside a transaction only; undefined (fail closed) otherwise. */
export function sampleLearningFence(): LearningFenceSample | undefined {
  try {
    const db = database();
    if (!installLearningFence(db)) return undefined;
    return readCounter(db);
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------------------------- held refs (§2, phase 1)
export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface HeldRecord { id: string; version: number; digest?: string }
export interface HeldSource { id: string; revision: number; digest?: string }
export interface HeldRefs { records?: ReadonlyArray<HeldRecord>; sources?: ReadonlyArray<HeldSource> }
/** Each held record is still the latest version, active or candidate, not tombstoned, and holds the same bytes; each held source the same
 * revision, active, not tombstoned, with the same payload bytes at that revision. A scrub or in-place rewrite moves the digest. */
export function heldRefsCurrent(db: DatabaseSync, refs: HeldRefs): boolean {
  // each statement is prepared once per check, not once per ref (PIP-PERF: the window holds up to WINDOW_MAX_SOURCES sources)
  const records = refs.records ?? [], heldSources = refs.sources ?? [];
  if (records.length) {
    const recordRow = db.prepare("SELECT r.state,r.text,(SELECT max(version) FROM memory_records WHERE id=r.id) AS latest FROM memory_records r WHERE r.id=? AND r.version=?");
    const recordTomb = db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1");
    for (const ref of records) {
      const row = recordRow.get(ref.id, ref.version);
      if (!row || Number(row.latest) !== ref.version || (row.state !== "active" && row.state !== "candidate")) return false;
      if (ref.digest !== undefined && digestOf(String(row.text)) !== ref.digest) return false;
      if (recordTomb.get(ref.id, ref.version)) return false;
    }
  }
  if (!heldSources.length) return true;
  // the current verdict of every held source, read in one batched statement per 500 refs (deny-read.ts batchSources)
  const sources=heldSources.map(ref=>({kind:"source" as const,id:ref.id,version:ref.revision}));
  for(const verdict of memoryLookup(db,sources,{audience:null,ownFlag:true}).values())if(verdict.state!=="shown")return false;
  const sourceRow = db.prepare("SELECT s.revision,s.state,v.payload FROM memory_sources s LEFT JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?");
  const sourceTomb = db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1");
  for (const ref of heldSources) {
    const row = sourceRow.get(ref.id);
    if (!row || Number(row.revision) !== ref.revision || row.state !== "active") return false;
    if (ref.digest !== undefined && (row.payload === null || digestOf(String(row.payload)) !== ref.digest)) return false;
    if (sourceTomb.get(ref.id, ref.revision)) return false;
  }
  return true;
}
/** The scoped re-check's record verdicts (deny-read.ts memoryLookup): a deny mark on a held record (memory_deny_memory, which no fence
 * trigger watches) refuses the call as a tombstone does. Sources are already judged so in heldRefsCurrent. */
function heldRecordsShown(db: DatabaseSync, refs: HeldRefs): boolean {
  const records = (refs.records ?? []).map(ref => ({ kind: "record" as const, id: ref.id, version: ref.version }));
  if (!records.length) return true;
  for (const verdict of memoryLookup(db, records, { audience: null, ownFlag: true }).values()) if (verdict.state !== "shown") return false;
  return true;
}
/** The digest of a record's text at a version, or of a source's payload at a revision, as the call reads it (for building a HeldRefs). */
export function recordDigest(db: DatabaseSync, id: string, version: number): string | undefined {
  const row = db.prepare("SELECT text FROM memory_records WHERE id=? AND version=?").get(id, version);
  return row ? digestOf(String(row.text)) : undefined;
}
export function sourceDigest(db: DatabaseSync, id: string, revision: number): string | undefined {
  const row = db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=? AND revision=?").get(id, revision);
  return row ? digestOf(String(row.payload)) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------- the gate (§1)
export type LearningPurpose = "extraction" | "grounding" | "evaluation" | "reflection" | "continuity";
export interface LearningGateOptions {
  /** Non-row state checks (the PIP stamp, settingsCurrent, the GEPA assertCurrent): any throw refuses. */
  checks?: ReadonlyArray<() => void>;
  /** Durably charge before BEGIN; return a best-effort refund for a refusal before release. */
  preSend?: () => (() => void);
  /** Runs under the lock after the check and before the release; a throw refuses with nothing released. */
  onAdmit?: () => void;
  /** The refusal to throw (PIP's readMoved); MemorySendFenced by default. */
  refuse?: () => Error;
}
/** Why a gate refused, fixed words only (the log's `cause=`): `unsampled` (no sample, or the counter is gone), `transaction` (called inside
 * one), `connection` (the handle or counter was replaced), `changed` (the global fence moved and the gate holds no rows to re-check),
 * `withdrawal` (policy, mode, learning settings, a binding or a roster bump), `held-row` (a row the call read changed), `check` (a
 * caller's own state check threw). */
export type LearningFenceCause = "unsampled" | "transaction" | "connection" | "changed" | "withdrawal" | "held-row" | "check";
export interface LearningGate {
  readonly purpose: LearningPurpose;
  /** The cause of the last refusal, undefined until one. */
  readonly cause: LearningFenceCause | undefined;
  /** Attempts this gate let out (cumulative over every attempt, pin, fallback, relaunch and re-run of the call). */
  readonly released: number;
  readonly refused: boolean;
  /** The cheap early exit: throws the refusal when the words may no longer be sent. Releases nothing; refuses inside any transaction. */
  check(): void;
  /** Sole release. A synchronous emitter may return an already-issued response
   * promise; waiting for that response happens after the writer lock ends.
   * Composed consuming checks run in validate before any attempt is charged. */
  send<R>(emit: () => R, validate?: (context: ReleaseContext) => void): R;
}

/** The time BEGIN IMMEDIATE was held per release, in ms, kept for the lock-hold measurement (T18e). Bounded. */
const holdSamples: number[] = [];
export function learningSendHoldSamples(): readonly number[] { return holdSamples; }
function noteHold(ms: number) { if (holdSamples.length >= 4096) holdSamples.shift(); holdSamples.push(ms); }


/** A gate over the words a learning call read after `at` was sampled, plus the rows it holds. One gate per learning call. */
export function learningGate(purpose: LearningPurpose, at: LearningFenceSample | undefined, refs: HeldRefs = {}, options: LearningGateOptions = {}): LearningGate {
  let released = 0, refused = false, cause: LearningFenceCause | undefined;
  const refusal = (): Error => options.refuse?.() ?? new MemorySendFenced();
  const scoped = (refs.records?.length ?? 0) + (refs.sources?.length ?? 0) > 0;
  const no = (why: LearningFenceCause): false => { cause = why; return false; };
  const current = (db: DatabaseSync): boolean => {
    cause = undefined;
    if (!at || !Number.isFinite(at.epoch) || !Number.isFinite(at.dataVersion) || !Number.isFinite(at.withdrawal)) return no("unsampled");
    if (!installed.get(db) || !fenceIntact(db)) return no("unsampled");
    const now = readCounter(db);
    if (!now || now.token !== at.token || now.connection !== at.connection) return no("connection");
    if (now.epoch !== at.epoch || now.dataVersion !== at.dataVersion) {
      // something moved: only the call's OWN rows (and a withdrawal) may refuse it; without rows to re-check, the global fence holds
      if (!scoped) return no("changed");
      if (now.withdrawal !== at.withdrawal) return no("withdrawal");
      if (now.dataVersion !== at.dataVersion && (at.stamp === undefined || now.stamp !== at.stamp)) return no("withdrawal");
      if (!heldRefsCurrent(db, refs) || !heldRecordsShown(db, refs)) return no("held-row");
    } else if (!heldRefsCurrent(db, refs)) return no("held-row");
    try { for (const check of options.checks ?? []) check(); } catch (error) { cause = "check"; throw error; }
    return true;
  };
  const fail = (why?: LearningFenceCause): never => { if (why) cause = why; refused = true; throw refusal(); };
  /** Private: valid only inside the gate's own BEGIN IMMEDIATE. */
  const checkHeld = (db: DatabaseSync, context: ReleaseContext) => {
    assertReleaseContext(context, db);
    let ok: boolean;
    try { ok = current(db); } catch { cause ??= "held-row"; ok = false; }
    if (!ok) fail();
  };
  const locked = <R>(emit: (context: ReleaseContext) => R, validate?: (context: ReleaseContext) => void): R => {
    const db = database();
    if (db.isTransaction) fail("transaction");
    let started = false;
    let refund: (() => void) | undefined;
    const start = performance.now();
    try {
      if (emit.constructor.name === "AsyncFunction") throw new Error("ASYNC_LEARNING_RELEASE");
      try { refund = options.preSend?.(); } catch (error) { if (isDatabaseBusy(error)) throw new MemorySendBusy(); throw error; }
      setBusy(db, BACKGROUND_BUSY_MS);
      noteIdentityEpoch(db);
      try {
        return releaseTransaction(db, {
          validate: context => {
            checkHeld(db, context);
            // Validation-only composition never owns BEGIN or charges a release.
            if (validate) joinReleaseTransaction(context, db, () => validate(context));
            if (options.onAdmit) joinReleaseTransaction(context, db, options.onAdmit);
          },
          onRelease: () => { released++; started = true; },
          emit: context => ({ result: emit(context) }),
          onHold: noteHold,
        }).result;
      } catch (error) {
        if (error instanceof ReleaseCommitFailed) throw new MemorySendCommitFailed();
        if (!started && isDatabaseBusy(error)) { noteBusy("learning-send", performance.now() - start); throw new MemorySendBusy(); }
        throw error;
      }
    } finally {
      if (!started && refund) { try { refund(); } catch { /* a failed refund keeps the durable charge */ } }
      try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ }
    }
  };
  return {
    purpose,
    get released() { return released; },
    get refused() { return refused; },
    get cause() { return cause; },
    check() {
      const db = database();
      if (db.isTransaction) fail("transaction");
      let ok: boolean;
      try { ok = current(db); } catch { cause ??= "held-row"; ok = false; }
      if (!ok) fail();
    },
    send<R>(emit: () => R, validate?: (context: ReleaseContext) => void): R { return locked(emit, validate); },
  };
}

/** The cheap early exit as a boolean: true with no gate, or when `check` passes. */
export function gatePasses(gate: LearningGate | undefined): boolean {
  if (!gate) return true;
  try { gate.check(); return true; } catch { return false; }
}
/** Settlement (r8 §6): a refusal or a busy lock is unsent only while the call's gate released nothing on any attempt. A call without a gate
 *  keeps the r3 reading (a fenced drop is unsent). */
export function droppedUnsent(error: unknown, gate: LearningGate | undefined): boolean {
  if (!isMemorySendFencedError(error) && !isMemorySendBusy(error)) return false;
  return gate ? gate.released === 0 : true;
}
const isMemorySendFencedError = (error: unknown): boolean =>
  error instanceof MemorySendFenced || (error as { message?: unknown } | null)?.message === "MEMORY_SEND_FENCED";

/** The one log line of a dropped call: fixed words and the purpose label only. */
export { logFencedDrop, MemorySendFenced, isMemorySendFenced } from "./learning-send-fence.ts";
