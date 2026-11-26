// W-T10, W-T14, W-T15: durable publication, the seed barrier and isolated homes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as atomic from './atomic.ts';
import { LoginLinkUnavailableError, nodeLinkIo } from './drivers/shared-login-link.ts';
import { loadExclusionAddon } from './engine-exclusion.ts';
import { FolderTrustStore } from './folder-trust.ts';
import { isolatedFuigoConfigurationHome, sweepIsolatedFuigoHomes, writeFuigoSeed, writeFuigoSeedDurable } from './folder-trust-seed.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'trust-transaction-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });
const SEED = '[folders."/fixture/workspace"]\ntrusted = false\nconsent = 2\n';

describe('failed-forget-keeps-live-decision', () => {
  it.each(['exact', 'folder'] as const)('%s: a failed Forget retains the saved answer in memory, in the index and on disk', mode => {
    const root = fixture(), file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    mkdirSync(folder);
    const store = new FolderTrustStore(file);
    store.remember(folder, 'reject', 'card', { key: folder, consent: 2 });
    const bytes = readFileSync(file, 'utf8'), revision = store.index().revision;
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(() => { throw new Error('fixture write failure'); });
    expect(() => mode === 'exact' ? store.forgetKey(folder) : store.forget(folder)).toThrow('fixture write failure');
    expect(store.decision(folder), 'old authority must remain published').toBe('reject');
    expect(store.index().lookup(folder).decision).toBe('reject');
    expect(store.index().revision, 'no new revision before a durable write').toBe(revision);
    expect(store.turnRecords().rejects.map(r => r.key)).toEqual([folder]);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(new FolderTrustStore(file).decision(folder)).toBe('reject');
  });

  it('a failed remember does not publish a new answer either', () => {
    const root = fixture(), file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    mkdirSync(folder);
    const store = new FolderTrustStore(file);
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(() => { throw new Error('fixture write failure'); });
    expect(() => store.remember(folder, 'trust', 'card', { consent: 2 })).toThrow('fixture write failure');
    expect(store.decision(folder)).toBeUndefined();
    expect(store.index().lookup(folder).decision).toBe('none');
  });

  /** A crash is a process that stops at the cut; what a restart reads must be one complete state. */
  it.each([
    ['before the write', 'open'], ['after the flush, before the rename', 'fsync'],
  ] as const)('crash cut %s: a restart reads the old complete state', (_name, cut) => {
    const root = fixture(), file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    mkdirSync(folder);
    const store = new FolderTrustStore(file);
    store.remember(folder, 'reject', 'card', { key: folder, consent: 2 });
    const before = readFileSync(file, 'utf8');
    const real = atomic.writeFileAtomic;
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((path, data, options = {}) => real(path, data, { ...options, ops: { [cut]: () => { throw new Error('crash cut'); } } }));
    expect(() => store.forgetKey(folder)).toThrow('crash cut');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(root).filter(name => name.endsWith('.tmp')), 'no half-written temporary is left to be read').toEqual([]);
    expect(new FolderTrustStore(file).decision(folder)).toBe('reject');
  });

  it.each([
    ['after the rename', 'rename'], ['after the write returns, before publish', 'publish'],
  ] as const)('crash cut %s: the restart reads the new complete state', (_name, cut) => {
    const root = fixture(), file = join(root, 'folder-trust.json'), folder = join(root, 'workspace');
    mkdirSync(folder);
    const store = new FolderTrustStore(file);
    store.remember(folder, 'reject', 'card', { key: folder, consent: 2 });
    const revision = store.index().revision;
    const real = atomic.writeFileAtomic;
    // the file lands, then the process stops at the cut before it can publish anything in memory
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((path, data, options = {}) => {
      if (cut === 'rename') return real(path, data, { ...options, renameHandlesRetry: true, rename: (from, to) => { renameSync(from, to); throw new Error('crash cut'); } });
      real(path, data, options);
      throw new Error('crash cut');
    });
    expect(() => store.forgetKey(folder)).toThrow('crash cut');
    expect(store.decision(folder), 'the stopped process never published the new state').toBe('reject');
    expect(store.index().revision).toBe(revision);
    expect(readFileSync(file, 'utf8')).not.toContain(folder);
    expect(readdirSync(root).filter(name => name.endsWith('.tmp')), 'no half-written temporary is left to be read').toEqual([]);
    expect(new FolderTrustStore(file).decision(folder)).toBeUndefined();
  });
});

describe('seed barrier', () => {
  it('a seed without a barrier is never reported as durable: uncertain, not synced', () => {
    const root = fixture();
    const noBarrier = { platform: 'win32' as const, renameDurable: null };
    expect(writeFuigoSeedDurable(root, SEED, noBarrier)).toBe('uncertain');
    mkdirSync(join(root, 'second'));
    expect(writeFuigoSeed(join(root, 'second'), SEED, noBarrier)).toBe(false);
    expect(existsSync(join(root, 'trusted_folders.toml'))).toBe(true);
  });

  it('win32 without the native move renames and flushes the reopened file and reports uncertain', () => {
    const root = fixture();
    writeFileSync(join(root, 'a.tmp'), 'x');
    expect(atomic.renameAndSyncParent(join(root, 'a.tmp'), join(root, 'a'), { platform: 'win32', renameDurable: null })).toBe('uncertain');
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('x');
  });

  it('win32 with the native move reports synced only through that call', () => {
    const root = fixture();
    writeFileSync(join(root, 'a.tmp'), 'x');
    const native = vi.fn((from: string, to: string) => { atomic.renameAndSyncParent(from, to, { platform: 'linux' }); return 0; });
    expect(atomic.renameAndSyncParent(join(root, 'a.tmp'), join(root, 'a'), { platform: 'win32', renameDurable: native })).toBe('synced');
    expect(native).toHaveBeenCalledOnce();
  });

  it('a failed publish leaves no file and reports failed', () => {
    const root = fixture();
    expect(writeFuigoSeedDurable(join(root, 'missing'), SEED)).toBe('failed');
  });

  it.runIf(process.platform !== 'win32')('the Windows-only move is absent off Windows', () => {
    expect(loadExclusionAddon()?.renameDurable).toBeUndefined();
  });

  // W-T14: real win32 code path on a Windows runner, no platform mock. The packaged addon always ships the export.
  it.runIf(process.platform === 'win32')('seed-barrier-durable-on-windows', () => {
    const addon = loadExclusionAddon();
    expect(typeof addon?.renameDurable, 'the packaged addon exports renameDurable').toBe('function');
    const nativeMove = vi.spyOn(addon!, 'renameDurable');
    const root = fixture();
    expect(writeFuigoSeedDurable(root, SEED)).toBe('synced');
    expect(readFileSync(join(root, 'trusted_folders.toml'), 'utf8')).toBe(SEED);
    expect(nativeMove).toHaveBeenCalledTimes(1);
    writeFileSync(join(root, 'old'), 'old'); writeFileSync(join(root, 'new'), 'new');
    expect(atomic.renameAndSyncParent(join(root, 'new'), join(root, 'old'))).toBe('synced');
    expect(nativeMove).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'old'), 'utf8')).toBe('new');
  });
});

describe('isolated-home-swept-after-crash', () => {
  it('lives under the data directory, owner-only, carries only sign-in and is deleted on release', () => {
    const data = fixture(), source = fixture();
    writeFileSync(join(source, 'auth.json'), '{"fixture":"sign-in"}');
    writeFileSync(join(source, 'trusted_folders.toml'), '[folders."/fixture/workspace"]\ntrusted = true\n');
    const { home, release } = isolatedFuigoConfigurationHome({ sourceHome: source }, data);
    expect(home.startsWith(join(data, 'run', 'fuigo-turn-homes'))).toBe(true);
    expect(home.startsWith(tmpdir()) && !home.startsWith(data)).toBe(false);
    expect(readdirSync(home).sort()).toEqual(['auth.json', 'auth.json.lock']);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"fixture":"sign-in"}');
    if (process.platform !== 'win32') expect((statSync(home).mode & 0o777)).toBe(0o700);
    release(); release();
    expect(existsSync(home)).toBe(false);
  });

  it('shares an atomic sign-in refresh and its lock across isolated turns and release', () => {
    const data = fixture(), source = fixture();
    const ownerAuth = join(source, 'auth.json');
    const ownerLock = join(source, 'auth.json.lock');
    writeFileSync(ownerAuth, 'original sign-in');
    writeFileSync(ownerLock, '');
    const first = isolatedFuigoConfigurationHome({ sourceHome: source }, data);
    const second = isolatedFuigoConfigurationHome({ sourceHome: source }, data);
    // Fuigo resolves the link and renames the refreshed file onto its target.
    const target = realpathSync(join(first.home, 'auth.json'));
    writeFileSync(`${target}.tmp`, 'refreshed sign-in');
    renameSync(`${target}.tmp`, target);
    first.release();
    expect(existsSync(first.home)).toBe(false);
    expect(readFileSync(ownerAuth, 'utf8')).toBe('refreshed sign-in');
    expect(readFileSync(join(second.home, 'auth.json'), 'utf8')).toBe('refreshed sign-in');
    expect(realpathSync(join(second.home, 'auth.json.lock'))).toBe(realpathSync(ownerLock));
    second.release();
    expect(existsSync(ownerLock)).toBe(true);
  });

  it('a home without sign-in is empty', () => {
    const data = fixture();
    const { home, release } = isolatedFuigoConfigurationHome({ sourceHome: null }, data);
    expect(readdirSync(home)).toEqual([]); release();
  });

  it.each(['auth.json', 'auth.json.lock'])('removes an incomplete home when the existing sign-in cannot be linked (%s)', (unavailable) => {
    const data = fixture(), source = fixture();
    const ownerAuth = join(source, 'auth.json');
    writeFileSync(ownerAuth, 'original sign-in');
    const symlink = nodeLinkIo.symlinkSync;
    vi.spyOn(nodeLinkIo, 'symlinkSync').mockImplementation((target, path) => {
      if (basename(path) === unavailable) {
        throw Object.assign(new Error('fixture denies this link'), { code: 'EPERM' });
      }
      symlink(target, path);
    });
    expect(() => isolatedFuigoConfigurationHome({ sourceHome: source }, data)).toThrow(LoginLinkUnavailableError);
    expect(readdirSync(join(data, 'run', 'fuigo-turn-homes'))).toEqual([]);
    expect(readFileSync(ownerAuth, 'utf8')).toBe('original sign-in');
  });

  it('boot sweep removes every home an earlier epoch left behind, and keeps this epoch', () => {
    const data = fixture(), dir = join(data, 'run', 'fuigo-turn-homes');
    mkdirSync(join(dir, 'aaaaaaaaaaaa-1'), { recursive: true }); writeFileSync(join(dir, 'aaaaaaaaaaaa-1', 'auth.json'), 'left behind by a crash');
    mkdirSync(join(dir, 'bbbbbbbbbbbb-7'), { recursive: true });
    const live = isolatedFuigoConfigurationHome({ sourceHome: null }, data);
    expect(sweepIsolatedFuigoHomes(data)).toBe(2);
    expect(readdirSync(dir)).toEqual([live.home.slice(dir.length + 1)]);
    live.release();
  });

  it('the first home of a process sweeps the earlier epochs before it is created', async () => {
    vi.resetModules();
    const fresh = await import('./folder-trust-seed.ts');
    const data = fixture(), dir = join(data, 'run', 'fuigo-turn-homes');
    mkdirSync(join(dir, 'cccccccccccc-3'), { recursive: true });
    const live = fresh.isolatedFuigoConfigurationHome({ sourceHome: null }, data);
    expect(readdirSync(dir)).toEqual([live.home.slice(dir.length + 1)]);
    live.release();
  });
});
