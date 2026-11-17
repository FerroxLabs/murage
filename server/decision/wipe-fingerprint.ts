// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { physicalWipePath } from '../wipe-path.ts';
import type { OwnerOperation } from '../no-limits-inspection.ts';
import type { EffectRecord, Value, WipeContext } from '../wipe/types.ts';
import { canonical } from './bounds.ts';
import {inspectWipe,inspectNativeWipe} from '../wipe-breaker.ts';

export type WipeCompleteness = 'complete' | 'unknown-target';
/** Fingerprinting consumes the checker's records. It never reparses code or
 * recursively rediscovers children with a second invocation reader. Legacy
 * direct callers obtain their records from the same authoritative producer. */
export function wipeFingerprint(operation:OwnerOperation,wipeClass:string,context:WipeContext={},records?:readonly EffectRecord[]):{
 fingerprint:string;resolvedTargets:readonly string[];completeness:WipeCompleteness;exactOperation:string;
} {
 if(operation.cwdInvalid)throw Error('wipe-fingerprint-invalid-cwd');
 if(records===undefined){
  const scanContext={...context,cwd:operation.cwd,cwdOpaque:operation.cwdInvalid};
  records=operation.kind==='native'?inspectNativeWipe(operation.effects,operation.rawTool??'',operation.rawInput,scanContext).records
   :inspectWipe(operation.text,{...scanContext,...(operation.kind==='code'?{lang:operation.lang}:{dialect:operation.dialect})}).records;
 }
 const targets=new Set<string>(),commands:unknown[]=[],evidence:unknown[]=[];
 let completeness:WipeCompleteness='complete';
 const probe=(token:string,cwd:string|undefined)=>{
  if(!token)return {state:'empty'};
  let target:string|undefined;
  if(context.pathPort){
   const path=context.platform==='win32'?win32:posix;
   if(!path.isAbsolute(token)&&!cwd)throw Error('wipe-path-unknown-cwd');
   target=context.pathPort.realpath(path.resolve(cwd??'',token))??undefined;
  }else target=physicalWipePath(token,cwd,true);
  if(target===undefined)return {state:'absent'};
  const identity=context.pathPort?(context.pathPort.stat?.(target)??context.pathPort.lstat?.(target)):statSync(target,{bigint:true});
  if(!identity){completeness='unknown-target';return {state:'unknown',target};}
  targets.add(target);
  return {state:'present',target,device:String(identity.dev),inode:String(identity.ino)};
 };
 const alternatives=(value:Value):string[]=>{
  const values=[...(value.k==='known'?[value.s,...(value.candidates??[]),...(value.glob?[value.glob.dir]:[])]:[]),...(value.entryOf?[value.entryOf.start]:[])];
  for(const entry of value.entryAlternatives??[])values.push(...alternatives(entry));
  return values;
 };
 for(const record of records){
  const {origin,binding}=record;
  if(origin.cwd.opaque)completeness='unknown-target';
  const cwdValues=origin.cwd.values.length?origin.cwd.values:origin.cwd.k==='known'?[origin.cwd.s]:[undefined];
  const envelope=[...origin.argv,...origin.redirects.map(redirect=>redirect.target)];
  const argv=[origin.program,...envelope.flatMap(value=>{const values=alternatives(value);return values.length?values:[undefined];})];
  // Preserve the established unread-argv hold. An unknown selector with known
  // argv is represented below and can be answered for exactly that operation.
  if(argv.some(value=>value===undefined))throw Error('wipe-fingerprint-unknown-argv');
  const objects:unknown[]=[];
  for(const cwd of cwdValues)for(let index=0;index<argv.length;index++){
   const token=argv[index]!,equals=token.indexOf('=');
   for(const [kind,text]of [['whole',token],...(equals<0?[]:[['equals-suffix',token.slice(equals+1)]])] as [string,string][])
    objects.push({index,probe:kind,...probe(text,cwd)});
  }
  commands.push({argv,objects});
  const bound:unknown[]=[];
  if(binding.kind==='unknown-target')completeness='unknown-target';
  else for(const reference of binding.values){
   if(reference.kind==='path'){
    const values=alternatives(reference.value);
    if(reference.value.k==='known'&&reference.value.mayOpaque)completeness='unknown-target';
    if(!values.length)completeness='unknown-target';
    for(const cwd of cwdValues)for(const value of values)bound.push({value,cwd,...probe(value,cwd)});
   }else{
    // The full child operand envelope above binds every token (including option
    // values and '=' suffixes). Completeness requires a destination operand;
    // an executable, redirect or unrelated option value cannot establish it.
    // Disk tools with selectors require platform resolution and remain unknown
    // on hosts that cannot identify their destination.
    const destinations=reference.destinations.flatMap(alternatives);
    let identified=false;
    for(const cwd of cwdValues)for(const destination of destinations){
     if(!destination)continue;
     const resolved=probe(destination,cwd);bound.push({destination,cwd,...resolved});
     if(resolved.state==='present')identified=true;
    }
    if(!identified)completeness='unknown-target';
   }
  }
  evidence.push({effect:record.effect,origin,binding,bound});
 }
 // Explicit target-free rules (fork bomb) keep exact-operation approval. A
 // scanner fault with no records is incomplete and still requires its card.
 if(!records.length&&wipeClass!=='fork-bomb'&&wipeClass!=='wipe-cleared')completeness='unknown-target';
 const exactOperation=createHash('sha256').update(canonical({operation,env:context.env,home:context.home,platform:context.platform})).digest('hex');
 return {fingerprint:canonical({version:4,wipeClass,completeness,exactOperation,commands,records:evidence}),resolvedTargets:[...targets].sort(),completeness,exactOperation};
}
