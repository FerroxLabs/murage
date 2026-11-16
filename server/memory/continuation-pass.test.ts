import * as bundleReader from './bundle.ts';
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
import { liveFrameSources, startLiveSession } from './testing/live-session-fixture.ts';
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { mkdirSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { saveMemoryCandidate } from './authority.ts';
import { captureSource } from './capture.ts';
import { bindMemoryDisclosureSession, deliverMemoryDisclosure, continuationMemoryRevoked, resetSessionHolds } from './disclosures.ts';
import { reconcileMemoryRoster, inMemoryAccessPass } from './policy.ts';
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from './repository.ts';
import { LineageAllowance, thawRootSetWritesForTest } from './replay-lineage.ts';
// MAIN RULING 1115-RECALL-R7 (GrokBuild): this controlled owner source needs live line provenance.
import { storeLiveAnchor as storeAnchorMessage } from './testing/live-session-fixture.ts';

const roster={bots:[{id:'bot',threadId:'chat',tasks:[{threadId:'older'}]}],groups:[]};
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode('active');reconcileMemoryRoster(roster);resetSessionHolds();thawRootSetWritesForTest(true);});
afterEach(()=>{thawRootSetWritesForTest(false);});
it('constructs one dependency hold for repeated checks, then sees deletion within and between synchronous passes',async()=>{
 const registry=new InternalCapabilities();registry.begin('bot','chat','g');
 const access=memoryAccess(registry,registry.resolve(`Bearer ${registry.mint({botId:'bot',threadId:'chat',generation:'g',depth:0,kind:'memory',skillAuthoring:false})}`)!,()=>roster);
 const db=database(),text='The fixture colour is blue.';
 storeAnchorMessage(db,'older','m1',text);captureSource(db,{id:'message:older:m1',threadId:'older',messageId:'m1',kind:'text',speaker:'owner',outcome:'recorded',text});
 const id=saveMemoryCandidate(text,[{sourceId:'message:older:m1',revision:1,startByte:0,endByte:Buffer.byteLength(text)}],'k',access);
 db.prepare("UPDATE memory_records SET state='active' WHERE id=?").run(id);
 db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('F','chat','engine',NULL,?,?,'[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1)").run(JSON.stringify([{id,version:1}]),JSON.stringify(liveFrameSources([{id,version:1}])));
 startLiveSession(access,'engine','S',()=>{bindMemoryDisclosureSession('F','S');deliverMemoryDisclosure('F',access);});
 // MAIN RULING 1115-RECALL-R7 (GrokBuild): retain a cold proof for this exact single-hydration census.
 db.prepare("UPDATE memory_session_checks SET up_to=0 WHERE thread_id='chat' AND driver_instance='engine' AND native_session='S'").run();
 // 2fe571bb91: the dependency hold now records notebook ids and kinds too.
 // MAIN RULING 1115-RECALL-R7 (GrokBuild): count the actual proof hydration, including cached statements.
 const hydrated=vi.spyOn(bundleReader,'hydrateDisclosedMemoryRecord');
 const queries=()=>hydrated.mock.calls.length;
 const check=()=>continuationMemoryRevoked(LineageAllowance.tool(),'chat','engine','S',access);
 try {
  inMemoryAccessPass(()=>{for(let i=0;i<6;i++)expect(check()).toBe(false);});
  expect(queries()).toBe(1);
  await Promise.resolve();
  inMemoryAccessPass(()=>{
   expect(check()).toBe(false);
   db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','older',1,1)").run();
   expect(check()).toBe(true);
  });
  await Promise.resolve();
  inMemoryAccessPass(()=>expect(check()).toBe(true));
  expect(queries()).toBe(1);
 }finally{hydrated.mockRestore();}
});

useOutsideStoreFixture();
