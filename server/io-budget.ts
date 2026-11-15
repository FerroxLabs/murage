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
import { BLOCK_BYTES, osWriteBlocks, takeWrittenBytes, walFrameReader, walIndexReader } from "./io-written.ts";
import { ioMeterTotal, ioMeterCoverageKnown, ioMeterSnapshot, ioGrantSnapshot, beginBgGrant, endBgGrant, commitCeiling, withForegroundCopy, ioMeterWallTime } from "./io-meter.ts";
import { darwinWrittenBytes } from "./os-disk-written.ts";
import { turnTraceEnabled } from "./turn-trace.ts";
import { activeTaskName, oldestLongOp, rateLimited, reportSlowSql, SLOW_SQL_MS } from "./observe.ts";
import { systemLoad } from "./system-load.ts";
import { HEALTH_LIMITS, type IoSample, type IoSourceClass } from "../shared/health-protocol.mjs";
import { recordFact } from "./health/counters.ts";
import { NET_LINE_BYTES_PER_MINUTE, netMeter, netText, type NetMinute } from "./net-meter.ts";
import { countsAsOwnerAction } from "./owner-activity.ts";

import { registerTestHandle } from "./test-handle-registry.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { BgDeferred } from "./bg-admission.ts";
export { BgDeferred, isBgDeferred } from "./bg-admission.ts";

export const IO_BUDGET_INTERVAL_MS = 60_000;
export const IO_BUDGET_BYTES_PER_MINUTE = 50 * 1024 * 1024;
export const IO_BUDGET_IDLE_BYTES_PER_MINUTE = 1024 * 1024;
/** Shared admission for periodic writers. Leave room for checkpoint copies and overlapping sample windows; the watchdog limits stay unchanged. */
export const IO_BUDGET_BACKGROUND_BYTES_PER_MINUTE = IO_BUDGET_IDLE_BYTES_PER_MINUTE / 4;
const PERIODIC_SOURCES: ReadonlySet<string> = new Set([
  "memory-worker", "memory-idle", "memory-notebook", "memory-upgrade", "memory-continuity",
  "search-index", "transcript-backfill", "record-keys-backfill", "push-delivery",
]);
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
export interface IoReading { at: number; fsWriteBlocks: number; cpuMicros: number; osKnown?: boolean; meterBytes?: number; sentinelGeneration?:string|null; coverageKnown?:boolean }
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
/** SEAN 1114-MEM-DELETE-IDLE-WINDOW: settled owner-deletion bytes a minute while the idle exemption is in use. Equal to
 * REVOKE_WRITE_BUDGET.bytesPerMinute (memory/revoke-budget.ts; a test holds the two together). */
export const OWNER_DELETE_IDLE_BYTES_PER_MINUTE = 20 * 1024 * 1024;
export interface AdmissionTicket { readonly bytes:number; readonly debtBytes:number; readonly expiresAt:number; readonly minute:number; readonly cls:"BG"|"FGCOPY"; readonly observed:number }
export interface BackfillMark { salt:string; frame:number; complete?:boolean }
/** Admission's fast process floor never opens receipt files or advances a
 * coverage endpoint. The minute tick owns the authenticated external sample. */
function readAdmissionProcess():IoReading {
 const usage=process.resourceUsage(),at=Date.now(),cpuMicros=usage.userCPUTime+usage.systemCPUTime;
 const counted=ioMeterTotal()??ioMeterSnapshot()?.total??null;
 const meter=counted===null?{}:{meterBytes:counted};
 if(process.platform==="win32")return {at,fsWriteBlocks:(counted??0)/BLOCK_BYTES,cpuMicros,...meter,...(counted===null?{osKnown:false}:{})};
 if(process.platform==="darwin"){const bytes=darwinWrittenBytes();return {at,fsWriteBlocks:(bytes??0)/BLOCK_BYTES,cpuMicros,...meter,...(bytes===null?{osKnown:false}:{})};}
 return {at,fsWriteBlocks:osWriteBlocks(usage),cpuMicros,...meter};
}
export class IoBudget {
  private readonly read: () => IoReading;
  private readonly admissionRead: () => IoReading;
  private readonly log: (line: string) => void;
  private onScale: (scale: number) => void;
  private readonly bytesPerMinute: number;
  private readonly cpuFraction: number;
  private readonly cpuMinutes: number;
  private last: IoReading | null = null;
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
  private deferredSource: string | null = null;
  private deferUntil = 0;
  /** A leaky bucket's finish time: constant state, including an oversized slice's debt, independent of history or writer count. */
  private backgroundDebtAt = 0;
  private foregroundActivity = false;
  /** Bytes written in the last minute under a budget of their own (the revoke marker's, revoke-budget.ts): planned, capped there, and
   *  taken off the minute's writes before the verdict, so a walk at its allowance is not reported as a fault and punished with a slower poll
   *  rate for everything else (SELF-OVERLOAD-105 item 1b). */
  private plannedBytes: (() => number) | null = null;
  /** The most the planned reader is believed for in one minute: its own budget plus a margin. A reader that claims more hides nothing. */
  private plannedCap = Number.POSITIVE_INFINITY;
  /** Totals at the last statement-trace line, so each line is one minute's cost. */
  private traced = new Map<string, { calls: number; ms: number }>();
  private traceTimer: ReturnType<typeof setInterval> | null = null;
  /** One diagnostic per category per minute; three fixed keys bound state even as sources change. */
  private readonly diagnosticLogs = new Map<"writing" | "cpu" | "both" | "traffic" | "unknown", { at: number; suppressed: number }>();

  private readonly admissionShared=checkpointLedger(new SharedArrayBuffer(14*BigInt64Array.BYTES_PER_ELEMENT));
  private admissionMinute=-1;
  private admissionTimer:ReturnType<typeof setInterval>|null=null;
  private reserved=new Map<AdmissionTicket,{write:number;debt:number}>();
  /** Owner-deletion copies admitted through the idle exemption this minute: settled bytes plus what is still reserved. */
  private ownerIdle={minute:-1,settled:0,reserved:0,tickets:new Map<AdmissionTicket,number>()};
  private ownerIdleBytes():number {
    if(this.ownerIdle.minute!==this.admissionMinute){this.ownerIdle.minute=this.admissionMinute;this.ownerIdle.settled=0;this.ownerIdle.reserved=0;this.ownerIdle.tickets.clear();}
    return this.ownerIdle.settled+this.ownerIdle.reserved;
  }
  private copyDebt:{mark:BackfillMark;bytes:number}[]=[];
  /** A closed test fixture is a fresh application. Never resets a running product ledger. */
  resetAdmissionForFixture():void {
    this.ownerIdle.minute=-2;
    if(!process.env.VITEST)throw new Error("IO_ADMISSION_TEST_ONLY");
    const reading=this.read(),a=this.admissionShared;
    a.lock();try{
      for(const slot of [2,3,4,5,6,8,11])Atomics.store(a.slots,slot,0n);
      this.copyDebt=[];this.reserved.clear();
      Atomics.store(a.slots,9,BigInt(reading.fsWriteBlocks*BLOCK_BYTES));Atomics.store(a.slots,10,BigInt(reading.meterBytes??0));
      Atomics.store(a.slots,12,a.slots[9]);Atomics.store(a.slots,13,a.slots[10]);
      this.admissionMinute=Math.floor(reading.at/IO_BUDGET_INTERVAL_MS);Atomics.store(a.slots,1,BigInt(this.admissionMinute));
    }finally{a.unlock();}
  }
  private admissionReading():IoReading {
    const reading=this.admissionRead(),minute=Math.floor(reading.at/IO_BUDGET_INTERVAL_MS);
    const os=reading.fsWriteBlocks*BLOCK_BYTES,meter=reading.meterBytes??0;
    const a=this.admissionShared;a.lock();
    try{
      a.rotate(reading.at);
      if(minute!==this.admissionMinute){
        this.admissionMinute=minute;
        // Keep the last pre-flip reading as a conservative base; no first-sample gap.
        this.reserved.clear();
      }
      const observed=Math.max(0,os-Number(a.slots[9]),meter-Number(a.slots[10]));
      Atomics.store(a.slots,11,BigInt(Math.max(Number(a.slots[11]),observed)));
      Atomics.store(a.slots,3,a.slots[11]+a.slots[8]);
      Atomics.store(a.slots,12,BigInt(os));Atomics.store(a.slots,13,BigInt(meter));
      Atomics.store(a.slots,7,this.isIdle()&&!this.foregroundActivity?1n:0n);
    }finally{a.unlock();}
    return reading;
  }
  /** One buffer per budget; WM checks whole-copy room immediately before stepping. */
  checkpointAdmissionBuffer():SharedArrayBuffer {this.admissionReading();return this.admissionShared.slots.buffer as SharedArrayBuffer;}
  admissionState():{bg:number;debt:number;total:number;reserved:number} {
    this.admissionReading();const a=this.admissionShared;a.lock();
    try{return {bg:Number(a.slots[2]),debt:Number(a.slots[4]),total:Number(a.slots[3]),reserved:Number(a.slots[5])};}finally{a.unlock();}
  }
  /** Reserve both the write and the copy it creates. Settlement releases only unused room. */
  /** ownerDeletion (SEAN 1114-MEM-DELETE-IDLE-WINDOW): a foreground copy for an owner's deletion scrub, asked while the controller's
   * window is open, skips ONLY the idle clause and is paced at OWNER_DELETE_IDLE_BYTES_PER_MINUTE instead. BG never qualifies. */
  admit(cls:"BG"|"FGCOPY",ceiling:number,debtBytes=0,options?:{ownerDeletion?:boolean}):AdmissionTicket|null {
    if(!Number.isSafeInteger(ceiling)||ceiling<0||!Number.isSafeInteger(debtBytes)||debtBytes<0)throw new Error("BG_CEILING_INVALID");
    let reading:IoReading;try{reading=this.admissionReading();}catch{return null;}
    const a=this.admissionShared,end=(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS;
    a.lock();
    try{
      const bg=Number(a.slots[2]),debt=Number(a.slots[4]),total=Number(a.slots[3]),reserved=Number(a.slots[5]),writes=Number(a.slots[6]);
      const idle=a.slots[7]!==0n;
      const exempt=cls==="FGCOPY"&&idle&&options?.ownerDeletion===true;
      if(cls==="BG"){
        if(idle||reading.at>end-5000||bg+debt+reserved+ceiling+debtBytes>BG_MINUTE_BYTES||total+writes+ceiling>49*1024*1024)return null;
      }else if(exempt){
        if(this.ownerIdleBytes()+ceiling>OWNER_DELETE_IDLE_BYTES_PER_MINUTE)return null;
      }else if(idle&&(reading.at>end-5000||total+writes+ceiling>IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536))return null;
      const ticket:AdmissionTicket=Object.freeze({bytes:ceiling,debtBytes,expiresAt:ioMeterWallTime()+end-reading.at,minute:this.admissionMinute,cls,observed:Number(a.slots[11])});
      this.reserved.set(ticket,{write:ceiling,debt:debtBytes});
      if(exempt){this.ownerIdle.tickets.set(ticket,ceiling);this.ownerIdle.reserved+=ceiling;}
      if(cls==="BG")Atomics.add(a.slots,5,BigInt(ceiling+debtBytes));
      Atomics.add(a.slots,6,BigInt(ceiling));return ticket;
    }finally{a.unlock();}
  }
  settle(ticket:AdmissionTicket,used:number,mark?:BackfillMark,debtUsed?:number,rawUsed=0):void {
    this.admissionReading();const reserved=this.reserved.get(ticket);if(!reserved)return;
    if(!Number.isSafeInteger(used)||used<0||(ticket.cls==="BG"&&used>ticket.bytes))throw new Error("BG_CEILING_MISS");
    if(ticket.debtBytes&&used&&!mark)throw new Error("BG_DEBT_MARK_REQUIRED");
    if(debtUsed!==undefined&&(!Number.isSafeInteger(debtUsed)||debtUsed<0||debtUsed>ticket.debtBytes))throw new Error("BG_DEBT_CEILING_MISS");
    const a=this.admissionShared;a.lock();
    try{
      this.reserved.delete(ticket);
      this.ownerIdleBytes();
      const exemptBytes=this.ownerIdle.tickets.get(ticket);
      if(exemptBytes!==undefined){this.ownerIdle.tickets.delete(ticket);this.ownerIdle.reserved-=exemptBytes;this.ownerIdle.settled+=used;}
      if(ticket.cls==="BG"){
        Atomics.sub(a.slots,5,BigInt(reserved.write+reserved.debt));Atomics.add(a.slots,2,BigInt(used));
      }
      Atomics.sub(a.slots,6,BigInt(reserved.write));
      const included=Math.min(rawUsed,Math.max(0,Number(a.slots[11])-ticket.observed));
      Atomics.add(a.slots,8,BigInt(used-included));Atomics.store(a.slots,3,a.slots[11]+a.slots[8]);
      if(ticket.debtBytes&&used){
        const bytes=debtUsed??Math.min(used,ticket.debtBytes);
        this.copyDebt.push({mark:mark!,bytes});Atomics.add(a.slots,4,BigInt(bytes));
      }
    }finally{a.unlock();}
  }
  foregroundCopy<T>(ceiling:number,fn:()=>T):T|undefined {
    const ticket=this.admit("FGCOPY",ceiling);if(!ticket)return undefined;
    let used=ceiling,raw=0;
    try{const result=withForegroundCopy(fn);used=result.usedBytes??ceiling;raw=result.rawBytes;return result.result;}
    finally{this.settle(ticket,used,undefined,0,raw);}
  }
  /** Copy debt moves to this minute before release, including a WAL restart; one atomic critical section. */
  backfilled(mark:BackfillMark):void {
    this.admissionReading();const a=this.admissionShared;a.lock();
    try{
      const retained:typeof this.copyDebt=[];
      for(const entry of this.copyDebt){
        if((entry.mark.salt==="unreadable"?mark.complete:entry.mark.salt!==mark.salt||entry.mark.frame<=mark.frame)){Atomics.add(a.slots,2,BigInt(entry.bytes));Atomics.sub(a.slots,4,BigInt(entry.bytes));}
        else retained.push(entry);
      }
      this.copyDebt=retained;
    }finally{a.unlock();}
  }
  /** Read-only offer bound; owner deletion preserves the shared idle ceiling. */
  copyRoom(ownerDeletion=false):number {
    this.admissionReading();const a=this.admissionShared;a.lock();
    try{
      if(ownerDeletion&&a.slots[7]!==0n)return Math.max(0,Math.min(11*1024*1024,OWNER_DELETE_IDLE_BYTES_PER_MINUTE-this.ownerIdleBytes()));
      return a.slots[7]!==0n?Math.max(0,IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536-Number(a.slots[3])-Number(a.slots[6])):11*1024*1024;
    }
    finally{a.unlock();}
  }
  backgroundRoom():number {
    const s=this.admissionState();return Math.max(0,Math.min(BG_MINUTE_BYTES-s.bg-s.debt-s.reserved,49*1024*1024-s.total-s.reserved));
  }
  nextAdmissionMs():number {const r=this.admissionReading();return Math.max(1,(this.admissionMinute+1)*IO_BUDGET_INTERVAL_MS-r.at);}

  constructor(options: IoBudgetOptions = {}) {
    this.read = options.read ?? readProcess;
    this.admissionRead = options.read ?? readAdmissionProcess;
    this.log = options.log ?? ((line) => console.warn(line));
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
    if(options.read)try{this.admissionReading();}catch{Atomics.store(this.admissionShared.slots,7,1n);}
    else {
      // Establish the process floor without loading a native extension during module evaluation.
      const baseline=osWriteBlocks(process.resourceUsage())*BLOCK_BYTES;
      Atomics.store(this.admissionShared.slots,9,BigInt(baseline));Atomics.store(this.admissionShared.slots,12,BigInt(baseline));this.admissionMinute=Math.floor(Date.now()/IO_BUDGET_INTERVAL_MS);
      Atomics.store(this.admissionShared.slots,1,BigInt(this.admissionMinute));
    }
  }

  /** Replace the listener told when the scale changes. */
  setOnScale(listener: (scale: number) => void): void { this.onScale = listener; }
  setIsIdle(read: () => boolean): void { this.isIdle = read; this.admissionReading(); }
  setOnMemoryWork(listener: () => void): void { this.onMemoryWork = listener; }
  setOnSample(listener: ((sample: IoSample) => void) | undefined): void { this.onSample = listener; }
  /** A reader of the bytes a writer with its own budget wrote in the last minute (null: none), and the most it is believed for (its budget
   *  plus a margin): the exemption is for a writer that keeps to its plan, never a blank cheque. */
  setPlannedBytes(read: (() => number) | null, capBytesPerMinute = Number.POSITIVE_INFINITY): void { this.plannedBytes = read; this.plannedCap = capBytesPerMinute > 0 ? capBytesPerMinute : Number.POSITIVE_INFINITY; }
  notifyMemoryWork(): void { try { this.onMemoryWork?.(); } catch { /* notifications do not change a write's result */ } }

  noteBytes(source: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.bytes.set(source, (this.bytes.get(source) ?? 0) + bytes);
    if (this.timer && PERIODIC_SOURCES.has(source)) {
      this.backgroundDebtAt = Math.max(Date.now(), this.backgroundDebtAt)
        + bytes / IO_BUDGET_BACKGROUND_BYTES_PER_MINUTE * IO_BUDGET_INTERVAL_MS;
    }
  }

  /** A turn's start and completion both mark the sampled interval, even if the engine is already idle at the minute tick. */
  noteForegroundActivity(): void { this.foregroundActivity = true; this.admissionReading(); }

  /** Use the same owner-action classification as the idle clock; presence beats do not buy an active minute. */
  noteOwnerRequest(method: string | undefined, rawUrl: string | undefined): void {
    if (countsAsOwnerAction(method, rawUrl)) this.noteForegroundActivity();
  }

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
  /** Names the SYNCHRONOUS part of `operation` only: the timers and promises it starts do not inherit the source (an after-listen step
   *  starts long-lived loops, whose later slices must keep their own source, or none). */
  withSyncSource<T>(source: string, operation: () => T): T {
    const outer = this.syncSource;
    this.syncSource = source;
    try { return operation(); } finally { this.syncSource = outer; }
  }
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
    if (!previous) { this.bytes.clear(); this.childBytes=0; this.foregroundActivity = false; return null; }
    if (reading.at <= previous.at) return null;
    const minutes = (reading.at - previous.at) / 60_000;
    // fail closed (IO-IDLE r3.6): a minute either end of which could not read the OS count is UNKNOWN, not 0: it is never calm (the poll
    // rate stays at least halved and never steps back), its sample is never valid evidence, and it says so once an hour
    const osUnavailable = reading.osKnown === false || previous.osKnown === false;
    const osUnknown = osUnavailable || reading.coverageKnown===false || previous.coverageKnown===false || reading.sentinelGeneration!==previous.sentinelGeneration;
    const osBytes = osUnavailable ? 0 : Math.max(0, (reading.fsWriteBlocks - previous.fsWriteBlocks) * BLOCK_BYTES);
    let planned = 0;
    if (this.plannedBytes) { try { planned = Math.min(this.plannedCap * minutes, Math.max(0, Number(this.plannedBytes()) || 0)); } catch { planned = 0; } }
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
    const budget = idle ? IO_BUDGET_IDLE_BYTES_PER_MINUTE : this.bytesPerMinute;
    const writing = writeBytesPerMinute > budget;
    const spinning = this.hotCpuMinutes >= this.cpuMinutes;
    const tripped = writing || spinning;
    const traffic = net ? netText(net, reading.at - previous.at) : "";
    if (tripped) {
      this.calmMinutes = 0;
      const next = Math.min(IO_BUDGET_MAX_SCALE, this.scale * 2);
      this.deferredSource = [...this.bytes].sort((a,b) => b[1]-a[1])[0]?.[0] ?? this.topStatements(1)[0]?.sql ?? "process";
      this.deferUntil = reading.at + next * IO_BUDGET_INTERVAL_MS;
      const category = writing ? (spinning ? "both" : "writing") : "cpu";
      const lastLog = this.diagnosticLogs.get(category);
      if (!lastLog || reading.at - lastLog.at >= IO_BUDGET_INTERVAL_MS) {
        const top = this.topStatements().map(cost => `${Math.round(cost.ms)}ms x${cost.calls} ${cost.sql}`).join(" | ") || "none recorded";
        const line = `[io-budget] ${writing ? `writing ${(writeBytesPerMinute / 1048576).toFixed(1)} MB/min (budget ${(budget / 1048576).toFixed(0)}${planned > 0 ? `, ${(planned / minutes / 1048576).toFixed(1)} MB/min planned not counted` : ""})` : ""}`
          + `${writing && spinning ? ", " : ""}${spinning ? `cpu ${(cpu * 100).toFixed(0)}%${systemHot ? ` (computer: ${system!.why})` : ""} for ${this.hotCpuMinutes} min` : ""}; source: ${this.deferredSource}; top statements: ${top}; poll rate x1/${next}${traffic && `; ${traffic}`}`;
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
        try { this.log(`[io-budget] os writes unknown (the engine-exclusion helper's diskWritten could not be read): background work runs at half rate; applicationBytes=${Math.round(applicationBytes)}; suppressed=${lastLog?.suppressed ?? 0}`); } catch { /* a line never changes the minute */ }
        this.diagnosticLogs.set("unknown", { at: reading.at, suppressed: 0 });
      } else lastLog.suppressed++;
    } else if (this.scale > 1 && ++this.calmMinutes >= IO_BUDGET_CALM_MINUTES) {
      this.calmMinutes = 0;
      this.setScale(Math.max(1, this.scale / 2));
      if (this.scale === 1) this.deferredSource = null;
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
    this.bytes.clear();this.childBytes=0;
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
    this.admissionTimer=setInterval(()=>{try{this.admissionReading();}catch{/* admission stays conservative */}},25);
    this.admissionTimer.unref?.();
    if (turnTraceEnabled() && !this.traceTimer) {
      this.traceTimer = setInterval(() => { try { this.traceTopStatements(); } catch { /* tracing never throws into the app */ } }, IO_BUDGET_INTERVAL_MS);
      this.traceTimer.unref?.();
    }
  }

  stop(): void {
    if(this.admissionTimer)clearInterval(this.admissionTimer);this.admissionTimer=null;
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

export const ioBudget = new IoBudget({ onSample: sample => recordFact({ kind: "io-minute", ...sample }), netMinute: () => netMeter.take(), written: takeWrittenBytes });
// Disjoint from the memory helper, which retains its existing source.
ioBudget.registerByteSource("owned-node-children",ownedChildIoBytes,{child:true});
registerTestHandle("stop",dir=>{if(dir===undefined)ioBudget.resetAdmissionForFixture();});
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
export function withStatementReuse<T>(work: () => T): T {
  if (reuseDepth++ === 0) reuseGeneration++;
  try { return work(); } finally { reuseDepth--; }
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
/** Starts noting the caller of every counted write; stopWriteTrace() hands back `caller xN` pairs, most first, and stops. */
export function startWriteTrace(): void { writeTrace = new Map(); }
export function stopWriteTrace(): string {
  const trace = writeTrace; writeTrace = null;
  if (!trace) return "";
  return [...trace].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([at, n]) => `${at}x${n}`).join(",");
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
  const wal=source&&options.bytes!==false?walIndexReader(String(file)):null;
  let auto:AdmissionTicket|null=null;
  let sliceGeneration=0,autoRefused=0;
  let beforeMark:ReturnType<NonNullable<typeof wal>>=null;
  const sqlitePage=Number(prepare("PRAGMA page_size").get()?.page_size??4096);
  const finishGrant=()=>{
    if(!auto)return;
    const ticket=auto;auto=null;sliceGeneration++;
    const state=endBgGrant(), mark=wal?.();
    const frames=mark?Math.max(0,mark.mxFrame-(beforeMark?.salt===mark.salt?beforeMark.mxFrame:0)):null;
    const debt=frames===null?undefined:frames*Math.ceil(sqlitePage/state.pageSize)*state.pageSize;
    budget.settle(ticket,state.usedBytes,{salt:mark?.salt??"unreadable",frame:mark?.mxFrame??Number.MAX_SAFE_INTEGER},debt,state.rawBytes);
    if(state.refusedWrites>autoRefused)throw new BgDeferred(budget.nextAdmissionMs());
  };
  const beforeWrite=(writing:boolean)=>{
    const current=budget.currentSource();
    // The independent notebook timer retains owner scheduling priority and shares BG byte admission.
    if(!writing||!(current?.startsWith("memory-")||current==="owner-notebook"))return;
    budget.assertCurrentSlice();
    if(auto||ioGrantSnapshot().live)return;
    const cap=Math.min(Math.floor(budget.backgroundRoom()/2),1024*1024);
    const ticket=cap>=commitCeiling(1,sqlitePage,ioGrantSnapshot().pageSize)?budget.admit("BG",cap,wal?cap:0):null;
    if(!ticket)throw new BgDeferred(budget.nextAdmissionMs());
    beforeMark=wal?.()??null;
    try{beginBgGrant(ticket);}catch(error){budget.settle(ticket,0);throw error;}
    auto=ticket;autoRefused=ioGrantSnapshot().refusedWrites;
    const gen=++sliceGeneration;
    // A shared connection must never keep a native grant or a transaction across an await.
    queueMicrotask(()=>{
      if(!auto||gen!==sliceGeneration)return;
      try{if(db.isTransaction){exec("ROLLBACK");budget.deferCurrentSlice();}}finally{finishGrant();}
    });
  };
  const afterWrite=(failed?:unknown)=>{
    if(!auto)return;
    if(failed!==undefined&&db.isTransaction)try{exec("ROLLBACK");}catch{/* preserve failure */}
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
    if (writing || /\b(?:CREATE|DROP|ALTER)\b/i.test(sql)) {
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
      afterWrite(failed);
    }
    if (!db.isTransaction) sample(budget.currentSource() ?? (inTransaction ? transactionSource : statementKey(sql)));
  };
  db.exec = instrumentedExec;
  const reuse = new Map<string, StatementSync>();
  let reuseSeen = -1;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    if (reuseDepth > 0) {
      if (reuseSeen !== reuseGeneration) { reuse.clear(); reuseSeen = reuseGeneration; }
      const known = reuse.get(sql);
      if (known) return known;
    }
    const statement = prepare(sql);
    const key = statementKey(sql);
    const tokens = sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    const writes = /\b(?:INSERT|UPDATE|REPLACE|DELETE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b|^\s*BEGIN\b/i.test(tokens);
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
            const changed = method === "run" ? Number((result as { changes: number | bigint }).changes) > 0 : true;
            if (changed) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); }
          }
          if (memoryWork && method === "run" && Number((result as {changes:number|bigint}).changes) > 0) budget.notifyMemoryWork();
          return result;
        } catch (error) { failed = error; throw error; }
        finally {
          // a failed statement that made SQLite abort the whole transaction undid every write in it
          if (failed !== undefined && inTransactionBefore && !db.isTransaction) undid(db);
          // a failed binding write may keep what it changed before it failed (UPDATE OR FAIL): it moves the binding stamp all the same
          if (failed !== undefined && bindingTable) { wrote(db); wroteBindingRows(db); }
          if (undoes && inTransactionBefore) undid(db);
          if (writes && method === "run") countWrite(db);
          const ms = performance.now() - started;
          budget.note(key, ms, true);
          if (lowered) restoreAfterHold(db, exec, sql, ms, failed);
          else if (failed !== undefined && writes && ms > SLOW_SQL_MS) witnessWait(db, sql, ms, failed, budget);
          afterWrite(failed);
        }
      };
      (statement as unknown as Record<string, unknown>)[method] = instrumentedStatement;
    }
    // iterate() runs the statement as its rows are pulled (an UPDATE ... RETURNING writes there): every pull and the end of the iteration
    // move the stamps the statement could move, whether it changed rows or failed
    if (writes || undoes) {
      const iterate = statement.iterate.bind(statement) as (...args: unknown[]) => IterableIterator<unknown>;
      const touched = () => { if (writes) { wrote(db); if (sharedTable) wroteSharedRows(db); if (bindingTable) wroteBindingRows(db); } if (undoes) undid(db); };
      // a pull that made SQLite abort the whole transaction (a schema-level ON CONFLICT ROLLBACK on a row it inserted into another table)
      // undid every write in it, binding rows included: the same abort test as get/all/run, around every pull and the end
      const pulled = <R>(pull: () => R): R => {
        const inTransactionBefore = db.isTransaction;
        beforeWrite(writes);
        try { return pull(); } finally { afterWrite(); touched(); try { if (inTransactionBefore && !db.isTransaction) undid(db); } catch { undid(db); } }
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
    if (reuseDepth > 0 && reuse.size < REUSE_LIMIT) reuse.set(sql, statement);
    return statement;
  };
  return () => { unregister(); wal?.close(); };
}
