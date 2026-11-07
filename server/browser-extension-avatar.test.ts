// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { privateTestDirectory } from './testing/private-test-dir.ts';
import { removeTempDir } from './testing/cleanup.ts';
import { BROWSER_APP_PROTOCOL, type BrowserExtensionCommand, type BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
const A = { kind: 'picture' as const, id: 'aaaaaaaaaaaaaaaa', dataUrl: 'data:image/webp;base64,AAAA' };
const B = { ...A, id: 'bbbbbbbbbbbbbbbb', dataUrl: 'data:image/webp;base64,BBBB' };
const deferred = <T>() => { let resolve!: (v:T)=>void; let reject!: (e:Error)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const clean: (()=>Promise<void>)[]=[];
afterEach(async()=>{vi.useRealTimers(); for(const f of clean.splice(0))await f();});
const tick = async()=>{ for(let i=0;i<50;i++)await Promise.resolve(); };
async function fixture(avatar: ()=>Promise<unknown> = async()=>A, capable=true, extra: Partial<Parameters<typeof createBrowserExtensionService>[0]> = {}) {
 vi.resetModules();const {createBrowserExtensionService:makeService}=await import('./browser-extension-service.ts');
 const {root,directory}=await privateTestDirectory(path.resolve('.avatar-'));
 const calls: BrowserExtensionCommand[]=[]; const held=new Map<string,string>();
 let capabilities=['scoped_cdp','durable_stop','explicit_share','manual_pause','engine_cdp_v1','unexpected_input_pause','ordered_requests_v1',...(capable?['panel_avatar_v1']:[])];
 let generation=1; const states=new Map<string,'active'|'paused'|'stopped'>(); let profileHook: (()=>void)|undefined;
 let hook: ((c:BrowserExtensionCommand)=>Promise<void>)|undefined;
 const broker={drop:()=>false,profiles:():BrowserExtensionHello[]=>{profileHook?.();return [{version:1,type:'hello',profileId:'profile',browser:'chromium',extensionVersion:'1.0.1',capabilities}];},
 async request(_p:string,c:BrowserExtensionCommand){calls.push(c); const snapshot=held.get(c.bindingId)??''; await hook?.(c); if(c.operation==='stop'||c.operation==='pause')states.set(c.bindingId,c.operation==='stop'?'stopped':'paused'); if(c.operation==='avatar')held.set(c.bindingId,String(c.params.avatarId));
 return {version:1 as const,type:'response' as const,id:c.id,bindingId:c.bindingId,generation:c.generation,result:{generation:Math.max(generation,c.generation)+(['stop','pause'].includes(c.operation)?1:0),state:states.get(c.bindingId)??'active',tabs:[],avatarId:c.operation==='avatar'?held.get(c.bindingId):snapshot}};}};
 const options={...extra,broker,workspaceId:'workspace',stateFile:path.join(directory,'state.json'),avatar} as Parameters<typeof createBrowserExtensionService>[0];
 const service=await makeService(options);
 clean.push(async()=>{await service.close();await removeTempDir(root);});
 const bind=(botId='bot')=>service.ensureBinding({botId,threadId:botId,profileId:'profile'});
 return {disconnect:()=>{generation++;for(const c of calls)if(states.get(c.bindingId)!=='stopped')states.set(c.bindingId,'paused');},ownerResume:async(target:typeof service,bindingId:string)=>{generation++;states.set(bindingId,'active');await target.handleMessage('profile',{version:1,type:'event',bindingId,generation,event:'resumed',data:{resumedAt:generation}});},reopen:async(cleanShutdown=true)=>{if(cleanShutdown)await service.close();vi.resetModules();const next=await (await import('./browser-extension-service.ts')).createBrowserExtensionService(options);clean.unshift(()=>next.close());return next;},setGeneration:(v:number)=>{generation=v;},profileHook:(fn:()=>void)=>{profileHook=fn;},service:service as typeof service & {avatarChanged(id:string):void},bind,calls,held,hook:(v:typeof hook)=>{hook=v;},incapable:()=>{capabilities=capabilities.filter(c=>c!=='panel_avatar_v1');}};
}
const avatars=(f:Awaited<ReturnType<typeof fixture>>)=>f.calls.filter(c=>c.operation==='avatar');
it('T1/T3/T16: bind and revoke finish while the picture is pending; only cosmetic bytes follow',async()=>{
 const d=deferred<typeof A>();const read=vi.fn(()=>d.promise);const f=await fixture(read);const b=await f.bind();
 await f.service.setSiteAccess(b.bindingId,'https://example.com','allow');await f.service.revoke(b.bindingId,'https://example.com');
 expect(f.calls.filter(c=>c.operation==='bind').at(-1)?.params.approvedOrigins).not.toContain('https://example.com');expect(read).toHaveBeenCalledTimes(1);
 d.resolve(A);await tick();expect(avatars(f)).toHaveLength(1);expect(avatars(f)[0].params).toEqual({avatarId:A.id,data:A.dataUrl});
});
it('T4: an old extension never reads or receives a picture',async()=>{const read=vi.fn(async()=>A);const f=await fixture(read,false);await f.bind();await tick();expect(read).not.toHaveBeenCalled();expect(avatars(f)).toHaveLength(0);expect(f.calls[0].params).toEqual({profileId:'profile',botName:'bot',approvedOrigins:[],appProtocol:BROWSER_APP_PROTOCOL,panel:{mode:'step',grants:[],sites:[]}});});
it('T5: current hello capability is checked after a pending read',async()=>{let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());await f.bind();await tick();expect(avatars(f)).toHaveLength(1);const d=deferred<typeof A>();read=()=>d.promise;f.service.avatarChanged('bot');f.incapable();d.resolve(B);await tick();expect(avatars(f)).toHaveLength(1);});
it('T8: A B A acknowledgements serialize the latest picture',async()=>{let desired=A;const f=await fixture(async()=>desired);await f.bind();await tick();expect(f.held.values().next().value).toBe(A.id);const ack=deferred<void>();f.hook(async c=>{if(c.operation==='avatar')await ack.promise;});desired=B;f.service.avatarChanged('bot');await tick();desired=A;f.service.avatarChanged('bot');expect(avatars(f)).toHaveLength(2);ack.resolve();await tick();expect(avatars(f).map(c=>c.params.avatarId)).toEqual([A.id,B.id,A.id]);expect([...f.held.values()]).toEqual([A.id]);});
it('T9/T11: acknowledged id deduplicates, lost extension memory resends on bind',async()=>{const f=await fixture();const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);await f.service.setSiteAccess(b.bindingId,'https://example.com','allow');await tick();expect(avatars(f)).toHaveLength(1);f.held.clear();await f.service.revoke(b.bindingId,'https://example.com');await tick();expect(avatars(f)).toHaveLength(2);});
it('T10: 32 bindings share one profile avatar slot',async()=>{const f=await fixture();let pending=0,peak=0;const gates:(()=>void)[]=[];f.hook(async c=>{if(c.operation==='avatar'){pending++;peak=Math.max(peak,pending);await new Promise<void>(r=>gates.push(r));pending--;}});await Promise.all(Array.from({length:32},(_,i)=>f.bind('bot'+i)));await tick();expect(peak).toBe(1);for(let i=0;i<32;i++){await tick();gates.shift()?.();await tick();}expect(f.held.size).toBe(32);expect(peak).toBe(1);});
it('T12: refused bind schedules no avatar',async()=>{const f=await fixture();f.hook(async c=>{if(c.operation==='bind')throw Error('broker_busy');});await expect(f.bind()).rejects.toThrow();await tick();expect(avatars(f)).toHaveLength(0);});
it('T13/T14: removal clears, unknown preserves, replacement sends',async()=>{let desired:unknown=A;const f=await fixture(async()=>desired);await f.bind();await tick();expect(avatars(f)).toHaveLength(1);desired={kind:'unknown'};f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(1);desired={kind:'none'};f.service.avatarChanged('bot');await tick();expect(avatars(f).at(-1)?.params).toEqual({avatarId:''});desired=B;f.service.avatarChanged('bot');await tick();expect(avatars(f).at(-1)?.params.avatarId).toBe(B.id);});
it.each(['stop','pause'] as const)('T15: %s fences a pending read',async action=>{let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);const d=deferred<typeof A>();read=()=>d.promise;f.service.avatarChanged('bot');await f.service[action](b.bindingId);d.resolve(B);await tick();expect(avatars(f)).toHaveLength(1);});
it('T17/T18: two failures forget held, stop retrying, and a later trigger repairs',async()=>{let desired=A;const f=await fixture(async()=>desired);await f.bind();await tick();expect(avatars(f)).toHaveLength(1);desired=B;f.hook(async c=>{if(c.operation==='avatar')throw Error('broker_busy');});f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(3);desired=A;f.hook(undefined);f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(4);expect(avatars(f).at(-1)?.params.avatarId).toBe(A.id);});
it('T19a: read deadline releases the job and late resolution is ignored',async()=>{const d=deferred<typeof A>();let read:()=>Promise<typeof A>=()=>d.promise;const f=await fixture(()=>read());await f.bind();vi.useFakeTimers(); // trigger a fresh timed iteration after the first completes
 d.resolve(A);await tick();expect(avatars(f)).toHaveLength(1);const hung=deferred<typeof A>();read=()=>hung.promise;f.service.avatarChanged('bot');await tick();await vi.advanceTimersByTimeAsync(15001);read=async()=>B;f.service.avatarChanged('bot');await tick();expect(avatars(f).at(-1)?.params.avatarId).toBe(B.id);hung.resolve(A);await tick();expect(avatars(f)).toHaveLength(2);});
it('T6: the final synchronous capability gate refuses a replacement old host',async()=>{
 let desired=A;const f=await fixture(async()=>desired);const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 desired=B;let checks=0;f.profileHook(()=>{if(++checks===7)f.incapable();});
 // Three sendable checks each read online/capability; the seventh read is request's own guard.
 f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(1);expect(checks).toBeGreaterThanOrEqual(7);expect(f.service.avatarState(b.bindingId).held).toBeUndefined();
});
it('T7: a resumed generation drops the old read and sends at the new generation',async()=>{
 const pending=deferred<typeof A>();let read:()=>Promise<typeof A>=()=>pending.promise;
 const f=await fixture(()=>read());const b=await f.bind();f.setGeneration(2);
 await f.service.handleMessage('profile',{version:1,type:'event',bindingId:b.bindingId,generation:2,event:'resumed',data:{resumedAt:2}});
 read=async()=>B;pending.resolve(A);await tick();expect(avatars(f).map(c=>c.generation)).toEqual([2]);expect(avatars(f)[0].params.avatarId).toBe(B.id);
});
it('T18: a delayed same-generation bind cannot restore held A after B loses its ack',async()=>{
 let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 const bindAck=deferred<void>(),avatarAck=deferred<void>(),nextRead=deferred<typeof A>();
 f.hook(async c=>{if(c.operation==='bind')await bindAck.promise;if(c.operation==='avatar'&&c.params.avatarId===B.id){f.held.set(b.bindingId,B.id);await avatarAck.promise;}});
 const rebind=f.service.setSiteAccess(b.bindingId,'https://example.com','allow');
 await vi.waitFor(()=>expect(f.calls.filter(c=>c.operation==='bind')).toHaveLength(2));
 read=async()=>B;f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(2);
 read=()=>nextRead.promise;avatarAck.reject(Error('deadline_exceeded_uncertain'));await tick();bindAck.resolve();await rebind;nextRead.resolve(A);await tick();
 expect(avatars(f).map(c=>c.params.avatarId)).toEqual([A.id,B.id,A.id]);expect(f.held.get(b.bindingId)).toBe(A.id);
});
it('T16: onHello and startNewTask resolve with a never-settling avatar option',async()=>{
 const read=vi.fn(()=>new Promise(()=>{}));const f=await fixture(read);const b=await f.bind();expect(read).toHaveBeenCalledTimes(1);
 f.service.onHello('profile');await f.service.stop(b.bindingId);const next=await f.service.startNewTask(b.bindingId);expect(next.bindingId).not.toBe(b.bindingId);expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it.each([true,false])('T11a/BF-3: crash recovery sends only after owner Resume (applied=%s)',async applied=>{
 const read=vi.fn(async()=>A);const f=await fixture(read);const ack=deferred<void>();
 f.hook(async c=>{if(c.operation==='avatar'){if(applied)f.held.set(c.bindingId,A.id);await ack.promise;}});
 const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 // The old process disappears: no service.close(), no disconnect notification to it,
 // and its pending IPC callback is never delivered. Only the extension survives.
 const closed=vi.spyOn(f.service,'close');
 f.disconnect();f.hook(undefined);const second=await f.reopen(false);expect(closed).not.toHaveBeenCalled();
 await verifyRestart(f,second,b.bindingId,read,applied);
});
it.each([true,false])('T11b/BF-3: clean restart sends only after owner Resume (held=%s)',async retained=>{
 const read=vi.fn(async()=>A);const f=await fixture(read);const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 await f.service.close();f.disconnect();if(!retained)f.held.clear();const second=await f.reopen();
 await verifyRestart(f,second,b.bindingId,read,retained);
});
async function verifyRestart(f:Awaited<ReturnType<typeof fixture>>,second:Awaited<ReturnType<typeof createBrowserExtensionService>>,bindingId:string,read:ReturnType<typeof vi.fn>,retained:boolean){
 const count=avatars(f).length,reads=read.mock.calls.length;
 second.onHello('profile');
 await vi.waitFor(()=>expect(second.status().bindings.find(b=>b.bindingId===bindingId)?.generation).toBe(2));
 expect(second.status().bindings.find(b=>b.bindingId===bindingId)?.state).toBe('paused');
 const reused=await second.ensureBinding({botId:'bot',threadId:'bot',profileId:'profile'});expect(reused.bindingId).toBe(bindingId);
 second.avatarChanged('bot');await tick();expect(read).toHaveBeenCalledTimes(reads);expect(avatars(f)).toHaveLength(count);
 const gate=deferred<void>();f.hook(async c=>{if(c.operation==='bind')await gate.promise;});
 const resume=f.ownerResume(second,bindingId);
 await vi.waitFor(()=>expect(f.calls.some(c=>c.operation==='bind'&&c.generation===3)).toBe(true));
 second.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(count);expect(read).toHaveBeenCalledTimes(reads);
 gate.resolve();await resume;await tick();expect(avatars(f)).toHaveLength(count+(retained?0:1));
 if(!retained)expect(avatars(f).at(-1)?.generation).toBe(3);
}
it('T15: a failed site bind pauses and fences the pending avatar',async()=>{
 let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 const pending=deferred<typeof A>();read=()=>pending.promise;f.service.avatarChanged('bot');f.hook(async c=>{if(c.operation==='bind')throw Error('broker_busy');});
 await f.service.setSiteAccess(b.bindingId,'https://example.com','never').catch(()=>{});pending.resolve(B);await tick();expect(avatars(f)).toHaveLength(1);expect(f.service.status().bindings[0].state).toBe('paused');
});

it.each([false, true])('T20/BF-1: bind completion cannot approve a generation moved during persistence (new first=%s)', async newFirst => {
 const oldSave=deferred<void>(); let delay=false, reached=false;
 const f=await fixture(async()=>A,true,{reconcilePersistence:async saved=>{await saved;if(delay){delay=false;reached=true;await oldSave.promise;}}});
 const control=await f.bind('control');await tick();expect(avatars(f)).toHaveLength(1);
 const b=await f.bind();await tick();expect(f.service.avatarState(b.bindingId).bound).toBe(1);
 f.held.set(b.bindingId,'');delay=true;
 const oldBind=f.service.setSiteAccess(b.bindingId,'https://example.com','allow');await vi.waitFor(()=>expect(reached).toBe(true));
 const newAck=deferred<void>();f.hook(async c=>{if(c.bindingId===b.bindingId&&c.operation==='bind'&&c.generation===2)await newAck.promise;});
 f.setGeneration(2);
 const resume=f.service.handleMessage('profile',{version:1,type:'event',bindingId:b.bindingId,generation:2,event:'resumed',data:{resumedAt:2}});
 await vi.waitFor(()=>expect(f.calls.some(c=>c.operation==='bind'&&c.bindingId===b.bindingId&&c.generation===2)).toBe(true));
 const before=avatars(f).length;
 if(newFirst){newAck.resolve();await resume;await tick();expect(f.service.avatarState(b.bindingId).bound).toBe(2);}
 oldSave.resolve();await oldBind;f.service.avatarChanged('bot');await tick();
 if(!newFirst){expect(f.service.avatarState(b.bindingId).bound).not.toBe(2);expect(avatars(f)).toHaveLength(before);newAck.resolve();await resume;await tick();}
 expect(f.service.avatarState(b.bindingId).bound).toBe(2);
 expect(avatars(f).filter(c=>c.bindingId===b.bindingId&&c.generation===2)).toHaveLength(1);
 expect(f.service.avatarState(control.bindingId).bound).toBe(1);
});
it('T20: first bind gates avatarChanged until reconciliation completes',async()=>{
 const f=await fixture();await f.bind('control');await tick();expect(avatars(f)).toHaveLength(1);
 const ack=deferred<void>();f.hook(async c=>{if(c.operation==='bind')await ack.promise;});
 const binding=f.bind();f.service.avatarChanged('bot');
 await vi.waitFor(()=>expect(f.calls.filter(c=>c.operation==='bind')).toHaveLength(2));
 f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(1);
 ack.resolve();const b=await binding;await tick();expect(avatars(f).filter(c=>c.bindingId===b.bindingId)).toHaveLength(1);
});

import { createPanelAvatars, PANEL_AVATAR_MAKE_MS, helperEncode, type PanelAvatarEncode, type PanelAvatarRead } from './browser-extension-panel-avatar.ts';
import { panelAvatarSource } from './browser-extension-panel-avatar-source.ts';
const botPicture = (name: string) => ({avatarUrl:`/api/attachments/${name}.png`,avatarCrop:'circle'});
const rawPicture = (name: string): PanelAvatarRead => ({state:'ok',bytes:Buffer.from(name),version:name});
it.each(['read','acquisition','marker-probe','marker-read'] as const)('T19b/BF-2: expired %s never enters replacement encoder',async stage=>{
 vi.useFakeTimers();const gate=deferred<void>();let first=true;const calls:string[]=[];
 const encode:PanelAvatarEncode=async bytes=>{calls.push(bytes.toString());return Buffer.from('webp');};
 const acquisition=Object.assign(async()=>{if(stage==='acquisition'&&first){first=false;await gate.promise;}return encode;},{recycle:vi.fn()});
 const read=vi.fn(async(url:string)=>{if(stage==='read'&&url.includes('/A.'))await gate.promise;return rawPicture(url.includes('/A.')?'A':url.includes('/B.')?'B':'C');});
 let markers=0;const probeImage=vi.fn(async()=>({ok:true as const,id:{dev:1n,ino:1n,size:1n,mtimeNs:1n,ctimeNs:1n}}));
 const readFile=vi.fn(async(name:string)=>({ok:true as const,bytes:Buffer.from(name[0]),version:name}));
 const source=panelAvatarSource({removalState:async()=>{markers++;if((stage==='marker-probe'&&markers===1)||(stage==='marker-read'&&markers===2))await gate.promise;return 'present';},
  probeServedImage:probeImage,readAttachment:readFile});
 const probe=stage.startsWith('marker')?source.probe:async()=>({state:'ok' as const,stamp:'1'});
 const actualRead=stage.startsWith('marker')?source.read:read;
 const avatars=createPanelAvatars({probe,read:actualRead,encode:acquisition});
 const a=avatars.get(botPicture('A'));await vi.advanceTimersByTimeAsync(PANEL_AVATAR_MAKE_MS);
 expect(await a).toEqual({kind:'unknown'});expect(acquisition.recycle).toHaveBeenCalledTimes(1);
 expect(await avatars.get(botPicture('B'))).toMatchObject({kind:'picture'});
 const probes=probeImage.mock.calls.length,reads=readFile.mock.calls.length;
 gate.resolve();await tick();expect(calls).toEqual(['B']);expect(probeImage).toHaveBeenCalledTimes(probes);expect(readFile).toHaveBeenCalledTimes(reads);
 if(stage==='marker-probe')expect(markers).toBe(3); // A must not advance from probe to read.
 expect(await avatars.get(botPicture('C'))).toMatchObject({kind:'picture'});
 expect(acquisition.recycle).toHaveBeenCalledTimes(1);
 expect(await avatars.get(botPicture('A'))).toMatchObject({kind:'picture'});expect(calls).toEqual(['B','C','A']);
});
it.each(['unavailable','throw','null'] as const)('T2/BF-2: loaded encoder %s has the correct cache semantics',async outcome=>{
 const encode=vi.fn(async()=>{if(outcome==='throw')throw Error('encoder');return outcome==='null'?null:'unavailable' as const;});
 const avatars=createPanelAvatars({probe:async()=>({state:'ok',stamp:'1'}),read:async()=>rawPicture('A'),encoder:{encode,recycle:vi.fn()}});
 expect(await avatars.get(botPicture('A'))).toEqual({kind:outcome==='null'?'none':'unknown'});
 await avatars.get(botPicture('A'));expect(encode).toHaveBeenCalledTimes(outcome==='null'?1:2);
});
it('BF-2: an expired token cannot fork or enqueue helper IPC',async()=>{
 const onChild=vi.fn();const encoder=helperEncode({onChild});
 await expect(encoder.encode(Buffer.from('A'),72,{expired:true})).rejects.toThrow('avatar_expired');expect(onChild).not.toHaveBeenCalled();encoder.recycle();
});

it('T23/BF-3: replacement after Stop binds a new id before sending',async()=>{
 const f=await fixture();const old=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 await f.service.stop(old.bindingId);const gate=deferred<void>();f.hook(async c=>{if(c.operation==='bind')await gate.promise;});
 const replacement=f.service.startNewTask(old.bindingId);f.service.avatarChanged('bot');
 await vi.waitFor(()=>expect(f.calls.filter(c=>c.operation==='bind')).toHaveLength(2));await tick();expect(avatars(f)).toHaveLength(1);
 gate.resolve();const next=await replacement;await tick();expect(next.bindingId).not.toBe(old.bindingId);
 expect(f.service.status().bindings.find(b=>b.bindingId===old.bindingId)?.state).toBe('stopped');
 expect(avatars(f).filter(c=>c.bindingId===next.bindingId)).toHaveLength(1);
});
it('T24/BF-3: active turn reuses binding while avatar changes',async()=>{
 let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 const gate=deferred<typeof A>(),ack=deferred<void>();let inFlight=0,peak=0;
 read=()=>gate.promise;f.hook(async c=>{if(c.operation==='avatar'){peak=Math.max(peak,++inFlight);await ack.promise;inFlight--;}});
 f.service.avatarChanged('bot');await tick();const turn=f.bind();f.service.avatarChanged('bot');
 gate.resolve(B);await tick();ack.resolve();expect((await turn).bindingId).toBe(b.bindingId);await tick();
 expect(peak).toBe(1);expect(f.calls.some(c=>c.operation==='stop')).toBe(false);expect(new Set(f.calls.map(c=>c.bindingId)).size).toBe(1);
 expect(f.held.get(b.bindingId)).toBe(B.id);expect(avatars(f).map(c=>c.params.avatarId)).toEqual([A.id,B.id]);
});

import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { attachmentRemovalState, attachmentsHomeOf } from './attachment-read.ts';
import { PANEL_AVATAR_HELPER_IDLE_MS } from './browser-extension-panel-avatar-encoder.ts';
// T19d and T21: new contract, no historical assertion-red claim. These directly
// exercise implementation-head exports; no base+module run or missing-export shim.
it('T19d/BF-4: helper deadline kills child and replacement encodes',async()=>{
 const children:ChildProcess[]=[];const env:Record<string,string>={MURAGE_PANEL_AVATAR_HELPER_HANG:'1'};
 let killedRequestId:number|undefined;let injected=false;
 const encoder=helperEncode({env,onChild:child=>{
  children.push(child);const send=child.send.bind(child);
  vi.spyOn(child,'send').mockImplementation(((message:{id:number},...args:unknown[])=>{
   if(children.length===1)killedRequestId=message.id;
   else if(children.length===2){
    // The old id must be ignored; using the pending live id also proves the
    // child-identity guard, independently of monotonically increasing ids.
    expect(killedRequestId).toBeDefined();
    children[0].emit('message',{id:killedRequestId,out:Buffer.from('stale old id')});
    children[0].emit('message',{id:message.id,out:Buffer.from('stale child')});
    injected=true;
   }
   return Reflect.apply(send,child,[message,...args]);
  }) as typeof child.send);
 }});clean.push(async()=>{encoder.recycle();});
 const sharp=createRequire(fileURLToPath(import.meta.resolve('@huggingface/transformers')))('sharp');
 const png:Buffer=await sharp({create:{width:16,height:16,channels:3,background:'#448866'}}).png().toBuffer();
 const source={probe:async()=>({state:'ok' as const,stamp:'1'}),read:async()=>({state:'ok' as const,bytes:png,version:'1'})};
 vi.useFakeTimers();const avatars=createPanelAvatars({...source,encoder});const first=avatars.get(botPicture('A'));await tick();
 expect(children).toHaveLength(1);const killed=once(children[0],'exit');
 await vi.advanceTimersByTimeAsync(PANEL_AVATAR_MAKE_MS);expect(await first).toEqual({kind:'unknown'});vi.useRealTimers();
 expect((await killed)[1]).toBe('SIGKILL');expect(children[0].signalCode).toBe('SIGKILL');delete env.MURAGE_PANEL_AVATAR_HELPER_HANG;
 const replacement=await avatars.get(botPicture('B'));expect(replacement).toMatchObject({kind:'picture'});expect(children).toHaveLength(2);
 expect(children[1].pid).not.toBe(children[0].pid);expect(injected).toBe(true);
 if(replacement.kind!=='picture')throw Error('missing picture');
 expect(Buffer.from(replacement.dataUrl.split(',')[1],'base64').toString()).not.toBe('stale child');
 expect(await sharp(Buffer.from(replacement.dataUrl.split(',')[1],'base64')).metadata()).toMatchObject({format:'webp',width:72,height:72});
 const idleAt=Date.now();const idle=await once(children[1],'exit');expect(idle).toEqual([0,null]);
 expect(Date.now()-idleAt).toBeGreaterThanOrEqual(PANEL_AVATAR_HELPER_IDLE_MS-1000);
 const out=await encoder.encode(png,72);expect(Buffer.isBuffer(out)).toBe(true);expect(children).toHaveLength(3);expect(children[2].pid).not.toBe(children[1].pid);
},90_000);
it('T21/BF-4: marker errors preserve held avatar',async()=>{
 const home=attachmentsHomeOf(path.resolve('../tmp/source-contract'));let code='ENOENT';
 const stat=vi.fn(async()=>{if(code)throw Object.assign(Error(code),{code});return {};});
 for(const [error,expected] of [['','removed'],['ENOENT','present'],['ENOTDIR','present'],['EIO','error']]){code=error;expect(await attachmentRemovalState(home,'A.png',stat)).toBe(expected);}
 expect(await attachmentRemovalState(home,'../not-a-name',stat)).toBe('present');
 code='ENOENT';let reason='';const readAttachment=vi.fn(async()=>reason?{ok:false as const,reason}:{ok:true as const,bytes:Buffer.from('image'),version:'1'});
 const source=panelAvatarSource({removalState:name=>attachmentRemovalState(home,name,stat),probeServedImage:async()=>reason?{ok:false as const,reason}:{ok:true as const,id:{dev:1n,ino:1n,size:1n,mtimeNs:1n,ctimeNs:1n}},readAttachment});
 const encode=vi.fn(async()=>Buffer.from('webp'));const avatars=createPanelAvatars({...source,encoder:{encode,recycle:vi.fn()}});
 const f=await fixture(()=>avatars.get(botPicture('A')));const binding=await f.bind();await tick();expect(avatarsSent(f)).toHaveLength(1);const held=f.held.get(binding.bindingId);
 code='EIO';expect(await source.probe('/api/attachments/A.png')).toEqual({state:'error'});expect(await source.read('/api/attachments/A.png')).toEqual({state:'error'});
 expect(await avatars.get(botPicture('A'))).toEqual({kind:'unknown'});f.service.avatarChanged('bot');await tick();expect(avatarsSent(f)).toHaveLength(1);expect(f.held.get(binding.bindingId)).toBe(held);
 code='ENOENT';expect(await avatars.get(botPicture('A'))).toMatchObject({kind:'picture'});expect(encode).toHaveBeenCalledTimes(1);expect(readAttachment).toHaveBeenCalledTimes(1);
 for(const r of ['io','busy']){reason=r;expect(await source.probe('/api/attachments/A.png')).toEqual({state:'error'});expect(await source.read('/api/attachments/A.png')).toEqual({state:'error'});}
 reason='missing';expect(await source.probe('/api/attachments/A.png')).toEqual({state:'removed'});expect(await source.read('/api/attachments/A.png')).toEqual({state:'gone'});reason='';code='';
 expect(await source.read('/api/attachments/A.png')).toEqual({state:'gone'});f.service.avatarChanged('bot');await tick();expect(avatarsSent(f).at(-1)?.params).toEqual({avatarId:''});expect(avatarsSent(f)).toHaveLength(2);
});
const avatarsSent=avatars;
it('T22: a held-id acknowledgement during the profile wait suppresses duplicate bytes',async()=>{
 let desired=A;const f=await fixture(async()=>desired);const y=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 desired=B;f.hook(async c=>{if(c.operation==='avatar')throw Error('broker_busy');});f.service.avatarChanged('bot');await tick();expect(f.service.avatarState(y.bindingId).held).toBeUndefined();expect(avatars(f)).toHaveLength(3);
 desired=A;const gate=deferred<void>();f.hook(async c=>{if(c.operation==='avatar'&&c.bindingId!==y.bindingId)await gate.promise;});
 await f.bind('X');await tick();f.service.avatarChanged('bot');await tick();const count=avatars(f).length;
 f.held.set(y.bindingId,A.id);await f.bind();expect(f.service.avatarState(y.bindingId).held).toBe(A.id);
 gate.resolve();await tick();expect(avatars(f)).toHaveLength(count);expect(f.service.avatarState(y.bindingId).running).toBe(false);
});
it.each(['broker_busy','deadline_exceeded_uncertain'])('T17/T18: %s forgets held and bind summaries repair only missing bytes',async error=>{
 let desired=A;const f=await fixture(async()=>desired);const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 desired=B;f.hook(async c=>{if(c.operation==='avatar'){f.held.set(b.bindingId,B.id);throw Error(error);}});
 f.service.avatarChanged('bot');await tick();expect(avatars(f)).toHaveLength(3);expect(f.service.avatarState(b.bindingId).held).toBeUndefined();
 f.hook(undefined);await f.bind();await tick();expect(avatars(f)).toHaveLength(3);expect(f.service.avatarState(b.bindingId).held).toBe(B.id);
 f.held.set(b.bindingId,A.id);await f.bind();await tick();expect(avatars(f)).toHaveLength(4);expect(f.held.get(b.bindingId)).toBe(B.id);
});

it('T19b/BF-2: expired read sends no IPC to the replacement helper',async()=>{
 const children:ChildProcess[]=[];const sends:ReturnType<typeof vi.spyOn>[]=[];
 const encoder=helperEncode({onChild:child=>{children.push(child);sends.push(vi.spyOn(child,'send'));}});clean.push(async()=>encoder.recycle());
 const sharp=createRequire(fileURLToPath(import.meta.resolve('@huggingface/transformers')))('sharp');
 const png:Buffer=await sharp({create:{width:8,height:8,channels:3,background:'#883311'}}).png().toBuffer();
 const gate=deferred<void>();const avatars=createPanelAvatars({encoder,probe:async()=>({state:'ok',stamp:'1'}),read:async url=>{if(url.includes('/A.'))await gate.promise;return {state:'ok',bytes:png,version:url};}});
 vi.useFakeTimers();const a=avatars.get(botPicture('A'));await vi.advanceTimersByTimeAsync(PANEL_AVATAR_MAKE_MS);expect(await a).toEqual({kind:'unknown'});vi.useRealTimers();
 expect(await avatars.get(botPicture('B'))).toMatchObject({kind:'picture'});expect(children).toHaveLength(1);expect(sends[0]).toHaveBeenCalledTimes(1);
 gate.resolve();await tick();expect(children).toHaveLength(1);expect(sends[0]).toHaveBeenCalledTimes(1);
 expect(await avatars.get(botPicture('C'))).toMatchObject({kind:'picture'});expect(children).toHaveLength(1);expect(sends[0]).toHaveBeenCalledTimes(2);
});
it('T15: a deleted bot is stopped and a retired binding drops its pending read',async()=>{
 let read:()=>Promise<typeof A>=async()=>A;const f=await fixture(()=>read());const b=await f.bind();await tick();expect(avatars(f)).toHaveLength(1);
 const gate=deferred<typeof A>();read=()=>gate.promise;f.service.avatarChanged('bot');await tick();
 // The bot deletion routes stop its bindings before deleting the bot record.
 await f.service.stop(b.bindingId);f.hook(async c=>{if(c.operation==='status')throw Object.assign(Error('unknown_binding'),{code:'unknown_binding'});});
 await f.bind(); // observes runtime retirement and executes the real policy unbind path
 gate.resolve(B);await tick();expect(avatars(f)).toHaveLength(1);expect(f.service.avatarState(b.bindingId).running).toBe(false);
});
