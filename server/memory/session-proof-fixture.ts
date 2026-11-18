import { FreshReplaySessionConfirmation } from './fresh-replay-session.ts';
import { captureSendReplayProof } from './replay-lineage.ts';
// Owners: recall-s1s2g owns proof production and these consumers; warm-keep owns the warm contract.



import { database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';

import * as policy from './policy.ts';

import { prepareRecallContextSync, stopRecallViewMaintenance } from './recall-view.ts';
import { setMemoryMode } from './repository.ts';
import { buildMemoryBundle } from './bundle.ts';
import { prepareMemoryDisclosure, bindMemoryDisclosureSession, deliverMemoryDisclosure } from './disclosures.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { stampFreshSession, WritetimeFixture } from './testing/writetime-fixture.ts';
import { retainedSessionInvalid } from './dispatch.ts';

// Baseline adapter exercises the old room decision, so privacy reproductions
// fail on the actual retained-session behavior before the new API exists.
export async function proofModule() {
  const url = new URL('./session-proof.ts', import.meta.url).href;
  try { return await import(/* @vite-ignore */ url); }
  catch(error) {
    if (!(error instanceof Error) || !/session-proof|Failed to load|Cannot find/.test(error.message)) throw error;
    return { proveRetainedSession(a: LineageAllowance, k: any, ctx: any) {
      const why: {reason?: string} = {};
      const bad = retainedSessionInvalid(a,k.threadId,k.driverInstance,k.nativeSession,why,ctx.reader);
      return bad ? {kind:'fresh',reason:why.reason,cause:'denied'} : {kind:'resume'};
    }, sessionProofMeter: () => ({ rows: Infinity, seeks: Infinity, path:'baseline' }) };
  }
}
export function setupProofFixture(threadId = 'room-thread', notOwnerAudience=false) {
  const fixture=new WritetimeFixture(database());fixture.cert(true).ready(threadId,true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
  const roster: policy.MemoryRoster = {memoryRosterRevision:1,bots:[{id:'reader',threadId:'direct',tasks:[{threadId:'older'}]}],groups:[{id:'room',threadId:'room-thread',memberIds:['reader']}]};
  setMemoryMode('active'); policy.reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin('reader',threadId,'generation');
  const token=registry.mint({botId:'reader',threadId,generation:'generation',depth:0,kind:'memory',skillAuthoring:false,...(notOwnerAudience?{notOwnerAudience:true}:{})});
  const issue=()=>{prepareRecallContextSync('reader',threadId,roster,notOwnerAudience);stopRecallViewMaintenance();return policy.memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);};
  const access=issue(), key={threadId,driverInstance:'engine',nativeSession:'session'};
  stampFreshSession(database(),threadId,'engine','session');
  return {roster,registry,issue,access,key};
}
export async function receipts(f: ReturnType<typeof setupProofFixture>, n: number, _start=0) {
  const ids:string[]=[];
  const db=database();
  const newSession=!db.prepare('SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  // An explicit live provider event is part of this isolated fixture's birth.
  // Passing a boolean alone to the initialization API supplies no authority.
  const confirmation=newSession?new FreshReplaySessionConfirmation(captureSendReplayProof(f.key.threadId,[]),f.key.driverInstance,()=>policy.assertMemoryAccess(f.access),{generation:f.access.generation}):undefined;
  confirmation?.sessionStarted('fixture-live-turn',f.key,true);
  if(newSession) {
    const p=await proofModule();
    if(p.initializeFreshSessionProof) {
      const state=await import('./session-proof-schema.ts');
      state.noteSessionFrame(db,f.key,false);
      p.initializeFreshSessionProof(f.key,f.access,undefined,{fresh:true,confirmation});
    }
  }
  for(let i=0;i<n;i++) {
    const bundle=await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()});
    prepareMemoryDisclosure(bundle,f.access,f.key.driverInstance);
    // MAIN RULING 1115-RECALL-GROK-Q1Q2: initialize from the live first frame, with the real reader and view.
    const bind=()=>{bindMemoryDisclosureSession(bundle.bundleId,f.key.nativeSession);deliverMemoryDisclosure(bundle.bundleId,f.access);};
    const p=await proofModule();if(i===0&&p.initializeFreshSessionProof)p.initializeFreshSessionProof(f.key,f.access,bind,{fresh:true,confirmation});else bind();
    ids.push(bundle.bundleId);
  }
  // MAIN RULING 1115-RECALL-GROK-Q1Q2: callers may still finish the fixture's
  // first receipt references. Leave that prefix unjudged for the real check,
  // preserving the live reader/view certificate and all privacy assertions.
  if(newSession&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_checks'").get())db.prepare('UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?').run(f.key.threadId,f.key.driverInstance,f.key.nativeSession);
  return ids;
}
