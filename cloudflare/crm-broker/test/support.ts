// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { HmacRuntimeVerifier, RUNTIME_HEADER } from '../src/runtime-auth.ts';
import type { BrokerStorage, BrokerTxn, EnrollmentStore } from '../src/runtime-auth.ts';
import type { RuntimeBinding } from '../src/contracts.ts';
import type { FlowDeps, FlowRecord, FlowStore } from '../src/flow.ts';
import type { OAuthCredentials } from '../src/oauth.ts';
import { masterSealer } from '../src/seal.ts';
export const binding: RuntimeBinding = { runtimePrincipalId: 'home-a', installationId: 'home-a', homeId: 'home-a', contentOwnerId: 'owner' };
export const fakeCredentials: OAuthCredentials = { accessToken: 'fake-access-canary', refreshToken: 'fake-refresh-canary',
  locationId: 'location-a', companyId: null, userId: 'user-a', scopes: ['contacts.readonly', 'contacts.write'], expiresAt: 5_000_000, scopeProvenance: 'oauth-token-response' };
export const key = new Uint8Array(32).fill(19);
export const b64 = (v: Uint8Array | string) => Buffer.from(v).toString('base64url');
export function storage(backing = new Map<string, unknown>()) {
  let tail = Promise.resolve();
  const control = { fail: false, backing };
  const make = (map: Map<string, unknown>): BrokerStorage => ({
    async get<T>(k: string) { return structuredClone(map.get(k)) as T | undefined; },
    async put<T>(k: string, v: T) { if (control.fail) throw Error('fake storage failure'); map.set(k, structuredClone(v)); },
    async delete(k) { if (control.fail) throw Error('fake storage failure'); return map.delete(k); },
    async list<T>({ prefix, limit, startAfter, end }: {prefix:string;limit?:number;startAfter?:string;end?:string}) { return new Map([...map].sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([k]) => k.startsWith(prefix)&&(!startAfter||k>startAfter)&&(!end||k<end)).slice(0, limit).map(([k,v]) => [k, structuredClone(v) as T])); },
    async transaction<T>(body: (txn: BrokerTxn) => Promise<T>) {
      let unlock!: () => void; const prior = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await prior;
      try { const copy = structuredClone(map); const result = await body(make(copy)); if (control.fail) throw Error('fake commit failure'); map.clear(); for (const [k,v] of copy) map.set(k,v); return result; }
      finally { unlock(); }
    },
  });
  return { state: { storage: make(backing) }, control };
}
export function enrollments(): EnrollmentStore & { records: Map<string, { binding: RuntimeBinding; runtimeKey: Uint8Array }> } {
  const records = new Map<string, { binding: RuntimeBinding; runtimeKey: Uint8Array }>(); const requests = new Map<string,number>();
  return { records, async get(id) { return records.get(id) ?? null; }, async createIfAbsent(b,k) { if (records.has(b.runtimePrincipalId)) return 'exists'; records.set(b.runtimePrincipalId,{binding:b,runtimeKey:k}); return 'created'; },
    async delete(id) { records.delete(id); }, async markRequest(id,r,until) { const k = `${id}:${r}`; if (requests.has(k)) return 'replayed'; requests.set(k,until); return 'fresh'; } };
}
export function flows(): FlowStore & { records: Map<string, FlowRecord> } {
  const records = new Map<string,FlowRecord>(); const previews = new Map<string,number>();
  return { records, async put(r) { records.set(r.flowId,structuredClone(r)); },
    async byLookup(h) { return structuredClone([...records.values()].find(r => r.lookupHash === h) ?? null); }, async byFlowId(id) { return structuredClone(records.get(id) ?? null); },
    async cas(id,from,r) { if (records.get(id)?.status !== from) return false; records.set(id,structuredClone(r)); return true; },
    async admit(r,now) { if ([...records.values()].filter(f => f.binding.runtimePrincipalId === r.binding.runtimePrincipalId && f.expiresAt > now && !['completed','expired','denied'].includes(f.status)).length >= 3) return false;
      records.set(r.flowId,structuredClone(r)); return true; },
    async previewAllowed(id,now) { if (now - (previews.get(id) ?? -Infinity) < 1000) return false; previews.set(id,now); return true; } };
}
let seq = 0;
export function signedRequest(path: string, method: 'GET'|'POST', body: unknown, now: number, runtimeKey: Uint8Array = key, b = binding, extra: Record<string,string> = {}) {
  const raw = method === 'GET' ? '' : JSON.stringify(body);
  const env = { ...b, requestId: `req-${++seq}`, issuedAt: now, expiresAt: now + 60_000 };
  const signature = createHmac('sha256',runtimeKey).update(['murage-crm-v1',path,method,env.runtimePrincipalId,env.installationId,env.homeId,env.contentOwnerId,env.requestId,env.issuedAt,env.expiresAt,createHash('sha256').update(raw).digest('hex')].join('\n')).digest('base64url');
  return new Request(`https://connect.murage.ai${path}`,{method,headers: { [RUNTIME_HEADER]: b64(JSON.stringify({...env,signature})), ...extra }, ...(method === 'POST' ? {body:raw} : {})});
}
export function flowFixture() {
  let now = 1_000_000, exchanges = 0, grants = 0; const completions = new Map<string, unknown>();
  const fs = flows(), es = enrollments();
  const d: FlowDeps = { routeMaster:key, ipAdmission:async()=>true, flows: fs, enrollments: es, verifier: new HmacRuntimeVerifier(es,() => now), master: masterSealer(b64(key)),
    now: () => now, random: n => new Uint8Array(randomBytes(n)), origin: 'https://connect.murage.ai', clientId: 'fake-client',
    oauth: async () => { exchanges++; return {kind:'ok',credentials: {...fakeCredentials,expiresAt:now+3_600_000}}; },
    grants: { async createPending(input) { const prior = input.completionId ? completions.get(input.completionId) : null; if(prior) return structuredClone(prior) as Awaited<ReturnType<FlowDeps["grants"]["createPending"]>>; grants++; const result: Awaited<ReturnType<FlowDeps["grants"]["createPending"]>> = {grant: { grantId:'grant-a',credentialVersion:1,grantVersion:1,connectionEpoch:input.connectionEpoch,
      provenance:'oauth-token-response',userType:'Location',locationId:input.credentials.locationId,scopes:[...input.credentials.scopes]},grantCapability:input.grantCapability ?? b64(key)}; if(input.completionId) completions.set(input.completionId,result); return result; } } };
  return { d, fs, es, counts: () => ({exchanges,grants}), advance: (ms: number) => { now += ms; } };
}
