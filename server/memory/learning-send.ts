// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning send gate (designs/MEM-LEARNING-FENCE-R8.md, phase 1). A learning call reads memory words and may then wait in a queue.
// Its one gate decides, under the database write lock and with no await before the bytes leave, whether those words may still be sent:
// nothing that removes or changes them (a Forget, a delete, an owner edit, a scrub, a policy, roster or learning withdrawal) may have
// committed since they were read. A call still waiting is dropped unsent; a call the gate released is out of our hands (forget.ts:83).
//
// The fence counter is a TEMP table on the main connection moved by TEMP triggers, independent of deletion_epoch. Another connection's
// commit moves PRAGMA data_version, which the gate checks too. `send` holds BEGIN IMMEDIATE from the check through the release and the
// write, so no other connection can commit in between. Busy waits at most BACKGROUND_BUSY_MS and defers the call (released unchanged).
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { connectionId, database } from "../database.ts";
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS, isDatabaseBusy, noteBusy, setBusy } from "../db-busy.ts";
import { txScopeBegin, txScopeEnd } from "../tx-scope.ts";
import { noteIdentityEpoch } from "./provenance-stamp.ts";
import { NOISY_SYSTEM_SUBJECTS, bumpLearningFence } from "./authority-epoch.ts";
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
export class MemorySendCommitFailed extends Error {
  constructor() { super("MEMORY_SEND_COMMIT_FAILED"); this.name = "memory-send-commit-failed"; }
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
const LITERAL = /^[a-z][a-z-]*$/;
const lit = (value: string) => { if (!LITERAL.test(value)) throw new Error("LEARNING_FENCE_QUIET_LITERAL"); return `'${value}'`; };
const QUIET_BINDING_INSERT = LEARNING_FENCE_QUIET_BINDINGS.filter(q => q.insert).map(q =>
  `(NEW.subject_type IS ${lit(q.type)}${q.subject ? ` AND NEW.subject_id IS ${lit(q.subject)}` : ""} AND NEW.state IS 'granted')`).join(" OR ") || "0";
const QUIET_BINDING_UPDATE = LEARNING_FENCE_QUIET_BINDINGS.filter(q => q.update).map(q =>
  `(NEW.subject_type IS ${lit(q.type)} AND OLD.subject_type IS ${lit(q.type)}${q.subject ? ` AND NEW.subject_id IS ${lit(q.subject)}` : ""} AND NEW.subject_id IS OLD.subject_id${q.update!.map(c => ` AND NEW.${c} IS OLD.${c}`).join("")})`).join(" OR ") || "0";
const BUMP = "UPDATE memory_learning_fence SET epoch=epoch+1 WHERE id=1";
const trig = (name: string, event: string, table: string, when?: string) =>
  ({ name: `learning_fence_${name}`, sql: `CREATE TEMP TRIGGER IF NOT EXISTS learning_fence_${name} AFTER ${event} ON main.${table}${when ? ` WHEN ${when}` : ""} BEGIN ${BUMP}; END;` });
const all = (table: string, events: readonly string[] = ["INSERT", "UPDATE", "DELETE"]) =>
  events.map(event => trig(`${table}_${event[0]!.toLowerCase()}`, event, table));
const TRIGGER_DEFS = [
  ...all("memory_tombstones"), ...all("memory_deny"), ...all("memory_deny_line"), ...all("memory_deny_range"),
  trig("memory_meta_u", "UPDATE", "memory_meta", "OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch OR OLD.mode IS NOT NEW.mode"),
  trig("bindings_i", "INSERT", "memory_scope_bindings", `NOT (${QUIET("NEW")}) AND NOT (${ACCT_INSERT}) AND NOT (${QUIET_BINDING_INSERT})`),
  trig("bindings_u", "UPDATE", "memory_scope_bindings", `(NOT (${QUIET("NEW")}) OR NOT (${QUIET("OLD")})) AND NOT (${ACCT_UPDATE}) AND NOT (${QUIET_BINDING_UPDATE})`),
  trig("bindings_d", "DELETE", "memory_scope_bindings", `NOT (${QUIET("OLD")})`),
  ...all("memory_learning_config", ["INSERT", "UPDATE"]),
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
    db.exec("CREATE TEMP TABLE IF NOT EXISTS memory_learning_fence(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, token TEXT NOT NULL, quiet TEXT, quiet_subject TEXT)");
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
    if (!db.prepare("SELECT 1 AS ok, quiet, quiet_subject FROM temp.memory_learning_fence WHERE id=1").get()) return false;
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
export interface LearningFenceSample { epoch: number; token: string; connection: string; dataVersion: number }
function readCounter(db: DatabaseSync): LearningFenceSample | undefined {
  const row = db.prepare("SELECT (SELECT epoch FROM temp.memory_learning_fence WHERE id=1) AS epoch, (SELECT token FROM temp.memory_learning_fence WHERE id=1) AS token").get();
  if (!row || row.epoch === null || row.epoch === undefined || typeof row.token !== "string") return undefined;
  // data_version last: nothing between this read and the gate's next step awaits
  const version = db.prepare("PRAGMA data_version").get();
  return { epoch: Number(row.epoch), token: row.token, connection: connectionId(db), dataVersion: Number(version?.data_version) };
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
  for (const ref of refs.records ?? []) {
    const row = db.prepare("SELECT r.state,r.text,(SELECT max(version) FROM memory_records WHERE id=r.id) AS latest FROM memory_records r WHERE r.id=? AND r.version=?").get(ref.id, ref.version);
    if (!row || Number(row.latest) !== ref.version || (row.state !== "active" && row.state !== "candidate")) return false;
    if (ref.digest !== undefined && digestOf(String(row.text)) !== ref.digest) return false;
    if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1").get(ref.id, ref.version)) return false;
  }
  const sources=(refs.sources??[]).map(ref=>({kind:"source" as const,id:ref.id,version:ref.revision}));
  for(const verdict of memoryLookup(db,sources,{audience:null,ownFlag:true}).values())if(verdict.state!=="shown")return false;
  for (const ref of refs.sources ?? []) {
    const row = db.prepare("SELECT s.revision,s.state,v.payload FROM memory_sources s LEFT JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?").get(ref.id);
    if (!row || Number(row.revision) !== ref.revision || row.state !== "active") return false;
    if (ref.digest !== undefined && (row.payload === null || digestOf(String(row.payload)) !== ref.digest)) return false;
    if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?) LIMIT 1").get(ref.id, ref.revision)) return false;
  }
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
  /** Runs under the lock after the check and before the release (PIP's paid-call charge); a throw refuses with nothing released. */
  onAdmit?: () => void;
  /** The refusal to throw (PIP's readMoved); MemorySendFenced by default. */
  refuse?: () => Error;
}
export interface LearningGate {
  readonly purpose: LearningPurpose;
  /** Attempts this gate let out (cumulative over every attempt, pin, fallback, relaunch and re-run of the call). */
  readonly released: number;
  readonly refused: boolean;
  /** The cheap early exit: throws the refusal when the words may no longer be sent. Releases nothing; refuses inside any transaction. */
  check(): void;
  /** Check under BEGIN IMMEDIATE, release, run `emit` (which must hand the bytes to the engine before it returns), COMMIT, then return
   *  its result. `emit` must not await before its write (learning-send-boundary.test.ts). */
  send<R>(emit: () => R): R;
  /** The adapter form (the Codex/ACP beforeSubmit hook, the Claude one-shot): check and release under the lock, COMMIT; the adapter's
   *  synchronous chain then writes. */
  admit(): void;
  /** The adapter wrote the admitted bytes. */
  wrote(): void;
  /** The adapter halted after `admit` and before any write: the admission is withdrawn (once; never below what was written). */
  notWritten(): void;
}

/** The time BEGIN IMMEDIATE was held per release, in ms, kept for the lock-hold measurement (T18e). Bounded. */
const holdSamples: number[] = [];
export function learningSendHoldSamples(): readonly number[] { return holdSamples; }
function noteHold(ms: number) { if (holdSamples.length >= 4096) holdSamples.shift(); holdSamples.push(ms); }

let gateOwnsTransaction = false;

/** A gate over the words a learning call read after `at` was sampled, plus the rows it holds. One gate per learning call. */
export function learningGate(purpose: LearningPurpose, at: LearningFenceSample | undefined, refs: HeldRefs = {}, options: LearningGateOptions = {}): LearningGate {
  let released = 0, written = 0, refused = false, open = false;
  const refusal = (): Error => options.refuse?.() ?? new MemorySendFenced();
  const current = (db: DatabaseSync): boolean => {
    if (!at || !Number.isFinite(at.epoch) || !Number.isFinite(at.dataVersion)) return false;
    if (!installed.get(db) || !fenceIntact(db)) return false;
    const now = readCounter(db);
    if (!now || now.token !== at.token || now.connection !== at.connection || now.epoch !== at.epoch || now.dataVersion !== at.dataVersion) return false;
    if (!heldRefsCurrent(db, refs)) return false;
    for (const check of options.checks ?? []) check();
    return true;
  };
  const fail = (): never => { refused = true; throw refusal(); };
  /** Private: valid only inside the gate's own BEGIN IMMEDIATE. */
  const checkHeld = (db: DatabaseSync) => {
    if (!gateOwnsTransaction || !db.isTransaction) throw new Error("LEARNING_GATE_CHECK_OUTSIDE_GATE");
    let ok: boolean;
    try { ok = current(db); } catch { ok = false; }
    if (!ok) fail();
  };
  /** Steps 0-4 under the lock; `then` runs after the release and before COMMIT (emit), or nothing (admit). */
  const locked = <R>(then: (() => R) | undefined): R | undefined => {
    const db = database();
    // 0: a caller's own transaction could roll back what the check rests on
    if (db.isTransaction) fail();
    let began = false, committed = false, scoped = false;
    const start = performance.now();
    try {
      setBusy(db, BACKGROUND_BUSY_MS);
      noteIdentityEpoch(db);
      try { db.exec("BEGIN IMMEDIATE"); began = true; }
      catch (error) {
        if (isDatabaseBusy(error)) { noteBusy("learning-send", performance.now() - start); throw new MemorySendBusy(); }
        throw error;
      }
      gateOwnsTransaction = true; txScopeBegin(); scoped = true;
      const lockedAt = performance.now();
      checkHeld(db);           // 2
      options.onAdmit?.();     // 3 (nests as a SAVEPOINT through transaction())
      released++;              // 4
      let out: R | undefined;
      try { out = then?.(); }
      finally {
        try { db.exec("COMMIT"); committed = true; }
        catch {
          // the attempt was released: keep it, roll back what is left, and never call it unsent
          try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* the connection reports its own state */ }
          began = false;
          // eslint-disable-next-line no-unsafe-finally
          throw new MemorySendCommitFailed();
        }
        began = false;
        noteHold(performance.now() - lockedAt);
      }
      return out;
    } finally {
      if (began) { try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* reported by the caller's error */ } }
      if (scoped) txScopeEnd(committed);
      gateOwnsTransaction = false;
      try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ }
    }
  };
  return {
    purpose,
    get released() { return released; },
    get refused() { return refused; },
    check() {
      const db = database();
      if (db.isTransaction) fail();
      let ok: boolean;
      try { ok = current(db); } catch { ok = false; }
      if (!ok) fail();
    },
    send<R>(emit: () => R): R { return locked(emit) as R; },
    admit() { locked(undefined); open = true; },
    wrote() { if (open) { written++; open = false; } },
    notWritten() {
      if (!open) return;
      open = false;
      if (released > written) released--;
    },
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
