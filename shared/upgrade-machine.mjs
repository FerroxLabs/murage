// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one client state machine for everything that shows an upgrade: reduce(ctx, event) is pure (no clock, no timers, no I/O: an event carries
// its own `at`), and every screen draws only from the selectors below. There are two instances of the same machine: the window family (the
// shell's wait window, fed from the start-up note and the server's 503 answer) and the app family (the renderer's strip, settings detail and
// reclaim offer, fed from /api/health). Neither keeps a percent, a time-left gate or a "moving" tracker of its own.
//
// The rules that keep a screen from claiming what it does not know (shared/upgrade-contract.mjs gives "unknown" as a value):
//  - a reading from a different known launch retires the old launch and starts afresh; a reading with an unknown launch applies its figures but
//    never accrues a percent and never resets; the first known launch is adopted without a reset;
//  - within a launch the percent is a high-water mark; a missed or malformed reading changes none of it;
//  - nothing pending with complete false/unknown keeps the last view (it counts a missed reading, it neither hides nor finishes);
//  - held:true wins from any state until a new launch or an explicit held:false; held:"unknown" keeps what was known and makes no capture claim;
//  - complete:true is the only thing that finishes a run; complete:"unknown" never does;
//  - keepOpen is true while blocking unless a parsed reading says false;
//  - the time left is shown only for a phase that has run long enough, and is withdrawn on a gap, a failed read, or a reading without one.
import { SLEEP_GAP_MS, ADVANCE_FRESH_MS, gateStep, newGate } from "./upgrade-wait.mjs";

/** How long "finished" stays up before the view goes. */
export const DONE_SHOWN_MS = 6000;
/** Without a good reading for this long, the view says only that work is going on (no percent, no time left). */
export const NEUTRAL_AFTER_MS = 60_000;
/** The measured time left is believed once the phase has run this long (awake) and, where it counts, a tenth of it is done. */
export const ETA_MIN_PHASE_MS = 5000;
export const ETA_MIN_FRACTION = 0.1;
/** How often the health answer is read: often while the window is in view, rarely when it is not. */
export const POLL_VISIBLE_MS = 2000;
export const POLL_HIDDEN_MS = 10_000;
export const POLL_UNSETTLED_MS = 10_000;

const WORKING = new Set(["blocking", "working"]);

export function initialContext(family = "app") {
  return {
    family, mode: "unknown", modeBeforeHold: null, now: 0, lastEventAt: null, lastGoodAt: null,
    launch: null, retired: [], seq: -1, ignored: 0, missed: 0, legacy: false,
    overallHigh: 0, overallSeen: false, resumeAbove: -1, runAwakeMs: 0,
    stage: "unknown", phase: "unknown", step: { awakeElapsedMs: 0, unit: "none" }, counts: { exact: false }, copy: null,
    gate: newGate(), etaMinutes: null, slow: false, advance: { signature: null, movedAt: null },
    keepOpen: true, held: "unknown", holdKey: null, capture: "unknown", recall: "unknown", storedMode: "unknown", storage: "unknown", complete: "unknown",
    doneAt: null, ready: false, pollNow: false, suspendedAt: null, legacyWorking: false,
  };
}

/** More work in the same launch (after a "finished", or a first run). The percent is the launch's high-water mark and never goes back: it keeps
 * what it had, and is shown again only once a reading goes above it (until then the bar is indeterminate, never a lower figure). */
function startRun(ctx) {
  return { ...ctx, overallSeen: false, resumeAbove: ctx.overallSeen ? ctx.overallHigh : -1, runAwakeMs: 0, gate: newGate(), etaMinutes: null, slow: false, advance: { signature: null, movedAt: null }, doneAt: null, ready: false, complete: "unknown" };
}
/** A new server launch: everything of the old one is forgotten, and the old launch is retired for good (a late answer from it is ignored). */
function newLaunch(ctx, launch) {
  const fresh = initialContext(ctx.family);
  return { ...fresh, launch, retired: [...ctx.retired, ...(ctx.launch ? [ctx.launch] : [])].slice(-8), now: ctx.now, lastEventAt: ctx.lastEventAt, pollNow: ctx.pollNow, ignored: ctx.ignored };
}
function forgetEstimates(ctx) { return { ...ctx, gate: newGate(), etaMinutes: null, slow: ctx.slow, advance: { signature: null, movedAt: null } }; }
/** Moves the clock to `at`. A gap longer than SLEEP_GAP_MS is the computer asleep: estimates made before it say nothing about after, and the gap is no time worked. */
function touch(ctx, at) {
  let out = { ...ctx, now: at };
  if (ctx.lastEventAt !== null) {
    const gap = at - ctx.lastEventAt;
    if (gap > SLEEP_GAP_MS) out = forgetEstimates(out);
    else if (WORKING.has(ctx.mode)) out.runAwakeMs = ctx.runAwakeMs + Math.max(0, gap);
  }
  out.lastEventAt = at;
  return out;
}

function resolveKeepOpen(reading, ctx) {
  if (reading.keepOpen === true || reading.keepOpen === false) return reading.keepOpen;
  // unknown: an upgrade that blocks (or is not known to be over) keeps the window open
  return reading.stage === "idle" ? ctx.keepOpen : true;
}

function applyReading(before, event) {
  let ctx = touch(before, event.at);
  const s = event.state;
  const known = s.launch !== "unknown";
  if (known) {
    if (ctx.retired.includes(s.launch)) return { ...ctx, ignored: ctx.ignored + 1 };
    if (ctx.launch === null) ctx = { ...ctx, launch: s.launch };
    else if (ctx.launch !== s.launch) ctx = newLaunch(ctx, s.launch);
  }
  const sameLaunch = known && s.launch === ctx.launch;
  if (sameLaunch && s.seq < ctx.seq) return { ...ctx, ignored: ctx.ignored + 1 };
  if (sameLaunch) ctx = { ...ctx, seq: s.seq };

  // held: true wins; false clears it; unknown leaves what was known
  // an unknown reading keeps a known hold (it is a restriction, kept until something says otherwise) but withdraws every affirmative claim: "not held",
  // "capture on" and "recall on" are only what the current reading says
  let held, holdKey;
  if (s.held === true) { held = true; holdKey = s.holdKey; }
  else if (s.held === false) { held = false; holdKey = null; }
  else if (ctx.held === true) { held = true; holdKey = ctx.holdKey; }
  else { held = "unknown"; holdKey = null; }
  const capture = held === true ? "off" : s.capture;
  const recall = held === true ? "off" : s.recall;

  const pending = s.stage === "starting" || s.stage === "blocked" || s.stage === "background";
  let mode = ctx.mode, modeBeforeHold = ctx.modeBeforeHold;
  let run = ctx;
  if (held === true) {
    if (mode !== "held") modeBeforeHold = mode;
    mode = "held";
  } else if (s.complete === true) {
    mode = WORKING.has(ctx.mode) || ctx.mode === "held" || ctx.mode === "finishing" ? "finishing" : "idle";
  } else if (pending) {
    if (ctx.mode === "idle" || ctx.mode === "finishing" || ctx.mode === "reclaim") run = startRun(ctx);
    mode = s.stage === "background" ? "working" : "blocking";
  } else if (ctx.mode === "held") {
    mode = modeBeforeHold && modeBeforeHold !== "held" ? modeBeforeHold : "working";
  }
  const nothingPending = !pending && s.complete !== true;
  let out = {
    ...run, mode, modeBeforeHold: mode === "held" ? modeBeforeHold : null, held, holdKey, capture, recall,
    storedMode: s.storedMode !== "unknown" ? s.storedMode : run.storedMode,
    storage: s.storage !== "unknown" ? s.storage : run.storage,
    stage: s.stage, phase: s.phase, step: sameLaunch && s.phase === run.phase && s.step.awakeElapsedMs < run.step.awakeElapsedMs ? { ...s.step, awakeElapsedMs: run.step.awakeElapsedMs } : s.step,
    counts: s.counts.exact ? s.counts : run.counts,
    complete: s.complete, lastGoodAt: event.at, legacy: false,
    missed: nothingPending ? run.missed + 1 : 0,
    copy: event.copy ?? null,
    keepOpen: mode === "finishing" || mode === "idle" ? false : resolveKeepOpen(s, run),
  };
  if (mode === "finishing" && out.doneAt === null) out.doneAt = event.at;
  // the percent is a launch-wide high-water mark, accrued only by a reading from the known launch
  if (sameLaunch && typeof s.overall === "number") out = { ...out, overallHigh: Math.max(out.overallHigh, s.overall), overallSeen: out.overallSeen || s.overall > out.resumeAbove };
  // the measured time left: believed only for a phase that has run long enough (awake) and, where it counts, is a tenth done
  if (WORKING.has(mode)) {
    const fraction = s.step.unit !== "none" && s.step.total > 0 ? s.step.done / s.step.total : null;
    const believable = s.eta.stable && s.step.awakeElapsedMs >= ETA_MIN_PHASE_MS && (fraction === null || fraction >= ETA_MIN_FRACTION);
    const gated = gateStep(out.gate, { phase: s.phase, etaMs: believable ? s.eta.ms : null });
    out = { ...out, gate: gated.gate, etaMinutes: gated.minutes, slow: gated.slow };
    const signature = JSON.stringify([s.phase, s.step.done ?? null, s.step.total ?? null, s.overall, event.copy?.done ?? null]);
    out = { ...out, advance: signature === out.advance.signature ? out.advance : { signature, movedAt: event.at } };
  } else {
    out = { ...out, gate: newGate(), etaMinutes: null };
  }
  return out;
}

/** The machine. Events (each carries `at`, the caller's clock in ms):
 *   READING { state, copy? }   a parsed upgrade state (parseUpgradeState ok); `copy` is {done,total} bytes the shell measured for the copy
 *   MALFORMED { reason, pending? }  a reading that did not parse ("legacy" for a server that predates the contract; `pending` is its old pending-work flag)
 *   READ_FAILED                the reading could not be made at all
 *   TICK                       time passes (nothing was read)
 *   SUSPEND / RESUME           the computer sleeps / wakes
 *   LISTEN { ready }           the server is listening (window family): the same window says the app is opening
 *   LIFECYCLE { state }, RECONNECT, VISIBLE     things that mean "look again now", even when polling had stopped
 *   POLL_STARTED               the poller took note of pollNow */
export function reduce(ctx, event) {
  switch (event.type) {
    case "READING": return applyReading(ctx, event);
    case "MALFORMED": {
      let out = { ...touch(ctx, event.at), missed: ctx.missed + 1 };
      if (event.reason === "legacy") {
        // a server that predates the contract says only whether work is pending: that is an indeterminate "working", nothing more (no percent, no time left)
        out.legacy = true;
        if (event.pending === true && out.mode !== "held") { out.mode = WORKING.has(out.mode) ? out.mode : "working"; out.legacyWorking = true; out.keepOpen = true; out.lastGoodAt = event.at; out.missed = 0; }
        else if (event.pending === false && out.legacyWorking) { out.mode = "idle"; out.legacyWorking = false; out.lastGoodAt = event.at; }
      }
      if (out.lastGoodAt === null || event.at - out.lastGoodAt > SLEEP_GAP_MS) out = { ...out, gate: newGate(), etaMinutes: null };
      return out;
    }
    case "READ_FAILED": {
      let out = { ...touch(ctx, event.at), missed: ctx.missed + 1 };
      if (out.lastGoodAt === null || event.at - out.lastGoodAt > SLEEP_GAP_MS) out = { ...out, gate: newGate(), etaMinutes: null };
      return out;
    }
    case "TICK": {
      let out = touch(ctx, event.at);
      if (out.mode === "finishing" && out.doneAt !== null && event.at - out.doneAt >= DONE_SHOWN_MS && !out.ready) out = { ...out, mode: "idle" };
      if (out.lastGoodAt !== null && event.at - out.lastGoodAt > SLEEP_GAP_MS && out.etaMinutes !== null) out = { ...out, gate: newGate(), etaMinutes: null };
      return out;
    }
    case "SUSPEND": return { ...touch(ctx, event.at), suspendedAt: event.at };
    case "RESUME": return { ...forgetEstimates({ ...ctx, now: event.at }), lastEventAt: event.at, suspendedAt: null };
    case "LISTEN": return { ...touch(ctx, event.at), mode: "finishing", doneAt: ctx.doneAt ?? event.at, ready: event.ready === true, keepOpen: false };
    case "LIFECYCLE": case "RECONNECT": case "VISIBLE": return { ...ctx, now: Math.max(ctx.now, event.at ?? 0), pollNow: true };
    case "POLL_STARTED": return { ...ctx, pollNow: false };
    default: return ctx;
  }
}

// ---------------------------------------------------------------- selectors: every surface draws only from these

const worked = (ctx) => WORKING.has(ctx.mode);
const stale = (ctx) => ctx.lastGoodAt === null || ctx.now - ctx.lastGoodAt > NEUTRAL_AFTER_MS;
/** The whole-launch percent, whole and never 100 until the run is over; null when no known launch has said how far it is. */
function percentOf(ctx) {
  if (ctx.mode === "finishing") return ctx.ready || ctx.complete === true ? 100 : ctx.overallSeen ? Math.floor(Math.min(0.99, ctx.overallHigh) * 100 + 1e-9) : null;
  if (!ctx.overallSeen) return null;
  return Math.floor(Math.min(0.99, ctx.overallHigh) * 100 + 1e-9);
}
function counterOf(ctx) {
  if (ctx.step.unit !== "none") return { unit: ctx.step.unit, done: ctx.step.done, total: ctx.step.total };
  if (ctx.phase === "copying" && ctx.copy && ctx.copy.total > 0) return { unit: "bytes", done: Math.min(ctx.copy.done, ctx.copy.total), total: ctx.copy.total };
  return null;
}
const advancing = (ctx) => ctx.advance.movedAt !== null && ctx.now - ctx.advance.movedAt <= ADVANCE_FRESH_MS;

/** Whether the poller should run, how soon, and whether to look right now (a lifecycle event, a reconnect, the window coming back). */
export function selectPoll(ctx, { hidden = false } = {}) {
  const settled = ctx.mode === "idle" || ctx.mode === "reclaim";
  // polling ends only when a known launch has said it is idle; it goes on while the storage conversion is running (no separate poll for it)
  const active = !(settled && ctx.launch !== null && ctx.storage !== "converting");
  const intervalMs = ctx.mode === "unknown" || settled ? (hidden ? POLL_UNSETTLED_MS * 3 : POLL_UNSETTLED_MS) : hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  return { active, intervalMs, now: ctx.pollNow };
}

/** The wait window. Returns null before anything is known (the window shows the start-up lines then). */
export function selectWindow(ctx) {
  if (ctx.mode === "unknown" && ctx.lastGoodAt === null && !ctx.legacy) return null;
  const counts = ctx.counts.exact ? ctx.counts : null;
  const percent = percentOf(ctx);
  if (ctx.mode === "finishing" || ctx.mode === "idle") {
    return { mode: "finishing", percent, indeterminate: percent === null, keepOpen: false, counts, counter: counterOf(ctx), phaseId: ctx.phase, elapsedMs: null, etaMinutes: null, slow: false, late: false, longSlow: false, neutral: false };
  }
  const counter = counterOf(ctx);
  const indeterminate = !counter && ctx.phase !== "copying";
  const counting = (ctx.phase === "unknown" || ctx.phase === "none") && !counts;
  const neutral = ctx.lastGoodAt !== null && ctx.now - ctx.lastGoodAt > NEUTRAL_AFTER_MS;
  const eta = neutral ? null : ctx.etaMinutes;
  const late = !neutral && (ctx.slow || ctx.runAwakeMs > 4 * 60_000 || (eta !== null && eta > 5));
  const slow = late && advancing(ctx);
  return {
    mode: counting ? "counting" : slow ? "slow" : "blocking",
    percent: neutral ? null : percent, indeterminate: indeterminate || neutral || percent === null && !counter, keepOpen: ctx.keepOpen,
    counts, counter, phaseId: ctx.phase, elapsedMs: indeterminate ? ctx.step.awakeElapsedMs : null,
    etaMinutes: eta, slow, late, longSlow: slow && ctx.runAwakeMs > 10 * 60_000, neutral,
  };
}

/** The strip under the engine banner: null when there is nothing to say. */
export function selectStrip(ctx) {
  if (ctx.mode === "held") return { kind: "hold", role: "alert", holdKey: ctx.holdKey, percent: null, phaseId: null, left: null, counter: null, slow: false, neutral: false };
  if (ctx.mode === "finishing") return { kind: "done", role: "status", holdKey: null, percent: 100, phaseId: null, left: null, counter: null, slow: false, neutral: false };
  if (!worked(ctx)) return null;
  const neutral = stale(ctx) && ctx.lastGoodAt !== null;
  return {
    kind: "working", role: "status", holdKey: null, percent: neutral ? null : percentOf(ctx), phaseId: ctx.phase === "unknown" || ctx.phase === "none" ? null : ctx.phase,
    left: neutral ? null : ctx.etaMinutes, counter: neutral ? null : counterOf(ctx), slow: neutral ? false : ctx.slow, neutral,
    // a step with nothing to count shows how long it has been going on (time awake): the activity is real, and so is the time
    elapsedMs: neutral || counterOf(ctx) || ctx.phase === "unknown" || ctx.phase === "none" ? null : ctx.step.awakeElapsedMs,
  };
}
/** The detail in Memory settings: the strip, a little more of it. */
export function selectDetail(ctx) { return selectStrip(ctx); }

/** The sentence key for the memory mode line in Settings. `endpoint` is what /api/memory/status says now ({ mode, held, capture, recall }); a known
 * hold from either source wins over every cached mode, and a capture claim is made only when a source says capture is on. */
export function selectSettingsDescription(ctx, endpoint) {
  if (ctx.held === true || endpoint?.held === true) return "held";
  // a claim about capture or recall needs a source that knows there is no hold and says "on"; the endpoint's own fields win over the health feed's
  const claim = (field) => {
    if (endpoint && endpoint[field] !== undefined) return endpoint.held === false && endpoint[field] === "on";
    return ctx.held === false && ctx[field] === "on";
  };
  const mode = endpoint?.mode ?? (ctx.storedMode !== "unknown" ? ctx.storedMode : null);
  if (mode === "off") return "off";
  if (mode === "paused") return claim("capture") ? "pausedNoted" : "paused";
  if (mode === "capture") return claim("capture") ? "capture" : "on";
  if (mode === "active") return claim("capture") && claim("recall") ? "active" : "on";
  return "on";
}

/** The reclaim offer: which state the storage conversion is in, as the health answer reports it. */
export function selectReclaim(ctx) {
  return { storage: ctx.storage, converting: ctx.storage === "converting", offer: ctx.storage === "reclaim-available", waiting: ctx.storage === "waiting-for-disk" };
}
