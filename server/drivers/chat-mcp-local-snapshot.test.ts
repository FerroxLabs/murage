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
import { ChatMcpDescendants } from './chat-mcp-client.ts';
import { configureMcpStop, resetMcpStopForTests } from './mcp-stop-runtime.ts';
import { desktopCapture, desktopProof, type DesktopEnv, type StopRecord } from './mcp-stop-proof.ts';
beforeEach(()=>{probe.ps=0;});
it('a Linux MCP snapshot does not wait for a scheduled ps process before confirming descendants gone',async()=>{
  let running = true;
  const env: DesktopEnv = {
    platform: 'linux', bootId: async () => 'fixture-boot', pidns: async () => 'pid:[1]',
    visibility: async () => ({ hidepid: false, sameNs: true }),
    table: async () => running ? [{ pid: 200, ppid: 1, start: 'proc:100', startKind: 'proc', state: 'S', threads: 1 }] : [],
  };
  // The snapshot moved to the helper boundary; synchronous fs mocks cannot cross it.
  configureMcpStop({ targetDeps: {
    helper: async request => request.op === 'capture' ? { found: await desktopCapture(request.rootPid, env), rows: await env.table() }
      : request.op === 'desktopProof' ? desktopProof(request.record as StopRecord, env) : null,
    signalEnv: () => ({ platform: 'linux', identity: async () => running ? { start: 'proc:100', kind: 'proc' } : 'absent',
      kill: () => { running = false; }, residual: () => {} }),
  } });
  try {
    const descendants=new ChatMcpDescendants({pid:200} as ChildProcess,'linux');
    expect(await descendants.stop()).toBe(true);
    expect(probe.ps).toBe(0);
  } finally { resetMcpStopForTests(); }
});
