// Checkpoint producer and selection/citation consumer: recall-s1s2k.
// Memory integration owner: MurageMain; privacy decision owner: GrokBuild.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { DatabaseSync } from '../sqlite-open.ts';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { captureSource } from './capture.ts';
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';
import { threadCheckpointId } from './checkpoints.ts';
import { stopMemoryRevocation } from './memory-revocation.ts';

beforeEach(() => {
 closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true});
 reconcileMemoryRoster({bots:[{id:'reader',threadId:'thread'}],groups:[]}); setMemoryMode('capture'); resetMemoryClaimCursor();
 new WritetimeFixture(database()).cert(true).ready('thread',true);
 database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
});
afterEach(() => {stopMemoryRevocation();closeDatabase();});
function captured(id:string,text:string,thread='thread') {
 storeAnchorMessage(database(),thread,id,text);
 const lsn=Number(database().prepare('SELECT next FROM memory_lsn WHERE id=1').get()!.next);
 new WritetimeFixture(database()).lineage(thread,id,lsn,{generated:false,turnLsn:null}).ready(thread,true);
 captureSource(database(),{id,threadId:thread,messageId:id,origin:{kind:'attended'},kind:'text',speaker:'owner',outcome:'recorded',text});
 const work=claimMemoryJob('checkpoint-fixture')!;
 expect(work).toBeTruthy(); publishMemoryWork(work,'checkpoint-fixture',captureWork(work));
 return work.id;
}
function published(job:string) {
 const result=refreshMemoryCheckpoint(job); expect(result.status).toBe('updated');
 if(result.status!=='updated')throw Error('checkpoint not published');
 return {id:result.checkpointId,version:result.version};
}
it('K-CP-append: changed publication preserves the exact previous record and evidence',()=>{
 const db=database(),a=published(captured('message-a','The sample is green.'));
 const record=db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(a.id,a.version);
 const edges=db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id').all(a.id,a.version);
 const watermark=db.prepare('SELECT max(seq) AS n FROM memory_session_change_log').get()!.n??0;
 const b=published(captured('message-b','The specimen is round.'));
 expect(b.id).not.toBe(a.id); expect(b.version).toBe(1);
 expect(db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(a.id,a.version)).toEqual(record);
 expect(db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id').all(a.id,a.version)).toEqual(edges);
 expect(db.prepare('SELECT 1 FROM memory_session_change_log WHERE seq>? AND id=?').get(watermark,`record:${a.id}`)).toBeUndefined();
 const scope=String(record!.scope_id),family=threadCheckpointId(scope,'thread');
 expect(db.prepare('SELECT record_id,record_version FROM memory_checkpoint_heads WHERE family_id=?').get(family)).toMatchObject({record_id:b.id,record_version:1});
});
it('K-CP-publication: an older completion retry cannot move the current head backwards',()=>{
 const db=database(),job=captured('message-a','First observation.'),a=published(job);
 const b=published(captured('message-b','Second observation.'));
 const before=db.prepare('SELECT * FROM memory_records ORDER BY id,version').all();
 const retry=refreshMemoryCheckpoint(job);
 expect(retry).toMatchObject({status:'unchanged',checkpointId:a.id,version:1});
 expect(db.prepare('SELECT * FROM memory_records ORDER BY id,version').all()).toEqual(before);
 expect(db.prepare('SELECT record_id FROM memory_checkpoint_heads').get()?.record_id).toBe(b.id);
});
it('K-CP-publication: failed head publication rolls back record, evidence and membership',()=>{
 const db=database(),a=published(captured('message-a','First observation.'));
 const job=captured('message-b','Second observation.');
 db.exec("CREATE TRIGGER fixture_head_failure BEFORE UPDATE ON memory_checkpoint_heads BEGIN SELECT RAISE(ABORT,'fixture head failure'); END");
 expect(()=>refreshMemoryCheckpoint(job)).toThrow('fixture head failure');
 expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'").get()?.n).toBe(1);
 expect(db.prepare('SELECT record_id FROM memory_checkpoint_heads').get()?.record_id).toBe(a.id);
 db.exec('DROP TRIGGER fixture_head_failure');
 const b=published(job); expect(b.id).not.toBe(a.id);
});

it('K-CP-discovery-work: candidate indexes retain only the selected publication after bounded maintenance',async()=>{
 const {setupProofFixture}=await import('./session-proof-fixture.ts');
 const {maintainRecallViewSlice}=await import('./recall-view.ts');
 const {eligibleViewPage,lexicalViewPage}=await import('./recall-view-index.ts');
 const f=setupProofFixture('direct'),db=database();
 const a=published(captured('message-a','First observation.','direct'));f.access=f.issue();
 while(!maintainRecallViewSlice(f.access.view)){}
 const b=published(captured('message-b','Second observation.','direct'));f.access=f.issue();
 while(!maintainRecallViewSlice(f.access.view)){}
 const candidates=eligibleViewPage(db,f.access.view,'',100).filter(ref=>db.prepare("SELECT 1 FROM memory_records WHERE id=? AND version=? AND kind='checkpoint'").get(ref.id,ref.version));
 expect(candidates.map(ref=>({id:ref.id,version:ref.version}))).toEqual([b]);
 expect(lexicalViewPage(db,'observation',f.access.view,100).hits.map(ref=>ref.id)).not.toContain(a.id);
 const {pendingProjectionRecords}=await import('./projection.ts');
 expect(pendingProjectionRecords(db,100).find(ref=>ref.id===a.id)).toMatchObject({state:'deleted',text:'',rolled:1});
 expect(db.prepare('SELECT state FROM memory_records WHERE id=? AND version=?').get(a.id,a.version)?.state).toBe('active');
});
it('K-CP-denial: a new head preserves exact old citations, and editing the cited record still refuses',async()=>{
 const {setupProofFixture,receipts,proofModule}=await import('./session-proof-fixture.ts');
 const {LineageAllowance}=await import('./lineage-allowance.ts');
 const f=setupProofFixture('direct'),db=database();
 const a=published(captured('message-a','First observation.','direct'));
 f.access=f.issue();
 const ids=await receipts(f,1);
 const cited=JSON.parse(String(db.prepare('SELECT record_versions FROM memory_disclosures WHERE bundle_id=?').get(ids[0])!.record_versions));
 expect(cited).toContainEqual(a);
 const p=await proofModule();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 published(captured('message-b','Second observation.','direct'));
 f.access=f.issue();
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
 expect(JSON.parse(String(db.prepare('SELECT record_versions FROM memory_disclosures WHERE bundle_id=?').get(ids[0])!.record_versions))).toContainEqual(a);
 db.prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(a.id,a.version);
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'changed:record'});
});
it('K-CP-publication: family archive denies retained members and stops automatic publication',async()=>{
 const {archiveMemoryRecord}=await import('./retention.ts');
 const {ownerMemoryTicket}=await import('./authority.ts');
 const db=database(),a=published(captured('message-a','First observation.'));
 const b=published(captured('message-b','Second observation.'));
 archiveMemoryRecord(ownerMemoryTicket(),b.id,b.version);
 // MAIN RULING recall-k: family archive blanks retained checkpoint excerpts.
 expect(db.prepare("SELECT text FROM memory_records WHERE kind='checkpoint'").all().every(row=>row.text==='')).toBe(true);
 expect(db.prepare('SELECT state FROM memory_records WHERE id=?').get(a.id)?.state).toBe('archived');
 expect(db.prepare('SELECT state FROM memory_records WHERE id=?').get(b.id)?.state).toBe('archived');
 expect(refreshMemoryCheckpoint(captured('message-c','Third observation.'))).toMatchObject({status:'deferred',reason:'owner-archived-checkpoint'});
 expect(db.prepare('SELECT record_id FROM memory_checkpoint_heads').get()?.record_id).toBeNull();
});
it('K-CP-publication: family forget denies all retained members without forgetting transcript sources or republishing their evidence',async()=>{
 const {forgetMemory}=await import('./forget.ts');
 const {ownerMemoryTicket}=await import('./authority.ts');
 const db=database(),first=captured('message-a','First observation.'),a=published(first);
 const b=published(captured('message-b','Second observation.'));
 forgetMemory(ownerMemoryTicket(),{kind:'record',id:b.id,revision:b.version});
 for(const id of [a.id,b.id])expect(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=?").get(id)).toBeTruthy();
 expect(db.prepare("SELECT state FROM memory_sources WHERE id='message-a'").get()?.state).toBe('active');
 // MAIN RULING recall-k: a forgotten publication cannot be returned as current.
 expect(refreshMemoryCheckpoint(first)).toMatchObject({status:'deferred',reason:'published-evidence-unavailable'});
 expect(db.prepare('SELECT record_id FROM memory_checkpoint_heads').get()?.record_id).toBeNull();
 const c=published(captured('message-c','Third observation.'));
 expect(db.prepare('SELECT source_id FROM memory_evidence WHERE record_id=?').all(c.id).map(row=>row.source_id)).toEqual(['message-c']);
});
it('K-CP-restore: an exclusion created after an older backup survives and blocks a fresh publication identity',async()=>{
 const {forgetMemory}=await import('./forget.ts');
 const {ownerMemoryTicket}=await import('./authority.ts');
 const {mergeDestinationMemoryDeletions}=await import('./restore.ts');
 const {stopWalMaintenance}=await import('../wal-maintenance.ts');
 const job=captured('message-a','An observation excluded after the backup.');
 const candidate=join(DATA_DIR,'older-backup');mkdirSync(candidate);
 await backup(database(),join(candidate,'messages.db'));
 const a=published(job);
 forgetMemory(ownerMemoryTicket(),{kind:'record',id:a.id,revision:a.version});
 const exclusions=database().prepare('SELECT * FROM memory_checkpoint_exclusions').all();
 expect(exclusions).toHaveLength(1);
 stopMemoryRevocation();closeDatabase();await stopWalMaintenance();
 expect(mergeDestinationMemoryDeletions(DATA_DIR,candidate).history).toBe('destination-ledger-preserved');
 // Repeated merges retain the union, including exclusions already in the backup.
 const restored=new DatabaseSync(join(candidate,'messages.db'));
 try {
  expect(restored.prepare('SELECT * FROM memory_checkpoint_exclusions').all()).toEqual(exclusions);
  restored.exec("INSERT INTO memory_checkpoint_exclusions SELECT family_id,'backup-only-source',1 FROM memory_checkpoint_heads");
 }finally{restored.close();}
 mergeDestinationMemoryDeletions(DATA_DIR,candidate);
 const selected=new DatabaseSync(join(candidate,'messages.db'));
 try {
  expect(selected.prepare('SELECT count(*) AS n FROM memory_checkpoint_exclusions').get()?.n).toBe(2);
  await backup(selected,join(DATA_DIR,'messages.db'));
 }finally{selected.close();}
 const db=database();setMemoryMode('capture');
 expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_exclusions').get()?.n).toBe(2);
 expect(db.prepare("SELECT state FROM memory_sources WHERE id='message-a'").get()?.state).toBe('active');
 expect(refreshMemoryCheckpoint(job)).toMatchObject({status:'deferred',reason:'no-current-completed-evidence'});
 expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'").get()?.n).toBe(0);
 const b=published(captured('message-b','A later permitted observation.'));
 expect(b.id).not.toBe(a.id);
 expect(db.prepare('SELECT source_id FROM memory_evidence WHERE record_id=?').all(b.id)).toEqual([{source_id:'message-b'}]);
});
it('K-CP-restore: an existing backup family keeps later exclusions and never reuses a forgotten publication identity',async()=>{
 const {forgetMemory}=await import('./forget.ts');
 const {ownerMemoryTicket}=await import('./authority.ts');
 const {mergeDestinationMemoryDeletions}=await import('./restore.ts');
 const {stopWalMaintenance}=await import('../wal-maintenance.ts');
 const a=published(captured('message-a','The first observation.'));
 const candidate=join(DATA_DIR,'older-backup');mkdirSync(candidate);
 await backup(database(),join(candidate,'messages.db'));
 const b=published(captured('message-b','The later excluded observation.'));
 forgetMemory(ownerMemoryTicket(),{kind:'record',id:b.id,revision:b.version});
 stopMemoryRevocation();closeDatabase();await stopWalMaintenance();
 expect(mergeDestinationMemoryDeletions(DATA_DIR,candidate).history).toBe('destination-ledger-preserved');
 const selected=new DatabaseSync(join(candidate,'messages.db'));
 try {await backup(selected,join(DATA_DIR,'messages.db'));}finally{selected.close();}
 const db=database();setMemoryMode('capture');
 expect(db.prepare('SELECT source_id FROM memory_checkpoint_exclusions ORDER BY source_id').all()).toEqual([{source_id:'message-a'},{source_id:'message-b'}]);
 expect(db.prepare('SELECT state,text FROM memory_records WHERE id=?').get(a.id)).toMatchObject({state:'deleted',text:''});
 const c=published(captured('message-c','A permitted observation after restore.'));
 expect(c.id).not.toBe(a.id);expect(c.id).not.toBe(b.id);
 expect(db.prepare('SELECT source_id FROM memory_evidence WHERE record_id=?').all(c.id)).toEqual([{source_id:'message-c'}]);
});
it('K-CP-migration: legacy metadata seeds without editing records and rolls append-only after restart',async()=>{
 const {ensureCheckpointSchema}=await import('./checkpoint-schema.ts');
 const {insertMemoryRecord}=await import('./record-write.ts');
 const db=database(),job=captured('message-a','Legacy observation.');
 const source=db.prepare("SELECT scope_id FROM memory_sources WHERE id='message-a'").get()!;
 const id=threadCheckpointId(String(source.scope_id),'thread');
 insertMemoryRecord(db,{id,version:2,scopeId:String(source.scope_id),kind:'checkpoint',text:'Legacy observation.',assertion:'assistant-inference',state:'active',validFrom:1,createdAt:1});
 db.prepare('INSERT INTO memory_evidence VALUES(?,2,?,1,0,19)').run(id,'message-a');
 const record=db.prepare('SELECT * FROM memory_records WHERE id=?').get(id);
 db.exec('DROP TABLE memory_checkpoint_exclusions; DROP TABLE memory_checkpoint_publications; DROP TABLE memory_checkpoint_members; DROP TABLE memory_checkpoint_heads');
 ensureCheckpointSchema(db);
 expect(db.prepare('SELECT * FROM memory_records WHERE id=?').get(id)).toEqual(record);
 expect(db.prepare('SELECT record_id,record_version FROM memory_checkpoint_heads').get()).toMatchObject({record_id:id,record_version:2});
 closeDatabase();const b=published(job);
 expect(b.id).not.toBe(id);expect(b.version).toBe(1);
 expect(database().prepare('SELECT * FROM memory_records WHERE id=?').get(id)).toEqual(record);
});
it('K-CP-downgrade: an unused extension leaves for an older reader and returns empty on upgrade',async()=>{
 const {downgradeMemorySchema,migrateMemorySchema}=await import('./schema.ts');
 const db=database();downgradeMemorySchema(db,13);
 expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_checkpoint_heads'").get()).toBeUndefined();
 migrateMemorySchema(db);
 expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_heads').get()?.n).toBe(0);
});
it('K-CP-downgrade: retained publication metadata refuses an older reader before any authority or schema changes',async()=>{
 const {downgradeMemorySchema}=await import('./schema.ts');
 const db=database();published(captured('message-a','Retained observation.'));
 const records=db.prepare('SELECT * FROM memory_records ORDER BY id,version').all();
 const schema=db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
 const members=db.prepare('SELECT * FROM memory_checkpoint_members').all();
 expect(()=>downgradeMemorySchema(db,13)).toThrow('MEMORY_SCHEMA_UNSUPPORTED');
 expect(db.prepare('SELECT * FROM memory_records ORDER BY id,version').all()).toEqual(records);
 expect(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
 expect(db.prepare('SELECT * FROM memory_checkpoint_members').all()).toEqual(members);
});

it('K-CP-selection: the head is discovered while an exact old citation still hydrates independently',async()=>{
 const {setupProofFixture}=await import('./session-proof-fixture.ts');
 const {LineageAllowance}=await import('./lineage-allowance.ts');
 const {buildMemoryBundle,hydrateMemoryRecord}=await import('./bundle.ts');
 const f=setupProofFixture('direct'),a=published(captured('message-a','First observation.','direct'));
 const b=published(captured('message-b','Second observation.','direct'));
 f.access=f.issue();
 const bundle=await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()});
 expect(bundle.recordVersions).toContainEqual(b);
 expect(bundle.recordVersions).not.toContainEqual(a);
 expect(hydrateMemoryRecord(a.id,a.version,f.access,{allowance:LineageAllowance.tool()})).toMatchObject(a);
});
it('K-CP-owner: a pin and then an owner correction stop automatic publication without repointing old citations',async()=>{
 const {pinMemory,correctMemory,ownerMemoryTicket}=await import('./authority.ts');
 const a=published(captured('message-a','First observation.'));
 const next=captured('message-b','Second observation.');
 pinMemory(ownerMemoryTicket(),a.id,a.version,true);
 expect(refreshMemoryCheckpoint(next)).toMatchObject({status:'deferred',reason:'owner-controlled-checkpoint'});
 pinMemory(ownerMemoryTicket(),a.id,a.version,false);
 expect(correctMemory(ownerMemoryTicket(),a.id,a.version,'Owner corrected observation.')).toBe(2);
 expect(database().prepare('SELECT record_id,record_version FROM memory_checkpoint_heads').get()).toMatchObject({record_id:a.id,record_version:2});
 expect(refreshMemoryCheckpoint(next)).toMatchObject({status:'deferred',reason:'owner-controlled-checkpoint'});
 expect(database().prepare('SELECT state FROM memory_records WHERE id=? AND version=1').get(a.id)?.state).toBe('superseded');
});
it('K-CP-storage: historical publication growth is separate from keyed head lookup and four-source evidence',()=>{
 const db=database();
 for(let n=0;n<24;n++)published(captured(`message-${n}`,`Observation ${n}.`));
 const records=db.prepare("SELECT count(*) AS n,sum(length(CAST(text AS BLOB))) AS bytes FROM memory_records WHERE kind='checkpoint'").get()!;
 const family=String(db.prepare('SELECT family_id FROM memory_checkpoint_heads').get()!.family_id);
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT record_id,record_version FROM memory_checkpoint_heads WHERE family_id=?').all(family);
 expect(records.n).toBe(24);
 expect(plan.every(row=>String(row.detail).includes('SEARCH'))).toBe(true);
 expect(db.prepare('SELECT max(n) AS n FROM (SELECT count(*) AS n FROM memory_evidence GROUP BY record_id,record_version)').get()!.n).toBeLessThanOrEqual(4);
 console.info(`K_CP_STORAGE publications=${records.n} textBytes=${records.bytes} headSeeks=1 maxEvidence=4`);
});

function completedTurnJob() {
 const db=database();
 storeAnchorMessage(db,'thread','completed-turn','Completed.');
 captureSource(db,{id:'completed-turn',threadId:'thread',messageId:'completed-turn',turnId:'completed-turn',origin:{kind:'attended'},kind:'turn',speaker:'assistant',outcome:'completed',text:'Completed.'});
 const work=claimMemoryJob('checkpoint-fixture')!;
 expect(work).toBeTruthy();publishMemoryWork(work,'checkpoint-fixture',captureWork(work));
 return work.id;
}
it('K-CP-empty: no current evidence clears selection without mutating the old citation or manufacturing a replacement',()=>{
 const db=database(),a=published(captured('message-a','First observation.'));
 const record=db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(a.id,a.version);
 const edges=db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=?').all(a.id,a.version);
 const job=completedTurnJob();
 db.prepare("UPDATE memory_sources SET state='retired' WHERE id='message-a'").run();
 expect(refreshMemoryCheckpoint(job)).toMatchObject({status:'deferred',reason:'no-current-completed-evidence'});
 expect(db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(a.id,a.version)).toEqual(record);
 expect(db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=?').all(a.id,a.version)).toEqual(edges);
 expect(db.prepare('SELECT record_id,record_version FROM memory_checkpoint_heads').get()).toMatchObject({record_id:null,record_version:null});
 expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'").get()?.n).toBe(1);
});
it('K-CP-checking: pending evidence keeps the previous head and cannot publish a reduced checkpoint',()=>{
 const db=database(),a=published(captured('message-a','First observation.'));
 const job=completedTurnJob(),scope=String(db.prepare("SELECT scope_id FROM memory_sources WHERE id='message-a'").get()!.scope_id);
 new WritetimeFixture(db).pendingScope(scope,0,7).job(7,1_000_000);
 expect(refreshMemoryCheckpoint(job)).toMatchObject({status:'deferred',reason:'evidence-checking'});
 expect(db.prepare('SELECT record_id,record_version FROM memory_checkpoint_heads').get()).toMatchObject({record_id:a.id,record_version:a.version});
 expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE kind='checkpoint'").get()?.n).toBe(1);
});

it('K-CP-retry-authorization: a completed-publication retry cannot return an unavailable current head',()=>{
 const db=database(),a=published(captured('message-a','First observation.'));
 const job=completedTurnJob();
 expect(refreshMemoryCheckpoint(job)).toMatchObject({status:'unchanged',checkpointId:a.id});
 db.prepare("UPDATE memory_sources SET state='retired' WHERE id='message-a'").run();
 expect(refreshMemoryCheckpoint(job)).toMatchObject({status:'deferred',reason:'published-evidence-unavailable'});
 expect(db.prepare('SELECT record_id FROM memory_checkpoint_heads').get()?.record_id).toBeNull();
 expect(db.prepare('SELECT state FROM memory_records WHERE id=?').get(a.id)?.state).toBe('active');
});
