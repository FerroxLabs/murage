// Owed-capture idle admission producer and controller consumer owner: warm-capture.
// File-receipt producer owner: scperf-p2-rd2; byte-budget consumer owner: scperf-p1.
import {sampleSentinelFileIo,sentinelExternalIoBytes} from "./sentinel-file-sampling.ts";
import {ownedChildIoBytes} from "./sentinel/io-child-receipts.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// A disk and CPU watchdog with application byte accounting. Periodic work
// consults its source's backoff before starting. Turns, routines, user actions,
// claimed jobs and owner-requested writes always proceed; it never stops a turn.
// CPU is judged on the whole computer too (system-load.ts: load average and all
// cores busy, children and other apps included), not only Murage's own process.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { BLOCK_BYTES, osWriteBlocks, takeDatabaseBuckets, takeWrittenBytes, walFrameReader, walIndexReader } from "./io-written.ts";
import { ioMeterTotal, ioMeterCoverageKnown, ioMeterSnapshot, ioGrantSnapshot, beginBgGrant, endBgGrant, commitCeiling, withForegroundCopy, ioMeterWallTime } from "./io-meter.ts";
import { darwinWrittenBytes } from "./os-disk-written.ts";
import { turnTraceEnabled } from "./turn-trace.ts";
import { activeTaskName, oldestLongOp, rateLimited, reportSlowSql, SLOW_SQL_MS } from "./observe.ts";
import { systemLoad } from "./system-load.ts";
import { HEALTH_LIMITS, type IoSample, type IoSourceClass } from "../shared/health-protocol.mjs";
import { recordFact } from "./health/counters.ts";
import { NET_LINE_BYTES_PER_MINUTE, netMeter, netText, type NetMinute } from "./net-meter.ts";
import { countsAsOwnerAction } from "./owner-activity.ts";

import { checkpointLedger, isAdmissionLockTimeout } from "./admission-shared.ts";
import { BgDeferred } from "./bg-admission.ts";
import { isReadOnly } from "./read-only-state.ts";
import { ownerFirst } from "./owner-first.ts";
import { framesOfCeiling, indexDebtFrames, indexDebtPage, INDEX_SQLITE_PAGE } from "./index-debt-frames.ts";
export { BgDeferred, isBgDeferred } from "./bg-admission.ts";

export const IO_BUDGET_INTERVAL_MS = 60_000;
export const IO_BUDGET_BYTES_PER_MINUTE = 50 * 1024 * 1024;
export const IO_BUDGET_IDLE_BYTES_PER_MINUTE = 1024 * 1024;
/** Shared admission for periodic writers. Leave room for checkpoint copies and overlapping sample windows; the watchdog limits stay unchanged. */
export const IO_BUDGET_BACKGROUND_BYTES_PER_MINUTE = IO_BUDGET_IDLE_BYTES_PER_MINUTE / 4;
const PERIODIC_SOURCES: ReadonlySet<string> = new Set([
  "memory-worker", "memory-capture", "memory-idle", "memory-notebook", "memory-upgrade", "memory-boot-recovery", "memory-continuity",
  "search-index", "transcript-backfill", "record-keys-backfill", "push-delivery",
]);
/** recalldesign-1020-n1 section 4: the recall reclaimer's own admission class. Its token bucket is shared by the reclaim slices and the demanded
 *  build that follows; it is excluded from foreground admission and refusal, and is not behind the BG ticket or the idle deferral. */
export const RECALL_RECLAIM_SOURCE = "recall-reclaim";
export const RECALL_RECLAIM_BYTES_PER_MINUTE = 700_000_000;
export const RECALL_RECLAIM_YIELD_MS = 500;
export const RECALL_RECLAIM_OPEN_HOLD_MS = 5_000;
/** cause18e-overbudget (PERF-SPEC 0edba926a6): NAMED ONE-TIME SEED BUDGETS. Work a store does once over history it already holds (the
 *  first build of its recall views; the first index of its messages for search) is not background drift, and judging it against the idle
 *  minute (1 MB) printed `writing 24 MB/min (budget 1)` and `writing 65 MB/min` on every first start after an import, then halved every
 *  background poll for it. Each such writer charges its bytes to its own source here. A minute's seed bytes are taken out of the judged
 *  bytes up to the source's per-minute room AND its per-process total; whatever is over either counts as before. Nothing is hidden: every
 *  minute that uses a seed budget prints one `[io-budget] seed:` line with the source, the bytes, and what is left of the total, and the
 *  io-minute sample carries them as planned bytes. No admission, deferral or pacing reads these: they change what the watchdog says about
 *  a minute, never what a turn or a writer may do. */
export const RECALL_SEED_SOURCE = "recall-seed";
export const SEARCH_SEED_SOURCE = "search-seed";
export interface IoSeedBudget { perMinute: number; total: number; what: string }
export const IO_SEED_BUDGETS: Readonly<Record<string, IoSeedBudget>> = {
  // 128 views (the cap) at the ~100-200 KB a small view's rows cost; a store of large views runs past it and is reported as usual
  [RECALL_SEED_SOURCE]: { perMinute: 32 * 1024 * 1024, total: 32 * 1024 * 1024, what: "first build of recall views" },
  // the search index's own designed pace (message-search-index.ts SEARCH_WRITE_BYTES_PER_MIN), while the worker reports it is still building
  [SEARCH_SEED_SOURCE]: { perMinute: 256 * 1024 * 1024, total: 4 * 1024 * 1024 * 1024, what: "first search index of existing messages" },
};
/** MAIN-RULING 2026-11-22 idle-capture: THE definition of planned writes, shared by the minute tick (what the watchdog judges) and by idle
 *  admission (what a capture or a copy may still write while idle), so the two cannot drift. A source is planned when it writes under a
 *  budget of its own: the recall reclaimer's bucket (every recall build slice is charged there, recall-view.ts reclaimCharge) and the named
 *  one-time seed budgets. Everything else is unplanned and stays under the minute's ceiling. */
export function isPlannedSource(source: string): boolean { return source === RECALL_RECLAIM_SOURCE || Object.hasOwn(IO_SEED_BUDGETS, source); }
export interface PlannedSeedUse { name: string; seed: IoSeedBudget; wrote: number; allowed: number; spent: number }
/** The planned share of `minutes` of writing. `wrote` gives the bytes each planned source wrote in the window, `owedCapture` the bytes
 *  that captures owed by a message settled in it, `reader` the bytes of a writer that reports its own (setPlannedBytes; believed up to
 *  `readerCap` a minute), `seedSpent` what a seed source has already used of its per-process total. Pure: the caller commits the seed
 *  use it accepts. Only sources isPlannedSource names are ever read.
 *  MAIN-RULING 2026-11-22T18:25:43Z idle-owed-capture: a capture owed by a message writes under a budget of its own, the BG minute
 *  ceiling (admit's hard cap), so its settled bytes are planned up to that ceiling, here, for the tick and for admission alike. */
export function plannedWrites(minutes: number, wrote: (source: string) => number, owedCapture: number, reader: (() => number) | null, readerCap: number, seedSpent: (source: string) => number): { planned: number; owed: number; seeds: PlannedSeedUse[] } {
  const of = (source: string) => isPlannedSource(source) ? Math.max(0, Number(wrote(source)) || 0) : 0;
  const owed = Math.min(BG_MINUTE_BYTES * minutes, Math.max(0, Number(owedCapture) || 0));
  let planned = owed;
  if (reader) { try { planned += Math.min(readerCap * minutes, Math.max(0, Number(reader()) || 0)); } catch { /* an unreadable reader plans nothing */ } }
  // recall-reclaim keeps to its own bucket (RECALL_RECLAIM_BYTES_PER_MINUTE): metered and in the io-minute facts, never counted against a foreground minute.
  planned += Math.min(RECALL_RECLAIM_BYTES_PER_MINUTE * minutes, of(RECALL_RECLAIM_SOURCE));
  // named one-time seed budgets (IO_SEED_BUDGETS): allowed up to the per-minute room and what is left of the per-process total
  const seeds: PlannedSeedUse[] = [];
  for (const [name, seed] of Object.entries(IO_SEED_BUDGETS)) {
    const bytes = of(name);
    if (bytes <= 0) continue;
    const spent = seedSpent(name), allowed = Math.max(0, Math.min(bytes, seed.perMinute * minutes, seed.total - spent));
    seeds.push({ name, seed, wrote: bytes, allowed, spent });
    planned += allowed;
  }
  return { planned, owed, seeds };
}
/** Ledger slot 32 (admission-shared.ts): the planned bytes inside this admission minute's observed total, published at every owner reading. */
const PLANNED_SLOT = 32;
export const IO_BUDGET_CPU_FRACTION = 0.8;
export const IO_BUDGET_CPU_MINUTES = 3;
export const IO_BUDGET_MAX_SCALE = 8;
/** Calm minutes in a row before the poll scale is halved back. */
export const IO_BUDGET_CALM_MINUTES = 10;
/** The OS write floor and the WAL readers live in io-written.ts (a leaf the memory helper can import): on win32 the floor is 0,
 *  because fsWrite there counts pipe and IPC writes too, and application bytes decide (WIN-IOB-QUICK; what that still sees is
 *  listed in that file's header). */
export { BLOCK_BYTES, fileGrowthReader, noteWrittenBytes, noteWrittenFile, osWriteBlocks, walFrameReader } from "./io-written.ts";

/** What one reading of the process looks like. All values are cumulative. */
/** `osKnown` false: the OS write count could not be read (macOS without the addon's diskWritten): that minute's OS bytes are UNKNOWN. */
export interface IoReading { at: number; fsWriteBlocks: number; cpuMicros: number; osKnown?: boolean; meterBytes?: number; /** Validity per source (D6.2 X1): a source is valid only when known === true; an absent flag is NOT known. */ meter?:{total:number;known:boolean}; os?:{total:number;known:boolean}; sentinelGeneration?:string|null; coverageKnown?:boolean }
export interface StatementCost { sql: string; calls: number; ms: number }

export interface IoBudgetOptions {
  read?: () => IoReading;
  log?: (line: string) => void;
  /** Called whenever the poll scale changes. 1 = normal; 2 = half as often; and so on. */
  onScale?: (scale: number) => void;
  bytesPerMinute?: number;
  cpuFraction?: number;
  cpuMinutes?: number;
  isIdle?: () => boolean;
  onMemoryWork?: () => void;
  /** The whole computer is overloaded (default: the system-load sampler, which reads nothing until started). */
  systemOverloaded?: () => { overloaded: boolean; why: string } | null;
  /** Told every judged minute, calm and zero minutes included (1.0.9 Sentinel's io-minute fact). Enums and byte counts
   *  only: never statement text or a file path. A throw is ignored. */
  onSample?: (sample: IoSample) => void;
  /** Reads and restarts the minute's traffic counters (net-meter.ts). A throw is ignored. */
  netMinute?: () => NetMinute;
  /** Takes the logical output bytes noted since the last call (io-written.ts takeWrittenBytes; the process singleton only). */
  written?: () => Iterable<[string, number]>;
  /** q1022-ordfiles: what the native meter saw per database file since the last call (database:* bucket deltas). Database bytes are named
   *  by the source whose transaction wrote them (takeWrittenBytes leaves these buckets out); this reader only names the bytes no source took. */
  databaseBuckets?: () => Iterable<[string, number]>;
}

/** The process's cumulative writes and CPU. macOS (IO-IDLE r3.6): getrusage's block count reads 0 there, so the OS floor is the addon's
 *  diskWritten bytes (os-disk-written.ts), in BLOCK_BYTES units (not rounded); unreadable is osKnown false, never 0 blocks. */
export function readProcess(platform: string = process.platform, disk: () => number | null = darwinWrittenBytes): IoReading {
  const {snapshot,process:reading}=sampleSentinelFileIo(()=>{
    const usage=process.resourceUsage(),at=Date.now(),cpuMicros=usage.userCPUTime+usage.systemCPUTime;
    const knownTotal=ioMeterTotal(),counted=knownTotal??ioMeterSnapshot()?.total??null;
    return {usage,at,cpuMicros,knownTotal,counted};
  });
  const {usage,at,cpuMicros,knownTotal,counted}=reading;
  const sentinelGeneration=snapshot.epoch===null?null:`${snapshot.epoch}/${snapshot.lossSerial}/${snapshot.continuity}`;
  const countedReading={...(counted===null?{}:{meterBytes:counted}),coverageKnown:ioMeterCoverageKnown(snapshot.known)};
  const coverage=countedReading.coverageKnown;
  if(platform==="win32")return {at,fsWriteBlocks:(counted??0)/BLOCK_BYTES,cpuMicros,...countedReading,sentinelGeneration,...(knownTotal!==null&&coverage?{}:{osKnown:false})};
  // Preserve the OS floors. Missing external coverage still makes the complete
  // measurement UNKNOWN while all observed bytes continue to be charged.
  if(platform!=="darwin")return {at,fsWriteBlocks:osWriteBlocks(usage,platform),cpuMicros,...countedReading,sentinelGeneration};
  const bytes=disk();
  return {at,fsWriteBlocks:(bytes??0)/BLOCK_BYTES,cpuMicros,...countedReading,sentinelGeneration,...(bytes!==null?{}:{osKnown:false})};
}

// Ledger owner: scperf-p1. VFS and checkpoint consumers: scperf-p1.
export const BG_MINUTE_BYTES = 12 * 1024 * 1024;
/** 1.0.22 bgstarve (field: "[memory-worker] subsystem=capture cause=BG_DEFERRED ... since=2026-11-18 next=later", capture, index,
 *  learning, reflection and maintenance refused for six days while other writers spent every minute's allowance): background memory work
 *  is never deferred without limit. MAIN ruling 2026-11-25T00:06:14Z, RELIEF DOOR = ONE DISPATCHER:
 *  the gate keeps NO queue, NO clock and NO offer. The dispatcher (worker-controller.ts reliefDispatch, the worker's tick) keeps the one
 *  ticket array (a family with a real pending job that has waited BG_MAX_DEFERRAL_MS), and at a minute's start names the ONE family
 *  that holds the minute's grant (grantBgRelief). What the gate does:
 *  - a reservation of the holding family that the gate's own clauses refuse is taken from the minute's ONE grant of at most
 *    BG_RELIEF_MINUTE_BYTES (every relief ticket of the minute, so what is open plus what was written never passes it); the gate's
 *    own room is used first (relief is looked at only after the gate's own clauses refused);
 *  - nothing reserves more than what is left of the grant (a helper index step is cut to it: worker-controller.ts, index-wal.ts);
 *  - no grant and no relief ticket while an owner's turn is held (holdBgReliefWhile);
 *  - a question about room (backgroundRoom, bgReliefGrantRoom) changes nothing: it reads the holder and what is left;
 *  - it records when a job of a lane last RAN by the gate's own rules (a whole slice admitted and settled with bytes written,
 *    bgLaneRanAt): the dispatcher restarts that family's wait from it. A relief ticket never does.
 *  Owner: lane q1022-bgstarve (this rule and its witnesses); scperf-p1 owns the ledger it sits on. The safety doors stay closed (WAL
 *  half gate, poisoned or stuck ledger, full ticket table, the minute's last 5 s). */
export const BG_MAX_DEFERRAL_MS = 10 * 60_000;
/** One slice: what the gate's own largest background slice reserves (beforeWrite: 1 MiB of writes plus the copy they owe). A smaller one
 *  cannot hold a capture's publication transaction, which would then be granted and refused for ever. */
export const BG_RELIEF_SLICE_BYTES = 1536 * 1024;
/** The room at which the write gate's reservation is the largest it ever takes (beforeWrite: half the room, at most 1 MiB of writes). */
export const BG_WRITE_GATE_FULL_ROOM = 2 * 1024 * 1024;
/** The minute's one relief grant: what its tickets have open plus what the settled ones wrote. */
export const BG_RELIEF_MINUTE_BYTES = 4 * 1024 * 1024;
/** The judge's allowance for a minute's relief grant: the granted bytes times this (MAIN 2026-11-24T23:23:46Z: the OS amplification). */
export const BG_RELIEF_JUDGE_FACTOR = 1.2;
const CAPTURE_RESERVATION_RETRY_MS = 1000;
/** 1.0.21 B3 (MEMORY-V2-DESIGN 4.8, F16): a refusal caused by a missed ledger lock (lock() has already spun to its bounded deadline) is retried
 * after this short step, never deferred to the next minute: the lock is held for microseconds by a checkpointer, not by spent bytes. */
export const LOCK_MISS_RETRY_MS = 250;
/** IDLECPU-1022 cause 3 (MAIN-RULING 2026-11-25T13:37:06Z): the admission refresh runs every ADMISSION_REFRESH_MS while it is needed; after a
 *  main-thread lock miss it waits ADMISSION_MISS_BACKOFF_MS, doubling per further miss up to ADMISSION_MISS_BACKOFF_MAX_MS, until a section takes
 *  the lock again. A miss is a WARN line (at most one per ADMISSION_MISS_WARN_MS); ERROR only after ADMISSION_MISS_ERROR_MS of misses with no
 *  section taking the lock. */
export const ADMISSION_REFRESH_MS = 25;
export const ADMISSION_MISS_BACKOFF_MS = 250;
export const ADMISSION_MISS_BACKOFF_MAX_MS = 2_000;
export const ADMISSION_MISS_WARN_MS = 60_000;
export const ADMISSION_MISS_ERROR_MS = 60_000;
/** 1.0.21 B4/B5 (MEMORY-V2-DESIGN 4.8): background memory writes stop first, at half the 512 MiB hard gate of un-copied WAL
 * (wal-maintenance.ts WAL_ADMISSION_BYTES), so owner sends are the last thing refused. A refusal at the half gate retries after
 * WAL_HALF_RETRY_MS (the off-thread copy, not the minute, reopens it). */
export const WAL_HALF_GATE_BYTES = 256 * 1024 * 1024;
export const WAL_HALF_RETRY_MS = 1000;
/** 1.0.21 B4 (MEMORY-V2-DESIGN 4.8): the one background bucket for work nobody waits on (prune, dead-term clean-up, the migration runner
 * of section 5, retention). Its bytes are declared to the watchdog as planned (never a fault), and it is stopped first at the WAL half gate.
 * Consumers (lane I: migration runner and retention) ask backgroundBucketWait() before a slice and chargeBackgroundBucket() after it; a
 * slice stays at or under the bucket's minute (only that much is planned per minute: a larger one is debt for the bucket and a fault for the
 * watchdog). */
export const BACKGROUND_BUCKET_BYTES_PER_MINUTE = 8 * 1024 * 1024;
/** W5 (D-R4 1.5): the free-disk floor an index-debt copy leaves untouched (wal-maintenance's low-disk floor, 64 MiB). */
export const INDEX_DEBT_DISK_FLOOR_BYTES = 64 * 1024 * 1024;
/** SEAN 1114-MEM-DELETE-IDLE-WINDOW: settled owner-deletion bytes a minute while the idle exemption is in use. Equal to
 * REVOKE_WRITE_BUDGET.bytesPerMinute (memory/revoke-budget.ts; a test holds the two together). */
export const OWNER_DELETE_IDLE_BYTES_PER_MINUTE = 20 * 1024 * 1024;
export interface AdmissionTicket { readonly bytes:number; readonly debtBytes:number; readonly expiresAt:number; readonly minute:number; readonly cls:"BG"|"BOOT_RECOVERY"|"FGCOPY"; readonly observed:number }
export interface BackfillMark { salt:string; frame:number; complete?:boolean }
interface DebtEntry { mark:BackfillMark; published:number; pending:number; pendingMoved:number }
/** D6 bounds (DESIGN-D6.md section 2): every walk in the ledger is over at most RESERVED_MAX + DEBT_MAX + TABLE_N entries. */
export const RESERVED_MAX=64,DEBT_MAX=16,TABLE_N=4;
const SETTLEMENT_LOUD_MS=2000,SETTLEMENT_STUCK_MS=10_000,TICKET_GRACE_MS=60_000,STALE_RESERVATION_MS=120_000;
/** Admission's fast process floor never opens receipt files or advances a
 * coverage endpoint. The minute tick owns the authenticated external sample. */
/** Production conversion of the process counters to an admission reading. The deps are parameters only so a test can drive the real
 * conversion with another platform or meter snapshot. `meter.known` is copied from ioMeterSnapshot (an absent flag is NOT known). On
 * win32 the OS reading is an alias of the meter, never a second source: its validity is always false. */
export function readAdmissionProcess():IoReading {
 const platform=process.platform,meterSnapshot=ioMeterSnapshot,meterTotal=ioMeterTotal,disk=darwinWrittenBytes;
 const usage=process.resourceUsage(),at=Date.now(),cpuMicros=usage.userCPUTime+usage.systemCPUTime;
 const snap=meterSnapshot();
 const counted=meterTotal()??snap?.total??null;
 const meterField=snap?{meter:{total:snap.total,known:snap.known===true}}:counted===null?{}:{meter:{total:counted,known:false}};
 const meter={...(counted===null?{}:{meterBytes:counted}),...meterField};
 if(platform==="win32")return {at,fsWriteBlocks:(counted??0)/BLOCK_BYTES,cpuMicros,...meter,os:{total:counted??0,known:false},...(counted===null?{osKnown:false}:{})};
 if(platform==="darwin"){const bytes=disk();return {at,fsWriteBlocks:(bytes??0)/BLOCK_BYTES,cpuMicros,...meter,os:{total:bytes??0,known:bytes!==null},...(bytes===null?{osKnown:false}:{})};}
 const blocks=osWriteBlocks(usage);
 return {at,fsWriteBlocks:blocks,cpuMicros,...meter,os:{total:blocks*BLOCK_BYTES,known:true}};
}
/** The readers wal-maintenance hands in (B4 walBacklog, the index-debt disk gate) live beside the instance, not on it: the fixture port
 * integrity (server/testing/port-integrity.ts) snapshots the exported singleton's own properties and treats a function that appears on it
 * later as tampering, and a booted app sets both at its first database open. rel/1023: same behaviour, per instance. */
const walBacklogReaders=new WeakMap<object,(()=>number|null)|null>();
const indexDebtDiskReaders=new WeakMap<object,(()=>{refusing:boolean;free:number|null})|null>();
export class IoBudget {
  private readonly read: () => IoReading;
  private readonly admissionRead: () => IoReading;
  private readonly log: (line: string) => void;
  /** Diagnostics that are not a fault (a normal minute-boundary measurement break): the injected log if there is one, else console.info, never a warning. */
  private readonly notice: (line: string) => void;
  private onScale: (scale: number) => void;
  private readonly bytesPerMinute: number;
  private readonly cpuFraction: number;
  private readonly cpuMinutes: number;
  private last: IoReading | null = null;
  /** Bytes each seed source has already been allowed in this process (IO_SEED_BUDGETS total). */
  private readonly seedSpent = new Map<string, number>();
  private hotCpuMinutes = 0;
  private calmMinutes = 0;
  private scale = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statements = new Map<string, StatementCost>();
  private bytes = new Map<string, number>();
  private byteSources = new Map<string, {read: () => number; last: number; child:boolean}>();
  private childBytes=0;
  private sourceContext = new AsyncLocalStorage<{source:string;deferred?:BgDeferred}>();
  private isIdle: () => boolean;
  private onMemoryWork?: () => void;
  private systemOverloaded: () => { overloaded: boolean; why: string } | null;
  private onSample?: (sample: IoSample) => void;
  private netMinute?: () => NetMinute;
  private written?: () => Iterable<[string, number]>;
  private databaseBuckets?: () => Iterable<[string, number]>;
  private deferredSource: string | null = null;
  private deferUntil = 0;
  /** A leaky bucket's finish time: constant state, including an oversized slice's debt, independent of history or writer count. */
  private backgroundDebtAt = 0;
  private foregroundActivity = false;
  /** idle DO LESS (idleQuiet): told once when a section turns the published idle verdict back to active (the first turn after an idle
   *  stretch), outside the ledger lock and never inline, so work paused to the next minute's look runs on that turn. */
  private readonly onActiveListeners = new Set<() => void>();
  /** Bytes written in the last minute under a budget of their own (the revoke marker's, revoke-budget.ts): planned, capped there, and
   *  taken off the minute's writes before the verdict, so a walk at its allowance is not reported as a fault and punished with a slower poll
   *  rate for everything else (SELF-OVERLOAD-105 item 1b). */
  private plannedBytes: (() => number) | null = null;
  /** The most the planned reader is believed for in one minute: its own budget plus a margin. A reader that claims more hides nothing. */
  private plannedCap = Number.POSITIVE_INFINITY;
  /** Planned sources' bytes (isPlannedSource) noted since the last admission section, and their sum inside the current admission minute.
   *  They are folded in at each section, on the same boundary as the observed total (slot 11), so the planned share that idle admission
   *  takes off is the planned part of exactly the bytes it counted. */
  private plannedPending = new Map<string, number>();
  private plannedMinute = new Map<string, number>();
  private plannedMinuteOf = -1;
  /** Totals at the last statement-trace line, so each line is one minute's cost. */
  private traced = new Map<string, { calls: number; ms: number }>();
  private traceTimer: ReturnType<typeof setInterval> | null = null;
  /** One diagnostic per category per minute; three fixed keys bound state even as sources change. */
  private readonly diagnosticLogs = new Map<"writing" | "cpu" | "both" | "traffic" | "unknown", { at: number; suppressed: number }>();

  private readonly admissionShared:ReturnType<typeof checkpointLedger>;
  /** AdmissionLockTimeout health: counted, logged loudly (rate limited) and reported by GET /api/health (admissionHealth). */
  /** B3: the latest critical section missed the ledger lock (true) or took it (false). */
  private lastSectionMissed=false;
  /** B4: the reader of the un-copied WAL bytes (wal-maintenance). */
  /** wal-maintenance.ts hands in its un-copied log reading (walBacklog) at start and null at stop. */
  setWalBacklog(read:(()=>number|null)|null):void {walBacklogReaders.set(this,read);}
  /** B4: at or past the half gate. An unreadable log reads as past it (background work waits; the owner path never asks). */
  walHalfGate():boolean {
    const read=walBacklogReaders.get(this);if(!read)return false;
    try{const bytes=read();return bytes!==null&&!(bytes<WAL_HALF_GATE_BYTES);}catch{return true;}
  }
  private lockTimeouts=0;private lastLockTimeout:{site:string;at:number}|null=null;private lockTimeoutLoggedAt=0;private lockTimeoutSuppressed=0;
  private admissionMinute=-1;
  private admissionTimer:ReturnType<typeof setTimeout>|null=null;
  private admissionArms=0;private admissionFires=0;
  /** IDLECPU-1022 cause 3 (MAIN-RULING 2026-11-25T13:37:06Z): main-thread lock misses since the last section that took the lock, the first
   * miss's time, the armed refresh's delay and the last miss line. A miss backs the refresh off (ADMISSION_MISS_BACKOFF_MS doubling to
   * ADMISSION_MISS_BACKOFF_MAX_MS); a section that takes the lock resets it. */
  private missStreak=0;private missSince:number|null=null;private admissionDelay=0;private admissionFiring=false;private missWarnAt=0;private missWarnSuppressed=0;
  /** B4 diagnostics: BG admissions refused at the WAL half gate. */
  halfGateRefusals=0;
  /** Open main-thread tickets. Reservations are live work: a minute flip never clears them; settle or expiry releases each exactly once. */
  private reserved=new Map<AdmissionTicket,{write:number;debt:number;end:number}>();
  /** Running sums over `reserved` (O(1) rebuild, no walk). */
  private sumWrite=0;private sumBg=0;
  /** Owner-deletion copies admitted through the idle exemption this minute: settled bytes plus what is still reserved. */
  private ownerIdle={minute:-1,settled:0,reserved:0,tickets:new Map<AdmissionTicket,number>()};
  /** MAIN-RULING 2026-11-22 idle-owed-capture: what captures owed by a message settled, in this admission minute (captureIdle: their
   * charge, as slot 3 counts them) and since the last tick (owedTick: the bytes they wrote, as the tick's total counts them). The two
   * windows feed the ONE definition (plannedWrites' owed term, capped at the BG minute ceiling): admission takes the term off what the
   * idle allowance has used (slot 32), the tick takes it off the minute it judges; each takes off exactly what its own total holds. An owed capture is admitted
   * under the BG minute ceiling (slot 2), which stays its hard cap; every unplanned write still closes the idle allowance. */
  private captureIdle={minute:-1,settled:0};
  private captureTickets=new Set<AdmissionTicket>();
  private pendingCapture=0;
  private owedTick=0;
  /** MAIN-RULING 2026-11-22T20:47:34Z idle-retry: "each retry counts against the idle write allowance". The grant of a helper start that
   * is a retry, or of an idle start that died before it was ready, is no owed capture's write: it leaves the owed term here, for
   * admission (captureIdle, slot 32) and for the tick (owedTick) alike, so its charge stays in what the idle allowance has used. */
  countAgainstIdle(ticket:AdmissionTicket):void {this.captureTickets.delete(ticket);}
  private captureSettled():number {
    if(this.captureIdle.minute!==this.admissionMinute){this.captureIdle.minute=this.admissionMinute;this.captureIdle.settled=0;}
    return this.captureIdle.settled;
  }
  private ownerIdleBytes():number {
    if(this.ownerIdle.minute!==this.admissionMinute){this.ownerIdle.minute=this.admissionMinute;this.ownerIdle.settled=0;this.ownerIdle.reserved=0;this.ownerIdle.tickets.clear();}
    return this.ownerIdle.settled+this.ownerIdle.reserved;
  }
  /** Copy debt, at most DEBT_MAX entries. `published` is in slot 4; `pending` is a deferred settlement's debt not yet in slot 4;
   * `pendingMoved` was pending when its frames were already copied (goes straight to slot 2 at the next drain). */
  private copyDebt:DebtEntry[]=[];
  /** One additive delta for settlements whose critical section could not be taken. Never dropped. */
  private pendingDelta:{d2:number;d5:number;d6:number;d8:number}|null=null;
  private pendingSince:number|null=null;
  private retryMarks=new Map<string,BackfillMark>();
  private liveOwners=new Set<bigint>();private rescanOwners=false;
  private sectionReading:IoReading|null=null;private lastReadingAt=0;private nextExpiryAt=0;
  private settlementStuck=false;
  private readonly brk={meter:{seen:false,valid:false,prev:null as number|null,last:-1},os:{seen:false,valid:false,prev:null as number|null,last:-1}};
  private breakLoggedAt=0;
  /** Timeouts per call site (a fixed set of names, at most 16 kept). */
  private readonly siteCounts=new Map<string,number>();
  private readonly counters={reservedFull:0,tableFull:0,expiredTickets:0,debtFolded:0,debtFull:0,staleReservation:0};
  private debtFullHandled=0;
  private readonly loudAt=new Map<string,number>();
  /** One loud line per key per windowMs; a line never changes the ledger. */
  private loud(key:string,windowMs:number,line:string):void {
    const now=Date.now();if(now-(this.loudAt.get(key)??0)<windowMs)return;this.loudAt.set(key,now);
    try{this.log(`[io-budget] ERROR ${line}`);}catch{/* a line never changes the ledger */}
  }
  /** The two measuring sources of a reading with their validity. A source is VALID only when known === true and its total is finite.
   * An absent flag is NOT known (never defaulted to true). On win32 the OS reading is an alias of the meter, not a source. */
  private sourceOf(r:IoReading,which:"meter"|"os"):{total:number;known:boolean}|null {
    if(which==="meter"){
      if(r.meter)return {total:r.meter.total,known:r.meter.known===true};
      return r.meterBytes===undefined?null:{total:r.meterBytes,known:false};
    }
    if(r.os)return {total:r.os.total,known:r.os.known===true};
    return {total:r.fsWriteBlocks*BLOCK_BYTES,known:r.osKnown!==false};
  }
  private static valid(s:{total:number;known:boolean}|null):boolean {return s!==null&&s.known===true&&Number.isFinite(s.total);}
  /** Continuity per source: the most recent reading in which it was not valid, whose total went down, or the first reading. */
  private noteSources(r:IoReading):void {
    for(const which of ["meter","os"] as const){
      const s=this.sourceOf(r,which),ok=IoBudget.valid(s),st=this.brk[which];
      let broke=false;
      if(!st.seen)broke=true;else if(!ok)broke=true;else if(st.prev!==null&&s!.total<st.prev)broke=true;
      const first=!st.seen,wasValid=st.prev!==null&&st.valid;st.seen=true;st.valid=ok;
      if(ok)st.prev=s!.total;
      if(broke){
        st.last=Math.max(st.last,r.at);
        if(!first&&wasValid&&Date.now()-this.breakLoggedAt>60_000){this.breakLoggedAt=Date.now();try{this.notice(`[io-budget] admission measurement break: the ${which} source was not continuously valid; reservations older than this are charged, not released`);}catch{/* a line never changes the ledger */}}
      }
    }
  }
  /** Whether a dead owner's entry is proven inside the observed counters (X1): older than this minute, and a source that is valid in this
   * section's reading and was valid without a break since before the entry's minute began. Otherwise it is charged now. */
  private covered(minute:number):boolean {
    const r=this.sectionReading;if(!r)return false;
    if(!(minute<Math.floor(r.at/IO_BUDGET_INTERVAL_MS)))return false;
    const start=minute*IO_BUDGET_INTERVAL_MS;
    // B1/I8: only the meter can prove coverage; the OS counter is no admission input on any OS.
    return IoBudget.valid(this.sourceOf(r,"meter"))&&this.brk.meter.last<start;
  }
  private readonly isLiveOwner=(o:bigint)=>this.liveOwners.has(o);
  private readonly coveredFor=(_o:bigint,minute:number)=>this.covered(minute);
  /** Every main operation takes the ledger lock ONCE (a compare-exchange retried for at most a quarter of a millisecond, never a sleep). Order inside: rotate, publish the reading,
   * evaluate the stuck predicate, drain deferred work into the now-current minute, then the operation. On a failed CAS nothing runs:
   * the failure is counted and logged, deferred work stays pending, and `closed` is returned. */
  private critical<T>(site:string,op:(reading:IoReading,stuck:boolean)=>T,closed:T,failClosedIdle=false):T {
    const reading=this.admissionRead();this.lastReadingAt=reading.at;
    this.noteSources(reading);
    // D4: the idle verdict walks the server's bot and group tables; it is read BEFORE the lock, never inside the critical section.
    const idle=this.isIdle()&&!this.foregroundActivity?1n:0n;
    const a=this.admissionShared;
    try{a.lock();}catch(error){
      // A miss never leaves a looser verdict than the one just computed: an idle verdict is stored even where the caller asked not to fail closed,
      // so a stale "active" mark from before the server turned idle cannot admit a copy past the idle allowance (only an active verdict is skipped).
      if(isAdmissionLockTimeout(error)){this.lastSectionMissed=true;this.missStreak++;this.missSince??=Date.now();this.noteLockTimeout(site,true);if(failClosedIdle||idle!==0n)Atomics.store(a.slots,7,1n);this.armAdmission();return closed;}
      throw error;
    }
    this.lastSectionMissed=false;this.missStreak=0;this.missSince=null;
    try{
      a.rotate(reading.at);
      this.admissionMinute=Math.floor(reading.at/IO_BUDGET_INTERVAL_MS);
      const os=reading.fsWriteBlocks*BLOCK_BYTES,meter=reading.meterBytes??0;
      // 1.0.21 B1/I8 (MEMORY-V2-DESIGN 4.8): admission sees only the application's own counted bytes (the meter, the same on every OS).
      // The OS counter (darwin diskWritten: the whole process; Linux fsWrite) is kept in slot 12 for the watchdog line, never an input.
      const observed=Math.max(0,meter-Number(a.slots[10]));
      Atomics.store(a.slots,11,BigInt(Math.max(Number(a.slots[11]),observed)));
      Atomics.store(a.slots,3,a.slots[11]+a.slots[8]);
      Atomics.store(a.slots,12,BigInt(os));Atomics.store(a.slots,13,BigInt(meter));
      this.publishPlanned();
      const wasIdle=a.slots[7]!==0n;
      Atomics.store(a.slots,7,idle);
      if(wasIdle&&idle===0n&&this.onActiveListeners.size)setImmediate(()=>{for(const listener of [...this.onActiveListeners]){try{listener();}catch{/* a listener never changes the ledger */}}});
      this.sectionReading=reading;
      const age=this.pendingSince===null?0:reading.at-this.pendingSince;
      const stuck=this.pendingSince!==null&&age>SETTLEMENT_STUCK_MS;
      this.settlementStuck=stuck;
      if(this.pendingSince!==null&&age>SETTLEMENT_LOUD_MS)this.loud("pending",10_000,`admission settlement pending for ${Math.round(age/1000)} s (the ledger lock was busy at every attempt); it is kept and retried${stuck?"; background admission is refused until it drains":""}`);
      this.drain(reading);
      return op(reading,stuck);
    }finally{this.sectionReading=null;a.unlock();this.armAdmission();}
  }
  /** Inside a critical section, after rotate and the observed total: the planned bytes noted since the last section join this admission
   *  minute, and slot 32 takes the minute's planned share (plannedWrites, the tick's own definition), never more than was observed. Called again
   *  whenever an owed capture settles, so the next admission in the same section already sees it. */
  private publishPlanned():void {
    const s=this.admissionShared.slots;
    if(this.plannedMinuteOf!==this.admissionMinute){this.plannedMinute.clear();this.plannedMinuteOf=this.admissionMinute;}
    if(this.plannedPending.size){for(const [name,bytes] of this.plannedPending)this.plannedMinute.set(name,(this.plannedMinute.get(name)??0)+bytes);this.plannedPending.clear();}
    const share=plannedWrites(1,name=>this.plannedMinute.get(name)??0,this.captureSettled(),this.plannedBytes,this.plannedCap,name=>this.seedSpent.get(name)??0);
    // (upkeep is inside the observed total, slot 11; an owed capture's settled bytes are inside the whole total, slot 3)
    const upkeep=Math.max(0,Math.min(Number(s[11]),Math.floor(share.planned-share.owed)));
    if(s.length>PLANNED_SLOT)Atomics.store(s,PLANNED_SLOT,BigInt(upkeep+Math.max(0,Math.min(Number(s[3])-upkeep,Math.floor(share.owed)))));
  }
  /** What an idle minute has used of the idle allowance: the minute's total (slot 3) without its planned share (slot 32: recall upkeep,
   *  seed budgets and the owed captures' settled bytes). The 49 MiB and BG ceilings keep reading the whole total. */
  private idleUsed():number {const s=this.admissionShared.slots;return Math.max(0,Number(s[3])-(s.length>PLANNED_SLOT?Number(s[PLANNED_SLOT]):0));}
  /** 1.0.21 B2 (MEMORY-V2-DESIGN 4.8, no idle timer): the 25 ms admission refresh is needed only while something is open that it settles or
   * expires (a reservation, a pending settlement or delta, a copy debt or backfill mark not yet published, a section that missed the lock), or
   * while the published verdict
   * is ACTIVE, so the turn to idle is published within 25 ms. A published IDLE verdict is the strict one (copies at the idle allowance), so
   * leaving it unrefreshed fails closed; the next critical section (any admit, settle, owner action or watchdog tick) re-arms the refresh. */
  private admissionNeeded():boolean {
    return this.lastSectionMissed||this.reserved.size>0||this.pendingSince!==null||this.pendingDelta!==null||this.retryMarks.size>0
      ||this.copyDebt.some(e=>e.pending>0||e.pendingMoved>0)||Atomics.load(this.admissionShared.slots,7)===0n;
  }
  /** The refresh's next delay: ADMISSION_REFRESH_MS, or after a lock miss ADMISSION_MISS_BACKOFF_MS doubling per miss up to
   * ADMISSION_MISS_BACKOFF_MAX_MS, so a miss never re-arms a 25 ms loop that collides again (IDLECPU-1022 cause 3). */
  private admissionDelayMs():number {
    return this.missStreak===0?ADMISSION_REFRESH_MS:Math.min(ADMISSION_MISS_BACKOFF_MAX_MS,ADMISSION_MISS_BACKOFF_MS*2**Math.min(8,this.missStreak-1));
  }
  /** One-shot refresh, re-armed after each fire while admissionNeeded(). A section that takes the lock while a backed-off refresh waits
   * brings it forward to the plain delay. */
  private armAdmission():void {
    if(!this.timer||!this.admissionNeeded())return;
    const delay=this.admissionDelayMs();
    if(this.admissionTimer){if(this.admissionDelay<=delay)return;clearTimeout(this.admissionTimer);}
    else if(!this.admissionFiring)this.admissionArms++;
    this.admissionDelay=delay;
    this.admissionTimer=setTimeout(()=>{
      this.admissionTimer=null;
      this.admissionFires++;
      this.admissionFiring=true;
      try{this.readingOrNull("timer");}catch{/* admission stays conservative */}finally{this.admissionFiring=false;}
      if(!this.admissionTimer){this.admissionFiring=true;try{this.armAdmission();}finally{this.admissionFiring=false;}}
    },delay);
    this.admissionTimer.unref?.();
  }
  /** B2 diagnostics: whether the admission refresh is armed now, how often it was armed and how often it fired. */
  admissionRefresh():{armed:boolean;arms:number;fires:number} {return {armed:this.admissionTimer!==null,arms:this.admissionArms,fires:this.admissionFires};}
  /** Inside a critical section, after rotate and the reading: everything deferred lands in the current minute. */
  private drain(reading:IoReading):void {
    const a=this.admissionShared,s=a.slots;
    const sub=(slot:number,n:number)=>{if(n>0){const cur=Number(s[slot]);Atomics.sub(s,slot,BigInt(Math.min(cur,n)));}};
    if(reading.at>=this.nextExpiryAt){
      this.nextExpiryAt=reading.at+1000;
      // `reserved` is in admission order and a ticket's end only grows: the expired ones are at the front.
      const expired:[AdmissionTicket,{write:number;debt:number;end:number}][]=[];
      for(const entry of this.reserved){if(reading.at>entry[1].end+TICKET_GRACE_MS)expired.push(entry);else break;}
      for(const [ticket,rec] of expired){
        this.unreserve(ticket,rec);this.counters.expiredTickets++;
        this.loud("expired",10_000,`admission ticket never settled: converted at its full ceiling and debt after ${TICKET_GRACE_MS/1000} s past its minute (${this.counters.expiredTickets} so far)`);
        this.applySettle(ticket,rec,ticket.bytes,0,ticket.debtBytes,{salt:"unreadable",frame:Number.MAX_SAFE_INTEGER},"published");
      }
    }
    const p=this.pendingDelta;
    if(p){
      Atomics.add(s,2,BigInt(p.d2));sub(5,p.d5);sub(6,p.d6);Atomics.add(s,8,BigInt(p.d8));Atomics.store(s,3,s[11]+s[8]);
      this.pendingDelta=null;
    }
    if(this.pendingCapture){this.captureSettled();this.captureIdle.settled+=this.pendingCapture;this.pendingCapture=0;this.publishPlanned();}
    this.pendingSince=null;
    let toFour=0,toTwo=0,dirty=false;
    for(const e of this.copyDebt){if(e.pending||e.pendingMoved){toFour+=e.pending;toTwo+=e.pendingMoved;e.published+=e.pending;e.pending=0;e.pendingMoved=0;dirty=true;}}
    if(toFour)Atomics.add(s,4,BigInt(toFour));
    if(toTwo)Atomics.add(s,2,BigInt(toTwo));
    if(dirty)this.copyDebt=this.copyDebt.filter(e=>e.published>0);
    if(this.retryMarks.size){const marks=[...this.retryMarks.values()];this.retryMarks.clear();for(const m of marks)this.applyBackfill(m);}
    if(this.rescanOwners){
      a.reconcileDead(this.isLiveOwner,this.coveredFor,a.poisoned());
      this.rescanOwners=false;
    }
  }
  private unreserve(ticket:AdmissionTicket,rec:{write:number;debt:number}):void {
    this.reserved.delete(ticket);this.sumWrite-=rec.write;if(ticket.cls!=="FGCOPY")this.sumBg-=rec.write+rec.debt;
    // (a settled slice was given its unused bytes back first; an expired one is charged whole, to the judge's allowance too)
    const expired=this.bgReliefTickets.get(ticket);if(expired)this.bgReliefJudged+=expired.bytes;
    this.bgReliefTickets.delete(ticket);this.bgOwnTickets.delete(ticket);
    this.ownerIdleBytes();
    const exemptBytes=this.ownerIdle.tickets.get(ticket);
    if(exemptBytes!==undefined){this.ownerIdle.tickets.delete(ticket);this.ownerIdle.reserved-=exemptBytes;}
  }
  /** Apply one settlement now (the lock is held and the drain has run). */
  private applySettle(ticket:AdmissionTicket,rec:{write:number;debt:number},used:number,included:number,debtUsed:number|undefined,mark:BackfillMark|undefined,field:"published"|"pending"):void {
    const s=this.admissionShared.slots;
    const sub=(slot:number,n:number)=>{if(n>0){const cur=Number(s[slot]);Atomics.sub(s,slot,BigInt(Math.min(cur,n)));}};
    const owed=this.captureTickets.delete(ticket);
    if(owed){this.captureSettled();this.captureIdle.settled+=used;}
    if(ticket.cls!=="FGCOPY"){sub(5,rec.write+rec.debt);Atomics.add(s,2,BigInt(used));}
    sub(6,rec.write);
    Atomics.add(s,8,BigInt(Math.max(0,used-included)));Atomics.store(s,3,s[11]+s[8]);
    if(owed)this.publishPlanned();
    if(ticket.debtBytes&&used){const bytes=debtUsed??Math.min(used,ticket.debtBytes);this.insertDebt(mark!,bytes,field);}
  }
  /** D6.1 section 2. Never stores zero bytes. Rule 2: a same-salt entry with frame >= the new frame takes it (the smallest such frame;
   * released no earlier). Rule 3: when full, merge two adjacent same-salt entries with the closest frames into one with the HIGHER
   * frame. Rule 4: still full (all distinct salts): fold the TWO oldest into an "unreadable" entry (or the oldest into an existing one).
   * Every merge keeps published and pending apart so slot 4 stays the sum of `published`. */
  private insertDebt(mark:BackfillMark,bytes:number,field:"published"|"pending"):void {
    const s=this.admissionShared.slots;
    if(bytes<=0)return;
    if(field==="published")Atomics.add(s,4,BigInt(bytes));
    const list=this.copyDebt;
    let best:DebtEntry|null=null;
    for(const e of list){if(e.mark.salt===mark.salt&&e.mark.frame>=mark.frame&&(best===null||e.mark.frame<best.mark.frame))best=e;}
    if(best){best[field]+=bytes;return;}
    if(list.length>=DEBT_MAX){
      // Rule 3.
      let bi=-1,bd=Infinity;
      for(let i=0;i+1<list.length;i++){if(list[i]!.mark.salt===list[i+1]!.mark.salt){const d=Math.abs(list[i+1]!.mark.frame-list[i]!.mark.frame);if(d<bd){bd=d;bi=i;}}}
      if(bi>=0){const lo=list[bi]!,hi=list[bi+1]!;hi.published+=lo.published;hi.pending+=lo.pending;hi.pendingMoved+=lo.pendingMoved;list.splice(bi,1);}
    }
    if(list.length>=DEBT_MAX){
      // Rule 4.
      this.counters.debtFolded++;
      const ui=list.findIndex(e=>e.mark.salt==="unreadable");
      if(ui>=0){
        const oi=ui===0?1:0,old=list[oi]!,u=list[ui]!;
        u.published+=old.published;u.pending+=old.pending;u.pendingMoved+=old.pendingMoved;list.splice(oi,1);
      }else{
        const a0=list[0]!,a1=list[1]!;
        const folded:DebtEntry={mark:{salt:"unreadable",frame:Number.MAX_SAFE_INTEGER},published:a0.published+a1.published,pending:a0.pending+a1.pending,pendingMoved:a0.pendingMoved+a1.pendingMoved};
        list.splice(0,2,folded);
      }
    }
    if(list.length>=DEBT_MAX){this.counters.debtFull++;this.loud("debtFull",10_000,"admission debt list is full and cannot be folded; background admission is refused");}
    list.push({mark:{salt:mark.salt,frame:mark.frame},published:field==="published"?bytes:0,pending:field==="pending"?bytes:0,pendingMoved:0});
  }
  private static matches(e:DebtEntry,mark:BackfillMark):boolean {
    return e.mark.salt==="unreadable"?mark.complete===true:(e.mark.salt!==mark.salt||e.mark.frame<=mark.frame);
  }
  /** Lock held. Moves the published bytes of matching entries from slot 4 to slot 2. */
  private applyBackfill(mark:BackfillMark):void {
    const s=this.admissionShared.slots;
    let moved=0;const keep:DebtEntry[]=[];
    for(const e of this.copyDebt){
      if(IoBudget.matches(e,mark)){moved+=e.published;e.published=0;}
      if(e.published+e.pending+e.pendingMoved>0)keep.push(e);
    }
    if(moved){Atomics.add(s,2,BigInt(moved));const cur=Number(s[4]);Atomics.sub(s,4,BigInt(Math.min(cur,moved)));}
    this.copyDebt=keep;
  }
  /** admissionReading for callers that must not throw: null means the lock was busy (counted and logged); the caller does nothing this tick. */
  private readingOrNull(site="admissionReading",failClosedIdle=true):IoReading|null {
    return this.critical<IoReading|null>(site,reading=>reading,null,failClosedIdle);
  }
  /** Every AdmissionLockTimeout lands here: a counter and the health field. A main-thread miss (mainMiss, critical()) is a WARN line at
   * most once per ADMISSION_MISS_WARN_MS while the lock is taken again in between; it is an ERROR only once misses have persisted, with no
   * section taking the lock, for more than ADMISSION_MISS_ERROR_MS. A checkpointer timeout (it waited its whole deadline) stays an ERROR.
   * ERROR lines: first at once, then at most one per 10 s. */
  noteLockTimeout(site:string,mainMiss=false):void {
    this.lockTimeouts++;this.lastLockTimeout={site,at:Date.now()};
    if(this.siteCounts.has(site)||this.siteCounts.size<16)this.siteCounts.set(site,(this.siteCounts.get(site)??0)+1);
    const now=Date.now();
    if(mainMiss&&!(this.missSince!==null&&now-this.missSince>ADMISSION_MISS_ERROR_MS)){
      if(now-this.missWarnAt<ADMISSION_MISS_WARN_MS){this.missWarnSuppressed++;return;}
      const suppressed=this.missWarnSuppressed;this.missWarnAt=now;this.missWarnSuppressed=0;
      try{this.log(`[io-budget] WARN AdmissionLockTimeout at ${site}: the admission ledger lock was busy (${this.lockTimeouts} so far, ${suppressed} lines suppressed); this admission or copy is refused, the refresh backs off and retries`);}catch{/* a line never changes the ledger */}
      return;
    }
    if(this.lockTimeouts>1&&now-this.lockTimeoutLoggedAt<10_000){this.lockTimeoutSuppressed++;return;}
    const suppressed=this.lockTimeoutSuppressed;this.lockTimeoutLoggedAt=now;this.lockTimeoutSuppressed=0;
    const retry = site === "checkpointAdmissionBuffer" ? "; retry on the next ledger refresh"
      : site === "wal-beginCopy" || site === "wal-endCopy" ? "; the checkpointer will retry"
        : "";
    try{this.log(`[io-budget] AdmissionLockTimeout at ${site}: the admission ledger was busy (${this.lockTimeouts} so far, ${suppressed} lines suppressed)${retry}`);}catch{/* a line never changes the ledger */}
  }
  /** A checkpointer worker found its owner table full (worker message "admission-table-full"). */
  noteTableFull():void {this.counters.tableFull++;this.loud("tableFull",10_000,`admission owner table is full (${this.counters.tableFull} refusals so far): this copy is not admitted`);}
  /** GET /api/health (server/index.ts, admissionLock): symptom counters, steady zero and not poisoned is healthy. */
  admissionHealth() {
    const s=this.admissionShared.slots;
    const stuck=this.settlementStuck||(this.pendingSince!==null&&this.lastReadingAt-this.pendingSince>SETTLEMENT_STUCK_MS);
    return {lockTimeouts:this.lockTimeouts,timeoutSites:Object.fromEntries(this.siteCounts) as Record<string,number>,lastTimeoutSite:this.lastLockTimeout?.site??null,lastTimeoutAt:this.lastLockTimeout?.at??null,poisoned:this.admissionShared.poisoned(),recoveries:this.admissionShared.recoveries(),
      pendingSince:this.pendingSince,settlementStuck:stuck,reservedFull:this.counters.reservedFull,tableFull:this.counters.tableFull,expiredTickets:this.counters.expiredTickets,
      debtFolded:this.counters.debtFolded,debtFull:this.counters.debtFull,staleReservation:this.counters.staleReservation,
      meterBreakAt:Math.max(this.brk.meter.last,this.brk.os.last),reconciles:Number(s[17]),tableFullSlot:Number(s[16])};
  }
  /** A checkpointer's identity (thread id, WM generation), registered at spawn. Only its confirmed exit removes it. */
  registerCheckpointer(threadId:number,gen:number):void {this.liveOwners.add((BigInt(threadId)<<32n)|BigInt(gen>>>0));}
  /** Main thread, after a checkpointer's confirmed exit (its 'exit' event, or terminate() resolving): recovers a lock that thread
   * still held (the ledger is then poisoned), forgets its identity and asks for an owner scan; the next section that gets the CAS
   * reconciles the entries of every exited owner. Exits of workers without an entry cost one flag write. Never called on a timer. */
  checkpointerExited(threadId:number,gen:number):boolean {
    const recovered=this.recoverAdmissionAfterExit(threadId);
    this.liveOwners.delete((BigInt(threadId)<<32n)|BigInt(gen>>>0));
    this.rescanOwners=true;
    this.critical("exit",()=>true,false);
    return recovered;
  }
  /** Main thread, after a checkpointer's confirmed exit: recovers a lock that thread still held. Never called on a timer. */
  recoverAdmissionAfterExit(threadId:number):boolean {
    const recovered=this.admissionShared.recoverAfterExit(threadId);
    if(recovered)try{this.log(`[io-budget] admission ledger: checkpointer thread ${threadId} exited inside the ledger lock; the ledger is poisoned (no copy admitted) until it is rebuilt (${this.admissionShared.recoveries()} so far)`);}catch{/* a line never changes the ledger */}
    return recovered;
  }
  /** A checkpointer did not exit within its bound: fail closed. The lock is never cleared by time. */
  poisonAdmission(reason:string):void {
    this.admissionShared.poison();
    try{this.log(`[io-budget] ERROR admission ledger poisoned: ${reason}; no copy is admitted until the next checkpointer starts`);}catch{/* a line never changes the ledger */}
  }
  /** The 1 s checkpointer tick: scan for owners that exited, flag live reservations older than two minutes, retry a pending rebuild. */
  admissionTick():void {
    this.rescanOwners=true;
    if(this.admissionShared.poisoned()){this.rebuildAdmissionIfPoisoned();return;}
    this.critical("tick",reading=>{
      const now=Math.floor(reading.at/IO_BUDGET_INTERVAL_MS);
      for(const [,o,,minute] of this.admissionShared.entries()){
        if(this.liveOwners.has(o)&&reading.at-Number(minute)*IO_BUDGET_INTERVAL_MS>STALE_RESERVATION_MS&&Number(minute)<now){
          this.counters.staleReservation++;this.loud("stale",60_000,`a live checkpointer has held an admission reservation for more than ${STALE_RESERVATION_MS/60000} minutes; it is never released by anyone else`);
        }
      }
      return true;
    },false);
  }
  /** Next checkpointer start or tick: one critical section: drain, reconcile the dead owners, recompute slots 3..6 from the owner's state
   * and the live owners' entries, then clear the poison. */
  rebuildAdmissionIfPoisoned():boolean {
    if(!this.admissionShared.poisoned())return false;
    return this.critical("rebuild",()=>{
      const a=this.admissionShared;
      if(!a.poisoned())return false;
      let debt=0;for(const e of this.copyDebt)debt+=e.published;
      a.rebuildLocked({writes:this.sumWrite,bgReserved:this.sumBg,debt},this.isLiveOwner,this.coveredFor);
      this.rescanOwners=false;
      return true;
    },false);
  }
  /** One buffer per budget; WM checks whole-copy room immediately before stepping. */
  /** Publishes the owner's reading and idle verdict, then returns the ledger. A miss of the ledger lock is counted and fails closed (strict idle) unless
   * `failClosedIdle` is false: the caller about to request a copy passes false, because a miss there usually means the checkpointer is inside the ledger
   * (or a dead worker's token holds it, which recovery poisons) and a strict verdict stored by an ACTIVE server's miss refuses the very request that
   * follows it. Only an active verdict is skipped: an idle verdict computed for this call is stored on a miss too (critical), so a miss never admits a
   * copy past the idle allowance. The 25 ms timer and every other owner reading still fail closed. */
  checkpointAdmissionBuffer(failClosedIdle=true):SharedArrayBuffer {this.readingOrNull("checkpointAdmissionBuffer",failClosedIdle);return this.admissionShared.slots.buffer as SharedArrayBuffer;}
  admissionState():{bg:number;debt:number;total:number;reserved:number;idleUsed:number} {
    const a=this.admissionShared;
    // Closed on timeout: a full minute and a full total, so every room is zero.
    const closed={bg:BG_MINUTE_BYTES,debt:0,total:49*1024*1024,reserved:0,idleUsed:49*1024*1024};
    return this.critical("admissionState",()=>({bg:Number(a.slots[2]),debt:Number(a.slots[4]),total:Number(a.slots[3]),reserved:Number(a.slots[5]),idleUsed:this.idleUsed()}),closed);
  }
  private bootRecoveryClaimed=false;
  private bootRecoveryAllowed:(()=>boolean)|undefined;
  /** Owners: scperf-p1 ledger; boot-tolerance producer. Only the initial transcript pass may claim this process's scope. */
  claimBootRecovery(allowed:()=>boolean):{run:<T>(run:()=>T)=>T;close:()=>void}|null {
    if(this.bootRecoveryClaimed)return null;
    this.bootRecoveryClaimed=true;this.bootRecoveryAllowed=allowed;
    return {
      run:run=>{
        if(!this.bootRecoveryPermitted())throw new BgDeferred(this.nextAdmissionMs());
        return this.withSource("memory-boot-recovery",run);
      },
      close:()=>{this.bootRecoveryAllowed=undefined;},
    };
  }
  private bootRecoveryPermitted():boolean {
    // MAIN-RULING 2026-11-25T07:09:02Z (idle DO LESS, no starvation): paused on an idle minute (the write gate's idleQuiet), admitted on an
    // ACTIVE minute under the BG minute cap even after owner activity this minute (foregroundActivity: an owner-only store has no other active
    // minute); it still yields while a turn streams or starts and while the owner types
    return !isReadOnly()&&this.bootRecoveryAllowed?.()===true&&ownerFirst.pressure({only:["owner-turn","work-starting","owner-typing"]})===null;
  }
  /** bgstarve, the minute's ONE relief grant: the family the dispatcher named for it (null: nobody yet) and what its tickets have open
   *  or wrote. There is no queue here (worker-controller.ts reliefDispatch owns the one ticket array). */
  private bgRelief:{minute:number;lane:string|null;used:number}={minute:-1,lane:null,used:0};
  /** The family of the work asking: named by its caller (the passes that share a source, the helper index), else its source; the capture
   *  pipeline's two sources ("memory-capture" and the worker's own slices "memory-worker") are one family. */
  private bgLane=new AsyncLocalStorage<string>();
  withBgReliefLane<T>(lane:string,run:()=>T):T {return this.bgLane.run(lane,run);}
  private bgLaneName():string {const source=this.currentSource();return this.bgLane.getStore()??(source==="memory-capture"||source==="memory-worker"?"capture":source??"");}
  /** Diagnostics and tests: every relief ticket (grants), their reserved bytes, what the settled ones wrote, the minutes that had a grant. */
  readonly bgReliefStats={grants:0,bytes:0,written:0,minutes:0};
  /** Diagnostics and tests: one row per minute that had a grant (the last 240): its one family, all its tickets, tagged or not. */
  readonly bgReliefLog:Array<{minute:number;lane:string;tickets:number;reserved:number;peak:number;written:number}>=[];
  private bgReliefRoll():void {
    if(this.bgRelief.minute!==this.admissionMinute)this.bgRelief={minute:this.admissionMinute,lane:null,used:0};
  }
  /** When a job of the family last ran by the gate's own rules (0: never seen). A fact for the dispatcher, set only by a settlement. */
  private bgRanAt=new Map<string,number>();
  bgLaneRanAt(lane:string):number {return this.bgRanAt.get(lane)??0;}
  /** How many write reservations of the family the gate's own clauses refused (and the relief grant did not cover). A fact for the
   *  dispatcher: a refused reservation is a real write somebody tried, never a question about room. */
  private bgRefusals=new Map<string,number>();
  bgLaneRefusals(lane:string):number {return this.bgRefusals.get(lane)??0;}
  /** A write of the current family was refused: by admit, by the write gate before it could size a reservation (no room: admit is
   *  never asked), or by the native grant (the transaction is larger than what was reserved). Counted whoever catches the refusal
   *  (review of 6ebaf6f091: a pass that catches it itself on a minute with no room was never owed). Never a question about room. */
  noteBgRefusal():void {const lane=this.bgLaneName();if(lane&&(this.bgRefusals.has(lane)||this.bgRefusals.size<64))this.bgRefusals.set(lane,(this.bgRefusals.get(lane)??0)+1);}
  /** The dispatcher hands back a grant its family took no ticket of (it had nothing to write): the minute is free for the next ticket. */
  returnBgRelief(lane:string):boolean {
    const relief=this.bgRelief,row=this.bgReliefLog[this.bgReliefLog.length-1];
    if(relief.minute!==this.admissionMinute||relief.lane!==lane||relief.used!==0||!row||row.minute!==relief.minute||row.tickets!==0)return false;
    relief.lane=null;this.bgReliefLog.pop();this.bgReliefStats.minutes--;
    return true;
  }
  /** On an idle minute the gate's own rules admit only an owed capture (the idle rule): every other source is refused there. */
  private bgIdleRefused(idle:boolean):boolean {return idle&&this.currentSource()!=="memory-capture";}
  /** An owner's turn on its way to the engine (worker-controller.ts holdForTurn): no relief grant or ticket starts while one is held. */
  private bgReliefHolds=new Set<()=>boolean>();
  holdBgReliefWhile(held:()=>boolean):()=>void {this.bgReliefHolds.add(held);return ()=>{this.bgReliefHolds.delete(held);};}
  private bgReliefHeld():boolean {for(const held of this.bgReliefHolds){try{if(held())return true;}catch{return true;}}return false;}
  /** The doors admit keeps closed whatever the dispatcher says, read outside its section. */
  private bgDoorsClosed():boolean {
    return this.lastSectionMissed||this.admissionShared.poisoned()||this.settlementStuck||this.counters.debtFull>this.debtFullHandled||this.reserved.size>=RESERVED_MAX
      ||this.lastReadingAt>(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS-5000||this.walHalfGate()
      // idle DO LESS (idleQuiet): no relief grant or ticket on an idle minute (the callers read the section first: admissionState)
      ||this.admissionShared.poisoned()||Atomics.load(this.admissionShared.slots,7)!==0n;
  }
  /** The dispatcher's question: may this minute's grant still be given (nobody holds it, no turn is held, no door is closed)? */
  bgReliefFree():boolean {
    this.admissionState();
    if(this.bgDoorsClosed()||this.bgReliefHeld())return false;
    this.bgReliefRoll();
    return this.bgRelief.lane===null;
  }
  /** The dispatcher's ONE act a minute: `lane` holds this minute's grant. False (and nothing changed) when the minute has a holder, a
   *  turn is held or a door is closed. */
  grantBgRelief(lane:string,waitedMs=0):boolean {
    if(!lane||!this.bgReliefFree())return false;
    this.bgRelief.lane=lane;this.bgReliefStats.minutes++;
    this.bgReliefLog.push({minute:this.bgRelief.minute,lane,tickets:0,reserved:0,peak:0,written:0});if(this.bgReliefLog.length>240)this.bgReliefLog.shift();
    this.loud("bgRelief",10*60_000,`background memory work (${lane}) was deferred for ${Math.round(waitedMs/1000)} s (other writers spent each minute's allowance); deferred memory work now runs one job a minute, at most ${BG_RELIEF_MINUTE_BYTES/1024} KiB written a minute, until the gate admits it again`);
    return true;
  }
  /** Bytes the current family may reserve on relief now: 0 unless it holds this minute's grant and no turn is held. The holder may
   *  take all that is left of the grant, whatever its family (review of 6ebaf6f091: a pass capped to one slice had its write
   *  reservation halved to 768 KiB, under the 1 MiB the gate's own rules give one transaction, so a transaction in that band was
   *  refused on every relief turn with the whole grant free). The minute's grant is the one cap. Reads only. */
  private bgReliefRoom():number {
    const relief=this.bgRelief;
    if(relief.minute!==this.admissionMinute||relief.lane===null||relief.lane!==this.bgLaneName()||this.bgReliefHeld())return 0;
    return Math.max(0,BG_RELIEF_MINUTE_BYTES-relief.used);
  }
  /** All that is left of this minute's grant, for the family that holds it (0 for anybody else). Reads only. */
  bgReliefLeft():number {
    this.admissionState();
    const relief=this.bgRelief;
    return this.bgDoorsClosed()||this.bgReliefRoom()<=0?0:Math.max(0,BG_RELIEF_MINUTE_BYTES-relief.used);
  }
  /** What the current family may reserve on relief now (admit with relief), 0 for none. Reads only. */
  bgReliefGrantRoom():number {
    this.admissionState();
    return this.bgDoorsClosed()?0:this.bgReliefRoom();
  }
  /** MAIN ruling 2026-11-24T23:23:46Z IDLE HEADROOM (b): the relief grant is an authorised over-budget. What the relief tickets wrote
   *  since the judge's last minute (a settled ticket: what it wrote; an expired one: what it reserved), at most the grant a minute. */
  private bgReliefJudged=0;
  /** The part of it the judge already leaves out as planned (an owed capture's settled bytes, owedTick): allowed once, not twice. */
  private bgReliefPlanned=0;
  /** The open relief tickets: each is charged to its minute's grant what it reserved, and gives back what it did not write when it
   *  settles (a claim or a lease beat reserves a whole slice and writes a few pages); one that expires is charged whole. */
  private bgReliefTickets=new Map<AdmissionTicket,{bytes:number;minute:number}>();
  /** Tickets the gate admitted by its own rules to a lane that is in the queue: the lane's clock ends when one settles with bytes written. */
  private bgOwnTickets=new Map<AdmissionTicket,string>();
  /** Tests: forget this minute's grant and the record. */
  resetBgRelief():void {this.bgRefusals.clear();this.bgReliefJudged=0;this.bgReliefPlanned=0;this.bgRanAt.clear();this.bgRelief={minute:-1,lane:null,used:0};this.bgReliefTickets.clear();this.bgOwnTickets.clear();this.bgReliefLog.length=0;this.bgReliefStats.grants=0;this.bgReliefStats.bytes=0;this.bgReliefStats.written=0;this.bgReliefStats.minutes=0;}
  private settleBgRelief(ticket:AdmissionTicket,wrote:number):void {
    const own=this.bgOwnTickets.get(ticket);
    if(own!==undefined){
      this.bgOwnTickets.delete(ticket);
      // the job actually ran by the gate's own rules: the dispatcher restarts this family's wait from here
      if(wrote>0&&(this.bgRanAt.has(own)||this.bgRanAt.size<64))this.bgRanAt.set(own,Date.now());
      return;
    }
    const slice=this.bgReliefTickets.get(ticket);if(!slice)return;
    this.bgReliefTickets.delete(ticket);
    const used=Math.min(slice.bytes,Math.max(0,wrote));
    this.bgReliefStats.written+=used;this.bgReliefJudged+=used;if(this.captureTickets.has(ticket))this.bgReliefPlanned+=used;
    for(let i=this.bgReliefLog.length-1;i>=0;i--)if(this.bgReliefLog[i].minute===slice.minute){this.bgReliefLog[i].written+=used;break;}
    if(this.bgRelief.minute===slice.minute)this.bgRelief.used=Math.max(0,this.bgRelief.used-(slice.bytes-used));
  }
  /** One relief ticket of the holding family, reserved from the minute's one grant. */
  private takeBgRelief(bytes:number):{bytes:number;minute:number} {
    const relief=this.bgRelief;
    relief.used+=bytes;
    const row=this.bgReliefLog[this.bgReliefLog.length-1];
    if(row&&row.minute===relief.minute){row.tickets++;row.reserved+=bytes;row.peak=Math.max(row.peak,relief.used);}
    this.bgReliefStats.grants++;this.bgReliefStats.bytes+=bytes;
    return {bytes,minute:relief.minute};
  }
  /** Reserve both the write and the copy it creates. Settlement releases only unused room. */
  /** ownerDeletion (SEAN 1114-MEM-DELETE-IDLE-WINDOW): a foreground copy for an owner's deletion scrub, asked while the controller's
   * window is open, skips ONLY the idle clause and is paced at OWNER_DELETE_IDLE_BYTES_PER_MINUTE instead. BG never qualifies. */
  admit(cls:"BG"|"BOOT_RECOVERY"|"FGCOPY",ceiling:number,debtBytes=0,options?:{ownerDeletion?:boolean;relief?:boolean}):AdmissionTicket|null {
    if(!Number.isSafeInteger(ceiling)||ceiling<0||!Number.isSafeInteger(debtBytes)||debtBytes<0)throw new Error("BG_CEILING_INVALID");
    // B4: background work stops first at the WAL half gate; FGCOPY (a copy returns log space) is never stopped by it
    if(cls!=="FGCOPY"&&this.walHalfGate()){this.lastSectionMissed=false;this.halfGateRefusals++;return null;}
    const a=this.admissionShared;
    // Fail closed on a timeout (null, nothing reserved). While the ledger is poisoned the strict idle rule applies and the owner-deletion exemption does not.
    return this.critical<AdmissionTicket|null>("admit",(reading,stuck)=>{
      const end=(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS;
      const bg=Number(a.slots[2]),debt=Number(a.slots[4]),total=Number(a.slots[3]),reserved=Number(a.slots[5]),writes=Number(a.slots[6]);
      const poisoned=a.poisoned();
      const idle=a.slots[7]!==0n||poisoned;
      const exempt=cls==="FGCOPY"&&idle&&!poisoned&&options?.ownerDeletion===true;
      let relief:{bytes:number;minute:number}|null=null,own:string|null=null;
      if(cls==="BOOT_RECOVERY"&&(poisoned||!this.bootRecoveryPermitted()))return null;
      if(this.reserved.size>=RESERVED_MAX){this.counters.reservedFull++;this.loud("reservedFull",10_000,`admission refused: ${RESERVED_MAX} tickets are open (${this.counters.reservedFull} refusals so far)`);return null;}
      if(cls==="BOOT_RECOVERY"){
        if(stuck||this.counters.debtFull>this.debtFullHandled||reading.at>end-5000||bg+debt+reserved+ceiling+debtBytes>BG_MINUTE_BYTES||total+writes+ceiling>49*1024*1024)return null;
      }else if(cls==="BG"){
        // X2: the stuck predicate was evaluated at the section's entry, before the drain; it refuses background admission only.
        if(stuck||this.counters.debtFull>this.debtFullHandled)return null;
        // idle DO LESS (idleQuiet, the same verdict): no background ticket on an idle minute, the owed capture and relief included (the
        // helper's start and index steps ask here directly); an owner's deletion copy is FGCOPY and keeps its own idle exemption
        if(idle)return null;
        // Only the capture already owed by a message can drain while idle, and never while the ledger is poisoned
        // (the strict idle rule applies then). Active turns keep the same BG ceiling. Idle writes reserve their
        // copy as well, under the existing idle ceiling and closing guard.
        const capture=!poisoned&&this.currentSource()==="memory-capture";
        // MAIN 2026-11-22 idle-capture + idle-owed-capture: an idle owed capture is judged on the minute's unplanned writes (idleUsed: the
        // captures' own settled bytes are planned, by the tick's definition), and copy debt carried from earlier commits does not shrink its ceiling: that copy is judged against the
        // idle allowance when it is made (admission-shared.ts beginCopy). The capture still reserves its own copy (debtBytes) and stays
        // under the BG minute ceiling; every other background source is refused while idle, as before.
        const carried=idle&&capture?0:debt;
        if(reading.at>end-5000)return null;
        // (relief: the caller found the gate's own room too small for its job and asks for what is left of the minute's relief grant)
        if(options?.relief===true||(idle&&(!capture||this.idleUsed()+writes+reserved+ceiling+debtBytes>IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536))||bg+carried+reserved+ceiling+debtBytes>BG_MINUTE_BYTES||total+writes+ceiling>49*1024*1024){
          // bgstarve: the gate's own clauses refuse. Only the family the dispatcher named for this minute is served, from the one grant.
          if(poisoned||ceiling+debtBytes<=0)return null;
          if(ceiling+debtBytes>this.bgReliefRoom()){this.noteBgRefusal();return null;}
          relief=this.takeBgRelief(ceiling+debtBytes);
        // a whole slice admitted by the gate's own rules: settled with bytes written, a job of this family ran (bgLaneRanAt)
        }else if(ceiling+debtBytes>=BG_RELIEF_SLICE_BYTES)own=this.bgLaneName();
      }else if(exempt){
        if(this.ownerIdleBytes()+ceiling>OWNER_DELETE_IDLE_BYTES_PER_MINUTE)return null;
      }else if(idle&&(reading.at>end-5000||this.idleUsed()+writes+ceiling>IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536))return null;
      const ticket:AdmissionTicket=Object.freeze({bytes:ceiling,debtBytes,expiresAt:ioMeterWallTime()+end-reading.at,minute:this.admissionMinute,cls,observed:Number(a.slots[11])});
      this.reserved.set(ticket,{write:ceiling,debt:debtBytes,end});this.sumWrite+=ceiling;if(cls!=="FGCOPY")this.sumBg+=ceiling+debtBytes;
      if(relief)this.bgReliefTickets.set(ticket,relief);else if(own!==null)this.bgOwnTickets.set(ticket,own);
      if(exempt){this.ownerIdle.tickets.set(ticket,ceiling);this.ownerIdle.reserved+=ceiling;}
      if(cls==="BG"&&this.currentSource()==="memory-capture")this.captureTickets.add(ticket);
      if(cls!=="FGCOPY")Atomics.add(a.slots,5,BigInt(ceiling+debtBytes));
      Atomics.add(a.slots,6,BigInt(ceiling));return ticket;
    },null);
  }
  /** 1.0.21 W5 (MEMORY-V2-DESIGN 4.9 W5, R1; owner memv2-D; the helper's call = index-wal.ts, its transport = worker-controller.ts): the one
   * grant outside the minute ledger. An unclean stop can leave a helper index log whose copy is larger than any background ticket (the
   * ledger never admits more than BG_MINUTE_BYTES a minute) and SQLite has no partial checkpoint, so before W5 an undamaged log was set
   * aside and rebuilt from every receipt (far more I/O than its copy). Its one copy is granted here instead, as debt on the background
   * bucket (B4): settling a copy of N bytes puts the bucket N / BACKGROUND_BUCKET_BYTES_PER_MINUTE minutes behind, so every bucket slice
   * waits it out and the average stays at the bucket's rate. Fail closed (null; the helper asks again at its next open check) while the
   * bucket is behind or the main log is at the half gate, while the owner is active (any owner-first reason), on a read-only start, and
   * while another such grant is open. The grant is counted as planned writes of this minute like a foreground copy. */
  admitIndexDebt(ceiling:number,now:number=Date.now()):AdmissionTicket|null {
    if(!Number.isSafeInteger(ceiling)||ceiling<=0)throw new Error("BG_CEILING_INVALID");
    // D-R4 1.5: the ledger reads F back from the ceiling at its own page: only an exact K(F, p) with F_B(p) < F <= F_C is one bounded copy
    // (a stray or forged purpose cannot ask more, Opus r3 L8); the cap K_MAX(p) scales with the page (ASTRA be394275a5 H1).
    const page=indexDebtPage(),frames=framesOfCeiling(ceiling,page);
    if(frames===null||!indexDebtFrames(frames,page))return this.refuseIndexDebt("shape");
    const open=this.indexDebtTicket;
    if(open&&this.reserved.has(open)&&ioMeterWallTime()<=open.expiresAt)return this.refuseIndexDebt("open");
    // an expired or dropped grant nobody settled (a helper that died with it) is charged its whole copy first, never 0 (Opus r3 L7)
    if(open)this.closeIndexDebt(open,1,now);
    const door=isReadOnly()?"readOnly":this.backgroundBucketWait(now)>0?(this.walHalfGate()?"half":"bucket"):ownerFirst.pressure()!==null?"owner":this.indexDebtDiskLow(frames)?"disk":null;
    if(door)return this.refuseIndexDebt(door);
    const a=this.admissionShared;
    // The idle allowance does not apply (an unclean stop is usually followed by a quiet machine, where it would never be granted and the
    // index would stay unusable); the bucket debt bounds the average instead. Every other closed door of admit() does.
    const ticket=this.critical<AdmissionTicket|null>("admitIndexDebt",(reading,stuck)=>{
      const end=(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS;
      if(stuck||a.poisoned()||this.counters.debtFull>this.debtFullHandled||this.reserved.size>=RESERVED_MAX)return this.refuseIndexDebt("ledger");
      if(reading.at>end-5000)return this.refuseIndexDebt("minuteEnd"); // as every other ticket: none in the minute's last 5 s
      const t:AdmissionTicket=Object.freeze({bytes:ceiling,debtBytes:0,expiresAt:ioMeterWallTime()+end-reading.at,minute:this.admissionMinute,cls:"FGCOPY",observed:Number(a.slots[11])});
      this.reserved.set(t,{write:ceiling,debt:0,end});this.sumWrite+=ceiling;
      Atomics.add(a.slots,6,BigInt(ceiling));return t;
    },null);
    if(ticket){this.indexDebtTicket=ticket;this.indexDebtFramesOpen=frames;this.indexDebtGrants++;this.lastIndexDebtDoor=null;}
    return ticket;
  }
  /** W5: the open index-debt grant (at most one), its frames, how many were issued and the refusals by door. */
  private indexDebtTicket:AdmissionTicket|null=null;
  private indexDebtFramesOpen=0;
  indexDebtGrants=0;
  readonly indexDebtRefusals={shape:0,open:0,readOnly:0,bucket:0,half:0,owner:0,disk:0,ledger:0,minuteEnd:0};
  private lastIndexDebtDoor:keyof IoBudget["indexDebtRefusals"]|null=null;
  private refuseIndexDebt(door:keyof IoBudget["indexDebtRefusals"]):null {this.indexDebtRefusals[door]++;this.lastIndexDebtDoor=door;return null;}
  /** W5 (D-R4 1.5, R8): the bucket is charged in SQLite currency, the same on every OS: F x 4,096 for a copy that ran (`used` > 0) or a grant
   * nobody settled, 0 for one that never ran. A partial copy is charged as whole (fail closed: its rest is asked and charged again). */
  private closeIndexDebt(ticket:AdmissionTicket,used:number,now:number=Date.now()):void {
    if(ticket!==this.indexDebtTicket)return;
    const frames=this.indexDebtFramesOpen;this.indexDebtTicket=null;this.indexDebtFramesOpen=0;
    if(Number.isFinite(used)&&used>0){this.chargeBackgroundBucket(frames*INDEX_SQLITE_PAGE,now);this.indexDebtCharged+=frames*INDEX_SQLITE_PAGE;}
  }
  /** W5 diagnostics: bytes charged to the bucket by index-debt copies (SQLite currency). */
  indexDebtCharged=0;
  /** W5 disk door (D-R4 1.5, R10): the W4 low-disk verdict, or free space under the copy's bytes plus the floor. Unknown free space is no
   * verdict (the W4 verdict covers the main log's volume; the index sits beside it). */
  setIndexDebtDisk(read:(()=>{refusing:boolean;free:number|null})|null):void {indexDebtDiskReaders.set(this,read);}
  private indexDebtDiskLow(frames:number):boolean {
    const read=indexDebtDiskReaders.get(this);if(!read)return false;
    try{const d=read();return d.refusing||(d.free!==null&&d.free<frames*INDEX_SQLITE_PAGE+INDEX_DEBT_DISK_FLOOR_BYTES);}catch{return true;}
  }
  /** W5 (R11): when a refused index-debt ask is retried: at the door's own time and never sooner than 1 s (no re-ask loop). */
  indexDebtRetryMs(now:number=Date.now()):number {
    const minute=this.lastIndexDebtDoor==="minuteEnd"||this.lastIndexDebtDoor==="ledger"?this.nextAdmissionMs():0;
    return Math.max(WAL_HALF_RETRY_MS,this.backgroundBucketWait(now),minute);
  }
  settle(ticket:AdmissionTicket,used:number,mark?:BackfillMark,debtUsed?:number,rawUsed=0):void {
    const rec=this.reserved.get(ticket);if(!rec)return;
    // W5: the index-debt copy is charged to the background bucket as debt, by the bytes it measured
    if(ticket===this.indexDebtTicket)this.closeIndexDebt(ticket,used);
    if(!Number.isSafeInteger(used)||used<0||(ticket.cls!=="FGCOPY"&&used>ticket.bytes))throw new Error("BG_CEILING_MISS");
    if(ticket.debtBytes&&used&&!mark)throw new Error("BG_DEBT_MARK_REQUIRED");
    if(debtUsed!==undefined&&(!Number.isSafeInteger(debtUsed)||debtUsed<0||debtUsed>ticket.debtBytes))throw new Error("BG_DEBT_CEILING_MISS");
    const a=this.admissionShared;
    this.settleBgRelief(ticket,used+(ticket.debtBytes?debtUsed??Math.min(used,ticket.debtBytes):0));
    const exemptBytes=this.ownerIdle.tickets.get(ticket);
    if(exemptBytes!==undefined){this.ownerIdleBytes();this.ownerIdle.settled+=used;}
    // idle-owed-capture: the tick's window takes the bytes this owed capture WROTE (rawUsed, what the meter counted and so what the
    // tick's total holds), never more than its charge; the ledger's minute takes the charge (applySettle), which is what slot 3 holds.
    // A ticket that expires unsettled wrote nothing known: the tick excuses nothing for it.
    if(this.captureTickets.has(ticket))this.owedTick+=Math.max(0,Math.min(used,Number(rawUsed)||0));
    // The ticket leaves `reserved` here and can never be lost: it is applied in this call's one critical section, or kept pending.
    this.unreserve(ticket,rec);
    let applied=false;
    try{
      applied=this.critical("settle",()=>{
        const included=Math.min(rawUsed,Math.max(0,Number(a.slots[11])-(ticket.minute===this.admissionMinute?ticket.observed:0)));
        this.applySettle(ticket,rec,used,included,debtUsed,mark,"published");
        return true;
      },false);
    }finally{
      if(!applied){
        // included = 0 when deferred: over by at most rawUsed, never under.
        const bg=ticket.cls!=="FGCOPY";
        const p=this.pendingDelta??={d2:0,d5:0,d6:0,d8:0};
        if(bg){p.d2+=used;p.d5+=rec.write+rec.debt;}
        p.d6+=rec.write;p.d8+=used;
        if(this.captureTickets.delete(ticket))this.pendingCapture+=used;
        if(ticket.debtBytes&&used)this.insertDebt(mark!,debtUsed??Math.min(used,ticket.debtBytes),"pending");
        if(this.pendingSince===null)this.pendingSince=this.lastReadingAt;
      }
    }
  }
  foregroundCopy<T>(ceiling:number,fn:()=>T):T|undefined {
    const ticket=this.admit("FGCOPY",ceiling);if(!ticket)return undefined;
    let used=ceiling,raw=0;
    try{const result=withForegroundCopy(fn);used=result.usedBytes??ceiling;raw=result.rawBytes;return result.result;}
    finally{this.settle(ticket,used,undefined,0,raw);}
  }
  /** Copy debt moves to this minute before release, including a WAL restart; one critical section. */
  backfilled(mark:BackfillMark):void {
    // D4: the debt walk is main-thread state; it runs BEFORE the one CAS.
    const hit:DebtEntry[]=[];
    for(const e of this.copyDebt)if(IoBudget.matches(e,mark))hit.push(e);
    if(hit.length===0)return;
    // Debt not yet in slot 4 whose frames are already copied goes straight to slot 2 at the next drain.
    for(const e of hit)if(e.pending){e.pendingMoved+=e.pending;e.pending=0;}
    const salt=mark.salt,frame=mark.frame,complete=mark.complete;
    const done=this.critical("backfilled",()=>{this.applyBackfill({salt,frame,complete});return true;},false);
    if(!done){
      // Kept, never dropped: applied in the next section (bounded: one mark per salt, at most DEBT_MAX + 1 salts).
      const prev=this.retryMarks.get(salt);
      this.retryMarks.set(salt,{salt,frame:Math.max(frame,prev?.frame??frame),complete:Boolean(complete||prev?.complete)});
      if(this.retryMarks.size>DEBT_MAX+1){const first=this.retryMarks.keys().next().value;if(first!==undefined)this.retryMarks.delete(first);}
    }
  }
  /** Read-only offer bound; owner deletion preserves the shared idle ceiling. */
  copyRoom(ownerDeletion=false):number {
    const a=this.admissionShared;
    // Zero on a lock timeout: no copy is offered.
    return this.critical("copyRoom",()=>{
      if(a.poisoned())return 0;
      if(ownerDeletion&&a.slots[7]!==0n)return Math.max(0,Math.min(11*1024*1024,OWNER_DELETE_IDLE_BYTES_PER_MINUTE-this.ownerIdleBytes()));
      return a.slots[7]!==0n?Math.max(0,IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536-this.idleUsed()-Number(a.slots[6])):11*1024*1024;
    },0);
  }
  /** Idle verdict for the capture drain. A missed ledger lock or a poisoned ledger reads as idle (the strict rule). */
  admissionIdle():boolean {this.readingOrNull("admissionIdle");return this.admissionShared.poisoned()||Atomics.load(this.admissionShared.slots,7)!==0n;}
  /** MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS: THE one decision point. While this minute is judged idle (admissionIdle: the idle
   *  verdict the admission section publishes; a missed lock or a poisoned ledger reads as idle, the strict rule), no background memory
   *  work writes: the write gate refuses every background memory source (capture publish and its relief, deferred-job heartbeats), the
   *  relief grant stays closed, the revocation runner holds its non-closing tidy, and recall view builds, the applier, requested
   *  maintenance and the reclaimer wait. Each resumes on the next active minute under its existing caps. Closing work (an owner's
   *  forget/revoke) never asks. */
  // (a poisoned ledger on a minute the owner made active is not an idle minute: admit's own strict rule refuses background tickets then,
  // as before; only the published idle verdict (slot 7; a missed lock publishes idle there) pauses the work below)
  // int-1022q-w1 H2: a minute the owner made active (a turn, an owner request, a reader's demand: foregroundActivity) is never quiet, even
  // when that activity's ledger reading missed the lock. The miss still publishes the strict idle verdict for admission (slot 7, copies at
  // the idle allowance); it no longer parks the warming and upkeep a waiting turn needs until a later section takes the lock.
  idleQuiet():boolean {return this.admissionIdle()&&!this.foregroundActivity&&(!this.admissionShared.poisoned()||Atomics.load(this.admissionShared.slots,7)!==0n);}
  backgroundRoom():number {
    const s=this.admissionState();
    // (the same terms as admit's BG clause: an idle owed capture is not charged the carried copy debt or the captures' own settled bytes)
    const idleCapture=this.currentSource()==="memory-capture"&&Atomics.load(this.admissionShared.slots,7)!==0n&&!this.admissionShared.poisoned();
    const idleRoom=this.currentSource()==="memory-capture"&&Atomics.load(this.admissionShared.slots,7)!==0n
      ? IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536-s.idleUsed-s.reserved-Number(Atomics.load(this.admissionShared.slots,6)) : Infinity;
    const room=Math.max(0,Math.min(idleRoom,BG_MINUTE_BYTES-s.bg-(idleCapture?0:s.debt)-s.reserved,49*1024*1024-s.total-s.reserved));
    // bgstarve: the family that holds this minute's relief grant is told what is left of it for it (callers park on room <= 0 without
    // asking admit, and the write gate sizes its reservation from this figure). A question only: nothing is recorded here.
    if(this.lastSectionMissed||this.admissionShared.poisoned())return room;
    const idle=Atomics.load(this.admissionShared.slots,7)!==0n;
    // (review of 91f1fb7727: with room for a slice but under BG_WRITE_GATE_FULL_ROOM the write gate's reservation, half the room, is
    // under the 1 MiB it gives one transaction; the holder of the grant is told the grant then, or its transaction in that band is
    // refused on every relief turn. At BG_WRITE_GATE_FULL_ROOM and over the reservation is the largest there is: the room is the answer.)
    if(!this.bgIdleRefused(idle)&&room>=BG_WRITE_GATE_FULL_ROOM)return room;
    const relief=this.bgDoorsClosed()?0:this.bgReliefRoom();
    // (an idle minute, not the owed capture: admit refuses this source whatever the room, so the relief is what it may reserve)
    return this.bgIdleRefused(idle)&&relief>0?relief:Math.max(room,relief);
  }
  /** The refusal of a background write on an idle minute (idle DO LESS): the next minute's look, unless the idle verdict was itself read
   *  across a missed ledger lock (B3: the miss, not the minute, closed the door, so it retries at the short step like every other lock
   *  miss). Read lastSectionMissed before nextAdmissionMs, which takes its own section. */
  idleRefusal():BgDeferred {
    if(this.lastSectionMissed)return new BgDeferred(LOCK_MISS_RETRY_MS,true);
    return new BgDeferred(this.nextAdmissionMs());
  }
  /** A capture write refused only because other holders' live reservations fill the minute retries at a short step; spent bytes wait for the minute. */
  refusalRetry():BgDeferred {
    // B3: a refusal that was a lock miss (the admit's own section) retries at a short step; it is marked reservationWait so every consumer
    // takes the short delay (worker-controller bgRetryDelay). Read before nextAdmissionMs, which takes its own section.
    if(this.lastSectionMissed)return new BgDeferred(LOCK_MISS_RETRY_MS,true);
    // B4: read live, never from a flag an earlier refusal left (a refusal for spent bytes while under the gate waits for the minute)
    if(this.walHalfGate())return new BgDeferred(WAL_HALF_RETRY_MS,true);
    const minute=this.nextAdmissionMs();
    if(this.currentSource()!=="memory-capture")return new BgDeferred(minute);
    return this.reservationOnlyRefusal()?new BgDeferred(Math.min(minute,CAPTURE_RESERVATION_RETRY_MS),true):new BgDeferred(minute);
  }
  /** A live reservation is held and its settle can return room: spent bytes leave room under the minute's BG and total allowances
   * and, on an idle minute, under the idle allowance (a poisoned ledger admits no capture at all while idle). */
  private reservationOnlyRefusal():boolean {
    const idle=this.admissionIdle(),s=this.admissionState();
    const carried=idle&&!this.admissionShared.poisoned()?0:s.debt;
    if(s.reserved<=0||s.bg+carried>=BG_MINUTE_BYTES||s.total>=49*1024*1024)return false;
    return !idle||!this.admissionShared.poisoned()&&s.idleUsed<IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536;
  }
  /** The work loop's wait when no background room is left: a capture-stage claim blocked only by another holder's live reservation retries at a short step (the reservation settles within the minute); spent bytes and every other work wait for the minute. */
  claimRetryMs(capture:boolean):number {
    const minute=this.nextAdmissionMs();
    if(!capture)return minute;
    return this.reservationOnlyRefusal()?Math.min(minute,CAPTURE_RESERVATION_RETRY_MS):minute;
  }
  nextAdmissionMs():number {const r=this.readingOrNull("nextAdmissionMs")??this.admissionRead();return Math.max(1,(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS-r.at);}

  constructor(options: IoBudgetOptions = {}) {
    this.read = options.read ?? readProcess;
    this.admissionRead = options.read ?? (()=>readAdmissionProcess());
    this.admissionShared=checkpointLedger(new SharedArrayBuffer(33*BigInt64Array.BYTES_PER_ELEMENT),0);
    this.log = options.log ?? ((line) => console.warn(line));
    this.notice = options.log ?? ((line) => console.info(line));
    this.onScale = options.onScale ?? (() => {});
    this.bytesPerMinute = options.bytesPerMinute ?? IO_BUDGET_BYTES_PER_MINUTE;
    this.cpuFraction = options.cpuFraction ?? IO_BUDGET_CPU_FRACTION;
    this.cpuMinutes = options.cpuMinutes ?? IO_BUDGET_CPU_MINUTES;
    this.isIdle = options.isIdle ?? (() => false);
    this.onMemoryWork = options.onMemoryWork;
    this.systemOverloaded = options.systemOverloaded ?? (() => systemLoad.reading());
    this.onSample = options.onSample;
    this.netMinute = options.netMinute;
    this.written = options.written;
    this.databaseBuckets = options.databaseBuckets;
    if(options.read){try{this.readingOrNull("admissionReading");}catch{Atomics.store(this.admissionShared.slots,7,1n);}}
    else {
      // Establish the process floor without loading a native extension during module evaluation.
      const baseline=osWriteBlocks(process.resourceUsage())*BLOCK_BYTES;
      Atomics.store(this.admissionShared.slots,9,BigInt(baseline));Atomics.store(this.admissionShared.slots,12,BigInt(baseline));this.admissionMinute=Math.floor(Date.now()/IO_BUDGET_INTERVAL_MS);
      Atomics.store(this.admissionShared.slots,1,BigInt(this.admissionMinute));
    }
  }

  /** Replace the listener told when the scale changes. */
  setOnScale(listener: (scale: number) => void): void { this.onScale = listener; }
  setIsIdle(read: () => boolean): void { this.isIdle = read; this.readingOrNull(); }
  /** idle DO LESS: subscribe to the idle -> active edge of the published verdict (see onActiveListeners). Returns the unsubscribe. */
  onActiveMinute(listener: () => void): () => void { this.onActiveListeners.add(listener); return () => { this.onActiveListeners.delete(listener); }; }
  setOnMemoryWork(listener: () => void): void { this.onMemoryWork = listener; }
  setOnSample(listener: ((sample: IoSample) => void) | undefined): void { this.onSample = listener; }
  /** A reader of the bytes a writer with its own budget wrote in the last minute (null: none), and the most it is believed for (its budget
   *  plus a margin): the exemption is for a writer that keeps to its plan, never a blank cheque. */
  /** B4: the background bucket's finish time (a leaky bucket: one oversized slice is debt, constant state) and its bytes since the last minute. */
  private bucketAt = 0;
  private bucketBytes = 0;
  /** B4: 0 when a background slice may run now; else how long to wait. The WAL half gate stops it first (an unreadable log reads as past it). */
  backgroundBucketWait(now: number = Date.now()): number {
    const wait = Math.max(0, this.bucketAt - now);
    return this.walHalfGate() ? Math.max(wait, WAL_HALF_RETRY_MS) : wait;
  }
  /** B4: charge a finished background slice its own bytes (rows x W or its own frames, as the caller measures). */
  chargeBackgroundBucket(bytes: number, now: number = Date.now()): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bucketAt = Math.max(this.bucketAt, now) + bytes / BACKGROUND_BUCKET_BYTES_PER_MINUTE * IO_BUDGET_INTERVAL_MS;
    this.bucketBytes += bytes;
  }
  setPlannedBytes(read: (() => number) | null, capBytesPerMinute = Number.POSITIVE_INFINITY): void { this.plannedBytes = read; this.plannedCap = capBytesPerMinute > 0 ? capBytesPerMinute : Number.POSITIVE_INFINITY; }
  notifyMemoryWork(): void { try { this.onMemoryWork?.(); } catch { /* notifications do not change a write's result */ } }

  /** recalldesign-1020-n1 section 4 (owner: the recallcap racer): owner write requests in flight and when the last one ended. The recall reclaimer
   *  starts no slice while one is open or for RECALL_RECLAIM_YIELD_MS after it closes. The engine's own /api/internal calls are not owner sends, and a
   *  request still open after RECALL_RECLAIM_OPEN_HOLD_MS is waiting on something else (a reply, a card), never on its write transaction. */
  private ownerWrites = new Map<symbol, number>();
  private ownerWriteEndedAt = 0;
  beginOwnerWrite(method: string | undefined, rawUrl: string | undefined): (() => void) | null {
    if (!countsAsOwnerAction(method, rawUrl) || (rawUrl ?? "").startsWith("/api/internal/")) return null;
    const token = Symbol("owner-write");
    this.ownerWrites.set(token, Date.now());
    return () => { if (!this.ownerWrites.delete(token)) return; this.ownerWriteEndedAt = Date.now(); };
  }
  /** Milliseconds since the last owner write request closed; 0 while one opened in the last RECALL_RECLAIM_OPEN_HOLD_MS is still open. */
  ownerWriteQuietMs(now = Date.now()): number {
    for (const started of this.ownerWrites.values()) if (now - started < RECALL_RECLAIM_OPEN_HOLD_MS) return 0;
    return now - this.ownerWriteEndedAt;
  }

  /** True while any owner write request is open (recallcap-1020-n4a: a paced build slice measured then also counts the turn's writes). */
  ownerWriteOpen(): boolean { return this.ownerWrites.size > 0; }

  /** Fable BLOCK bb30fb1d03 (owner: the recallcap racer): the reclaimer, held at the log gate, asks for one log copy under its own bucket
   *  (admission-shared rule 5); its slices charge that same bucket. */
  requestReclaimCopy(now = Date.now()): void { this.admissionShared.requestReclaimCopy(now); }
  chargeReclaimBucket(bytes: number, now = Date.now()): void { this.admissionShared.chargeReclaim(bytes, now); }
  noteBytes(source: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytes.set(source, (this.bytes.get(source) ?? 0) + bytes);
    if (isPlannedSource(source)) this.plannedPending.set(source, (this.plannedPending.get(source) ?? 0) + bytes);
    if (this.timer && PERIODIC_SOURCES.has(source)) {
      this.backgroundDebtAt = Math.max(Date.now(), this.backgroundDebtAt)
        + bytes / IO_BUDGET_BACKGROUND_BYTES_PER_MINUTE * IO_BUDGET_INTERVAL_MS;
    }
  }

  /** A turn's start and completion both mark the sampled interval, even if the engine is already idle at the minute tick. */
  noteForegroundActivity(): void { this.foregroundActivity = true; this.readingOrNull(); }

  /** MAIN-RULING 2026-11-25T12:40:11Z: a reader that finds its recall view not ready (recall-view.ts demandRecallContext) is
   *  a turn or an owner action in the making, before any turn.started: the minute is active from here, so nothing that reader needs
   *  rests on idleQuiet. Only the first demand of a minute takes the reading (the published verdict turns active there and the
   *  idle -> active listeners run); the rest cost one flag read. */
  noteRecallDemand(): void { if (!this.foregroundActivity) this.noteForegroundActivity(); }
  /** Use the same owner-action classification as the idle clock; presence beats do not buy an active minute. */
  noteOwnerRequest(method: string | undefined, rawUrl: string | undefined): void {
    if (countsAsOwnerAction(method, rawUrl)) this.noteForegroundActivity();
  }

  /** What a seed source has used of its per-process total (IO_SEED_BUDGETS; tests and diagnostics). */
  seedSpentBytes(source: string): number { return this.seedSpent.get(source) ?? 0; }
  /** Bytes charged to `source` in the current minute so far (tests and diagnostics; the tick reads and clears them). */
  pendingBytes(source: string): number { return this.bytes.get(source) ?? 0; }

  /** Readers return cumulative bytes. Register once before the source starts. */
  registerByteSource(name: string, read: () => number, options:{child?:boolean}={}): () => void {
    let last = 0;
    try { last = read(); } catch { /* an absent child starts at zero */ }
    const source = { read, last, child:options.child===true };
    this.byteSources.set(name, source);
    // Release what the reader holds (walFrameReader's shm descriptor) when its owner lets go,
    // even if a later registration under the same name replaced this entry in the map.
    return () => {
      if (this.byteSources.get(name) === source) this.byteSources.delete(name);
      try { (read as { close?: () => void }).close?.(); } catch { /* releasing is best effort */ }
    };
  }

  /** q1023-recallpace: a registered source's cumulative bytes now, read without charging or sampling anything (the view-build pace
   *  measures one database's own log frames around a slice, recall-view.ts viewWritten). null when no such source is registered. */
  byteSourceTotal(name: string): number | null {
    const source = this.byteSources.get(name);
    if (!source) return null;
    try { const current = source.read(); return Number.isFinite(current) && current >= 0 ? current : null; } catch { return null; }
  }

  /** Observe a writer at a transaction boundary, or leave it to the minute tick. */
  sampleByteSource(name: string, attribution = name): void {
    const source = this.byteSources.get(name);
    if (!source) return;
    try {
      const current = source.read();
      if (!Number.isFinite(current) || current < 0) return;
      const delta=Math.max(0,current-source.last);
      if(source.child)this.childBytes+=delta;
      this.noteBytes(attribution, delta);
      source.last = current;
    } catch { /* a child or file may disappear between samples */ }
  }

  /** Pending application bytes in this window, including newly observed files. */
  sampleBytes(): number {
    for (const name of this.byteSources.keys()) this.sampleByteSource(name);
    if (this.written) { try { for (const [name, bytes] of this.written()) this.noteBytes(name, bytes); } catch { /* a reader never throws into the tick */ } }
    return [...this.bytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  }

  /** A source for the synchronous part of a call only (withSyncSource); an inner withSource takes over while it runs. */
  private syncSource: string | undefined;
  private syncDeadline: number | undefined;
  withSource<T>(source: string, operation: () => T): T {
    const outer = this.syncSource;
    this.syncSource = undefined;
    try {
      const context:{source:string;deferred?:BgDeferred}={source};
      const result=this.sourceContext.run(context,operation);
      if(result&&typeof (result as {then?:unknown}).then==="function"){
        return Promise.resolve(result).then(value=>{if(context.deferred)throw context.deferred;return value;},error=>{throw context.deferred??error;}) as T;
      }
      return result;
    } finally { this.syncSource = outer; }
  }
  /** 1.0.22 deep1022 (field: "revocation job: BG_DEFERRED; trying again" for 27 hours): runs `operation`, and every timer, microtask and
   *  promise it starts, under NO source. A job with a pace ledger of its own (the revocation runner, revoke-budget.ts) is woken by whatever
   *  writer committed its work, and Node hands that writer's store on to the wake's microtask and timer: woken by a background slice it ran
   *  as that slice for good, met the background byte gate (beforeWrite) and, once the slice was refused a write, its sticky `deferred`. */
  withoutSource<T>(operation: () => T): T {
    const outer = this.syncSource, outerDeadline = this.syncDeadline;
    this.syncSource = undefined; this.syncDeadline = undefined;
    try { return this.sourceContext.exit(operation); } finally { this.syncSource = outer; this.syncDeadline = outerDeadline; }
  }
  /** Names the SYNCHRONOUS part of `operation` only: the timers and promises it starts do not inherit the source (an after-listen step
   *  starts long-lived loops, whose later slices must keep their own source, or none). */
  withSyncSource<T>(source: string, operation: () => T, deadlineAt?: number): T {
    const outer = this.syncSource;
    const outerDeadline = this.syncDeadline;
    this.syncSource = source;
    this.syncDeadline = Math.min(outerDeadline ?? Infinity, deadlineAt ?? Infinity);
    try { return operation(); } finally { this.syncSource = outer; this.syncDeadline = outerDeadline; }
  }
  currentSliceDeadline(): number { return this.syncDeadline ?? Infinity; }
  currentSource(): string | undefined { return this.syncSource ?? this.sourceContext.getStore()?.source; }
  deferCurrentSlice():void {const context=this.sourceContext.getStore();if(context)context.deferred=new BgDeferred(this.nextAdmissionMs());}
  assertCurrentSlice():void {const deferred=this.sourceContext.getStore()?.deferred;if(deferred)throw deferred;}

  shouldDefer(source: string): boolean {
    return this.deferredForMs(source) > 0;
  }

  /** Milliseconds until `source`'s deferral window ends (0 when it is not deferred). */
  deferredForMs(source: string, options?: { requested?: boolean }): number {
    // A live turn can be waiting on a phone job or call. Its delivery/retries
    // remain foreground work even when unrelated periodic writers owe debt.
    if (source === "push-delivery") {
      try { if (!this.isIdle()) return 0; } catch { return 0; }
    }
    // Work owed to a new request keeps its source's own measured backoff,
    // but does not wait for unrelated periodic writers to repay their debt.
    const shared = !options?.requested && this.timer && PERIODIC_SOURCES.has(source)
      // Repay the measured slice before another starts. Borrowing a whole
      // minute admitted two minutes' WAL plus checkpoint copies into one.
      ? Math.max(0, this.backgroundDebtAt - Date.now()) : 0;
    if (source !== this.deferredSource || this.scale === 1) return shared;
    try { return Math.max(shared, this.deferUntil - this.read().at); } catch { return shared; }
  }

  /** 1 normally; doubles each time the budget is blown, up to 8. Pollers multiply their interval by this. */
  pollScale(): number { return this.scale; }

  /** Record one statement's cost. Cheap: a Map update. Keyed by the first 160
   *  characters of the text; pass `keyed` when the text already is that key. */
  note(sql: string, ms: number, keyed = false): void {
    const key = keyed ? sql : statementKey(sql);
    const cost = this.statements.get(key);
    if (cost) { cost.calls++; cost.ms += ms; }
    else {
      if (this.statements.size >= 500) this.statements.clear();
      this.statements.set(key, { sql: key, calls: 1, ms });
    }
    if (keyed && ms > SLOW_SQL_MS) reportSlowSql(shortStatement(key), ms, this.currentSource() ?? statementSource(key) ?? (key.startsWith(EXEC_PREFIX) ? execSource(key.slice(EXEC_PREFIX.length)) : undefined) ?? unclaimedStatementSource());
  }

  topStatements(count = 3): StatementCost[] {
    return [...this.statements.values()].sort((a, b) => b.ms - a.ms).slice(0, count);
  }

  /** The statements that cost the most since the last call, as trace lines (MURAGE_TURN_TRACE=1
   *  only). Text is the statement shortened with its literals stripped; never a bound value. */
  traceTopStatements(sink: (line: string) => void = line => console.log(line), count = 5): void {
    if (!turnTraceEnabled()) return;
    const window: StatementCost[] = [];
    for (const cost of this.statements.values()) {
      const before = this.traced.get(cost.sql);
      const ms = Math.max(0, cost.ms - (before?.ms ?? 0)), calls = Math.max(0, cost.calls - (before?.calls ?? 0));
      if (calls > 0) window.push({ sql: cost.sql, calls, ms });
    }
    this.traced = new Map([...this.statements.values()].map(cost => [cost.sql, { calls: cost.calls, ms: cost.ms }]));
    window.sort((a, b) => b.ms - a.ms).slice(0, count).forEach((cost, index) =>
      sink(`[turn-trace] phase=sql.top rank=${index + 1} ms=${Math.round(cost.ms)} calls=${cost.calls} sql="${shortStatement(cost.sql)}"`));
  }

  /** Take one sample and judge the minute since the last. Returns the verdict for tests. */
  tick(): { writeBytesPerMinute: number; cpu: number; tripped: boolean; source: string | null } | null {
    let reading: IoReading;
    try { reading = this.read(); } catch { return null; }
    const previous = this.last;
    this.last = reading;
    const attributedBytes = this.sampleBytes();
    const childBytes=this.childBytes;
    const meterBytes=reading.meterBytes!==undefined&&previous?.meterBytes!==undefined?Math.max(0,reading.meterBytes-previous.meterBytes):0;
    const applicationBytes=Math.max(meterBytes,Math.max(0,attributedBytes-childBytes))+childBytes;
    let net: NetMinute | null = null;
    try { net = this.netMinute?.() ?? null; } catch { /* traffic counts are diagnostics */ }
    // q1022-ordfiles: the database files the meter saw move this minute (names only; the first reading takes the baseline)
    const takeDatabaseMoved = (): Array<[string, number]> => { try { return [...(this.databaseBuckets?.() ?? [])].filter(([, bytes]) => Number.isFinite(bytes) && bytes > 0).sort((a, b) => b[1] - a[1]); } catch { return []; } };
    if (!previous) { this.bgReliefJudged=0; this.bgReliefPlanned=0; this.bytes.clear(); takeDatabaseMoved(); this.childBytes=0; this.owedTick=0; this.bucketBytes = 0; this.foregroundActivity = false; return null; }
    if (reading.at <= previous.at) return null;
    const databaseMoved = takeDatabaseMoved();
    const minutes = (reading.at - previous.at) / 60_000;
    // fail closed (IO-IDLE r3.6): a minute either end of which could not read the OS count is UNKNOWN, not 0: it is never calm (the poll
    // rate stays at least halved and never steps back), its sample is never valid evidence, and it says so once an hour
    const osUnavailable = reading.osKnown === false || previous.osKnown === false;
    const osUnknown = osUnavailable || reading.coverageKnown===false || previous.coverageKnown===false || reading.sentinelGeneration!==previous.sentinelGeneration;
    // B7 (sweep-1021): name the cause that made the minute unknown; only the first of these is the diskWritten reader.
    const unknownWhy = osUnavailable ? "the engine-exclusion helper's diskWritten could not be read"
      : reading.coverageKnown===false || previous.coverageKnown===false ? "the write meter does not cover every writer yet"
      : "the write meter restarted, so this minute does not compare with the last";
    const osBytes = osUnavailable ? 0 : Math.max(0, (reading.fsWriteBlocks - previous.fsWriteBlocks) * BLOCK_BYTES);
    // ONE definition of planned (plannedWrites), shared with idle admission (publishPlanned): the reader's budgeted bytes, the recall
    // reclaimer's bucket, the named seed budgets and the owed captures' settled bytes up to the BG minute ceiling (idle-owed-capture).
    // The tick commits the seed use and says so on its own line.
    const share = plannedWrites(minutes, name => this.bytes.get(name) ?? 0, this.owedTick, this.plannedBytes, this.plannedCap, name => this.seedSpent.get(name) ?? 0);
    let planned = share.planned;
    // B4: the background bucket's bytes are planned (at most its rate for the interval; beyond that it hides nothing)
    planned += Math.min(BACKGROUND_BUCKET_BYTES_PER_MINUTE * minutes, this.bucketBytes);
    const seeds: string[] = [], seedAllowed = new Map<string, number>();
    for (const { name, seed, wrote, allowed, spent } of share.seeds) {
      this.seedSpent.set(name, spent + allowed);
      seedAllowed.set(name, allowed);
      seeds.push(`${name} wrote ${(wrote / 1048576).toFixed(1)} MB (${seed.what}): ${(allowed / 1048576).toFixed(1)} MB under its one-time seed budget, ${((seed.total - spent - allowed) / 1048576).toFixed(1)} of ${(seed.total / 1048576).toFixed(0)} MB left`);
    }
    const totalWriteBytes=Math.max(osBytes,meterBytes,Math.max(0,attributedBytes-childBytes))+childBytes;
    const writeBytesPerMinute = Math.max(0, totalWriteBytes - planned) / minutes;
    const cpu = (reading.cpuMicros - previous.cpuMicros) / 1000 / (reading.at - previous.at);
    let system: { overloaded: boolean; why: string } | null = null;
    try { system = this.systemOverloaded(); } catch { /* unknown load: Murage's own CPU decides */ }
    const systemHot = system?.overloaded === true;
    this.hotCpuMinutes = cpu > this.cpuFraction || systemHot ? this.hotCpuMinutes + 1 : 0;
    let idle = false;
    try { idle = this.isIdle() && !this.foregroundActivity; } catch { /* startup uses the active budget */ }
    this.foregroundActivity = false;
    this.armAdmission(); // B2: a stale ACTIVE verdict is refreshed (and the refresh disarms once idle is published)
    const budget = idle ? IO_BUDGET_IDLE_BYTES_PER_MINUTE : this.bytesPerMinute;
    // MAIN ruling 2026-11-24T23:23:46Z IDLE HEADROOM (b): the one relief door's grant (at most BG_RELIEF_MINUTE_BYTES a minute) is an
    // authorised over-budget. The granted bytes x1.2 (the measured OS amplification) are added to THIS minute's judged allowance, and
    // a minute they alone carried over the budget says so on one "relief grant" line instead of an over-budget line; bytes beyond
    // grant x1.2 are over budget as before.
    const reliefGrant = Math.min(this.bgReliefJudged, BG_RELIEF_MINUTE_BYTES * Math.max(1, Math.ceil(minutes)));
    // (relief bytes of an owed capture are planned already: the allowance adds only what is not left out above)
    const reliefAllowance = Math.max(0, Math.ceil(reliefGrant * BG_RELIEF_JUDGE_FACTOR) - Math.min(reliefGrant, this.bgReliefPlanned)) / minutes;
    this.bgReliefJudged = 0; this.bgReliefPlanned = 0;
    const writing = writeBytesPerMinute > budget + reliefAllowance;
    if (!writing && writeBytesPerMinute > budget) {
      try { this.log(`[io-budget] relief grant: deferred memory work wrote ${(reliefGrant / 1048576).toFixed(1)} MB through the relief door; ${(reliefAllowance / 1048576).toFixed(1)} MB/min (grant x${BG_RELIEF_JUDGE_FACTOR}) added to this minute's allowance; wrote ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min against the budget of ${(budget / 1048576).toFixed(0)}: not over budget`); } catch { /* a line never changes the minute */ }
    }
    const spinning = this.hotCpuMinutes >= this.cpuMinutes;
    const tripped = writing || spinning;
    const traffic = net ? netText(net, reading.at - previous.at) : "";
    if (tripped) {
      this.calmMinutes = 0;
      const next = Math.min(IO_BUDGET_MAX_SCALE, this.scale * 2);
      // the minute is blamed on what was judged: a seed source's excused bytes are not what tripped it (its bytes past the budget still are)
      // (the reclaimer's own bucket is planned too: its bytes never tripped the minute)
      const judged = (entry: [string, number]) => entry[0] === RECALL_RECLAIM_SOURCE ? Math.max(0, entry[1] - RECALL_RECLAIM_BYTES_PER_MINUTE * minutes) : entry[1] - (seedAllowed.get(entry[0]) ?? 0);
      this.deferredSource = [...this.bytes].sort((a,b) => judged(b)-judged(a))[0]?.[0] ?? this.topStatements(1)[0]?.sql ?? "process";
      // q1022-ordfiles: the minute is judged on the largest of the OS count, the meter and the named sources, but its line named the largest
      // NAMED source only. A minute whose bytes nobody named (a database write no source's transaction took: a WAL copy, a worker thread's
      // own connection; or an OS count above the meter) was blamed on whatever small writer it also saw: on an idle minute the health log's
      // ~1 KB append (source: ordinary-files). When the bytes no source took outweigh every named byte, the LINE says so, with the database
      // file the meter saw. The deferral key stays the top named source (a real writer keeps its deferral; nothing is deferred as "unnamed").
      const unnamed = Math.max(0, totalWriteBytes - attributedBytes);
      const fileName = (bucket: string) => `database:${bucket.slice("database:".length).split(/[\\/]/).pop()}`;
      const blamed = this.bytes.size > 0 && unnamed > attributedBytes ? `unnamed${databaseMoved[0] ? ` (meter: ${fileName(databaseMoved[0][0])})` : ""}` : this.deferredSource;
      this.deferUntil = reading.at + next * IO_BUDGET_INTERVAL_MS;
      const category = writing ? (spinning ? "both" : "writing") : "cpu";
      const lastLog = this.diagnosticLogs.get(category);
      if (!lastLog || reading.at - lastLog.at >= IO_BUDGET_INTERVAL_MS) {
        const topText = this.topStatements().map(cost => `${Math.round(cost.ms)}ms x${cost.calls} ${cost.sql}`).join(" | ") || "none recorded";
        const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
        // The split comes first (a copied log line is often cut short): what the OS counted, what the meter counted, what sources named.
        const named = [...this.bytes].filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, bytes]) => `${name.startsWith("database:") ? fileName(name) : name} ${mb(bytes)}`).join(", ");
        const split = `os ${osUnavailable ? "unknown" : mb(osBytes)} MB, meter ${mb(meterBytes)} MB, named ${mb(attributedBytes)} MB${named && ` (${named})`}, unnamed ${mb(Math.max(0, totalWriteBytes - attributedBytes))} MB${databaseMoved.length ? ` (meter by file: ${databaseMoved.slice(0, 2).map(([name, bytes]) => `${fileName(name)} ${mb(bytes)}`).join(", ")})` : ""}`;
        const line = `[io-budget] ${writing ? `writing ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min (budget ${(budget / 1048576).toFixed(0)}${planned > 0 ? `, ${(planned / minutes / 1048576).toFixed(1)} MB/min planned not counted` : ""})` : ""}`
          + `${writing && spinning ? ", " : ""}${spinning ? `cpu ${(cpu * 100).toFixed(0)}%${systemHot ? ` (computer: ${system!.why})` : ""} for ${this.hotCpuMinutes} min` : ""}; source: ${blamed}; bytes: ${split}; top statements: ${topText}; poll rate x1/${next}${traffic && `; ${traffic}`}`;
        // Bound diagnostics too: custom source names and load descriptions need not be short.
        this.log(`${line.length > 4096 ? `${line.slice(0, 4096)}…` : line}; osBytes=${Math.round(osBytes)}; applicationBytes=${Math.round(applicationBytes)}; suppressed=${lastLog?.suppressed ?? 0}`);
        this.diagnosticLogs.set(category, { at: reading.at, suppressed: 0 });
      } else {
        lastLog.suppressed++;
      }
      this.setScale(next);
      this.statements.clear(); this.traced.clear();
      if (spinning) this.hotCpuMinutes = 0;
    } else if (osUnknown) {
      this.calmMinutes = 0;
      if (this.scale < 2) this.setScale(2);
      const lastLog = this.diagnosticLogs.get("unknown");
      if (!lastLog || reading.at - lastLog.at >= 60 * 60_000) {
        // osUnavailable: the OS count itself could not be read (macOS without the addon's diskWritten). Otherwise the count was read and
        // what is unknown is COVERAGE (io-meter.ts ioMeterCoverageKnown, or a new sentinel generation): the line names the real cause
        // (B7 sweep-1021: unknownWhy, a meter that does not cover every writer or one that restarted).
        const why = osUnavailable ? `os writes unknown (${unknownWhy})` : `write coverage unknown (${unknownWhy}; the os write count was read)`;
        try { this.log(`[io-budget] ${why}: background work runs at half rate; applicationBytes=${Math.round(applicationBytes)}; suppressed=${lastLog?.suppressed ?? 0}`); } catch { /* a line never changes the minute */ }
        this.diagnosticLogs.set("unknown", { at: reading.at, suppressed: 0 });
      } else lastLog.suppressed++;
    } else if (this.scale > 1 && ++this.calmMinutes >= IO_BUDGET_CALM_MINUTES) {
      this.calmMinutes = 0;
      this.setScale(Math.max(1, this.scale / 2));
      if (this.scale === 1) this.deferredSource = null;
    }
    // Every minute that used a seed budget says so, tripped or not (never hidden; at most one line a minute, the tick's own pace).
    if (seeds.length) {
      try { this.log(`[io-budget] seed: ${seeds.join("; ")}; judged ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min against the budget of ${(budget / 1048576).toFixed(0)} without them`); } catch { /* a line never changes the minute */ }
    }
    // A storm on the port that neither watchdog trips on still says what it was. Diagnostic only: it changes no scale and defers nothing.
    if (!tripped && net && net.outBytes > NET_LINE_BYTES_PER_MINUTE * minutes) {
      const lastLog = this.diagnosticLogs.get("traffic");
      if (!lastLog || reading.at - lastLog.at >= IO_BUDGET_INTERVAL_MS) {
        try { this.log(`[io-budget] traffic; ${traffic}; suppressed=${lastLog?.suppressed ?? 0}`); } catch { /* a line never changes the minute */ }
        this.diagnosticLogs.set("traffic", { at: reading.at, suppressed: 0 });
      } else lastLog.suppressed++;
    }
    if (this.onSample) {
      const intervalMs = reading.at - previous.at;
      let top: string | undefined, topBytes = -1;
      for (const [name, bytes] of this.bytes) if (bytes > topBytes) { top = name; topBytes = bytes; }
      const sample: IoSample = {
        idle, intervalMs, osBytes, applicationBytes, plannedBytesAllowed: Math.round(planned),
        chargedBytes: Math.round(Math.max(0, totalWriteBytes - planned)), budgetBytes: budget,
        cpuFraction: Math.min(1, Math.max(0, Number.isFinite(cpu) ? cpu : 0)), pollScale: this.scale, sourceClass: ioSourceClass(top),
        // A minute far longer than the timer's is a suspend or a clock jump; the sample is reported but never valid.
        discontinuity: intervalMs > HEALTH_LIMITS.ioSampleMaxMs || osUnknown,
      };
      try { this.onSample(sample); } catch { /* telemetry never changes the watchdog */ }
    }
    this.bytes.clear();this.childBytes=0;this.owedTick=0;this.bucketBytes=0;
    return { writeBytesPerMinute, cpu, tripped, source: this.deferredSource };
  }

  private setScale(next: number): void {
    if (next === this.scale) return;
    this.scale = next;
    try { this.onScale(next); } catch { /* backing off is advisory */ }
  }

  start(): void {
    if (this.timer) return;
    this.backgroundDebtAt = 0;
    this.foregroundActivity = false;
    this.last = null;
    this.tick();
    this.timer = setInterval(() => { try { this.tick(); } catch { /* a watchdog never throws into the app */ } }, IO_BUDGET_INTERVAL_MS);
    this.timer.unref?.();
    this.armAdmission(); // B2: armed only while needed (admissionNeeded), never as a standing timer
    if (turnTraceEnabled() && !this.traceTimer) {
      this.traceTimer = setInterval(() => { try { this.traceTopStatements(); } catch { /* tracing never throws into the app */ } }, IO_BUDGET_INTERVAL_MS);
      this.traceTimer.unref?.();
    }
  }

  stop(): void {
    if(this.admissionTimer)clearTimeout(this.admissionTimer);this.admissionTimer=null;this.missStreak=0;this.missSince=null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.backgroundDebtAt = 0;
    if (this.traceTimer) clearInterval(this.traceTimer);
    this.traceTimer = null;
  }
}

/** The text a statement is filed under. Done once per prepare, not per run:
 *  the Inbox projection is ten kilobytes of SQL. */
export function statementKey(sql: string): string { return sql.replace(/\s+/g, " ").trim().slice(0, 160); }

/** The lineage checks (memory/replay-lineage.ts) run for whichever caller asks, under no source of their own.
 *  Their statements are known by the tables only they read, so a slow one is reported as `lineage`. */
const LINEAGE_SQL = /\b(?:memory_disclosure_outputs|memory_output_roots|memory_session_roots|memory_root_set\w*|lineage_(?:dirty|epoch|structure))\b|^WITH (?:RECURSIVE )?direct\(b\)/i;
/** The source a statement with no source of its own is reported under, when its text says. */
export function statementSource(key: string): string | undefined { return LINEAGE_SQL.test(key) ? "lineage" : undefined; }

/** The source a request's statements are filed under: `route:<METHOD> <path>`, with id-like segments (long, or holding a digit) as `:id`, cut at 80 characters. */
export function routeSource(method: string | undefined, url: string | undefined): string {
  const path = (url ?? "/").split(/[?#]/)[0].split("/").map(part => (part.length > 24 || /\d/.test(part) ? ":id" : part)).join("/");
  return `route:${method ?? "GET"} ${path}`.slice(0, 80);
}
/** The label of a db.exec: its first words, with literals gone, so a long DDL, checkpoint or backfill names itself in the stall log. */
const EXEC_PREFIX = "exec: ";
export function execSource(sql: string): string { return `exec:${shortStatement(sql).slice(0, 40)}`; }

/** A statement for a trace line: literals (quoted text, numbers) replaced by ?, cut at 80 characters. */
export function shortStatement(sql: string): string {
  return statementKey(sql).replace(/[xX]'(?:[^']|'')*'|'(?:[^']|'')*'|\b\d+(?:\.\d+)?\b/g, "?").slice(0, 80);
}

/** The process-wide watchdog. index.ts starts it; database.ts feeds it. */
/** The closed source class a byte source name falls in (1.0.9 Sentinel): the file name of an instrumented database, the
 *  memory helper, or `other`. Never the name or path itself. */
export function ioSourceClass(source: string | undefined): IoSourceClass {
  if (!source) return "other";
  if (source === "memory-worker") return "memory";
  const file = source.startsWith("database:") ? source.slice("database:".length).split(/[\\/]/).pop() ?? "" : "";
  switch (file) {
    case "messages.db": return "messages-db";
    case "memory-index.db": return "memory-index-db";
    case "skill-index.db": return "skill-index-db";
    case "connected-app-ledger.db": return "connected-app-ledger-db";
    default: return "other";
  }
}

export const ioBudget = new IoBudget({ onSample: sample => recordFact({ kind: "io-minute", ...sample }), netMinute: () => netMeter.take(), written: takeWrittenBytes, databaseBuckets: takeDatabaseBuckets });
// Disjoint from the memory helper, which retains its existing source.
ioBudget.registerByteSource("owned-node-children",ownedChildIoBytes,{child:true});
ioBudget.registerByteSource("sentinel-file-receipts",sentinelExternalIoBytes,{child:true});

// The lock wait each handle runs with now (database.ts setBusy keeps it). A statement that waited on the write lock with no budget below the
// handle's default is the bug the stall work hunts (database.ts invariant 4): it is named, with its caller, by `[sqlite] busy ... budget=none`.
const busyNow = new WeakMap<object, number>();
export function noteBusyTimeout(db: object, ms: number): void { busyNow.set(db, ms); }
/** The lock wait (ms) the handle has now; undefined for a handle database.ts never set. */
export function currentBusy(db: object): number | undefined { return busyNow.get(db); }
interface BusyWitness { defaultMs: number; /** the background wait (BACKGROUND_BUSY_MS) */ holdMs: number; held: () => boolean; /** the ambient source is a background one (db-busy.ts BACKGROUND_SOURCES) */ background: () => boolean; transactionEnded: (db: object) => void }
let busyWitness: BusyWitness | null = null;
/** database.ts registers what the witness needs from it (the default wait, whether a writer hold is in force, the end-of-transaction hook). */
export function setBusyWitness(witness: BusyWitness): void { busyWitness = witness; }
const BEGIN_WRITE = /^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
// A deferred BEGIN changes no rows; writes within it and every undo still invalidate row memos.
const DEFERRED_BEGIN = /^\s*BEGIN(?:\s+DEFERRED)?(?:\s+TRANSACTION)?\s*;?\s*$/i;
const END_TRANSACTION = /^\s*(?:COMMIT|END|ROLLBACK)\b(?!\s+TO\b)/i;
const isBusyFailure = (error: unknown): boolean => {
  const e = error as { errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.errcode === "number" && (e.errcode & 0xff) === 5) return true;
  return typeof e.message === "string" && /database is locked|SQLITE_BUSY/i.test(e.message);
};
/** The database layer's own frames, by FUNCTION name: the packaged server is one bundled index.js, where no frame carries database.ts or
 *  io-budget.ts as its file, so the file test below matches nothing there. A bundler that renames a function on a name clash appends digits
 *  (transaction2), which the match allows. The instrumented exec and statement methods are named functions for this reason. */
export const LAYER_FUNCTIONS: ReadonlySet<string> = new Set([
  "waitCaller", "witnessWait", "traceWrite", "instrumentedExec", "instrumentedStatement", "lowerForHold", "restoreAfterHold",
  "transaction", "withBusyBudget", "backgroundWrite", "beginBackground", "beginForSource", "setBusy", "unclaimedStatementSource",
]);
/** The label of a slow statement no source claims, so no slow line or stall holder is ever `unattributed` (rc13 real-data run: a 1032 ms and a
 *  714 ms holder with no name): the named step running (observe.ts heldStep), else `caller:` and the first frames outside the database layer
 *  (`function@index.js:line` in the bundle). A stack is read only for a statement over SLOW_SQL_MS. */
function unclaimedStatementSource(): string {
  const task = activeTaskName();
  if (task) return `step:${task}`;
  const limit = Error.stackTraceLimit;
  let stack = "";
  Error.stackTraceLimit = 30;
  try { stack = new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; }
  // IoBudget.note is a method, so its frame is dropped here by name (LAYER_FUNCTIONS lists function declarations only)
  return `caller:${waitCaller(stack.split("\n").filter(line => frameFunction(line) !== "note").join("\n"))}`;
}
const LAYER_FILE = /(?:^|[\\/(])(?:database|db-busy|io-budget|observe)\.ts:|node:|internal\//;
/** The function a stack line names (`at DatabaseSync.instrumentedExec [as exec] (...)` gives instrumentedExec), digits a bundler added cut. */
function frameFunction(line: string): string {
  const named = /^\s*at (?:async )?(?:new )?([^\s(]+)(?: \[as [^\]]+\])? \(/.exec(line);
  if (!named) return "";
  const last = named[1]!.split(".").pop() ?? "";
  return last.replace(/\d+$/, "");
}
/** `file.ts:line` (in the bundle `name@index.js:line`) of the first two frames outside the database layer: who asked for the wait. */
export function waitCaller(stack?: string): string {
  if (stack === undefined) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30;
    try { stack = new Error().stack ?? ""; } finally { Error.stackTraceLimit = limit; }
  }
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    if (LAYER_FILE.test(line)) continue;
    const name = frameFunction(line);
    if (name && LAYER_FUNCTIONS.has(name)) continue;
    const at = /([^\\/( ]+\.[cm]?[jt]s):(\d+)/.exec(line);
    if (!at) continue;
    // a bundle has one file name for every frame: the function's name is what says where the frame is
    const bundled = !/\.ts$/.test(at[1]!) && name && name !== "<anonymous>" && name !== "Object";
    frames.push(`${bundled ? `${name}@` : ""}${at[1]}:${at[2]}`);
    if (frames.length === 2) break;
  }
  return frames.length ? frames.join("<") : "unknown";
}
/** A statement over SLOW_SQL_MS that waited on the write lock (a BEGIN IMMEDIATE, or one that ended in SQLITE_BUSY) while the handle still had
 *  its default wait: `[sqlite] busy op= waited= holder= budget=none at=<caller>`. The stack is read only here, rate limited per op and caller. */
function witnessWait(db: object, sql: string, ms: number, failed: unknown, budget: IoBudget): void {
  const witness = busyWitness;
  if (!witness || ms <= SLOW_SQL_MS || busyNow.get(db) !== witness.defaultMs) return;
  if (!BEGIN_WRITE.test(sql) && !isBusyFailure(failed)) return;
  const op = shortStatement(sql).slice(0, 60), at = waitCaller();
  let holder: string;
  try { holder = witness.held() ? "writer-hold" : oldestLongOp() ?? "other-connection"; } catch { holder = "other-connection"; }
  const source = budget.currentSource();
  rateLimited(`sqlite-unbudgeted:${op}:${at}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(ms)} holder=${holder} budget=none at=${at}${source ? ` source=${source}` : ""}${suppressed ? ` more=${suppressed}` : ""}`);
}

// Statement reuse for a synchronous pass that runs the same few statements thousands of times (a session's receipts are
// checked record by record: ~60,000 prepares for one check). While a pass is open, preparing the same SQL again on the same
// handle returns the statement already made. Statements are only shared inside the pass, which is synchronous, so no two users
// ever hold one at the same time; the cache is dropped when the next outermost pass opens.
let reuseDepth = 0, reuseGeneration = 0;
let preparedDepth = 0, preparedGeneration = 0;
/** Share compilation within one synchronous slice; freshness memos retain their separate proof passes. */
export function withPreparedStatementReuse<T>(work: () => T): T {
  if (preparedDepth++ === 0) preparedGeneration++;
  try { return work(); } finally { preparedDepth--; }
}
export function withStatementReuse<T>(work: () => T): T {
  if (reuseDepth++ === 0) reuseGeneration++;
  try { return withPreparedStatementReuse(work); } finally { reuseDepth--; }
}
const REUSE_LIMIT = 512;
// Every write through an instrumented handle moves its counter (conservatively: a statement that can write, or any exec). A memo
// that only needs to know "did this connection write since I looked" reads it instead of asking SQLite for total_changes().
const writeCounts = new WeakMap<object, number>();
export const writeStamp = (db: object): number | undefined => writeCounts.get(db);
const wrote = (db: object) => writeCounts.set(db, (writeCounts.get(db) ?? 0) + 1);
// A second counter that moves only when a write names the tables the shared-bot rows are built from (room requests, team identities).
// Every statement on the handle goes through the instrumented prepare and exec below, so no writer can skip it, and a cascade from
// a parent delete needs no hook because the rows that matter are deleted by a statement that names them. Cross-connection writers do
// not exist for these tables (the only other connections to messages.db are read-only or touch other tables).
const sharedRowCounts = new WeakMap<object, number>();
export const sharedRowsStamp = (db: object): number | undefined => sharedRowCounts.get(db);
const SHARED_ROW_TABLES = /\b(?:room_requests|team_identities)\b/i;
const wroteSharedRows = (db: object) => sharedRowCounts.set(db, (sharedRowCounts.get(db) ?? 0) + 1);
// A third counter for the memory_scope_bindings table alone (a thread's human binding is read by about every route and moves rarely): it
// moves when a write names the table, and on every undo. No foreign key cascades into the table; another connection's commit is not seen
// here (a memo built on it must also end with the synchronous run that made it).
const bindingRowCounts = new WeakMap<object, number>();
export const bindingRowsStamp = (db: object): number | undefined => bindingRowCounts.get(db);
const BINDING_TABLE = /\bmemory_scope_bindings\b/i;
const wroteBindingRows = (db: object) => bindingRowCounts.set(db, (bindingRowCounts.get(db) ?? 0) + 1);
// Undoing writes (ROLLBACK, ROLLBACK TO, an aborted transaction) reports no changes but changes what a reader would see: it moves the
// general stamp and the shared-rows stamp, so a memo built from rows read inside the rolled-back transaction is never reused.
const UNDO_EXEC = /\bROLLBACK\b/i;
const undid = (db: object) => { wrote(db); wroteSharedRows(db); wroteBindingRows(db); };
// Statements that really write (INSERT, UPDATE, DELETE, REPLACE, a write transaction's BEGIN), per handle: the start-up witness counts them
// between listen and the first health answer (index.ts), where there should be none.
const writeStatements = new WeakMap<object, number>();
const WRITE_EXEC = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b|^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
// While traced (the start-up witness, listen until the first health answer) every counted write also notes who made it.
let writeTrace: Map<string, number> | null = null;
function traceWrite(): void { if (writeTrace) { const at = waitCaller(); writeTrace.set(at, (writeTrace.get(at) ?? 0) + 1); } }
const countWrite = (db: object) => { writeStatements.set(db, (writeStatements.get(db) ?? 0) + 1); traceWrite(); };
/** Starts noting the caller of every counted write; stopWriteTrace() hands back `caller xN` pairs, most first (the first `most` of them), and stops. */
export function startWriteTrace(): void { writeTrace = new Map(); }
export function stopWriteTrace(most = 8): string {
  const trace = writeTrace; writeTrace = null;
  if (!trace) return "";
  return [...trace].sort((a, b) => b[1] - a[1]).slice(0, most).map(([at, n]) => `${at}x${n}`).join(",");
}
/** A write about to start outside a transaction (an autocommit statement, a bare BEGIN IMMEDIATE), on a handle at its default wait, while the
 *  process's own writer hold is in force (a CREATE INDEX, the VACUUM) or under a background source: it waits the background budget, never the
 *  owner's 1 s on the serving thread (database.ts invariants 1 and 2). Owner writes were gated before a hold (gateWriteRequest, the turn start,
 *  the delivery gate), and background work treats the busy failure as "try later". True when the wait was lowered (the caller restores it). */
function lowerForHold(db: DatabaseSync, exec: (sql: string) => void): boolean {
  const witness = busyWitness;
  try {
    if (!witness || busyNow.get(db) !== witness.defaultMs || db.isTransaction || !(witness.held() || witness.background())) return false;
    exec(`PRAGMA busy_timeout=${witness.holdMs}`); busyNow.set(db, witness.holdMs);
    return true;
  } catch { return false; }
}
function restoreAfterHold(db: DatabaseSync, exec: (sql: string) => void, sql: string, ms: number, failed: unknown): void {
  const witness = busyWitness;
  if (!witness) return;
  try { if (db.isOpen) { exec(`PRAGMA busy_timeout=${witness.defaultMs}`); busyNow.set(db, witness.defaultMs); } } catch { /* closed */ }
  if (failed !== undefined && isBusyFailure(failed)) {
    const op = shortStatement(sql).slice(0, 60), at = waitCaller();
    let holder: string;
    try { holder = witness.held() ? "writer-hold" : oldestLongOp() ?? "other-connection"; } catch { holder = "other-connection"; }
    rateLimited(`sqlite-lowered:${op}:${at}`, 60_000, suppressed => `[sqlite] busy op=${op} waited=${Math.round(ms)} holder=${holder} budget=${witness.holdMs} at=${at}${suppressed ? ` more=${suppressed}` : ""}`);
  }
}
/** How many writing statements this handle has run (0 for a handle that is not instrumented). */
export const writeStatementCount = (db: object): number => writeStatements.get(db) ?? 0;
/** Whether a synchronous pass is open (the data folder cannot be swapped under it). */
export const inStatementReusePass = () => reuseDepth > 0;
/** Identifies the open pass (0 when none), so a memo made inside one is never read in another. */
export const statementReusePassId = () => reuseDepth > 0 ? reuseGeneration : 0;

/** What a connection reports to the one observer it may have (the memory wake bus, server/memory/wake.ts; owner: lane W of MEMORY V2).
 *  `ended`: a transaction has just ended or an autocommit write has just run. It is detected from the connection's own state
 *  (`isTransaction` true before the call and false after it), never from statement text, so a multi-statement exec that ends in COMMIT, a
 *  RELEASE of the outermost SAVEPOINT, a prepared COMMIT and SQLite ending the transaction itself are all seen. A rollback is reported the
 *  same way (it wrote nothing, so the observer finds nothing).
 *  `undone`: a ROLLBACK, a ROLLBACK TO, a failed statement, or one of the wrapper's own raw rollbacks: something a reader may have seen
 *  inside the transaction is gone. */
export interface ConnectionObserver { ended(): void; undone(): void }
const observerSlots = new WeakMap<object, { set(observer: ConnectionObserver | null): void; raw: { exec(sql: string): void; prepare(sql: string): StatementSync } }>();
/** Attach (or with null, remove) the observer of an instrumented handle. False when the handle is not instrumented. */
export function observeConnection(db: object, observer: ConnectionObserver | null): boolean {
  const slot = observerSlots.get(db);
  if (!slot) return false;
  slot.set(observer); return true;
}
/** The handle's un-instrumented exec and prepare, for connection setup that must stay outside the budget and the statement meter (TEMP
 *  installs and the wake drain). Undefined for a handle that is not instrumented. */
export function rawConnection(db: object): { exec(sql: string): void; prepare(sql: string): StatementSync } | undefined { return observerSlots.get(db)?.raw; }
/** A prepared statement that can end a transaction without writing (its iterate() is wrapped too, so the end is still seen). */
const LONE_PRAGMA = /^\s*PRAGMA\b[^;]*;?\s*$/i;
const ENDS_TRANSACTION_STATEMENT = /^\s*(?:COMMIT|END|RELEASE)\b/i;

/** Time every statement run through this handle, so a trip can name the culprits. `bytes: false` for a handle that never writes
 * (the memory index reader): its file's log is another process's writing, charged by that process's own report, not read here twice. */
export function instrumentDatabase(db: DatabaseSync, budget: IoBudget = ioBudget, options: { bytes?: boolean } = {}): () => void {
  const prepare = db.prepare.bind(db);
  const file = prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  const source = file ? `database:${file}` : "";
  // Attribute committed WAL frames to the connection. The process meter separately reports every raw xWrite,
  // including copy-back, without attributing WM bytes to the foreground statement that happened to sample them.
  const unregister = source && options.bytes !== false ? budget.registerByteSource(source, walFrameReader(String(file))) : () => {};
  let transactionSource = source;
  const sample = (name: string) => { if (source) budget.sampleByteSource(source, name); };
  const exec = db.exec.bind(db);
  let observer: ConnectionObserver | null = null;
  observerSlots.set(db, { set: next => { observer = next; }, raw: { exec, prepare } });
  // After every statement: `wasIn` is whether a transaction was open before it, `wrote` whether it could write.
  const observed = (wasIn: boolean, wrote: boolean, failed: unknown, undoes: boolean) => {
    const watching = observer;
    if (!watching) return;
    let inNow: boolean;
    try { inNow = db.isTransaction; } catch { return; } // closed under us
    if (undoes || failed !== undefined) watching.undone();
    if (!inNow && (wasIn || wrote)) watching.ended();
  };
  const wal=source&&options.bytes!==false?walIndexReader(String(file)):null;
  let auto:AdmissionTicket|null=null;
  let sqlDeadline=false;
  let sliceGeneration=0,autoRefused=0;
  let beforeMark:ReturnType<NonNullable<typeof wal>>=null;
  const sqlitePage=Number(prepare("PRAGMA page_size").get()?.page_size??4096);
  const finishGrant=()=>{
    if(!auto)return;
    const ticket=auto;auto=null;sliceGeneration++;
    const state=endBgGrant(), mark=wal?.();
    const frames=mark?Math.max(0,mark.mxFrame-(beforeMark?.salt===mark.salt?beforeMark.mxFrame:0)):null;
    const debt=frames===null?undefined:frames*Math.ceil(sqlitePage/state.pageSize)*state.pageSize;
    // MAIN 2026-11-22 idle-capture (b): a write the native grant refused was rolled back, and a rolled-back write charges nothing. It is
    // proven by the log: refused, and no frame committed under this grant. The bytes it did put on disk stay in the observed total
    // (measured, slot 11); only the ticket's charge and copy debt are dropped. Unprovable (no log reader, or frames landed): charged as before.
    const rolledBack=state.refusedWrites>autoRefused&&frames===0;
    budget.settle(ticket,rolledBack?0:state.usedBytes,{salt:mark?.salt??"unreadable",frame:mark?.mxFrame??Number.MAX_SAFE_INTEGER},rolledBack?0:debt,rolledBack?0:state.rawBytes);
    if(sqlDeadline){sqlDeadline=false;prepare('SELECT murage_grant_deadline(0)').get();}
    if(state.refusedWrites>autoRefused){budget.noteBgRefusal();throw new BgDeferred(budget.nextAdmissionMs());}
  };
  const beforeWrite=(writing:boolean)=>{
    const current=budget.currentSource();
    // The independent notebook timer retains owner scheduling priority and shares BG byte admission.
    if(!writing||!(current?.startsWith("memory-")||current==="owner-notebook"))return;
    budget.assertCurrentSlice();
    if(auto||ioGrantSnapshot().live)return;
    // idle DO LESS (idleQuiet): on an idle minute no background memory write starts; the slice waits for the next minute's look
    if(budget.idleQuiet())throw budget.idleRefusal();
    // An owed capture reserves its copy at the exact per-frame bound: the meter charges every WAL frame at least one OS page
    // of header plus its page span, and the frame owes one page span of copy. Other writers keep the half split.
    const room=budget.backgroundRoom(),osPage=ioGrantSnapshot().pageSize,copy=Math.ceil(sqlitePage/osPage)*osPage,frame=osPage+copy;
    const capture=current==="memory-capture";
    const cap=Math.min(capture?Math.floor(room*frame/(frame+copy)):Math.floor(room/2),1024*1024);
    const ticket=cap>=commitCeiling(1,sqlitePage,osPage)?budget.admit(current==="memory-boot-recovery"?"BOOT_RECOVERY":"BG",cap,wal?(capture?Math.floor(cap/frame)*copy:cap):0):null;
    if(!ticket){if(cap<commitCeiling(1,sqlitePage,osPage))budget.noteBgRefusal();throw budget.refusalRetry();}
    beforeMark=wal?.()??null;
    try{
      if(Number.isFinite(budget.currentSliceDeadline())){prepare('SELECT murage_grant_deadline(1)').get();sqlDeadline=true;}
      beginBgGrant({...ticket,expiresAt:Math.min(ticket.expiresAt,budget.currentSliceDeadline())});
    }catch(error){
      try{if(sqlDeadline){sqlDeadline=false;prepare('SELECT murage_grant_deadline(0)').get();}}
      finally{budget.settle(ticket,0);}
      throw error;
    }
    auto=ticket;autoRefused=ioGrantSnapshot().refusedWrites;
    const gen=++sliceGeneration;
    // A shared connection must never keep a native grant or a transaction across an await.
    queueMicrotask(()=>{
      if(!auto||gen!==sliceGeneration)return;
      try{if(db.isTransaction){try{exec("ROLLBACK");}finally{observed(true,false,undefined,true);}budget.deferCurrentSlice();}}finally{finishGrant();}
    });
  };
  const afterWrite=(failed?:unknown)=>{
    if(!auto)return;
    if(failed!==undefined&&db.isTransaction)try{exec("ROLLBACK");}catch{/* preserve failure */}finally{observer?.undone();}
    if(!db.isTransaction){
      finishGrant();
    }
  };
  writeCounts.set(db, 0);
  sharedRowCounts.set(db, 0);
  bindingRowCounts.set(db, 0);
  const instrumentedExec = (sql: string) => {
    const inTransaction = db.isTransaction;
    if (!inTransaction) sample(source);
    const writing = WRITE_EXEC.test(sql) || /^\s*BEGIN\b/i.test(sql) || /\b(?:CREATE|DROP|ALTER|VACUUM|REINDEX)\b|^\s*PRAGMA\s+[\w.]+\s*=/i.test(sql);
    beforeWrite(writing);
    // (an exec cannot report its changes: a statement that can write moves the stamps, a pragma or a read does not)
    if ((writing && !DEFERRED_BEGIN.test(sql)) || /\b(?:CREATE|DROP|ALTER)\b/i.test(sql)) {
      wrote(db);
      if (SHARED_ROW_TABLES.test(sql)) wroteSharedRows(db);
      if (BINDING_TABLE.test(sql)) wroteBindingRows(db);
    }
    if (writing) countWrite(db);
    const lowered = writing && !/^\s*PRAGMA\s+(?:main\.)?busy_timeout\s*=/i.test(sql) && lowerForHold(db, exec);
    const started = performance.now();
    let failed: unknown;
    try { exec(sql); } catch (error) { failed = error; throw error; }
    finally {
      // A rollback reports no changes yet undoes rows a memo may have read inside the transaction: it always moves every stamp (a
      // ROLLBACK, a ROLLBACK TO, or SQLite aborting the transaction itself when a statement fails and the handle is no longer in one).
      if (inTransaction && (UNDO_EXEC.test(sql) || (failed !== undefined && !db.isTransaction))) undid(db);
      const ms = performance.now() - started;
      if (lowered) restoreAfterHold(db, exec, sql, ms, failed);
      budget.note(EXEC_PREFIX + statementKey(sql), ms, true);
      if (!lowered && ms > SLOW_SQL_MS) witnessWait(db, sql, ms, failed, budget);
      // the end of a transaction: database.ts puts back what a background slice relaxed for its commit (synchronous)
      if (inTransaction && END_TRANSACTION.test(sql)) { try { if (!db.isTransaction) busyWitness?.transactionEnded(db); } catch { /* closed */ } }
      // (a lone PRAGMA assignment is a setting, not a row: it is no autocommit write to the observer)
      try { afterWrite(failed); } finally { observed(inTransaction, writing && !LONE_PRAGMA.test(sql), failed, UNDO_EXEC.test(sql)); }
    }
    if (!db.isTransaction) sample(budget.currentSource() ?? (inTransaction ? transactionSource : statementKey(sql)));
  };
  db.exec = instrumentedExec;
  const reuse = new Map<string, StatementSync>();
  let reuseSeen = -1;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (preparedDepth > 0) {
      if (reuseSeen !== preparedGeneration) { reuse.clear(); reuseSeen = preparedGeneration; }
      const known = reuse.get(sql);
      if (known) return known;
    }
    const statement = prepare(sql);
    const key = statementKey(sql);
    const tokens = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const writes = /\b(?:INSERT|UPDATE|REPLACE|DELETE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b|^\s*BEGIN\b/i.test(tokens);
    const deferredBegin = DEFERRED_BEGIN.test(tokens);
    const schemaWrite = /\b(?:CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i.test(tokens);
    const sharedTable = writes && SHARED_ROW_TABLES.test(tokens);
    // (matched on the statement as written, quotes and comments included: `UPDATE 'memory_scope_bindings'` names the table too)
    const bindingTable = writes && BINDING_TABLE.test(sql);
    // a prepared ROLLBACK or ROLLBACK TO undoes rows a memo may have read, as the exec form does
    const undoes = UNDO_EXEC.test(tokens);
    const memoryWork = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+(?:OR\s+\w+\s+)?|REPLACE\s+INTO)\s*["`\[]?(?:main["`\]]?\s*\.\s*["`\[]?)?memory_(?:jobs|projection_receipts|scope_bindings)["`\]]?(?=\s|\(|$)/i.test(tokens);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      const instrumentedStatement = (...args: unknown[]) => {
        beforeWrite(writes);
        const lowered = writes && method === "run" && lowerForHold(db, exec);
        const inTransactionBefore = db.isTransaction;
        const started = performance.now();
        let failed: unknown;
        try {
          const result = original(...args);
          if (writes) {
            transactionSource = budget.currentSource() ?? key;
            if (!db.isTransaction) sample(transactionSource);
          }
          // the stamps move only when rows really changed: a DELETE that matched nothing (the idle push-notification prune) leaves them
          if (writes) {
            const changed = schemaWrite || method !== "run" || Number((result as { changes: number | bigint }).changes) > 0;
            if (changed && !deferredBegin) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); }
          }
          if (memoryWork && method === "run" && Number((result as {changes:number|bigint}).changes) > 0) budget.notifyMemoryWork();
          return result;
        } catch (error) { failed = error; throw error; }
        finally {
          // a failed statement that made SQLite abort the whole transaction undid every write in it
          if (failed !== undefined && inTransactionBefore && !db.isTransaction) undid(db);
          // OR FAIL can retain earlier row changes: invalidate facts even when the statement throws.
          if (failed !== undefined && writes && !deferredBegin) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); }
          if (undoes && inTransactionBefore) undid(db);
          if (writes && method === "run") countWrite(db);
          const ms = performance.now() - started;
          budget.note(key, ms, true);
          if (lowered) restoreAfterHold(db, exec, sql, ms, failed);
          else if (failed !== undefined && writes && ms > SLOW_SQL_MS) witnessWait(db, sql, ms, failed, budget);
          try { afterWrite(failed); } finally { observed(inTransactionBefore, writes, failed, undoes); }
        }
      };
      (statement as unknown as Record<string, unknown>)[method] = instrumentedStatement;
    }
    // iterate() runs the statement as its rows are pulled (an UPDATE ... RETURNING writes there): every pull and the end of the iteration
    // move the stamps the statement could move, whether it changed rows or failed
    if (writes || undoes || ENDS_TRANSACTION_STATEMENT.test(tokens)) {
      const iterate = statement.iterate.bind(statement) as (...args: unknown[]) => IterableIterator<unknown>;
      const touched = () => { if (writes && !deferredBegin) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); } if (undoes) undid(db); };
      // a pull that made SQLite abort the whole transaction (a schema-level ON CONFLICT ROLLBACK on a row it inserted into another table)
      // undid every write in it, binding rows included: the same abort test as get/all/run, around every pull and the end
      const pulled = <R>(pull: () => R): R => {
        const inTransactionBefore = db.isTransaction;
        beforeWrite(writes);
        let failed: unknown;
        // a statement wrapped only because it can end a transaction (COMMIT, END, RELEASE) keeps its old path: it is observed, nothing more
        if (!writes && !undoes) { try { return pull(); } catch (error) { failed = error ?? new Error("iterate failed"); throw error; } finally { observed(inTransactionBefore, false, failed, false); } }
        try { return pull(); } catch (error) { failed = error ?? new Error("iterate failed"); throw error; }
        finally { try { afterWrite(); touched(); try { if (inTransactionBefore && !db.isTransaction) undid(db); } catch { undid(db); } } finally { observed(inTransactionBefore, writes, failed, undoes); } }
      };
      (statement as unknown as Record<string, unknown>).iterate = (...args: unknown[]) => {
        const inner = iterate(...args);
        const wrapped: IterableIterator<unknown> = {
          next: (...more: [] | [unknown]) => pulled(() => inner.next(...more)),
          return: (value?: unknown) => pulled(() => inner.return ? inner.return(value) : { done: true, value }),
          [Symbol.iterator]() { return wrapped; },
        };
        return wrapped;
      };
    }
    if (preparedDepth > 0 && reuse.size < REUSE_LIMIT) reuse.set(sql, statement);
    return statement;
  };
  return () => { unregister(); wal?.close(); };
}
