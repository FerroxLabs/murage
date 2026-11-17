// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from './testing/cleanup.ts';
const roots: string[] = [];
const sid = 'S-1-5-21-1-2-3-1001';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() { const root = fs.mkdtempSync(join(tmpdir(), 'acl-retry-')); roots.push(root); return join(root, 'data'); }

test('M2 failed ACL work survives a process restart, logs and clears only after success', async () => {
  const root = fixture(), paths = [root, join(root, 'events'), join(root, 'native')];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const first = await import('./windows-private-directory.ts');
  await first.createPrivateWindowsDirectories(paths, { run: () => { throw Error('restricted'); }, sid: () => sid, retryProtection: true });
  const marker = join(root, '.murage-acl-pending.json');
  expect(fs.existsSync(marker)).toBe(true);
  fs.writeFileSync(join(root, 'events', 'history'), 'RETAIN');
  vi.resetModules(); // no in-memory pending set in this new process
  const second = await import('./windows-private-directory.ts');
  let calls = 0;
  await second.createPrivateWindowsDirectories(paths, { run: () => { calls++; return 'MURAGE_SIGNAL_PROTECTED'; }, sid: () => sid, retryProtection: true });
  expect(calls).toBeGreaterThan(0);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.readFileSync(join(root, 'events', 'history'), 'utf8')).toBe('RETAIN');
  expect(warn).toHaveBeenCalled();
});

test('M3 startup and retry await native work without calling a synchronous runner', async () => {
  vi.useFakeTimers();
  const { createPrivateWindowsDirectories } = await import('./windows-private-directory.ts');
  const root = fixture(); let finish!: (value: string) => void;
  const run = vi.fn(() => { throw Error('sync child must never run'); });
  const runAsync = vi.fn((_file: string, _args: readonly string[], _opts: {timeout:number}) => new Promise<string>(resolve => { finish = resolve; }));
  const startup = createPrivateWindowsDirectories([root], { run, runAsync, sid: () => sid, retryProtection: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(run).not.toHaveBeenCalled();
  expect(runAsync).toHaveBeenCalledTimes(1);
  expect(runAsync.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(5_000);
  finish(''); await startup;
  const calls = runAsync.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(runAsync).toHaveBeenCalledTimes(calls); // successful ACL is never repeated
});

test('M3 retry timeouts use capped backoff and do not overlap a hung native attempt', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { createPrivateWindowsDirectories } = await import('./windows-private-directory.ts');
  const root = fixture(); const starts: number[] = [];
  const runAsync = vi.fn(() => { starts.push(Date.now()); return new Promise<string>(() => {}); });
  createPrivateWindowsDirectories([root], { run: () => { throw Error('sync'); }, runAsync, sid: () => sid, retryProtection: true });
  await vi.advanceTimersByTimeAsync(25_000_000);
  expect(starts.length).toBeGreaterThan(6);
  const gaps = starts.slice(1).map((at, i) => at - starts[i]!);
  expect(gaps[1]).toBeGreaterThan(gaps[0]!);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(3_605_000);
  expect(gaps.at(-1)).toBe(gaps.at(-2));
});


test('M2 restart retries never harden a replacement child', async () => {
  const root = fixture(), events = join(root, 'events');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const first = await import('./windows-private-directory.ts');
  await first.createPrivateWindowsDirectories([root,events], {run:() => {throw Error('restricted');}, sid:() => sid, retryProtection:true});
  fs.renameSync(events, join(root, 'original-events')); fs.mkdirSync(events);
  fs.writeFileSync(join(events,'foreign'), 'PRESERVE');
  vi.resetModules();
  const second = await import('./windows-private-directory.ts');
  const protectedPaths: string[] = [];
  await second.createPrivateWindowsDirectories([root,events], {sid:() => sid, retryProtection:true, run:(_file,args) => {protectedPaths.push(args[0]!); return '';}});
  expect(protectedPaths).toEqual([root]);
  expect(fs.readFileSync(join(events,'foreign'),'utf8')).toBe('PRESERVE');
});


test('M3 a hung PowerShell leaves time for asynchronous icacls fallback', async () => {
  vi.useFakeTimers();
  const { createPrivateWindowsDirectories } = await import('./windows-private-directory.ts');
  const root = fixture(), events = join(root,'events');
  const protectedPaths: string[] = [];
  const startup = createPrivateWindowsDirectories([root,events], {sid:() => sid, retryProtection:true,
    run:() => {throw Error('sync');}, runAsync:async (file,args) => {
      if (file.endsWith('powershell.exe')) return new Promise<string>(() => {});
      expect(file).toMatch(/icacls.exe$/); protectedPaths.push(args[0]!); return '';
    },
  });
  await vi.advanceTimersByTimeAsync(2_000); await startup;
  expect(protectedPaths).toEqual([root,events]);
  expect(fs.existsSync(join(root,'.murage-acl-pending.json'))).toBe(false);
});
