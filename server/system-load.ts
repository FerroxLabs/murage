// SPDX-License-Identifier: AGPL-3.0-or-later
// How loaded the whole computer is, not only Murage's own process (F9, A7, O8; 1.0.2).
//
// Two readings, sampled every few seconds off the request path:
//  - the 1-minute load average against the core count (macOS, Linux): more
//    runnable work than cores means everything, the owner's turn included,
//    is waiting for a CPU;
//  - the share of all cores busy since the last sample, from os.cpus() times.
//    It covers what the load average cannot: Windows (where loadavg is always
//    0) and every process on the machine, Murage's engine and memory children
//    included, which process.resourceUsage() never counted.
import { availableParallelism, cpus, loadavg } from "node:os";

export const SYSTEM_LOAD_SAMPLE_MS = 5_000;
/** All cores this busy since the last sample counts as overloaded. */
export const SYSTEM_BUSY_FRACTION = 0.92;

export interface SystemLoadReading { at: number; cores: number; load1: number; busy: number | null; overloaded: boolean; why: string }
export interface SystemLoadProbe { cores: () => number; loadavg: () => number[]; cpuTimes: () => Array<{ busy: number; total: number }> }

const defaultProbe: SystemLoadProbe = {
  // The load average counts the whole machine, so it is compared with every core the machine has (not this
  // process's affinity, which a container narrows while still reporting the host's load).
  cores: () => Math.max(1, cpus().length || availableParallelism()),
  loadavg: () => loadavg(),
  cpuTimes: () => cpus().map(cpu => { const t = cpu.times; const busy = t.user + t.nice + t.sys + t.irq; return { busy, total: busy + t.idle }; }),
};

export class SystemLoad {
  private probe: SystemLoadProbe;
  private previous: Array<{ busy: number; total: number }> | null = null;
  private last: SystemLoadReading | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  constructor(probe: SystemLoadProbe = defaultProbe, now: () => number = Date.now) { this.probe = probe; this.now = now; }

  /** Take one reading now. Cheap: a syscall for the load average and one for the CPU times. */
  sample(): SystemLoadReading {
    let cores = 1, load1 = 0, busy: number | null = null;
    try { cores = Math.max(1, this.probe.cores()); } catch { /* one core */ }
    try { load1 = Number(this.probe.loadavg()[0]) || 0; } catch { /* unknown: 0 */ }
    try {
      const times = this.probe.cpuTimes();
      if (this.previous && this.previous.length === times.length) {
        let busyDelta = 0, totalDelta = 0;
        times.forEach((cpu, index) => { busyDelta += cpu.busy - this.previous![index]!.busy; totalDelta += cpu.total - this.previous![index]!.total; });
        if (totalDelta > 0) busy = Math.min(1, Math.max(0, busyDelta / totalDelta));
      }
      this.previous = times;
    } catch { /* unknown */ }
    const byLoad = load1 > cores, byBusy = busy !== null && busy >= SYSTEM_BUSY_FRACTION;
    const why = byLoad ? `load ${load1.toFixed(1)} on ${cores} cores` : byBusy ? `cpu ${Math.round(busy! * 100)}% of ${cores} cores` : "";
    this.last = { at: this.now(), cores, load1, busy, overloaded: byLoad || byBusy, why };
    return this.last;
  }

  /** The latest reading; null before start() (tests and tools never see load). */
  reading(): SystemLoadReading | null { return this.last; }
  overloaded(): boolean { return this.last?.overloaded === true; }

  start(intervalMs = SYSTEM_LOAD_SAMPLE_MS): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => { try { this.sample(); } catch { /* a probe never throws into the app */ } }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.last = null; this.previous = null; }
}

/** The process-wide sampler. index.ts starts it; io-budget and the owner-first gate read it. */
export const systemLoad = new SystemLoad();
