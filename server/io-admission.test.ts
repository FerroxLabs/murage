// SPDX-License-Identifier: AGPL-3.0-or-later
// Admission owner: scperf-p1. Native enforcement owner: scperf-p1.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { forgetExclusionAddon } from "./engine-exclusion.ts";
import * as meter from "./io-meter.ts";
import { IoBudget, instrumentDatabase, ioBudget } from "./io-budget.ts";
import { DatabaseSync } from "./sqlite-open.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { checkpointCeiling, commitCeiling, shmCharge } from "./io-meter.ts";
import { indexStepFrames } from "./memory/index-wal.ts";
import { checkpointPassive, startWalMaintenance, stopWalMaintenance, walMaintenanceReady, assertWalWriteAdmission } from "./wal-maintenance.ts";
import { walIndexReader } from "./io-written.ts";
import { installWalBarrier } from "./testing/wal-barrier.ts";
// Every checkpointer this file starts carries the test instrumentation (gate hold); production workers get none.
const barrier = installWalBarrier();

// Missing admission on the pinned base is a behavioural RED, not an import failure.
const api = meter as typeof meter & {
 registerBg(db: DatabaseSync): boolean;
 withBgGrant<T>(ticket: { bytes: number; expiresAt: number }, fn: () => T, db?: DatabaseSync): T;
 ioGrantSnapshot(): { usedBytes: number; refusedWrites: number; ceilingMiss: number; pageSize: number; readBytes: number; chargedBytes: number };
};
const root = mkdtempSync(join(tmpdir(), "admission-fixture-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let serial = 0;
beforeAll(() => {
 const binary = join(root, "meter.node");
 execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
 process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
 forgetExclusionAddon(); meter.resetIoMeterForTest();
});
afterAll(() => {
 if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior;
 forgetExclusionAddon(); meter.resetIoMeterForTest();
 rmSync(root, { recursive: true, force: true });
});
function fixture() {
 const file = join(root, `fixture-${++serial}.db`), db = new DatabaseSync(file);
 db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v BLOB)");
 return { db, file };
}
function grant<T>(fn: () => T, db?: DatabaseSync, bytes = 1024 * 1024) {
 expect(api.withBgGrant, "T3 native grant API exists").toBeTypeOf("function");
 return api.withBgGrant({ bytes, expiresAt: Date.now() + 60_000 }, fn, db);
}
it("T3 registered BG files default-deny before any disk byte; foreground remains writable", () => {
 const { db, file } = fixture();
 try {
  expect(api.registerBg, "T3 BG registration exists").toBeTypeOf("function");
  expect(api.registerBg(db), "T3 registration readback").toBe(true);
  const size = statSync(file + "-wal").size, before = api.ioGrantSnapshot();
  expect(() => db.exec("INSERT INTO t VALUES(zeroblob(8192))"), "T3 ungranted write refused").toThrow();
  expect(statSync(file + "-wal").size, "T3 zero bytes written").toBe(size);
  expect(api.ioGrantSnapshot().refusedWrites - before.refusedWrites, "T3 refusal counted").toBeGreaterThan(0);
  grant(() => db.exec("INSERT INTO t VALUES(1)"), db);
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n).toBe(1);
 } finally { db.close(); }
});
it("T4 cap refusal rolls back an open transaction and keeps the connection usable", () => {
 const { db } = fixture();
 try {
  expect(() => grant(() => db.exec("BEGIN; INSERT INTO t VALUES(zeroblob(65536)); COMMIT"), db, 1), "T4 cap enforced").toThrow(/BG_REFUSED/);
  expect(db.isTransaction, "T4 rollback").toBe(false);
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "T4 no publication").toBe(0);
  db.exec("INSERT INTO t VALUES(1)");
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "T4 connection usable").toBe(1);
 } finally { db.close(); }
});
it("T4 exact cap is inclusive and cap-minus-one refuses", () => {
 const { db } = fixture();
 try {
  grant(() => db.exec("INSERT INTO t VALUES(1)"), db);
  const used = api.ioGrantSnapshot().usedBytes;
  expect(used, "T4 write charged").toBeGreaterThan(0);
  expect(()=>grant(() => db.exec("UPDATE t SET v=2"), db, used),"T4 inclusive exact cap").not.toThrow();
  expect(() => grant(() => db.exec("UPDATE t SET v=3"), db, api.ioGrantSnapshot().usedBytes - 1), "T4 one byte short").toThrow();
 } finally { db.close(); }
});
it("T5 an expired grant writes nothing", () => {
 const { db } = fixture();
 try {
  expect(api.withBgGrant, "T5 grant API").toBeTypeOf("function");
  expect(() => api.withBgGrant({ bytes: 1024 * 1024, expiresAt: Date.now() - 1 }, () => db.exec("INSERT INTO t VALUES(1)"), db), "T5 expiry enforced").toThrow();
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n).toBe(0);
 } finally { db.close(); }
});
it("T16 owner writes succeed outside brackets while BG is saturated", () => {
 const { db } = fixture();
 try {
  grant(() => {}, db, 0);
  const before = api.ioGrantSnapshot().refusedWrites;
  db.exec("INSERT INTO t VALUES(1)");
  expect(api.ioGrantSnapshot().refusedWrites, "T16 owner zero refusals").toBe(before);
 } finally { db.close(); }
});
it("T21 reported bytes retain the raw currency; grants use runtime page spans and reads count", () => {
 const { db } = fixture();
 try {
  const raw = meter.ioMeterSnapshot()!.total;
  grant(() => db.exec("INSERT INTO t VALUES(1)"), db);
  const state = api.ioGrantSnapshot(), delta = meter.ioMeterSnapshot()!.total - raw;
  expect(state.pageSize, "T13 runtime page size").toBeGreaterThanOrEqual(4096);
  expect(state.usedBytes % state.pageSize, "T13 span aligned").toBe(0);
  expect(delta,"T21 reported meter is exact raw bytes").toBe(4120);
  expect(state.usedBytes, "T21 separate currencies").toBeGreaterThan(delta);
  expect(state.readBytes, "SCALE xRead counter").toBeGreaterThan(0);
 } finally { db.close(); }
});
const MiB = 1024 * 1024;
type Admission = { bytes: number; debtBytes: number; expiresAt: number };
function ledger() {
 let now = 0, idle = false;
 const budget = new IoBudget({ read: () => ({ at: now, fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => idle, log: () => {} });
 const b = budget as IoBudget & {
  admit(cls: "BG" | "FGCOPY", ceiling: number, debtBytes?: number): Admission | null;
  settle(ticket: Admission, used: number, mark?: { salt: string; frame: number }): void;
  backfilled(mark: { salt: string; frame: number }): void;
  admissionState(): { bg: number; debt: number; total: number; reserved: number };
 };
 expect(b.admit, "ledger admission API").toBeTypeOf("function");
 return { b, at: (n: number) => { now = n; }, idle: (v: boolean) => { idle = v; } };
}
it("T1 requested work cannot bypass a full admission ledger", () => {
 const { b } = ledger();
 const ticket = b.admit("BG", 12 * MiB)!;
 expect(ticket).not.toBeNull(); b.settle(ticket, 12 * MiB);
 expect(b.admit("BG", 1), "T1 pending before claim").toBeNull();
});
it("T19 A2 reserve write plus new debt before admission", () => {
 const { b } = ledger();
 expect(b.admit("BG", 8 * MiB, 8 * MiB), "A2 double reservation").toBeNull();
});
it.each([0, 60_000])("T19 A2 backfill at %i transfers debt into bg atomically", when => {
 const { b, at } = ledger();
 const ticket = b.admit("BG", 5 * MiB, 5 * MiB)!;
 expect(ticket).not.toBeNull(); b.settle(ticket, 5 * MiB, { salt: "fixture", frame: 7 });
 expect(b.admissionState().debt, "T19 debt retained").toBe(5 * MiB);
 at(when); b.backfilled({ salt: "fixture", frame: 7 });
 const state = b.admissionState();
 expect(state.debt, "A2 debt transferred").toBe(0);
 expect(state.bg, "A2 copy charged before release").toBe(when ? 5 * MiB : 10 * MiB);
 expect(b.admit("BG", (when ? 7 : 2) * MiB + 1), "A2 per-minute bound").toBeNull();
});
it("T6 FGCOPY is never refused active, idle needs whole fit at execution", () => {
 const { b, idle, at } = ledger();
 const ticket = b.admit("BG", 12 * MiB)!; b.settle(ticket, 12 * MiB);
 const open = b.admit("FGCOPY", 50 * MiB);
 expect(open, "T17 active foreground copy").not.toBeNull();
 // D6: a reservation is live work and is not dropped by the minute flip; the copy ends (settles) before the idle minute starts.
 b.settle(open!, 0);
 idle(true); at(60_000);
 expect(b.admit("FGCOPY", MiB), "T6 oversized idle whole copy waits").toBeNull();
 expect(b.admit("FGCOPY", MiB - 65536), "T6 idle whole fit").not.toBeNull();
 expect(b.admit("BG", 1), "T6 idle no BG").toBeNull();
 idle(false); at(120_000);
 expect(b.admit("FGCOPY", 50 * MiB), "T6 resumes active").not.toBeNull();
});
it("T16 A1 async memory pass auto-admits each synchronous statement", async () => {
 const { b } = ledger(), { db } = fixture();
 instrumentDatabase(db, b);
 try {
  await b.withSource("memory-idle", async () => {
   db.exec("INSERT INTO t VALUES(1)"); await Promise.resolve();
   db.prepare("INSERT INTO t VALUES(2)").run(); await Promise.resolve();
   db.exec("INSERT INTO t VALUES(3)");
  });
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "A1 async all writes succeed").toBe(3);
  expect(b.admissionState().bg, "A1 all bytes charged").toBeGreaterThan(0);
 } finally { db.close(); }
});
it("T16 A1 full ledger defers before stepping; owner write still works", () => {
 const { b } = ledger(), { db } = fixture(); instrumentDatabase(db, b);
 try {
  const ticket = b.admit("BG", 12 * MiB)!; b.settle(ticket, 12 * MiB);
  expect(() => b.withSource("memory-idle", () => db.exec("INSERT INTO t VALUES(1)")), "A1 no auto-grant without Admit").toThrow(/BG_DEFERRED/);
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "A1 refused before step").toBe(0);
  expect(()=>db.exec("INSERT INTO t VALUES(2)"),"T16 saturated ledger owner write succeeds").not.toThrow();
 } finally { db.close(); }
});

it("T13 page spans plus shm bound real Linux write_bytes", () => {
 const { db } = fixture();
 const written = () => Number(/^write_bytes: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))![1]);
 try {
  const before = written(), charged = api.ioGrantSnapshot().chargedBytes;
  grant(() => db.exec("INSERT INTO t VALUES(zeroblob(1048576))"), db, 8 * MiB);
  expect(api.ioGrantSnapshot().chargedBytes - charged, "T13 real OS upper bound").toBeGreaterThanOrEqual(written() - before);
 } finally { db.close(); }
});
it.each([4096,16384,65536])("T4c A3 A4 step plus owed copy fits with OS page %i", osPage => {
 const n = indexStepFrames(4096, osPage);
 expect(n, "A4 nonzero runtime step").toBeGreaterThan(0);
 expect(checkpointCeiling(1,4096,osPage),"A4 whole checkpoint ceiling includes OS span and shm").toBe(2*osPage+4096);
 const price = (frames: number) => commitCeiling(frames, 4096, osPage) + checkpointCeiling(frames, 4096, osPage) + 4 * osPage;
 expect(price(n), "A3 step plus owed PASSIVE and server room").toBeLessThanOrEqual(11 * MiB);
 expect(price(n + 1), "A4 maximum derived frame count").toBeGreaterThan(11 * MiB);
 expect(commitCeiling(1,4096,osPage), "A4 OS page currency").toBe(4 * osPage + 2 * osPage + shmCharge(1));
});
it.each(["W", "split merge"])("T4c %s at maximum derived size has zero refusals and ceiling misses", kind => {
 const { db } = fixture();
 try {
  const n = indexStepFrames(), ceiling = commitCeiling(n), before = api.ioGrantSnapshot();
  // Include a real FTS merge with a maximum-size transaction in the merge fixture.
  if (kind === "split merge") db.exec("CREATE VIRTUAL TABLE words USING fts5(text); INSERT INTO words VALUES('fixture alpha')");
  grant(() => {
   db.exec("BEGIN IMMEDIATE");
   db.prepare("INSERT INTO t VALUES(?)").run(Buffer.alloc((n - 12) * 4096, 7));
   if (kind === "split merge") db.exec("INSERT INTO words(words,rank) VALUES('merge',1)");
   db.exec("COMMIT");
  }, db, ceiling);
  const state = api.ioGrantSnapshot();
  expect(state.usedBytes, "T4c charge within commit ceiling").toBeLessThanOrEqual(ceiling);
  expect(state.refusedWrites, "T4c no refused writes").toBe(before.refusedWrites);
  expect(state.ceilingMiss, "T4c no ceiling miss").toBe(before.ceilingMiss);
  grant(() => db.exec("PRAGMA wal_checkpoint(PASSIVE)"), db, checkpointCeiling(n + 16));
  expect(api.ioGrantSnapshot().usedBytes, "T4c whole checkpoint within ceiling").toBeLessThanOrEqual(checkpointCeiling(n + 16));
  expect(api.ioGrantSnapshot().ceilingMiss, "T4c checkpoint no ceiling miss").toBe(before.ceilingMiss);
 } finally { db.close(); }
});
it("T4c old raw-frame ceiling is refused on a real file", () => {
 const { db } = fixture();
 try {
  const n = indexStepFrames();
  expect(() => grant(() => db.exec(`INSERT INTO t VALUES(zeroblob(${(n - 12) * 4096}))`), db, n * (4096 + 24)), "T4c raw currency mutant refused").toThrow(/BG_REFUSED/);
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "T4c refused publication rolled back").toBe(0);
 } finally { db.close(); }
});
it("T16 A1 a background transaction cannot span an await on the shared connection", async () => {
 const { b } = ledger(), { db } = fixture(); const release = instrumentDatabase(db, b);
 try {
  await expect(b.withSource("memory-idle", async () => {
   db.exec("BEGIN; INSERT INTO t VALUES(1)"); await Promise.resolve();
   db.exec("COMMIT");
  }), "A1 spanning transaction reported as deferral").rejects.toThrow(/BG_DEFERRED/);
  expect(db.isTransaction, "A1 grant ended at synchronous boundary").toBe(false);
  expect(db.prepare("SELECT count(*) n FROM t").get()?.n, "A1 spanning transaction rolled back").toBe(0);
  db.exec("INSERT INTO t VALUES(2)");
 } finally { db.close(); release(); }
});
it("T6 checkpoint admission is checked after dispatch on the WM thread", async () => {
 const { db, file } = fixture(), read = walIndexReader(file);
 try {
  db.exec("INSERT INTO t VALUES(zeroblob(2097152))");
  startWalMaintenance(file, {setAutocheckpoint: n => db.exec(`PRAGMA wal_autocheckpoint=${n}`), nudge: async () => false});
  barrier.holdGate(true);
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true));
  const before = read()!;
  const requested = checkpointPassive();
  ioBudget.setIsIdle(() => true);
  barrier.holdGate(false);
  const refused = await requested;
  expect(refused.checkpointed, "T6 oversized idle copy never runs partially").toBe(-1);
  expect(read()!.nBackfill, "T6 no backfill after idle flip").toBe(before.nBackfill);
  ioBudget.setIsIdle(() => false);
  const resumed = await checkpointPassive();
  expect(resumed.checkpointed, "T6 next active admission drains").toBe(resumed.log);
 } finally { ioBudget.setIsIdle(() => false); await stopWalMaintenance(); db.close(); read.close(); }
});
it("T6 shared execution ledger admits a whole small idle copy, with an atomic reservation", () => {
 const { b, idle } = ledger();idle(true);
 const shared = checkpointLedger(b.checkpointAdmissionBuffer());
 const ticket = shared.beginCopy(512 * 1024, 0);
 expect(ticket, "T6 small whole idle copy").not.toBeNull();
 expect(shared.beginCopy(512 * 1024, 0), "T6 simultaneous copy reservation").toBeNull();
 shared.endCopy(ticket!, 512 * 1024);
 expect(b.admissionState().total, "T6 copy charged at execution").toBe(512 * 1024);
});

it("T13 includes the exact shm region formula in a single-frame grant",()=>{
 const {db,file}=fixture();
 try{
  const offset=statSync(file+"-wal").size,p=api.ioGrantSnapshot().pageSize;
  const span=(off:number,n:number)=>(Math.ceil((off+n)/p)-Math.floor(off/p))*p;
  grant(()=>db.exec("INSERT INTO t VALUES(1)"),db);
  expect(api.ioGrantSnapshot().usedBytes,"T13 WAL header, payload and shm have one currency").toBe(span(offset,24)+span(offset+24,4096)+shmCharge(1));
 }finally{db.close();}
});
it("A4 native grant page size comes from runtime sysconf",()=>{
 const shim=join(root,"page-size.c"),binary=join(root,"page-size.node");
 writeFileSync(shim,'#include <unistd.h>\n#undef sysconf\nextern long sysconf(int);\nlong murage_fixture_sysconf(int name){return name==_SC_PAGESIZE?16384:sysconf(name);}\n');
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-Dsysconf=murage_fixture_sysconf","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c",shim,"-o",binary],{stdio:"pipe"});
 const entry=pathToFileURL(resolve("server/io-meter.ts")).href;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`import {ioGrantSnapshot} from ${JSON.stringify(entry)};console.log(ioGrantSnapshot().pageSize);`],{env:{...process.env,MURAGE_ENGINE_EXCLUSION_PATH:binary},encoding:"utf8"});
 expect(Number(output.trim()),"A4 native page size is supplied by OS initialization").toBe(16384);
});
it("T17 ten active foreground minutes cannot refuse a whole FGCOPY",()=>{
 let at=0,writes=0;
 const b=new IoBudget({read:()=>({at,fsWriteBlocks:writes/512,cpuMicros:0}),log:()=>{}});
 for(let n=0;n<10;n++){
  at=n*60000;
  const bg=b.admit("BG",12*MiB)!;expect(bg,"T17 active ledger fixture").not.toBeNull();b.settle(bg,12*MiB);
  writes+=50*MiB;
  const copy=b.admit("FGCOPY",50*MiB);
  expect(copy,"T17 foreground copy never uses BG refusal").not.toBeNull();b.settle(copy!,50*MiB);
 }
});

it("T17 real foreground WAL drains for ten 50 MiB active minutes with a full BG ledger",()=>{
 const {db,file}=fixture(),read=walIndexReader(file);
 let at=0;const b=new IoBudget({read:()=>({at,fsWriteBlocks:0,cpuMicros:0}),log:()=>{}});
 try{
  db.exec("PRAGMA journal_size_limit=0");
  for(let minute=0;minute<10;minute++){
   at=minute*60000;const full=b.admit("BG",12*MiB)!;expect(full).not.toBeNull();b.settle(full,full.bytes);
   db.exec("DELETE FROM t; INSERT INTO t VALUES(zeroblob(52428800))");
   const h=read()!,ceil=checkpointCeiling(h.mxFrame-h.nBackfill);
   let row:Record<string,unknown>|undefined;
   grant(()=>{row=b.foregroundCopy(ceil,()=>db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get());
    expect(api.ioGrantSnapshot().usedBytes,"T17 FGCOPY never spends caller BG cap").toBe(0);
   },db,0);
   expect(row,"T17 full BG ledger never refuses active copy").toBeDefined();
   expect(Number(row!.checkpointed),"T17 whole active copy drains").toBe(Number(row!.log));
   expect(()=>assertWalWriteAdmission(file),"T17 owner WAL admission stays open").not.toThrow();
   expect(statSync(file+"-wal").size,"T17 WAL bounded over ten minutes").toBeLessThan(150*MiB);
  }
 }finally{db.close();read.close();}
},120000);

it("T19 outstanding D remains part of every admission",()=>{
 const {b}=ledger();const t=b.admit("BG",5*MiB,5*MiB)!;b.settle(t,5*MiB,{salt:"fixture",frame:9});
 expect(b.admit("BG",2*MiB+1),"T19 live debt cannot be spent again").toBeNull();
});
it("T17 WM shared ledger never classifies active copy as BG",()=>{
 const {b}=ledger();const t=b.admit("BG",12*MiB)!;b.settle(t,t.bytes);
 const shared=checkpointLedger(b.checkpointAdmissionBuffer());
 expect(shared.beginCopy(50*MiB,0),"T17 WM ignores full BG ledger for active FGCOPY").not.toBeNull();
});

it.each([8,9,10])("A3 a %i MiB remaining permit derives the largest whole write plus copy",roomMiB=>{
 const room=roomMiB*1024*1024,n=indexStepFrames(4096,4096,room);
 const price=(frames:number)=>commitCeiling(frames,4096,4096)+checkpointCeiling(frames,4096,4096)+4*4096;
 expect(n,"A3 remaining permit allows progress").toBeGreaterThan(0);
 expect(price(n),"A3 dynamic step and copy fit remaining room").toBeLessThanOrEqual(room);
 expect(price(n+1),"A3 dynamic derived step is maximal").toBeGreaterThan(room);
});
