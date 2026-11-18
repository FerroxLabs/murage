// Producer owner: recall-s1s2g (held/paused session proof and its index.ts call sites). Consumer owner: recall-privacy-close-b (paused workflow witness).
// GrokBuild Critical 2 at dispatch: once the owner pauses memory, a retained session that already carried recall must not be resumed.
// The first paused turn, direct or in a room, replaces it for 'held-session-holds-recall'; later paused turns keep the replacement.
import {expect,it} from 'vitest';
import {proofWorld} from './session-proof-world.ts';

for(const engine of ['claude','acp'] as const)for(const venue of ['direct','room'] as const)it(`C2 dispatch ${engine} ${venue}: a paused turn replaces a session that carried recall, then keeps the replacement`,async()=>{
 const w=await proofWorld(engine,'none');
 try {
  const bot=await w.bot(),room=venue==='room'?(await w.api('POST','/api/groups',{name:'Fixture room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}})).group:undefined;
  const thread=room?.threadId??bot.threadId;
  const replies=async()=>(await w.api('GET',`/api/threads/${thread}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text'&&m.text).length;
  const send=async(text:string)=>{
   const before=await replies();
   if(room)await w.api('POST',`/api/groups/${room.id}/messages`,{text});
   else await w.api('POST',`/api/bots/${bot.id}/messages`,{threadId:thread,text});
   await expect.poll(replies,{timeout:45000}).toBe(before+1);
   await expect.poll(async()=>(await w.api('GET','/api/bots?messages=0')).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:15000}).not.toBe(true);
  };
  const resets=(from:number)=>w.log().slice(from).split('\n').filter(l=>l.includes(`memory continuation reset thread=${thread} `));
  await send('Full recall first turn.');await send('Full recall second turn.');
  const carried=w.session(thread);expect(carried).toBeTruthy();
  await w.api('POST','/api/memory/action',{action:'configure',mode:'paused'});
  // As in T-G2c: keep the carried receipts valid at the current policy watermark, so only the paused rule can decide.
  w.write(db=>{db.prepare("UPDATE memory_disclosures SET state='delivered',policy_revision=(SELECT policy_revision FROM memory_meta WHERE id=1),deletion_epoch=(SELECT deletion_epoch FROM memory_meta WHERE id=1) WHERE thread_id=?").run(thread);db.prepare('DELETE FROM memory_deny_session WHERE thread_id=?').run(thread);});
  const at=w.log().length;
  await send('Paused ordinary turn 1.');
  const first=resets(at);
  expect(first).toHaveLength(1);
  // Direct: the paused rule decides. Room: the session-lineage verdict is still 'checking' at that turn and refuses first
  // (fail-closed, seen with capture settled or not); the room paused rule itself is proven in memory/recall-paused-privacy.test.ts.
  expect(first[0]).toMatch(venue==='room'?/ reason=room-memory-paused (held-session-holds-recall|checking)$/:/ reason=memory-paused held-session-holds-recall$/);
  const started=(from:number)=>w.log().slice(from).split('\n').filter(l=>l.includes(`claude first-token thread=${thread} `));
  if(engine==='claude')expect(started(at)).toEqual([expect.stringContaining(' resumed=false ')]);
  const cursors=w.read(db=>db.prepare('SELECT native_session FROM memory_session_lineage WHERE thread_id=?').all(thread).map(r=>String(r.native_session)));
  expect(cursors.some(s=>s!==carried)).toBe(true);
  const kept=w.log().length;
  await send('Paused ordinary turn 2.');await send('Paused ordinary turn 3.');
  expect(resets(kept)).toEqual([]);
  if(engine==='claude')expect(started(kept)).toEqual([expect.stringMatching(/process=reused|resumed=true/),expect.stringMatching(/process=reused|resumed=true/)]);
 }finally{await w.fixture.close();}
},240000);
