// SPDX-License-Identifier: AGPL-3.0-or-later
// The only call-site surface for the narrow whole-root/disk breaker.
import { alwaysAskCommand } from './always-ask.ts';
import { evidenceScan,coarseEvidence } from './wipe/evidence.ts';
import { homedir } from 'node:os';
import type { AlwaysAskHit } from './always-ask.ts';
import type { NativeEffect } from './no-limits-fs.ts';
import { known, opaque, type WipeContext, type WipeEffect, type Verdict, type Dialect } from './wipe/types.ts';
import { cleanText } from './wipe/expand.ts';
import {interpreterEffects} from './wipe/interp.ts';
import { parse, walk,peel } from './wipe/invocation.ts';
import { effectsOf } from './wipe/programs.ts';
import { fromNativeEffects, fromNativeInput } from './wipe/native.ts';
import { RootClassifier } from './wipe/roots.ts';
import { registeredWipeProjects } from './wipe/registry.ts';
import { decide, faultVerdict } from './wipe/decide.ts';
export type { WipeContext } from './wipe/types.ts';
export const wipeCheckFault=():AlwaysAskHit=>{const {rule,what}=faultVerdict();return {rule,what};};
const hit=(verdict:Verdict):AlwaysAskHit|null=>verdict.k==='run'?null:{rule:verdict.rule,what:verdict.what};
const nativePaths=(effects:WipeEffect[],ctx:WipeContext)=>{const home=ctx.home??ctx.env?.HOME??ctx.env?.USERPROFILE??homedir(),expand=(v:import('./wipe/types.ts').Value)=>v.k==='known'?{...v,s:v.s.replace(/^~(?=[\\/]|$)/,home)}:v;return effects.map((effect):WipeEffect=>effect.k==='move-away'?{...effect,source:expand(effect.source)}:effect.k==='sync-wipe'?{...effect,dest:expand(effect.dest)}:'target'in effect?{...effect,target:expand(effect.target)}:effect);};
// Shell and code text may run where this host cannot look (WSL, a container, Cloud exec): item 4(b) lexical homes apply.
// Native tools act on this host and keep their existing release semantics.
// Checker internals: wfp-b2. Breaker ingress and overflow guard: r2-wait-c4-misc-d2c.
// MAIN RULING 1115-C4D2-GROK H2: a saturated glob inventory cannot prove an ordinary delete.
// Keep the registry's bounded-array contract; consult the complete subtree when available.
class ProtectedGlobOverflow extends Error {}
const breakerClassifier=(ctx:WipeContext,lexicalHomes=false)=>{
 const registry:ConstructorParameters<typeof RootClassifier>[1]=ctx.registry??registeredWipeProjects;
 return new RootClassifier(ctx,{
  contains:path=>registry.contains(path),
  ...(registry.containsIdentity?{containsIdentity:(stat:Parameters<NonNullable<typeof registry.containsIdentity>>[0])=>registry.containsIdentity!(stat)}:{}),
  protectedSubtreeChildren:dir=>{
   const complete=registry.protectedSubtreeChildren;
   const children=complete?.call(registry,dir)??registry.protectedChildren?.(dir)??[];
   if(children.length>256||(!complete&&children.length===256))throw new ProtectedGlobOverflow('wipe-protected-glob-overflow');
   return children;
  },
 },lexicalHomes);
};
const evaluate=(effects:WipeEffect[],ctx:WipeContext)=>{
 try{return hit(decide(effects,breakerClassifier(ctx,true)));}
 catch(error){if(error instanceof ProtectedGlobOverflow)return wipeCheckFault();throw error;}
};
// The recovery scanner neither tracks same-command assignments nor expands cmd variables: a variable the same
// text assigns, or a cmd variable, is undecided there. A variable the text never sets stays the scanner's own call.
const unreadVariable=(text:string)=>{for(const m of text.matchAll(/\$\{?([A-Za-z_]\w*)(?!\w)(?!\s*=(?!=))|%[A-Za-z_]\w*%/g))if(m[1]===undefined||new RegExp('(?:^|[\\s;&|({])\\$?'+m[1]+'\\s*=','i').test(text))return true;return false;};
function readAs(text:string,ctx:WipeContext):AlwaysAskHit|null {
 let state:import('./wipe/types.ts').ShellState|undefined;
 try{
  // MAIN RULING 23:15Z(c): retain the existing fork-bomb card.
  if((text.includes('(')||text.includes('function'))&&/(?:^|[^\w:])[\w:]+\s*\(\s*\)\s*\{|\bfunction\b/.test(text)){const bomb=alwaysAskCommand(text);if(bomb?.rule==='fork-bomb')return bomb;}
  const home=ctx.home??ctx.env?.HOME??ctx.env?.USERPROFILE??homedir();
  // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 5: variable values come only from the caller's engine env.
  const env=new Map<string,string|undefined>();
  for(const [name,value]of Object.entries({HOME:home,USERPROFILE:home})){env.delete(name);env.set(name,value);}
  for(const [name,value]of Object.entries(ctx.env??{})){env.delete(name);env.set(name,value);}
  const cwd=ctx.cwd??ctx.workFolder??ctx.project;
  // A shell sets PWD to its own working directory at start.
  if(cwd&&!ctx.cwdOpaque){env.delete('PWD');env.set('PWD',cwd);}
  // Product retention asks the classifier itself (static roots, registered projects, lexical homes; no IO).
  let lexical:RootClassifier|undefined;const protect=(path:string)=>{try{return !!(lexical??=new RootClassifier(ctx,ctx.registry??registeredWipeProjects,true)).classifyLexical(path);}catch{return true;}};
  const dialect:Dialect=ctx.dialect??(ctx.shell==='pwsh'||ctx.lang==='pwsh'?'pwsh':/^\s*(?:Remove-Item|Move-Item|ri|mi|Get-ChildItem|gci|Format-Volume|Clear-Disk|Initialize-Disk|Rename-Item|Get-Item)\b/i.test(text)?'pwsh':/^\s*(?:rd|rmdir|del|erase|move|robocopy|format)\s+\//i.test(text)?'cmd':'sh');
  state={env,home,platform:ctx.platform,proc:{},exported:new Set(env.keys()),exportedFns:new Set(),noEnv:ctx.env===undefined,vars:new Map(),arrays:new Map(),functions:new Map(),links:new Map(),dirStack:[],drive:/^([a-z]:)/i.exec(cwd??'')?.[1],startCwd:cwd,lexicalProtected:protect,cwd:!ctx.cwdOpaque&&cwd?known(cwd):opaque('cwd'),dialect,depth:0};
  if(ctx.lang==='py'||ctx.lang==='js'){const scan=interpreterEffects(text,env.get('HOME')??env.get('USERPROFILE')??home),nested=[...scan.shells.flatMap(body=>peel([known('sh'),known('-c'),known(body)],state!)),...scan.argv.flatMap(argv=>peel(argv,state!))];return evaluate([...scan.effects,...nested.flatMap(effectsOf)],ctx);}
  const invocations=walk(parse(cleanText(text),dialect),{...state,env:new Map(state.env)});
  return evaluate(invocations.flatMap(effectsOf),ctx);
 }catch{
  try{return evaluate(evidenceScan(cleanText(text),state??{home:homedir(),env:new Map(),cwd:opaque('cwd'),dialect:'sh',depth:0}).flatMap(effectsOf),{...ctx,pathPort:{realpath:()=>null,isBlockDevice:()=>null}})??(unreadVariable(text)&&coarseEvidence(text)?wipeCheckFault():null);} // recovery tracks no assignments: an unread variable is undecided
  catch{return coarseEvidence(text)?wipeCheckFault():null;}
 }
}
// MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 4(a): a caller that names no dialect may be handing over
// PowerShell or cmd text. Text carrying their markers is also read in those dialects; any reading that cards, cards.
// Markers are command words and switches only: each shell expands only its own variable syntax, so a foreign
// variable (`%USERPROFILE%` after rm, `$HOME` after rd) never selects a reading. cmd switches rule out PowerShell.
const pwshMarker=/(?:^|[\s;|&({=])(?:[a-z]+-(?:item|childitem|location|content|volume|disk|partition|expression|itemproperty)|rd|del|erase|ri|rmdir|gci|iex|pwsh|powershell)(?:\.exe)?(?=[\s;|)]|$)|(?:^|\s)-(?:fo|for|forc|force|rec|recu|recur|recurs|recurse|literalpath|whatif)(?=\s|$)|^\s*&\s/i;
const cmdMarker=/(?:^|[\s&|(])(?:rd|rmdir|del|erase|format|cmd|robocopy|move|if\s+exist|for\s+\/?%)(?:\.exe)?(?=\s|$)/i;
const cmdSwitch=/(?:^|\s)\/[a-z?](?=\s|$)/i;
// A PowerShell host handed backslash-quoted text is the cmd / CreateProcess spelling of an inner quote.
const hostEscapedQuote=/(?:^|[\s&|(])(?:pwsh|powershell)(?:\.exe)?\s[^\n]*\\"/i;
export function wipeBreaker(text:string,ctx:WipeContext={}):AlwaysAskHit|null {
 if(typeof text!=='string')return wipeCheckFault();
 const first=readAs(text,ctx);
 if(first||ctx.dialect||ctx.shell||ctx.lang||text.length>65536)return first;
 for(const dialect of [pwshMarker.test(text)&&!cmdSwitch.test(text)?'pwsh':undefined,cmdMarker.test(text)||hostEscapedQuote.test(text)?'cmd':undefined] as (Dialect|undefined)[]){
  if(!dialect)continue;
  const other=readAs(text,{...ctx,dialect});if(other)return other;
 }
 return first;
}
export function nativeWipeBreaker(tool:string,input:unknown,ctx:WipeContext={},filePaths?:readonly string[]):AlwaysAskHit|null {
 try{const classifier=breakerClassifier(ctx);return hit(decide(nativePaths(fromNativeInput(tool,input,filePaths,v=>classifier.isDevice(v)),ctx),classifier));}catch{return wipeCheckFault();}
}
export function nativeEffectsWipe(effects:readonly NativeEffect[],ctx:WipeContext={}):AlwaysAskHit|null {
 try{const classifier=breakerClassifier(ctx);return hit(decide(nativePaths(fromNativeEffects(effects,v=>classifier.isDevice(v)),ctx),classifier));}catch{return wipeCheckFault();}
}
