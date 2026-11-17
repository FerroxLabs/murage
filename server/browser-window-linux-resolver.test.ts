import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Redirect only OS fixture reads. The resolver, provenance verifier, hashes and
// private evidence writes are real; no host installation or database is used.
const os = vi.hoisted(() => ({ root: '' }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const mapped = (p: unknown) => typeof p === 'string' && ['/opt', '/var/lib', '/proc/sys', '/etc/opt'].some(prefix => p === prefix || p.startsWith(prefix + '/'));
  const path = (p: unknown) => mapped(p) ? os.root + p : p;
  const overrides = Object.fromEntries(['existsSync', 'readFileSync', 'readdirSync', 'openSync', 'readlinkSync'].map(name => [name, (p: unknown, ...args: unknown[]) => (fs as any)[name](path(p), ...args)]));
  return { ...fs, ...overrides,
    realpathSync: (p: string) => mapped(p) ? fs.realpathSync(path(p) as string).slice(os.root.length) : fs.realpathSync(p),
    lstatSync: (p: string, options?: any) => { const s = fs.lstatSync(path(p) as string, options); if (mapped(p) && !options?.bigint) s.uid = 0; return s; },
  };
});
import * as fs from 'node:fs';
import { createWindowChromeResolver } from './browser-window-chrome.ts';
import { GOOGLE_LINUX_FINGERPRINT } from './browser-window-linux.ts';
describe.runIf(process.platform === 'linux')('Linux resolver fixture', () => {
const version = '157.0.8103.38';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'linux-resolver-')); os.root = root; });
afterEach(() => { removeTempDirSync(root); });
function fixture() {
  for (const path of ['opt/google/chrome', 'var/lib/rpm', 'proc/sys/user']) fs.mkdirSync(join(root, path), { recursive: true, mode: 0o755 });
  const names = ['chrome', 'chrome-sandbox', 'chrome_crashpad_handler', 'lib.so'];
  for (const name of names) fs.writeFileSync(join(root, 'opt/google/chrome', name), name, { mode: 0o755 });
  fs.writeFileSync(join(root, 'var/lib/rpm/Packages'), 'database');
  fs.writeFileSync(join(root, 'proc/sys/user/max_user_namespaces'), '100');
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === '/usr/bin/gpg') return { stdout: `pub:-:4096:1:key:0:0::::::\nfpr:::::::::${GOOGLE_LINUX_FINGERPRINT}:\n`, stderr: '' };
    if (cmd === '/usr/bin/rpmkeys') return { stdout: 'package.rpm: digests signatures OK', stderr: '' };
    if (args.includes('--dump')) return { stdout: names.map(n => `/opt/google/chrome/${n} 5 0 ${hash(n)} 0100755 root root 0 0 0 X`).join('\n'), stderr: '' };
    if (args.includes('--qf')) return { stdout: `google-chrome-stable\n${version}-1\n${args.includes('-qp') ? '8\n' : ''}`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const fetch = vi.fn(async () => Buffer.from('RPM fixture')), authenticode = vi.fn();
  const options = { platform: 'linux' as const, arch: 'x64', env: { DISPLAY: ':1' }, dataDir: join(root, 'data'),
    validated: { darwin: { installedVersions: [], cft: null }, win32: { installedVersions: [], cft: null }, linux: { installedVersions: [version], cft: null } }, deps: { run, fetch, authenticode } };
  const resolver = createWindowChromeResolver(options);
  const evidence = join(root, `data/browser-window/linux-evidence/google-chrome-stable-${version}-1.json`);
  const clear = () => { run.mockClear(); fetch.mockClear(); authenticode.mockClear(); };
  const local = async () => { clear(); const result = await resolver.resolve({ mode: 'local' }); expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(authenticode).not.toHaveBeenCalled(); return result; };
  return { resolver, options, evidence, run, fetch, local };
}
it('Linux prepare establishes provenance and local succeeds without child/native/network calls', async () => {
  const f = fixture(); expect(await f.local()).toHaveProperty('cause', 'linux_evidence_needed');
  expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok'); expect(fs.existsSync(f.evidence)).toBe(true);
  expect(await f.local()).toHaveProperty('ok');
});
it.each(['identity', 'database', 'bytes', 'extra', 'missing'] as const)('invalidates disk and memory on %s change and recovers in one prepare', async change => {
  const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
  const lib = join(root, 'opt/google/chrome/lib.so');
  if (change === 'identity') fs.writeFileSync(lib, 'lib.so');
  if (change === 'database') fs.writeFileSync(join(root, 'var/lib/rpm/Packages'), 'updated database');
  if (change === 'bytes') fs.writeFileSync(lib, 'evil');
  if (change === 'extra') fs.writeFileSync(join(root, 'opt/google/chrome/extra'), 'evil');
  if (change === 'missing') fs.rmSync(lib);
  expect(await f.local()).toHaveProperty('cause'); expect(fs.existsSync(f.evidence)).toBe(false);
  if (['bytes', 'extra', 'missing'].includes(change)) {
    expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('cause');
    fs.writeFileSync(lib, 'lib.so', { mode: 0o755 }); fs.rmSync(join(root, 'opt/google/chrome/extra'), { force: true });
  }
  f.fetch.mockClear(); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok'); expect(f.fetch).toHaveBeenCalled();
  expect(await f.local()).toHaveProperty('ok');
});
it('prepare after restart discards a stale disk manifest and completes fresh verification', async () => {
  const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
  fs.writeFileSync(join(root, 'opt/google/chrome/lib.so'), 'lib.so'); f.fetch.mockClear();
  expect(await createWindowChromeResolver(f.options).resolve({ mode: 'prepare' })).toHaveProperty('ok'); expect(f.fetch).toHaveBeenCalled();
});
it('a restart with unchanged disk evidence prepares offline after a local recheck', async () => {
  const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
  const restarted = createWindowChromeResolver(f.options); f.fetch.mockClear();
  expect(await restarted.resolve({ mode: 'local' })).toHaveProperty('cause', 'recheck_needed');
  expect(fs.existsSync(f.evidence)).toBe(true);
  expect(await restarted.resolve({ mode: 'prepare' })).toHaveProperty('ok'); expect(f.fetch).not.toHaveBeenCalled();
  expect(await restarted.resolve({ mode: 'local' })).toHaveProperty('ok');
});
it('sandbox refusal cannot leave a local admission, and prepare recovers when restored', async () => {
  const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
  fs.writeFileSync(join(root, 'proc/sys/user/max_user_namespaces'), '0');
  expect(await f.local()).toHaveProperty('cause', 'sandbox_blocked');
  expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('cause', 'sandbox_blocked');
  fs.writeFileSync(join(root, 'proc/sys/user/max_user_namespaces'), '100');
  expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok'); expect(await f.local()).toHaveProperty('ok');
});

});
