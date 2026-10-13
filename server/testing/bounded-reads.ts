// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared by the bounded-reads API tests (turn-full-bounded-api, turn-room-bounded-api,
// bounded-routes-api): the in-server counter of statements and rows bound to a
// watched thread, and the checks that two thread sizes read the same.
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect } from "vitest";
import { dropThread } from "../branch-index.ts";
import { prepareSyncOn } from "../branch-fill.ts";

// In the server process: every statement bound to the watched thread id, the
// rows it returned, its query plan, and any whole-thread load (with where it
// came from). The settle is seen when the turn's task goes idle.
export const countingInstrumentation = (STORE: string): string => `
  const fs=await import('node:fs');const path=await import('node:path');const sqlite=await import('node:sqlite');
  const dir=process.env.MURAGE_DATA_DIR;let watched=null;let watchedBot=null;let counts;const reset=()=>{counts={statements:0,rows:0,bySql:{},loads:[],plans:{},big:[],whole:[]};};reset();
  const owner=new WeakMap();const prepare=sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare=function(sql,...rest){const statement=prepare.call(this,sql,...rest);owner.set(statement,this);return statement;};
  const tables=new WeakMap();
  const scans=(db,sql,args)=>{try{let known=tables.get(db);if(!known){known=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name));tables.set(db,known);}
    return db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>String(r.detail)).filter(d=>{const m=/^SCAN (\\w+)/.exec(d);return m&&known.has(m[1]);});}catch(e){return ['explain failed: '+e.message];}};
  const where=()=>String(new Error().stack).split('\\n').filter(l=>l.includes('/server/')&&!l.includes('instrumentation')).slice(0,8).map(l=>l.trim().replace(/^at /,'').replace(/\\(.*\\/server\\//,'(')).join(' < ');
  const proto=sqlite.StatementSync.prototype;let inside=false;let lastStore=null;const everLoaded={};
  for(const name of ['all','get','iterate','run']){const original=proto[name];proto[name]=function(...args){const result=original.apply(this,args);
    if(!inside&&watched!==null&&args.some(arg=>arg===watched||(arg&&typeof arg==='object'&&Object.values(arg).includes(watched)))){inside=true;try{counts.statements++;
      const rows=name==='all'?result.length:name==='get'?(result?1:0):0;counts.rows+=rows;
      const key=String(this.sourceSQL).replace(/\\s+/g,' ').slice(0,160);const entry=counts.bySql[key]??={statements:0,rows:0};entry.statements++;entry.rows+=rows;
      if(!(key in counts.plans)){const db=owner.get(this);counts.plans[key]=db?scans(db,String(this.sourceSQL),args):['no handle'];}
      if(rows>=50||entry.statements===100)counts.big.push({sql:key,rows,at:where()});}finally{inside=false;}}
    return result;};}
  const {pathToFileURL}=await import('node:url');const {Store}=await import(pathToFileURL(${JSON.stringify(STORE)}).href);
  const cache=Store.prototype.cacheThread;Store.prototype.cacheThread=function(threadId,...rest){const at=where();if(threadId===watched)counts.loads.push(at);(everLoaded[threadId]??=[]).push(at);return cache.call(this,threadId,...rest);};
  for(const name of ['messagesFor','activePath','walkActivePath','thread']){const original=Store.prototype[name];Store.prototype[name]=function(threadId,...rest){
    if(threadId===watched){const at=name+': '+where();if(!counts.whole.includes(at))counts.whole.push(at);}return original.call(this,threadId,...rest);};}
  const botActivity=Store.prototype.setActivity;Store.prototype.setActivity=function(botId,state){lastStore=this;const out=botActivity.call(this,botId,state);
    if(watchedBot!==null&&botId===watchedBot&&state==='idle')fs.writeFileSync(path.join(dir,'settled'),'1');return out;};
  const activity=Store.prototype.setTaskActivity;Store.prototype.setTaskActivity=function(botId,threadId,state){lastStore=this;const out=activity.call(this,botId,threadId,state);
    if(threadId===watched&&state==='idle')fs.writeFileSync(path.join(dir,'settled'),'1');return out;};
  process.on('SIGUSR2',()=>{const command=JSON.parse(fs.readFileSync(path.join(dir,'count-control.json'),'utf8'));
    if(command.start){watched=command.start;watchedBot=command.bot??null;reset();counts.loadedAtStart=lastStore?lastStore.threads.has(watched):null;counts.loadedBefore=everLoaded[watched]??[];fs.writeFileSync(path.join(dir,'count-started'),command.start);}
    else{fs.writeFileSync(path.join(dir,'counts.json'),JSON.stringify(counts));watched=null;watchedBot=null;}});
`;


export type Counts = { statements: number; rows: number; bySql: Record<string, { statements: number; rows: number }>; loads: string[]; plans: Record<string, string[]>; big: Array<{ sql: string; rows: number; at: string }> };

/** What differs between the two, and where each heavy read came from. */
export const report = (label: string, a: Counts, b: Counts) => {
  const keys = new Set([...Object.keys(a.bySql), ...Object.keys(b.bySql)]);
  const diff = [...keys].filter((key) => JSON.stringify(a.bySql[key]) !== JSON.stringify(b.bySql[key])).map((key) => ({ key, small: a.bySql[key], large: b.bySql[key] }));
  console.log(`[${label}] totals`, { small: [a.statements, a.rows, (a as any).loadedAtStart], large: [b.statements, b.rows, (b as any).loadedAtStart] });
  console.log(`[${label}] diff`, JSON.stringify(diff, null, 1));
  console.log(`[${label}] loads`, JSON.stringify({ small: a.loads, large: b.loads, before: (b as any).loadedBefore }, null, 1));
  console.log(`[${label}] heavy`, JSON.stringify({ small: a.big, large: b.big }, null, 1).slice(0, 12_000));
  console.log(`[${label}] whole-thread calls`, JSON.stringify({ small: (a as any).whole, large: (b as any).whole }, null, 1));
  console.log(`[${label}] scans`, JSON.stringify(Object.entries(b.plans).filter(([, scans]) => scans.length), null, 1));
};

/** The memory lineage judge's lookups (memory_* tables, the batched withheld-from-bots check of the lines a prompt shows, the owner-send
 * retry probe whose count follows timing, and a copy's original
 * read by id): each is one keyed read for one message id, and how many run
 * depends on what its verdict cache already holds, which varies from run to
 * run whatever the thread's length. They are held to a bound, not an equality. */
export const lineageRead = (sql: string) => /\bmemory_|\$\.copyOf|\brecord_versions\b|\bdeletion_epoch\b|\$\.withheldFromBots|\bFROM owner_sends\b/.test(sql);
/** A message read by its id: how many run follows what recall named for this turn. */
const keyedMessageRead = (sql: string) => sql.startsWith("SELECT json FROM messages WHERE thread_id = ? AND id = ?");
export const split = (counts: Counts, keyedReads = false) => {
  const exact: Counts["bySql"] = {};
  let lineage = 0;
  for (const [sql, entry] of Object.entries(counts.bySql)) {
    if (lineageRead(sql) || (keyedReads && keyedMessageRead(sql))) lineage += entry.statements;
    else exact[sql] = entry;
  }
  return { exact, lineage };
};

/** A scan of memory_deny (one row per deleted conversation or bot, never per message: the write-time lineage judge's `EXISTS` on it) is allowed.
 * `learningScans`: scans of the small tables that hold learning (one row per feedback signal or lesson, not per message) are allowed.
 * `keyedReads`: reads of one message by its id are held to a bound, not an equality (their number follows what recall named). */
export const expectBounded = (a: Counts, b: Counts, learningScans = false, keyedReads = false) => {
  const unindexed = (counts: Counts) => Object.entries(counts.plans).map(([sql, scans]) => [sql, scans.filter((scan) => !(learningScans && /^SCAN memory_(feedback|lessons)\b/.test(scan)) && !/^SCAN memory_deny\b/.test(scan))] as const).filter(([, scans]) => scans.length);
  // no whole-thread load or whole-thread read, named by where it came from
  expect((a as any).whole).toEqual([]);
  expect((b as any).whole).toEqual([]);
  expect(a.loads).toEqual([]);
  expect(b.loads).toEqual([]);
  // per statement, so a difference names the read that grew: the transcript's
  // reads are the same statements and the same rows at either length
  const x = split(a, keyedReads), y = split(b, keyedReads);
  expect(y.exact).toEqual(x.exact);
  // the lineage judge's keyed reads stay within the same bound
  expect(y.lineage).toBeLessThanOrEqual(Math.max(50, x.lineage * 2));
  expect(x.lineage).toBeLessThanOrEqual(Math.max(50, y.lineage * 2));
  // every statement is an index search
  expect(unindexed(b)).toEqual([]);
  expect(unindexed(a)).toEqual([]);
};


// ── in-process version ──────────────────────────────────────────────────────
// For tests that call the code directly (a Store, a route function) instead of
// a running server: every statement bound to the watched thread while `run`
// executes, the rows it returned, and which of them scan a table.
export interface Reads { statements: number; rows: number; bySql: Record<string, { statements: number; rows: number }>; scans: Array<{ sql: string; scan: string[] }>; plans: Array<{ sql: string; plan: string[] }> }

// Every statement is counted from the moment it is prepared, so one the code under test
// prepared long ago (a cached statement) is counted too: this file must be imported before
// the database is first opened. Counting happens only while a measurement is running.
interface Watch { threadId: string; reads: Reads; sample: Map<string, unknown[]> }
let watch: Watch | null = null;
let inside = false;
const installed = Symbol.for("murage.bounded-reads.prepare");
/** The derived tables are keyed by small integers, not the thread id: a statement that touches one is the thread's whatever its arguments. */
const DERIVED_TABLES = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:msg_branch|seg|line|thread_key|fill_pending|branch_change)\b/;
const proto = DatabaseSync.prototype as unknown as Record<symbol | string, unknown>;
if (!proto[installed]) {
  const prepare = DatabaseSync.prototype.prepare;
  proto[installed] = true;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]) {
    const statement = (prepare as (...args: unknown[]) => StatementSync).call(this, sql, ...rest);
    for (const name of ["all", "get", "iterate", "run"] as const) {
      const original = (statement[name] as (...args: unknown[]) => unknown).bind(statement);
      (statement as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const result = original(...args);
        const current = watch;
        if (current && !inside && (args.some((arg) => arg === current.threadId || (arg && typeof arg === "object" && Object.values(arg as object).includes(current.threadId))) || DERIVED_TABLES.test(String(statement.sourceSQL)))) {
          inside = true;
          try {
            const rows = name === "all" ? (result as unknown[]).length : name === "get" ? (result ? 1 : 0) : 0;
            current.reads.statements++; current.reads.rows += rows;
            const key = String(statement.sourceSQL).replace(/\s+/g, " ").slice(0, 160);
            const entry = current.reads.bySql[key] ??= { statements: 0, rows: 0 };
            entry.statements++; entry.rows += rows;
            if (!current.sample.has(key)) current.sample.set(key, [String(statement.sourceSQL), ...args]);
          } finally { inside = false; }
        }
        return result;
      };
    }
    return statement;
  } as typeof DatabaseSync.prototype.prepare;
}

/** The statements bound to `threadId` while `run` executes: how many, the rows they returned, and which scan a table. */
export async function measureReads<T>(threadId: string, messagesDb: string, run: () => T | Promise<T>): Promise<{ result: T; reads: Reads }> {
  const current: Watch = { threadId, reads: { statements: 0, rows: 0, bySql: {}, scans: [], plans: [] }, sample: new Map() };
  watch = current;
  let result: T;
  try { result = await run(); } finally { watch = null; }
  const explainer = new DatabaseSync(messagesDb, { readOnly: true });
  try {
    const tables = new Set((explainer.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [key, [sql, ...args]] of current.sample) {
      let scan: string[];
      try {
        const plan = (explainer.prepare(`EXPLAIN QUERY PLAN ${sql as string}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => String(row.detail));
        current.reads.plans.push({ sql: key, plan });
        scan = plan.filter((detail) => { const match = /^SCAN (\w+)/.exec(detail); return Boolean(match && tables.has(match[1]!)); });
      } catch (error) { scan = [`explain failed: ${(error as Error).message}`]; }
      if (scan.length) current.reads.scans.push({ sql: key, scan });
    }
  } finally { explainer.close(); }
  return { result, reads: current.reads };
}

/** The same statements, the same rows, and no table scan, at both sizes. */
export function expectSameReads(small: Reads, large: Reads) {
  expect(large.bySql).toEqual(small.bySql);
  expect(large.scans).toEqual([]);
  expect(small.scans).toEqual([]);
}

/** A thread whose rows were stored behind the writers' back (a database from before the indexes): what is derived for it is dropped
 * and filled again, as its first turn would do, so a measured turn starts from a prepared thread, small or large alike. */
export function refillThread(db: DatabaseSync, threadId: string): void {
  dropThread(db, threadId);
  db.prepare("DELETE FROM turn_first WHERE thread_id = ?").run(threadId);
  prepareSyncOn(db, threadId);
}
