// Owners: recall-s1s2g owns checkpoint migration; warm-keep owns resume consumers.
import { MEMORY_SCHEMA_VERSION } from "./schema.ts";
import {mkdirSync} from 'node:fs';
import {beforeEach,afterEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {closeDatabase,database} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {validateMemorySchema,downgradeMemorySchema,migrateMemorySchema} from './schema.ts';
import {proofModule,setupProofFixture,receipts} from './session-proof-fixture.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
for(const size of [200,3000])for(const seeded of [false,true])it(`T-MIG: ${size} pre-checkpoint receipts, seeder=${seeded}`,async()=>{
  const f=setupProofFixture(),p=await proofModule(),db=database();await receipts(f,size);
  expect(typeof p.seedSessionChecksSlice).toBe('function');
  // Delete derived proof data: this is exactly the cache state of a77003e6.
  db.exec('DELETE FROM memory_session_checks;DELETE FROM memory_session_check_cites;DELETE FROM memory_session_state');
  if(seeded)for(let i=0;i<4;i++)p.seedSessionChecksSlice(f.access);
  const first=p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true});
  // MAIN RULING 1115-RECALL-DESIGN-GROK: every upgrade session carrying recall takes one fresh replay, even if seeded first.
  expect(first).toMatchObject({kind:'fresh',reason:'upgrade-session-holds-recall'});
  f.key.nativeSession+='-fresh';
  const {stampFreshSession}=await import('./testing/writetime-fixture.ts');
  stampFreshSession(db,f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  await receipts(f,1);
  expect(p.proveRetainedSession(LineageAllowance.tool(),f.key,{access:f.access,disclosed:true})).toEqual({kind:'resume'});
  expect(()=>validateMemorySchema(db)).not.toThrow();
  downgradeMemorySchema(db,13);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_checks'").get()).toBeUndefined();
  migrateMemorySchema(db,'active');expect(()=>validateMemorySchema(db)).not.toThrow();
  expect(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()!.schema_version).toBe(MEMORY_SCHEMA_VERSION);
});
