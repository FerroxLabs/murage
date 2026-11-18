// Producer owner: recall-s1s2g (bounded proof); consumer owner: afix-recall-s1s2f (room regression witnesses).
import {mkdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {closeDatabase,database} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {buildMemoryBundle} from './bundle.ts';
import {MemoryDispatchReceipt} from './dispatch.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {proofModule,receipts,setupProofFixture} from './session-proof-fixture.ts';

beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});

for(const size of [300,4200])it(`room ${size} receipts: preparation and every write stay bounded while an old denial refuses`,async()=>{
 const f=setupProofFixture(),p=await proofModule();await receipts(f,size);
 for(let n=0;n<6;n++)p.seedSessionChecksSlice(f.access);
 const ctx={access:f.access,disclosed:true};
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx)).toEqual({kind:'resume'});
 const receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),f.access,f.key.driverInstance);
 receipt.retains(f.key.nativeSession,ctx);
 for(let write=0;write<3;write++){
  expect(()=>receipt.assertCurrent()).not.toThrow();
  const meter=p.sessionProofMeter();expect(meter.path).toBe('incremental');expect(meter.rows+meter.seeks).toBeLessThanOrEqual(200);
 }
 database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE rowid=(SELECT min(rowid) FROM memory_disclosures WHERE thread_id=? AND native_session=?)").run(f.key.threadId,f.key.nativeSession);
 expect(()=>receipt.assertCurrent()).toThrow('MEMORY_CONTEXT_REVOKED');
 expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,ctx).kind).toBe('fresh');
});
