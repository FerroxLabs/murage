// SPDX-License-Identifier: AGPL-3.0-or-later
// The scheduler of the search index's merge (designs/SMOOTH-FTS-MERGE-R6.md §1, §2). Main thread, no SQL: every transaction runs on the
// checkpointer worker (wal-maintenance.ts), which answers each op with its own measured ms. This module only decides what to post next.
//
// A conversation deletion leaves tombstones in the index and writes the marker row `search_merge` (done=0) in its own transaction
// (message-db.ts deleteThread). The run pays it: one `('merge', -N)`, positive slices while they write, then `merge-prove`, a `-N` that
// sets done=1 in the same transaction only when it wrote nothing (the exact proof that no deleted posting is left in the index). Then
// the scrub: the frames the slices wrote can still hold deleted postings, so the log must restart past them (wal-maintenance.ts owe /
// walScrubbed, no deadline) before `scrub-done` deletes the done=1 row. A kick with no marker is tidying: positive slices until one
// writes nothing (automerge is off, so the worker is the merger of level-0 segments too).
//
// Lifecycle: every activation (startWalMaintenance) has a token; the state, timers and in-flight op are keyed by it, and a reply whose
// token or op id is not the one in flight is dropped. A kick during an op is kept and served after it. While no worker runs, the marker
// stays in the file and merges stop (the index then only crisis-merges); the restarted worker carries on from the marker.
//
// Nothing here is a responsiveness guarantee: the allowance is output pages checked at term boundaries, so a slice can run longer. The
// §6 maxima are a qualification contract, measured by search-merge-r6-103k-t2.test.ts and -t5.test.ts, not a runtime promise.
import { oweWalScrub, postMergeOp, setWalLifecycle, walMark, type MergeOp, type MergeReply } from "./wal-maintenance.ts";

/** The soft output allowance of one slice, in leaf pages (FTS5 checks it at term boundaries). The design starts at 8; T5 on the 103k
 * copy (11-03) measured a foreground stall p99 of 30.9 ms at 8 against the 20 ms contract, and 15.28 ms at 4, so the qualified start is 4. */
export const SEARCH_MERGE_PAGES = 4;
/** A slice whose reported ms is over this halves the allowance for the rest of the run (4, 2, 1); it never rises mid-run.
 * The same figure as BACKGROUND_BUSY_MS (db-busy.ts): above it background work gives up its turn. */
export const SEARCH_MERGE_SLOW_SLICE_MS = 50;
/** The kick's delay: deletions and writes close together share one run. */
export const SEARCH_MERGE_KICK_MS = 250;
const MIN_PAUSE_MS = 10;
/** Restarts of one run (a prove that found work) before it backs off. */
const RUN_RESTARTS = 2;
const BACKOFF_FIRST_MS = 30_000, BACKOFF_MAX_MS = 600_000;
/** An op the worker never answers (a lost reply) is given up after this and the sequence starts again from the marker read. */
const REPLY_LOST_MS = 60_000;

export type SearchMergePhase = "idle" | "run" | "tidy" | "scrub";
export interface SearchMergeEvent {
  token: number; kind: "config" | "first" | "slice" | "prove" | "scrub" | "scrub-done" | "stale" | "backoff" | "lost";
  reply?: MergeReply; phase: SearchMergePhase; allowance: number;
}
export interface SearchMergeTestHooks {
  /** Every reply the scheduler acts on (and every one it drops as stale), in order. */
  onEvent: ((event: SearchMergeEvent) => void) | null;
  /** While true no further op is posted (the sequence resumes when it is set false and `resumeSearchMerge()` is called). */
  halt: boolean;
  kickMs: number;
  /** The allowance a run starts with (8 in production). */
  startPages: number;
  backoffFirstMs: number;
  replyLostMs: number;
  /** Ask the worker for the segment count after each slice and prove (outside the measured transaction; diagnostics only). */
  segments: boolean;
}
export const searchMergeTestHooks: SearchMergeTestHooks = {
  onEvent: null, halt: false, kickMs: SEARCH_MERGE_KICK_MS, startPages: SEARCH_MERGE_PAGES, backoffFirstMs: BACKOFF_FIRST_MS, replyLostMs: REPLY_LOST_MS, segments: false,
};

interface FileState {
  token: number;
  walFile: string;
  phase: SearchMergePhase;
  /** A worker of this activation is ready to take ops. */
  ready: boolean;
  /** The op in flight: its id, the op itself (re-posted after `busy`), and the timer that gives it up if no reply comes. */
  inflight: { id: number; op: MergeOp; lost: ReturnType<typeof setTimeout> } | null;
  /** A kick that came while a sequence ran (or before a worker was ready): served when it ends. */
  pendingKick: boolean;
  /** The marker read in flight was asked for by a kick: with no marker it tidies. */
  kicked: boolean;
  /** The next slice reply answers the run's first (negative) slice. */
  firstPending: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The timer is the plain kick's wait (kickSearchMerge armed it), not a retry, a backoff or a sequence step: only that wait may be pulled forward. later() clears it. */
  plainKick: boolean;
  /** Not-settled proves in this run. */
  restarts: number;
  backoffMs: number;
  allowance: number;
  lastMs: number;
  /** The owe epoch captured before the marker read or the prove whose sequence this is; carried unchanged to `scrub-done`. */
  epoch: number;
  /** The op to post when the timer fires (a retry after busy, or the next step). */
  next: MergeOp | null;
  /** The generation of the sequence: bumped by every scrub start and every worker ready (a restart), so a scrub wait or a scrub-done
   * that belongs to an earlier sequence never completes a later one. */
  gen: number;
  /** The scrub this sequence owes: its generation and the owe epoch captured for it (immutable), carried to its own scrub-done only. */
  scrubbing: { gen: number; epoch: number } | null;
}

let current: FileState | null = null;
/** Bumped by every committed deletion that owes the merge (kickSearchMerge({ owed: true })). */
let oweEpoch = 0;
/** The in-process mirror of the marker: true from a committed deletion (or a row found at open) until a `scrub-done` reply whose carried
 * epoch is still the current one. */
let owing = false;
let fastPath = false;
let fastLogged = false;

const event = (s: FileState, kind: SearchMergeEvent["kind"], reply?: MergeReply) => {
  const hook = searchMergeTestHooks.onEvent;
  if (hook) try { hook({ token: s.token, kind, ...(reply ? { reply } : {}), phase: s.phase, allowance: s.allowance }); } catch { /* a test hook never breaks the scheduler */ }
};

function clearTimer(s: FileState) { if (s.timer) { clearTimeout(s.timer); s.timer = undefined; } }
function retire(s: FileState | null) {
  if (!s) return;
  clearTimer(s);
  if (s.inflight) clearTimeout(s.inflight.lost);
  s.inflight = null; s.ready = false;
}

/** Runs `op` after `ms` (unref'd), replacing any timer already set. */
function later(s: FileState, ms: number, op: MergeOp) {
  clearTimer(s);
  s.next = op;
  s.plainKick = false;
  s.timer = setTimeout(() => { s.timer = undefined; if (current === s) post(s, op); }, Math.max(0, ms));
  s.timer.unref?.();
}
const pause = (s: FileState) => Math.max(MIN_PAUSE_MS, 3 * s.lastMs);

function post(s: FileState, op: MergeOp) {
  if (current !== s || s.inflight) return;
  s.next = op;
  if (!s.ready || searchMergeTestHooks.halt) return; // served on ready, or on resumeSearchMerge()
  // the epoch is captured BEFORE the marker read and before the prove; it is carried unchanged through the scrub and scrub-done
  if (op.op === "config" || op.op === "merge-prove") s.epoch = oweEpoch;
  if (op.op === "config" && s.pendingKick) { s.kicked = true; s.pendingKick = false; }
  const withSegments = searchMergeTestHooks.segments && (op.op === "merge-slice" || op.op === "merge-prove") ? { ...op, segments: true } : op;
  const posted = postMergeOp(s.token, withSegments as MergeOp);
  if (!posted) { s.ready = false; return; } // no worker of this activation: wait for ready
  s.next = null;
  const lost = setTimeout(() => {
    if (current !== s || s.inflight?.id !== posted.id) return;
    s.inflight = null;
    event(s, "lost");
    failure(s);
  }, searchMergeTestHooks.replyLostMs);
  lost.unref?.();
  s.inflight = { id: posted.id, op, lost };
  void posted.reply.then(reply => onReply(s, posted.id, reply));
}

/** The sequence ended: idle, then serve a kick that came meanwhile. */
function finish(s: FileState) {
  s.phase = "idle";
  s.next = null; s.kicked = false;
  if (s.pendingKick) later(s, 0, { op: "config" });
}

/** An error reply or a lost one: nothing is settled; back off and start again from the marker read. */
function failure(s: FileState) {
  s.backoffMs = s.backoffMs ? Math.min(BACKOFF_MAX_MS, s.backoffMs * 2) : searchMergeTestHooks.backoffFirstMs;
  event(s, "backoff");
  s.phase = "idle";
  later(s, s.backoffMs, { op: "config" });
}

function slice(s: FileState, negative: boolean): MergeOp { return { op: "merge-slice", negative, pages: s.allowance }; }

function onReply(s: FileState, id: number, reply: MergeReply) {
  // a reply for another activation or another op is dropped (a late answer of a retired worker, or of an op given up as lost)
  if (current !== s || reply.token !== s.token || s.inflight?.id !== id) { event(s, "stale", reply); return; }
  const op = s.inflight.op;
  clearTimeout(s.inflight.lost);
  s.inflight = null;
  // no worker answered: the restarted worker's ready starts again from the marker read (the file holds the state)
  if (reply.unavailable) { s.ready = false; s.next = { op: "config" }; if (s.phase === "tidy") s.pendingKick = true; return; }
  s.lastMs = Number.isFinite(reply.ms) ? reply.ms : 0;
  const kind: SearchMergeEvent["kind"] = op.op === "merge-prove" ? "prove" : op.op === "scrub-done" ? "scrub-done" : op.op === "config" ? "config"
    : s.firstPending ? "first" : "slice";
  // any error reply means not settled (and never "nothing written"): back off and start again from the marker read
  if (reply.error) { s.firstPending = false; event(s, kind, reply); failure(s); return; }
  // the lock was held: the same op again after the pause (BEGIN never waited)
  if (reply.busy) { event(s, kind, reply); later(s, pause(s), op); return; }
  switch (reply.op) {
    case "config": return onConfig(s, reply);
    case "merge-slice": return onSlice(s, reply);
    case "merge-prove": return onProve(s, reply);
    case "scrub-done": return onScrubDone(s, reply);
  }
}

function onConfig(s: FileState, reply: MergeReply) {
  fastPath = reply.fast === true;
  if (!fastPath && !fastLogged) {
    fastLogged = true;
    const v = reply.values ?? {};
    console.warn(`[message-search] merge config read back automerge=${v.automerge} deletemerge=${v.deletemerge} usermerge=${v.usermerge}: deletes may merge at commit (slower) until it reads 0, 0, 4`);
  }
  event(s, "config", reply);
  if (reply.marker === 0) {
    s.phase = "run"; s.restarts = 0; s.allowance = searchMergeTestHooks.startPages; s.kicked = false; s.firstPending = true;
    later(s, 0, slice(s, true));
    return;
  }
  // done=1 found (at open, or left by a crash after the proof): the scrub is owed; the epoch was captured before this read
  if (reply.marker === 1) { s.kicked = false; scrub(s); return; }
  // no marker: nothing is owed in the file. A mirror set by a deletion whose transaction did not stand clears when the epoch is still current.
  if (s.epoch === oweEpoch) owing = false;
  s.backoffMs = 0;
  if (s.kicked) { s.kicked = false; s.phase = "tidy"; s.allowance = searchMergeTestHooks.startPages; later(s, 0, slice(s, false)); return; }
  finish(s);
}

function halve(s: FileState, reply: MergeReply) {
  if (reply.ms > SEARCH_MERGE_SLOW_SLICE_MS && s.allowance > 1) s.allowance = Math.max(1, Math.floor(s.allowance / 2));
}

function onSlice(s: FileState, reply: MergeReply) {
  event(s, s.firstPending ? "first" : "slice", reply);
  s.firstPending = false;
  halve(s, reply);
  if (s.phase === "tidy") {
    if (reply.wrote) { later(s, pause(s), slice(s, false)); return; }
    finish(s);
    return;
  }
  if (s.phase !== "run") { finish(s); return; }
  if (reply.wrote) { later(s, pause(s), slice(s, false)); return; }
  later(s, pause(s), { op: "merge-prove", pages: s.allowance });
}

function onProve(s: FileState, reply: MergeReply) {
  event(s, "prove", reply);
  halve(s, reply);
  if (reply.settled) { s.backoffMs = 0; scrub(s); return; }
  // the -N inside the prove did work (a write met a 1-input merge, or tombstones sit in a reused output): slices resume
  s.restarts++;
  if (s.restarts > RUN_RESTARTS) { failure(s); return; }
  later(s, pause(s), slice(s, false));
}

/** §2: the index is settled (done=1); the frames the slices wrote leave the log only when it restarts past them. */
function scrub(s: FileState) {
  s.phase = "scrub";
  const gen = ++s.gen;
  s.scrubbing = { gen, epoch: s.epoch };
  const mark = walMark(s.walFile);
  event(s, "scrub");
  void oweWalScrub(s.token, mark).then(scrubbed => {
    // only the wait of this very sequence completes it: a restarted worker or a later scrub (a newer log generation) moved the generation on
    if (current !== s || s.phase !== "scrub" || s.gen !== gen || s.scrubbing?.gen !== gen) return;
    // not proven (stopped, another activation): the done=1 row stays and the next start scrubs again
    if (!scrubbed) return;
    later(s, 0, { op: "scrub-done" });
  });
}

function onScrubDone(s: FileState, reply: MergeReply) {
  event(s, "scrub-done", reply);
  s.backoffMs = 0;
  const bound = s.scrubbing;
  s.scrubbing = null;
  // a deletion committed anywhere between the marker read (or the prove) and this reply bumped the epoch, or the reply is not this
  // sequence's own: keep the mirror, read again
  if (bound && bound.gen === s.gen && bound.epoch === oweEpoch) { owing = false; finish(s); return; }
  s.phase = "idle";
  later(s, 0, { op: "config" });
}

setWalLifecycle({
  activated(token, file) {
    retire(current);
    fastPath = false; fastLogged = false;
    current = {
      token, walFile: `${file}-wal`, phase: "idle", ready: false, inflight: null, pendingKick: false, kicked: false, firstPending: false, timer: undefined,
      restarts: 0, backoffMs: 0, allowance: searchMergeTestHooks.startPages, lastMs: 0, epoch: oweEpoch, next: { op: "config" },
      gen: 0, scrubbing: null, plainKick: false,
    };
  },
  ready(token) {
    const s = current;
    if (!s || s.token !== token) return;
    s.ready = true;
    if (s.inflight) { clearTimeout(s.inflight.lost); s.inflight = null; }
    // every ready (the first, or a restarted worker) reads the config and the marker again; a scrub in progress is re-owed from the marker
    clearTimer(s);
    if (s.phase === "tidy") s.pendingKick = true;
    // a restart cancels the scrub wait of the sequence it interrupted: the marker read below starts a new generation
    s.gen++; s.scrubbing = null;
    s.phase = "idle"; s.firstPending = false;
    post(s, { op: "config" });
  },
  stopped() { retire(current); current = null; fastPath = false; },
});

/** After a write to the index has committed: merge soon. `owed`: a deletion's transaction wrote the marker (call it after COMMIT only,
 * tx-scope afterCommit); it bumps the owe epoch and sets the mirror. A kick during a sequence is kept and served after it. */
export function kickSearchMerge(options: { owed?: boolean; soon?: boolean } = {}): void {
  if (options.owed) { oweEpoch++; owing = true; }
  const s = current;
  if (!s) return;
  s.pendingKick = true;
  if (s.inflight || s.phase !== "idle") return;
  if (s.timer) {
    // `soon` (the background fill found level 0 at its count trigger, message-search-index.ts) pulls the plain kick's own wait forward; it never touches a
    // timer that is a busy retry, a backoff or a sequence step (those were armed by later() for their own op, which clears plainKick).
    if (options.soon && s.plainKick) later(s, 0, { op: "config" });
    return;
  }
  later(s, options.soon ? 0 : searchMergeTestHooks.kickMs, { op: "config" });
  s.plainKick = !options.soon;
}
/** At open (database.ts): the marker row exists in either state, so the mirror starts true. */
export function noteSearchMergeRowAtOpen(exists: boolean): void { owing = exists; }
/** True while a deletion's merge or the WAL scrub after it is owed (the leftover line "Removed; finishing cleanup"). */
export function searchMergeOwing(): boolean { return owing; }
/** True only after the worker read back automerge=0, deletemerge=0, usermerge=4 on this activation (§1 fast path). */
export function searchMergeFastPath(): boolean { return fastPath; }
/** Test and diagnostics: the phase of the current activation. */
export function searchMergePhase(): SearchMergePhase | null { return current?.phase ?? null; }
/** Test only: whether an op is in flight or queued. */
export function searchMergeBusy(): boolean { return Boolean(current && (current.inflight || current.timer || current.phase !== "idle")); }
/** Test only: after `searchMergeTestHooks.halt` was set false, posts the op the sequence stopped at. */
export function resumeSearchMerge(): void {
  const s = current;
  if (!s || s.inflight || !s.next) return;
  const op = s.next;
  clearTimer(s);
  post(s, op);
}
