import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowChromeResolver, GOOGLE_CODESIGN_REQUIREMENT } from './browser-window-chrome.ts';
import { WINDOW_CHROME_VALIDATED, validateWindowChromeList } from './browser-window-validated.ts';

const version = '157.0.8103.38';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chrome-verify-')); });
afterEach(() => removeTempDirSync(root));
function fixture(platform: 'darwin' | 'win32' | 'linux' = 'darwin') {
  const tree = join(root, 'Chrome'); mkdirSync(join(tree, 'nested'), { recursive: true });
  const executable = join(tree, platform === 'win32' ? 'chrome.exe' : 'chrome');
  writeFileSync(executable, 'MZchrome'); chmodSync(executable, 0o755);
  writeFileSync(join(tree, 'nested', 'helper.dll'), 'MZhelper');
  const run = vi.fn(async (_file: string, _args: string[]) => ({ stdout: '', stderr: 'accepted\nsource=Notarized Developer ID' }));
  const authenticode = vi.fn(async (_path: string) => ({ status: 'Valid', subject: 'CN=Google Chrome, O=Google LLC, C=US', organization: 'Google LLC', thumbprint: 'ab'.repeat(32) }));
  const policy = vi.fn(async () => false), fetch = vi.fn();
  const deps = { candidates: () => [{ root: tree, executable }], readVersion: () => version, run, authenticode, policy, fetch };
  const validated = validateWindowChromeList({ darwin: { installedVersions: [version], cft: null }, win32: { installedVersions: [version], cft: null }, linux: { installedVersions: [version], cft: null } });
  const resolver = createWindowChromeResolver({ platform, env: { DISPLAY: ':1' }, dataDir: join(root, 'data'), validated, deps });
  return { resolver, deps, validated, tree, executable };
}

describe('exact release eligibility before trust or network', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('ships disabled on %s, including cached/downloadable CfT', async platform => {
    const f = fixture(platform);
    const r = createWindowChromeResolver({ platform, env: { DISPLAY: ':1' }, dataDir: join(root, 'data'), deps: f.deps });
    expect(await r.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'version_not_checked' });
    expect(await r.download({ ownerRequested: true, onProgress() {} })).toMatchObject({ cause: 'not_installed' });
    expect(f.deps.run).not.toHaveBeenCalled(); expect(f.deps.authenticode).not.toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(WINDOW_CHROME_VALIDATED[platform]).toEqual({ installedVersions: [], cft: null });
  });
  it('refuses another authentic patch in the same major (M17)', async () => {
    const f = fixture(); f.deps.readVersion = () => '157.0.8103.39';
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'version_not_checked' }); expect(f.deps.run).not.toHaveBeenCalled();
  });
  it.each([{ darwin: { installedVersions: ['157.*'], cft: null } }, { darwin: { installedVersions: [version], cft: null } }, { ...WINDOW_CHROME_VALIDATED, linux: { installedVersions: [157], cft: null } }])('rejects malformed or missing-platform release lists', value => {
    expect(() => validateWindowChromeList(value)).toThrow();
  });
  it('Cloud home and no display take precedence', async () => {
    const f = fixture();
    for (const [env, cause] of [[{ MURAGE_CLOUD_ROLE: 'home' }, 'cloud_home'], [{}, 'no_display']] as const) {
      expect(await createWindowChromeResolver({ platform: 'linux', dataDir: root, env, validated: f.validated, deps: f.deps }).resolve({ mode: 'prepare' })).toMatchObject({ cause });
    }
    expect(f.deps.run).not.toHaveBeenCalled();
  });
  it.each(['darwin', 'win32', 'linux'] as const)('missing Chrome on %s never downloads automatically (M18/M20)', async platform => {
    const f = fixture(platform); f.deps.candidates = () => [];
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'not_installed' }); expect(f.deps.fetch).not.toHaveBeenCalled();
  });
});

describe('whole tree identity and local admission', () => {
  it('uses the exact Google requirement and notarization tools, with no shell', async () => {
    const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ ok: { executable: f.executable, version, kind: 'installed' } });
    expect(GOOGLE_CODESIGN_REQUIREMENT).toBe('anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"');
    expect(f.deps.run.mock.calls).toEqual([
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', f.tree]],
      ['/usr/bin/codesign', ['-v', `-R=${GOOGLE_CODESIGN_REQUIREMENT}`, f.tree]],
      ['/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', f.tree]],
    ]);
  });
  it.each(['darwin', 'win32'] as const)('local %s never calls trust, child runner or fetch, including misses', async platform => {
    const f = fixture(platform);
    expect(await f.resolver.resolve({ mode: 'local' })).toMatchObject({ cause: 'recheck_needed' });
    expect(f.deps.run).not.toHaveBeenCalled(); expect(f.deps.authenticode).not.toHaveBeenCalled(); expect(f.deps.policy).not.toHaveBeenCalled();
    expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
    f.deps.run.mockClear(); f.deps.authenticode.mockClear(); f.deps.policy.mockClear();
    expect(await f.resolver.resolve({ mode: 'local' })).toHaveProperty('ok');
    writeFileSync(join(f.tree, 'nested', 'helper.dll'), 'MZchanged');
    expect(await f.resolver.resolve({ mode: 'local' })).toMatchObject({ cause: 'recheck_needed' });
    expect(f.deps.run).not.toHaveBeenCalled(); expect(f.deps.authenticode).not.toHaveBeenCalled(); expect(f.deps.policy).not.toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
    expect(platform === 'darwin' ? f.deps.run : f.deps.authenticode).toHaveBeenCalled();
  });
  it.each(['ctime', 'added', 'missing', 'external-link'] as const)('invalidates on %s (M14)', async change => {
    const f = fixture(); await f.resolver.resolve({ mode: 'prepare' });
    const helper = join(f.tree, 'nested', 'helper.dll');
    if (change === 'ctime') chmodSync(helper, 0o700);
    if (change === 'added') writeFileSync(join(f.tree, 'extra'), 'extra');
    if (change === 'missing') rmSync(helper);
    if (change === 'external-link') symlinkSync(root, join(f.tree, 'outside'));
    expect(await f.resolver.resolve({ mode: 'local' })).toMatchObject({ cause: 'recheck_needed' });
  });
  it('refuses retargeted symlinks on prepare and never caches a tree changing during trust', async () => {
    const f = fixture(); symlinkSync(root, join(f.tree, 'escape'));
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'unverified' }); rmSync(join(f.tree, 'escape'));
    f.deps.run.mockImplementation(async () => { writeFileSync(join(f.tree, 'nested', 'helper.dll'), Math.random().toString()); return { stdout: '', stderr: 'accepted\nsource=Notarized Developer ID' }; });
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'recheck_needed' });
  });
  it('requires accepted notarization, and treats child errors as refusals', async () => {
    const f = fixture(); f.deps.run.mockResolvedValue({ stdout: '', stderr: 'accepted\nsource=Developer ID' });
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'unverified' });
    f.deps.run.mockRejectedValue(new Error('signature'));
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'unverified' });
  });
  it('Windows checks every PE, the leaf organization and a thumbprint', async () => {
    const f = fixture('win32'); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
    expect(f.deps.authenticode.mock.calls.map(c => c[0]).sort()).toEqual([f.executable, join(f.tree, 'nested', 'helper.dll')].sort());
    for (const answer of [{ status: 'Valid' }, { status: 'Valid', subject: 'CN=Google LLC, O=Other', organization: 'Other', thumbprint: 'ab'.repeat(32) }, { status: 'NotTrusted', organization: 'Google LLC', thumbprint: 'ab'.repeat(32) }]) {
      chmodSync(f.executable, 0o700); writeFileSync(f.executable, readFileSync(f.executable));
      f.deps.authenticode.mockResolvedValue(answer as never);
      expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'unverified' });
    }
  });
  it('Windows organization policy refuses before trust', async () => {
    const f = fixture('win32'); f.deps.policy.mockResolvedValue(true);
    expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'org_managed' }); expect(f.deps.authenticode).not.toHaveBeenCalled();
  });
});
it('a refused prepare discards the prior Windows admission', async () => {
  const f = fixture('win32'); expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('ok');
  f.deps.policy.mockResolvedValue(true);
  expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('cause', 'org_managed');
  expect(await f.resolver.resolve({ mode: 'local' })).toHaveProperty('cause', 'recheck_needed');
});
it.each([
  { organization: undefined }, { organization: '' }, { thumbprint: undefined }, { thumbprint: '' },
  { thumbprint: 'ab'.repeat(31) }, { thumbprint: 'gg'.repeat(32) },
])('refuses native signer evidence when extraction is missing or failed: %j', async fields => {
  const f = fixture('win32'); f.deps.authenticode.mockResolvedValue({ status: 'Valid', subject: 'O=Google LLC', organization: 'Google LLC', thumbprint: 'ab'.repeat(32), ...fields } as never);
  expect(await f.resolver.resolve({ mode: 'prepare' })).toHaveProperty('cause', 'unverified');
});
