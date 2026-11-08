// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 + r14.1 + flagfold + r15: the lineage warmer. It keeps, per thread, a RECORD that says whether the NEXT plain send's
// mandatory pre-engine lineage reads (E2 continuation of the retained session, E1 direct replay of the transcript window with E3 inside it)
// are already answered by what the VerdictStore keeps. "warm" is a statement about ONE confirmed footprint (r14 1D, r15 sec. 2), made only
// by a CLEAN CONFIRM (C5'): E2, then the recall reserve charged, then E1 at the least room, then E1 again at the most room (flagfold F2), on
// one turn allowance, every pass hit-only. Any doubt goes to today's path, never to a guessed warm: the turn always runs E2 and E1 exactly as
// at the tip; a covered turn only finds them to be lookups, and every other turn is counted.
//
// The record is invalidated through the store, never by guessing: W1 (the store's gen, lossOf for the thread and every foreign thread the
// trace names, proofLossOf per PROOF bucket, memoEpoch when the confirm used a memo, the authority stamp when it read a hold), W2 (nothing
// waits to be applied), W3 (the head is the confirmed head). An unclean confirm is classified (SHARED > OVER-ALLOWANCE > DEFERRED-ONLY > WORK,
// r14.1 X4): WORK runs E2 and E1 again under a background allowance (they keep what a turn would), DEFERRED-ONLY lets the proof scheduler
// run, and after CONFIRM_TRIES unclean confirms the record is RECOVERING with at most RECOVER_SLICES_MAX slices until the thread's next send.
// So the warmer's own work per record per send is bounded (<= 19 rounds), whatever the history.
//
// Per-turn work never scales with history: the turn's covered() predicate (W3') is a few index seeks and map lookups; the confirm reads the
// transcript WINDOW (turn-replay-inputs.ts), not the thread. The C7 BACKFILL (the tip's oldest-first reply walk) still runs, but only while
// no record has work and every protected resource has room (the store's growth-site guards refuse a write that would cross a threshold).
//
// It writes nothing to the database: it only judges, and what it judges is kept exactly like a verdict a turn reached. It is driven in short
// slices by the memory worker's idle loop (worker-controller.ts, EARLIEST WINS), which yields to the owner.
import { isPrepared as isThreadPrepared, prepareThread } from "../branch-store.ts";
import { database } from "../database.ts";
import { executionStore } from "../execution-audience.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import { authorityParts } from "./authority-epoch.ts";
import { continuationMemoryRevoked, filterDirectReplay } from "./disclosures.ts";
import { LineageAllowance, RECALL_RESERVE, TURN_LINEAGE_NODES } from "./lineage-allowance.ts";
import { accessStamp, externalUpdatesKey, footprintHash, setLineageFootprintRecords, type LineageFootprint, type UserKind } from "./lineage-footprint.ts";
import { denyGeneration } from "./deny-read.ts";
import { accessIncludesRoom, memoryAccessIsOwnerAudience, type MemoryAccess } from "./policy.ts";
import { readTimeRetired } from "./read-time-retired.ts";
import {
  advanceRootSetProofs, isLineageLimit, lineageConfirmCounters, lineageWantedPending, onProofActivationsExhausted, prepareLineageCache,
  rootSetProofsPending, setProofActivationContext, takeLineageWanted, warmReplies, warmRootSets, warmSession,
} from "./replay-lineage.ts";
import { memoryState } from "./repository.ts";
import { resumeCursorOf } from "./session-incarnation.ts";
import { turnReplayInputs, type ReplayLineIndex } from "./turn-replay-inputs.ts";
import { verdictStore as store, type ConfirmCounters, type MapName, type Trace, type TraceStamps } from "./verdict-store.ts";
import type { Message } from "../store.ts";

export type { LineageFootprint, UserKind };

// ---- constants (r14 C5'(4), sec. 3; r14.1 X2, X4) ----
/** Unclean confirms (kind WORK or DEFERRED-ONLY) per send before the record is RECOVERING. */
export const CONFIRM_TRIES = 3;
/** Background slices a RECOVERING record may use per send, confirming after each; past it, nothing until the thread's next send. */
export const RECOVER_SLICES_MAX = 16;
/** Foreign threads one trace may name (each one's lossOf is compared in W1). */
export const FOREIGN_MAX = 8;
/** Admitted (pinned) records at most. */
export const ADMIT_MAX = 32;
/** Confirms one warmer step runs at most, most recently sent first; a record confirms at most once per step (C8). */
export const CONFIRMS_PER_STEP = 4;
/** A record not sent on for this long is dropped (its pins and watches with it). */
export const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
/** A record whose confirm threw 3 times is parked this long. */
export const PARK_RETRY_MS = 60_000;
const PARK_AFTER_THROWS = 3;
/** CLEAN: E2 + E1 spent at most half of the turn's nodes (the other half is the recall reserve, sec. 1E). */
const CONFIRM_NODES_MAX = TURN_LINEAGE_NODES / 2;
/** Proof-scheduler activations per record per send (flagfold F6): the same 19-round bound. */
const PROOF_ACTIVATIONS = CONFIRM_TRIES + RECOVER_SLICES_MAX;

/** Replies judged together in one backfill slice (the same chunk the replay judges in). */
const REPLY_CHUNK = 64;
/** Lineage work one slice may spend before it is split or its allowance grown. */
let SLICE_NODES = 600;
/** The most one slice is ever allowed; one that moves nothing even with this is parked (the turn path withholds that line). */
let SLICE_NODES_MAX = 9_600;
/** Tests shrink the slices to reach the paths that need several of them; nulls restore the real ones. */
export function setLineageWarmSlicesForTest(base: number | null, max: number | null): void { SLICE_NODES = base ?? 600; SLICE_NODES_MAX = max ?? 9_600; }
/** How long one call of the warmer works before it hands the event loop back. */
const SLICE_MS = 50;
/** Messages looked at per page of a thread's message scan. */
const SCAN_PAGE = 1024;
/** The page actually read is adaptive, SCAN_PAGE_MIN up to SCAN_PAGE: one that took longer than SCAN_PAGE_TARGET_MS is halved for the next, one
 *  much quicker doubled back (rc13 real-data run: a page of this scan read 217 ms beside the upgrade). */
export const SCAN_PAGE_TARGET_MS = 20;
const SCAN_PAGE_MIN = 32;
let scanRows = SCAN_PAGE;
/** The rows the next page reads (tests). */
export function lineageScanPageRows(): number { return scanRows; }
/** Threads found per discovery step. */
const DISCOVER_STEP = 32;
/** Slices in a row that moved something and still did not finish one batch: the batch is parked rather than retried for ever. */
const MOVES_MAX = 20_000;

/** The clock the records and the park retry read (tests drive it: the clock rule). */
let clock: () => number = () => Date.now();

// ---- the confirm's sources (r15 sec. 2; L2 seam) ----
/** Mints the turn's MemoryAccess for (botId, threadId), as the turn does (index.ts turnMemoryAccess). Registered by index.ts. */
export type LineageAccessMint = (botId: string, threadId: string) => MemoryAccess | null;
/** The task row the next turn resumes from (task.resumeCursors / resumeIncarnations, IX:12536-12539). */
export type LineageTaskRow = { resumeCursors?: Record<string, unknown>; resumeIncarnations?: Record<string, number>; externalUpdates?: string[] };
export interface LineageConfirmSources {
  mint: LineageAccessMint | null;
  lines: () => ReplayLineIndex | null;
  task: (threadId: string) => LineageTaskRow | null;
  /** whether the thread's branch and line indexes are complete (r15.1 Y3); false starts the fill and the record waits */
  prepared: (threadId: string) => boolean;
}
const preparing = new Set<string>();
/** The mint index.ts registered (kept across test source swaps). */
let registeredMint: LineageAccessMint | null = null;
const productionSources = (): LineageConfirmSources => ({
  mint: registeredMint,
  prepared: threadId => {
    if (isThreadPrepared(threadId)) return true;
    if (!preparing.has(threadId)) {
      preparing.add(threadId);
      void prepareThread(threadId).catch(() => {}).finally(() => { preparing.delete(threadId); const rec = records.get(threadId); if (rec) rec.due = true; wake(); });
    }
    return false;
  },
  lines: () => executionStore() ?? null,
  task: threadId => {
    const bots = executionStore()?.bots ?? [];
    for (const bot of bots) for (const task of bot.tasks ?? []) if (task.threadId === threadId) return task as LineageTaskRow;
    return null;
  },
});
let sources: LineageConfirmSources = productionSources();
/** index.ts registers the turn's own mint at boot. With none, every confirm reads "checking: inputs" (no production fallback, r15). */
export function setLineageAccessMint(mint: LineageAccessMint | null): void { registeredMint = mint; sources.mint = mint; }
/** Test seam (lineageWarmTestSurface().useSources): replaces the mint, the line index and the task rows; null restores production. */
export function setLineageConfirmSourcesForTest(next: Partial<LineageConfirmSources> | null): void {
  sources = next ? { ...productionSources(), ...next } : productionSources();
}

// ---- records (r14 C2, r15 sec. 2) ----
export type Outcome = "OVERSIZE" | "RECOVERING" | "SHARED" | null;
/** What one confirm pass (or a real-entry probe) read and spent. */
export interface ConfirmCounts {
  misses: number; listings: number; remember: number; holdWrites: number; handleMisses: number; memoMisses: number; merges: number;
  deferred: number; unfinished: number; deferredUnfinished?: number; ownLosses: number; hit: boolean; nodes: number; clean: boolean;
  revoked: boolean; withheld: string[]; order: Array<"E2" | "E1">;
  /** the confirm's E1 headSlot (1) and its two passes (flagfold F2); a probe has headSlot 0 and no passes */
  headSlot: number; passes: ConfirmPass[];
}
/** flagfold F2: one E1 pass of the confirm (producers branches are recorded by replay-lineage.ts when it reports them). */
export interface ConfirmPass { room: "least" | "most"; clean: boolean; branches: Record<string, "listing" | "groups" | "pairs"> }
interface WarmRecord {
  thread: string;
  /** the footprint the next confirm runs on (the turn's last recorded F) */
  footprint: LineageFootprint | null;
  /** the CONFIRMED snapshot: fp of the footprint the clean confirm ran on (its cursor read from the task row), or null */
  footprintHash: string | null;
  /** the head (messages rowid) the clean confirm proved, or null ("pending") */
  confirmedAt: number | null;
  outcome: Outcome;
  reason: string | null;
  confirmRounds: number;
  /** consecutive unclean confirms (a clean one resets it): CONFIRM_TRIES of them in a row make the record RECOVERING (T12 usefulness) */
  uncleanRun: number;
  recoverSlices: number;
  admitted: boolean;
  /** the clean confirm's trace and stamps (W1) */
  trace: Trace | null;
  stamps: TraceStamps | null;
  holdStamp: string | null;
  /** the raw epochs at the clean confirm (W3'(4), r15.1 Y1) */
  applied: ReturnType<typeof rawEpochs>;
  /** the transcript anchor at the clean confirm (W3'(2), r15.1 Y2) */
  anchor: Anchor | null;
  /** threads this record watches (own + foreign) */
  watching: Set<string>;
  traceSize: number;
  closureEdges: number;
  /** send order (C-BUDGET demotion: least recently sent first) */
  lastSent: number;
  /** the record wants a confirm (a moved counter, a send, a note): one bit, however many events moved it (C8) */
  due: boolean;
  /** DEFERRED-ONLY: waiting for the proof scheduler */
  waitingProof: boolean;
  sliceNodes: number;
  throws: number;
  parkedUntil: number;
  touched: number;
  lastConfirm: ConfirmCounts | null;
  /** flagfold F6: proof-scheduler activations left this send (reset by a send, 0 once exhausted) */
  activations: number;
  /** the windows the last confirm's replay loop read (tests: T15(h4)) */
  windows: LineageWindowTrace[] | null;
}
const records = new Map<string, WarmRecord>();
/** thread -> records whose W1 compares its lossOf (own and foreign), so a loss marks exactly those due */
const watchers = new Map<string, Set<string>>();
let sendSeq = 0;
const counters = {
  confirms: 0, cleanConfirms: 0, judgeSlices: 0, confirmsPerStepMax: 0, confirmsPerRecordPerStepMax: 0, warmAllowanceHit: 0, footprintMatch: 0,
  footprintMiss: 0, coveredMissByClause: noClauseMisses(),
  pinnedEvictions: 0, demotions: 0,
};

function freshRecord(thread: string): WarmRecord {
  return {
    thread, footprint: null, footprintHash: null, confirmedAt: null, outcome: null, reason: null, confirmRounds: 0, uncleanRun: 0, recoverSlices: 0, admitted: false,
    trace: null, stamps: null, holdStamp: null, applied: null, anchor: null, watching: new Set(), traceSize: 0, closureEdges: 0, lastSent: 0, due: true,
    waitingProof: false, sliceNodes: SLICE_NODES, throws: 0, parkedUntil: 0, touched: clock(), lastConfirm: null, activations: PROOF_ACTIVATIONS, windows: null,
  };
}
function recordOf(thread: string): WarmRecord {
  let rec = records.get(thread);
  if (!rec) { records.set(thread, rec = freshRecord(thread)); watchThread(rec, thread); }
  return rec;
}
function watchThread(rec: WarmRecord, thread: string): void {
  if (rec.watching.has(thread)) return;
  rec.watching.add(thread); store.watch(thread);
  let set = watchers.get(thread);
  if (!set) watchers.set(thread, set = new Set());
  set.add(rec.thread);
}
function unwatchThread(rec: WarmRecord, thread: string): void {
  if (!rec.watching.delete(thread)) return;
  store.unwatch(thread);
  const set = watchers.get(thread);
  set?.delete(rec.thread);
  if (set && !set.size) watchers.delete(thread);
}
/** The record is no longer covered: confirmedAt := none (fail closed) and it wants a confirm. */
function invalidate(rec: WarmRecord): void { rec.confirmedAt = null; rec.due = true; }
function demote(rec: WarmRecord, reason: string): void {
  if (!rec.admitted) return;
  store.unpin(rec.thread);
  rec.admitted = false; rec.reason = reason; counters.demotions++;
  demotionLog.push(rec.thread);
  if (demotionLog.length > 1024) demotionLog.splice(0, demotionLog.length - 1024);
}
/** Demoted threads in order, oldest first (T14(c); bounded). */
const demotionLog: string[] = [];
export function lineageDemotionsForTest(): string[] { return [...demotionLog]; }
/** The verdict keys a record's confirm trace read (tests: the lost-window-key fixture). */
export function lineageTraceKeysForTest(thread: string): string[] { return [...(records.get(thread)?.trace?.keys.verdicts ?? [])]; }
/** Tests (T14(c)): the threadGroupStore entries a record's admitted trace names. */
export function lineageTraceGroupsForTest(thread: string): string[] { return [...(records.get(thread)?.trace?.keys.threadGroupStore ?? [])]; }
function dropRecord(rec: WarmRecord): void {
  demote(rec, "dropped");
  for (const thread of [...rec.watching]) unwatchThread(rec, thread);
  records.delete(rec.thread);
}
store.onLoss(thread => { for (const id of watchers.get(thread) ?? []) { const rec = records.get(id); if (rec) rec.due = true; } });
store.onAllPinned(map => {
  // the all-pinned guard (sec. 3): the least recently sent admitted record pinning in `map` is demoted, then the eviction proceeds
  let victim: WarmRecord | undefined;
  for (const id of store.pinnedRecords(map)) { const rec = records.get(id); if (rec && (!victim || rec.lastSent < victim.lastSent)) victim = rec; }
  if (!victim) return false;
  counters.pinnedEvictions++;
  demote(victim, "not kept"); invalidate(victim);
  return true;
});
onProofActivationsExhausted(thread => {
  const rec = records.get(thread);
  if (!rec) return;
  rec.outcome = "RECOVERING"; rec.reason = "recovering: exhausted"; rec.recoverSlices = RECOVER_SLICES_MAX; rec.waitingProof = false; rec.activations = 0;
});

// ---- head, W1, W2 ----
/** The thread's newest stored row (an index seek): its rowid is the head the confirm proves. */
function headOf(thread: string): { seq: number; id: string } | null {
  const row = database().prepare("SELECT rowid AS r, id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(thread);
  return row ? { seq: Number(row.r), id: String(row.id) } : null;
}
/** The row before `seq` in the thread (r15 W3'(2): the confirmed head is the one right before U). */
function headBefore(thread: string, seq: number): number | null {
  const row = database().prepare("SELECT rowid AS r FROM messages WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT 1").get(thread, seq);
  return row ? Number(row.r) : null;
}
/** W1: every stamp the clean confirm wrote still holds. */
function stampsHold(rec: WarmRecord): boolean {
  const s = rec.stamps;
  if (!s) return false;
  if (store.gen() !== s.gen) return false;
  for (const [thread, seen] of Object.entries(s.lossSeen)) if (store.lossOf(thread) !== seen) return false;
  for (const [bucket, seen] of Object.entries(s.proofSeen)) if (store.proofLossOf(Number(bucket)) !== seen) return false;
  // r15 epoch split, handle half (L1; the forgets half waits on TCFO r3): memoEpoch() === handleEpoch()
  if ((rec.trace?.usedHandles || rec.trace?.usedMemos) && store.handleEpoch() !== s.handleEpoch) return false;
  if (rec.trace?.holdRead && authorityParts()?.stamp !== rec.holdStamp) return false;
  return true;
}
/** Which W1 stamp moved (diagnostics in the state string only). */
function stampMiss(rec: WarmRecord): string {
  const s = rec.stamps;
  if (!s) return "none";
  if (store.gen() !== s.gen) return "gen";
  for (const [thread, seen] of Object.entries(s.lossSeen)) if (store.lossOf(thread) !== seen) return `loss ${thread}`;
  for (const [bucket, seen] of Object.entries(s.proofSeen)) if (store.proofLossOf(Number(bucket)) !== seen) return `proof ${bucket}`;
  if ((rec.trace?.usedHandles || rec.trace?.usedMemos) && store.handleEpoch() !== s.handleEpoch) return "handles";
  return "hold";
}
/** W2 against the store's applied state: what committed since the last look is applied now (the dirty keys drop what rests on them, moving
 * lossOf), so W1 then sees it. Inside a transaction nothing can be applied (its writes may roll back): not applied. */
const lineageStore = {
  applied(): boolean {
    if (database().isTransaction) return false;
    prepareLineageCache();
    return true;
  },
};
/** Reasons that stop the confirm until a new note, a send or the branch fill (they are "checking", never "pending"). */
const BLOCKED = /^(kind|access|inputs|branch|revoked)/;
/** Tests only (the r14 real-entry file notes no footprint): the footprint an un-noted record confirms on. Production: none (no guessed F). */
let defaultFootprint: ((thread: string) => LineageFootprint | null) | null = null;
export function setLineageDefaultFootprintForTest(make: ((thread: string) => LineageFootprint | null) | null): void { defaultFootprint = make; }
function needsWork(rec: WarmRecord): boolean {
  if (!rec.footprint && defaultFootprint) rec.footprint = defaultFootprint(rec.thread);
  if (!rec.footprint || rec.parkedUntil > clock()) return false;
  if (rec.outcome === "OVERSIZE" || rec.outcome === "SHARED") return false;
  if (rec.outcome === "RECOVERING" && rec.recoverSlices >= RECOVER_SLICES_MAX) return false;
  if (rec.reason && BLOCKED.test(rec.reason)) return rec.due;
  if (rec.due || rec.confirmedAt === null || !stampsHold(rec) || store.redoOf(rec.thread).length || store.redoOverflow(rec.thread)) return true;
  const head = headOf(rec.thread);
  return !head || head.seq !== rec.confirmedAt;
}

/** r14 C5 precedence: "retired" | "checking: <reason>" | "pending" | "warm". A reader: it runs no lineage work (it may apply pending dirty keys). */
export function lineageThreadState(thread: string): string {
  try {
    if (readTimeRetired(database())) return "retired";
    const rec = records.get(thread);
    if (!rec) return "pending";
    if (rec.parkedUntil > clock()) return "checking: parked";
    if (rec.outcome === "OVERSIZE") return `checking: oversize (${rec.reason ?? ""})`;
    if (rec.outcome === "SHARED") return "checking: shared";
    if (rec.outcome === "RECOVERING") return "checking: recovering";
    if (rec.reason && BLOCKED.test(rec.reason)) return `checking: ${rec.reason}`;
    if (!rec.footprint || rec.confirmedAt === null) return "pending: unconfirmed";
    // W2: nothing waits to be applied
    {
      const store = lineageStore;
      // MUTANT:c5-skips-w2
      if (!store.applied()) return "pending: unapplied";
    }
    if (!stampsHold(rec)) { rec.due = true; return `pending: stamps (${stampMiss(rec)})`; }
    // T12 s3: W3'(4) exactly as lineageTurnCovered runs it (raw epochs, then every pending row through the S1 allowlist), so "warm" never
    // reads where the next send's compare misses. No user line exists yet: "" admits no m|t|U row; the anchor's s row is still allowlisted.
    {
      const w2 = w2Applied(rec, "");
      if (w2 !== "ok") { rec.due = true; return `pending: ${w2}`; }
    }
    if (store.redoOf(thread).length || store.redoOverflow(thread)) { rec.due = true; return "pending: redo"; }
    const head = headOf(thread);
    if (!head || head.seq !== rec.confirmedAt) { rec.due = true; return "pending: head"; }
    if (!rec.admitted) return `checking: not kept (${rec.reason ?? ""})`;
    return "warm";
  } catch {
    return "checking: degraded";
  }
}

// ---- the turn's side (r15 sec. 2) ----
/** The owner's own direct chat (DI:550): any other reader is SHARED (decided from F's access, before the pass). */
function ownerDirectAccess(threadId: string, access: MemoryAccess): boolean {
  return threadId === access.threadId && memoryAccessIsOwnerAudience(access) && !accessIncludesRoom(access) && isWorkspaceOwner(threadHumanPrincipal(threadId));
}
/** r15: only a plain APPENDED send without a project card run is ever confirmed. */
const eligibleKind = (f: LineageFootprint) => (f.userKind ?? "APPENDED") === "APPENDED" && f.projectCardRun !== true;
/** The raw epochs W2 compares (r15.1 Y1): the lineage epoch, the structure epoch, the authority stamp and other connections' data_version. */
// (TCFO r3 deletes the lineage_forgets counter: not compared here, per the TURNSTART lead 11-07.)
function rawEpochs(): { epoch: number; structure: number; authority: string | null; deny: number; version: number } | null {
  try {
    const db = database();
    const row = db.prepare("SELECT (SELECT n FROM temp.lineage_epoch) AS epoch, (SELECT n FROM temp.lineage_structure) AS structure, (SELECT data_version FROM pragma_data_version) AS version").get();
    if (!row) return null;
    return { epoch: Number(row.epoch), structure: Number(row.structure), authority: authorityParts()?.stamp ?? null, deny: denyGeneration(db), version: Number(row.version) };
  } catch { return null; }
}
/** r15.1 Y1: every raw epoch equals the value the clean confirm ran under (the store was applied then and the confirm wrote nothing), and no
 * transaction is open. An epoch-only change with no dirty row (a messages DELETE) fails it. */
function epochsApplied(rec: WarmRecord, failed: (clause: "epochs" | "recapture-authority") => void): boolean {
  if (database().isTransaction || !rec.applied) { failed("epochs"); return false; }
  const now = rawEpochs();
  if (now === null) { failed("epochs"); return false; }
  const a = rec.applied;
  if (now.epoch !== a.epoch || now.structure !== a.structure || now.deny !== a.deny || now.version !== a.version) {
    failed("epochs"); return false;
  }
  // Fable r15.1: the ON CONFLICT re-capture UPDATE moves the authority stamp (AE:52 SOFT_BUMP); its own miss kind
  if (now.authority !== a.authority) { failed("recapture-authority"); return false; }
  return true;
}
const SEP = "\u001f";
/** Past this many pending dirty rows the turn is ineligible (r15.1 Y1 PENDING_CHECK_MAX). */
const PENDING_CHECK_MAX = 64;
/** How many dependents a pending row's walk may visit before it counts as touching the trace (a doubt). */
const NOTE_WALK_MAX = 256;
/** Whether the pending dirty row `key` may make the turn ineligible: true unless it is an ALLOWLISTED row (S1) that the dependents test
 * clears (the verdicts that consulted it and, through their v-edges, what rests on them; bounded, past the bound a doubt). */
function noteTouchesTrace(key: string, rec: WarmRecord, userMessageId: string): boolean {
  const trace = rec.trace;
  if (!trace) return true;
  // Grok r15.1 S1 ALLOWLIST: only this thread's own rows, m|t|U and s|message:t:X with X = U or the previous bot reply (the anchor, which
  // the IX:12707 catch-up captures). Every other row is ineligible with NO dependents fallback: k (drainDirty rewrites k -> r, RL:1884),
  // d (never enters the graph, RL:1881), c, r, x, f, b, unparseable, another thread's.
  // MUTANT:allow-unlisted-kind
  switch (noteArm(key, rec, userMessageId)) {
    case "own-message":
    case "own-source":
      // L1 Y5: the store's own walk (dependents by dependency key, then v-edges upward, as dropDependents drops); over the cap: true (a doubt)
      return store.touchesTrace(trace, key, NOTE_WALK_MAX);
    default:
      return true; // INELIGIBLE
  }
}
/** S1 (MurageMain 18:01Z: an enum whose DEFAULT arm is INELIGIBLE): the arm a pending row takes. Only two arms continue to the dependents
 * check: "own-message" = exactly m|<t>|<U>; "own-source" = exactly s|message:<t>:<X>, X = U or the anchor (the previous bot reply). Every
 * other row (any other kind, shape, thread or id, or unparseable) is "ineligible". */
type NoteArm = "own-message" | "own-source" | "ineligible";
function noteArm(key: string, rec: WarmRecord, userMessageId: string): NoteArm {
  const parts = key.split(SEP);
  switch (parts[0]) {
    case "m":
      return parts.length === 3 && parts[1] === rec.thread && parts[2] === userMessageId ? "own-message" : "ineligible";
    case "s":
      return parts.length === 2 && (parts[1] === `message:${rec.thread}:${userMessageId}` || (rec.anchor !== null && parts[1] === `message:${rec.thread}:${rec.anchor.id}`))
        ? "own-source" : "ineligible";
    default:
      return "ineligible";
  }
}
/** W3'(4) = r14 W2 in full (r15.1 Y1); only pending dirty rows are relaxed, each by the S1 allowlist and the dependents test. Returns the failing
 * clause or "ok". */
function w2Applied(rec: WarmRecord, userMessageId: string): "ok" | "epochs" | "recapture-authority" | "dirty" {
  let clause: "epochs" | "recapture-authority" = "epochs";
  // MUTANT:w2-epochs-dropped
  const epochs = epochsApplied(rec, c => { clause = c; });
  if (!epochs) return clause;
  const notes = database().prepare("SELECT DISTINCT k FROM temp.lineage_dirty LIMIT ?").all(PENDING_CHECK_MAX + 1);
  if (notes.length > PENDING_CHECK_MAX) return "dirty";
  for (const note of notes) {
    if (typeof note.k !== "string") return "dirty";
    // MUTANT:w2-any-note
    if (noteTouchesTrace(note.k, rec, userMessageId)) return "dirty";
  }
  return "ok";
}
/** r15.1 Y2: the transcript anchor of the clean confirm, the newest row of t at h. */
interface Anchor { rowid: number; id: string }
function anchorOf(thread: string): Anchor | null {
  const row = database().prepare("SELECT rowid AS r, id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(thread);
  return row ? { rowid: Number(row.r), id: String(row.id) } : null;
}
/** W3'(2) (r15.1 Y2): (a) exactly one row of t after the anchor, and it is U; (b) U's parent is the anchor; (c) U has nonempty text; (d) the
 * anchor row is unchanged. Two index seeks; other threads' writes play no part. */
function anchorAdjacent(thread: string, rec: WarmRecord, userMessage: { id: string }): boolean {
  const anchor = rec.anchor;
  if (!anchor) return false;
  const after = database().prepare("SELECT id, text, json FROM messages WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT 2").all(thread, anchor.rowid);
  if (after.length !== 1 || String(after[0]!.id) !== userMessage.id) return false;
  if (typeof after[0]!.text !== "string" || !after[0]!.text) return false;
  let parent: unknown;
  try { parent = (JSON.parse(String(after[0]!.json ?? "{}")) as { parentId?: unknown }).parentId; } catch { return false; }
  if (parent !== anchor.id) return false;
  // identity only (the same id at that rowid): unchanged CONTENTS are W1/W2's (same-id replace notes RL:1847-1854), never this check's
  const held = database().prepare("SELECT id FROM messages WHERE thread_id=? AND rowid=?").get(thread, anchor.rowid);
  return held !== undefined && String(held.id) === anchor.id;
}
/** The r15 head test (the confirmed head right before U), kept ONLY for the anchor-is-seq mutant. */
function seqAdjacent(thread: string, rec: WarmRecord, userMessage: { id: string }): boolean {
  const head = headOf(thread);
  return head !== null && head.id === userMessage.id && headBefore(thread, head.seq) === rec.confirmedAt;
}
void seqAdjacent;
/** W3', the TURN's predicate at IX:13283 (r15 sec. 2 + r15.1), all of (1)-(6). O(1) in the thread's history: a few index seeks and map lookups. */
export function lineageTurnCovered(thread: string, userMessage: { id: string; seq?: number }, footprint: LineageFootprint): "match" | "APPENDED-changed" | "not-covered" {
  const miss = (clause: CoveredClause): "not-covered" => { counters.coveredMissByClause[clause]++; return "not-covered"; };
  try {
    const rec = records.get(thread);
    if (!rec || !eligibleKind(footprint)) return miss("kind");                           // (1) kind (the caller counts the kind itself)
    if (memoryState().mode !== "active") return miss("kind");                            // (1) floor (memoryLastResort: the caller's own F1 check)
    if (rec.confirmedAt === null || rec.footprintHash === null) return miss("admitted");
    // MUTANT:anchor-is-seq
    if (!anchorAdjacent(thread, rec, userMessage)) return miss("adjacency");             // (2) U right after the anchor
    if (!stampsHold(rec)) return miss("stamps");                                          // (3) W1
    const w2 = w2Applied(rec, userMessage.id);                                                           // (4) W2 in full, dirty rows by the dependents test
    if (w2 !== "ok") return miss(w2);
    if (!rec.admitted || rec.outcome !== null || rec.waitingProof || rec.parkedUntil > clock()) return miss("admitted"); // (5)
    if (store.redoOf(thread).length || store.redoOverflow(thread)) return miss("admitted");
    if (footprintHash(footprint) === rec.footprintHash) return "match";                   // (6)
    counters.coveredMissByClause.fp++;
    return "APPENDED-changed";
  } catch {
    return miss("error");
  }
}
/** Fable r15.1 (2): W3' misses broken down by the clause that failed, so R1 can tell which one. "recapture-authority" is the authority stamp
 * moved by the ON CONFLICT re-capture UPDATE (AE:52); INSERT OR REPLACE gives U a new rowid, which fails "adjacency". */
type CoveredClause = "kind" | "adjacency" | "stamps" | "epochs" | "recapture-authority" | "dirty" | "admitted" | "fp" | "error";
function noClauseMisses(): Record<CoveredClause, number> {
  return { kind: 0, adjacency: 0, stamps: 0, epochs: 0, "recapture-authority": 0, dirty: 0, admitted: 0, fp: 0, error: 0 };
}
/** noteLineageFootprint (IX:13283, after the compare): rec.footprint := F; if fp changed, confirmedAt := none and a wake. O(1). */
export function noteLineageFootprint(thread: string, footprint: LineageFootprint, hash = footprintHash(footprint)): void {
  const rec = recordOf(thread);
  rec.touched = clock();
  // a non-APPENDED turn (or a project card run) is never covered and never confirmed on: the record keeps the last plain F it proves the
  // next plain send for (its head moved, so it re-confirms); with no plain F yet it waits ("checking: kind")
  if (!eligibleKind(footprint)) {
    if (!rec.footprint) { rec.reason = "kind"; rec.confirmedAt = null; return; }
    rec.due = true; wake(); return;
  }
  rec.footprint = { ...footprint, exclude: [...footprint.exclude] };
  if (rec.reason && BLOCKED.test(rec.reason)) rec.reason = null;
  if (hash !== rec.footprintHash) invalidate(rec);
  wake();
}
setLineageFootprintRecords({
  covered: (thread, userMessage, footprint) => lineageTurnCovered(thread, userMessage, footprint),
  note: (thread, footprint, hash) => noteLineageFootprint(thread, footprint, hash),
});

// ---- the confirm (C5', r14.1 X2, flagfold F2, r15 sec. 3) ----
/** The session the next turn resumes, from the task row at confirm time (r15): the recorded F supplies only the instance and whether it resumed. */
function confirmCursor(thread: string, f: LineageFootprint): { instanceId: string; nativeSession: string; incarnation: number } | null {
  const task = sources.task(thread);
  // the instance is F's; a turn that did not resume (turn N created the session) names none, and the next turn resumes the task row's one
  // cursor (T15(l)); more than one with no instance named is a doubt: no cursor (the hash then differs from a resuming turn's: a miss)
  const named = f.cursor?.instanceId ?? null;
  const entries = Object.keys(task?.resumeCursors ?? {});
  const instanceId = named ?? (entries.length === 1 ? entries[0]! : null);
  if (instanceId === null) return null;
  const raw = task?.resumeCursors?.[instanceId];
  if (raw === undefined || raw === null || raw === "") return null;
  // the turn's F carries the same resumeCursorOf(...) as the turn: the incarnation-keyed id and resumeIncarnation ?? 0 (IX:13271)
  const incarnation = task?.resumeIncarnations?.[instanceId];
  return resumeCursorOf(thread, instanceId, String(raw), incarnation);
}
/** E1's inputs: the turn's widening loop with headSlot (1 for the confirm: the next send's U is not yet there; 0 for a turn), skip = exclude. */
/** One window of the widening loop as it was read (r15.1 Y4 T15(h4)); `window` is the turn's window W (the confirm reads W - headSlot).
 * skip/held/asked are those of the stopping window (the loop decides them there); earlier windows carry them empty. */
export interface LineageWindowTrace { window: number; loaded: string[]; hasMore: boolean; skip: string[]; held: string[]; asked: string[][] }
export function lineageReplayInputs(thread: string, f: LineageFootprint, headSlot: 0 | 1, extraSkip: readonly string[] = []): { messages: Message[]; skip: Set<string>; exact: boolean; windows: LineageWindowTrace[] } | null {
  const source = sources.lines();
  if (!source) return null;
  const windows: LineageWindowTrace[] = [];
  const lines: ReplayLineIndex = {
    activeTextLines(threadId: string, limit: number) {
      const read = source.activeTextLines(threadId, limit);
      windows.push({ window: limit + headSlot, loaded: read.messages.map(m => m.id), hasMore: read.hasMore, skip: [], held: [], asked: [] });
      return read;
    },
  };
  let updates: string[] = [];
  if (f.externalUpdates) { try { const parsed = JSON.parse(f.externalUpdates) as unknown; if (Array.isArray(parsed)) updates = parsed.map(String); } catch { updates = f.externalUpdates.split(",").filter(Boolean); } }
  const args = {
    store: lines, threadId: thread, botId: f.botId, routeHasTools: f.routeHasTools, externalUpdates: updates, floor: null, projectCardRun: false,
    skip: new Set([...f.exclude, ...extraSkip]), replayOptions: replayOptionsOf(f), headSlot,
  };
  const result = turnReplayInputs(args);
  // Fable r15.1 (4): "checking: branch" takes L3's exact flag (every window read exactly), never hasMore. L3 reads an index that does not
  // say as not exact; so does this.
  const exact = (result as { exact?: unknown }).exact === true;
  const last = windows.at(-1);
  if (last) { last.skip = [...result.skip].sort(); last.held = [...result.heldReplayIds].sort(); last.asked = [result.replayedMessages.map(m => m.id)]; }
  return { messages: result.activeMessages, skip: result.skip, exact, windows };
}
const counterDelta = (before: ConfirmCounters, after: ConfirmCounters) => ({
  misses: after.misses - before.misses, listings: after.listings - before.listings, remember: after.remembers - before.remembers,
  holdWrites: after.holdWrites - before.holdWrites, handleMisses: after.handleMisses - before.handleMisses, memoMisses: after.memoMisses - before.memoMisses,
  merges: after.merges - before.merges, deferred: after.deferred - before.deferred, unfinished: after.unfinished - before.unfinished,
  deferredUnfinished: after.deferredUnfinished - before.deferredUnfinished,
});
/** Tests (the "spend" fixture): per thread, what E2 + E1 cost in all, as if its window cost that much (E1 is padded up to it). */
const e1TargetNodes = new Map<string, number>();
export function setLineageE1NodesForTest(thread: string, nodes: number | null): void { if (nodes === null) e1TargetNodes.delete(thread); else e1TargetNodes.set(thread, nodes); }
/** Pads `allowance` so that what was spent since `base` is the thread's test target (no-op in production). */
function padForTest(allowance: LineageAllowance, thread: string, base: number): void {
  const target = e1TargetNodes.get(thread);
  if (target === undefined) return;
  const more = target - (allowance.spent - base);
  if (more > 0 && !charged(() => allowance.spendNodes(thread, more))) allowance.hit = true;
}
/** One E1 pass: filterDirectReplay on the inputs (E3 inside), the limit error read as `hit`. */
/** F's replay options (IX:12346): maxBytes -1 is the turn's "no model budget" (replayBudgetBytes undefined). */
const replayOptionsOf = (f: LineageFootprint) => ({ maxBytes: f.maxBytes >= 0 ? f.maxBytes : undefined, minLines: f.minLines });
function e1(allowance: LineageAllowance, thread: string, access: MemoryAccess, inputs: { messages: Message[]; skip: Set<string> }, f: LineageFootprint): string[] {
  try {
    const result = filterDirectReplay(allowance, thread, inputs.messages, access, inputs.skip, replayOptionsOf(f));
    return [...result.withheld];
  } catch (error) {
    if (!isLineageLimit(error)) throw error;
    allowance.hit = true;
    return [];
  }
}
function e2(allowance: LineageAllowance, thread: string, access: MemoryAccess, cursor: { instanceId: string; nativeSession: string; incarnation: number }): boolean {
  try { return continuationMemoryRevoked(allowance, thread, cursor.instanceId, cursor.nativeSession, access); }
  catch (error) { if (!isLineageLimit(error)) throw error; allowance.hit = true; return true; }
}
/** C5'(1)-(2): ONE turn allowance; E2 on the task row's cursor; the RECALL_RESERVE charge; E1 at the least room; E1 again at the most room.
 * Synchronous (T11(k)): no loss can land between a read and the stamps taken after the pass. */
function confirmPass(rec: WarmRecord, f: LineageFootprint, access: MemoryAccess, inputs: { messages: Message[]; skip: Set<string> }, cursor: ReturnType<typeof confirmCursor>): { counts: ConfirmCounts; trace: Trace } {
  const before = lineageConfirmCounters();
  const order: Array<"E2" | "E1"> = [];
  const passes: ConfirmPass[] = [];
  let revoked = false, withheld: string[] = [];
  const allowance = LineageAllowance.turn();
  const most = LineageAllowance.turn();
  store.openTrace(rec.thread);
  let trace: Trace | null = null;
  setProofActivationContext({ record: rec.thread, budget: Math.max(1, rec.activations) });
  try {
    if (cursor) { order.push("E2"); revoked = e2(allowance, rec.thread, access, cursor); }
    // the most-room pass starts where E2 left the turn: E2's own nodes spent, no recall charge
    if (!charged(() => most.spend(allowance.spent))) most.hit = true;
    // the recall reserve: the overlapped recall at its maximum, spent before E1 (r14.1 X2: E1 is proven at the least room a turn can have)
    // MUTANT:no-reserve-charge
    if (!charged(() => allowance.spend(RECALL_RESERVE))) allowance.hit = true;
    order.push("E1");
    const atLeast = lineageConfirmCounters();
    const leastBranches: ConfirmPass["branches"] = {}, mostBranches: ConfirmPass["branches"] = {};
    branchRecorder = { thread: rec.thread, branches: leastBranches, n: 0 };
    withheld = e1(allowance, rec.thread, access, inputs, f);
    padForTest(allowance, rec.thread, RECALL_RESERVE);
    const atMost = lineageConfirmCounters();
    branchRecorder = { thread: rec.thread, branches: mostBranches, n: 0 };
    const most1 = e1(most, rec.thread, access, inputs, f);
    branchRecorder = null;
    padForTest(most, rec.thread, 0);
    const passClean = (d: ReturnType<typeof counterDelta>, hit: boolean) => !hit && Object.values(d).every(n => n === 0);
    passes.push({ room: "least", clean: passClean(counterDelta(atLeast, atMost), allowance.hit), branches: leastBranches });
    passes.push({ room: "most", clean: passClean(counterDelta(atMost, lineageConfirmCounters()), most.hit), branches: mostBranches });
    // the two extremes must answer alike (they judge the same lines; a difference is a doubt)
    if (most1.length !== withheld.length || most1.some(id => !withheld.includes(id))) most.hit = true;
  } finally {
    branchRecorder = null;
    setProofActivationContext(null);
    trace = store.closeTrace();
  }
  const delta = counterDelta(before, lineageConfirmCounters());
  const nodes = Math.max(allowance.spent - RECALL_RESERVE, most.spent);
  const c = { ...delta, ownLosses: trace!.ownLosses, hit: allowance.hit || most.hit, nodes };
  const clean =
    c.misses === 0 && c.listings === 0 &&
    // MUTANT:confirm-writes-allowed
    c.remember === 0 &&
    // MUTANT:merges-allowed
    c.merges === 0 &&
    // MUTANT:unfinished-ignored
    c.unfinished === 0 &&
    c.holdWrites === 0 && c.handleMisses === 0 && c.memoMisses === 0 && c.deferred === 0 && c.ownLosses === 0 && !c.hit && c.nodes <= CONFIRM_NODES_MAX;
  return { counts: { ...c, clean, revoked, withheld, order, headSlot: 1, passes }, trace: trace! };
}
/** flagfold F2: the producers branch each room-dependent decision of the current E1 pass took, in decision order (d0, d1, ...). */
let branchRecorder: { thread: string; branches: ConfirmPass["branches"]; n: number } | null = null;
/** Tests wire RL's per-pass branch recorder (onProducerBranchForTest) here; outside a confirm pass it records nothing. */
export function lineageNoteProducerBranch(thread: string, branch: "listing" | "groups" | "pairs"): void {
  if (branchRecorder && branchRecorder.thread === thread) branchRecorder.branches[`d${branchRecorder.n++}`] = branch;
}
/** A charge with no read behind it: false when it did not fit (the allowance is then spent out). */
function charged(spend: () => void): boolean {
  try { spend(); return true; } catch (error) { if (!isLineageLimit(error)) throw error; return false; }
}
type Unclean ="SHARED" | "OVER-ALLOWANCE" | "DEFERRED-ONLY" | "WORK";
/** r14.1 X4 classifier, exhaustive: SHARED (from F, before the pass) > OVER-ALLOWANCE > DEFERRED-ONLY > WORK. */
function classify(c: ConfirmCounts): Unclean {
  // an unfinished walk (r14.1 X2) is work: a slice moves it on
  // (T15(d)/T10(r): the allowance running out counts an unfinished walk itself, RL:155 allowanceHooks.exhausted; on a HIT confirm that one is
  // the over-allowance, not work, or a hit-only confirm could never be OVER-ALLOWANCE and went RECOVERING instead of OVERSIZE)
  // (F6: a check unfinished only because it deferred a large set to the proof scheduler is the deferral, not work: RL deferSet counts both,
  // so without this DEFERRED-ONLY was unreachable and a deferred-only record never ran a proof slice)
  // MUTANT:f6-deferral-counts-as-work
  const unfinishedWork = Math.max(0, c.unfinished - (c.deferredUnfinished ?? 0));
  const work = c.misses + c.listings + c.remember + c.holdWrites + c.handleMisses + c.memoMisses + c.merges + c.ownLosses + (c.hit ? 0 : unfinishedWork);
  if (work === 0 && c.deferred === 0) return "OVER-ALLOWANCE";
  if (work === 0) return "DEFERRED-ONLY";
  return "WORK";
}

/** One confirm of `rec` (C5'), with its outcome. Synchronous; no await. */
function confirmRecord(rec: WarmRecord): void {
  rec.due = false;
  const noted = rec.footprint;
  if (!noted) return;
  let f: LineageFootprint = noted;
  if (!eligibleKind(f)) { rec.reason = "kind"; return; }
  const mint = sources.mint;
  let access: MemoryAccess | null = null;
  try { access = mint ? mint(f.botId, rec.thread) : null; } catch { access = null; }
  if (!mint) { rec.reason = "inputs: no mint"; return; }
  if (!access) { rec.reason = "access: mint failed"; return; }
  // T12 s1 (liveness): an audience change moves the access stamp. The next plain send mints this same access and its F carries this
  // stamp, so the confirm predicts THAT turn: F re-noted with the minted stamp (SHARED is still decided from it just below). Sound: the
  // claim stays gated by footprintHash equality at IX:13283; a turn under any other access hashes differently and misses.
  const stamp = accessStamp(access);
  if (stamp !== f.accessStamp) { f = { ...f, accessStamp: stamp, exclude: [...f.exclude] }; rec.footprint = f; }
  // SHARED is decided from F, not from misses (Astra A-a3)
  const minted = access;
  const ownerDirect = (g: LineageFootprint) => g.botId === f.botId && ownerDirectAccess(rec.thread, minted);
  // MUTANT:shared-by-misses
  if (!ownerDirect(f)) { rec.outcome = "SHARED"; rec.reason = "shared"; demote(rec, "shared"); return; }
  // r15.1 Y3: the confirm reads the branch the turn reads; a thread not prepared yet (its indexes being filled) is "checking: branch" until it is
  if (!sources.prepared(rec.thread)) { rec.reason = "branch: preparing"; return; }
  const head = headOf(rec.thread), anchor = anchorOf(rec.thread), epochs = rawEpochs();
  // r15.1 Y3: externalUpdates and the cursor come from the task row at confirm time
  const task = sources.task(rec.thread);
  const live = { externalUpdates: task && "externalUpdates" in task ? externalUpdatesKey(task.externalUpdates) : f.externalUpdates };
  const run = { ...f, externalUpdates: live.externalUpdates };
  const inputs = lineageReplayInputs(rec.thread, run, 1);
  if (!inputs || !head || !anchor) { rec.reason = "inputs: no line index"; return; }
  if (!inputs.exact) { rec.reason = "branch: uncertain"; return; }
  rec.reason = null;
  rec.windows = inputs.windows;
  // a confirm is a re-confirm from scratch: it subsumes every queued redo of the thread (pinned evictions, VS:242) and an overflow. Nothing
  // consumed them, so a thread with one stayed "pending: redo" after every clean confirm and the warmer re-confirmed it every step (T12).
  store.takeRedo(rec.thread); store.clearRedoOverflow(rec.thread);
  const cursor = confirmCursor(rec.thread, f);
  counters.confirms++;
  const { counts, trace } = confirmPass(rec, run, access, inputs, cursor);
  rec.lastConfirm = counts;
  if (rec.outcome !== "RECOVERING") rec.confirmRounds++;
  // Grok r15.1 S2 REVOKE VOIDS: a claim certifies only an E2 that answers not-revoked. A revoking E2 (IX:13285-13292, renew()) is the
  // turn's renew path, and a match never spans renew(): no claim until the next send (a new cursor) or note
  // MUTANT:match-survives-revoke
  if (counts.clean && counts.revoked) { invalidate(rec); rec.reason = "revoked"; rec.due = false; return; }
  if (counts.clean) { rec.uncleanRun = 0; cleanConfirm(rec, f, cursor, trace, head.seq, anchor, epochs, live); return; }
  rec.uncleanRun++;
  invalidate(rec); rec.due = false;
  // T10(r): the pass refused at the edge bound before any clear (RL remember); with C-EDGES on the record can never be kept: OVERSIZE now,
  // with no work slice (that would clear the store for it)
  // MUTANT:edges-refusal-ignored
  if (trace.edgesRefused && store.cEdgesOn()) { rec.outcome = "OVERSIZE"; rec.reason = "edges"; demote(rec, "oversize"); return; }
  if (oversized(rec, trace)) return;
  const kind = classify(counts);
  if (kind === "OVER-ALLOWANCE") { rec.outcome = "OVERSIZE"; rec.reason = "allowance"; demote(rec, "oversize"); return; }
  if (rec.outcome !== "RECOVERING") {
    // CONFIRM_TRIES unclean rounds IN A ROW (r14.1 X4): a clean confirm in between proved the record, so it is no try. Counting every
    // confirm since the send made a record that re-confirmed clean after other turns' writes RECOVERING on its next unclean one (T12 s2/s3:
    // the owner never matched).
    // MUTANT:no-confirm-tries
    if (rec.uncleanRun >= CONFIRM_TRIES) { rec.outcome = "RECOVERING"; rec.reason = "recovering"; demote(rec, "recovering"); }
  }
  if (rec.outcome === "RECOVERING") {
    // MUTANT:no-recover-bound
    if (rec.recoverSlices >= RECOVER_SLICES_MAX) return;
    rec.recoverSlices++;
  }
  if (kind === "DEFERRED-ONLY") { rec.waitingProof = true; proofSlice(rec); rec.due = true; return; }
  workSlice(rec, f, access, inputs, cursor);
  rec.due = true;
}
/** C-SIZE / C-FOREIGN / C-EDGES on a pass's trace: OVERSIZE (demoted) when it is over. Also run on an UNCLEAN pass (T10(r): "refused before any
 * clear"): an unclean pass's trace is at most the full one, so a partial trace already over a bound proves the full one is; more work slices
 * could only clear the store for a record that can never be kept. */
function oversized(rec: WarmRecord, trace: Trace): boolean {
  const stamps = store.stampsFor(trace);
  rec.traceSize = stamps.size;
  const limit = store.verdictLimit();
  if (stamps.size > limit / 8) { rec.outcome = "OVERSIZE"; rec.reason = "trace"; demote(rec, "oversize"); return true; }
  if (stamps.foreign.length > FOREIGN_MAX) { rec.outcome = "OVERSIZE"; rec.reason = "foreign"; demote(rec, "oversize"); return true; }
  rec.closureEdges = store.closureEdges(trace, limit * 4);
  if (rec.closureEdges > limit * 4) { rec.outcome = "OVERSIZE"; rec.reason = "edges"; demote(rec, "oversize"); return true; }
  return false;
}
/** C5'(3): the affirmative values, written only by a clean confirm; then admission (CAPACITY). */
function cleanConfirm(rec: WarmRecord, f: LineageFootprint, cursor: ReturnType<typeof confirmCursor>, trace: Trace, headSeq: number,
  anchor: Anchor, epochs: ReturnType<typeof rawEpochs>, live: { externalUpdates: string }): void {
  counters.cleanConfirms++;
  rec.waitingProof = false;
  if (oversized(rec, trace)) return;
  const stamps = store.stampsFor(trace);
  // watch every foreign thread the trace names (W1 compares its lossOf); drop the watches it no longer names
  const named = new Set([rec.thread, ...stamps.foreign]);
  for (const thread of [...rec.watching]) if (!named.has(thread)) unwatchThread(rec, thread);
  for (const thread of named) watchThread(rec, thread);
  rec.trace = trace; rec.stamps = store.stampsFor(trace);
  rec.holdStamp = trace.holdRead ? authorityParts()?.stamp ?? null : null;
  rec.applied = epochs;
  rec.anchor = anchor;
  rec.footprintHash = footprintHash({ ...f, cursor, externalUpdates: live.externalUpdates });
  rec.confirmedAt = headSeq;
  admit(rec);
  if (rec.admitted) { rec.reason = null; try { warmedHook(rec.thread); } catch (error) { console.warn(`[memory] checking notes: ${error instanceof Error ? error.message : String(error)}`); } }
}
/** CAPACITY (sec. 3): C-BUDGET, C-GROUP, C-EDGES in the store; ADMIT_MAX here. A record that does not fit demotes least recently sent admitted
 * records until it fits, never one sent more recently than it. */
function admit(rec: WarmRecord): void {
  const others = [...records.values()].filter(other => other !== rec && other.admitted).sort((a, b) => a.lastSent - b.lastSent);
  for (;;) {
    const count = others.filter(other => other.admitted).length;
    const verdict = count >= ADMIT_MAX ? "budget" : store.admit(rec.thread, rec.trace!);
    if (verdict === "ok") { rec.admitted = true; return; }
    const victim = others.find(other => other.admitted && other.lastSent < rec.lastSent);
    if (!victim) { rec.admitted = false; rec.reason = verdict; return; }
    demote(victim, verdict); invalidate(victim);
  }
}
/** WORK (C5'(4)c): E2 then E1 again under a BACKGROUND allowance; they judge and keep what the turn would, rebuild handles and the hold. */
function workSlice(rec: WarmRecord, f: LineageFootprint, access: MemoryAccess, inputs: { messages: Message[]; skip: Set<string> }, cursor: ReturnType<typeof confirmCursor>): void {
  counters.judgeSlices++;
  const allowance = LineageAllowance.warm(rec.sliceNodes);
  const was = store.warming();
  store.setWarming(true);
  setProofActivationContext({ record: rec.thread, budget: Math.max(1, rec.activations) });
  try {
    if (cursor) e2(allowance, rec.thread, access, cursor);
    e1(allowance, rec.thread, access, inputs, f);
  } finally {
    setProofActivationContext(null);
    store.setWarming(was);
    allowance.close();
  }
  // a slice that ran out moves to a larger allowance next round
  if (allowance.hit) rec.sliceNodes = Math.min(SLICE_NODES_MAX, rec.sliceNodes * 4);
}
/** DEFERRED-ONLY (C5'(4)d): the proof scheduler owns the set; one scheduler step under its own allowance, then the record confirms again. */
function proofSlice(rec: WarmRecord): void {
  counters.judgeSlices++;
  const was = store.warming();
  store.setWarming(true);
  setProofActivationContext({ record: rec.thread, budget: Math.max(1, rec.activations) });
  try { if (rootSetProofsPending()) advanceRootSetProofs(SLICE_NODES_MAX); }
  finally { setProofActivationContext(null); store.setWarming(was); }
}
/** r14 C2: a gen move writes confirmedAt := none ("pending") and keeps the outcome and both counters (send-only reset). */
function onGenMove(rec: WarmRecord): void {
  if (!rec.stamps || store.gen() === rec.stamps.gen) return;
  // MUTANT:gen-clears-oversize
  const keepOutcome = true;
  invalidate(rec);
  if (!keepOutcome) { rec.outcome = null; rec.reason = null; rec.confirmRounds = 0; rec.recoverSlices = 0; }
  rec.stamps = { ...rec.stamps, gen: store.gen() };
}

// ---- the tip's oldest-first reply walk, kept as the C7 BACKFILL ----
interface Reply { rowid: number; id: string; setId: string }
interface Pass {
  thread: string;
  /** Rowid of the last message of the thread already warmed (or parked). */
  at: number;
  phase: "replies" | "sessions" | "done";
  /** The message scan: the rowid it has looked through, whether it reached the end, and the replies it found and not judged yet. */
  scanAt: number;
  scanDone: boolean;
  found: Reply[];
  chunk: number;
  nodes: number;
  /** Slices in a row that moved something but did not finish. */
  moves: number;
  /** The session being warmed and the one the search for the next starts after (sessions are found one at a time, never listed whole). */
  session: { driver: string; session: string } | null;
  sessionAfter: [string, string];
  /** Replies and sessions left unwarmed (parked): not kept, so not warm. */
  parked: number;
}
const passes = new Map<string, Pass>();
const queue: string[] = [];
/** Threads with something parked, and how many things. */
const parkedThreads = new Map<string, number>();
/** The discovery in progress: the two tables it walks and the thread it got to in each, the threads found, and then the ranking of them. */
let discovery: { table: 0 | 1 | 2; at: string; found: Set<string>; ranking: string[]; ranked: Array<{ thread: string; top: number }> } | null = null;
/** When a thread was last started over by a turn that wanted it. */
const restarted = new Map<string, number>();
const DISCOVER_TABLES = ["memory_disclosure_outputs", "memory_output_roots"] as const;
/** Threads ranked per step. */
const RANK_STEP = 256;

const freshPass = (thread: string, at = 0): Pass => ({ thread, at, phase: "replies", scanAt: at, scanDone: false, found: [], chunk: REPLY_CHUNK, nodes: SLICE_NODES, moves: 0, session: null, sessionAfter: ["", ""], parked: 0 });

let warmedHook: (thread: string) => void = () => {};
/** Called when a thread's lineage is warm (a record admitted at a clean confirm, or the backfill finished the thread). */
export function onLineageThreadWarmed(hook: ((thread: string) => void) | null): void { warmedHook = hook ?? (() => {}); }
let wakeHook: ((delayMs: number) => void) | null = null;
/** The memory worker's EARLIEST WINS wake (worker-controller.ts wakeLineageWarm): told whenever a record becomes due. */
export function onLineageWarmWake(hook: ((delayMs: number) => void) | null): void { wakeHook = hook; }
function wake(delay = 0): void { try { wakeHook?.(delay); } catch { /* the worker wakes itself on its own schedule */ } }
/** The slice the warmer is given after every turn whose checks ran out, whatever else is waiting (1.0.2 lineage-cold r3, the 48 GB rig): idle
 * work yields to owner turns, so with turns arriving back to back the warmer never ran and every turn found the same history unproven. This
 * slice is short and runs at most every GUARANTEED_GAP_MS, so the turns keep the loop and the warmer still converges. */
export const GUARANTEED_SLICE_MS = 15;
const GUARANTEED_GAP_MS = 200;
let lastGuaranteed = -Infinity, guaranteedPending = false;
export function guaranteeLineageWarmSlice(now = Date.now()): boolean {
  if (guaranteedPending || (lineageWarmIdle() && !lineageWantedPending())) return false;
  if (now - lastGuaranteed < GUARANTEED_GAP_MS) return false;
  lastGuaranteed = now; guaranteedPending = true;
  setImmediate(() => { guaranteedPending = false; lineageWarmStep(GUARANTEED_SLICE_MS); });
  return true;
}
export function kickLineageWarm(): void { if (!discovery) discovery = { table: 0, at: "", found: new Set(), ranking: [], ranked: [] }; }

/** A send is arriving on `thread` (IX:12659): it goes first. SEND-ONLY RESET (r14 C2): the outcome and both round counters are cleared only
 * here (or by RECORD_TTL); confirmedAt and footprintHash are untouched (r15). New messages are judged on top of what is kept. */
export function bumpLineageWarm(thread: string): void {
  const known = passes.get(thread);
  passes.set(thread, freshPass(thread, known?.at ?? 0));
  const at = queue.indexOf(thread);
  if (at >= 0) queue.splice(at, 1);
  queue.unshift(thread);
  const rec = recordOf(thread);
  if (rec.outcome || rec.reason === "recovering: exhausted") { rec.outcome = null; rec.reason = null; }
  rec.confirmRounds = 0; rec.uncleanRun = 0; rec.recoverSlices = 0; rec.waitingProof = false; rec.throws = 0; rec.parkedUntil = 0; rec.sliceNodes = SLICE_NODES;
  rec.activations = PROOF_ACTIVATIONS;
  rec.lastSent = ++sendSeq; rec.touched = clock(); rec.due = true;
  wake();
}

/** Starts a thread over from its first reply (a turn ran out of its allowance there: something it needs is not kept). */
function restart(thread: string): void {
  passes.set(thread, freshPass(thread));
  parkedThreads.delete(thread);
  const at = queue.indexOf(thread);
  if (at >= 0) queue.splice(at, 1);
  queue.unshift(thread);
}

/** Whether every thread known to the warmer is warm: no record with work, nothing queued or being found, and nothing parked. */
export function lineageWarmIdle(): boolean {
  if (discovery !== null || queue.length !== 0 || parkedThreads.size !== 0) return false;
  for (const rec of records.values()) if (rec.footprint && rec.due && !rec.outcome && rec.parkedUntil <= clock()) return false;
  return true;
}
/** How many replies and sessions the warmer left unwarmed because even a full allowance could not keep their verdict. */
export function lineageWarmParked(): number { let total = 0; for (const count of parkedThreads.values()) total += count; return total; }

/** Test hook: forget what the warmer knows (records, pins and watches included). */
export function resetLineageWarmForTest(): void {
  for (const rec of [...records.values()]) dropRecord(rec);
  records.clear(); watchers.clear(); sendSeq = 0;
  passes.clear(); queue.length = 0; discovery = null; parkedThreads.clear(); restarted.clear(); takeLineageWanted();
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) if (typeof counters[key] === "number") (counters as Record<string, unknown>)[key] = 0;
  counters.coveredMissByClause = noClauseMisses();
  e1TargetNodes.clear(); preparing.clear(); demotionLog.length = 0; branchRecorder = null;
}

/** One step of finding the threads: up to DISCOVER_STEP index probes (one per thread, never a pass over a table), then the ranking a few at a time. */
function discoverStep(): void {
  const state = discovery!;
  const db = database();
  if (state.table === 2) {
    // ranked by their newest message (an index seek each), most recently active first
    const newest = db.prepare("SELECT rowid AS top FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1");
    for (const thread of state.ranking.splice(0, RANK_STEP)) state.ranked.push({ thread, top: Number(newest.get(thread)?.top ?? 0) });
    if (state.ranking.length) return;
    discovery = null;
    state.ranked.sort((a, b) => b.top - a.top || (a.thread < b.thread ? -1 : 1));
    for (const { thread } of state.ranked) {
      if (passes.has(thread)) continue;
      passes.set(thread, freshPass(thread));
      queue.push(thread);
    }
    return;
  }
  const next = db.prepare(`SELECT thread_id FROM ${DISCOVER_TABLES[state.table]} WHERE thread_id>? ORDER BY thread_id LIMIT 1`);
  for (let probes = 0; probes < DISCOVER_STEP; probes++) {
    const row = next.get(state.at);
    if (!row) {
      if (state.table === 0) { state.table = 1; state.at = ""; } else { state.table = 2; state.ranking = [...state.found]; }
      return;
    }
    state.at = String(row.thread_id);
    state.found.add(state.at);
  }
}

/** One page of a thread's messages after the scan cursor: the replies a receipt lists or that have roots join `found`, in the order they were written. */
function scanPage(pass: Pass): void {
  const limit = scanRows, started = performance.now();
  const rows = database().prepare(`SELECT m.rowid AS r, m.id AS id,
      EXISTS (SELECT 1 FROM memory_disclosure_outputs o WHERE o.thread_id=m.thread_id AND o.message_id=m.id) AS listed,
      (SELECT x.set_id FROM memory_output_roots x WHERE x.thread_id=m.thread_id AND x.message_id=m.id) AS setId
    FROM messages m WHERE m.thread_id=? AND m.rowid>? ORDER BY m.rowid LIMIT ?`).all(pass.thread, pass.scanAt, limit);
  const ms = performance.now() - started;
  if (ms > SCAN_PAGE_TARGET_MS) scanRows = Math.max(SCAN_PAGE_MIN, Math.floor(scanRows / 2));
  else if (ms < SCAN_PAGE_TARGET_MS / 4) scanRows = Math.min(SCAN_PAGE, scanRows * 2);
  for (const row of rows) {
    const setId = row.setId === null || row.setId === undefined ? null : String(row.setId);
    if (Number(row.listed) || setId !== null) pass.found.push({ rowid: Number(row.r), id: String(row.id), setId: setId ?? "" });
  }
  if (rows.length) pass.scanAt = Number(rows[rows.length - 1]!.r);
  if (rows.length < limit) pass.scanDone = true;
}

const finished = (pass: Pass): boolean => pass.phase === "done";
function park(pass: Pass): void {
  pass.parked++;
  parkedThreads.set(pass.thread, (parkedThreads.get(pass.thread) ?? 0) + 1);
}
/** One bounded step of one thread. */
function step(pass: Pass): void {
  if (pass.phase === "replies") {
    // the messages are looked through a page at a time until a chunk of replies is found or the thread ends
    if (pass.found.length < pass.chunk && !pass.scanDone) { scanPage(pass); return; }
    if (!pass.found.length) { pass.phase = "sessions"; return; }
    const batch = pass.found.slice(0, pass.chunk);
    const ids = batch.map(row => row.id), sets = [...new Set(batch.map(row => row.setId).filter(Boolean))];
    // a reply's verdict first (its receipts and what they cite), then the sets its roots rest on
    let result = warmReplies(pass.thread, ids, pass.nodes);
    let moved = result.moved;
    if (result.done && sets.length) { result = warmRootSets(pass.thread, sets, pass.nodes); moved = moved || result.moved; }
    if (result.done) {
      pass.found.splice(0, batch.length);
      pass.at = batch[batch.length - 1]!.rowid; pass.moves = 0; pass.nodes = SLICE_NODES;
      pass.chunk = Math.min(REPLY_CHUNK, pass.chunk * 2);
      return;
    }
    // The slice ran out of its allowance, or reached something it could not keep. What it finished is kept, so the same slice is further
    // along next time: while it moves, run it again as it was; when it moves nothing, try it smaller, then with more room, and a reply that
    // cannot be finished even alone with the most is parked (the turn path withholds that line, and it is not reported warm).
    if (moved && !result.unkept && ++pass.moves < MOVES_MAX) return;
    pass.moves = 0;
    if (batch.length > 1) { pass.chunk = Math.max(1, Math.floor(batch.length / 2)); return; }
    if (pass.nodes < SLICE_NODES_MAX && !result.unkept) { pass.nodes = Math.min(SLICE_NODES_MAX, pass.nodes * 4); return; }
    park(pass); pass.found.shift(); pass.at = batch[0]!.rowid; pass.nodes = SLICE_NODES; pass.chunk = REPLY_CHUNK;
    return;
  }
  if (pass.phase === "sessions") {
    if (!pass.session) {
      // the next session of the thread after the last one, an index seek (the index is ordered by driver and session): never a list of them all
      const row = database().prepare(`SELECT driver_instance AS d, native_session AS ns FROM memory_disclosures WHERE thread_id=? AND native_session IS NOT NULL
        AND (driver_instance,native_session)>(?,?) ORDER BY driver_instance,native_session LIMIT 1`).get(pass.thread, pass.sessionAfter[0], pass.sessionAfter[1]);
      if (!row) { pass.phase = "done"; return; }
      pass.session = { driver: String(row.d), session: String(row.ns) };
      pass.nodes = SLICE_NODES; pass.moves = 0;
    }
    const current = pass.session;
    const next = () => { pass.sessionAfter = [current.driver, current.session]; pass.session = null; pass.nodes = SLICE_NODES; pass.moves = 0; };
    const result = warmSession(pass.thread, current.driver, current.session, pass.nodes);
    if (result.done) { next(); return; }
    if (result.moved && !result.unkept && ++pass.moves < MOVES_MAX) return;
    pass.moves = 0;
    if (pass.nodes < SLICE_NODES_MAX && !result.unkept) { pass.nodes = Math.min(SLICE_NODES_MAX, pass.nodes * 4); return; }
    park(pass); next();
  }
}
/** C7: one backfill step, only while no record has work; the store's growth-site guards end the slice at a threshold (r14.1 X4). */
function backfillStep(): "more" | "stopped" | "idle" {
  if (!discovery && !queue.length) return "idle";
  if (discovery) { discoverStep(); return "more"; }
  const thread = queue[0]!;
  const pass = passes.get(thread);
  if (!pass || finished(pass)) { queue.shift(); return "more"; }
  const guarded = store.pinnedRecords().length > 0;
  if (guarded) store.setBackfill(true);
  try { step(pass); } finally { if (guarded) store.setBackfill(false); }
  if (guarded && store.backfillStopped()) return "stopped";
  if (finished(pass)) {
    queue.shift();
    // a thread whose lineage is warm: notes that said "still being checked" are brought up to date (index.ts)
    try { warmedHook(pass.thread); } catch (error) { console.warn(`[memory] checking notes: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return "more";
}

// ---- the step (C4, C8) ----
let ttlSweptAt = 0;
function sweepTtl(now: number): void {
  if (now - ttlSweptAt < 60_000) return;
  ttlSweptAt = now;
  for (const rec of [...records.values()]) if (now - rec.touched > RECORD_TTL_MS) dropRecord(rec);
}
/** Records with work, most recently sent first, at most CONFIRMS_PER_STEP. */
function dueRecords(): WarmRecord[] {
  const due: WarmRecord[] = [];
  for (const rec of records.values()) { onGenMove(rec); if (needsWork(rec)) due.push(rec); }
  return due.sort((a, b) => b.lastSent - a.lastSent);
}
/** Runs the warmer for about `sliceMs`, handing back sooner when `yieldNow` says the owner is waiting. True while there is more to do. Never throws. */
export function lineageWarmStep(sliceMs = SLICE_MS, yieldNow?: () => boolean): boolean {
  try {
    // retired (S6): there is no read-time verdict to warm; the write-time lookup is a fixed number of seeks cold or warm
    if (readTimeRetired(database())) { discovery = null; queue.length = 0; return false; }
    // a transaction in progress may hold writes that roll back: nothing is judged until it has ended
    if (database().isTransaction) return true;
    const now = clock();
    sweepTtl(now);
    for (const thread of takeLineageWanted()) {
      const rec = records.get(thread);
      if (rec) rec.due = true;
      // a thread with something parked is not started over by every turn that wants it: once a minute
      if (parkedThreads.has(thread) && now - (restarted.get(thread) ?? 0) < 60_000) continue;
      restarted.set(thread, now);
      restart(thread);
    }
    lineageStore.applied();
    // C8: at most CONFIRMS_PER_STEP confirms, most recently sent first, one per record per step
    const due = dueRecords();
    const run = due.slice(0, CONFIRMS_PER_STEP);
    for (const rec of run) {
      try { confirmRecord(rec); rec.throws = 0; }
      catch (error) {
        try { store.closeTrace(); } catch { /* none open */ }
        rec.due = true;
        if (++rec.throws >= PARK_AFTER_THROWS) { rec.parkedUntil = clock() + PARK_RETRY_MS; rec.throws = 0; wake(PARK_RETRY_MS); }
        console.warn(`[memory] lineage confirm: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    counters.confirmsPerStepMax = Math.max(counters.confirmsPerStepMax, run.length);
    if (run.length) counters.confirmsPerRecordPerStepMax = Math.max(counters.confirmsPerRecordPerStepMax, 1);
    if (due.length > run.length || run.some(rec => needsWork(rec))) return true;
    if (run.length) return true;
    // C7 backfill: idle-only (no record has work), stopped by the growth-site guards
    const until = performance.now() + sliceMs;
    let first = true;
    while (first || (performance.now() < until && !yieldNow?.())) {
      first = false;
      const result = backfillStep();
      if (result === "idle" || result === "stopped") return false;
    }
    return discovery !== null || queue.length > 0;
  } catch (error) {
    console.warn(`[memory] lineage warming: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** When the next parked record may retry (ms from now), or null: the worker's timer (EARLIEST WINS). */
export function lineageWarmNextDueMs(): number | null {
  const now = clock();
  let next: number | null = null;
  for (const rec of records.values()) {
    if (rec.parkedUntil > now) next = next === null ? rec.parkedUntil - now : Math.min(next, rec.parkedUntil - now);
    else if (needsWork(rec)) return 0;
  }
  return next;
}

/** R1 / trace counters (lineageFootprintMatch / Miss come from the turn's compare in lineage-footprint.ts; mirrored here when counted). */
export function lineageWarmCounters() {
  const s = store.counters();
  return { ...counters, coveredMissByClause: { ...counters.coveredMissByClause }, warmerCausedClears: s.warmerCausedClears, pinnedGroupDeletes: s.pinnedGroupDeletes, records: records.size, memoEpoch: store.memoEpoch() };
}

// ---- the test seam (r14 surface, server/memory/testing/turnstart-r14-surface.ts) ----
/** What the r14 test surface reads of a record. Test-only. */
export function lineageWarmRecordForTest(thread: string) {
  const rec = records.get(thread);
  if (!rec) return null;
  return {
    outcome: rec.outcome, reason: rec.reason, confirmRounds: rec.confirmRounds, recoverSlices: rec.recoverSlices, admitted: rec.admitted, traceSize: rec.traceSize,
    closureEdges: rec.closureEdges, usedMemos: rec.trace?.usedMemos ?? false, usedHandles: rec.trace?.usedHandles ?? false,
    footprintHash: rec.footprintHash, confirmedAt: rec.confirmedAt, lastConfirm: rec.lastConfirm, footprint: rec.footprint,
    anchor: rec.anchor ? { rowid: rec.anchor.rowid, id: rec.anchor.id } : null, activations: rec.activations, windows: rec.windows,
  };
}
/** The clock rule's driver (tests): the records' clock. Null restores Date.now. */
export function setLineageWarmClockForTest(now: (() => number) | null): void { clock = now ?? (() => Date.now()); }
/** Tests: one REAL-ENTRY probe on the turn's path (turnReplayInputs with headSlot 0, the user line skipped) -> E2 -> recall spend -> E1, on ONE
 * fresh turn allowance, counted like the confirm. */
export function lineageRealEntryForTest(thread: string, footprint: LineageFootprint, recallNodes: number, userMessageId?: string): (ConfirmCounts & { windows: LineageWindowTrace[] }) | null {
  // T12 s2: a source that throws (the mint, the line index) gives no probe: the turn entry falls back to the cold path and claims nothing
  // (the surface counts a missing probe as hit, unclean). It never escapes into the caller.
  let access: MemoryAccess | null = null;
  let inputs: ReturnType<typeof lineageReplayInputs> = null;
  try {
    access = sources.mint?.(footprint.botId, thread) ?? null;
    inputs = lineageReplayInputs(thread, footprint, 0, userMessageId ? [userMessageId] : []);
  } catch { return null; }
  if (!access || !inputs) return null;
  // the turn resumes the cursor its own F names (IX:13270), not the task row's
  const cursor = footprint.cursor;
  const before = lineageConfirmCounters();
  const allowance = LineageAllowance.turn();
  const order: Array<"E2" | "E1"> = [];
  let revoked = false;
  if (cursor) { order.push("E2"); revoked = e2(allowance, thread, access, cursor); }
  if (!charged(() => allowance.spend(recallNodes))) allowance.hit = true;
  order.push("E1");
  const withheld = allowance.hit ? [] : e1(allowance, thread, access, inputs, footprint);
  if (!allowance.hit) padForTest(allowance, thread, recallNodes);
  const delta = counterDelta(before, lineageConfirmCounters());
  const nodes = Math.max(0, allowance.spent - recallNodes);
  const counts: ConfirmCounts = { ...delta, ownLosses: 0, hit: allowance.hit, nodes, clean: false, revoked, withheld, order, headSlot: 0, passes: [] };
  counts.clean = counts.misses + counts.listings + counts.remember + counts.holdWrites + counts.handleMisses + counts.memoMisses + counts.merges + counts.deferred + counts.unfinished === 0 && !counts.hit;
  return { ...counts, windows: inputs.windows };
}
export { lineageWarmTestSurface } from "./lineage-warm-surface.ts";
/** Tests: the per-map pin counts (T14). */
export function lineagePinnedCountForTest(map: MapName): number { return store.pinnedCount(map); }
