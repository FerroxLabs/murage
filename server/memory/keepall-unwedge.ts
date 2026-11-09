// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-time 1.0.3 repair of a data dir that 1.0.2 left refusing every turn after "Keep all" or any install-wide revoke (P0-KEEPALL-REFUSED
// F5). No setting: it runs once at start, in bounded steps, and a second start does nothing.
//
// What 1.0.2 left behind, and what each step does with it:
//  1. deny_session marks of audience-only revokes (memory_revoke_audience: receipts a roster or settings change flipped) on the owner's own
//     direct chats. The owner's chat is judged by content now (deny-read.ts sessionLookup), so they are inert there; deleting them also stops
//     every later session of the thread from being reset by them. Only the owner's own direct chats, and there only the marks of a session
//     the task holds as an owner-audience resume cursor (ELD250 B12): a non-owner turn on the same thread reads with an audience
//     (AUDIENCE_SESSION_READER) and still honours the marks of its own sessions, so those are kept.
//  2. Revoke jobs reopened with nothing left to walk: the marker is drained within a bound, and the runner finishes the rest.
//  3. Resume cursors that point at a session that is withheld now: cleared (index.ts, with the store), so the first turn starts a fresh
//     session instead of resetting one. Only on a drained marker, and a session still "checking" keeps its cursor (the live check at the
//     turn decides it). The clear is an optimisation: a cursor the repair leaves is still judged at its turn.
// The 1.0.2 walk also marked sessions begun after a revoke's commit (the 1.0.3 cap no longer writes them). Those rows are kept: a session
// begun after the commit can also have been marked because it carried the revoked content (inheritance at write), and the rows do not say
// which, so deleting them could resume a session that holds what was revoked. Each such mark resets its session once, then the thread runs.
//
// ALL.eld250 (1.0.18, design ELD250-KEEPALL-R3): step 1 runs in slices of about 20 ms (a thread never split across two), each its own
// background transaction with a yield to the loop between; steps 2 and 3, the flush and the flag stay one synchronous task. The whole repair
// runs after listen under the `startup` source, and a gate made before listen holds a turn admission (bounded) while it runs.
//
// The flag lives beside the data (memory-repairs.json, never in messages.db: the memory schema's meta keys are fixed), keyed on the memory
// file's installation id, so a memory file with a different installation id is repaired again. Every step is idempotent, so a run cut short
// is simply run again.
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AFTER_LISTEN_BUSY_ATTEMPTS, AFTER_LISTEN_BUSY_RETRY_MS, trackBootJob } from "../after-listen.ts";
import { awaitWriterGate, beginBackground, FOREGROUND_GATE_MAX_MS, isDatabaseBusy } from "../db-busy.ts";
import { ioBudget } from "../io-budget.ts";
import { sessionKeyOf } from "./session-incarnation.ts";

export const MEMORY_REPAIRS_FILE = "memory-repairs.json";
export const KEEPALL_UNWEDGE = "keepallUnwedge103";

function installationId(db: DatabaseSync): string | null {
  try { const id = db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()?.installation_id; return typeof id === "string" ? id : null; }
  catch { return null; }
}
function readRepairs(dataDir: string): Record<string, unknown> {
  try { const file = join(dataDir, MEMORY_REPAIRS_FILE); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {}; }
  catch { return {}; }
}
/** Whether this memory file was already repaired (the flag names its installation id). */
export function keepAllUnwedged(db: DatabaseSync, dataDir: string): boolean {
  const id = installationId(db);
  const done = readRepairs(dataDir)[KEEPALL_UNWEDGE] as { installationId?: unknown } | undefined;
  return id !== null && done?.installationId === id;
}
function markUnwedged(db: DatabaseSync, dataDir: string, counts: { denySessions: number; openJobs: number }): void {
  const id = installationId(db);
  if (id === null) return;
  const next = { ...readRepairs(dataDir), [KEEPALL_UNWEDGE]: { installationId: id, at: Date.now(), denySessions: counts.denySessions, openJobs: counts.openJobs } };
  const file = join(dataDir, MEMORY_REPAIRS_FILE), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file);
}

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name));

export type KeepAllOutcome = "repaired" | "bounded" | "cursors-deferred" | "gave-up" | "stopped" | "already";

/** The repair's one gate (B5, B6, B17): made before listen, after the first database open. `pending` holds turn admissions (bounded) while
 * the repair runs; `stop()` latches `stopping` and resolves `stoppingPromise`, which every wait of the repair races. `done` resolves exactly
 * once and never rejects. `stop` and `finish` are idempotent. */
export interface KeepAllRepairGate {
  readonly pending: boolean;
  readonly done: Promise<KeepAllOutcome>;
  readonly stopping: boolean;
  readonly stoppingPromise: Promise<void>;
  stop(): void;
  finish(outcome: KeepAllOutcome): void;
}
/** `flagged`: the memory file is already repaired, so the gate is resolved ("already") from the first request. */
export function createKeepAllRepairGate(flagged: boolean): KeepAllRepairGate {
  let pending = true, stopping = false, finished = false;
  let resolveDone!: (outcome: KeepAllOutcome) => void, resolveStopping!: () => void;
  const done = new Promise<KeepAllOutcome>(resolve => { resolveDone = resolve; });
  const stoppingPromise = new Promise<void>(resolve => { resolveStopping = resolve; });
  const gate: KeepAllRepairGate = {
    get pending() { return pending; },
    done,
    get stopping() { return stopping; },
    stoppingPromise,
    stop() { if (stopping) return; stopping = true; resolveStopping(); },
    finish(outcome) { if (finished) return; finished = true; pending = false; resolveDone(outcome); },
  };
  if (flagged) gate.finish("already");
  return gate;
}

/** `p`, or undefined once `ms` passed (an unref'd timer, cleared when `p` wins). */
export function raceCeiling<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); timer.unref?.(); });
  return Promise.race([p, ceiling]).finally(() => { if (timer) clearTimeout(timer); });
}

/** The turn barrier (B5): one wait per admission, one ceiling. A courtesy: a turn in the repair window starts on the repaired state; past the
 * ceiling it goes on, and the repair then leaves that task's cursor to the live turn. */
export async function keepAllRepairBarrier(gate: KeepAllRepairGate, ms = FOREGROUND_GATE_MAX_MS): Promise<void> {
  if (gate.pending) await raceCeiling(gate.done, ms);
}

/** The shutdown join inside the data-writer stop (B6): latch, then wait (bounded) for the repair to reach its next check. */
export async function joinKeepAllRepair(gate: KeepAllRepairGate, ms = 1_000): Promise<void> {
  gate.stop();
  await raceCeiling(gate.done, ms);
}

/** The after-listen `keepallUnwedge` step (B4): starts the repair for a gate still pending, counted as start-up work. A throw before the
 * repair starts ends the gate ("gave-up"), so `done` always resolves. */
export function launchKeepAllRepair(gate: KeepAllRepairGate, start: () => Promise<KeepAllOutcome>, warn: (line: string) => void = console.warn): void {
  if (!gate.pending) return;
  try { trackBootJob(start()); }
  catch (error) { gate.finish("gave-up"); warn(`[memory] keep-all repair: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
}

/** The after-listen `memoryRevocation` step's wake (B7): once the repair has ended, any outcome (at once for a repaired file), and never
 * while stopping (a wake after stopMemoryRevocation would clear its stop). */
export function wakeAfterKeepAllRepair(gate: KeepAllRepairGate, wake: () => void): void {
  const go = () => { if (!gate.stopping) wake(); };
  if (!gate.pending) go(); else void gate.done.then(go);
}

/** The memory key of a stored cursor (session-incarnation.ts), joined for a set. */
export const sessionSlot = (instanceId: string, nativeSession: string) => `${instanceId}\u0000${nativeSession}`;
/** A recorded session audience an owner direct turn would resume: the owner's (a cursor from before the fingerprint reads as the owner's,
 * session-audience.ts sessionAudienceChanged; the partition suffix is not the audience). */
export const ownerSessionAudience = (recorded: string | undefined) => (recorded ?? "owner").split("|x2:")[0] === "owner";

export interface RepairTask {
  readonly threadId: string;
  readonly busy?: boolean;
  readonly resumeCursors?: Readonly<Record<string, unknown>>;
  readonly resumeIncarnations?: Readonly<Record<string, number>>;
  readonly resumeAudiences?: Readonly<Record<string, string>>;
}
export interface RepairBot { readonly id: string; readonly tasks?: ReadonlyArray<RepairTask> }

/** B12 (b): per owner direct thread, the sessions whose audience-only marks step 1 may delete: the task's stored owner-audience cursors.
 * Synchronous, from the store, in Part A's setup task. */
export function ownerAudienceSessions(bots: Iterable<RepairBot>, ownerDirectThread: (threadId: string) => boolean): Map<string, Set<string>> {
  const eligible = new Map<string, Set<string>>();
  for (const bot of bots) for (const task of bot.tasks ?? []) {
    if (!ownerDirectThread(task.threadId)) continue;
    for (const [instanceId, cursor] of Object.entries(task.resumeCursors ?? {})) {
      if (cursor === undefined || cursor === null || !ownerSessionAudience(task.resumeAudiences?.[instanceId])) continue;
      const session = sessionKeyOf(task.threadId, instanceId, String(cursor), task.resumeIncarnations?.[instanceId]).nativeSession;
      let slots = eligible.get(task.threadId);
      if (!slots) eligible.set(task.threadId, slots = new Set());
      slots.add(sessionSlot(instanceId, session));
    }
  }
  return eligible;
}

export interface CursorClear { readonly botId: string; readonly instanceId: string; readonly threadId: string; readonly cursor: unknown; readonly incarnation: number | undefined }
export type ReaderKind = "content" | "audience";
/** Step 3's judgment (B2 keep rules a and b, B11): a cursor is cleared only when its session is withheld (or its receipts revoked), and its
 * task has no live turn. "checking" is not final: it keeps the cursor, before the clear predicate is looked at. */
export function judgeKeepAllCursors(bots: Iterable<RepairBot>, deps: {
  ownerDirectThread: (threadId: string) => boolean;
  verdict: (threadId: string, instanceId: string, session: string, reader: ReaderKind) => { readonly state: string };
  revoked: (threadId: string, instanceId: string, session: string) => boolean;
  liveThreads: ReadonlySet<string>;
}): { clears: CursorClear[]; keptChecking: number; keptLive: number } {
  const clears: CursorClear[] = [];
  let keptChecking = 0, keptLive = 0;
  for (const bot of bots) for (const task of bot.tasks ?? []) for (const [instanceId, cursor] of Object.entries(task.resumeCursors ?? {})) {
    if (cursor === undefined || cursor === null) continue;
    const incarnation = task.resumeIncarnations?.[instanceId];
    const session = sessionKeyOf(task.threadId, instanceId, String(cursor), incarnation).nativeSession;
    const state = deps.verdict(task.threadId, instanceId, session, deps.ownerDirectThread(task.threadId) ? "content" : "audience").state;
    if (state === "checking") { keptChecking++; continue; }
    if (state !== "withheld" && !deps.revoked(task.threadId, instanceId, session)) continue;
    if (task.busy || deps.liveThreads.has(task.threadId)) { keptLive++; continue; }
    clears.push({ botId: bot.id, instanceId, threadId: task.threadId, cursor, incarnation });
  }
  return { clears, keptChecking, keptLive };
}

export interface KeepAllRepairDeps {
  /** Part A setup: the eligible sessions per owner direct thread (ownerAudienceSessions). Only these threads are visited. */
  readonly ownerSessions: () => ReadonlyMap<string, ReadonlySet<string>>;
  /** drainRevokeMarkerBounded(file, {4096, 250}, {background: true}): true while marker work is left. */
  readonly drain: (db: DatabaseSync) => boolean;
  /** markerWorkPending (revoke-marker.ts), for a file with no open job. */
  readonly markerPending: (db: DatabaseSync) => boolean;
  /** Judge and clear in one go (judgeKeepAllCursors, then Store.clearResumeCursors). */
  readonly judgeAndClear: () => { cleared: number; botsMoved: number; skipped: number; keptChecking: number; keptLive: number };
  /** flushCoalesced of bots.json: synchronous, rethrows. */
  readonly flush: () => void;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
  // test seams
  readonly now?: () => number;
  readonly sliceMs?: number;
  readonly maxRows?: number;
  readonly attempts?: number;
  readonly firstPauseMs?: number;
  readonly begin?: (db: DatabaseSync, op: string) => void;
  readonly writerGate?: () => Promise<void>;
  readonly nextTask?: () => Promise<void>;
  readonly onSlice?: () => void;
}

/** The whole repair, once per memory file (B1, B2, B4, B6): sliced deletes, then one synchronous task that drains, judges and clears the
 * cursors, flushes, then writes the flag. Ends the gate with its outcome and never rejects. */
export function startKeepAllRepair(db: DatabaseSync, dataDir: string, gate: KeepAllRepairGate, deps: KeepAllRepairDeps): Promise<KeepAllOutcome> {
  let run: Promise<KeepAllOutcome>;
  try { run = ioBudget.withSource("startup", () => runKeepAllRepair(db, dataDir, gate, deps)); }
  catch (error) { run = Promise.reject(error); }
  return run.catch(error => {
    (deps.warn ?? console.warn)(`[memory] keep-all repair: ${error instanceof Error ? error.message : String(error)}; the next start carries on`);
    return "gave-up" as const;
  }).then(outcome => { gate.finish(outcome); return outcome; });
}

async function runKeepAllRepair(db: DatabaseSync, dataDir: string, gate: KeepAllRepairGate, deps: KeepAllRepairDeps): Promise<KeepAllOutcome> {
  if (keepAllUnwedged(db, dataDir)) return "already";
  const now = deps.now ?? (() => performance.now()), sliceMs = deps.sliceMs ?? 20, maxRows = deps.maxRows ?? 50_000;
  const begin = deps.begin ?? beginBackground, writerGate = deps.writerGate ?? awaitWriterGate;
  const nextTask = deps.nextTask ?? (() => new Promise<void>(resolve => setImmediate(resolve)));
  const warn = deps.warn ?? console.warn;
  // every wait races the stop latch, and the latch is checked after every await (3.4)
  const wait = <T>(p: Promise<T>) => Promise.race([p, gate.stoppingPromise]);
  const pauseFor = (ms: number) => wait(new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  const repairYield = async () => { await wait(nextTask()); if (gate.stopping) return false; await wait(writerGate()); return !gate.stopping; };
  let attemptsLeft = deps.attempts ?? AFTER_LISTEN_BUSY_ATTEMPTS, pause = deps.firstPauseMs ?? AFTER_LISTEN_BUSY_RETRY_MS;
  /** A held lock: rolled back already; true when the repair may try again (after the writer gate and a growing pause). */
  const retry = async (error: unknown): Promise<boolean> => {
    if (!isDatabaseBusy(error)) throw error;
    if (--attemptsLeft <= 0) { warn(`[memory] keep-all repair met a held lock ${deps.attempts ?? AFTER_LISTEN_BUSY_ATTEMPTS} times; the next start carries on`); return false; }
    await wait(writerGate());
    if (gate.stopping) return false;
    await pauseFor(pause);
    pause = Math.min(pause * 2, 5_000);
    return !gate.stopping;
  };

  // Part A: the setup task (one read of the thread list, 478 rows on the real copy), then the slices
  let denySessions = 0, ownerThreads = 0, slices = 0, bounded = false;
  const rowsPresent = hasTable(db, "memory_deny_session") && hasTable(db, "memory_revoke_audience");
  const eligible = rowsPresent ? deps.ownerSessions() : new Map<string, ReadonlySet<string>>();
  const threads = rowsPresent
    ? db.prepare("SELECT DISTINCT thread_id FROM memory_deny_session WHERE revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)").all().map(row => String(row.thread_id)).filter(id => eligible.has(id))
    : [];
  const remove = rowsPresent ? db.prepare("DELETE FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=? AND revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)") : null;
  let next = 0;
  while (next < threads.length && !bounded) {
    if (!await repairYield()) return "stopped";
    const taskStart = now();
    let sliceRows = 0, sliceThreads = 0, at = next, hitBound = false;
    try {
      begin(db, "keepall-unwedge");
      try {
        while (at < threads.length) {
          // the row bound is cumulative across slices, checked between threads (B1)
          if (denySessions + sliceRows >= maxRows) { hitBound = true; break; }
          // a thread is never split across slices (B12 a): all its eligible rows go in this transaction
          const threadId = threads[at]!;
          for (const slot of eligible.get(threadId) ?? []) {
            const cut = slot.indexOf("\u0000");
            sliceRows += Number(remove!.run(threadId, slot.slice(0, cut), slot.slice(cut + 1)).changes);
          }
          sliceThreads++; at++;
          if (now() - taskStart >= sliceMs) break;
        }
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } } throw error; }
    } catch (error) {
      if (await retry(error)) continue;
      return gate.stopping ? "stopped" : "gave-up";
    }
    // the index and the counters move only after COMMIT, and are never reset per slice
    denySessions += sliceRows; ownerThreads += sliceThreads; next = at; slices++;
    bounded = hitBound;
    deps.onSlice?.();
  }

  // Part B: one synchronous task, reached after a yield whose stop check passed
  for (;;) {
    if (!await repairYield()) return "stopped";
    try {
      const openJobs = hasTable(db, "memory_revoke_jobs") ? Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')").get()?.n ?? 0) : 0;
      let drainLeft: boolean;
      try { drainLeft = openJobs ? deps.drain(db) : deps.markerPending(db); }
      catch (error) { if (isDatabaseBusy(error)) throw error; drainLeft = true; /* not known drained: the cursors wait, the runner finishes it */ }
      const line = (cursors: { cleared: number; keptChecking: number; keptLive: number; skipped: number }, flagged: boolean) => (deps.log ?? console.log)(
        `[memory] keep-all repair: owner-chat session marks removed=${denySessions} threads=${ownerThreads} open-jobs=${openJobs} cursors-cleared=${cursors.cleared} slices=${slices} drainLeft=${drainLeft} cursorsKeptChecking=${cursors.keptChecking} cursorsKeptLive=${cursors.keptLive} cursorsSkippedChanged=${cursors.skipped}${flagged ? "" : " (continues next start)"}`);
      // with marker work left no verdict is final: every cursor stays, no flag, the next start repeats (B2)
      if (drainLeft) { line({ cleared: 0, keptChecking: 0, keptLive: 0, skipped: 0 }, false); return "cursors-deferred"; }
      const cursors = deps.judgeAndClear();
      // a flush failure throws before the flag (3.5): no flag, the next start judges again
      deps.flush();
      if (!bounded) markUnwedged(db, dataDir, { denySessions, openJobs });
      line(cursors, !bounded);
      return bounded ? "bounded" : "repaired";
    } catch (error) {
      if (await retry(error)) continue;
      return gate.stopping ? "stopped" : "gave-up";
    }
  }
}
