// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, closeDatabase, transaction } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { withRetryReservation } from "../testing/retry-reservation.ts";
import { captureMemoryUsage, createInferenceSlot, withMemoryInferenceLease, clearUnseenExcess, groundMemoryClaim, journalMemoryRetry, reconcileDeadRetries, reserveExtraction, unseenExcessCalls, reportMemoryUsage, type TextOnlyExtractor } from "./extract.ts";
import { learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { learningCeilingStatus } from "./settings.ts";
import { maintainPip, type ReflectDeps } from "./pip-reflect.ts";
import { sumUsageReports } from "../drivers/headless-text-only.ts";
import { headlessUsageReport } from "./pip-transport.ts";

let other:DatabaseSync;
const messages=[{role:"user",content:"fixture"}];
const monthId=()=>learningSpendLedgerId(learningSpendMonth());
const read=(id=monthId())=>JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
const put=(id:string,row:unknown,kind="learning-spend")=>database().prepare("INSERT INTO memory_scope_bindings VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id,kind,JSON.stringify(row));
const reconcile=(id=monthId())=>transaction(db=>{const row=JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));reconcileDeadRetries(db,row);db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(row),id);});
function seed(usage:Record<string,number>={prompt_tokens:9000,completion_tokens:5000},opts:{id?:string;day?:string;estimated?:true;open?:number}={}){
  const id=opts.id??monthId(),day=opts.day??"extract-budget:2026-01-31";
  put(day,{input:100,output:50},"extract-budget");
  put(id,{input:100,output:50,open:{dead:opts.open??1},retryRecords:{r:{boot:"dead",ledgerId:day,tokens:{input:100,output:50},usage,...(opts.estimated?{estimated:true}:{})}}});
  return {id,day};
}
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  reserveExtraction(messages,1).settle({prompt_tokens:0,completion_tokens:0});
  database().exec("DELETE FROM memory_scope_bindings WHERE subject_id IN ('learning-spend','extract-budget','continuity-budget')");
  updateMemoryLearning(database(),{callsPerMinute:60},readMemoryLearning(database()).revision);
  other=new DatabaseSync(join(DATA_DIR,"messages.db"));
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();other.close();});

it("1, 3: dead complete evidence charges both ledgers once and leaves one unseen",()=>{
  const {day}=seed();reconcile();const settled=read();
  expect(settled).toMatchObject({input:9000,output:5000,unmetered:1,retryRecords:{}});
  expect(read(day)).toEqual({input:9000,output:5000});
  expect(unseenExcessCalls(settled)).toEqual({inFlight:0,settled:1});
  reconcile();expect(read()).toEqual(settled);
});
it.each<Record<string,number>>([{prompt_tokens:9000},{}])("2, 13: incomplete first usage %j leaves the first unseen too",usage=>{
  seed(usage);reconcile();expect(read().open).toEqual({dead:1});
  expect(read().input).toBe(usage.prompt_tokens??100);expect(read().output).toBe(50);
  expect(unseenExcessCalls(read()).settled).toBe(2);
});
it("4, 11: independent reader (no spawn) sees committed evidence and this boot is untouched",async()=>{
  await withRetryReservation(async()=>{
    expect(journalMemoryRetry({prompt_tokens:9,completion_tokens:4})).toBe(true);
    // Real spawn windows: headless-text-only.retry-ledger.test.ts tests 4 and 5 (original lines 72, 166).
    const readCommitted=()=>{const before=read();expect(Object.values(before.retryRecords)).toHaveLength(1);reconcile();expect(read()).toEqual(before);};
    readCommitted();reportMemoryUsage({prompt_tokens:9,completion_tokens:4,extraUnseen:0});
  });
  expect(read()).toMatchObject({input:9,output:4,retryRecords:{}});
});
it("5: hand-written UPDATE rollback preserves the already committed journal",async()=>{
  await withRetryReservation(async()=>{
    expect(journalMemoryRetry({prompt_tokens:9000,completion_tokens:5000})).toBe(true);
    const committed=read();
    expect(Object.values(committed.retryRecords)).toHaveLength(1);
    expect(Object.values(committed.retryRecords)[0]).toMatchObject({usage:{prompt_tokens:9000,completion_tokens:5000}});
    expect(()=>transaction(db=>{
      // Stand-in for the release transaction, after the independent journal commit.
      db.prepare("UPDATE memory_scope_bindings SET intent='{}' WHERE id=?").run(monthId());
      expect(read()).toEqual(committed);
      throw new Error("release rollback");
    })).toThrow("release rollback");
    expect(read()).toEqual(committed);
    reportMemoryUsage({prompt_tokens:9000,completion_tokens:5000,extraUnseen:0});
  });
  expect(read()).toMatchObject({input:9000,output:5000,retryRecords:{}});
});
it("crash table: during reconciliation rolls back day, month and record deletion together",()=>{
  const {day}=seed();
  const beforeDay=read(day),beforeMonth=read();
  // Fail the caller's month write after the helper wrote the day and deleted its record.
  database().exec("CREATE TRIGGER fail_reconcile AFTER UPDATE ON memory_scope_bindings WHEN new.subject_id='learning-spend' BEGIN SELECT RAISE(ABORT,'reconciliation crash'); END");
  expect(()=>reconcile()).toThrow("reconciliation crash");
  expect(read(day)).toEqual(beforeDay);expect(read()).toEqual(beforeMonth);
  database().exec("DROP TRIGGER fail_reconcile");
  reconcile();
  expect(read(day)).toEqual({input:9000,output:5000});
  expect(read()).toMatchObject({input:9000,output:5000,unmetered:1,retryRecords:{}});
  const settled=read();reconcile();expect(read()).toEqual(settled);expect(read(day)).toEqual({input:9000,output:5000});
});
it("BUILD-FIX 5: a single lease ignores a different duplicate report without closing another reservation",async()=>{
  const otherLease=reserveExtraction(messages,3000,undefined,"continuity",{botId:"fixture",family:"lived"});
  expect(otherLease.reserved).toBe(true);
  const extractor:TextOnlyExtractor=async()=>{
    reportMemoryUsage({prompt_tokens:91,completion_tokens:47,estimatedRuns:1,engineRun:true});
    const first=read();
    expect(first).toMatchObject({input:otherLease.handle.tokens.input+91,output:otherLease.handle.tokens.output+47,estimatedRuns:1});
    expect(Object.values(first.open)).toEqual([1]);
    const firstDay=read(otherLease.handle.ledgerId);
    reportMemoryUsage({prompt_tokens:901,completion_tokens:407,estimatedRuns:2,engineRun:true});
    expect(read()).toEqual(first);expect(read(otherLease.handle.ledgerId)).toEqual(firstDay);
    return "[]";
  };
  await withMemoryInferenceLease(async lease=>{
    const result=await lease.request(extractor,"fixture",3000,new AbortController().signal,messages,"continuity",{botId:"fixture",family:"lived"},openLearningGate("continuity"));
    expect(result.status).not.toBe("notStarted");
  },undefined,createInferenceSlot());
  expect(Object.values(read().open)).toEqual([1]);
  otherLease.settle({prompt_tokens:0,completion_tokens:0,unsent:true});
  expect(read()).toMatchObject({input:91,output:47,estimatedRuns:1});expect(read().open).toBeUndefined();
});
it("6, 16: a deferred settlement and cleared transport leave recovery independent",async()=>{
  vi.useFakeTimers();
  const lease=reserveExtraction(messages,2000), before=read();
  const boot=Object.keys(before.open)[0];
  before.retryRecords={[lease.handle.id!]:{boot,ledgerId:lease.handle.ledgerId,tokens:lease.handle.tokens,usage:{prompt_tokens:9000,completion_tokens:5000}}};put(monthId(),before);
  other.exec("BEGIN IMMEDIATE");lease.settle({prompt_tokens:9010,completion_tokens:5010,extraUnseen:0});
  expect(read().retryRecords[lease.handle.id!]).toBeDefined();
  // A crash loses the timer and all reflection transport state, but keeps the ledger.
  vi.clearAllTimers();other.exec("ROLLBACK");closeDatabase();database();
  const dead=read();dead.retryRecords[lease.handle.id!].boot="dead";dead.open={dead:1};put(monthId(),dead);
  reconcile();expect(read()).toMatchObject({input:9000,output:5000,unmetered:1,retryRecords:{}});
});
it("8: original day and month receive recovery, next month stays untouched; missing day is allowed",()=>{
  const previous=learningSpendLedgerId("2025-12");seed(undefined,{id:previous});put(monthId(),{input:3,output:2});
  database().prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("extract-budget:2026-01-31");
  reconcile(previous);expect(read(previous)).toMatchObject({input:9000,output:5000,unmetered:1});expect(read()).toEqual({input:3,output:2});
});
it("9: admission uses recovered excess and never writes its earlier snapshot back",()=>{
  seed();updateMemoryLearning(database(),{ceiling:{input:8000,output:8000}},readMemoryLearning(database()).revision);
  expect(reserveExtraction(messages,1).reserved).toBe("spend-ceiling");expect(read().input).toBe(9000);expect(read().retryRecords).toEqual({});
});
it("9: admission uses the reconciled unseen count",()=>{
  seed({});expect(reserveExtraction(messages,1,undefined,"continuity",{botId:"b",family:"lived"}).reserved).toBe("unseen-calls");expect(read().unmetered).toBe(1);
});
it.each([false,true])("10, 19: unused second call counts high and a raise clears it (estimated=%s)",estimated=>{
  const usage=estimated?headlessUsageReport(undefined,true,35000,17500,20):{prompt_tokens:9000,completion_tokens:5000};
  seed({prompt_tokens:usage.prompt_tokens!,completion_tokens:usage.completion_tokens!},{estimated:estimated?true:undefined});reconcile();
  expect(read().input).toBe(Math.max(100,usage.prompt_tokens!));expect(read().output).toBe(Math.max(50,usage.completion_tokens!));
  expect(read().estimatedRuns).toBe(estimated?1:undefined);expect(unseenExcessCalls(read()).settled).toBe(1);
  const before=read();before.unmetered++;put(monthId(),before);expect(learningCeilingStatus(database(),readMemoryLearning(database()).ceiling).paused).toBe(true);
  transaction(db=>clearUnseenExcess(db));expect(unseenExcessCalls(read()).settled).toBe(0);expect(learningCeilingStatus(database(),readMemoryLearning(database()).ceiling).paused).toBe(false);
});
it("10: clear reconciles tokens before clearing unseen",()=>{
  seed();transaction(db=>clearUnseenExcess(db));expect(read()).toMatchObject({input:9000,output:5000,retryRecords:{}});expect(unseenExcessCalls(read()).settled).toBe(0);
});
it.each(["outer","throw","cap"])("12: journal refuses %s without writing partial evidence",async mode=>{
  await withRetryReservation(async()=>{
    if(mode==="cap"){const row=read();row.retryRecords={a:{},b:{}};put(monthId(),row);}
    if(mode==="throw")database().exec("CREATE TRIGGER fail_journal BEFORE UPDATE ON memory_scope_bindings WHEN new.subject_id='learning-spend' BEGIN SELECT RAISE(ABORT,'disk fixture'); END");
    expect(mode==="outer"?transaction(()=>journalMemoryRetry({})):journalMemoryRetry({})).toBe(false);
    if(mode==="throw")database().exec("DROP TRIGGER fail_journal");
    reportMemoryUsage({prompt_tokens:1,completion_tokens:1});
  });
  expect(read().input).toBe(1);
});
it("12: no reservation refuses a journal",()=>expect(journalMemoryRetry({})).toBe(false));
it("14: malformed records are discarded once and do not break admission",()=>{
  seed();const row=read();row.retryRecords={bad:null,wrong:{boot:"dead",usage:[]}};row.open={};put(monthId(),row);
  const log=vi.spyOn(console,"warn").mockImplementation(()=>{});
  const lease=reserveExtraction(messages,1);expect(lease.reserved).toBe(true);lease.finish();
  expect(read().retryRecords).toEqual({});expect(log).toHaveBeenCalledTimes(2);reconcile();expect(log).toHaveBeenCalledTimes(2);
});
it("15: grounding and capture keep the reservation handle",async()=>{
  const extractor:TextOnlyExtractor=async()=>"[]";
  extractor.ground=async()=>{await captureMemoryUsage(()=>{},async()=>{expect(journalMemoryRetry(undefined)).toBe(true);expect(Object.values(read().retryRecords)[0]).toMatchObject({usage:{}});});reportMemoryUsage({prompt_tokens:1,completion_tokens:1});return '{"supported":true}';};
  expect((await groundMemoryClaim({text:"tea",quote:"tea",claimType:"owner-statement",speaker:"owner",outcome:"recorded"},extractor,new AbortController().signal)).supported).toBe(true);
  expect(read().retryRecords).toEqual({});
});
it.each(["complete","partial","absent","stop","unreleased"])("16, 27: settlement preserves run 1's excess with %s run 2",kind=>{
  const lease=reserveExtraction(messages,100),row=read();row.retryRecords={[lease.handle.id!]:{boot:Object.keys(row.open)[0],ledgerId:lease.handle.ledgerId,tokens:lease.handle.tokens,usage:{prompt_tokens:9000,completion_tokens:5000}}};put(monthId(),row);
  const reports=[{prompt_tokens:9000,completion_tokens:5000,engineRun:true},...(kind==="unreleased"?[]:[kind==="complete"?{prompt_tokens:3,completion_tokens:2}:kind==="partial"?{prompt_tokens:3}:{engineRun:true}])];
  lease.settle({...sumUsageReports(reports),extraUnseen:kind==="complete"||kind==="unreleased"?0:1});lease.finish();
  expect(read().input).toBe(kind==="complete"||kind==="partial"?9003:9000);expect(read().output).toBe(kind==="complete"?5002:5000);
  expect(read().unmetered??0).toBe(kind==="complete"||kind==="unreleased"?0:1);expect(read().retryRecords).toEqual({});
  const settled=read();closeDatabase();database();reconcile();expect(read()).toEqual(settled);
});
it("26: recovering one of two reservations on the same dead boot leaves the other open",()=>{seed(undefined,{open:2});reconcile();expect(read().open).toEqual({dead:1});});
it("18: fifty simulated crashes through admission keep durable records bounded",async()=>{
  vi.useFakeTimers();
  for(let boot=0;boot<50;boot++){
    const existing=other.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(monthId());
    if(existing&&unseenExcessCalls(JSON.parse(String(existing.intent))).settled>=2)transaction(db=>clearUnseenExcess(db));
    let failSettlement:{mockRestore:()=>void}|undefined;
    await withRetryReservation(async()=>{
      expect(journalMemoryRetry({prompt_tokens:9000,completion_tokens:5000})).toBe(true);
      expect(Object.keys(read().retryRecords).length).toBeLessThanOrEqual(2);
      const db=database(),prepare=db.prepare.bind(db);
      failSettlement=vi.spyOn(db,"prepare").mockImplementation(((sql:string)=>{if(sql==="UPDATE memory_scope_bindings SET intent=? WHERE id=?")throw Object.assign(new Error("database is locked"),{code:"SQLITE_BUSY"});return prepare(sql);}) as typeof db.prepare);
    });
    failSettlement!.mockRestore();vi.clearAllTimers();
    const dead=read(),records=Object.values(dead.retryRecords) as import("./extract.ts").RetryRecord[];
    expect(records).toHaveLength(1);const old=records[0].boot;records[0].boot=`dead-${boot}`;dead.open={[records[0].boot]:dead.open[old]};put(monthId(),dead);
  }
  reconcile();expect(Object.keys(read().retryRecords)).toHaveLength(0);
});
it("7, 17: maintenance scans thirteen keys once even without bots or attempts, and retries a busy write",async()=>{
  const now=new Date();
  for(let i=0;i<100;i++){const id=learningSpendLedgerId(learningSpendMonth(new Date(now.getFullYear(),now.getMonth()-i,1).getTime()));seed(undefined,{id,day:`day-${i}`});}
  transaction(()=>{for(let i=0;i<10000;i++)put(`unrelated-${i}`,{input:0,output:0},"fixture");});
  const deps={bots:()=>[],now:()=>Date.now(),memoryMode:()=>"active",tmpBase:join(DATA_DIR,"tmp"),bootEpoch:{pid:1,startedAt:1},resolveRoute:async()=>{throw new Error("no route");}} as ReflectDeps;
  other.exec("BEGIN IMMEDIATE");await maintainPip(deps);other.exec("ROLLBACK");
  expect(read().retryRecords.r).toBeDefined();
  const db=database(),prepare=db.prepare.bind(db),ids:string[]=[];
  vi.spyOn(db,"prepare").mockImplementation(((sql:string)=>{const stmt=prepare(sql);if(sql==="SELECT intent FROM memory_scope_bindings WHERE id=?"){const get=stmt.get.bind(stmt);vi.spyOn(stmt,"get").mockImplementation(((id:string)=>{ids.push(id);return get(id);}) as typeof stmt.get);}return stmt;}) as typeof db.prepare);
  await maintainPip(deps);expect(ids.filter(id=>id.startsWith("learning-spend:"))).toHaveLength(13);expect(ids.filter(id=>id.startsWith("day-"))).toHaveLength(13);
  expect(read().retryRecords).toEqual({});const n=ids.length;await maintainPip(deps);expect(ids).toHaveLength(n);
  const old=learningSpendLedgerId(learningSpendMonth(new Date(now.getFullYear(),now.getMonth()-13,1).getTime()));expect(read(old).retryRecords.r).toBeDefined();
});

it("29: an estimated record crossing a month boundary recovers onto its own day and month",()=>{
  const old=learningSpendLedgerId("2025-12"),day="extract-budget:2025-12-31";
  seed({prompt_tokens:10000,completion_tokens:5000},{id:old,day,estimated:true});put(monthId(),{input:0,output:0});reconcile(old);
  expect(read(old)).toMatchObject({input:10000,output:5000,estimatedRuns:1});expect(unseenExcessCalls(read(old)).settled).toBe(1);expect(read(day)).toEqual({input:10000,output:5000});expect(read()).toEqual({input:0,output:0});
});

it("F: settlement rolls back both ledgers and record deletion if the month write fails", async () => {
  vi.useFakeTimers();
  const lease=reserveExtraction(messages,3000),beforeMonth=read();
  beforeMonth.retryRecords={[lease.handle.id!]:{boot:Object.keys(beforeMonth.open)[0],ledgerId:lease.handle.ledgerId,tokens:lease.handle.tokens,usage:{prompt_tokens:9000,completion_tokens:5000}}};
  put(monthId(),beforeMonth);
  const beforeDay=read(lease.handle.ledgerId);
  database().exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON memory_scope_bindings WHEN new.subject_id='learning-spend' BEGIN SELECT RAISE(ABORT,'settlement crash'); END");
  lease.settle({prompt_tokens:9010,completion_tokens:5010,extraUnseen:0});
  expect(read(lease.handle.ledgerId)).toEqual(beforeDay);
  expect(read()).toEqual(beforeMonth);
  database().exec("DROP TRIGGER fail_settle");
  await vi.advanceTimersByTimeAsync(1000);
  expect(read(lease.handle.ledgerId)).toMatchObject({input:9010,output:5010});
  expect(read()).toMatchObject({input:9010,output:5010,retryRecords:{}});
});
