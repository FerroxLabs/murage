import { AsyncResource } from 'node:async_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UnifiedBrowserController } from './browser-control.ts';
import { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';
import { BrowserModeTransition, type BrowserChoiceBot, type DirectReservation } from './browser-mode-transition.ts';
import { browserOwnerSessionRequest } from './browser-owner-session.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))removeTempDirSync(dir);});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'murage-interleavings-'));dirs.push(dir);
 const native={protected:async()=>false,connect:vi.fn(async()=>'stream'),request:vi.fn(async()=>({})),command:vi.fn(async()=>({})),close:vi.fn(async()=>{}),input(){},resetStream(){}};
 const controller=new UnifiedBrowserController({stateFile:join(dir,'control.json'),createNative:()=>native});const spec={command:'fixture',args:[],env:{}};
 await controller.register('a',spec);await controller.connect('a');
 const lifecycle=new BrowserLifecycleGate();const bots:BrowserChoiceBot[]=[{id:'a',name:'Ava',browserMode:'builtin',selectionRevision:0},{id:'b',name:'Kai',browserMode:'builtin',selectionRevision:0,browserProfile:'b'}];
 let reservation:DirectReservation|undefined;
 const transition=new BrowserModeTransition({lifecycle,sessions:controller.sessionGate,bot:id=>bots.find(b=>b.id===id),bots:()=>bots,reservation:()=>reservation,
 write:(id,patch,r)=>{Object.assign(bots.find(b=>b.id===id)!,patch);reservation=r;},key:bot=>bot.browserMode==='chrome-extension'?null:bot.browserProfile??bot.id,blocksCommit:key=>controller.blocksCommit(key),paused:()=>false,destinationContext:()=>({profiles:[{id:'a',name:'A'},{id:'b',name:'B'}]}),release:async(_id,release)=>{if(release.key)await controller.forgetEntry(release.key);}});
 const choice=(id:string,mode:'builtin'|'chrome-extension',profile?:string)=>{const p=transition.preview(id,{mode,profile});return{mode,profile,baseRevision:bots.find(b=>b.id===id)!.selectionRevision!,disclosureKey:p.disclosure.disclosureKey};};
 const owner=(id='a')=>({controller,lifecycle,bot:()=>bots.find(b=>b.id===id),currentKey:()=>{const b=bots.find(b=>b.id===id)!;return b.browserMode==='chrome-extension'?null:b.browserProfile??id;},bind:async()=>({key:id}),owner:'person',canReclaim:true,active:()=>true,afterHoldEnded:(key:string)=>transition.afterHoldEnded(key)});
 return{controller,native,lifecycle,transition,bots,choice,owner,spec};
}
it('T14/T19 a held pending choice applies after Hand back without waiting on trailing refresh',async()=>{
 const f=await fixture();await f.controller.take('a','person');await f.lifecycle.admitTurn('a','turn',async()=>{});
 expect(await f.transition.applyBrowserChoice('a',f.choice('a','chrome-extension'))).toMatchObject({queued:true});
 await f.lifecycle.releaseTurn('turn');expect(f.bots[0]!.browserMode).toBe('builtin');
 const status=f.controller.status('a');const answer=await browserOwnerSessionRequest(f.owner(),'POST',{action:'release',generation:status.generation,control:status.control,expectedKey:'a',expectedRevision:0});
 expect(answer.held).toBe(false);await f.lifecycle.run('a',()=>{});expect(f.bots[0]!.browserMode).toBe('chrome-extension');expect(f.controller.holdState('a')).toBeNull();
},10000);
it('T15/T6 delayed owner body cannot take the old key after C',async()=>{
 const f=await fixture(),body={action:'take',expectedKey:'a',expectedRevision:0};await f.transition.applyBrowserChoice('a',f.choice('a','builtin','b'));
 await expect(browserOwnerSessionRequest(f.owner(),'POST',body)).rejects.toMatchObject({code:'revision_changed'});expect(f.controller.holdState('a')?.held??false).toBe(false);
},10000);
it('T9/T10 take drains outside the gate and fences an in-flight dispatch',async()=>{
 const f=await fixture(),entered=deferred(),finish=deferred();f.native.request.mockImplementation(async()=>{entered.resolve();await finish.promise;return {};});
 const dispatch=f.controller.dispatch('a','tools/call',{name:'agent_browser_snapshot'},()=>true);await entered.promise;
 const take=f.controller.take('a','person');await f.controller.sessionGate.run(['a'],()=>{expect(f.controller.holdState('a')?.held).toBe(true);});
 finish.resolve();expect((await Promise.allSettled([dispatch,take]))[0]!.status).toBe('rejected');expect(f.controller.holdState('a')?.held).toBe(true);
},10000);
it('T13 two forgets serialize behind the native close and never recreate it',async()=>{
 const f=await fixture(),entered=deferred(),finish=deferred();f.native.close.mockImplementation(async()=>{entered.resolve();await finish.promise;});
 const one=f.controller.forgetEntry('a');await entered.promise;const two=f.controller.forgetEntry('a');expect(f.controller.holdState('a')?.forgetting).toBe(true);finish.resolve();await Promise.all([one,two]);expect(f.native.close).toHaveBeenCalledTimes(1);expect(f.controller.holdState('a')).toBeNull();
},10000);
it('T8 opposite two-key changes complete for 100 seeded schedules',async()=>{
 let seed=134;
 for(let i=0;i<100;i++){
  const f=await fixture();await f.controller.register('b',f.spec);
  const original=f.controller.sessionGate.run.bind(f.controller.sessionGate);
  vi.spyOn(f.controller.sessionGate,'run').mockImplementation(async(keys,fn)=>{seed=(seed*1664525+1013904223)>>>0;for(let n=seed%4;n;n--)await Promise.resolve();return original(keys,fn);});
  await Promise.all([f.transition.applyBrowserChoice('a',f.choice('a','builtin','b')),f.transition.applyBrowserChoice('b',f.choice('b','builtin','a'))]);
  expect(f.bots.map(b=>b.browserProfile)).toEqual(['b','a']);
 }
},15000);
it('M40s owner takes lifecycle before session, so a competing commit can finish',async()=>{
 const f=await fixture(),entered=deferred(),proceed=deferred();
 const commit=f.lifecycle.run('a',async()=>{entered.resolve();await proceed.promise;await f.controller.sessionGate.run(['a'],()=>{});});await entered.promise;
 const take=browserOwnerSessionRequest(f.owner(),'POST',{action:'take',expectedKey:'a',expectedRevision:0});
 await new Promise(resolve=>setTimeout(resolve,20));proceed.resolve();await Promise.all([commit,take]);
},2000);
it('M49s hold-end hook runs after both acquisition gates are released',async()=>{
 const f=await fixture();await f.controller.take('a','person');const hooks:Promise<unknown>[]=[];
 const options={...f.owner(),afterHoldEnded:()=>{hooks.push(f.lifecycle.run('a',()=>f.controller.sessionGate.run(['a'],()=>{})).catch(error=>error));}};
 const held=f.controller.status('a');await browserOwnerSessionRequest(options,'POST',{action:'release',expectedKey:'a',expectedRevision:0,control:held.control});expect(await Promise.all(hooks)).toEqual([undefined]);
},2000);
it('T7/M38s recovery of a held old route keeps the native and marker until Hand back',async()=>{
 const f=await fixture();Object.assign(f.bots[0]!,{browserMode:'chrome-extension',selectionRevision:1,browserRelease:{mode:'builtin',revision:0,key:'a'}});
 await f.controller.take('a','person');expect(await f.transition.recover('a')).toBe(false);expect(f.native.close).not.toHaveBeenCalled();expect(f.bots[0]!.browserRelease?.key).toBe('a');
 const held=f.controller.status('a');await f.controller.release('a','person',held.generation,held.control);f.transition.afterHoldEnded('a');await f.lifecycle.run('a',()=>{});expect(f.bots[0]!.browserRelease).toBeUndefined();expect(f.native.close).toHaveBeenCalledTimes(1);
},2000);
it.each(['take','reclaim','forgetEntry'] as const)('T10 %s fences the pending dispatch and drains without owning the session gate',async action=>{
 const f=await fixture(),entered=deferred(),finish=deferred();f.native.request.mockImplementation(async()=>{entered.resolve();await finish.promise;return {};});
 const dispatch=f.controller.dispatch('a','tools/call',{name:'agent_browser_snapshot'},()=>true);const done=dispatch.catch(error=>error);await entered.promise;
 const actionDone=action==='forgetEntry'?f.controller.forgetEntry('a'):f.controller[action]('a','person');await f.controller.sessionGate.run(['a'],()=>{});finish.resolve();await actionDone;expect(await done).toBeInstanceOf(Error);
},2000);
for(const stage of ['before-lifecycle','before-session','after-final-probe','during-release','after-commit'] as const)for(const destination of ['builtin','chrome-extension'] as const){
 it(`T6 deterministic commit/take ${stage} -> ${destination}`,async()=>{
  const f=await fixture(),choice=f.choice('a',destination,destination==='builtin'?'b':undefined);
  const body={action:'take',expectedKey:'a',expectedRevision:0};
  if(stage==='before-lifecycle'){
   await browserOwnerSessionRequest(f.owner(),'POST',body);
   await expect(f.transition.applyBrowserChoice('a',choice)).rejects.toMatchObject({code:'held'});
   expect(f.bots[0]!.selectionRevision).toBe(0);return;
  }
  if(stage==='before-session'){
   const original=f.controller.sessionGate.run.bind(f.controller.sessionGate),entered=deferred(),finish=deferred();let once=true;
   vi.spyOn(f.controller.sessionGate,'run').mockImplementation(async(keys,fn)=>{if(once){once=false;entered.resolve();await finish.promise;}return original(keys,fn);});
   const commit=f.transition.applyBrowserChoice('a',choice).catch(error=>error);await entered.promise;
   // Another owner entry point already passed its lifecycle admission on a shared key.
   await f.controller.take('a','person');finish.resolve();expect(await commit).toMatchObject({code:'held'});
   expect(f.bots[0]!.selectionRevision).toBe(0);return;
  }
  if(stage==='during-release'){
   const entered=deferred(),finish=deferred();f.native.close.mockImplementation(async()=>{entered.resolve();await finish.promise;});
   const commit=f.transition.applyBrowserChoice('a',choice);await entered.promise;
   const take=browserOwnerSessionRequest(f.owner(),'POST',body).catch(error=>error);
   expect(f.controller.holdState('a')?.held).toBe(false);finish.resolve();await commit;expect(await take).toMatchObject({code:'revision_changed'});
  }else{
   // Final probe and write are synchronous. A take queued by the probe runs only after C.
   let take:Promise<unknown>|undefined;
   const independentRequest=AsyncResource.bind(()=>browserOwnerSessionRequest(f.owner(),'POST',body).catch(error=>error));
   if(stage==='after-final-probe'){
    const original=f.controller.blocksCommit.bind(f.controller);
    vi.spyOn(f.controller,'blocksCommit').mockImplementation(key=>{const result=original(key);take??=independentRequest();return result;});
   }
   await f.transition.applyBrowserChoice('a',choice);
   take??=browserOwnerSessionRequest(f.owner(),'POST',body).catch(error=>error);
   expect(await take).toMatchObject({code:'revision_changed'});
  }
  expect(f.bots[0]!.selectionRevision).toBe(1);expect(f.controller.holdState('a')?.held??false).toBe(false);
 },3000);
}
