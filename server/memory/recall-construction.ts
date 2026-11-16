// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: recall-scope, for cooperative construction primitives only.
/** Conservative accounting for retained facts and temporary copies. Unrelated authority facts count too.
 * Crossing either ceiling leaves recall unavailable; it never publishes a truncated audience. */
export const RECALL_CONSTRUCTION_BYTES = 128 * 1024 * 1024;
const RECALL_ACTIVE_CONSTRUCTION_BYTES = 256 * 1024 * 1024;
let activeConstructionBytes = 0;
export class ConstructionBudget {
  bytes = 0;
  private shared: boolean;
  constructor(shared = false) { this.shared = shared; }
  add(...strings: string[]): void {
    let added=4096;for(const value of strings)added+=value.length*4;
    this.bytes+=added;if(this.shared)activeConstructionBytes+=added;
    if (this.bytes > RECALL_CONSTRUCTION_BYTES || this.shared && activeConstructionBytes > RECALL_ACTIVE_CONSTRUCTION_BYTES) throw new Error('MEMORY_RECALL_STORAGE_LIMIT');
  }
  release():void {if(this.shared)activeConstructionBytes-=this.bytes;this.bytes=0;this.shared=false;}
}
const orderedObjectKeys = new WeakMap<object, readonly string[]>();
export function constructionObjectKeys(object: object, keys: readonly string[]): void { orderedObjectKeys.set(object, keys); }
/** Stable merge sort with one move per step; no history-sized native sort in a maintenance callback. */
export function* constructionSort<T>(input: T[], compare: (a:T,b:T)=>number): Generator<void,T[]> {
  let source = input, target: T[] = [];
  for (let width=1;width<input.length;width*=2) {
    target=[];
    for (let start=0;start<source.length;start+=2*width) {
      let a=start,b=Math.min(start+width,source.length);
      const ae=b,be=Math.min(start+2*width,source.length);
      while(a<ae || b<be) {
        target.push(b>=be || a<ae && compare(source[a],source[b])<=0 ? source[a++] : source[b++]);
        yield;
      }
    }
    source=target;
  }
  return source;
}
/** JSON's exact bytes, streamed without copying an entire scope set or roster into one string. */
export function* constructionJson(value: unknown): Generator<string> {
  if (typeof value==='string') {
    yield '"';
    for(let at=0;at<value.length;) {
      let end=Math.min(value.length,at+2048);
      if(end<value.length && value.charCodeAt(end-1)>=0xd800 && value.charCodeAt(end-1)<=0xdbff)end--;
      yield JSON.stringify(value.slice(at,end)).slice(1,-1);at=end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield '[';
    for(let i=0;i<value.length;i++){if(i)yield ',';yield* constructionJson(value[i]);}
    yield ']';
  } else if(value!==null && typeof value==='object') {
    yield '{';let first=true;
    // Large construction objects provide the key sequence already built one item per step.
    const keys=orderedObjectKeys.get(value);
    function* entries():Generator<string>{if(keys){for(const key of keys)yield key;}else for(const key in value as object)if(Object.hasOwn(value as object,key))yield key;}
    for(const key of entries())if((value as Record<string,unknown>)[key]!==undefined) {
      if(!first)yield ',';first=false;yield* constructionJson(key);yield ':';
      yield* constructionJson((value as Record<string,unknown>)[key]);
    }
    yield '}';
  } else yield JSON.stringify(value) ?? 'null';
}
