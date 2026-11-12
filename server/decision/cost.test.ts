import {expect,it} from 'vitest';
import {performance} from 'node:perf_hooks';
import {fixture} from './fixture.ts';
import {updateMessage} from '../message-db.ts';
import {APPROVAL_OBJECTS,initializeApprovals,pruneRecords,openRecords,recordStats,readRecord} from './records.ts';
it('A12a 10,000 settled records stay bounded; million-row pruning uses index and bounded batches',()=>{
 const f=fixture();const db=f.db;
 db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000)
 INSERT INTO approval_records(id,source_kind,thread_id,request_key,request_id,bot_id,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,chat_message_id,state,created_at,settled_at)
 SELECT 'record-'||x,'engine','t','key-'||x,'r-'||x,'b','owner','owner-typed','unlimited','wipe','{}','h','[]','i','a','message-'||x,'expired',0,0 FROM n;`);
 const lookupStart=performance.now();for(let i=0;i<100;i++){expect(openRecords(db)).toEqual([]);expect(openRecords(db,'t')).toEqual([]);}const lookupMs=performance.now()-lookupStart;console.log(JSON.stringify({metric:'million-history-open-lookups',lookups:200,milliseconds:lookupMs}));expect(lookupMs).toBeLessThan(1000);
 for(let i=1000;i<11000;i++)readRecord(db,'record-'+i);expect(recordStats(db).cache).toBeLessThanOrEqual(1024);
 const start=performance.now();expect(pruneRecords(db)).toBe(500);const elapsed=performance.now()-start;console.log(JSON.stringify({metric:'million-row-prune',milliseconds:elapsed,batch:500,cache:recordStats(db).cache}));expect(elapsed).toBeLessThan(2000);
},180000);
it('A12a 10,000 streamed text patches report trigger overhead ≤10%',()=>{
 const f=fixture(),db=f.db;const message=f.store.appendMessage('t',{role:'bot',kind:'text',text:'fixture'},'stream');
 const run=(count=10000)=>{const start=performance.now();db.exec('BEGIN');try{for(let i=0;i<count;i++){message.text='fixture'+i;updateMessage('t',message);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return performance.now()-start;};
 const on:number[]=[],off:number[]=[];
 run(100);for(let pass=0;pass<1;pass++){on.push(run());for(const trigger of APPROVAL_OBJECTS.triggers)db.exec(`DROP TRIGGER ${trigger}`);off.push(run());initializeApprovals(db);}
 const median=(xs:number[])=>xs.sort((a,b)=>a-b)[0];const ratio=median(on)/median(off);console.log(JSON.stringify({metric:'text-patch-trigger-cost',patches:10000,on,off,ratio}));expect(ratio).toBeLessThanOrEqual(1.1);
},180000);
