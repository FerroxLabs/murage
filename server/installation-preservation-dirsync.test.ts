// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { preservePost118Data } from './installation-decision-downgrade.ts';
import { syncDirectory as syncDelegationsDirectory } from './pending-delegations-schema.ts';
import { noteRestoreStuck } from './home-events.ts';
import { writeRecordAtomic } from './email/restore-job.ts';
import { preservePhoneCallsForDowngrade, removeDataDirNamesAfter102 } from './installation-memory-downgrade.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const hostPlatform = process.platform;
let parent: string, root: string;
let synced: string[], openedDirectories: string[];
let failure: ((path: string, directory: boolean) => boolean) | undefined;
let barrierFailure: ((stage: 'open' | 'sync', path: string, directory: boolean) => Error | undefined) | undefined;
let directoryHandles: Set<number>;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'murage-preservation-sync-'));
  root = join(parent, 'data'); mkdirSync(root);
  mkdirSync(join(root, 'decision-queues', 'nested'), { recursive: true });
  mkdirSync(join(root, 'restore-archives'));
  writeFileSync(join(root, 'decision-queues', 'nested', 'payload'), 'queued bytes');
  writeFileSync(join(root, 'restore-archives', 'archive'), 'archive bytes');
  writeFileSync(join(root, 'phone-calls.db'), '');
  synced = []; openedDirectories = []; failure = undefined; barrierFailure = undefined;
  directoryHandles = new Set();
  const handles = new Map<number, string>();
  const syntheticDirectories = new Set<number>();
  let nextDirectory = -1;
  fs.openSync = ((path, ...args) => {
    const name = String(path);
    if (fs.existsSync(name) && fs.statSync(name).isDirectory()) {
      openedDirectories.push(name);
      const error = barrierFailure?.('open', name, true); if (error) throw error;
      if (process.platform === 'win32') throw Object.assign(new Error('Windows directory open refused'), { code: 'EPERM' });
      // Native Windows cannot supply the POSIX primitive; keep those controls portable.
      if (hostPlatform === 'win32') { const fd = nextDirectory--; syntheticDirectories.add(fd); directoryHandles.add(fd); handles.set(fd, name); return fd; }
    }
    const fd = real.openSync(path, ...args); handles.set(fd, name);
    if (fs.fstatSync(fd).isDirectory()) directoryHandles.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = fd => {
    const path = handles.get(fd)!;
    const error = barrierFailure?.('sync', path, directoryHandles.has(fd)); if (error) throw error;
    if (failure?.(path, syntheticDirectories.has(fd) || fs.fstatSync(fd).isDirectory())) throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' });
    if (!syntheticDirectories.has(fd)) real.fsyncSync(fd);
    synced.push(path);
  };
  fs.closeSync = fd => { directoryHandles.delete(fd); handles.delete(fd); if (!syntheticDirectories.delete(fd)) real.closeSync(fd); };
  syncBuiltinESMExports();
});
afterEach(() => {
  Object.assign(fs, real); syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platform);
  removeTempDirSync(parent);
  expect(directoryHandles.size, 'every opened directory handle was closed').toBe(0);
});
function originals() {
  expect(readFileSync(join(root, 'decision-queues', 'nested', 'payload'), 'utf8')).toBe('queued bytes');
  expect(readFileSync(join(root, 'restore-archives', 'archive'), 'utf8')).toBe('archive bytes');
  expect(readFileSync(join(root, 'phone-calls.db'))).toEqual(Buffer.alloc(0));
}
for (const os of ['win32', 'linux'] as const) {
  it(`preserves empty queue and archive directories with no pending payloads on ${os}`, () => {
    fs.unlinkSync(join(root, 'decision-queues', 'nested', 'payload'));
    fs.unlinkSync(join(root, 'restore-archives', 'archive'));
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    const destination = preservePost118Data(root)!;
    for (const directory of ['decision-queues/nested', 'restore-archives']) {
      expect(readdirSync(join(destination, directory))).toEqual([]);
      expect(readdirSync(join(root, directory))).toEqual([]);
    }
    expect(synced).toEqual(os === 'win32' ? [] : [
      join(destination, 'decision-queues', 'nested'), join(destination, 'decision-queues'),
      join(destination, 'restore-archives'), destination, parent,
    ]);
    if (os === 'win32') expect(openedDirectories).toEqual([]);
  });
  it(`delegation downgrade and restore marker use platform-aware directory barriers on ${os}`, () => {
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    syncDelegationsDirectory(root);
    const marker = join(root, 'restore-stuck-at');
    noteRestoreStuck(undefined, marker, true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ at: expect.any(Number), nonce: expect.any(String) });
    expect(openedDirectories).toEqual(os === 'win32' ? [] : [root, root]);
    if (os === 'linux') expect(synced.filter(path => path === root)).toEqual([root, root]);
  });
  it(`async restore record skips unsupported Windows directory opens on ${os}`, async () => {
    // The counted adapter retains a copy of the builtin at module initialization.
    const promises = (globalThis as unknown as Record<symbol, typeof import('node:fs/promises')>)[Symbol.for('murage.io.raw-fs-promises')];
    const open = promises.open;
    const directories: string[] = [], barriers: string[] = [];
    promises.open = (async (path, ...args) => {
      const name = String(path);
      if (fs.statSync(name, { throwIfNoEntry: false })?.isDirectory()) {
        directories.push(name);
        if (os === 'win32') throw Object.assign(Error('Windows directory open refused'), { code: 'EPERM' });
        if (hostPlatform === 'win32') return { sync: async () => { barriers.push(name); }, close: async () => {} } as Awaited<ReturnType<typeof open>>;
      }
      const handle = await open(path, ...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); barriers.push(name); };
      return handle;
    }) as typeof promises.open;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    try {
      const record = join(root, 'restore-wait.json');
      await writeRecordAtomic(record, '{"waited":1}');
      expect(readFileSync(record, 'utf8')).toBe('{"waited":1}');
      expect(directories).toEqual(os === 'win32' ? [] : [root]);
      expect(barriers.length).toBe(os === 'win32' ? 1 : 2);
    } finally { promises.open = open; syncBuiltinESMExports(); }
  });
  it(`preserves nested application data on ${os}, syncing every file and POSIX directory`, () => {
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    const destination = preservePost118Data(root)!;
    originals();
    expect(readFileSync(join(destination, 'decision-queues', 'nested', 'payload'), 'utf8')).toBe('queued bytes');
    expect(readFileSync(join(destination, 'restore-archives', 'archive'), 'utf8')).toBe('archive bytes');
    expect(synced).toEqual([
      join(destination, 'decision-queues', 'nested', 'payload'),
      ...(os === 'linux' ? [join(destination, 'decision-queues', 'nested'), join(destination, 'decision-queues')] : []),
      join(destination, 'restore-archives', 'archive'),
      ...(os === 'linux' ? [join(destination, 'restore-archives'), destination, parent] : []),
    ]);
    if (os === 'win32') expect(openedDirectories).toEqual([]);
  });
  it(`preserves phone history on ${os}, syncing the file and both POSIX directories`, () => {
    Object.defineProperty(process, 'platform', { ...platform, value: os });
    const destination = preservePhoneCallsForDowngrade(root)!;
    originals();
    expect(readFileSync(join(destination, 'phone-calls.db'))).toEqual(Buffer.alloc(0));
    expect(synced).toEqual([join(destination, 'phone-calls.db'), ...(os === 'linux' ? [destination, parent] : [])]);
    if (os === 'win32') expect(openedDirectories).toEqual([]);
  });
}
it.each(['phone-file', 'application-file', 'nested-directory', 'application-directory', 'parent-directory'])('failed %s sync keeps all newer source data and a retry preserves before removing', point => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  failure = (path, directory) => point === 'phone-file' ? path.endsWith('phone-calls.db')
    : point === 'application-file' ? path.endsWith('payload')
    : point === 'nested-directory' ? directory && path.endsWith('nested')
    : point === 'application-directory' ? directory && path.includes('.murage-application-data-preserved-')
    : path === parent;
  expect(() => removeDataDirNamesAfter102(root)).toThrow('fixture sync failure');
  originals();
  failure = undefined;
  removeDataDirNamesAfter102(root);
  expect(readdirSync(root)).toEqual([]);
  const copies = readdirSync(parent).filter(name => name.startsWith('.murage-application-data-preserved-'));
  expect(copies.some(name => fs.existsSync(join(parent, name, 'restore-archives', 'archive')))).toBe(true);
});

// These codes are tolerated by ordinary atomic writes, but preservation must not
// remove the only durable source when a POSIX directory barrier was refused.
const unsupportedBarriers = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].flatMap(code =>
  (['open', 'sync'] as const).flatMap(stage =>
    (['application-nested', 'application-destination', 'application-parent', 'phone-destination', 'phone-parent'] as const)
      .map(point => ({ code, stage, point }))));
it.each(unsupportedBarriers)('POSIX $code at $point $stage retains originals and permits a safe restart', ({ code, stage, point }) => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const calls = new DatabaseSync(join(root, 'phone-calls.db'));
  try { calls.exec("CREATE TABLE phone_calls (status TEXT); INSERT INTO phone_calls VALUES ('ended')"); }
  finally { calls.close(); }
  const phoneBytes = readFileSync(join(root, 'phone-calls.db'));
  const refused = Object.assign(new Error('fixture unsupported directory barrier'), { code });
  let attempts = 0;
  barrierFailure = (operation, path, directory) => {
    const application = basename(path).startsWith('.murage-application-data-preserved-');
    const phone = basename(path).startsWith('.murage-phone-calls-preserved-');
    const target = point === 'application-nested' ? path.endsWith(join('decision-queues', 'nested'))
      : point === 'application-destination' ? application
      : point === 'phone-destination' ? phone
      : path === parent && (point === 'phone-parent' || synced.some(name => name.endsWith(join('restore-archives', 'archive'))));
    if (directory && operation === stage && target) { attempts++; return refused; }
  };
  // For --to 12 this is the removal boundary: preservation must finish first.
  expect(() => removeDataDirNamesAfter102(root)).toThrow(refused);
  expect(attempts).toBe(1);
  expect(readFileSync(join(root, 'decision-queues', 'nested', 'payload'), 'utf8')).toBe('queued bytes');
  expect(readFileSync(join(root, 'restore-archives', 'archive'), 'utf8')).toBe('archive bytes');
  expect(readFileSync(join(root, 'phone-calls.db'))).toEqual(phoneBytes);
  expect(directoryHandles.size).toBe(0);
  barrierFailure = undefined;
  removeDataDirNamesAfter102(root);
  expect(readdirSync(root)).toEqual([]);
  const copies = readdirSync(parent);
  expect(copies.some(name => name.startsWith('.murage-phone-calls-preserved-') &&
    readFileSync(join(parent, name, 'phone-calls.db')).equals(phoneBytes))).toBe(true);
  expect(copies.some(name => name.startsWith('.murage-application-data-preserved-') &&
    fs.existsSync(join(parent, name, 'restore-archives', 'archive')) &&
    readFileSync(join(parent, name, 'decision-queues', 'nested', 'payload'), 'utf8') === 'queued bytes' &&
    readFileSync(join(parent, name, 'restore-archives', 'archive'), 'utf8') === 'archive bytes')).toBe(true);
});

it.each(['SIGKILL', 'SIGTERM'] as const)('%s during preservation keeps newer data; a restarted command preserves before removing', signal => {
  const moduleUrl = new URL('./installation-memory-downgrade.ts', import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { removeDataDirNamesAfter102 } from ${JSON.stringify(moduleUrl)};
    const open = fs.openSync, sync = fs.fsyncSync, paths = new Map();
    fs.openSync = (path, ...args) => { const fd = open(path, ...args); paths.set(fd, String(path)); return fd; };
    fs.fsyncSync = fd => { sync(fd); if (paths.get(fd)?.endsWith('payload')) { fs.writeSync(1, 'INTERRUPTED_AT_PRESERVATION'); process.kill(process.pid, ${JSON.stringify(signal)}); } };
    syncBuiltinESMExports();
    removeDataDirNamesAfter102(process.argv[1]);
  `, root], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  expect(interrupted.error).toBeUndefined();
  expect(interrupted.stdout).toBe('INTERRUPTED_AT_PRESERVATION');
  if (hostPlatform === 'win32') expect(interrupted.status).not.toBe(0);
  else expect(interrupted.signal, interrupted.stderr).toBe(signal);
  originals();
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { removeDataDirNamesAfter102 } from ${JSON.stringify(moduleUrl)};
    removeDataDirNamesAfter102(process.argv[1]);
  `, root], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(readdirSync(root)).toEqual([]);
  const completed = readdirSync(parent).filter(name => name.startsWith('.murage-application-data-preserved-'))
    .filter(name => fs.existsSync(join(parent, name, 'restore-archives', 'archive')));
  expect(completed).toHaveLength(1);
  expect(readFileSync(join(parent, completed[0], 'decision-queues', 'nested', 'payload'), 'utf8')).toBe('queued bytes');
  expect(readFileSync(join(parent, completed[0], 'restore-archives', 'archive'), 'utf8')).toBe('archive bytes');
});
