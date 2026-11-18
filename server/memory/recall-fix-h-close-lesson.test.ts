import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
// Producer owner: recall-fix-h (memory route); consumer owner: recall-fix-h (withdrawn close-lesson refusal).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { fixtureMemoryAccess as memoryAccess } from '../testing/recall-access-fixture.ts';
import { settleTestHandles } from '../test-handle-registry.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { RecallViewLost } from './recall-recovery.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
import { memoryAgentRoute } from './routes.ts';
import { setMemoryCaptureRoster } from './capture-scope.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { setMemoryCaptureRoster(null); stopRecallViewMaintenance(); await settleTestHandles(DATA_DIR); });
it('C7 close lesson saves a bot-scoped candidate backed by the project, without grounding activation', async () => {
  const roster={bots:[{id:'bot',threadId:'direct'}],groups:[{id:'project',threadId:'room',memberIds:['bot']}]};
  reconcileMemoryRoster(roster);setMemoryMode('active');
  setMemoryCaptureRoster(()=>roster);
  captureSource(database(),{id:'project-evidence',threadId:'room',kind:'text',speaker:'owner',outcome:'recorded',text:'Project closed: what I learned'});
  const {channelToProjectRows}=await import('../project-settings.ts');const {startProjectClose,resumeProjectCloses}=await import('../project-close.ts');const {markRequestDispatched}=await import('../room-requests.ts');
  channelToProjectRows(database(),{groupId:'project',bulletin:'',leadBotId:null,now:1});
  const deps={groupId:'project',threadId:'room',memberIds:['bot'],now:2,lineage:{rootThreadId:'room',origin:'desktop' as const,audienceFingerprint:'owner',notOwnerAudience:false,unattended:false},deliverables:()=>[],routineNames:()=>[],pauseRoutines:()=>{},post:()=>{},summary:()=>null,sync:()=>{}};
  startProjectClose(database(),deps);resumeProjectCloses(database(),deps);
  setMemoryCaptureRoster(null);
  const requestId=String(database().prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'close-lesson:%'").get()!.id);markRequestDispatched(database(),requestId,{now:3,targetThreadId:'room'});
  const registry=new InternalCapabilities();registry.begin('bot','room','lesson');const token=registry.mint({botId:'bot',threadId:'room',generation:'lesson',depth:0,kind:'memory',skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const evidence=[{sourceId:'project-evidence',revision:1,startByte:0,endByte:Buffer.byteLength('Project closed: what I learned')}];
  const body={text:'Project closed: what I learned',evidence,idempotencyKey:'close-lesson',claimType:'owner-statement'};
  // R7-9: the lesson path refuses evidence whose capture is still pending, as every other save does
  await expect(memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toThrow('Source capture is still pending. Try saving this memory again after capture finishes.');
  expect(Number(database().prepare("SELECT COUNT(*) AS n FROM memory_records").get()!.n)).toBe(0);
  for(let job=claimMemoryJob('fixture');job;job=claimMemoryJob('fixture'))publishMemoryWork(job,'fixture',captureWork(job));
  const result=await memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId}) as {candidateId:string};
  expect(database().prepare('SELECT s.kind,s.owner_key,r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.id=?').get(result.candidateId)).toEqual({kind:'bot',owner_key:'bot',state:'candidate'});
  expect(database().prepare('SELECT source_id FROM memory_evidence WHERE record_id=?').all(result.candidateId)).toEqual([{source_id:'project-evidence'}]);
  expect(await memoryAgentRoute('/api/internal/memory/save',body,access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).toMatchObject({candidateId:result.candidateId,state:'candidate'});
  // R5: a Reopen while the lesson body is read revokes the lesson path; the save never
  // falls through to an ordinary grounded (project-scoped, possibly active) save.
  const {reopenProject}=await import('../project-close.ts');
  reopenProject(database(),{groupId:'project',now:4,sync:()=>{}});
  const before=Number(database().prepare('SELECT COUNT(*) AS n FROM memory_records').get()!.n);
  await expect(memoryAgentRoute('/api/internal/memory/save',{...body,idempotencyKey:'after-reopen'},access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toThrow('MEMORY_CLOSE_LESSON_REQUIRED');
  expect(Number(database().prepare('SELECT COUNT(*) AS n FROM memory_records').get()!.n)).toBe(before);
  await expect(memoryAgentRoute('/api/internal/memory/save',body,{...access},{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toThrow('MEMORY_UNAUTHORIZED');
  await expect(memoryAgentRoute('/api/internal/memory/search',{query:'closed lesson'},access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{executingRequestId:requestId})).rejects.toBeInstanceOf(RecallViewLost);
});
useOutsideStoreFixture();
