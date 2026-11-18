// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkFixtureWrite } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs, parkReason } from './park-fs.ts';
import { windowsSecurityPathsSync, WindowsSecurityTimeoutError, type SecurityRunner, type SecurityRunOptions } from './storage.ts';

const roots: string[] = [];
const sid = 'S-1-5-21-1-2-3-1001';
const sddl = `O:${sid}D:P(A;;FA;;;${sid})`;
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const root = privateParkTemp(join(tmpdir(), 'park-windows-race-')); roots.push(root);
  const key = join(root, 'key'); parkFixtureWrite(key, 'fixture-key', { mode: 0o600 });
  return { root, key };
}
function rows(opts: SecurityRunOptions) {
  return (JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[]).map(path =>
    JSON.stringify({ path, attributes: lstatSync(path).isDirectory() ? 16 : 0, sddl })).join('\n');
}
const options = (windowsRun: SecurityRunner, deadline = Date.now() + 30_000) =>
  ({ platform: 'win32' as const, windowsRun, windowsSid: () => sid, deadline });
const timeout = () => Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' });

for (const change of ['ancestor timestamps', 'file mtime', 'ancestor ino', 'ancestor dev'] as const) {
  test(`Windows security walk handles concurrent ${change} during native read`, () => {
    const { root, key } = fixture(), ancestor = dirname(root);
    let changed = false, reads = 0;
    const stat = (path: string, options: {bigint:true}) => {
      const value = lstatSync(path, options);
      if ((change === 'file mtime' ? reads >= 2 : changed) && path === (change === 'file mtime' ? key : ancestor)) {
        if (change === 'ancestor ino') value.ino += 1n;
        else if (change === 'ancestor dev') value.dev += 1n;
        else {
          value.mtimeNs += 1_000_000_000n; value.mtimeMs += 1000n;
          if (change === 'ancestor timestamps') { value.ctimeNs += 1_000_000_000n; value.ctimeMs += 1000n; value.size += 1n; }
        }
      }
      return value;
    };
    const run: SecurityRunner = (_file, _args, opts) => { const output = rows(opts); changed = true; reads++; return output; };
    const create = () => {const io = new ParkFs(root, { ...options(run), stat });if(change === 'file mtime')io.checked(key);return io;};
    if (change === 'ancestor timestamps') expect(create().read(key, 64, true).toString()).toBe('fixture-key');
    else expect(create).toThrow('changed');
  });
}

test('a timestamp-changing ancestor still refuses a native reparse point', () => {
  const { root } = fixture(), ancestor = dirname(root); let changed = false;
  const run: SecurityRunner = (_file, _args, opts) => {
    changed = true;
    return rows(opts).split('\n').map(line => {
      const row = JSON.parse(line); if (row.path === ancestor) row.attributes |= 0x400;
      return JSON.stringify(row);
    }).join('\n');
  };
  expect(() => new ParkFs(root, { ...options(run), stat: (path, options) => {
    const stat = lstatSync(path, options); if (changed && path === ancestor) {stat.mtimeNs += 1_000_000_000n;stat.mtimeMs += 1000n;} return stat;
  } })).toThrow('unsafe');
});

test('a full first security timeout leaves its retry and checked file read inside the original deadline', () => {
  const { root, key } = fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deadline = now + 30_000, budgets: number[] = [];
  const run: SecurityRunner = (_file, _args, opts) => {
    budgets.push(opts.timeout);
    if (budgets.length === 1) { now += opts.timeout; throw timeout(); }
    if (budgets.length === 2) now += 2500;
    return rows(opts);
  };
  const io = new ParkFs(root, options(run, deadline));
  expect(io.read(key, 64, true).toString()).toBe('fixture-key');
  expect(budgets.slice(0, 2)).toEqual([15_000, 15_000]);
  expect(io.deadline).toBe(deadline);
  now = deadline + 1; expect(() => io.checked(key)).toThrow('bound');
});

test('RED22 two full security timeouts exhausting the overall deadline refuse as bound', () => {
  const { root, key } = fixture(), before = readFileSync(key); let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deadline = now + 30_000, budgets: number[] = [];
  const run: SecurityRunner = (_file, _args, opts) => { budgets.push(opts.timeout); now += opts.timeout; throw timeout(); };
  let failure: unknown; try { new ParkFs(root, options(run, deadline)); } catch (error) { failure = error; }
  expect(parkReason(failure)).toBe('bound');
  expect(budgets).toEqual([15_000, 15_000]); expect(now).toBe(deadline);
  expect(readFileSync(key)).toEqual(before);
});

test('less than ten seconds remaining refuses as a security timeout without spawning', () => {
  const { root } = fixture(); const run = vi.fn<SecurityRunner>();
  expect(() => windowsSecurityPathsSync([root], Date.now() + 9999, run)).toThrow('security read timed out');
  expect(run).not.toHaveBeenCalled();
});

test('less than ten seconds remaining after a timeout refuses without starting a retry', () => {
  const { root } = fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deadline = now + 19_000, budgets: number[] = [];
  const run: SecurityRunner = (_file, _args, opts) => { budgets.push(opts.timeout); now += opts.timeout; throw timeout(); };
  expect(() => windowsSecurityPathsSync([root], deadline, run)).toThrow('security read timed out');
  expect(budgets).toEqual([10_000]); expect(now).toBe(deadline - 9000);
});

for (const overrun of [0, 1]) test(`RED22 a security read ending at deadline plus ${overrun} refuses as bound`, () => {
 const {root}=fixture();let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const deadline=now+30_000;
 const run:SecurityRunner=(_file,_args,opts)=>{const output=rows(opts);now=deadline+overrun;return output;};
 expect(()=>new ParkFs(root,options(run,deadline))).toThrow('bound');
});

test('RED22 protection timeout at the overall deadline retains bound through the write durability wrapper',()=>{
 const {root}=fixture();let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const deadline=now+30_000;
 const io=new ParkFs(root,{...options((_file,_args,opts)=>rows(opts),deadline),sync:()=> 'synced',protectNewWindowsEntry:()=>{
  now=deadline;throw new WindowsSecurityTimeoutError();
 }});
 let failure:unknown;try{io.write(join(root,'metadata.json'),{});}catch(error){failure=error;}
 expect(parkReason(failure)).toBe('bound');
});

test('the pinned installation ancestor identity still refuses between operations',()=>{
 const {root,key}=fixture();const run:SecurityRunner=(_file,_args,opts)=>rows(opts);
 const io=new ParkFs(root,options(run));io.checked(key);let injected=0;
 io.options.stat=(path,options)=>{const stat=lstatSync(path,options);if(path===root){const before=stat.ino;stat.ino+=1n;expect(stat.ino).toBe(before+1n);expect(stat.ino).not.toBe(before);injected++;}return stat;};
 expect(()=>io.checked(key)).toThrow('changed');expect(injected).toBeGreaterThan(0);
});
