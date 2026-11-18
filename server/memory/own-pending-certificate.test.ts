// Producer and submission-check consumer owner: recall-s1s2j under MAIN RULING 1115-RECALL-GROK-Q1Q2.
// Replay primitive owner: new3-g5; accepted-write correlation owner: tri3-g7-d.
import {mkdirSync,readFileSync} from 'node:fs';
import {beforeEach,afterEach,expect,it} from 'vitest';
import {DATA_DIR} from '../config.ts';
import {database,closeDatabase} from '../database.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {SendAttemptStore} from '../send-attempt-state.ts';
import {FreshReplaySessionConfirmation} from './fresh-replay-session.ts';
import {captureSendReplayProof,confirmFreshReplaySession,sendReplaySessionCurrent,forgetSendReplaySessionProof,replaceConfirmedReplayProof,replaySessionStateForTest,lastReplaySessionConservativeForTest} from './replay-lineage.ts';
import {setupProofFixture,proofModule,receipts} from './session-proof-fixture.ts';
import {stopRecallViewMaintenance} from './recall-view.ts';
import {LineageAllowance} from './lineage-allowance.ts';
import {buildMemoryBundle} from './bundle.ts';
import {MemoryDispatchReceipt} from './dispatch.ts';
import {sessionKeyOf} from './session-incarnation.ts';
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
afterEach(()=>{stopRecallViewMaintenance();closeDatabase();});
async function world(includeOwn=false){
 const f=setupProofFixture('direct'),db=database();await receipts(f,1);
 const attempts=new SendAttemptStore(db),row=attempts.create({ownerId:'owner',botId:'reader',threadId:'direct',sendId:'own-send',fingerprint:'fixture'});
 attempts.link(row.attemptId,'own-line');
 const keys=attempts.bind([row.attemptId],{generation:'generation',providerInstanceId:'engine'});
 for(const [thread,id,json] of [['direct','history',{}],['source','origin',{}],['other-source','origin',{}],['direct','copy',{copyOf:{threadId:'source',messageIds:['origin']}}]] as const)
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text','fixture',?)").run(thread,id,JSON.stringify(json));
 const retained=captureSendReplayProof('direct',['history','copy',...(includeOwn?['own-line']:[])]);
 confirmFreshReplaySession('direct','engine','session',retained,{generation:'previous',turnId:'previous-turn'});
 let live=true;
 const confirmation=new FreshReplaySessionConfirmation(captureSendReplayProof('direct',['own-line']),'engine',()=>{if(!live)throw new Error('stale generation');},
  {ownMessageIds:['own-line'],ownAttemptKeys:keys,retainedSession:'session',generation:'generation'} as any);
 const receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',f.access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),f.access,'engine');receipt.resumes('session');
 const attach=()=>{expect(typeof (receipt as any).submissionReplayConfirmation).toBe('function');(receipt as any).submissionReplayConfirmation(confirmation);};
 const release=()=>confirmation.ownEligibilityChange(()=>attempts.releaseWrite(keys[0]!,attempts.byId(row.attemptId)!.revision,1));
 return {f,db,attempts,row,keys,retained,confirmation,receipt,attach,release,stale:()=>{live=false;}};
}
it('Q1 own releaseWrite passes only its submission boundary, keeps pending blocked, then acknowledge permits prepare',async()=>{
 const w=await world(),p=await proofModule();w.attach();w.release();
 expect(sendReplaySessionCurrent('direct','engine','session')).toBe(false);
 expect(()=>w.receipt.assertCurrent(true)).not.toThrow();expect(()=>w.receipt.accepted()).not.toThrow();
 expect(sendReplaySessionCurrent('direct','engine','session')).toBe(false);
 expect(p.proveRetainedSession(LineageAllowance.tool(),w.f.key,{access:w.f.access,disclosed:true})).toMatchObject({kind:'fresh',reason:'send-replay-changed'});
 const key=w.attempts.allocateProvider(w.keys[0]!,w.attempts.byId(w.row.attemptId)!.revision,'own-turn');
 w.confirmation.ownEligibilityChange(()=>w.attempts.acknowledge(key,w.attempts.byId(w.row.attemptId)!.revision));
 expect(sendReplaySessionCurrent('direct','engine','session')).toBe(true);
 expect(p.proveRetainedSession(LineageAllowance.tool(),w.f.key,{access:w.f.access,disclosed:true})).toEqual({kind:'resume'});
});
for(const kind of ['foreign-message','second-attempt','stale-generation','other-session','other-incarnation','invalid','R1','R2','ancestry','exclusion','copy-root','foreign-epoch','newly-excluded','epoch-without-key','restart-blocked'] as const)it(`Q1 rejects ${kind}`,async()=>{
 const w=await world();w.attach();
 w.release();
 if(kind==='stale-generation')w.stale();
 if(kind==='other-session')w.receipt.resumes('other-session');
 // MAIN RULING 1115-RECALL-GROK-Q1Q2: exercise the real S6 incarnation encoding.
 if(kind==='other-incarnation')w.receipt.resumes(sessionKeyOf('direct','engine','session',2).nativeSession);
 if(kind==='R2')forgetSendReplaySessionProof('direct','engine','session');
 if(kind==='restart-blocked'){
  expect(w.db.prepare("SELECT json FROM send_replay_session_nodes WHERE thread_id='direct' AND driver_instance='engine' AND native_session='session' AND kind='blocked'").get()?.json).toBe('true');
  closeDatabase();const access=w.f.issue();
  w.receipt=new MemoryDispatchReceipt(await buildMemoryBundle('',access,{async search(){return {hits:[],vectorRows:0};}},{allowance:LineageAllowance.tool()}),access,'engine');w.receipt.resumes('session');(w.receipt as any).submissionReplayConfirmation(w.confirmation);
  expect(sendReplaySessionCurrent('direct','engine','session')).toBe(false);
 }
 if(kind==='invalid'||kind==='R1'){
  const row=w.attempts.create({ownerId:'owner',botId:'reader',threadId:'direct',sendId:'history-send',fingerprint:'fixture'});w.attempts.link(row.attemptId,'history');
  expect(replaySessionStateForTest('direct','engine','session')?.invalid).toBe(true);
  expect(lastReplaySessionConservativeForTest()).toBe('R1');
 }
 if(kind==='ancestry'){
  w.db.prepare("UPDATE messages SET json=? WHERE id='copy'").run(JSON.stringify({copyOf:{threadId:'other-source',messageIds:['origin']}}));
  w.db.exec("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='direct'");
 }
 if(kind==='copy-root')replaceConfirmedReplayProof(w.retained,captureSendReplayProof('direct',['history','copy'],new Map([['history',[{threadId:'other-source',messageId:'origin'}]]])),[]);
 if(kind==='foreign-epoch')w.db.exec("INSERT INTO send_replay_epochs VALUES('source',1) ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1");
 if(kind==='exclusion'||kind==='newly-excluded'){
  w.db.prepare("INSERT OR REPLACE INTO send_replay_exclusions VALUES('direct',?,?,'uncertain',1)").run(kind==='exclusion'?'history':'own-line','unexpected-attempt');
  w.db.exec("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='direct'");
 }
 if(kind==='epoch-without-key')w.db.exec("UPDATE send_replay_epochs SET revision=revision+1 WHERE thread_id='direct'");
 if(kind==='foreign-message'||kind==='second-attempt'){
  const row=w.attempts.create({ownerId:'owner',botId:'reader',threadId:'direct',sendId:'other-send',fingerprint:'fixture'});w.attempts.link(row.attemptId,kind==='foreign-message'?'foreign-line':'second-line');
  const keys=w.attempts.bind([row.attemptId],{generation:'generation',providerInstanceId:'engine'});w.attempts.releaseWrite(keys[0]!,w.attempts.byId(row.attemptId)!.revision,1);
 }
 expect(()=>w.receipt.assertCurrent(true)).toThrow('MEMORY_CONTEXT_REVOKED');
});
for(const route of ['prepare','steer','fence','room','recall-free','later-turn'] as const)it(`Q1 certificate never authorizes ${route}`,async()=>{
 const w=await world(),p=await proofModule();w.attach();w.release();
 // MAIN RULING 1115-RECALL-GROK-Q1Q2: preparation has no check-local waiver.
 expect(()=>w.receipt.assertCurrent()).toThrow('MEMORY_CONTEXT_REVOKED');
 expect(()=>w.receipt.accepted(false)).toThrow('MEMORY_CONTEXT_REVOKED');
 expect(w.receipt.steerable()).toBe(false);
 const ctx=route==='recall-free'?{access:undefined,reader:{audience:null},disclosed:true}:{access:w.f.access,disclosed:true};
 expect(p.proveRetainedSession(LineageAllowance.tool(),w.f.key,{...ctx,certificate:w.confirmation,route}).kind).toBe('fresh');
});

it('Q1 owned id already in the candidate set cannot acquire a pending waiver',async()=>{
 const w=await world(true);w.attach();w.release();expect(()=>w.receipt.assertCurrent(true)).toThrow('MEMORY_CONTEXT_REVOKED');
});
it('Q1 a conflicting attempt at the same pending node cannot reuse the certificate',async()=>{
 const w=await world();w.attach();w.release();
 // Model the old attempt releasing its line identity before a successor links it.
 w.db.prepare('UPDATE send_attempts SET message_id=NULL WHERE attempt_id=?').run(w.row.attemptId);
 const row=w.attempts.create({ownerId:'owner',botId:'reader',threadId:'direct',sendId:'conflicting-send',fingerprint:'fixture'});w.attempts.link(row.attemptId,'own-line');
 expect(()=>w.receipt.assertCurrent(true)).toThrow('MEMORY_CONTEXT_REVOKED');
});
it('Q1 the 4096 pending cap epoch bump without a new pending key refuses',async()=>{
 const w=await world();w.attach();w.release();
 w.attempts.transaction(()=>{
  for(let n=1;n<=4096;n++){
   const row=w.attempts.create({ownerId:'owner',botId:'reader',threadId:'direct',sendId:'cap-'+n,fingerprint:'fixture'});w.attempts.link(row.attemptId,'cap-line-'+n);
   const keys=w.attempts.bind([row.attemptId],{generation:'generation',providerInstanceId:'engine'});
   w.attempts.releaseWrite(keys[0]!,w.attempts.byId(row.attemptId)!.revision,1);
  }
 });
 const state=replaySessionStateForTest('direct','engine','session');expect(state?.pending).toHaveLength(4096);expect(state?.invalid).toBe(true);
 expect(()=>w.receipt.assertCurrent(true)).toThrow('MEMORY_CONTEXT_REVOKED');
},45000);
it('Q1 only dispatch submission checks consume the waiver',()=>{
 const dispatch=readFileSync(new URL('./dispatch.ts',import.meta.url),'utf8'),index=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
 expect(dispatch.slice(dispatch.indexOf('steerable(): boolean'),dispatch.indexOf('accepted(submission='))).not.toContain('AtSubmission');
 expect(index.match(/submissionReplayConfirmation\(replayConfirmation\)/g)).toHaveLength(1);
 expect(index.slice(index.indexOf('const prepareRoomMemory=async'))).not.toContain('submissionReplayConfirmation(');
});

it('K-Q2-live-event: freshness is bound to the exact key, generation and accepted provider turn',async()=>{
 const w=await world();
 w.confirmation.sessionStarted('fresh-turn',w.f.key,true);
 expect(w.confirmation.firstFrameSessionCurrent(w.f.key,'generation')).toBe(true);
 expect(w.confirmation.firstFrameSessionCurrent({...w.f.key,nativeSession:'other-incarnation'},'generation')).toBe(false);
 expect(w.confirmation.firstFrameSessionCurrent(w.f.key,'other-generation')).toBe(false);
 w.confirmation.accepted('different-provider-turn');
 expect(w.confirmation.firstFrameSessionCurrent(w.f.key,'generation')).toBe(false);
 w.stale();
 expect(w.confirmation.firstFrameSessionCurrent(w.f.key,'generation')).toBe(false);
});

// MAIN RULING recall-k: preparation validates without delivery evidence.
it('K-S1-preparation: validation cannot deliver the frame or notify delivery listeners',async()=>{
 const w=await world();w.attach();let deliveries=0;w.receipt.addOnDelivered(()=>deliveries++);
 const row=()=>w.db.prepare('SELECT state,native_session FROM memory_disclosures WHERE bundle_id=?').get(w.receipt.bundle.bundleId);
 const before=row();expect(before?.state).toBe('prepared');
 w.receipt.accepted(false);w.receipt.accepted(false);
 expect(row()).toEqual(before);expect(deliveries).toBe(0);
 w.release();w.receipt.accepted(true);w.receipt.accepted(true);
 expect(row()?.state).toBe('delivered');expect(deliveries).toBe(1);
 expect(()=>w.receipt.accepted(false)).toThrow('MEMORY_CONTEXT_REVOKED');
});
