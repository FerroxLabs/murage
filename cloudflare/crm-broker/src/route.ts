// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { runtimeBindingSchema } from './contracts.ts';
import { hkdf,decode64 } from './seal.ts';
import { requestBytes,HmacRuntimeVerifier,durableEnrollmentStore } from './runtime-auth.ts';
import type { BrokerStorage } from './runtime-auth.ts';
import { durableFlowStore } from './flow.ts';
import { durableGrantStore } from './grant.ts';
import type { GrantDeps } from './grant.ts';
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const decodeHex=(value:string)=>Uint8Array.from(value.match(/../gu) ?? [],s=>Number.parseInt(s,16));
/** A locator only. Every runtime/capability check runs inside the chosen home. */
export async function homeRouteTag(master:Uint8Array,homeId:string):Promise<string>{
  if(master.length!==32)throw Error('invalid_request');
  const key=await crypto.subtle.importKey('raw',await hkdf(master,'home-route'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(homeId));
  return hex(new Uint8Array(signature)).slice(0,32);
}
export function callbackRouteTag(state:string):string|null{
  try{if(!/^[A-Za-z0-9_-]{64}$/u.test(state))return null;const bytes=decode64(state);return bytes.length===48?hex(bytes.slice(0,16)):null;}catch{return null;}
}
export async function routeHomeId(req:Request):Promise<string|null>{
  try{
    const runtime=req.headers.get('x-murage-runtime'),preview=req.headers.get('x-murage-binding');
    const header=runtime ?? preview;
    if(header && header.length>16384)return null;
    const bytes=header?decode64(header):await requestBytes(req.clone());if(!bytes)return null;
    const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!raw || typeof raw!=='object')return null;
    // Project identifiers only: this is routing, never envelope authentication.
    const fields=raw as Record<string,unknown>,parsed=runtimeBindingSchema.safeParse({runtimePrincipalId:fields.runtimePrincipalId,installationId:fields.installationId,homeId:fields.homeId,contentOwnerId:fields.contentOwnerId});
    return parsed.success?parsed.data.homeId:null;
  }catch{return null;}
}
export interface HomeAuthority {flows:ReturnType<typeof durableFlowStore>;enrollments:ReturnType<typeof durableEnrollmentStore>;grants:ReturnType<typeof durableGrantStore>;verifier:HmacRuntimeVerifier}
const authorities=new WeakMap<BrokerStorage,HomeAuthority>();
/** Call in the per-home DO constructor with its stable storage object. Never
 * construct grant stores in fetch(): their serial chain spans provider I/O. */
export function homeAuthority(storage:BrokerStorage,deps:GrantDeps):HomeAuthority{
  const existing=authorities.get(storage);if(existing)return existing;
  const enrollments=durableEnrollmentStore(storage,deps.master,deps.now);
  const authority={flows:durableFlowStore(storage),enrollments,grants:durableGrantStore({storage},deps),verifier:new HmacRuntimeVerifier(enrollments,deps.now)};
  authorities.set(storage,authority);return authority;
}
