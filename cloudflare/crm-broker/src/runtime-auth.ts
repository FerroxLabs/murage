// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import { signedRuntimeRequestSchema } from "./contracts.ts";
import { decode64, encode64, equalHash, sha256 } from "./seal.ts";
import type { Sealer } from "./seal.ts";
import type { BROKER_ROUTES, RuntimeBinding, RuntimeRequestVerifier } from "./contracts.ts";
export type BrokerRoute = typeof BROKER_ROUTES[number];
export type SignedRuntimeRequest = z.infer<typeof signedRuntimeRequestSchema>;
export const RUNTIME_HEADER = "x-murage-runtime", GRANT_HEADER = "x-murage-grant";
export const RUNTIME_SKEW_MS = 30_000, REPLAY_WINDOW_MS = 120_000;
export interface EnrollmentStore {
  get(id: string): Promise<{ binding: RuntimeBinding; runtimeKey: Uint8Array } | null>;
  createIfAbsent(binding: RuntimeBinding, runtimeKey: Uint8Array, guard?: {flowId:string;homeGeneration:number}): Promise<"created" | "exists">;
  delete(id: string): Promise<void>;
  /** Atomically refuse expired deadlines or a live replay marker before insertion. */
  markRequest(principalId: string, requestId: string, until: number): Promise<"fresh" | "replayed">;
}
/** Structural Workers storage: adapters require real atomic transactions. */
export interface BrokerTxn {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number; startAfter?: string; end?: string }): Promise<Map<string, T>>;
}
export interface BrokerStorage extends BrokerTxn {
  transaction<T>(body: (txn: BrokerTxn) => Promise<T>): Promise<T>;
}
export interface VerifiedRuntimeRequest { readonly binding: RuntimeBinding; readonly body: Uint8Array }
export interface RequestRuntimeVerifier extends RuntimeRequestVerifier {
  verifyRequest(request: Request, route: BrokerRoute): Promise<VerifiedRuntimeRequest | null>;
}
export function canonicalRuntimeMessage(route: BrokerRoute, method: "GET" | "POST", env: Omit<SignedRuntimeRequest, "signature">, bodySha256Hex: string): string {
  return ["murage-crm-v1", route, method, env.runtimePrincipalId, env.installationId, env.homeId, env.contentOwnerId,
    env.requestId, env.issuedAt, env.expiresAt, bodySha256Hex].join("\n");
}
export function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return a.runtimePrincipalId === b.runtimePrincipalId && a.installationId === b.installationId && a.homeId === b.homeId && a.contentOwnerId === b.contentOwnerId;
}
export async function requestBytes(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > 32768) return null;
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0, reads = 0;
  try { while (true) { if (++reads > 32768) return null; const r = await reader.read(); if (r.done) break;
    total += r.value.length; if (total > 32768) return null; chunks.push(r.value); }
    const out = new Uint8Array(total); let offset=0; for (const chunk of chunks) {out.set(chunk,offset);offset+=chunk.length;} return out;
  } finally { void reader.cancel().catch(()=>{}); }
}
export class HmacRuntimeVerifier implements RequestRuntimeVerifier {
  private readonly store: EnrollmentStore; private readonly now: () => number;
  constructor(store: EnrollmentStore, now: () => number = Date.now) { this.store=store; this.now=now; }
  // Frozen interface has no method/body context and therefore cannot authorize.
  async verify(_request: SignedRuntimeRequest, _route: BrokerRoute): Promise<RuntimeBinding | null> { return null; }
  async verifyRequest(request: Request, route: BrokerRoute): Promise<VerifiedRuntimeRequest | null> {
    try {
      if (new URL(request.url).pathname !== route || (request.method !== "POST" && request.method !== "GET")) return null;
      const header=request.headers.get(RUNTIME_HEADER); if (!header || header.length>16384) return null;
      const parsed=signedRuntimeRequestSchema.safeParse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decode64(header)))); if (!parsed.success) return null;
      const env=parsed.data;
      const enrolled=await this.store.get(env.runtimePrincipalId); if (!enrolled || !sameBinding(env,enrolled.binding)) return null;
      const bytes=await requestBytes(request.clone()); if (!bytes) return null;
      const key=await crypto.subtle.importKey("raw",new Uint8Array(enrolled.runtimeKey),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
      if (!await crypto.subtle.verify("HMAC",key,decode64(env.signature),new TextEncoder().encode(canonicalRuntimeMessage(route,request.method,env,await sha256(bytes))))) return null;
      // Body reads and cryptography may outlive the signed request.
      const now=this.now();
      if (env.issuedAt>now+RUNTIME_SKEW_MS || env.expiresAt<=now || now-env.issuedAt>60_000+RUNTIME_SKEW_MS) return null;
      if (await this.store.markRequest(env.runtimePrincipalId,env.requestId,now+REPLAY_WINDOW_MS) !== "fresh") return null;
      return {binding:enrolled.binding,body:bytes};
    } catch { return null; }
  }
}
export function durableEnrollmentStore(storage: BrokerStorage, master: Sealer, now: () => number = Date.now): EnrollmentStore {
  type Record = {binding:RuntimeBinding;runtimeKeySealed:string;createdAt:number};
  return {
    async get(id) { const rec=await storage.get<Record>(`enr:${id}`); if (!rec) return null;
      const runtimeKey=await master.open("runtime-key",id,1,rec.runtimeKeySealed); if (!runtimeKey || runtimeKey.length!==32) return null;
      return {binding:rec.binding,runtimeKey}; },
    async createIfAbsent(binding,key,guard) { if (key.length!==32) throw Error("invalid_request");
      const sealed=await master.seal("runtime-key",binding.runtimePrincipalId,1,key);
      return storage.transaction(async tx=>{const id=`enr:${binding.runtimePrincipalId}`;
        // The flow and home fence are checked inside the enrollment insertion.
        if(guard){const h=await tx.get<string>(`flowid:${guard.flowId}`),flow=h?await tx.get<{status:string;expiresAt:number;generation:number;binding:RuntimeBinding}>(`flow:${h}`):undefined;
          const generation=(await tx.get<{generation:number}>(`home:${binding.homeId}`))?.generation ?? 1;
          if(!flow || !sameBinding(flow.binding,binding) || flow.generation!==guard.homeGeneration || generation!==guard.homeGeneration || flow.expiresAt<=now() || !["completing","completed"].includes(flow.status))throw Error("flow_expired");}
        if (await tx.get(id)) return "exists";
        await tx.put(id,{binding,runtimeKeySealed:sealed,createdAt:now()}); return "created";}); },
    async delete(id) { await storage.delete(`enr:${id}`); },
    async markRequest(id,requestId,until) { return storage.transaction(async tx=>{const key=`rq:${id}:${requestId}`;
      const prior=await tx.get<number>(key),at=now();
      if(until<=at || (prior ?? 0)>at) return "replayed"; await tx.put(key,until); await tx.put(expiryKey("rqdue:",until,key),key); return "fresh";}); },
  };
}
// Capability hashes use a fixed-work comparison; no plaintext capability storage.
export async function matchesCapability(capability: string, hash: string): Promise<boolean> { return equalHash(await sha256(capability),hash); }
export const randomCapability = () => encode64(crypto.getRandomValues(new Uint8Array(32)));

/** Each alarm page has a fixed bound, including legacy-index backfill. Workers
 * list ranges examine indexed keys only; startAfter is durable across restarts. */
export const STORAGE_PAGE_SIZE=64;
export const expiryKey=(prefix:string,at:number,id="")=>`${prefix}${String(at).padStart(16,"0")}:${id}`;
export async function legacyPage<T>(tx:BrokerTxn,prefix:string):Promise<Map<string,T>> {
  const key=`scan:${prefix}`,cursor=await tx.get<{after?:string;done?:boolean}>(key);
  if(cursor?.done)return new Map();
  const page=await tx.list<T>({prefix,startAfter:cursor?.after,limit:STORAGE_PAGE_SIZE});
  await tx.put(key,{after:[...page.keys()].at(-1) ?? cursor?.after,done:page.size<STORAGE_PAGE_SIZE});return page;
}
