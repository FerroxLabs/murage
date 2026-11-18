// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Snapshot and teardown repair owner: askcards-flake-b; integration owner: MAIN.
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
const probe=vi.hoisted(()=>({ps:0}));
vi.mock('node:child_process',async original=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,execFile:(...args:unknown[])=>{
    if(args[0]==='ps'){probe.ps++;return {};}
    return Reflect.apply(actual.execFile,actual,args);
  }};
});
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();
  const stat=(pid:number)=>`${pid} (fixture (process)) S 1 ${Array(17).fill('0').join(' ')} 100 0 0`;
  return {...actual,
    readdirSync:(path:unknown,...args:unknown[])=>String(path)==='/proc'?['200',String(process.pid)]:Reflect.apply(actual.readdirSync,actual,[path,...args]),
    readFileSync:(path:unknown,...args:unknown[])=>{
      const match=/^\/proc\/(\d+)\/stat$/.exec(String(path));
      return match?stat(Number(match[1])):Reflect.apply(actual.readFileSync,actual,[path,...args]);
    },
  };
});
import { ChatMcpDescendants } from './chat-mcp-client.ts';
beforeEach(()=>{probe.ps=0;});
it('a Linux MCP snapshot does not wait for a scheduled ps process before confirming descendants gone',async()=>{
  const descendants=new ChatMcpDescendants({pid:200} as ChildProcess,'linux');
  expect(await descendants.stop()).toBe(true);
  expect(probe.ps).toBe(0);
});
