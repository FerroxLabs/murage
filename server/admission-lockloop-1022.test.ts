// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: admission refresh backoff + miss lines (io-budget.ts) and these witnesses = q1022-lockloop-opus; ledger lock (admission-shared.ts,
// rule 2: the main thread never waits) = scperf-p1; the lock's other holder (the checkpointer worker, wal-maintenance.ts) = scperf-p1.
// IDLECPU-1022 cause 3 (MAIN-RULING 2026-11-25T13:37:06Z): a main-thread ledger-lock miss re-armed a 25 ms refresh that collided again
// (40 critical sections a second for as long as the lock kept being busy) and every miss was an ERROR line. A miss now backs the refresh off
// (250 ms doubling to 2 s, reset when a section takes the lock), a miss is a rate-limited WARN, and ERROR only once misses persist > 60 s.
// Contention model: the real IoBudget (started, so its own refresh timer runs) on a fake clock; the lock's other holder is planted in the
// real ledger word (slot 0) the way the checkpointer holds it in beginCopy/endCopy: a commit storm of 150 commits a minute, each commit's copy
// holding the lock for COPY_HOLD_MS. Background loops ask idleQuiet() every 100 ms (recall-view, worker-controller).
import { afterEach, describe, expect, it, vi } from "vitest";
import { IoBudget } from "./io-budget.ts";

const COMMIT_EVERY_MS = 400; // 150 commits a minute
const COPY_HOLD_MS = 120;
const STEP_MS = 5;
const FOREIGN = (7n << 32n) | 1n; // a worker thread's token

function storm(idle: () => boolean = () => true) {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => ({ at: Date.now(), cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 }) as never, log: line => lines.push(line), isIdle: idle });
  budget.start();
  const slots = new BigInt64Array(budget.checkpointAdmissionBuffer(false));
  vi.advanceTimersByTime(1_000); // idle published, refresh disarmed
  let held = false;
  const hold = () => { if (Atomics.compareExchange(slots, 0, 0n, FOREIGN) === 0n) held = true; };
  const release = () => { if (held) { Atomics.compareExchange(slots, 0, FOREIGN, 0n); held = false; } };
  /** Run `ms` of the storm in STEP_MS steps; counts the refresh's fires and the fires that landed while the lock was held. */
  const run = (ms: number, opts: { holdAlways?: boolean; background?: boolean; at?: (t: number) => void; after?: (t: number, held: boolean) => void } = {}) => {
    let fires = 0, heldFires = 0;
    for (let t = 0; t < ms; t += STEP_MS) {
      opts.at?.(t);
      if (opts.holdAlways || t % COMMIT_EVERY_MS < COPY_HOLD_MS) hold(); else release();
      if (opts.background !== false && t % 100 === 0) budget.idleQuiet();
      opts.after?.(t, held);
      const before = budget.admissionRefresh().fires, wasHeld = held;
      vi.advanceTimersByTime(STEP_MS);
      const n = budget.admissionRefresh().fires - before;
      fires += n; if (wasHeld) heldFires += n;
    }
    release();
    return { fires, heldFires };
  };
  const errors = () => lines.filter(l => /\bERROR\b/.test(l));
  const warns = () => lines.filter(l => /\bWARN AdmissionLockTimeout\b/.test(l));
  return { budget, slots, lines, run, errors, warns, release, stop: () => { release(); budget.stop(); } };
}

describe("IDLECPU-1022 cause 3: a ledger-lock miss backs off", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("W-STORM 150 commits/min for 5 min: the refresh fires bounded, 0 ERROR lines, misses are counted and a rate-limited WARN", () => {
    const s = storm();
    try {
      const commits = (5 * 60_000) / COMMIT_EVERY_MS;
      const { fires, heldFires } = s.run(5 * 60_000);
      const health = s.budget.admissionHealth();
      console.log(`[LOCKLOOP-MEASURE] storm 5 min: commits ${commits} refresh fires ${fires} fires-while-held ${heldFires} lockTimeouts ${health.lockTimeouts} errors ${s.errors().length} warns ${s.warns().length}`);
      expect(health.lockTimeouts, "the storm really collides with the main thread's sections").toBeGreaterThan(commits / 2);
      // base 68ed0def17: a miss re-arms 25 ms, so every held window takes about COPY_HOLD_MS / 25 refresh fires
      expect(heldFires, "a miss backs off: at most one refresh lands inside each held window").toBeLessThanOrEqual(commits);
      expect(fires, "refresh fires bounded: at most two per commit").toBeLessThanOrEqual(2 * commits);
      expect(s.errors(), "no ERROR line: the lock is taken again between misses").toEqual([]);
      expect(s.warns().length, "a miss is a WARN line, at most one a minute").toBeGreaterThanOrEqual(1);
      expect(s.warns().length).toBeLessThanOrEqual(5);
    } finally { s.stop(); }
  });

  it("W-PERSIST a lock held for 70 s: the refresh backs off 250 ms doubling to 2 s; WARN at once, ERROR only after 60 s of misses", () => {
    const s = storm();
    try {
      const gaps: number[] = [];
      let last = -1;
      let firstMin = { errors: -1, warns: -1 };
      s.run(70_000, { holdAlways: true, background: false, at: t => {
        if (t === STEP_MS) s.budget.idleQuiet(); // one background caller misses: the only thing that arms the refresh
        if (t === 59_000) firstMin = { errors: s.errors().length, warns: s.warns().length };
        const f = s.budget.admissionRefresh().fires;
        if (f !== last) { if (last >= 0) gaps.push(t); last = f; }
      } });
      const deltas = gaps.slice(1).map((t, i) => t - gaps[i]!);
      console.log(`[LOCKLOOP-MEASURE] held 70 s: fires ${gaps.length} first gaps ${deltas.slice(0, 6).join(",")} errors@59s ${firstMin.errors} warns@59s ${firstMin.warns} errors ${s.errors().length}`);
      expect(firstMin.errors, "one minute of misses is not an ERROR line").toBe(0);
      expect(firstMin.warns, "the first miss is one WARN line").toBe(1);
      expect(gaps.length, "the refresh keeps retrying the missed section (250 + 500 + 1000 + 2000 x 33 ms)").toBeGreaterThanOrEqual(30);
      expect(gaps.length, "backed off: about 70 s / 2 s refreshes, never 70 s / 25 ms").toBeLessThanOrEqual(45);
      expect(Math.min(...deltas), "never faster than the first backoff").toBeGreaterThanOrEqual(245);
      expect(Math.max(...deltas), "never slower than the 2 s cap").toBeLessThanOrEqual(2_010);
      expect(s.errors().length, "misses that persisted past 60 s are an ERROR line").toBeGreaterThanOrEqual(1);
    } finally { s.stop(); }
  });

  it("W-TURN an owner turn begins inside a held window after 2 min of storm: its ACTIVE verdict is republished by the backed-off refresh within 300 ms, and its foreground copy is admitted on the first free section", () => {
    let idle = true;
    const s = storm(() => idle);
    try {
      s.run(120_000); // two minutes of storm first: many misses, each reset by a section that took the lock
      // turn.started (index.ts:13307 ioBudget.noteForegroundActivity) lands inside a held window: its own section misses. No background
      // caller runs now, so only the refresh timer can republish: the backed-off retry must come at 250 ms, not after a grown 2 s backoff.
      let publishedAt = -1, copyAt = -1, copied: string | undefined;
      s.run(3_000, { background: false, at: t => {
        if (t === 10) { idle = false; s.budget.noteForegroundActivity(); }
      }, after: (t, held) => {
        if (t > 10 && publishedAt < 0 && s.slots[7] === 0n) publishedAt = t;
        // the turn's foreground copy waits for the next commit's held window, so the republish above is the refresh timer's alone
        if (t >= COMMIT_EVERY_MS && copyAt < 0 && !held) { copyAt = t; copied = s.budget.foregroundCopy(4096, () => "copied"); }
      } });
      console.log(`[LOCKLOOP-MEASURE] turn: ACTIVE republished ${publishedAt - 10} ms after the turn began inside a held window; copy at first free section ${copyAt} ms -> ${copied}`);
      expect(copyAt, "setup: the copy ran on the first free section after the next commit's hold").toBe(COMMIT_EVERY_MS + COPY_HOLD_MS);
      expect(copied, "the turn's foreground copy (io-budget.ts foregroundCopy) is admitted on the first free section").toBe("copied");
      expect(publishedAt - 10, "the ACTIVE verdict was published within 300 ms of the turn beginning inside a held window").toBeLessThanOrEqual(300);
      expect(s.errors(), "no ERROR line").toEqual([]);
    } finally { s.stop(); }
  });

  it("W-WORKER a checkpointer timeout (it waited its whole deadline, wal-maintenance.ts admission-timeout message) stays an ERROR line at once", () => {
    const s = storm();
    try {
      s.budget.noteLockTimeout("wal-beginCopy"); // the call wal-maintenance.ts makes for the worker's admission-timeout message
      expect(s.errors().length, "the worker's timeout is an ERROR line").toBe(1);
      expect(s.warns(), "not downgraded to the main-thread miss WARN").toEqual([]);
    } finally { s.stop(); }
  });
});
