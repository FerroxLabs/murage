// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { currentUserSid, nativeUserSidScope } from './win-acl.ts';
import { restrictArguments } from './sentinel/win-acl.ts';
import { PROTECT_SCRIPT, protectWindowsParkEntries } from './channels/signal/park-windows-protect.ts';
import { defaultSecurityRunner, defaultAsyncSecurityRunner, type SecurityRunner, type AsyncSecurityRunner } from './channels/signal/windows-security-runner.ts';

type DirectoryIdentity = Pick<fs.BigIntStats, 'dev' | 'ino'>;
interface PrivateDirectoryOptions {
  run?: SecurityRunner;
  runAsync?: AsyncSecurityRunner;
  sid?: () => string | null;
  /** App startup only: persist allocations on native ACL failure and retry asynchronously. */
  retryProtection?: boolean;
}
interface RetryState {
  pending: Map<string, DirectoryIdentity>;
  identity: DirectoryIdentity;
  attempts: number;
  warned: boolean;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
}
const retries = new Map<string, RetryState>();
const MARKER = '.murage-acl-pending.json';
const ATTEMPT_MS = 5_000;
const MAX_BACKOFF_MS = 3_600_000;

function assertSameDirectory(path: string, before: DirectoryIdentity): void {
  const after = fs.lstatSync(path, { bigint: true });
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Private directory changed');
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function assertChain(root: string, path: string): void {
  for (let dir = path; ; dir = dirname(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private directory refused');
    if (dir === root) return;
  }
}
function readPending(root: string): Map<string, DirectoryIdentity> {
  const pending = new Map<string, DirectoryIdentity>();
  try {
    const path = join(root, MARKER), stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('ACL marker refused');
    const marker = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (marker.version !== 1 || !Array.isArray(marker.directories) || marker.directories.length > 512) throw new Error('Invalid ACL marker');
    assertSameDirectory(root, {dev:BigInt(marker.root.dev), ino:BigInt(marker.root.ino)});
    for (const row of marker.directories) {
      if (typeof row.path !== 'string') throw new Error('Invalid ACL marker path');
      const path = resolve(root, row.path);
      if (!contained(root, path)) throw new Error('ACL marker path outside data directory');
      const before = {dev:BigInt(row.dev), ino:BigInt(row.ino)};
      try { assertChain(root, path); assertSameDirectory(path, before); pending.set(path, before); }
      catch { console.warn('[data-directory] Windows ACL pending directory changed; replacement left untouched'); }
    }
  } catch (error) {
    pending.clear();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[data-directory] Windows ACL pending marker could not be admitted; existing directories left untouched');
  }
  return pending;
}
function persist(root: string, state: RetryState): void {
  assertSameDirectory(root, state.identity);
  const path = join(root, MARKER);
  if (!state.pending.size) {
    try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return;
  }
  const directories = [...state.pending].filter(([path]) => contained(root, path)).map(([path, before]) => ({path:relative(root, path) || '.', dev:String(before.dev), ino:String(before.ino)}));
  const temp = join(root, `${MARKER}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({version:1, root:{dev:String(state.identity.dev), ino:String(state.identity.ino)}, directories}), {flag:'wx', mode:0o600});
    fs.renameSync(temp, path);
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed or unavailable */ } }
}
function retryLater(root: string, state: RetryState, options: PrivateDirectoryOptions): void {
  if (state.timer || !state.pending.size) return;
  const delay = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(6, state.attempts - 1));
  state.timer = setTimeout(() => { state.timer = undefined; void attempt(root, state, options); }, delay);
  state.timer.unref?.();
}
function attempt(root: string, state: RetryState, options: PrivateDirectoryOptions): Promise<void> {
  if (state.inFlight) return state.inFlight;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.inFlight = protectPending(root, state, options).catch(() => {
    console.warn('[data-directory] Windows ACL repair could not persist progress; pending work will retry');
  }).finally(() => { state.inFlight = undefined; retryLater(root, state, options); });
  return state.inFlight;
}
async function protectPending(root: string, state: RetryState, options: PrivateDirectoryOptions): Promise<void> {
  try { assertSameDirectory(root, state.identity); }
  catch { state.pending.clear(); retries.delete(root); console.warn('[data-directory] Windows ACL retry stopped because the data directory changed'); return; }
  for (const [path, before] of state.pending) {
    try { assertChain(contained(root, path) ? root : path, path); assertSameDirectory(path, before); }
    catch { state.pending.delete(path); console.warn('[data-directory] Windows ACL pending directory changed; replacement left untouched'); }
  }
  if (!state.pending.size) { persist(root, state); return; }
  const directories = [...state.pending];
  const deadline = Date.now() + ATTEMPT_MS;
  const runner = options.runAsync ?? (options.run ? async (...args: Parameters<SecurityRunner>) => options.run!(...args) : defaultAsyncSecurityRunner);
  const run: AsyncSecurityRunner = async (file, args, opts) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Windows ACL attempt timed out');
    const budget = Math.min(opts.timeout, remaining);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([runner(file, args, {...opts, timeout:budget}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Windows ACL attempt timed out')), budget);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  let sid: string | null = null;
  try {
    if (!win32.isAbsolute(systemRoot)) throw new Error('Invalid Windows root');
    sid = options.sid ? options.sid() : /"(S-1-[0-9-]+)"/.exec(await run(win32.join(systemRoot, 'System32', 'whoami.exe'), ['/user','/fo','csv','/nh'], {env:process.env, timeout:1_000}))?.[1] ?? null;
  } catch { /* SID reads are retried, never cached as failed. */ }
  let success = false;
  if (sid && /^S-1-(?:\d+-){1,14}\d+$/.test(sid)) {
    // Keep each environment value bounded; oversized batches use the per-path fallback.
    const entries = JSON.stringify(directories.map(([path]) => ({path, directory:true})));
    if (directories.length > 1 && entries.length < 30_000) {
      try {
        success = (await run(win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','-'], {
          input:PROTECT_SCRIPT, env:{...process.env,MURAGE_SIGNAL_NEW:entries,MURAGE_SIGNAL_SID:sid}, timeout:2_000,
        })).trim() === 'MURAGE_SIGNAL_PROTECTED';
      } catch { /* Restricted or hung PowerShell leaves time for icacls within the same deadline. */ }
    }
    for (const [path, before] of directories) {
      let protectedOne = success;
      if (!protectedOne) {
        try {
          assertSameDirectory(path, before);
          await run(win32.join(systemRoot,'System32','icacls.exe'), restrictArguments(path,sid,true), {env:process.env,timeout:ATTEMPT_MS});
          protectedOne = true;
        } catch { /* Keep this identity for the next attempt or next startup. */ }
      }
      assertSameDirectory(path, before);
      if (protectedOne) state.pending.delete(path);
    }
  }
  state.attempts++;
  persist(root, state);
  if (state.pending.size) {
    const log = state.warned ? console.info : console.warn;
    log(`[data-directory] Windows ACL hardening pending after attempt ${state.attempts}; retrying with capped backoff and on later starts`);
    state.warned = true;
  } else if (state.warned) console.info('[data-directory] Windows ACL hardening retry succeeded');
}

/** Strict allocation callers protect before returning. Startup persists the
 * newly allocated identities before starting bounded, asynchronous ACL repair.
 * Existing/imported directories without a pending marker remain untouched. */
export function createPrivateWindowsDirectories(paths: readonly string[], options: PrivateDirectoryOptions = {}): void | Promise<void> {
  const created = new Map<string, DirectoryIdentity>();
  const root = paths[0] && resolve(paths[0]);
  if (!root) return;
  try {
    for (const path of paths) {
      const chain: string[] = [];
      for (let dir = resolve(path); ; dir = dirname(dir)) { chain.unshift(dir); if (dirname(dir) === dir) break; }
      for (const dir of chain) {
        let stat: fs.BigIntStats;
        try { stat = fs.lstatSync(dir, {bigint:true}); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          fs.mkdirSync(dir, {mode:0o700}); stat = fs.lstatSync(dir, {bigint:true}); created.set(dir, stat);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Private directory refused');
      }
    }
    if (options.retryProtection) {
      let state = retries.get(root);
      if (state) assertSameDirectory(root, state.identity);
      else { state = {pending:readPending(root), identity:fs.lstatSync(root,{bigint:true}), attempts:0, warned:false}; retries.set(root,state); }
      for (const [path, before] of created) state.pending.set(path,before);
      if (!state.pending.size) return;
      persist(root,state); // crash/restart cannot forget an allocation
      return attempt(root,state,options);
    }
    if (!created.size) return;
    const run = options.run ?? defaultSecurityRunner;
    const sid = options.sid ? options.sid() : currentUserSid((file,args) => run(file,args,{env:process.env,timeout:15_000}),process.env,options.run ?? nativeUserSidScope);
    if (!sid || !protectWindowsParkEntries([...created.keys()].map(path => ({path,directory:true})),sid,Date.now()+120_000,run)) throw new Error('Private directory protection failed');
    for (const [path,before] of created) assertSameDirectory(path,before);
  } catch (error) {
    for (const [path,before] of [...created].reverse()) {
      try { assertSameDirectory(path,before); if (fs.readdirSync(path).length === 0) fs.rmdirSync(path); } catch { /* Preserve changed or populated directories. */ }
    }
    throw error;
  }
}
