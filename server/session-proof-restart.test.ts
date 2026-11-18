// Owners: recall-s1s2g owns durable checkpoint restart; warm-keep owns native direct-session identity.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {proofWorld} from './session-proof-world.ts';
for(const fault of [false,true])it(`T-RESTART real Claude: SIGKILL ${fault?'before checkpoint commit':'between turns'} keeps the native cursor`,async()=>{
 const instrumentation=`
  const {registerHooks:proofHooks}=await import('node:module');
  proofHooks({load(url,ctx,next){const r=next(url,ctx);let s=String(r.source);
   if(url.endsWith('/server/memory/session-proof.ts'))s+=\`
    import {existsSync as proofExists,unlinkSync as proofUnlink} from 'node:fs';
    import {join as proofJoin} from 'node:path';
    import {DATA_DIR as proofData} from '../config.ts';
    setSessionProofCommitFaultForTest(()=>{const file=proofJoin(proofData,'fixture-proof-crash');if(proofExists(file)){proofUnlink(file);process.kill(process.pid,'SIGKILL');}});
   \`;
   return {...r,source:s};}});
 `;
 const w=await proofWorld('claude','none',instrumentation);try{
  const bot=await w.bot();await w.acceptedTurn(bot,'First full captured turn.');await w.acceptedTurn(bot,'Second full captured turn.');
  const old=w.session(bot.threadId);expect(old).toBeTruthy();
  const before=w.read(db=>db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=?').get(bot.threadId));expect(before).toBeTruthy();
  if(fault){writeFileSync(join(w.fixture.info.dataDir,'fixture-proof-crash'),'fixture');await w.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Crash before checkpoint commit.'});}
  else w.fixture.child.kill('SIGKILL');
  await expect.poll(()=>w.fixture.child.exitCode!==null||w.fixture.child.signalCode!==null,{timeout:15000}).toBe(true);
  expect(w.read(db=>db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=?').get(bot.threadId)?.up_to)).toBe(before!.up_to);
  await w.fixture.restart();await w.login();const at=w.log().length;
  await w.acceptedTurn(bot,'Full turn after process restart.');expect(w.session(bot.threadId)).toBe(old);
  expect(w.log().slice(at)).not.toContain('memory continuation reset');
 }finally{await w.fixture.close();}
},180000);

// MAIN RULING 1115-RECALL-GROK-Q1Q2: crash at the native event, before receipt binding or replay confirmation.
it('Q2 real Claude: a crash at session start cannot persist a false frame bit',async()=>{
 const instrumentation=`
  const {registerHooks:crashHooks}=await import('node:module');
  crashHooks({load(url,ctx,next){const r=next(url,ctx);let s=String(r.source);
   if(url.endsWith('/server/index.ts')){
    const needle='recordSessionRoots(event.threadId, lineage.instanceId, start.key.nativeSession, lineage.roots);';
    if(!s.includes(needle))throw new Error('fixture native event boundary missing');
    s=s.replace(needle,"if(fresh)process.kill(process.pid,'SIGKILL');"+needle);
   }
   return {...r,source:s};}});
 `;
 const w=await proofWorld('claude','none',instrumentation);try{
  const bot=await w.bot();
  await w.api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Crash at the first framed native event.'});
  await expect.poll(()=>w.fixture.child.signalCode,{timeout:15000}).toBe('SIGKILL');
  const rows=w.read(db=>db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_state'").get()
   ?db.prepare('SELECT had_frame FROM memory_session_state WHERE thread_id=?').all(bot.threadId):[]);
  expect(rows.length).toBeGreaterThan(0);expect(rows.every(row=>Number(row.had_frame)===1)).toBe(true);
  expect(w.read(db=>db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_checks'").get()
   ?Number(db.prepare('SELECT count(*) AS n FROM memory_session_checks WHERE thread_id=?').get(bot.threadId)!.n):0)).toBe(0);
 }finally{await w.fixture.close();}
},120000);

// MAIN RULING 1115-RECALL-GROK-Q1Q2: the normal first frame must still establish P6 under its real reader.
it('Q2 first frame: a healthy native event commits the real reader checkpoint',async()=>{
 const w=await proofWorld('claude');try{
  const bot=await w.bot();await w.acceptedTurn(bot,'A healthy first framed turn.');
  const checks=w.read(db=>db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_checks'").get()
   ?db.prepare('SELECT reader_key,up_to,view_id,view_digest FROM memory_session_checks WHERE thread_id=?').all(bot.threadId):[]);
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.every(row=>row.reader_key!=='recall-free'&&JSON.parse(String(row.reader_key))[0]===bot.id&&Number(row.up_to)>0&&row.view_id&&row.view_digest)).toBe(true);
  const states=w.read(db=>db.prepare('SELECT had_frame FROM memory_session_state WHERE thread_id=?').all(bot.threadId));
  expect(states.length).toBeGreaterThan(0);expect(states.every(row=>Number(row.had_frame)===1)).toBe(true);
 }finally{await w.fixture.close();}
},120000);
