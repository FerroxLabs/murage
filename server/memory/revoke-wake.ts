// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory V2 lane C's LOCAL SHIM of the Wave-0 API (design section 3; the real module is lane W's server/memory/wake.ts).
// Owner: lane C, until lane C is rebased onto fix/1021-memv2-W. From then on this file is only re-exports of ./wake.ts
// (onWake, raise, armDeadline, memoVersion) and everything below is deleted.
//
//   onWake(topic, fn)        fn runs one bounded slice on a later turn of the event loop after raise(topic)
//   raise(topic)             wake the topic's subscribers (never inline)
//   armDeadline(topic, due)  the only timer: one timer for the earliest due time; at `due` the topic is raised
//   memoVersion(name, db)    the number a memo is keyed on (memo rules 3.4)
//
// memoVersion without the connection wrapper (instrumentDatabase is lane W's). The shim cannot see a ROLLBACK, so it follows memo rule
// 3.4 (c) to the letter: a version is STORED only outside a transaction.
//   P  a process counter, bumped through a registered SQL function by TEMP triggers on the watched tables. It never decreases, and a
//      write that is later undone (ROLLBACK, ROLLBACK TO, a statement abort) has still moved it.
//   Outside a transaction the version is the pair (P, PRAGMA data_version): committed state, moved by any watched write of this handle
//   (undone or not) and by any commit of another connection (rule c).
//   Inside a transaction a call answers the stored version only while the pair is still the stored one (no watched row written since,
//   rule d); after a watched write inside the transaction every call answers a NEW number, so nothing read from uncommitted rows is
//   ever kept and nothing can outlive a rollback.
// The triggers call the function and write NO row (an earlier form kept a TEMP counter row: every watched write then counted twice in
// total_changes(), which the marker's slice caps and the ledger charge read).
// The memo itself lives per DatabaseSync handle (rule a: a reopened handle is a new object and starts empty).
// TEMP shadows (F-R3 section 4, CONTRACT-REQ C-R3): the readers name these tables unqualified, so a TEMP table or view of the same name
// is what they read, and the triggers above (ON main.<table>) never see its rows. While any watched name exists in the temp schema there
// is NO memo (every call answers a new number) and memoDataVersion answers null, so no summary answers either (hold everything). PRAGMA
// temp.schema_version is part of the version too: creating or dropping any TEMP object drops the stored version. Names compare without
// case (SQLite resolves Memory_Deny_Pending to memory_deny_pending). The same probe counts this memo's own triggers, each pinned by exact
// name and stored text at install: one missing or rewritten (a DROP TRIGGER, a decoy of another name in its place) means watched writes
// no longer move P, so the call answers a new number and the next call outside a transaction installs again (DROP + CREATE).
// data_version is read by the PRAGMA statement: the table-valued pragma_data_version resolves to a TEMP table or view of that name first
// (and main.pragma_data_version to a main one), which could answer a constant and hide every foreign commit.
// A memo hit costs THREE statements here (PRAGMA data_version, the shadow probe, temp.schema_version). On lane W's memoVersion it costs none.
// Where the triggers cannot be installed (a query_only handle, an open transaction at first use, db.function refused, a missing table)
// there is NO memo: every call answers a new number and the caller's exact read runs as before.
import type { DatabaseSync, StatementSync } from "node:sqlite";

export type WakeTopic = string;
export interface WakeContext { readonly topic: string; armDeadline(dueMs: number): void; until(gate: PromiseLike<unknown>): void }
export type WakeResult = void | boolean | { more?: boolean };
export type WakeSubscriber = (context: WakeContext) => WakeResult | Promise<WakeResult>;
export interface WakeOptions { priority?: number; name?: string }

interface Subscription { topic: string; fn: WakeSubscriber; priority: number; order: number; running: boolean; again: boolean; gone: boolean }
const subscribers = new Map<string, Set<Subscription>>();
const owed = new Set<Subscription>();
const unheard = new Set<string>();
const deadlines = new Map<string, number>();
let subscriptions = 0, pumpQueued = false, timer: ReturnType<typeof setTimeout> | null = null, timerDue = Number.POSITIVE_INFINITY;

/** Subscribe to a topic. Returns the unsubscribe. A wake raised before anyone listened is delivered now. */
export function onWake(topic: WakeTopic, fn: WakeSubscriber, options: WakeOptions = {}): () => void {
  const sub: Subscription = { topic, fn, priority: options.priority ?? 4, order: subscriptions++, running: false, again: false, gone: false };
  let set = subscribers.get(topic);
  if (!set) subscribers.set(topic, set = new Set());
  set.add(sub);
  if (unheard.delete(topic)) owe(sub);
  return () => { sub.gone = true; set.delete(sub); owed.delete(sub); };
}
/** Wake every subscriber of the topic: each gets one slice on a later turn of the event loop. Never runs a subscriber inline. */
export function raise(topic: WakeTopic): void {
  const set = subscribers.get(topic);
  if (!set || set.size === 0) { unheard.add(topic); return; }
  for (const sub of set) owe(sub);
}
/** Arm the topic's deadline: at `dueMs` (wall clock) the topic is raised once. The earliest armed time of a topic wins. */
export function armDeadline(topic: WakeTopic, dueMs: number): void {
  // not finite: the topic's deadline is cancelled (lane W: disarmDeadline(topic))
  if (!Number.isFinite(dueMs)) { if (deadlines.delete(topic)) rearm(); return; }
  const known = deadlines.get(topic);
  if (known !== undefined && known <= dueMs) return;
  deadlines.set(topic, dueMs);
  rearm();
}
function rearm(): void {
  let earliest = Number.POSITIVE_INFINITY;
  for (const due of deadlines.values()) earliest = Math.min(earliest, due);
  if (earliest === timerDue && timer !== null) return;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  timerDue = earliest;
  if (!Number.isFinite(earliest)) return;
  timer = setTimeout(() => {
    timer = null; timerDue = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const [topic, due] of [...deadlines]) if (due <= now) { deadlines.delete(topic); raise(topic); }
    rearm();
  }, Math.min(Math.max(0, earliest - Date.now()), 2_147_000_000));
  (timer as { unref?: () => void }).unref?.();
}
function owe(sub: Subscription): void {
  if (sub.gone) return;
  if (sub.running) { sub.again = true; return; }
  owed.add(sub);
  if (!pumpQueued) { pumpQueued = true; setImmediate(pump); }
}
function pump(): void {
  pumpQueued = false;
  let next: Subscription | undefined;
  for (const sub of owed) if (!next || sub.priority < next.priority || (sub.priority === next.priority && sub.order < next.order)) next = sub;
  if (!next) return;
  owed.delete(next);
  const sub = next;
  sub.running = true;
  let armed = false;
  const context: WakeContext = {
    topic: sub.topic,
    armDeadline: due => { armed = true; armDeadline(sub.topic, due); },
    until: gate => { armed = true; void Promise.resolve(gate).then(() => owe(sub), () => owe(sub)); },
  };
  const settle = (result: WakeResult, failed: boolean): void => {
    sub.running = false;
    const more = failed || result === true || (typeof result === "object" && result !== null && result.more === true);
    if (sub.again) { sub.again = false; owe(sub); }
    // work left with no deadline and no gate named: late, never stranded
    else if (more && !armed) armDeadline(sub.topic, Date.now() + 1000);
    if (owed.size && !pumpQueued) { pumpQueued = true; setImmediate(pump); }
  };
  try {
    const result = sub.fn(context);
    if (result && typeof (result as PromiseLike<WakeResult>).then === "function") (result as PromiseLike<WakeResult>).then(value => settle(value, false), () => settle(undefined, true));
    else settle(result as WakeResult, false);
  } catch { settle(undefined, true); }
}

// ── memo versions (3.4), shim form ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The tables each memo's answer is read from. `windows` (V5): the four the design names, and memory_revoke_audience, which the exact
 * pending read also joins (deny-read.ts rawPending: audience_only), so a memo of that read must move with it too. */
const MEMO_TABLES: Readonly<Record<string, readonly string[]>> = {
  windows: ["memory_deny_pending", "memory_deny_pending_scope", "memory_receipt_flips", "memory_revoke_jobs", "memory_revoke_audience"],
};
interface MemoState { read: StatementSync; versionRead: StatementSync | null; tempSchema: StatementSync; triggers: number; lastKey: string; lastId: number; dataVersion: number }
type HandleState = Map<string, MemoState | "failed">;
const handles = new WeakMap<DatabaseSync, HandleState>();
/** P: bumped by every watched write of every handle, undone or not. Never decreases. */
let processCounter = 0;
/** The numbers memoVersion hands out. Never reused. */
let issued = 0;
const stats = { installs: 0, failed: 0, versionReads: 0, fresh: 0 };
/** Counters for the witnesses: `versionReads` counts memo checks (each costs three statements with the shim: see the header). */
export function revokeWakeStats(): Readonly<typeof stats> & { processCounter: number } { return { ...stats, processCounter }; }
/** Test-only seam (mutant c of memv2-c-windows-1021.test.ts): store a version inside a transaction too (the name is the earlier form's). Never set in product code. */
export const revokeWakeTestHooks = { processCounterOnly: false, ignoreTempShadow: false, noTempSchemaVersion: false, caseSensitiveShadow: false, ignoreMissingTriggers: false, unqualifiedDataVersion: false, triggersByPrefix: false, qualifiedDataVersion: false };

function install(db: DatabaseSync, name: string): MemoState | "failed" | null {
  const tables = MEMO_TABLES[name]!;
  // not inside a transaction: the TEMP objects would vanish with a rollback while this module still believed in them. Try again later.
  if ((db as { isTransaction?: boolean }).isTransaction !== false) return null;
  try {
    if (Number((db.prepare("PRAGMA query_only").get() as { query_only?: unknown } | undefined)?.query_only ?? 1) !== 0) return "failed";
    const fn = `murage_c_memo_bump_${name}`;
    db.function(fn, () => ++processCounter);
    // DROP then CREATE (never IF NOT EXISTS): a trigger of the same name made by anyone else is replaced, so what is pinned below is ours
    const made = tables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => ({
      name: `mem_c_memo_${name}__${table}__${event[0]!.toLowerCase()}`, on: `AFTER ${event} ON main.${table}` })));
    db.exec(made.map(t => `DROP TRIGGER IF EXISTS temp.${t.name}; CREATE TEMP TRIGGER ${t.name} ${t.on} BEGIN SELECT ${fn}(); END;`).join("\n"));
    // pin each trigger by its exact name and stored text: the probe counts only these, so a trigger of another name (or the same name
    // with other text) never stands in for one of ours that was dropped
    const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const pinned = (db.prepare(`SELECT name, sql FROM temp.sqlite_master WHERE type='trigger' AND name IN (${made.map(t => quote(t.name)).join(",")})`)
      .all() as Array<{ name: string; sql: string }>);
    if (pinned.length !== made.length) return "failed";
    stats.installs++;
    const names = tables.map(table => `'${table}'`).join(",");
    // data_version from the PRAGMA statement, never the table-valued pragma_data_version: that name resolves to a TEMP table or view of
    // the same name first, and main.pragma_data_version to a table or view of that name in main (any connection can persist one), either
    // of which can answer a constant and hide every commit of another connection. (Mutants k and o read the table-valued forms.)
    const tableValued = revokeWakeTestHooks.unqualifiedDataVersion ? "pragma_data_version" : revokeWakeTestHooks.qualifiedDataVersion ? "main.pragma_data_version" : null;
    return {
      read: db.prepare(`SELECT ${tableValued ? `(SELECT data_version FROM ${tableValued})` : "NULL"} AS data_version,
        EXISTS(SELECT 1 FROM temp.sqlite_master WHERE type IN ('table','view') AND ${revokeWakeTestHooks.caseSensitiveShadow ? "name" : "lower(name)"} IN (${names})) AS shadowed,
        (SELECT count(*) FROM temp.sqlite_master WHERE type='trigger' AND ${revokeWakeTestHooks.triggersByPrefix ? `name GLOB 'mem_c_memo_${name}__*'`
          : `(name, sql) IN (VALUES ${pinned.map(t => `(${quote(t.name)},${quote(t.sql)})`).join(",")})`}) AS armed`),
      triggers: made.length,
      versionRead: tableValued ? null : db.prepare("PRAGMA data_version"),
      tempSchema: db.prepare("PRAGMA temp.schema_version"), lastKey: "", lastId: 0, dataVersion: -1,
    };
  } catch { stats.failed++; return "failed"; }
}

/** The version a memo is keyed on (design 3.4): equal numbers from two calls mean no watched row of this handle was written, undone or
 * rolled back in between, and no other connection committed. Where that cannot be known every call answers a new number (no memo).
 * `db` is the handle the memo lives on; lane W's memoVersion(name) knows its one connection and takes no handle. */
export function memoVersion(name: string, db?: DatabaseSync): number {
  // a code-only counter (no table behind it): moved by bumpMemoVersion alone, 0 before its first bump
  if (!MEMO_TABLES[name]) return codeVersions.get(name) ?? 0;
  if (!db) { stats.fresh++; return ++issued; }
  let byName = handles.get(db);
  if (!byName) handles.set(db, byName = new Map());
  let state = byName.get(name);
  if (state === undefined) {
    const made = install(db, name);
    if (made === null) { stats.fresh++; return ++issued; }
    byName.set(name, state = made);
  }
  if (state === "failed") { stats.fresh++; return ++issued; }
  let row: { data_version?: unknown; shadowed?: unknown; armed?: unknown } | undefined, tempSchema: number, version: unknown;
  try {
    stats.versionReads++;
    version = state.versionRead ? (state.versionRead.get() as { data_version?: unknown } | undefined)?.data_version : undefined;
    row = state.read.get() as typeof row;
    if (!state.versionRead) version = row?.data_version;
    tempSchema = revokeWakeTestHooks.noTempSchemaVersion ? 0 : Number((state.tempSchema.get() as { schema_version?: unknown } | undefined)?.schema_version);
  } catch { byName.delete(name); stats.fresh++; return ++issued; }
  const dataVersion = Number(version);
  if (!Number.isFinite(dataVersion) || !Number.isFinite(tempSchema)) { byName.set(name, "failed"); stats.fresh++; return ++issued; }
  // a trigger of this memo is gone: no memo now; the next call outside a transaction installs again (CREATE ... IF NOT EXISTS)
  if (Number(row?.armed) !== state.triggers && !revokeWakeTestHooks.ignoreMissingTriggers) { byName.delete(name); stats.fresh++; return ++issued; }
  // a watched name shadowed in temp (or the probe unreadable): the readers read rows no trigger here sees. No memo, no summary.
  if (Number(row?.shadowed) !== 0 && !revokeWakeTestHooks.ignoreTempShadow) { state.dataVersion = -1; state.lastKey = ""; stats.fresh++; return ++issued; }
  state.dataVersion = dataVersion;
  const key = `${processCounter}:${dataVersion}:${tempSchema}`;
  if (key === state.lastKey) return state.lastId;
  // a watched row was written (or another connection committed) since the stored version: inside a transaction nothing is stored
  if ((db as { isTransaction?: boolean }).isTransaction !== false && !revokeWakeTestHooks.processCounterOnly) { stats.fresh++; return ++issued; }
  state.lastKey = key; state.lastId = ++issued;
  return state.lastId;
}
const codeVersions = new Map<string, number>();
/** Shim only: moves the code-only counter `name` forward (the stand-in for a lane W TEMP trigger bump where the writer is code). */
export function bumpMemoVersion(name: string): void {
  if (MEMO_TABLES[name]) throw new Error(`bumpMemoVersion: ${name} is moved by its tables`);
  codeVersions.set(name, (codeVersions.get(name) ?? 0) + 1);
}
/** Diagnostics and tests: whether a deadline is armed for `topic`, and how many subscribers it has. */
export const wakeProbe = { armed: (topic: string): boolean => deadlines.has(topic), subscribers: (topic: string): number => subscribers.get(topic)?.size ?? 0 };
/** `PRAGMA data_version` as the last memoVersion(name, db) read it (no statement), or null when this handle has no memo (or the last call
 * found a watched name shadowed in temp). */
export function memoDataVersion(name: string, db: DatabaseSync): number | null {
  const state = handles.get(db)?.get(name);
  return state && state !== "failed" && state.dataVersion >= 0 ? state.dataVersion : null;
}
