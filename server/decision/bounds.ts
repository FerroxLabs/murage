// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
export const CONTENT_FIELDS = new Set(['content','body','text','subject','message','description','new_string','old_string','fileContent']);
export function canonical(value: unknown): string {
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value) ?? 'null';
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as any)[k])).join(',')+'}';
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function freeze<T>(value:T): T {if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
/** No unbounded pre-clone. Hash content in chunks; policy never reads its tail. */
/** Copy the bounded prefix so a V8 sliced string cannot retain a large body. */
function textPrefix(value:string,bytes:number):string {
 let low=0,high=Math.min(value.length,Math.max(0,bytes));
 while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(value.slice(0,mid))<=bytes)low=mid;else high=mid-1;}
 if(low>0&&low<value.length&&/[\uD800-\uDBFF]/.test(value[low-1])&&/[\uDC00-\uDFFF]/.test(value[low]))low--;
 return Buffer.from(value.slice(0,low),'utf16le').toString('utf16le');
}
export function boundedProjection(value: unknown): any {
 let bytes=1_000_000,keys=10_000;const seen=new Set<object>();
 const visit=(v:unknown,depth:number,field=''):any=>{
  if(typeof v==='string'){
   if(CONTENT_FIELDS.has(field)&&v.length>65536) {const h=createHash('sha256');for(let i=0;i<v.length;){let end=Math.min(i+32768,v.length);if(end<v.length&&/[\uD800-\uDBFF]/.test(v[end-1])&&/[\uDC00-\uDFFF]/.test(v[end]))end--;h.update(v.slice(i,end),'utf8');i=end;}const head=textPrefix(v,Math.min(65536,Math.max(0,bytes)));bytes-=Buffer.byteLength(head);return {contentHash:h.digest('hex'),length:v.length,head};}
   const s=textPrefix(v,Math.max(0,bytes));bytes-=Buffer.byteLength(s);return s;
  }
  if(v===null||typeof v==='boolean'||typeof v==='number')return v;
  if(v===undefined)return null;
  if(typeof v!=='object'||depth>=32||seen.has(v)||bytes<=0||keys<=0)return {unread:true};
  seen.add(v);const out:any=Array.isArray(v)?[]:Object.create(null);
  for(const k in v){if(!Object.hasOwn(v,k))continue;if(--keys<0||bytes<=0||k.length>bytes)break;const keyBytes=Buffer.byteLength(k);if(keyBytes>bytes)break;bytes-=keyBytes;try {out[k]=visit((v as any)[k],depth+1,k);} catch {out[k]={unread:true};}}
  seen.delete(v);return out;
 };
 return freeze(visit(value,0));
}

/** Side-effect delivery keeps immutable content strings by reference. Policy
 * receives only their bounded/hash projection. No JSON clone of a file body. */
export function captureDelivery(projected:any,original:any,depth=0):any {
 if(projected===null||typeof projected!=='object'){
  if(projected!==original&&!(projected===null&&original===undefined))throw new Error('service-input-too-large');
  return original;
 }
 if(depth>=32||!original||typeof original!=='object'&&typeof original!=='string')throw new Error('service-input-too-large');
 if(projected.contentHash&&typeof original==='string'){
  const probe=boundedProjection({body:original}).body;
  if(probe.contentHash!==projected.contentHash)throw new Error('content-capture-conflict');
  return original;
 }
 if(Array.isArray(projected)!==Array.isArray(original))throw new Error('service-input-too-large');
 for(const k in original)if(Object.hasOwn(original,k)&&!Object.hasOwn(projected,k))throw new Error('service-input-too-large');
 const out:any=Array.isArray(projected)?[]:Object.create(null);
 for(const k of Object.keys(projected)){const descriptor=original&&typeof original==='object'?Object.getOwnPropertyDescriptor(original,k):undefined;out[k]=captureDelivery(projected[k],descriptor&&'value'in descriptor?descriptor.value:undefined,depth+1);}
 return freeze(out);
}
