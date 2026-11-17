// Owners: recall-s1s2g owns held-session replacement; warm-keep owns full-turn identity.
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {proofWorld} from './session-proof-world.ts';
const forcedHeld=`
 const {registerHooks:heldHooks}=await import('node:module');
 heldHooks({load(url,ctx,next){const r=next(url,ctx);let s=String(r.source);
 if(url.endsWith('/server/index.ts')) {
  const forced="if((text?.includes('Force held')||latestUser?.text?.includes('Force held'))&&!globalThis.fixtureHeldOnce){globalThis.fixtureHeldOnce=true;await recallReadiness.access(()=>{throw new RecallPreparationPending();},new AbortController().signal);}";
  s=s.replace('const {access,earlyVerdictHolds}=dispatchAccess(',forced.replace("||latestUser?.text?.includes('Force held')",'')+'const {access,earlyVerdictHolds}=dispatchAccess(');
  s=s.replace('const access=await admittedRecallAccess(recallReadiness,bot.id,threadId,internalGeneration);',forced+ 'const access=await admittedRecallAccess(recallReadiness,bot.id,threadId,internalGeneration);');
 }
 return {...r,source:s};}});
`;
for(const engine of ['claude','acp'] as const)for(const venue of ['direct','room'] as const)it(`T-G2a ${engine} ${venue}: held recall replaces the session once and full recall then stays warm`,async()=>{
 const w=await proofWorld(engine,'none',forcedHeld);
 try {
  const bot=await w.bot(),room=venue==='room'?(await w.api('POST','/api/groups',{name:'Fixture room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).group:undefined;
  const thread=room?.threadId??bot.threadId;
  const send=async(text:string)=>{
   if(!room)return w.acceptedTurn(bot,text);
   const before=(await w.api('GET',`/api/threads/${thread}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').length;
   await w.api('POST',`/api/groups/${room.id}/messages`,{text});
   await expect.poll(async()=>(await w.api('GET',`/api/threads/${thread}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').length,{timeout:45000}).toBe(before+1);
   await expect.poll(async()=>(await w.api('GET','/api/bots?messages=0')).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:15000}).not.toBe(true);
  };
  await send('Full recall first turn.');await send('Full recall second turn.');
  const before=w.session(thread),at=w.log().length;expect(before).toBeTruthy();
  await send('Force held turn.');
  const messages=await w.api('GET',`/api/threads/${thread}/messages?limit=100`);
  expect(JSON.stringify(messages)).toContain('did not use recalled memories');
  expect(w.log().slice(at).split('\n').filter(l=>l.includes('memory continuation reset')&&l.includes('held-session-holds-recall'))).toHaveLength(1);
  const cursors=w.read(db=>db.prepare('SELECT native_session FROM memory_session_lineage WHERE thread_id=?').all(thread).map(r=>String(r.native_session)));
  expect(cursors.some(s=>s!==before)).toBe(true);
  await send('Full recall after held turn.');const after=w.session(thread);expect(after).not.toBe(before);
  await send('Full recall remains warm.');expect(w.session(thread)).toBe(after);
  const dump=engine==='claude'?readFileSync(w.fixture.fixtureDumpLogPath,'utf8'):JSON.stringify(w.rpc().filter(r=>r.method==='session/prompt'));expect(dump).toBeTruthy();
 }finally{await w.fixture.close();}
},180000);
it('T-G2c: first paused turn replaces recall, the next nine paused turns keep the replacement',async()=>{
 const w=await proofWorld('claude');try{
  const bot=await w.bot();await w.turn(bot,'Full recall.');const old=w.session(bot.threadId);
  await w.api('POST','/api/memory/action',{action:'configure',mode:'paused'});
  // Isolate the recall-mode contract from the independent policy-move reset:
  // these historical receipts remain valid at the current policy watermark.
  w.write(db=>{db.prepare("UPDATE memory_disclosures SET state='delivered',policy_revision=(SELECT policy_revision FROM memory_meta WHERE id=1),deletion_epoch=(SELECT deletion_epoch FROM memory_meta WHERE id=1) WHERE thread_id=?").run(bot.threadId);db.prepare('DELETE FROM memory_deny_session WHERE thread_id=?').run(bot.threadId);db.exec('DELETE FROM memory_deny_pending;DELETE FROM memory_deny_pending_scope');});
  const at=w.log().length;
  for(let n=0;n<10;n++)await w.acceptedTurn(bot,`Paused ordinary turn ${n+1}.`);
  const log=w.log().slice(at);expect(log.split('\n').filter(l=>l.includes('memory continuation reset'))).toHaveLength(1);
  // MAIN RULING 1115-RECALL-HELD-REPLACE: the owner's paused setting can move the policy watermark first.
  expect(log).toMatch(/held-session-holds-recall|writetime-watermark/);
  const lines=log.split('\n').filter(l=>l.includes(`claude first-token thread=${bot.threadId} `));expect(lines).toHaveLength(10);
  for(const line of lines.slice(1))expect(line).toMatch(/process=reused|resumed=true/);
  expect(old).toBeTruthy();
 }finally{await w.fixture.close();}
},240000);
