// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1024-memrecall (ASTRA-MEMAUDIT NEW 8): a memory the owner approves through the service path (registered RUN, or Keep on the
// queued card) must reach the recall index like the desktop approve route does, so it comes back on a later turn. The save
// enters through the real internal memory route (memoryAgentRoute) with a service authority; the decision gate is the only
// stand-in (the owner's RUN/Keep answer). Ten unrelated turns follow, then the next turn's bundle (dispatch.ts) must carry it
// for a paraphrase that shares no word with the fact. Words alone find the record without a receipt; meaning comes only from
// the helper's vectors, and the helper embeds exactly what the worker hands it: pendingProjectionRecords (worker-controller.ts).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(()=>vi.resetModules());
const gate = vi.hoisted(() => ({ mode: 'run', calls: new Map<object, any>() }));
vi.mock('../decision/index.ts', () => ({
  openRequest: (source: any) => { const handle = {}; gate.calls.set(handle, structuredClone(source)); return handle; },
  decide: () => gate.mode === 'run' ? {kind:'run'} : {kind:'card',ref:{approvalId:'approval'}},
  executeServiceSync: (handle: object, operation: any) => ({kind:'executed',value:operation(gate.calls.get(handle).call)}),
  attachQueue: () => {},
  presentApprovalSync: () => {},
}));
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { appendMessage } from '../message-db.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { fixtureMemoryAccess } from '../testing/recall-access-fixture.ts';
import { setMemoryMode } from './repository.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { memoryAgentRoute } from './routes.ts';
import { approveMemory, memoryApprovalQueue, ownerMemoryTicket } from './authority.ts';
import { ensureScope } from './policy.ts';
import { memoryOwnerRoute } from './settings.ts';
import { buildMemoryBundleAfterReset } from './dispatch.ts';
import { pendingProjectionRecords } from './projection.ts';
import { closeMemoryIndexReader } from './index-reader.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { captureAndPublish, indexPendingRecords } from './testing/recall-fixture.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';

beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true}); gate.mode='run'; gate.calls.clear(); });
afterEach(() => closeMemoryIndexReader());
useOutsideStoreFixture();

const UNRELATED = ['The harbour ferry leaves at seven.','Paint the fence green next spring.','The printer on floor two jams often.',
  'Book club meets on the first Tuesday.','Water the basil every other day.','The bakery closes early on Sundays.',
  'Renew the parking permit in March.','The dentist moved to Elm Street.','Kids soccer practice is on Wednesdays.','Backup drive sits in the hall closet.'];

/** The helper's vector store: filled only from the worker's own queue query, the way worker-controller.ts feeds the helper. */
function semanticHelper() {
  const vectors=new Map<string,{id:string;version:number;text:string}>();
  const drain=async()=>{
    for(const row of pendingProjectionRecords(database(),1000))if(row.state==='active')vectors.set(`${row.id}:${row.version}`,{id:String(row.id),version:Number(row.version),text:String(row.text)});
    await indexPendingRecords();
  };
  // Meaning match stand-in: the paraphrase below is about the storage unit's code.
  const bridge={search:async()=>({hits:[...vectors.values()].filter(v=>/gate code/i.test(v.text)).map(v=>({id:v.id,version:v.version,score:1,similarity:0.9})),vectorRows:vectors.size,coverageComplete:true})};
  return {drain,bridge};
}

function fixture() {
  const roster={bots:[{id:'bot',threadId:'thread'}],groups:[]};
  reconcileMemoryRoster(roster); setMemoryMode('capture');
  appendMessage('thread',{id:'m',at:1,role:'user',origin:'desktop',kind:'text',text:'Original owner note about the storage unit'});
  const work=claimMemoryJob('fixture')!; publishMemoryWork(work,'fixture',captureWork(work));
  setMemoryMode('active');
  const target=String(database().prepare('SELECT id FROM memory_records').get()!.id);
  const registry=new InternalCapabilities(); registry.begin('bot','thread','generation');
  const token=registry.mint({botId:'bot',threadId:'thread',generation:'generation',depth:99,kind:'memory',skillAuthoring:false});
  const access=fixtureMemoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const evidence=[{sourceId:work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(work.text)}];
  const authority={claim:{fixture:true},proof:{reference:'fake-source'},identity:{threadId:'thread',generation:'generation'}};
  const FACT='Storage unit gate code is 4417 zebra';
  const save=(operation:'save'|'correction') => memoryAgentRoute(
    operation==='save'?'/api/internal/memory/save':'/api/internal/memory/propose-correction',
    operation==='save'?{text:FACT,evidence,idempotencyKey:'k'}:{id:target,version:1,replacement:FACT,evidence,idempotencyKey:'k'},
    access,{search:async()=>({hits:[],vectorRows:0})},undefined,null,{authority} as any,
  ) as Promise<any>;
  return {save,access,roster};
}

for (const answer of ['run','keep','owner-route'] as const) for (const operation of ['save','correction'] as const)
it(`W1 ${operation} approved by ${answer==='run'?'service RUN':answer==='keep'?'service Keep on the queued card':'the desktop owner route (control)'}: active, indexed, recalled after 10 unrelated turns`, async () => {
  const f=fixture();
  gate.mode=answer==='run'?'run':'card';
  const saved=await f.save(operation);
  if(answer==='keep'){
    expect(saved.state).toBe('candidate');
    const item=memoryApprovalQueue().pendingApprovals()[0];
    expect(memoryApprovalQueue().respondNow(item,{behavior:'allow'} as any,{answerId:'owner-keep'} as any)).toEqual({state:'accepted'});
  }
  if(answer==='owner-route'){
    expect(saved.state).toBe('candidate');
    await memoryOwnerRoute('/api/memory/action',{action:'approve',id:String(saved.candidateId),version:1},ownerMemoryTicket(),f.roster);
  }
  const id=String(saved.candidateId);
  expect(database().prepare('SELECT state FROM memory_records WHERE id=? AND version=1').get(id)?.state).toBe('active');
  const helper=semanticHelper(); await helper.drain();
  for(const line of UNRELATED){ captureAndPublish(line); await helper.drain(); }
  const bundle=await buildMemoryBundleAfterReset('which number opens the place where my boxes are kept',f.access,helper.bridge,undefined,{allowance:LineageAllowance.tool()});
  expect(bundle.recordVersions.map(r=>r.id)).toContain(id);
});

// The scope-changing approval (applyMemoryApproval options.scopeId) activates a COPY in the chosen scope. No route passes a
// scope today; approveMemory is the one entry that takes it. The copy, not the candidate, must reach the worker's queue.
it('W1 save approved into another scope (approveMemory scopeId): the active copy is indexed and recalled after 10 unrelated turns', async () => {
  const f=fixture(); gate.mode='card';
  const saved=await f.save('save');
  expect(saved.state).toBe('candidate');
  const copy=String(approveMemory(ownerMemoryTicket(),String(saved.candidateId),1,{scopeId:ensureScope('bot','bot')}));
  expect(copy).not.toBe(String(saved.candidateId));
  expect(database().prepare('SELECT state FROM memory_records WHERE id=? AND version=1').get(copy)?.state).toBe('active');
  const helper=semanticHelper(); await helper.drain();
  for(const line of UNRELATED){ captureAndPublish(line); await helper.drain(); }
  const bundle=await buildMemoryBundleAfterReset('which number opens the place where my boxes are kept',f.access,helper.bridge,undefined,{allowance:LineageAllowance.tool()});
  expect(bundle.recordVersions.map(r=>r.id)).toContain(copy);
});
