// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync, fstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { IO_BUDGET_BYTES_PER_MINUTE, IO_BUDGET_CALM_MINUTES, IO_BUDGET_IDLE_BYTES_PER_MINUTE, IO_BUDGET_MAX_SCALE, IoBudget, instrumentDatabase, walFrameReader, type IoReading } from "./io-budget.ts";

const MINUTE = 60_000;
/** 1 MB written per minute = 2048 blocks of 512 bytes. */
const MB = 2048;

function rig(options: Partial<ConstructorParameters<typeof IoBudget>[0]> = {}) {
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
  const lines: string[] = [], scales: number[] = [];
  const budget = new IoBudget({ read: () => reading, log: line => lines.push(line), onScale: scale => scales.push(scale), ...options });
  const minute = (writeMb: number, cpu: number) => {
    reading = { at: reading.at + MINUTE, fsWriteBlocks: reading.fsWriteBlocks + writeMb * MB, cpuMicros: reading.cpuMicros + cpu * MINUTE * 1000 };
    return budget.tick();
  };
  budget.tick();
  return { budget, lines, scales, minute };
}

describe("io-budget", () => {
  it("stays quiet while the process is calm", () => {
    const { lines, scales, minute, budget } = rig();
    for (let i = 0; i < 30; i++) expect(minute(5, 0.1)?.tripped).toBe(false);
    expect(lines).toEqual([]); expect(scales).toEqual([]); expect(budget.pollScale()).toBe(1);
  });

  it("logs the top statements and halves the poll rate above 50 MB a minute", () => {
    const { lines, scales, minute, budget } = rig();
    budget.note("SELECT cheap", 1);
    budget.note("WITH raw AS (  SELECT m.rowid\n FROM messages m)", 400);
    budget.note("WITH raw AS (  SELECT m.rowid\n FROM messages m)", 300);
    expect(minute(60, 0.1)?.tripped).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[io-budget\] writing 60\.0 MB\/min/);
    expect(lines[0]).toContain("700ms x2 WITH raw AS ( SELECT m.rowid FROM messages m)");
    expect(scales).toEqual([2]); expect(budget.pollScale()).toBe(2);
    minute(60, 0.1); minute(60, 0.1); minute(60, 0.1); minute(60, 0.1);
    expect(budget.pollScale()).toBe(IO_BUDGET_MAX_SCALE);
  });

  it("trips on 80 percent cpu only after three minutes in a row", () => {
    const { lines, minute, budget } = rig();
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.2)?.tripped).toBe(false); // a calm minute resets the run
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(false);
    expect(minute(1, 0.95)?.tripped).toBe(true);
    expect(lines[0]).toMatch(/cpu 95% for 3 min/); expect(budget.pollScale()).toBe(2);
  });

  it("backs the poll rate off again after ten calm minutes", () => {
    const { scales, minute, budget } = rig();
    minute(60, 0.1); expect(budget.pollScale()).toBe(2);
    for (let i = 0; i < 9; i++) minute(1, 0.1);
    expect(budget.pollScale()).toBe(2);
    minute(1, 0.1); expect(budget.pollScale()).toBe(1);
    expect(scales).toEqual([2, 1]);
  });

  it("never throws into the app, whatever the sampler or a listener does", () => {
    const budget = new IoBudget({ read: () => { throw new Error("no usage"); } });
    expect(budget.tick()).toBeNull();
    const { minute } = rig({ onScale: () => { throw new Error("listener broke"); } });
    expect(() => minute(60, 0.1)).not.toThrow();
  });

  it.each([0,4])("accounts for a 4 MiB append with an OS reading of %s MiB",osMb=>{
    const root=mkdtempSync(join(tmpdir(),"murage-io-budget-")),path=join(root,"child-index.db-wal");
    try{
      appendFileSync(path,Buffer.alloc(0));
      const {budget,minute}=rig();
      const unregister=budget.registerByteSource("memory-worker",()=>statSync(path).size);
      appendFileSync(path,Buffer.alloc(4*1024*1024));
      expect(budget.sampleBytes()).toBe(4*1024*1024);
      budget.sampleBytes();
      const verdict=minute(osMb,0)!;
      expect(verdict.writeBytesPerMinute).toBeGreaterThanOrEqual(4*1024*1024*0.9);
      expect(verdict.writeBytesPerMinute).toBeLessThanOrEqual(4*1024*1024*1.1);
      expect(minute(0,0)?.writeBytesPerMinute).toBe(0);
      unregister();
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  it.each([0,4])("measures instrumented WAL growth with an OS reading of %s MiB",osMb=>{
    const root=mkdtempSync(join(tmpdir(),"murage-io-wal-")),path=join(root,"fixture.db");
    const db=new DatabaseSync(path);
    try{
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE data(value BLOB)");
      const {budget,minute}=rig();instrumentDatabase(db,budget);
      const before=statSync(path+"-wal").size;
      budget.withSource("notebook-sync",()=>db.prepare("INSERT INTO data VALUES(?)").run(Buffer.alloc(4*1024*1024)));
      const delta=statSync(path+"-wal").size-before;
      expect(delta).toBeGreaterThanOrEqual(4*1024*1024);
      expect(delta).toBeLessThanOrEqual(4*1024*1024*1.1);
      expect(budget.sampleBytes()).toBe(delta);
      expect(minute(osMb,0)?.writeBytesPerMinute).toBe(delta);
      budget.noteBytes("explicit",1234);expect(minute(0,0)?.writeBytesPerMinute).toBe(1234);
    }finally{db.close();rmSync(root,{recursive:true,force:true});}
  });

  it("names the largest byte source and defers it through a decaying backoff",()=>{
    const {budget,minute}=rig({bytesPerMinute:1024});
    budget.noteBytes("notebook-sync",4096);budget.noteBytes("owner-turn",512);
    expect(minute(0,0)).toMatchObject({tripped:true,source:"notebook-sync"});
    expect(budget.shouldDefer("notebook-sync")).toBe(true);
    expect(budget.shouldDefer("owner-turn")).toBe(false);
    budget.noteBytes("notebook-sync",4096);minute(0,0);expect(budget.pollScale()).toBe(4);
    for(let n=0;n<IO_BUDGET_CALM_MINUTES;n++)minute(0,0);
    expect(budget.pollScale()).toBe(2);
    for(let n=0;n<IO_BUDGET_CALM_MINUTES;n++)minute(0,0);
    expect(budget.pollScale()).toBe(1);expect(budget.shouldDefer("notebook-sync")).toBe(false);
  });

  it("uses the idle budget only while the caller reports idle",()=>{
    let idle=false;
    const {budget,minute}=rig({isIdle:()=>idle});
    expect(IO_BUDGET_IDLE_BYTES_PER_MINUTE).toBe(1024*1024);
    expect(IO_BUDGET_IDLE_BYTES_PER_MINUTE).toBeLessThan(IO_BUDGET_BYTES_PER_MINUTE);
    budget.noteBytes("notebook-sync",2*1024*1024);expect(minute(0,0)?.tripped).toBe(false);
    idle=true;budget.noteBytes("notebook-sync",2*1024*1024);expect(minute(0,0)?.tripped).toBe(true);
  });

  it("notifies only completed queue writes, including prepared statements reused after registration",()=>{
    const db=new DatabaseSync(":memory:"),budget=new IoBudget(),notify=vi.fn();
    try{
      db.exec("CREATE TABLE memory_jobs(id INTEGER PRIMARY KEY); CREATE TABLE memory_projection_receipts(id INTEGER PRIMARY KEY); CREATE TABLE memory_scope_bindings(id INTEGER PRIMARY KEY)");
      instrumentDatabase(db,budget);
      const insert=db.prepare('/* queue */ INSERT OR IGNORE INTO "memory_jobs" VALUES(?)');
      budget.setOnMemoryWork(notify);
      insert.run(1);expect(notify).toHaveBeenCalledTimes(1);
      insert.run(1);expect(notify).toHaveBeenCalledTimes(1);
      db.prepare("SELECT * FROM memory_jobs").all();expect(notify).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE memory_jobs SET id=2 WHERE id=1").run();
      db.prepare("REPLACE INTO memory_projection_receipts VALUES(1)").run();
      expect(notify).toHaveBeenCalledTimes(3);
      // Idle lanes (reviews, reveals, consolidation, evolution) queue through scope bindings.
      db.prepare("INSERT INTO memory_scope_bindings VALUES(1)").run();expect(notify).toHaveBeenCalledTimes(4);
      expect(()=>db.prepare("INSERT INTO memory_jobs VALUES(2)").run()).toThrow();
      expect(notify).toHaveBeenCalledTimes(4);
    }finally{db.close();}
  });

  it("keeps counting WAL writes after a checkpoint rewinds the WAL in place",()=>{
    const root=mkdtempSync(join(tmpdir(),"murage-io-walreuse-")),path=join(root,"fixture.db");
    const db=new DatabaseSync(path);
    try{
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE data(value BLOB)");
      const {budget,minute}=rig();instrumentDatabase(db,budget);
      db.prepare("INSERT INTO data VALUES(?)").run(Buffer.alloc(4*1024*1024));
      minute(0,0);
      db.exec("PRAGMA wal_checkpoint(RESTART)");
      const size=statSync(path+"-wal").size;
      budget.withSource("notebook-sync",()=>db.prepare("UPDATE data SET value=?").run(Buffer.alloc(4*1024*1024,1)));
      // The WAL file did not grow: the second 4 MiB went into reused frames.
      expect(statSync(path+"-wal").size).toBeLessThanOrEqual(size*1.01);
      const seen=minute(0,0)!.writeBytesPerMinute;
      expect(seen).toBeGreaterThanOrEqual(4*1024*1024*0.9);
      expect(seen).toBeLessThanOrEqual(4*1024*1024*1.1);
    }finally{db.close();rmSync(root,{recursive:true,force:true});}
  });

  it("closes the -shm descriptor on unregister and holds a fresh one after re-instrumentation",()=>{
    const root=mkdtempSync(join(tmpdir(),"murage-io-fdleak-")),path=join(root,"fixture.db");
    const open=(fd:number|undefined)=>{if(fd===undefined)return false;try{fstatSync(fd);return true;}catch{return false;}};
    const openFds=()=>{let n=0;for(let fd=3;fd<1024;fd++)if(open(fd))n++;return n;};
    const first=new DatabaseSync(path);let second:DatabaseSync|undefined;
    try{
      first.exec("PRAGMA journal_mode=WAL; CREATE TABLE data(value BLOB)");
      const budget=new IoBudget();
      // The unregister closure releases the reader's descriptor; calling it twice is harmless; no reopen afterwards.
      const reader=walFrameReader(path);reader();
      const fd=reader.fd();expect(open(fd)).toBe(true);
      const unregister=budget.registerByteSource("database:"+path,reader);
      unregister();unregister();
      expect(open(fd)).toBe(false);expect(reader.fd()).toBeUndefined();
      expect(()=>reader()).not.toThrow();expect(reader.fd()).toBeUndefined();
      // instrumentDatabase hands back the release: closing it frees exactly the one held shm descriptor.
      const release1=instrumentDatabase(first,budget);
      first.prepare("INSERT INTO data VALUES(?)").run(Buffer.alloc(10));
      first.close();
      const held=openFds();
      release1();release1();
      expect(openFds()).toBe(held-1);
      // Re-instrumenting the same path opens a fresh descriptor, and releasing it leaks nothing.
      second=new DatabaseSync(path);
      const base=openFds();
      const release2=instrumentDatabase(second,budget);
      second.exec("INSERT INTO data VALUES(x'00')");
      release2();release2();
      second.close();
      expect(openFds()).toBeLessThanOrEqual(base-1);
    }finally{try{second?.close();}catch{/* closed */}try{first.close();}catch{/* closed */}rmSync(root,{recursive:true,force:true});}
  });
});

describe("io-budget statement trace", () => {
  const withTrace = <T>(value: string | undefined, run: () => T): T => {
    const saved = process.env.MURAGE_TURN_TRACE;
    if (value === undefined) delete process.env.MURAGE_TURN_TRACE; else process.env.MURAGE_TURN_TRACE = value;
    try { return run(); } finally { if (saved === undefined) delete process.env.MURAGE_TURN_TRACE; else process.env.MURAGE_TURN_TRACE = saved; }
  };
  it("logs the five costliest statements of the minute, shortened, literals stripped, and nothing when tracing is off", () => {
    const budget = new IoBudget({ read: () => ({ at: 0, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {} });
    for (let i = 0; i < 7; i++) budget.note(`SELECT * FROM memory_jobs WHERE status='complete' AND source_id='secret-${i}' AND x>${i}00 /* padding padding padding padding padding */`.replace("memory_jobs", `t${i}`), 10 * (i + 1));
    const off: string[] = [];
    withTrace(undefined, () => budget.traceTopStatements(line => off.push(line)));
    expect(off).toEqual([]);
    const lines: string[] = [];
    withTrace("1", () => budget.traceTopStatements(line => lines.push(line)));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("rank=1 ms=70 calls=1");
    for (const line of lines) {
      expect(line).not.toMatch(/secret|complete/);
      expect(line.match(/sql="([^"]*)"/)![1].length).toBeLessThanOrEqual(80);
    }
    // the next minute reports only that minute's cost
    budget.note("SELECT 1 FROM only_now", 3);
    const next: string[] = [];
    withTrace("1", () => budget.traceTopStatements(line => next.push(line)));
    expect(next).toHaveLength(1);
    expect(next[0]).toContain("only_now");
  });
});
