import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowChromeResolver } from './browser-window-chrome.ts';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chrome-download-')); });
afterEach(() => removeTempDirSync(root));
function fixture(platform: 'darwin' | 'win32' | 'linux' = 'darwin') {
  const version = '157.0.8103.38', zip = Buffer.from('test zip');
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const validated = { darwin: { installedVersions: [], cft: { version, sha256: { 'mac-arm64': sha256 } } }, win32: { installedVersions: [], cft: { version, sha256: { win64: sha256 } } }, linux: { installedVersions: [], cft: null } };
  const deps = {
    candidates: () => [], readVersion: () => version,
    fetch: vi.fn(async (_url: string) => zip),
    extractZip: vi.fn(async (_zip: string, target: string) => {
      const app = platform === 'darwin' ? join(target, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS') : join(target, 'chrome-win64');
      mkdirSync(app, { recursive: true }); writeFileSync(join(app, platform === 'darwin' ? 'Google Chrome for Testing' : 'chrome.exe'), 'MZchrome', { mode: 0o755 });
    }),
    run: vi.fn(async () => ({ stdout: '', stderr: 'accepted\nsource=Notarized Developer ID' })),
    authenticode: vi.fn(async () => ({ status: 'Valid', organization: 'Google LLC', subject: 'O=Google LLC', thumbprint: 'ab'.repeat(32) })),
    policy: vi.fn(async () => false), grant: vi.fn(async () => {}),
  };
  return { version, deps, resolver: createWindowChromeResolver({ platform, arch: platform === 'darwin' ? 'arm64' : 'x64', dataDir: root, env: { DISPLAY: ':1' }, validated, deps }) };
}
it('offers an explicit download, never fetches during resolve or without the owner tap (M20)', async () => {
  const f = fixture(); expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'download_needed' });
  expect(await f.resolver.download({ ownerRequested: false, onProgress() {} })).toMatchObject({ cause: 'download_needed' }); expect(f.deps.fetch).not.toHaveBeenCalled();
});
it.each(['darwin', 'win32'] as const)('stages, verifies and atomically publishes %s CfT then checks its manifest', async platform => {
  const f = fixture(platform), onProgress = vi.fn();
  const result = await f.resolver.download({ ownerRequested: true, onProgress }); expect(result).toHaveProperty('ok');
  expect(f.deps.fetch.mock.calls[0][0]).toMatch(/^https:\/\/storage.googleapis.com\/chrome-for-testing-public\/157\.0\.8103\.38\//);
  expect(onProgress).toHaveBeenCalled(); expect(await f.resolver.resolve({ mode: 'local' })).toHaveProperty('ok');
  if (platform === 'win32') expect(f.deps.grant).toHaveBeenCalledTimes(1);
  if ('ok' in result) writeFileSync(result.ok.executable, 'tampered');
  expect(await f.resolver.resolve({ mode: 'local' })).toMatchObject({ cause: 'recheck_needed' });
  expect(await f.resolver.resolve({ mode: 'prepare' })).toMatchObject({ cause: 'unverified' });
});
it.each(['hash', 'partial', 'signature', 'unpack', 'grant'] as const)('never publishes a %s download and preserves existing versions', async fault => {
  const f = fixture(fault === 'grant' ? 'win32' : 'darwin');
  const old = join(root, 'browser-window', 'cft', '156.0.0.1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'keep'), 'old');
  if (fault === 'hash') f.deps.fetch.mockResolvedValue(Buffer.from('tampered'));
  if (fault === 'partial') f.deps.fetch.mockRejectedValue(new Error('interrupted'));
  if (fault === 'signature') f.deps.run.mockRejectedValue(new Error('ad hoc'));
  if (fault === 'unpack') f.deps.extractZip.mockRejectedValue(new Error('unsafe zip'));
  if (fault === 'grant') f.deps.grant.mockRejectedValue(new Error('ACL'));
  expect(await f.resolver.download({ ownerRequested: true, onProgress() {} })).toHaveProperty('cause');
  expect(existsSync(join(root, 'browser-window', 'cft', f.version))).toBe(false); expect(existsSync(join(old, 'keep'))).toBe(true);
});
it('Linux never offers or downloads CfT (M18)', async () => {
  const f = fixture('linux'); expect(await f.resolver.download({ ownerRequested: true, onProgress() {} })).toMatchObject({ cause: 'not_installed' }); expect(f.deps.fetch).not.toHaveBeenCalled();
});
it('a cached CfT must still report the exact pinned executable version', async () => {
  const f = fixture(); expect(await f.resolver.download({ ownerRequested: true, onProgress() {} })).toHaveProperty('ok');
  f.deps.readVersion = () => '157.0.8103.39';
  expect(await f.resolver.resolve({ mode: 'local' })).toHaveProperty('cause', 'version_not_checked');
});
it('every unpacked file is covered, including entries beside the macOS app', async () => {
  const f = fixture(), extract = f.deps.extractZip.getMockImplementation()!;
  f.deps.extractZip.mockImplementation(async (zip, target) => { await extract(zip, target); writeFileSync(join(target, 'chrome-mac-arm64', 'LICENSE'), 'license'); });
  expect(await f.resolver.download({ ownerRequested: true, onProgress() {} })).toHaveProperty('ok');
  writeFileSync(join(root, 'browser-window/cft', f.version, 'payload/chrome-mac-arm64/LICENSE'), 'changed');
  expect(await f.resolver.resolve({ mode: 'local' })).toHaveProperty('cause', 'recheck_needed');
});
