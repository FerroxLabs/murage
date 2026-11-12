import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInstance, RuntimeEvent } from '../contracts.ts';
import * as delivery from './request-delivery.ts';
import { RequestTransport } from './request-transport.ts';
import { removeTempDir } from '../testing/cleanup.ts';

it('T3b registers and taps all 2000 simultaneously open native asks', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'delivery-')); const old = process.env.MURAGE_DATA_DIR, tap = process.env.MURAGE_GATE_TAP;
 process.env.MURAGE_DATA_DIR = dir; process.env.MURAGE_GATE_TAP = '1';
 try {
  const f = fixture(); f.emit('turn.started', {turnId:'g'});
  for(let i=0;i<2000;i++) f.emit('request.opened',{turnId:'g',requestId:String(i)});
  expect(readFileSync(join(dir,'nolim-protocol.ndjson'),'utf8').trim().split('\n')).toHaveLength(2000);
  expect(await f.instance.adapter.respondToRequest('t','1999',{behavior:'allow'},{answerId:'a'})).toEqual({state:'accepted'});
  await f.instance.dispose();
 } finally { if(old===undefined) delete process.env.MURAGE_DATA_DIR; else process.env.MURAGE_DATA_DIR=old; if(tap===undefined) delete process.env.MURAGE_GATE_TAP; else process.env.MURAGE_GATE_TAP=tap; await removeTempDir(dir); }
});
it('T3e retirement visits only its three requests after 10000 closed requests', async () => {
 const f=fixture();
 f.emit('turn.started',{turnId:'history'});
 for(let i=0;i<10000;i++){ f.emit('request.opened',{turnId:'history',requestId:String(i)}); f.emit('request.resolved',{turnId:'history',requestId:String(i)}); }
 f.emit('turn.completed',{turnId:'history'}); f.emit('turn.started',{turnId:'g'});
 for(let i=0;i<3;i++) f.emit('request.opened',{turnId:'g',requestId:String(i)});
 const probe = (delivery as unknown as {__visits?:{count:number}}).__visits;
 expect(probe, 'bucket visit instrumentation must exist').toBeDefined();
 const before=probe?.count??0; f.emit('turn.completed',{turnId:'g'});
 expect((probe?.count??Infinity)-before).toBeLessThanOrEqual(3);
 await f.instance.dispose();
});
it('resolved and disposed requests settle receipts and never write again',async()=>{
 const f=fixture();f.emit('turn.started',{turnId:'g'}); f.emit('request.opened',{turnId:'g',requestId:'r'});
 expect(await f.instance.adapter.respondToRequest('t','r',{behavior:'allow'},{answerId:'a'})).toEqual({state:'accepted'});
 f.emit('request.resolved',{turnId:'g',requestId:'r'});
 expect(await f.instance.adapter.respondToRequest('t','r',{behavior:'allow'},{answerId:'b'})).toEqual({state:'failed'});
 await f.instance.dispose();
});
function fixture(){
 const listeners = new Set<(e:RuntimeEvent)=>void>();const transport=new RequestTransport();
 const instance=delivery.withRequestDelivery({instanceId:'fixture',driverKind:'fake',adapter:{onEvent:(f:any)=>{listeners.add(f);return()=>listeners.delete(f);},respondToRequest:async(t:string,r:string)=>{transport.confirm(t,r,Promise.resolve(true));return 'allowed-once';}},dispose:async()=>{}} as unknown as ProviderInstance,transport);
 return {instance,emit:(type:string,fields:Record<string,unknown>)=>{for(const f of listeners)f({type,threadId:'t',...fields} as RuntimeEvent);}};
}

it('M32 conflicting concurrent identity never replaces the accepted receipt at close',async()=>{
 const listeners=new Set<(e:RuntimeEvent)=>void>();const transport=new RequestTransport();let release!:(ok:boolean)=>void;
 const instance=delivery.withRequestDelivery({instanceId:'conflict',driverKind:'fake',adapter:{onEvent:(f:any)=>{listeners.add(f);return()=>listeners.delete(f);},respondToRequest:async(t:string,r:string)=>{
  const receipt=new Promise<boolean>(resolve=>{release=resolve;});transport.confirm(t,r,receipt);const ok=await receipt;
  for(const f of listeners)f({type:'request.resolved',threadId:t,turnId:'g',requestId:r,behavior:'allow',source:'user'} as RuntimeEvent);
  return ok?'allowed-once':'unavailable';
 }},dispose:async()=>{}} as unknown as ProviderInstance,transport);
 for(const f of listeners){f({type:'turn.started',threadId:'t',turnId:'g'} as RuntimeEvent);f({type:'request.opened',threadId:'t',turnId:'g',requestId:'r'} as RuntimeEvent);}
 const first=instance.adapter.respondToRequest('t','r',{behavior:'allow'},{answerId:'a'});await Promise.resolve();
 expect(await instance.adapter.respondToRequest('t','r',{behavior:'deny'},{answerId:'b'})).toEqual({state:'failed'});
 release(true);expect(await first).toEqual({state:'accepted'});await instance.dispose();
});

it('native receipt taps keep their captured identity across synchronous closure and LRU eviction',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-taps-'));const old=process.env.MURAGE_DATA_DIR,gate=process.env.MURAGE_GATE_TAP;process.env.MURAGE_DATA_DIR=dir;process.env.MURAGE_GATE_TAP='1';
 const listeners=new Set<(e:RuntimeEvent)=>void>(),transport=new RequestTransport();
 const instance=delivery.withRequestDelivery({instanceId:'legacy',driverKind:'fake',adapter:{onEvent:(f:any)=>{listeners.add(f);return()=>listeners.delete(f);},respondToRequest:async()=> 'allowed-once'},dispose:async()=>{}} as unknown as ProviderInstance,transport);
 const emit=(type:string,r?:string)=>{for(const f of listeners)f({type,threadId:'t',turnId:'g',requestId:r} as RuntimeEvent);};
 try{
  emit('turn.started');
  for(let i=0;i<2200;i++){emit('request.opened',String(i));transport.confirm('t',String(i),Promise.resolve(true));emit('request.resolved',String(i));}
  await Promise.resolve();
  const taps=readFileSync(join(dir,'nolim-protocol.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));expect(taps.filter(t=>t.type==='answer'&&t.state==='accepted')).toHaveLength(2200);
 }finally{await instance.dispose();if(old===undefined)delete process.env.MURAGE_DATA_DIR;else process.env.MURAGE_DATA_DIR=old;if(gate===undefined)delete process.env.MURAGE_GATE_TAP;else process.env.MURAGE_GATE_TAP=gate;await removeTempDir(dir);}
});

it.each(['turn.completed','turn.started','dispose'])('BLOCK1 resolved hung receipt remains reachable by %s',async retirement=>{
 const listeners=new Set<(e:RuntimeEvent)=>void>(),transport=new RequestTransport();
 const emit=(type:string,turnId='g')=>{for(const f of listeners)f({type,threadId:'t',turnId,requestId:'r'} as RuntimeEvent);};
 const instance=delivery.withRequestDelivery({instanceId:'hung',driverKind:'fake',adapter:{onEvent:(f:any)=>{listeners.add(f);return()=>listeners.delete(f);},respondToRequest:async()=>{emit('request.resolved');return 'allowed-once';}},dispose:async()=>{}} as unknown as ProviderInstance,transport);
 emit('turn.started');emit('request.opened');
 const pending=instance.adapter.respondToRequest('t','r',{behavior:'allow'},{answerId:'a'});
 await Promise.resolve();await Promise.resolve();
 expect(await instance.adapter.respondToRequest('t','r',{behavior:'allow'},{answerId:'a'})).toEqual({state:'failed'});
 if(retirement==='dispose')await instance.dispose();else emit(retirement,retirement==='turn.started'?'next':'g');
 let settled:unknown='hung';void pending.then(r=>{settled=r;});
 for(let i=0;i<12;i++)await Promise.resolve();
 expect(settled,'retirement must settle a resolved request with a missing native receipt').toEqual({state:'failed'});
 await instance.dispose();
});

it('the registry exposes strict delivery from the same session and dedup map',async()=>{
 const f=fixture();f.emit('turn.started',{turnId:'g'});f.emit('request.opened',{turnId:'g',requestId:'registry-request'});
 expect(f.instance.decisionAdapter).toBeDefined();
 const strict=f.instance.decisionAdapter!;
 expect(await strict.respondToRequest('t','registry-request',{behavior:'allow'},{answerId:'registry-answer'})).toEqual({state:'accepted'});
 expect(await f.instance.adapter.respondToRequest('t','registry-request',{behavior:'allow'},{answerId:'registry-answer'})).toEqual({state:'already'});
 expect(await strict.respondToRequest('t','registry-request',{behavior:'deny'},{answerId:'different-answer'})).toEqual({state:'failed'});
 await f.instance.dispose();
});
