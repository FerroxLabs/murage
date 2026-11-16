// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-qual-h (qualification). Consumers: recall-fix-g (recent), recall-prod-x (controller); MAIN integrates.
import { beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { captureSource } from './capture.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

beforeEach(() => {freshDataDir('active');new WritetimeFixture(database()).cert(true).ready(THREAD,true);});
function work() {
 const db=database();storeAnchorMessage(db,THREAD,'message','The fixture gate is green.');
 captureSource(db,{id:'message-a',threadId:THREAD,messageId:'message',kind:'text',speaker:'owner',outcome:'recorded',text:'The fixture gate is green.'});
 return claimMemoryJob('fixture')!;
}
const debt=(job:string)=>database().prepare("SELECT subject_id,state,intent FROM memory_scope_bindings WHERE id=?").get('checkpoint-debt:'+job);

it('capture completion atomically leaves exact durable checkpoint debt until its publication receipt commits',()=>{
 const w=work();publishMemoryWork(w,'fixture',captureWork(w));
 expect(debt(w.id)).toMatchObject({subject_id:'checkpoint-pending',state:'granted'});
 expect(JSON.parse(String(debt(w.id)!.intent))).toMatchObject({jobId:w.id,sourceId:w.sourceId,revision:w.revision});
 expect(database().prepare('SELECT * FROM memory_checkpoint_publications').all()).toHaveLength(0);
 expect(refreshMemoryCheckpoint(w.id).status).toBe('updated');
 expect(debt(w.id)).toBeUndefined();
 const first=database().prepare('SELECT * FROM memory_checkpoint_publications').all();expect(first).toHaveLength(1);
 expect(refreshMemoryCheckpoint(w.id).status).toBe('unchanged');
 expect(database().prepare('SELECT * FROM memory_checkpoint_publications').all()).toEqual(first);
});

it('failure to record checkpoint debt rolls capture records and coverage back together',()=>{
 const w=work(),db=database(),prepare=db.prepare.bind(db);
 const spy=vi.spyOn(db,'prepare').mockImplementation(sql=>{if(sql.includes('INSERT')&&sql.includes('memory_scope_bindings'))throw Error('fixture debt write failed');return prepare(sql);});
 try{expect(()=>publishMemoryWork(w,'fixture',captureWork(w))).toThrow('fixture debt write failed');}finally{spy.mockRestore();}
 expect(db.prepare('SELECT status,cursor FROM memory_jobs WHERE id=?').get(w.id)).toMatchObject({status:'leased',cursor:0});
 expect(db.prepare('SELECT * FROM memory_records').all()).toHaveLength(0);
 expect(debt(w.id)).toBeUndefined();
});

it('a checkpoint failure preserves the committed capture and recoverable debt',()=>{
 const w=work(),db=database();publishMemoryWork(w,'fixture',captureWork(w));
 db.exec("CREATE TEMP TRIGGER fixture_checkpoint_failure BEFORE INSERT ON memory_checkpoint_publications BEGIN SELECT RAISE(ABORT,'fixture checkpoint failed'); END");
 expect(()=>refreshMemoryCheckpoint(w.id)).toThrow('fixture checkpoint failed');
 expect(db.prepare('SELECT status FROM memory_jobs WHERE id=?').get(w.id)).toMatchObject({status:'complete'});
 expect(debt(w.id)).toMatchObject({subject_id:'checkpoint-pending'});
 expect(db.prepare('SELECT * FROM memory_checkpoint_heads').all()).toHaveLength(0);
 db.exec('DROP TRIGGER fixture_checkpoint_failure');
 expect(refreshMemoryCheckpoint(w.id).status).toBe('updated');expect(debt(w.id)).toBeUndefined();
});
