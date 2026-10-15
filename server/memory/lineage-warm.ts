// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): the lineage verdicts a turn needs, made while the app is idle.
//
// A start keeps no verdict (they live in memory), and a turn may spend only its allowance on lineage work (replay-lineage.ts
// LineageAllowance), so a long thread would meet its first turns unproven: replay withholds the lines, recall drops the hits, a retained
// session is reset. This warmer judges every thread's replies in the order they were written, oldest first, so each verdict rests on
// verdicts already kept and costs its own additions only (the depth any one judgement walks stays small). It then judges the replies'
// root sets and each retained session's receipts and roots, which is what the continuation check asks. The most recently active thread
// goes first, a thread a turn arrives on is moved to the front, and a thread where a turn ran out of its allowance starts over (what was
// kept before it forgot something is judged again, what still stands is a lookup).
//
// Every step is small and resumable, so one call stays near its deadline however long the history is and hands the loop back between steps:
// - the messages of a thread are looked through a page at a time (a cursor on their rowid), never in one read;
// - a slice that ran out of its allowance but kept something (a verdict, a page of a session's receipts, a page of a root-set chain) is run
//   again from where it got to, with the same allowance; only a slice that moved nothing is given more room, and one that cannot finish with
//   the most room is PARKED: it is counted and reported, and never passed off as warm;
// - the work of finding the threads is paged too.
//
// It writes nothing: it only judges, and what it judges is kept exactly like a verdict a turn reached. It is driven in short slices by the
// memory worker's idle loop (worker-controller.ts), which yields to the owner.
import { readTimeRetired } from "./read-time-retired.ts";
import { database } from "../database.ts";
import { lineageWantedPending, takeLineageWanted, warmReplies, warmRootSets, warmSession } from "./replay-lineage.ts";

/** Replies judged together in one slice (the same chunk the replay judges in). */
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

/** Queues every thread that holds receipt outputs or reply roots, the most recently active first (found a few at a time). */
let warmedHook: (thread: string) => void = () => {};
/** Called when the warmer has finished a thread (its replies and sessions judged and kept). */
export function onLineageThreadWarmed(hook: ((thread: string) => void) | null): void { warmedHook = hook ?? (() => {}); }
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

/** A turn is arriving on `thread`: it goes first. New messages since it was last warmed are judged on top of what is kept. */
export function bumpLineageWarm(thread: string): void {
  const known = passes.get(thread);
  passes.set(thread, freshPass(thread, known?.at ?? 0));
  const at = queue.indexOf(thread);
  if (at >= 0) queue.splice(at, 1);
  queue.unshift(thread);
}

/** Starts a thread over from its first reply (a turn ran out of its allowance there: something it needs is not kept). */
function restart(thread: string): void {
  passes.set(thread, freshPass(thread));
  parkedThreads.delete(thread);
  const at = queue.indexOf(thread);
  if (at >= 0) queue.splice(at, 1);
  queue.unshift(thread);
}

/** Whether every thread known to the warmer is warm: nothing queued or being found, and nothing parked (parked work is not warm). */
export function lineageWarmIdle(): boolean { return discovery === null && queue.length === 0 && parkedThreads.size === 0; }
/** How many replies and sessions the warmer left unwarmed because even a full allowance could not keep their verdict. */
export function lineageWarmParked(): number { let total = 0; for (const count of parkedThreads.values()) total += count; return total; }

/** Test hook: forget what the warmer knows. */
export function resetLineageWarmForTest(): void { passes.clear(); queue.length = 0; discovery = null; parkedThreads.clear(); restarted.clear(); takeLineageWanted(); }

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

/** Runs the warmer for about `sliceMs`, handing back sooner when `yieldNow` says the owner is waiting. True while there is more to do. Never throws. */
export function lineageWarmStep(sliceMs = SLICE_MS, yieldNow?: () => boolean): boolean {
  try {
    // retired (S6): there is no read-time verdict to warm; the write-time lookup is a fixed number of seeks cold or warm
    if (readTimeRetired(database())) { discovery = null; queue.length = 0; return false; }
    // a transaction in progress may hold writes that roll back: nothing is judged until it has ended
    if (database().isTransaction) return true;
    for (const thread of takeLineageWanted()) {
      // a thread with something parked is not started over by every turn that wants it: once a minute
      if (parkedThreads.has(thread) && Date.now() - (restarted.get(thread) ?? 0) < 60_000) continue;
      restarted.set(thread, Date.now());
      restart(thread);
    }
    const until = performance.now() + sliceMs;
    let first = true;
    while ((discovery || queue.length) && (first || (performance.now() < until && !yieldNow?.()))) {
      first = false;
      if (discovery) { discoverStep(); continue; }
      const thread = queue[0]!;
      const pass = passes.get(thread);
      if (!pass || finished(pass)) { queue.shift(); continue; }
      step(pass);
      if (finished(pass)) {
        queue.shift();
        // a thread whose lineage is warm: notes that said "still being checked" are brought up to date (index.ts)
        try { warmedHook(pass.thread); } catch (error) { console.warn(`[memory] checking notes: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return discovery !== null || queue.length > 0;
  } catch (error) {
    console.warn(`[memory] lineage warming: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
