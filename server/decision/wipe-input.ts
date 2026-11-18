// SPDX-License-Identifier: AGPL-3.0-or-later
import { freeze } from './bounds.ts';

/** Keep complete inputs when possible. On capacity/integrity failure, retain
 * the executable/native fields independently of unrelated presentation data.
 * This sidecar is only evidence for the narrow breaker, never an execution copy. */
export const WIPE_INPUT_MAX_BYTES = 16 * 1024 * 1024;
export function captureWipeInput<T>(value:T):T|null {
 let bytes=0,nodes=0;
 const copies=new Map<object,any>(),ancestors=new Set<object>();
 const charge=(size:number)=>{bytes+=size;if(bytes>WIPE_INPUT_MAX_BYTES)throw Error('wipe-input-capacity');};
 const visit=(v:unknown,depth:number):any=>{
  if(++nodes>100_000||depth>128)throw Error('wipe-input-capacity');
  if(typeof v==='string'){charge(Buffer.byteLength(v));return v;}
  if(v===null||v===undefined||typeof v==='boolean'||typeof v==='number'){charge(8);return v;}
  if(typeof v!=='object'||ancestors.has(v))throw Error('wipe-input-integrity');
  if(copies.has(v))return copies.get(v);
  const out:any=Array.isArray(v)?[]:Object.create(null);copies.set(v,out);ancestors.add(v);
  for(const key of Object.keys(v)){
   charge(Buffer.byteLength(key));
   const descriptor=Object.getOwnPropertyDescriptor(v,key);
   if(!descriptor||!('value'in descriptor))throw Error('wipe-input-integrity');
   out[key]=visit(descriptor.value,depth+1);
  }
  ancestors.delete(v);return out;
 };
 try{return freeze(visit(value,0));}catch{return captureWipeFields(value);}
}

// Fixed schema edges: do not walk arbitrary content, descriptions or padding.
const wipeFields = new Set([
 'threadId','requestId','turnId','providerInstanceId','generation','tool','inputHash','event',
 'toolCall','name','input','toolKind','toolEngine','toolIdentity','namespace','mcpMounts',
 'engineName','mountId','provenance','toolInputTruncated','summary','filePaths',
 'execEnv','env','absent','unread','cwd','workdir','executionCwd','commandShell','cwdInvalid','cwdExplicit','shell','capture',
 'tool_name','toolName','tool_input','toolInput','variant',
 'command','cmd','script','argv','code','patch','fileChanges','grantRoot',
 'path','file_path','filename','directory','root','target','source','source_path','old_path',
 'paths','files','edits','entries','changes','kind','type','move_path','movePath',
 'filePath','notebook_path','TargetFile','AbsolutePath','Path','FilePath','File','DirectoryPath',
 'destination','dest','src','from','new_path','link_path','removed','recursive','dir',
]);
export function captureWipeFields<T>(value:T):T|null {
 const ancestors=new Set<object>(),copies=new Map<object,any>(),environments=new Map<object,any>(),changeMaps=new Map<object,any>();
 const visit=(v:unknown,depth:number,environment=false,changeMap=false):any=>{
  if(v===null||typeof v!=='object')return typeof v==='function'?undefined:v;
  if(depth>32||ancestors.has(v))return undefined;
  const memo=environment?environments:changeMap?changeMaps:copies;
  if(memo.has(v))return memo.get(v);
  ancestors.add(v);
  const out:any=Array.isArray(v)?[]:Object.create(null);memo.set(v,out);
  // Object keys of opaque content are never visited. Environment maps have
  // arbitrary names, but values are strings rather than nested input objects.
  const keys=Array.isArray(v)||environment||changeMap?Object.keys(v):[...wipeFields];
  for(const key of keys){
   const descriptor=Object.getOwnPropertyDescriptor(v,key);
   if(!descriptor)continue;
   if(!('value'in descriptor))throw Error('wipe-field-integrity');
   const item=descriptor.value;
   out[key]=environment?(typeof item==='string'?item:undefined):visit(item,depth+1,!changeMap&&key==='env',!changeMap&&key==='fileChanges');
  }
  ancestors.delete(v);return out;
 };
 try{return freeze(visit(value,0));}catch{return null;}
}
