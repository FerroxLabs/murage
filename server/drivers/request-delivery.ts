// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { RequestTransport } from './request-transport.ts';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionProviderAdapter, GateTapEvent, ProviderAdapter, ProviderInstance, RequestAnswerOptions, RequestDelivery, RequestOutcome } from '../contracts.ts';
import { AnswerDelivery, inputHash } from './answer-delivery.ts';

/** Test instrumentation: counts actual bucket entries visited by retirement. */
export const __visits = { count: 0 };
/** S0's legacy overload remains available. Explicit answerId requires a native receipt. */
export function withRequestDelivery<T extends ProviderInstance>(instance: T, transport?: RequestTransport): T {
 const adapter = instance.adapter, answers = new AnswerDelivery();
 const generation = new Map<string, string>();
 const open = new Map<string, { generation: string; deliveryGeneration?:string; explicit: boolean; resolved?: boolean; delivery?: Promise<RequestDelivery> }>();
 const byGeneration = new Map<string, Set<string>>();
 const closed = new Map<string, string>();
 const key = (t: string, r: string) => JSON.stringify([t, r]);
 const tap = (event: GateTapEvent, threadId: string) => {
  if (process.env.MURAGE_GATE_TAP !== '1') return;
  adapter.gateTap?.(event);
  if (process.env.MURAGE_DATA_DIR) appendFileSync(join(process.env.MURAGE_DATA_DIR, 'nolim-protocol.ndjson'),
   JSON.stringify({ ...event, threadId, engine: instance.driverKind, providerInstanceId: instance.instanceId, at: Date.now() }) + '\n', { mode: 0o600 });
 };
 const close = (k: string, retiring = false) => {
  const entry = open.get(k); if (!entry) return;
  const [t, r] = JSON.parse(k) as [string, string], g = entry.generation;
  // Keep a resolved request in its generation until its receipt settles. A
  // missing callback must still be reachable by turn retirement or disposal.
  if (!retiring && entry.delivery) {
   if (!entry.resolved) {
    entry.resolved = true;
    void entry.delivery.then(() => close(k,true));
   }
   return;
  }
  open.delete(k); const bucket = byGeneration.get(g); bucket?.delete(k); if (!bucket?.size) byGeneration.delete(g);
  if (retiring && entry.explicit) transport?.cancel(t,r);
  answers.close(entry.deliveryGeneration??g,r);
  closed.delete(k); closed.set(k,g);
  while (closed.size > 1024) closed.delete(closed.keys().next().value!);
 };
 const retire = (g: string) => {
  const bucket = byGeneration.get(g);
  if (bucket) for (const k of bucket) { __visits.count++; close(k,true); }
  byGeneration.delete(g);
 };
 if (transport) transport.onConfirming = (t,r) => {
  const entry = open.get(key(t,r));
  if (!entry || entry.explicit) return;
  const g=entry.generation;
  return accepted => tap({type:'answer',generation:g,requestId:r,answerId:`native:${g}:${r}`,state:accepted?'accepted':'failed'},t);
 };
 const off = adapter.onEvent(event => {
  if (event.type === 'turn.started' && event.turnId) {
   const prior = generation.get(event.threadId);
   if (prior && prior !== event.turnId) retire(prior);
   generation.set(event.threadId, event.turnId);
  }
  if (event.type === 'request.opened' && event.requestId) {
   const g = event.turnId ?? generation.get(event.threadId); if (!g) return;
   const k = key(event.threadId,event.requestId);
   open.set(k,{generation:g,explicit:false}); closed.delete(k);
   let bucket = byGeneration.get(g); if (!bucket) byGeneration.set(g,bucket=new Set()); bucket.add(k);
   tap({ type: 'request', generation: g, requestId: event.requestId, tool: event.toolCall?.name ?? event.tool ?? '', inputHash: inputHash(event.toolCall?.input ?? event.toolInput ?? null) },event.threadId);
  }
  if (event.type === 'request.resolved' && event.requestId) close(key(event.threadId,event.requestId));
  if (event.type === 'turn.completed' && event.turnId) {
   retire(event.turnId); if (generation.get(event.threadId) === event.turnId) generation.delete(event.threadId);
  }
 });
 let replayEpoch=0;
 if(transport)transport.onReopen=(t,r)=>{
  const k=key(t,r),g=generation.get(t),prior=open.get(k);
  if(!g||prior&&!prior.resolved||closed.get(k)!==g&&prior?.generation!==g)return false;
  if(prior)close(k,true);
  open.set(k,{generation:g,deliveryGeneration:`${g}:replay:${++replayEpoch}`,explicit:false});closed.delete(k);
  let bucket=byGeneration.get(g);if(!bucket)byGeneration.set(g,bucket=new Set());bucket.add(k);
  return true;
 };
 if(transport)transport.onRearmReady=async(t,r)=>{
  const k=key(t,r),prior=open.get(k),pending=prior?.delivery;if(!prior||!pending)return false;
  const receipt=await pending;
  if(receipt.state!=='failed'||open.get(k)!==prior||prior.resolved||generation.get(t)!==prior.generation)return false;
  answers.close(prior.deliveryGeneration??prior.generation,r);
  open.set(k,{generation:prior.generation,deliveryGeneration:`${prior.generation}:held:${++replayEpoch}`,explicit:false});
  return true;
 };
 if(transport)transport.onReopenReady=async(t,r)=>{const pending=open.get(key(t,r))?.delivery;if(pending)await pending;return transport.onReopen?.(t,r)===true;};
 const original = adapter.respondToRequest.bind(adapter);
 function respond(t: string, r: string, decision: Parameters<ProviderAdapter['respondToRequest']>[2]): Promise<RequestOutcome>;
 function respond(t: string, r: string, decision: Parameters<ProviderAdapter['respondToRequest']>[2], options: RequestAnswerOptions): Promise<RequestDelivery>;
 function respond(t: string, r: string, decision: Parameters<ProviderAdapter['respondToRequest']>[2], options?: RequestAnswerOptions): Promise<RequestOutcome | RequestDelivery> {
  if (!options) return original(t,r,decision);
  const entry = open.get(key(t,r));
  if (!entry || entry.resolved || !options.answerId) return Promise.resolve({state:'failed'});
  const g = entry.generation; entry.explicit = true;
  const done = answers.deliver(entry.deliveryGeneration??g,r,options.answerId,decision,async () => {
   const receipt = transport?.begin(t,r);
   try {
    let result: RequestOutcome;
    try { result = await original(t,r,decision); }
    catch (error) { if ((error as {reason?:string})?.reason !== 'delivery_pending') throw error; }
    const accepted = result! !== 'unavailable' && result! !== 'card' && (receipt ? await receipt.done : false);
    tap({type:'answer',generation:g,requestId:r,answerId:options.answerId,state:accepted?'accepted':'failed'},t);
    return accepted;
   } finally { receipt?.close(); }
  });
  // Conflicting identities return their own failed receipt without replacing
  // the outstanding native delivery that a synchronous resolution must await.
  entry.delivery ??= done;
  void done.then(result => { if (result.state === 'failed' && entry.delivery === done) entry.delivery = undefined; });
  return done;
 }
 adapter.respondToRequest = respond;
 // The strict capability uses the same live session and AnswerDelivery map.
 // Legacy callers keep their three-argument return type on adapter.
 const decisionAdapter:DecisionProviderAdapter={
  respondToRequest:(t,r,decision,options)=>respond(t,r,decision,options),
  interruptTurn:(threadId,turnId)=>adapter.interruptTurn(threadId,turnId),
  ...(adapter.onPostureChange?{onPostureChange:adapter.onPostureChange.bind(adapter)}:{}),
  ...(adapter.gateTap?{gateTap:adapter.gateTap.bind(adapter)}:{}),
 };
 Object.defineProperty(instance,'decisionAdapter',{value:Object.freeze(decisionAdapter),enumerable:true});
 const dispose = instance.dispose.bind(instance);
 instance.dispose = async () => {
  // Settle even a native dispose waiting on a hung ask.
  for (const g of byGeneration.keys()) retire(g);
  try { await dispose(); } finally { off(); transport?.clear(); if (transport) transport.onConfirming=undefined; if(transport){transport.onReopen=undefined;transport.onReopenReady=undefined;transport.onRearmReady=undefined;} generation.clear(); open.clear(); closed.clear(); }
 };
 return instance;
}
