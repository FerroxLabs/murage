import {fixture,d,baseRun} from '../decision/fixture.ts';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createAcpDriver } from './acp/core.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';

it.each([[false, false, false], [true, false, false], [false, true, false], [false, false, true]])('R7 ACP posture before answer (permissionOnly=%s reverse=%s retry=%s)', async (permissionOnly, reverse, retry) => {
 ensureDirs();const decisionFixture=fixture('ask');let turnId='';
 const scratch = mkdtempSync(join(tmpdir(), 'posture-'));
 const cli = fileURLToPath(new URL('./testing/posture-acp.mjs', import.meta.url));
 chmodSync(cli, 0o755);
 const gate = join(scratch, 'go'), log = join(scratch, 'protocol.jsonl');
 let ask = !reverse;
 let failedRestore = false;
 const applied: boolean[] = [];
 const instance = await createAcpDriver({
  driverKind: 'postureTest', displayName: 'Posture', models: { default: '', options: [] },
  defaultCli: cli, nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: () => [gate, log, ...(permissionOnly ? ['--permission-only'] : [])],
  pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
  askStop: { sessionMode: { readOnly: 'readonly', normal: 'normal' }, apply: async ({ askLevel }) => { applied.push(askLevel); if (retry && !askLevel && !failedRestore) { failedRestore = true; throw new Error("fixture restoration failure"); } } },
 }).create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: {}, config: { cli, fullAuto: false } });
 const recorder = recordEvents(instance.adapter);
 // Posture changes still use the actual S1 registration/release bridge.
 // A bare allow cannot authorize a new No limits native operation.
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'switch',botId:'b',principal:'owner',roomOwnerOnly:true,initiator:{k:'owner-typed'},at:1}),live:()=>({botId:'b',turnId,providerInstanceId:'posture',principal:'owner',owner:true,level:ask?'ask':'unlimited'})});
 d.installDecisionTransport({interrupt:async()=>{},respond:(target,answer,options)=>(instance.adapter.respondToRequest as unknown as (t:string,r:string,a:typeof answer,o:typeof options)=>Promise<import('../contracts.ts').RequestDelivery>)(target.threadId,target.requestId,answer,options)});
 const offIngress=d.installRequestIngress({subscribe:fn=>instance.adapter.onEvent(event=>{if(event.type==='turn.started')turnId=event.turnId??'';fn({...event,providerInstanceId:'posture'});})});
 const off = instance.adapter.onEvent(e => {if(e.type==='request.opened'){const handle=d.openRequest({kind:'engine',threadId:e.threadId,requestId:String(e.requestId)});expect(d.decide(handle,baseRun)).toEqual({kind:'run'});void d.deliverRequest(handle);}});
 try {
  await instance.adapter.sendTurn({ threadId: 'switch', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  await recorder.until(e => e.type === 'content.delta');
  ask = reverse;
  expect(instance.adapter.onPostureChange).toBeTypeOf('function');
  await instance.adapter.onPostureChange!('switch');
  const beforeTool = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  expect(beforeTool.filter(x => x.method === 'session/set_mode').at(-1)?.params.modeId).toBe(reverse ? 'readonly' : 'normal');
  writeFileSync(gate, 'go');
  await recorder.until(e => e.type === 'turn.completed');
  const frames = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  expect(frames.filter(x => x.method === 'session/set_mode').map(x => x.params.modeId)).toEqual(reverse ? ['readonly'] : ['readonly', 'normal']);
  expect(applied).toEqual(reverse ? [false, true] : retry ? [true, false, false] : [true, false]);
  expect(frames.findIndex(x => x.method === 'session/set_mode' && x.params.modeId === (reverse ? 'readonly' : 'normal'))).toBeLessThan(frames.findIndex(x => x.id === 900));
  expect(frames.find(x => x.id === 900)?.result.outcome.optionId).toBe(reverse ? 'deny' : 'allow');
 } finally { off();offIngress();decisionFixture.dispose();recorder.stop(); await instance.dispose(); await removeTempDir(scratch); }
});

it.each([false,true])('BLOCK2 immutable apply closes the old PID and bounds recovery (hang=%s)', async hang => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'acp-restart-'));
 const cli = fileURLToPath(new URL('./testing/posture-acp-restart.mjs', import.meta.url)); chmodSync(cli, 0o755);
 const log = join(scratch, 'frames.jsonl'), witness = join(scratch, 'written.txt');
 let ask = true;
 const instance = await createAcpDriver({ driverKind:'restartTest', displayName:'Restart', models:{default:'',options:[]},
  defaultCli:cli, nativeSource:'test.acp', loginNote:'unused', spawnArgs:()=>[], pickAuthMethod:()=>null, authFailure:'continue', isAuthenticated:()=>true,
  askStop:{ apply:async ({ env, askLevel }) => { env.POSTURE_READONLY = askLevel ? '1' : '0'; } },
 }).create({ instanceId:'restart', displayName:'Restart', enabled:true, environment:{POSTURE_LOG:log,POSTURE_WITNESS:witness,POSTURE_HANG_NORMAL:hang?'1':'0'}, config:{cli,fullAuto:false} });
 const recorder = recordEvents(instance.adapter);
 try {
  await instance.adapter.sendTurn({threadId:'restart',cwd:fixtureBotFolder(),text:'fixture',askLevel:true,routeAsks:true,
   permissionNow:()=>ask ? {askLevel:true,routeAsks:true} : {noLimits:true,stopLine:true} });
  await recorder.until(e=>e.type==='content.delta'); ask=false;
  const changed = instance.adapter.onPostureChange!('restart');
  const duplicate = instance.adapter.onPostureChange!('restart'); void duplicate.catch(()=>{});
  if (hang) {
   await expect(changed).rejects.toThrow('posture recovery deadline');
   await expect(duplicate).rejects.toThrow('posture recovery deadline');
  } else await Promise.all([changed,duplicate]);
  await recorder.until(e=>e.type==='turn.completed');
  const frames = readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const launches = frames.filter(f=>f.launch);
  expect(launches).toHaveLength(hang?3:2); expect(launches.map(f=>f.readonly)).toEqual(hang?[true,false,false]:[true,false]);
  expect(launches[0].pid).not.toBe(launches[1].pid);
  expect(()=>process.kill(launches[0].pid,0)).toThrow();
  if (hang) { expect(frames.filter(f=>f.method==='session/prompt')).toHaveLength(1); expect(recorder.events.find(e=>e.type==='turn.completed')?.ok).toBe(false); expect(recorder.events.filter(e=>e.type==='runtime.error' && e.message==='The engine did not acknowledge the changed permission level.')).toHaveLength(1); return; }
  expect(frames.filter(f=>f.method==='session/prompt')).toHaveLength(2);
  expect(frames.filter(f=>f.method==='session/prompt')[1].params.prompt[0].text).toMatch(/retry/i);
  expect(readFileSync(witness,'utf8')).toContain('replacement process');
 } finally { recorder.stop();await instance.dispose();await removeTempDir(scratch); }
},30000);

async function epochFixture(env:Record<string,string>,run:(ctx:{instance:any;recorder:ReturnType<typeof recordEvents>;scratch:string;log:string;witness:string;set:(v:boolean)=>void;change:()=>Promise<void>})=>Promise<void>){
 ensureDirs();const scratch=mkdtempSync(join(tmpdir(),'acp-epochs-'));
 const cli=fileURLToPath(new URL('./testing/posture-acp-restart.mjs',import.meta.url));chmodSync(cli,0o755);
 const log=join(scratch,'frames.jsonl'),witness=join(scratch,'written.txt');let ask=true;
 const instance=await createAcpDriver({driverKind:'epochTest',displayName:'Epoch',models:{default:'',options:[]},defaultCli:cli,nativeSource:'test.acp',loginNote:'unused',spawnArgs:()=>[],pickAuthMethod:()=>null,authFailure:'continue',isAuthenticated:()=>true,askStop:{apply:async({env,askLevel})=>{env.POSTURE_READONLY=askLevel?'1':'0';}}}).create({instanceId:'epoch',displayName:'Epoch',enabled:true,environment:{POSTURE_LOG:log,POSTURE_WITNESS:witness,POSTURE_FINISH:join(scratch,'finish'),...env},config:{cli,fullAuto:false}});
 const recorder=recordEvents(instance.adapter);const oldDir=process.env.MURAGE_DATA_DIR,oldTap=process.env.MURAGE_GATE_TAP;process.env.MURAGE_DATA_DIR=scratch;process.env.MURAGE_GATE_TAP='1';
 try {await instance.adapter.sendTurn({threadId:'epoch',cwd:fixtureBotFolder(),text:'fixture',askLevel:true,routeAsks:true,permissionNow:()=>ask?{askLevel:true,routeAsks:true}:{noLimits:true,stopLine:true}});await recorder.until(e=>e.type==='content.delta');await run({instance,recorder,scratch,log,witness,set:v=>{ask=v;},change:()=>instance.adapter.onPostureChange!('epoch')});}
 finally{recorder.stop();await instance.dispose();if(oldDir===undefined)delete process.env.MURAGE_DATA_DIR;else process.env.MURAGE_DATA_DIR=oldDir;if(oldTap===undefined)delete process.env.MURAGE_GATE_TAP;else process.env.MURAGE_GATE_TAP=oldTap;await removeTempDir(scratch);}
}
it('T5a unlimited successful owner posture epochs in one continued turn',async()=>{
 await epochFixture({},async c=>{
  for(const level of [false,true,false]){c.set(level);await expect(c.change()).resolves.toBeUndefined();}
  const frames=readFileSync(c.log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  expect(frames.filter(f=>f.launch).map(f=>f.readonly)).toEqual([true,false,true,false]);
  expect(readFileSync(c.witness,'utf8')).toContain('replacement process');
  expect(readFileSync(join(c.scratch,'nolim-protocol.ndjson'),'utf8').split('\n').filter(s=>s.includes('"native":"replacement-session"'))).toHaveLength(3);
  writeFileSync(join(c.scratch,'finish'),'go');await c.recorder.until(e=>e.type==='turn.completed');
  expect(c.recorder.events.find(e=>e.type==='turn.completed')?.ok).toBe(true);
 });
},30000);
it('T5b one failed replacement retries and acknowledges',async()=>{
 await epochFixture({FAIL_SPAWNS:'1'},async c=>{c.set(false);await expect(c.change()).resolves.toBeUndefined();expect(readFileSync(c.log,'utf8').split('\n').filter(s=>s.includes('"launch":true'))).toHaveLength(3);expect(c.recorder.events.filter(e=>e.type==='runtime.error')).toHaveLength(0);});
},30000);
it('T5c two failed replacements exhaust exactly once without a hang',async()=>{
 await epochFixture({FAIL_SPAWNS:'2'},async c=>{c.set(false);await expect(c.change()).rejects.toThrow();await c.recorder.until(e=>e.type==='turn.completed');expect(c.recorder.events.find(e=>e.type==='turn.completed')?.stopReason).toBe('posture-recovery-exhausted');expect(c.recorder.events.filter(e=>e.type==='runtime.error'&&e.message==='The engine did not acknowledge the changed permission level.')).toHaveLength(1);expect(readFileSync(c.log,'utf8').split('\n').filter(s=>s.includes('"launch":true'))).toHaveLength(3);});
},30000);
it('T5d failure budget resets after each successful posture epoch',async()=>{
 await epochFixture({FAIL_PATTERN:'2,4'},async c=>{c.set(false);const changed=c.change();void changed.catch(()=>{});await expect.poll(()=>readFileSync(c.log,'utf8').split('\n').filter(s=>s.includes('"launch":true')).length,{timeout:5000,interval:1}).toBeGreaterThanOrEqual(3);c.set(true);await expect(changed).resolves.toBeUndefined();expect(readFileSync(c.log,'utf8').split('\n').filter(s=>s.includes('"launch":true'))).toHaveLength(5);expect(c.recorder.events.filter(e=>e.type==='runtime.error')).toHaveLength(0);});
},30000);
it('T5e latest level during restart is rechecked after ready',async()=>{
 await epochFixture({},async c=>{c.set(false);const changing=c.change();void changing.catch(()=>{});await expect.poll(()=>readFileSync(c.log,'utf8').split('\n').filter(s=>s.includes('"launch":true')).length,{timeout:5000,interval:1}).toBeGreaterThanOrEqual(2);c.set(true);await expect(changing).resolves.toBeUndefined();const launches=readFileSync(c.log,'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(f=>f.launch);expect(launches.map(f=>f.readonly)).toEqual([true,false,true]);expect(readFileSync(join(c.scratch,'nolim-protocol.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.type==='posture.ack').map(x=>x.level)).toEqual(['unlimited','ask']);});
},30000);
