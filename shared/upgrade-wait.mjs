// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The numbers behind every place that tells the owner how long an upgrade has left: the wait window the desktop shell draws before the
// server listens (electron/upgrade-screen.mjs) and the strip in the app after (src/lib/memory-integrity-view.ts). One module, so the two
// round, smooth and order their figures the same way. No words live here: each side owns its sentences and its translations.
//
// The functions that run inside the wait window's page (formatDone, formatTotal, formatElapsed, tweenStep) are self-contained on purpose:
// the shell embeds their source in the page it shows.

/** A figure still being counted, to three significant figures, so each poll visibly moves it ("612,000"). */
export function formatDone(value, locale) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  try { return new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }).format(n); } catch { return String(n); }
}
/** A total, to two significant figures: "1.2 million" from a million up, otherwise whole with separators ("840,000", "48,000", "4,300"). Under a thousand it is exact. */
export function formatTotal(value, locale) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  try {
    if (n < 1000) return new Intl.NumberFormat(locale).format(n);
    if (n < 1000000) return new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 }).format(n);
    return new Intl.NumberFormat(locale, { notation: "compact", compactDisplay: "long", maximumSignificantDigits: 2 }).format(n);
  } catch { return String(n); }
}
/** Time spent on a step the owner can watch tick: "14 s", "1 min 5 s". Never a countdown. */
export function formatElapsed(ms, locale) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60), seconds = total % 60;
  try {
    const unit = (value, name) => new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
    return minutes ? `${unit(minutes, "minute")} ${unit(seconds, "second")}` : unit(seconds, "second");
  } catch { return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`; }
}
/** One step of a counter's glide from the value shown towards the latest real value: it covers the gap over `duration` ms and never passes the target. */
export function tweenStep(shown, target, elapsed, duration) {
  if (!(target > shown)) return target;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
  return Math.min(target, shown + (target - shown) * fraction);
}

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
/** How much history there is, from the oldest message: years from two, "a year" from one, months from two, nothing below that (the clause is dropped). */
export function memorySpan(firstMessageAt, now = Date.now()) {
  if (typeof firstMessageAt !== "number" || !Number.isFinite(firstMessageAt) || firstMessageAt <= 0 || firstMessageAt > now) return null;
  const years = Math.floor((now - firstMessageAt) / (365.25 * 24 * 3600 * 1000));
  if (years >= 2) return { kind: "years", n: years };
  const months = Math.floor((now - firstMessageAt) / MONTH_MS);
  if (months >= 12) return { kind: "year", n: 1 };
  if (months >= 2) return { kind: "months", n: months };
  return null;
}

/** Milliseconds left to the phrase the owner reads, as a whole number of minutes: 0 is "under a minute", 1 "about a minute", then the
 * nearest minute up to ten minutes and the nearest five minutes beyond. */
export function etaMinutes(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return 0;
  if (seconds < 90) return 1;
  if (seconds < 150) return 2;
  const minutes = seconds / 60;
  if (minutes <= 10) return Math.round(minutes);
  return Math.max(10, Math.round(minutes / 5) * 5);
}

/** The measured estimate is believed only once enough has happened for it to mean something (a tenth of the whole, five seconds). */
export function etaBelievable({ stable, fraction, elapsedMs }) {
  return stable === true && typeof fraction === "number" && fraction >= 0.1 && typeof elapsedMs === "number" && elapsedMs >= 5000;
}

/** A gap between two readings this long means the computer slept (or the work stalled): estimates made before it say nothing about after. */
export const SLEEP_GAP_MS = 30_000;
/** How recently the work must have moved for the screen to say it is still moving. */
export const ADVANCE_FRESH_MS = 60_000;

/** The state of the time-left gate: what is shown, the figure waiting to be confirmed, and how often the estimate has risen in this phase. Plain data, so a reducer can keep it. */
export function newGate() { return { shown: null, candidate: null, count: 0, rises: 0, phase: "", slow: false }; }
/** One reading through the gate (pure): { gate, minutes, slow }. The shown figure changes only when a new one has held for two readings in a row (a
 * reading with no estimate breaks the run and withdraws what was shown); it may fall at will, and may rise once per phase (that rise also says the
 * work is taking longer than first said, `slow`). */
export function gateStep(gate, { phase, etaMs }) {
  let { shown, candidate, count, rises, slow } = gate;
  // a different phase is a different piece of work: what was shown for the last one says nothing about this one, so the estimate starts again
  if (phase !== gate.phase) { shown = null; rises = 0; candidate = null; count = 0; slow = false; }
  const next = etaMinutes(etaMs);
  // no believable estimate right now: the old one is withdrawn, and the run of consecutive readings starts again
  if (next === null) return { gate: { shown: null, candidate: null, count: 0, rises, phase, slow }, minutes: null, slow };
  if (next === shown) return { gate: { shown, candidate: null, count: 0, rises, phase, slow }, minutes: shown, slow };
  if (next === candidate) count += 1; else { candidate = next; count = 1; }
  if (count >= 2) {
    if (shown === null || next < shown) shown = next;
    else if (rises < 1) { shown = next; rises += 1; slow = true; }
    candidate = null; count = 0;
  }
  return { gate: { shown, candidate, count, rises, phase, slow }, minutes: shown, slow };
}
/** The same gate with its state held in a closure. `reset()` forgets everything: a new launch, or a wake from sleep. */
export function createEtaGate() {
  let gate = newGate();
  return {
    update(input) { const out = gateStep(gate, input); gate = out.gate; return { minutes: out.minutes, slow: out.slow }; },
    reset() { gate = newGate(); },
    shown: () => gate.shown,
    slow: () => gate.slow,
  };
}

/** Whether the work is moving: `observe` is given a signature of the figures that matter (phase, done, total, overall), and the work counts
 * as advancing while that signature last changed within `freshMs`. A heartbeat alone (same signature) does not advance it. */
export function createAdvanceTracker(freshMs = ADVANCE_FRESH_MS) {
  let signature = null, movedAt = null;
  return {
    observe(next, at) { const key = JSON.stringify(next); if (key !== signature) { signature = key; movedAt = at; } },
    advancing: (at) => movedAt !== null && at - movedAt <= freshMs,
    reset() { signature = null; movedAt = null; },
  };
}

/** A progress figure that never goes back. 0 to 1 in, whole percent out; 100 only when `done` says the work is over. */
export function createMonotonePercent() {
  let high = 0;
  return (fraction, done = false) => {
    const raw = typeof fraction === "number" && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    high = Math.max(high, done ? 1 : Math.min(raw, 0.99));
    return Math.floor(high * 100 + 1e-9);
  };
}
