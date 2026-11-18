// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
const proc=vi.hoisted(()=>({
  root:process.pid+1_000_000,
  rows:new Map<number,{parent:number;ticks:number[]}>(),
  failure:'' as string,missing:false,gone:false,argsDenied:false,malformed:false,largeArgs:false,
}));
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();
  return {...actual,
    readdirSync:(path:unknown,...args:unknown[])=>String(path)==='/proc'?[...proc.rows.keys()].map(String):Reflect.apply(actual.readdirSync,actual,[path,...args]),
    readFileSync:(path:unknown,...args:unknown[])=>{
      const match=/^\/proc\/(\d+)\/(stat|cmdline)$/.exec(String(path));
      if(!match)return Reflect.apply(actual.readFileSync,actual,[path,...args]);
      const pid=Number(match[1]),row=proc.rows.get(pid)!;
      if(pid===proc.root+1 && (proc.failure || proc.missing))throw Object.assign(new Error('fixture read failure'),{code:proc.failure || 'ENOENT'});
      if(match[2]==='cmdline'){
        if(proc.argsDenied)throw Object.assign(new Error('fixture argv denied'),{code:'EACCES'});
        return proc.largeArgs?'x'.repeat(4*1024*1024+1):'node\0fixture.js\0';
      }
      if(pid===proc.root+1 && proc.malformed)return `${proc.root+1} (truncated)`;
      const ticks=row.ticks.length>1?row.ticks.shift()!:row.ticks[0];
      return `${pid} (fixture (nested) name)\nname) S ${row.parent} ${Array(17).fill('0').join(' ')} ${ticks} 0 0`;
    },
  };
});
import { linuxDescendantIdentities, linuxParentsAndArgs } from './linux-process-snapshot.ts';
import { ChatMcpDescendants } from './chat-mcp-client.ts';
// Keep fixture identities distinct from Vitest's real process identity.
const ROOT=proc.root,CHILD=ROOT+1;
beforeEach(()=>{
  Object.assign(proc,{failure:'',missing:false,gone:false,argsDenied:false,malformed:false,largeArgs:false});
  proc.rows=new Map([[process.pid,{parent:0,ticks:[1]}],[ROOT,{parent:0,ticks:[20]}],[CHILD,{parent:ROOT,ticks:[30]}]]);
  vi.spyOn(process,'kill').mockImplementation((pid,signal)=>{
    expect(signal).toBe(0);
    if(pid===proc.root+1 && proc.gone)throw Object.assign(new Error('fixture gone'),{code:'ESRCH'});
    return true;
  });
});
afterEach(()=>vi.restoreAllMocks());
it('walks full parentage and uses tick identities despite spaces, parentheses and newlines in comm',()=>{
  proc.rows.set(ROOT+2,{parent:CHILD,ticks:[40]});
  expect(linuxDescendantIdentities(ROOT)).toEqual(new Map([[CHILD,'proc:30'],[ROOT+2,'proc:40']]));
  expect(linuxParentsAndArgs([CHILD])).toEqual(new Map([[CHILD,{ppid:ROOT,start:'proc:30',args:'node fixture.js'}]]));
});
it('an unreadable descendant snapshot leaves teardown and its late confirmation unconfirmed',async()=>{
  proc.failure='EACCES';
  expect(linuxDescendantIdentities(ROOT)).toBeNull();
  const descendants=new ChatMcpDescendants({pid:ROOT} as ChildProcess,'linux');
  let released=false;void descendants.goneSignal().then(()=>{released=true;});
  expect(await descendants.stop()).toBe(false);
  await Promise.resolve();expect(released).toBe(false);
});
it('a missing live process is unknown and only ESRCH permits leaving it out',()=>{
  proc.missing=true;
  expect(linuxDescendantIdentities(ROOT)).toBeNull();
  expect(linuxParentsAndArgs([CHILD])).toBeNull();
  proc.gone=true;
  expect(linuxDescendantIdentities(ROOT)).toEqual(new Map());
  expect(linuxParentsAndArgs([CHILD])).toEqual(new Map());
});
it('a stat read failure during exit is omitted only after the OS independently confirms ESRCH',()=>{
  proc.failure='ESRCH';
  expect(linuxDescendantIdentities(ROOT)).toBeNull();
  proc.gone=true;
  expect(linuxDescendantIdentities(ROOT)).toEqual(new Map());
});
it('rejects malformed identity data instead of returning a partial tree',()=>{
  proc.malformed=true;
  expect(linuxDescendantIdentities(ROOT)).toBeNull();
  expect(linuxParentsAndArgs([CHILD])).toBeNull();
});
it('PID reuse while reading argv cannot authorize a signal',()=>{
  proc.rows.get(CHILD)!.ticks=[30,31];
  expect(linuxParentsAndArgs([CHILD])).toBeNull();
});
it('unreadable argv from a live process remains unknown',()=>{
  proc.argsDenied=true;
  expect(linuxParentsAndArgs([CHILD])).toBeNull();
});
it('native argv retains the ps probe four MiB result bound',()=>{
  proc.largeArgs=true;
  expect(linuxParentsAndArgs([CHILD])===null).toBe(true);
});
it('an oversized process table is unknown rather than an unbounded snapshot',()=>{
  for(let n=0;n<90_000;n++)proc.rows.set(ROOT+100_000+n,{parent:Number.MAX_SAFE_INTEGER,ticks:[Number.MAX_SAFE_INTEGER]});
  expect(linuxDescendantIdentities(ROOT)===null).toBe(true);
});
