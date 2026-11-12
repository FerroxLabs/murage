// SPDX-License-Identifier: AGPL-3.0-or-later
// R10c uses the real posture dispatch, hook broker, S1 capture/registration and
// automatic answer. Only the provider transport/engine and disk are fixtures.
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { fixture, d, baseRun } from '../decision/fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { CodexDriver } from './codex.ts';
import { resetIsolationCache } from './isolation-cache.ts';
import { recordEvents, type EventRecorder } from '../testing/events.ts';
import type { ProviderInstance, RequestAnswerOptions, RequestDelivery, RuntimeEvent } from '../contracts.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '../testing/fake-codex-app-server.ts');
let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, scratch: string | undefined;
const offs: Array<() => void> = [];
afterEach(async () => {
  for (const key of ['FAKE_CODEX_VERSION','FAKE_CODEX_TOOLS','FAKE_CODEX_DUMP','FAKE_CODEX_MODE','FAKE_CODEX_APPROVAL']) delete process.env[key];
  for (const off of offs.splice(0)) off();
  recorder?.stop(); await instance?.dispose(); instance=undefined;
  if(scratch) await removeTempDir(scratch); scratch=undefined;
});

async function run(changed: boolean, level: 'full' | 'unlimited' = 'unlimited', native = false, shell = false, legacyAuto = false, cache = false, detail: { multiInode?: boolean; nativeMethod?: 'applyPatchApproval'; verifyCacheReplay?:boolean; wipe?:boolean } = {}) {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nlsym-codex-')));
  const cwd = join(scratch, 'project'), home = join(scratch, 'home'), dump = join(scratch, 'dump.json');
  mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd,'out'));
  writeFileSync(join(home,'config.toml'), 'model = "gpt-fake-default"\n');
  chmodSync(fake, 0o755); resetIsolationCache();
  // Native approvals use a supported pre-hook CLI's real policy route. The
  // modern fake's approval mode intentionally sends a shell hook first.
  process.env.FAKE_CODEX_VERSION=native?'codex-cli 0.128.0':'codex-cli 0.150.0';
  process.env.FAKE_CODEX_DUMP=dump;
  const patch=['*** Begin Patch',...(detail.multiInode?[
    '*** Delete File: out/gone','*** Update File: out/old','*** Move to: out/renamed','@@','-a','+b',
    ...Array.from({length:300},(_,i)=>[`*** Add File: out/file-${i}`,'+hello']).flat(),
  ]:['*** Add File: out/notes','+hello']),'*** End Patch'].join('\n');
  const inodeTarget=join(cwd,'out','file-299'), named=join(homedir(),'.zshrc');
  if(detail.multiInode){
    expect(homedir()).toContain('murage-test-home-');
    writeFileSync(inodeTarget,'ordinary fixture bytes');writeFileSync(named,'separate fixture inode');
    onTestFinished(()=>unlinkSync(named));
  }
  // c3 requests permission before execution/item.started. Skipping a hook and
  // announcing an already-started fileChange would test the tripwire instead.
  if(native){
    process.env.FAKE_CODEX_MODE='approval';
    process.env.FAKE_CODEX_APPROVAL=JSON.stringify({method:detail.nativeMethod??'item/fileChange/requestApproval',params:{itemId:'nl-patch',cwd,fileChanges:[{path:'out/notes',kind:'add'}]}});
  }else process.env.FAKE_CODEX_TOOLS=JSON.stringify([shell?{kind:'shell',id:'nl-patch',command:detail.wipe?'rm -rf /':'printf x > out/notes',cwd,escalate:cache}:{kind:'apply_patch',id:'nl-patch',patch,cwd,escalate:cache}]);
  const nativeFrames:Array<{id?:number;result?:{decision?:string;action?:string}}>=[];
  const originalWrite=Socket.prototype.write;
  const writes=vi.spyOn(Socket.prototype,'write').mockImplementation(function(this:Socket,...args:any[]){
    const line=String(args[0]);try{const frame=JSON.parse(line);if(frame.jsonrpc==='2.0'&&frame.id!==undefined&&!frame.method&&frame.result)nativeFrames.push(frame);}catch{}
    return originalWrite.apply(this,args as any);
  } as any);
  onTestFinished(()=>writes.mockRestore());
  const f=fixture(level); let turnId='';
  instance=await CodexDriver.create({instanceId:'p',displayName:'NL fixture',environment:{CODEX_HOME:home},enabled:true,config:{cli:fake,fullAuto:true}});
  recorder=recordEvents(instance.adapter);
  const bus={subscribe:(fn:(event:RuntimeEvent)=>void)=>instance!.adapter.onEvent(event=>{
    if(event.type==='turn.started')turnId=event.turnId??'';
    fn({...event,providerInstanceId:'p'});
  })};
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',initiator:{k:'owner-typed'},roomOwnerOnly:true,at:1}),live:()=>({botId:'b',turnId,providerInstanceId:'p',principal:'owner',owner:true,level})});
  offs.push(d.installRequestIngress(bus));
  const opened: Array<Extract<RuntimeEvent,{type:'request.opened'}>>=[]; const registrations: string[]=[]; const automatic: string[]=[];
  let crossed=false;
  d.installDecisionTransport({interrupt:async()=>{},respond:async(target,answer,options)=>{
    // Deterministic barrier AFTER S1 inspected and before native finish. No
    // policy, routeDelivery, request capture or release guard is mocked.
    crossed=true;
    if(changed&&!cache) {
      if(detail.multiInode){unlinkSync(named);linkSync(inodeTarget,named);}
      else {await removeTempDir(join(cwd,'out'));symlinkSync('/etc',join(cwd,'out'));}
    }
    automatic.push(answer.behavior);
    // withRequestDelivery installs the explicit receipt overload at runtime.
    const respond=instance!.adapter.respondToRequest as unknown as (thread:string,request:string,decision:typeof answer,options:Readonly<RequestAnswerOptions>)=>Promise<RequestDelivery>;
    return respond(target.threadId,target.requestId,answer,options);
  }});
  offs.push(d.installDecisionObserver(e=>{if(e.type==='registered')registrations.push(e.actor+':'+e.level);}));
  let rebound=false;
  const cacheCard=new Promise<void>(resolve=>offs.push(f.store.onChange(()=>{
    if(d.openApprovals('t').some(a=>a.why==='deny'&&a.state==='open'))resolve();
  })));
  if(cache&&changed)offs.push(instance.adapter.onEvent(event=>{
    // A confirmed successful hook answer is required before mutation; this is
    // not a fabricated cache entry or a direct Full access shortcut witness.
    if(event.type==='request.resolved'&&event.behavior==='allow'&&!rebound){
      rebound=true;rmdirSync(join(cwd,'out'));symlinkSync('/etc',join(cwd,'out'));
    }
  }));
  const deliveries: Promise<void>[]=[];
  offs.push(instance.adapter.onEvent(event=>{
    if(event.type!=='request.opened')return;
    opened.push(event);
    const h=d.openRequest({kind:'engine',threadId:'t',requestId:event.requestId!});
    const outcome=d.decide(h,baseRun);
    if(detail.wipe){expect(outcome.kind).toBe('card');if(outcome.kind!=='card')throw Error('root wipe escaped');deliveries.push((async()=>{await d.deliverRequest(h);await d.answerApproval(outcome.ref,{behavior:'deny'});})());}
    else {expect(outcome).toEqual({kind:'run'});deliveries.push(d.deliverRequest(h));}
  }));
  const sent=await instance.adapter.sendTurn({threadId:'t',text:'fake-only',cwd,...(!legacyAuto?{stopLine:true as const,permissionNow:()=>d.readTurnPolicy({threadId:'t',generation:'g'})!.permission}:{}),...(level==='unlimited'?{noLimits:true as const}:{})});
  if(level==='full') {
    await recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId);
    const result=JSON.parse(readFileSync(dump,'utf8'));
    expect(opened).toEqual([]);
    if(native)expect(JSON.stringify(result.decision)).toMatchSnapshot();
    else expect(JSON.stringify(result.hookLog)).toMatchSnapshot();
    return;
  }
  await recorder.until(e=>e.type==='request.opened'&&e.turnId===sent.turnId);
  // Await the real automatic delivery; a guard hold must return without
  // resolving an allow hook answer or writing an accepted native frame.
  await Promise.all(deliveries);
  if(detail.wipe){await recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId);expect(automatic).toEqual(['deny']);expect(recorder.events.filter(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.ok===true)).toEqual([]);expect(d.openApprovals('t')).toEqual([]);return;}
  if(cache&&changed)await Promise.race([cacheCard,recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId)]);
  expect(crossed).toBe(true); expect(registrations).toEqual(['owner:unlimited']); expect(automatic).toEqual(['allow']);
  expect(opened).toHaveLength(1);
  if(native)expect(opened[0]).toMatchObject({tool:'edit',toolCall:{name:'edit',input:{paths:['out/notes'],cwd}}});
  if(!native) expect(opened[0]).toMatchObject(shell?{tool:'Bash',toolCall:{name:'Bash',input:{command:'printf x > out/notes'}}}:{tool:'apply_patch',toolCall:{name:'apply_patch',input:{command:patch}}});
  if(detail.multiInode){
    const extracted=extractInspectedOperation({tool:opened[0]!.toolCall!.name,input:opened[0]!.toolCall!.input});
    expect(extracted.kind).toBe('operation');
    if(extracted.kind!=='operation'||extracted.exactOperation.kind!=='native')throw new Error('missing-exact-native-operation');
    const effects=extracted.exactOperation.effects;
    expect(effects).toHaveLength(304);
    expect(effects.slice(0,4)).toMatchObject([{path:'out/gone',op:'delete',followFinal:false},{path:'out/old',op:'delete',followFinal:false},{path:'out/renamed',source:'out/old',op:'rename'},{path:'out/renamed',op:'edit'}]);
    expect(effects.at(-1)).toMatchObject({path:'out/file-299',op:'write',followFinal:true});
  }
  // A late protected-path/inode change is not a No limits hold. The real
  // native release guard must finish the exact automatic response without a card.
  expect(d.openApprovals('t')).toEqual([]);
  if(changed){
    if(detail.multiInode)expect(statSync(named).ino).toBe(statSync(inodeTarget).ino);
    else expect(realpathSync(join(cwd,'out'))).toBe('/etc');
    if(cache)expect(rebound).toBe(true);
  }
  await recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId);
  const result=JSON.parse(readFileSync(dump,'utf8'));
  if(!native)expect(result.hookLog).toMatchObject([{id:'nl-patch',verdict:'allow'}]);
  if(cache)expect(result.decision).toEqual({decision:'accept'});
  if(detail.verifyCacheReplay)expect(nativeFrames.filter(frame=>frame.id===7000)).toEqual([{jsonrpc:'2.0',id:7000,result:{decision:'accept'}}]);
  if(cache||native)expect(nativeFrames.filter(frame=>['accept','approved'].includes(frame.result?.decision??'')||frame.result?.action==='accept')).toHaveLength(1);
  expect(d.openApprovals('t')).toEqual([]);
  expect(recorder.events).toContainEqual(expect.objectContaining({type:'request.resolved',behavior:'allow'}));
  if(!native)expect(recorder.events.filter(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.itemId==='nl-patch'&&e.ok===true)).toHaveLength(1);
}
it.each([false,true])('R10c1 real NL patch hook changed=%s',changed=>run(changed));
it.each([false,true])('R10c2 real NL multi-file patch beyond cap, inode changed=%s',changed=>run(changed,'unlimited',false,false,false,false,{multiInode:true}));
it.each([false,true])('R10c shell counterpart changed=%s',changed=>run(changed,'unlimited',false,true));
it.each([false,true])('R10c3 real NL native approval changed=%s',changed=>run(changed,'unlimited',true));
it.each([false,true])('R10c3 real NL legacy applyPatchApproval changed=%s',changed=>run(changed,'unlimited',true,false,false,false,{nativeMethod:'applyPatchApproval'}));
it('R10c4 F09-Codex real Full access own-workspace shortcut',()=>run(false,'full'));
it('R10c4 F09-Codex real Full access autoAccept native approval',()=>run(false,'full',true,false,true));
it.each([false,true])('R10d real successful NL hook then final-cache replay changed=%s',changed=>run(changed,'unlimited',false,false,false,true));

it.each([false,true])('R10d real successful NL shell hook then final-cache replay changed=%s',changed=>run(changed,'unlimited',false,true,false,true));

it('R10d changed cache releases the exact waiting native RPC without a card',()=>run(true,'unlimited',false,false,false,true,{verifyCacheReplay:true}));

it('R10e literal root wipe still cards and denies before native execution',()=>run(false,'unlimited',false,true,false,false,{wipe:true}));
