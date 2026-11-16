import { vendorSecretSpans } from "./provider-secret-mask.mjs";
/** Original-input Basic extents, in UTF-16 coordinates. This module has no
 * server/browser dependencies and no mutable state shared between calls. */
export type BasicSpan = Readonly<{start:number;end:number;payloadStart:number;payloadEnd:number;originId:number}>;
export type Edit = Readonly<{start:number;end:number;length:number}>;
export type EditCollector = (edit:Edit)=>void;
// A whole-input sink fallback must drop vendor carry without changing the
// release-base Basic edit stream (A5). Other rules ignore the third argument.
export type TrackedRule = (text:string,edits?:EditCollector,discardCarry?:()=>void)=>string;
export type ForwardedSpan = Readonly<{start:number;end:number;origins:readonly Readonly<{id:number;length:number}>[]}>;
const alphaNumeric=(code:number)=>(code>=48&&code<=57)||(code>=65&&code<=90)||(code>=97&&code<=122);
const hex=(code:number)=>(code>=48&&code<=57)||(code>=65&&code<=70)||(code>=97&&code<=102);
const unitSize=(s:string,i:number)=>s.charCodeAt(i)===37?(hex(s.charCodeAt(i+1))&&hex(s.charCodeAt(i+2))?3:0):i<s.length&&!alphaNumeric(s.charCodeAt(i))?1:0;
/** Cache GAP and successor endpoints once. No failed header or punctuation
 * give-back restarts a suffix scan; each gap/value has bounded visits. */
export type BasicWork = { visits:number; allocations:number };
export function basicSpans(original:string,work?:BasicWork):BasicSpan[] {
  if(work){work.visits=original.length;work.allocations=original.length;}
  const n=original.length;if(n<20)return [];
  const lower=original.replace(/[A-Z]/g,c=>c.toLowerCase());
  const names:number[]=[];for(let at=lower.indexOf("authorization");at>=0;at=lower.indexOf("authorization",at+13))names.push(at);
  if(!names.length)return [];
  if(work){work.visits+=3*n+names.length;work.allocations+=3*(n+1)+names.length;}
  const gap=new Uint32Array(n+1),takes=new Uint32Array(n+1),end=new Uint32Array(n+1);
  gap[n]=end[n]=n;
  for(let i=n-1;i>=0;i--){const size=unitSize(original,i);gap[i]=size?gap[i+size]!:i;}
  for(const at of names){const scheme=gap[at+13]!;if(lower.startsWith("basic",scheme)&&gap[scheme+5]!>scheme+5)takes[at]=gap[scheme+5]!;}
  for(let i=n-1;i>=0;i--){
    const c=original.charCodeAt(i),next=original.charCodeAt(i+1);
    if(takes[i] || c===34 || c===39 || (c===92&&(next===34||next===39)) || (c===10&&next!==32&&next!==9))end[i]=i;
    else end[i]=end[i+(c===10?2:1)]!;
  }
  const spans:BasicSpan[]=[];let consumed=0;
  for(const name of names){
    if(name<consumed || !takes[name])continue;
    const start=gap[name+13]!;let at=start,last=start,gapStart=start+5,repetitions=0;
    while(lower.startsWith("basic",at)&&gap[at+5]!>at+5){if(work)work.visits++;last=at;gapStart=at+5;at=gap[gapStart]!;repetitions++;}
    let payload=at;
    if(end[payload]===payload){
      // Normal parsing has priority over EMPTY, including greedy GAP1
      // giving back its last eligible suffix (but never its sole UNIT).
      let eligible=-1;
      for(let i=gapStart+unitSize(original,gapStart);i<at;){
        if(work)work.visits++;
        if(end[i]!>i)eligible=i;
        const size=unitSize(original,i);if(!size)break;i+=size;
      }
      if(eligible>=0)payload=eligible;
      else if(repetitions>1)payload=last;
    }
    if(end[payload]!>payload){
      consumed=end[payload]!;
      spans.push({start,end:consumed,payloadStart:payload,payloadEnd:consumed,originId:spans.length});
    }else if(takes[at]){
      let emptyEnd=at;while(emptyEnd>start&&/\s/.test(original[emptyEnd-1]!))emptyEnd--;
      spans.push({start,end:emptyEnd,payloadStart:at,payloadEnd:at,originId:spans.length});consumed=at;
    }
  }
  if(work)work.allocations+=spans.length*5;
  return spans;
}
const originsOf=(span:BasicSpan|ForwardedSpan)=>"origins" in span?span.origins:[{id:span.originId,length:span.payloadEnd-span.payloadStart}];
/** Sorted edits are relative to the text BEFORE one rule. An intersecting
 * replacement belongs to the entire protected extent, even when it deletes
 * all bytes. Insertion at start belongs; insertion at exclusive end does not. */
export function forwardSpans(spans:readonly (BasicSpan|ForwardedSpan)[],edits:readonly Edit[]):ForwardedSpan[] {
  const mapped:{start:number;end:number;origins:Map<number,number>}[]=[];let i=0,shift=0;
  for(const span of spans){
    while(i<edits.length){const e=edits[i]!;if(e.end>span.start || (e.start===span.start&&e.end===span.start))break;shift+=e.length-(e.end-e.start);i++;}
    let start=span.start+shift,finish=span.end+shift,local=shift;
    for(let j=i;j<edits.length;j++){
      const e=edits[j]!;
      if(e.start>span.end || (e.start===span.end&&span.start!==span.end))break;
      if(e.end<span.start)continue;
      const replacementStart=e.start+local,replacementEnd=replacementStart+e.length;
      if(e.start<=span.start)start=Math.min(start,replacementStart);
      local+=e.length-(e.end-e.start);
      finish=e.end>=span.end?replacementEnd:span.end+local;
      if(e.end>=span.end && e.end!==e.start)break;
    }
    const previous=mapped[mapped.length-1];
    if(previous && start<=previous.end){previous.end=Math.max(previous.end,finish);for(const origin of originsOf(span))previous.origins.set(origin.id,origin.length);}
    else mapped.push({start,end:finish,origins:new Map(originsOf(span).map(o=>[o.id,o.length]))});
  }
  return mapped.map(span=>({start:span.start,end:span.end,origins:[...span.origins].map(([id,length])=>({id,length}))}));
}
/** B1: forward only surviving original characters, retaining each fragment's
 * own origins. This is whole-edit forwarding followed by subtraction of the
 * replacement, without merging unrelated origins across a base replacement.
 * Spans and edits are ordered and disjoint. An edit covering several spans is
 * visited once per covered span; other edits advance the shared cursor once.
 * Basic extents still use forwardSpans, with its original merge semantics. */
export function forwardVisibleSpans(spans:readonly ForwardedSpan[],edits:readonly Edit[]):ForwardedSpan[] {
  const visible:ForwardedSpan[]=[];let i=0,shift=0;
  for(const span of spans){
    while(i<edits.length&&edits[i]!.end<=span.start){
      const edit=edits[i++]!;shift+=edit.length-(edit.end-edit.start);
    }
    let start=span.start;
    while(i<edits.length&&edits[i]!.start<span.end){
      const edit=edits[i]!;
      if(start<edit.start)visible.push({...span,start:start+shift,end:edit.start+shift});
      start=Math.max(start,edit.end);
      // Keep this edit for the next span if its removed input extends past us.
      if(edit.end>span.end)break;
      shift+=edit.length-(edit.end-edit.start);i++;
    }
    if(start<span.end)visible.push({...span,start:start+shift,end:span.end+shift});
  }
  return visible;
}
/** Native replace keeps capture/offset semantics and resets global lastIndex.
 * Only actual replacements report edits; the collector never sees text. */
export function replaceTracked(text:string,regexp:RegExp,replacer:(substring:string,...args:any[])=>string,collector?:EditCollector):string {
  return text.replace(regexp,(...args:any[])=>{
    const replacement=replacer(args[0],...args.slice(1));
    const offset=args[typeof args[args.length-1]==="object"?args.length-3:args.length-2] as number;
    if(replacement!==args[0])collector?.({start:offset,end:offset+args[0].length,length:replacement.length});
    return replacement;
  });
}
/** Splice only after all base stages. Origin lengths survive merges and edits. */
export function spliceSpans(text:string,spans:readonly (BasicSpan|ForwardedSpan)[],markerForLength:(length:number)=>string):string {
  const chunks:string[]=[];let at=0;
  for(const span of spans){chunks.push(text.slice(at,span.start),markerForLength(originsOf(span).reduce((sum,o)=>sum+o.length,0)));at=span.end;}
  chunks.push(text.slice(at));return chunks.join("");
}
export function maskBasicAuthCarry(original:string,trackedChain:readonly TrackedRule[],markerForLength:(length:number)=>string,initial:readonly ForwardedSpan[]):StageResult {
  let spans:readonly (BasicSpan|ForwardedSpan)[]=basicSpans(original),text=original,carry=initial;
  for(const rule of trackedChain){
    const edits:Edit[]=[];
    text=rule(text,spans.length||carry.length?e=>edits.push(e):undefined,()=>{carry=[];});
    if(spans.length&&edits.length)spans=forwardSpans(spans,edits);
    if(carry.length&&edits.length)carry=forwardVisibleSpans(carry,edits);
  }
  const edits:Edit[]=[];
  const result=spliceSpans(text,spans,length=>{
    const marker=markerForLength(length),span=spans[edits.length]!;
    edits.push({start:span.start,end:span.end,length:marker.length});
    return marker;
  });
  if(carry.length&&edits.length)carry=forwardVisibleSpans(carry,edits);
  return {text:result,carry};
}
export function maskBasicAuth(original:string,trackedChain:readonly TrackedRule[],markerForLength:(length:number)=>string):string {
  return maskBasicAuthCarry(original,trackedChain,markerForLength,[]).text;
}
export type StageResult = Readonly<{text:string;carry:readonly ForwardedSpan[]}>;
export type CarryStage = (text:string,carry:readonly ForwardedSpan[])=>StageResult;
export const basicStage=(chain:readonly TrackedRule[],marker:(length:number)=>string):CarryStage =>
  (text,carry)=>maskBasicAuthCarry(text,chain,marker,carry);
export const tracked=(rule:TrackedRule):CarryStage => (text,carry)=>{
  const edits:Edit[]=[];
  const shown=rule(text,carry.length?e=>edits.push(e):undefined,()=>{carry=[];});
  return {text:shown,carry:carry.length&&edits.length?forwardVisibleSpans(carry,edits):carry};
};
export function runStages(text:string,stages:readonly CarryStage[],carry:readonly ForwardedSpan[]=[]):string {
  for(const stage of stages)({text,carry}=stage(text,carry));
  return text;
}
// Each vendor fragment retains this one origin through every visible forward;
// splitting cannot multiply an origin list or make final rendering quadratic.
export const vendorCarry=(text:string):ForwardedSpan[]=>vendorSecretSpans(text).map((s,id)=>({...s,origins:[{id,length:s.end-s.start}]}));
export function maskVendorLast(original:string,stages:readonly CarryStage[],markerForLength:(length:number)=>string):string {
  let carry:readonly ForwardedSpan[]=vendorCarry(original);
  if(!carry.length)return runStages(original,stages);
  let text=original;
  for(const stage of stages)({text,carry}=stage(text,carry));
  return spliceSpans(text,carry,markerForLength);
}
