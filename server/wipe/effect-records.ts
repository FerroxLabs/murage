// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner producer contract: MAIN; owner approval consumer: wfp-b.
import {known, type Value, type EffectRecord, type Invocation, type InvocationSnapshot, type TargetReference, type WipeEffect} from './types.ts';

function immutable<T>(value:T):T {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))immutable(child);Object.freeze(value);}
 return value;
}
export function invocationSnapshot(inv:Invocation):InvocationSnapshot {
 return immutable(structuredClone({program:inv.program,argv:inv.argv,redirects:inv.redirects,cwd:inv.cwd,dialect:inv.dialect,platform:inv.platform,home:inv.home,drive:inv.drive,stdin:inv.stdin,env:[...(inv.env??[])],links:[...(inv.links??[])]}));
}
/** Destination roles are metadata only: no role changes a checker verdict.
 * Unrecognized/selector syntax stays unknown; all tokens still bind in origin. */
function diskDestinations(origin:InvocationSnapshot):Value[] {
 const tool=origin.program.toLowerCase(),words=origin.argv;
 const text=(index:number)=>{const value=words[index];return value?.k==='known'?value.s:'';};
 if(tool==='format')return words.filter(value=>value.k==='known'&&/^[a-z]:[\\/]?$/i.test(value.s)).map(value=>value.k==='known'?known(value.s.slice(0,2)+'\\'):value);
 if(tool==='format-volume'){
  const index=words.findIndex(value=>value.k==='known'&&/^-driveletter$/i.test(value.s));
  return index>=0&&/^[a-z]$/i.test(text(index+1))?[known(text(index+1)+':\\')]:[];
 }
 if(tool==='diskutil')return text(0).toLowerCase()==='erasedisk'?words.slice(3,4):text(0).toLowerCase()==='partitiondisk'?words.slice(1,2):[];
 if(!/^mkfs(?:\.|$)|^newfs(?:_|$)|^(?:mke2fs|wipefs)$/.test(tool))return [];
 const destinations:Value[]=[];
 const withValue=new Set(['-t','-L','-U','-O','-E','-b','-B','-i','-I','-N','-m','-o','-r','-C','-G','-J','-l','-M','-T','--types','--label','--uuid','--offset','--backup-file']);
 const flags=new Set(['-a','--all','-F','-f','--force','-q','-v','-n','-c','-cc','-j','-S','-V','--no-act','--backup','--lock','--parsable','--json']);
 let ended=false;
 for(let index=0;index<words.length;index++){
  const word=text(index);
  if(!ended&&word==='--'){ended=true;continue;}
  if(!ended&&word.startsWith('-')){
   const equals=word.indexOf('=');
   if(withValue.has(word)){index++;continue;}
   if(equals>=0&&withValue.has(word.slice(0,equals)))continue;
   if(flags.has(word))continue;
   return [];
  }
  destinations.push(words[index]!);
 }
 return destinations;
}
/** Every effect variant must choose a binding. Recursive producers pass records,
 * so a child never acquires its parent's argv or working directory. */
export function effectRecord(effect:WipeEffect, invocation:Invocation|InvocationSnapshot):EffectRecord {
 const origin='rawArgv'in invocation?invocationSnapshot(invocation):invocation;
 effect=structuredClone(effect);
 let values:TargetReference[];
 switch(effect.k){
  case 'delete':case 'git-clean':case 'device-write':case 'write':values=[{kind:'path',value:effect.target}];break;
  case 'move-away':values=[{kind:'path',value:effect.source},...(effect.destination===undefined?[]:[{kind:'path' as const,value:effect.destination}])];break;
  case 'sync-wipe':values=[{kind:'path',value:effect.dest}];break;
  case 'uncertain-operands':values=effect.words.map(value=>({kind:'path',value}));break;
  case 'disk-tool':{const destinations=diskDestinations(origin);values=destinations.length?[{kind:'disk-operands',destinations,argv:origin.argv,redirects:origin.redirects}]:[];break;}
  default:{const exhaustive:never=effect;throw Error(`unbound-wipe-effect:${exhaustive}`);}
 }
 if(values.length&&values.every(reference=>reference.kind==='path'&&reference.value.k==='opaque'&&!reference.value.entryOf&&!reference.value.entryAlternatives?.length))values=[];
 return immutable({effect,origin,binding:values.length?{kind:'targets' as const,values:values as [TargetReference,...TargetReference[]]}:{kind:'unknown-target' as const,reason:'no-operands'}});
}
