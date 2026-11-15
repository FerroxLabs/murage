// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope-c (named usage deltas). Consumer owner: recall-scope-c (presentation cache).
import { expect, it } from 'vitest';
import { createTaskAggregateCache, sumTaskUsage } from './task-window.ts';
it('named usage deltas retain exact known/unknown totals without visiting task history',()=>{
  let reads=0,active=false;
  const rows=Array.from({length:5000},(_,n)=>({threadId:`task-${n}`,createdAt:n,usage:n%2?{input:4,output:2,turns:1,costUsd:null as number|null}:{input:3,output:1,turns:1,costUsd:0.5 as number|null,cachedInput:1}}));
  const tasks=new Proxy(rows,{get(target,key,receiver){if(active&&typeof key==='string'&&/^\d+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});
  const cache=createTaskAggregateCache(),get=()=>cache.get('reader',tasks,'task-0','stable',10,()=>undefined);
  get();active=true;
  for(const at of [0,1,2,3]) {
    const task=rows[at],before=task.usage,after={input:10,output:5,turns:2,costUsd:at%2?0.25:null,cachedInput:at%2?undefined:2};
    task.usage=after as typeof task.usage;cache.noteUsage('reader',before,after);
    expect(get().usage).toEqual(sumTaskUsage(rows));
  }
  expect(reads).toBe(0);expect(get().window.tasks.some(task=>task.threadId==='task-0')).toBe(true);
});
