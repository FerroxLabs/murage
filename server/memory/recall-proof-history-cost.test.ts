// Producer owner: recall-s1s2g (bounded session proof). Consumer owner: recall-privacy-close-b (room revalidation cost witness).
// Review High (a77003e6fb): room continuation reread every receipt of the retained session at each validation and reset the
// session past 4,096 of them. A retained room session must be revalidated at a cost that does not depend on how long it is:
// the same SQL work for 64 or 9,000 receipts, no statement that scans history, and the same session kept throughout.
// (A retained session idle across more than LOG_SCAN_MAX install-wide changes still starts fresh: MAIN RULING 1115-RECALL-DESIGN-GROK.)
import {mkdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {closeDatabase,database} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {buildMemoryBundle} from './bundle.ts';
import {MemoryDispatchReceipt} from './dispatch.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {prepareRecallContextSync,stopRecallViewMaintenance} from './recall-view.ts';
import {revalidateMemoryAccess} from './policy.ts';
import {proofModule,receipts,setupProofFixture} from './session-proof-fixture.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});

const HISTORY=['memory_disclosures','memory_session_change_log','memory_session_check_cites','memory_session_check_messages','memory_receipt_lines','memory_evidence','memory_line_lineage','messages'];
// Counts every statement run and every row returned on the file while `work` runs, and keeps each statement's text.
function counted<T>(work:()=>T){
 const db=database() as any,prepare=db.prepare;const seen={statements:0,rows:0,sql:new Set<string>()};
 db.prepare=function(sql:string){
  const statement=prepare.call(db,sql);seen.sql.add(sql);
  return new Proxy(statement,{get(target,name){
   const value=Reflect.get(target,name,target);
   if(name==='get')return (...args:unknown[])=>{seen.statements++;const row=value.apply(target,args);if(row)seen.rows++;return row;};
   if(name==='all')return (...args:unknown[])=>{seen.statements++;const rows=value.apply(target,args);seen.rows+=rows.length;return rows;};
   if(name==='run')return (...args:unknown[])=>{seen.statements++;return value.apply(target,args);};
   return typeof value==='function'?value.bind(target):value;
  }});
 };
 try{return {result:work(),seen};}finally{db.prepare=prepare;}
}
const AGGREGATE=/\b(count|sum|total|avg|group_concat|string_agg|json_group_array|json_group_object|min|max)\s*\(/i;
const NOT_ALIAS='(?!(?:WHERE|JOIN|ON|ORDER|GROUP|LIMIT|LEFT|INNER|CROSS|UNION|USING|NATURAL|INDEXED|NOT)\\b)';
// Every plan step on a history table, by its name or its alias, is checked. A full scan of one (indexed or not) is a finding,
// and so is an aggregate that walks a range of one: only SQLite's one-row min/max lookup (a bare SEARCH) is free of history.
// A statement whose plan cannot be read, or whose plan names a table the oracle cannot resolve, is a finding too.
// Only a bare first-row probe (one table, no WHERE, join, order, grouping or function, LIMIT 1) stops after one row whatever the table holds.
const FIRST_ROW=/^\s*SELECT\s+[\w\s,.*]+?\s+FROM\s+[\w.]+(?:\s+(?:AS\s+)?\w+)?\s+LIMIT\s+1\s*;?\s*$/i;
const firstRowProbe=(text:string)=>FIRST_ROW.test(text)&&!/\b(WHERE|JOIN|ORDER|GROUP|UNION|HAVING|OFFSET)\b|\(/i.test(text);
const scans=(sql:Set<string>)=>[...sql].filter(text=>/^\s*(SELECT|WITH)/i.test(text)&&!firstRowProbe(text)).flatMap(text=>{
 let plan:Array<{detail:string}>;
 try{plan=database().prepare('EXPLAIN QUERY PLAN '+text).all() as Array<{detail:string}>;}catch(error){return [`EXPLAIN failed (${(error as Error).message}): ${text}`];}
 const names=new Map<string,string>();
 // A schema-qualified name (temp.x, main.x) is planned under that name and names the table x.
 for(const m of text.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+((?:[A-Za-z_]\\w*\\.)?([A-Za-z_]\\w*))(?:\\s+(?:AS\\s+)?${NOT_ALIAS}([A-Za-z_]\\w*))?`,'gi'))){names.set(m[1],m[2]);names.set(m[2],m[2]);if(m[3])names.set(m[3],m[2]);}
 for(const m of text.matchAll(/\b([A-Za-z_]\w*)\s+AS\s*\(/gi))names.set(m[1],m[1]);
 const aggregate=AGGREGATE.test(text);
 return plan.map(step=>String(step.detail)).flatMap(detail=>{
  const step=/^(SCAN|SEARCH) (\S+)(.*)$/.exec(detail);
  if(!step||step[2]==='CONSTANT'||step[2].startsWith('('))return [];
  const table=names.get(step[2]);
  if(!table)return [`unresolved ${detail}: ${text}`];
  if(!HISTORY.includes(table))return [];
  if(step[1]==='SCAN')return [`${detail} [${table}]: ${text}`];
  if(aggregate&&step[3]!=='')return [`aggregate ${detail} [${table}]: ${text}`];
  return [];
 });
});

function unrelatedChanges(n:number){
 const db=database();
 // a file with no change log (the reviewed tree) has no change history to pay for
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_change_log'").get())return;
 const insert=db.prepare("INSERT INTO memory_session_change_log(id) VALUES('source:unrelated-history')");
 db.exec('BEGIN');try{for(let i=0;i<n;i++)insert.run();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
it('H room revalidation: preparation and write proofs cost the same at 64 and 9,000 receipts and keep the session',async()=>{
 const costs:Array<{size:number;prepare:{statements:number;rows:number};write:{statements:number;rows:number};plan:string[]}>=[];
 for(const size of [64,1100,4200,9000]) {
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  // The install's change history before this session is as long as the session itself.
  const f=setupProofFixture('room-thread'),p=await proofModule();unrelatedChanges(size);await receipts(f,size);
  const ctx={access:f.access,disclosed:true};
  // Idle maintenance has caught up with this long session, then the room's next turn adds its own receipts.
  for(let slice=0;slice<16&&p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx).kind!=='resume';slice++)p.seedSessionChecksSlice?.(f.access);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx)).toEqual({kind:'resume'});
  await receipts(f,3);unrelatedChanges(1);
  // MAIN 2026-11-17T22:32Z: epoch recertification is part of the measured continuation work.
  database().exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
  prepareRecallContextSync('reader',f.key.threadId,f.roster);
  const prepared=counted(()=>{f.access=revalidateMemoryAccess(f.access);ctx.access=f.access;return p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx);});
  expect(prepared.result).toEqual({kind:'resume'});
  const receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),f.access,f.key.driverInstance);
  receipt.retains(f.key.nativeSession,ctx);
  database().exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
  prepareRecallContextSync('reader',f.key.threadId,f.roster);
  const written=counted(()=>receipt.assertCurrent());
  expect(database().prepare('SELECT count(*) AS n FROM memory_disclosures WHERE thread_id=? AND native_session=?').get(f.key.threadId,f.key.nativeSession)?.n).toBe(size+3);
  costs.push({size,prepare:{statements:prepared.seen.statements,rows:prepared.seen.rows},write:{statements:written.seen.statements,rows:written.seen.rows},plan:scans(new Set([...prepared.seen.sql,...written.seen.sql]))});
 }
 // Cost independent of history: identical work at every length, and no history table is ever scanned.
 for(const cost of costs.slice(1))expect({size:cost.size,prepare:cost.prepare,write:cost.write}).toEqual({size:cost.size,prepare:costs[0].prepare,write:costs[0].write});
 for(const cost of costs)expect({size:cost.size,plan:cost.plan}).toEqual({size:cost.size,plan:[]});
 expect(costs[0].prepare.statements).toBeGreaterThan(0);
},240000);

it('H room revalidation: one proof reads at most its fixed slice of a turn\'s new receipts',async()=>{
 const f=setupProofFixture('room-thread'),p=await proofModule();await receipts(f,64);
 const ctx={access:f.access,disclosed:true},slice=Number(p.SESSION_PROOF?.NEW_RECEIPTS_MAX??64)+1;
 for(let n=0;n<16&&p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx).kind!=='resume';n++)p.seedSessionChecksSlice?.(f.access);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx)).toEqual({kind:'resume'});
 await receipts(f,200);
 const db=database() as any,prepare=db.prepare;let read=0;
 db.prepare=function(sql:string){const statement=prepare.call(db,sql);if(!/FROM memory_disclosures\b/.test(sql)||!/^\s*SELECT/i.test(sql))return statement;
  return new Proxy(statement,{get(target,name){const value=Reflect.get(target,name,target);
   if(name==='all')return (...args:unknown[])=>{const rows=value.apply(target,args);read+=rows.length;return rows;};
   if(name==='get')return (...args:unknown[])=>{const row=value.apply(target,args);if(row)read++;return row;};
   return typeof value==='function'?value.bind(target):value;}});};
 try{p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx);}finally{db.prepare=prepare;}
 expect(read).toBeGreaterThan(0);
 expect(read).toBeLessThanOrEqual(slice+4);
},120000);
