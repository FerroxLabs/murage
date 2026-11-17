import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGoogleLinuxPath, authenticateDeb, authenticateRpm, compareLinuxFiles, GOOGLE_LINUX_FINGERPRINT } from './browser-window-linux.ts';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chrome-linux-')); });
afterEach(() => removeTempDirSync(root));
const goodInspect = (path: string) => ({ realpath: path, uid: 0, mode: path === '/opt/google/chrome/chrome' ? 0o100755 : 0o40755 });
it('requires the canonical stable path and root-owned, nonwritable parents', () => {
  expect(() => assertGoogleLinuxPath('/opt/google/chrome/chrome', goodInspect)).not.toThrow();
  for (const path of ['/snap/chromium/chrome', '/opt/google/chrome-beta/chrome', '/usr/bin/google-chrome', '/tmp/google-chrome']) expect(() => assertGoogleLinuxPath(path, goodInspect)).toThrow();
  for (const override of [{ realpath: '/tmp/chrome' }, { uid: 1000 }, { mode: 0o40775 }]) expect(() => assertGoogleLinuxPath('/opt/google/chrome/chrome', p => ({ ...goodInspect(p), ...(p === '/opt' ? override : {}) }))).toThrow();
});
function chain() {
  const version = '157.0.8103.38-1', deb = Buffer.from('signed package bytes');
  const files = ['chrome', 'chrome-sandbox', 'chrome_crashpad_handler', 'lib.so'].map(path => ({ path: `opt/google/chrome/${path}`, sha256: hash(path), mode: 0o755 }));
  const packages = Buffer.from(`Package: google-chrome-stable\nVersion: ${version}\nArchitecture: amd64\nFilename: pool/main/g/google-chrome-stable/chrome.deb\nSize: ${deb.length}\nSHA256: ${hash(deb)}\n\n`);
  const release = Buffer.from(`Origin: Google LLC\nSHA256:\n ${hash(packages)} ${packages.length} main/binary-amd64/Packages\n`);
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === '/usr/bin/gpg') return { stdout: `pub:-:4096:1:7721F63BD38B4796:0:0::::::\nfpr:::::::::${GOOGLE_LINUX_FINGERPRINT}:\n`, stderr: '' };
    if (cmd === '/usr/bin/gpgv') return { stdout: release.toString('utf8'), stderr: `[GNUPG:] VALIDSIG ${GOOGLE_LINUX_FINGERPRINT} 0 0 0 0 0 0 0 0 ${GOOGLE_LINUX_FINGERPRINT}` };
    if (cmd === '/usr/bin/rpmkeys') return { stdout: 'package.rpm: digests signatures OK', stderr: '' };
    if (cmd === '/usr/bin/rpm' && args.includes('--dump')) return { stdout: files.map(f => `/${f.path} 5 0 ${f.sha256} 0100755 root root 0 0 0 X`).join('\n'), stderr: '' };
    if (cmd === '/usr/bin/rpm' && args.includes('--qf')) return { stdout: `google-chrome-stable\n${version}\n8\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const fetch = vi.fn(async (url: string) => url.endsWith('/InRelease') ? release : url.endsWith('/Packages') ? packages : deb);
  const unpackDeb = vi.fn(async () => files);
  const options = { packageVersion: version, architecture: 'amd64', workDir: root, keyring: join(root, 'google.gpg'), run, fetch, unpackDeb };
  writeFileSync(options.keyring, 'fixture keyring');
  return { options, run, fetch, files, unpackDeb };
}
describe('authenticated repository provenance, never local package claims', () => {
  it('authenticates the complete deb chain and full key fingerprint', async () => {
    const f = chain(); expect(await authenticateDeb(f.options)).toEqual(f.files);
    expect(f.run.mock.calls.some(([c, a]) => c === '/usr/bin/gpgv' && a.includes(f.options.keyring))).toBe(true);
    expect(f.fetch.mock.calls.every(([u]) => u.startsWith('https://dl.google.com/linux/chrome/deb/'))).toBe(true);
  });
  it.each(['signature', 'key', 'packages', 'deb', 'absent', 'beta'] as const)('refuses %s evidence', async fault => {
    const f = chain();
    if (fault === 'signature') f.run.mockImplementation(async c => { if (c === '/usr/bin/gpgv') throw new Error('bad sig'); return { stdout: `pub:-:4096:1:key:0:0::::::\nfpr:::::::::${GOOGLE_LINUX_FINGERPRINT}:\n`, stderr: '' }; });
    if (fault === 'key') f.run.mockResolvedValue({ stdout: 'pub:-:4096:1:key:0:0::::::\nfpr:::::::::DEADBEEF:', stderr: '' });
    if (fault === 'packages' || fault === 'deb') { const original = f.fetch.getMockImplementation()!; f.fetch.mockImplementation(async url => url.endsWith(fault === 'packages' ? '/Packages' : '.deb') ? Buffer.from('tampered') : original(url)); }
    if (fault === 'absent') f.options.packageVersion = '156.0.0.1-1';
    if (fault === 'beta') f.options.packageVersion = 'bad\nPackage: google-chrome-beta';
    await expect(authenticateDeb(f.options)).rejects.toThrow();
  });
  it('RPM uses a private keyring and verifies before reading digests (M16)', async () => {
    const f = chain(); const result = await authenticateRpm({ ...f.options, rpmUrl: 'https://dl.google.com/linux/chrome/rpm/stable/x86_64/google-chrome-stable-157.0.8103.38-1.x86_64.rpm' });
    expect(result).toEqual(f.files);
    const verifyIndex = f.run.mock.calls.findIndex(([c]) => c === '/usr/bin/rpmkeys');
    const dumpIndex = f.run.mock.calls.findIndex(([, a]) => a.includes('--dump'));
    expect(verifyIndex).toBeGreaterThan(-1); expect(dumpIndex).toBeGreaterThan(verifyIndex);
    const args = f.run.mock.calls[verifyIndex][1]; expect(args).toContain('--dbpath'); expect(args[args.indexOf('--dbpath') + 1]).toMatch(/^.*rpm-keyring/);
  });
  it.each(['unsigned', 'other-key', 'header'] as const)('refuses RPM %s', async fault => {
    const f = chain(), original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (c, a) => {
      if (fault === 'unsigned' && c === '/usr/bin/rpmkeys') return { stdout: 'digests OK', stderr: '' };
      if (fault === 'other-key' && c === '/usr/bin/rpmkeys') throw new Error('NOKEY');
      if (fault === 'header' && a.includes('--dump')) return { stdout: '/opt/google/chrome/chrome 2 0 bad 0100755 root root 0 0 0 X', stderr: '' };
      return original(c, a);
    });
    await expect(authenticateRpm({ ...f.options, rpmUrl: 'https://dl.google.com/linux/chrome/rpm/stable/x86_64/chrome.rpm' })).rejects.toThrow();
  });
});
function installed() {
  const f = chain(); mkdirSync(join(root, 'installed'));
  for (const file of f.files) { const name = file.path.split('/').at(-1)!; writeFileSync(join(root, 'installed', name), name); chmodSync(join(root, 'installed', name), file.mode); }
  return { ...f, installedRoot: join(root, 'installed') };
}
it.each(['empty', 'wrong-root', 'incomplete', 'extra', 'bytes', 'mode'] as const)('refuses %s installed manifest', async fault => {
  const f = installed(); expect((await compareLinuxFiles(f.installedRoot, f.files)).filter(e => e.type === 'file')).toHaveLength(4);
  let table = f.files;
  if (fault === 'empty') table = [];
  if (fault === 'wrong-root') table = f.files.map(e => ({ ...e, path: e.path.replace('opt/google', 'usr/local') }));
  if (fault === 'incomplete') table = f.files.slice(1);
  if (fault === 'extra') writeFileSync(join(f.installedRoot, 'extra.so'), 'extra');
  if (fault === 'bytes') writeFileSync(join(f.installedRoot, 'chrome'), 'substitution');
  if (fault === 'mode') chmodSync(join(f.installedRoot, 'chrome-sandbox'), 0o777);
  await expect(compareLinuxFiles(f.installedRoot, table)).rejects.toThrow();
});
it('local launch hashes chrome and chrome-sandbox again and checks every other identity', async () => {
  const f = installed(); const prior = await compareLinuxFiles(f.installedRoot, f.files);
  expect(await compareLinuxFiles(f.installedRoot, f.files, prior)).toEqual(prior);
  writeFileSync(join(f.installedRoot, 'lib.so'), readFileSync(join(f.installedRoot, 'lib.so')));
  await expect(compareLinuxFiles(f.installedRoot, f.files, prior)).rejects.toThrow();
});
it('parses only the plaintext authenticated by gpgv, never unsigned armor headers', async () => {
  const f = chain(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (cmd, args) => cmd === '/usr/bin/gpgv' ? { stdout: 'Origin: Google\n', stderr: `[GNUPG:] VALIDSIG ${GOOGLE_LINUX_FINGERPRINT}` } : original(cmd, args));
  await expect(authenticateDeb(f.options)).rejects.toThrow();
});
it('uses an available apt InRelease before fetching a replacement', async () => {
  const f = chain(); const cachedInRelease = await f.fetch('https://dl.google.com/linux/chrome/deb/dists/stable/InRelease'); f.fetch.mockClear();
  expect(await authenticateDeb({ ...f.options, cachedInRelease })).toEqual(f.files);
  expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/InRelease'))).toBe(false);
});
it.each(['chrome', 'chrome-sandbox'])('cached launch independently hashes %s against its authenticated digest', async name => {
  const f = installed(); const prior = await compareLinuxFiles(f.installedRoot, f.files);
  // Keep every identity unchanged; only the authenticated expected digest differs.
  // Deleting either per-launch read must make this rejection fail.
  const table = f.files.map(file => file.path.endsWith('/' + name) ? { ...file, sha256: '00'.repeat(32) } : file);
  await expect(compareLinuxFiles(f.installedRoot, table, prior)).rejects.toThrow('Package bytes changed');
});
