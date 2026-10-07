// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { realpathSync } from 'node:fs';
// A short real root keeps the fixture socket inside sockaddr_un's bound on
// every runner (macOS TMPDIR is long and reached through /var -> /private/var).
// These fixtures use a Unix socket broker config and Mac/Linux registration
// paths. Windows registration (named pipe, ACL, registry) is covered by
// browser-extension-windows.node-test.mjs.
const POSIX_ONLY = process.platform === 'win32' && 'POSIX broker fixture; Windows registration has its own tests';
const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : realpathSync('/tmp');
import { connectOwnerBrowser, removeOwnerBrowser, assertRegistryFree, assertBrowserInstalled, rollbackFailedInstall } from './browser-extension-registration.mjs';
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(SHORT_ROOT, 'bxr-')); await fs.chmod(root, 0o700);
  const resources = path.join(root, 'resources'), browserResources = path.join(resources, 'browser-extension');
  await fs.mkdir(browserResources, { recursive: true });
  await fs.writeFile(path.join(browserResources, 'native-host.mjs'), '// fixture only\n');
  await fs.writeFile(path.join(browserResources, 'build.json'), JSON.stringify({ version: 1, mode: 'development', developmentId: 'b'.repeat(32) }));
  const socketPath = path.join(root, 'broker.sock'); const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(socketPath, resolve)); await fs.chmod(socketPath, 0o600);
  const configPath = path.join(root, 'native-host.json'); await fs.writeFile(configPath, JSON.stringify({ version: 1, socketPath, token: 'a'.repeat(64) }), { mode: 0o600 });
  // The browser has been opened once: its own user-data folder exists (Connect never creates one for a browser the owner lacks).
  if (!process.env.BXR_NO_BROWSER) for (const folder of ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium']) await fs.mkdir(path.join(root, 'fake-home', 'Library/Application Support', folder), { recursive: true });
  if (!process.env.BXR_NO_BROWSER) for (const folder of ['google-chrome', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'chromium']) await fs.mkdir(path.join(root, 'fake-home', '.config', folder), { recursive: true });
  const options = { ownerConfirmed: true, browser: 'chromium', platform: 'darwin', registrationHome: path.join(root, 'fake-home'), configPath, resourcesPath: resources, electronPath: process.execPath };
  try { await run(options, { root, browserResources }); }
  finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
}
test('owner Connect writes exact fake-home manifest, is idempotent and removes matching files', { skip: POSIX_ONLY }, async () => fixture(async options => {
  const connected = await connectOwnerBrowser(options); assert.equal(connected.connected, false);
  assert.ok(connected.manifestPath.startsWith(options.registrationHome + path.sep));
  const manifest = JSON.parse(await fs.readFile(connected.manifestPath, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'b'.repeat(32)}/`]);
  assert.equal((await fs.stat(manifest.path)).mode & 0o777, 0o700);
  assert.match(await fs.readFile(manifest.path, 'utf8'), /native-host.json/);
  assert.deepEqual(await connectOwnerBrowser(options), connected);
  assert.equal((await removeOwnerBrowser(options)).status, 'removed');
  assert.equal((await removeOwnerBrowser(options)).status, 'not_registered');
  await assert.rejects(fs.stat(manifest.path), { code: 'ENOENT' });
}));
test('owner false and absent build identity perform no registration', { skip: POSIX_ONLY }, async () => { process.env.BXR_NO_BROWSER = '1'; try { await fixture(async (options, { browserResources }) => {
  await assert.rejects(connectOwnerBrowser({ ...options, ownerConfirmed: false }), { code: 'owner_consent_required' });
  await fs.writeFile(path.join(browserResources, 'build.json'), JSON.stringify({ mode: 'resources', productionIds: [] }));
  await assert.rejects(connectOwnerBrowser(options), { code: 'extension_identity_required' });
  await assert.rejects(fs.stat(options.registrationHome), { code: 'ENOENT' });
}); } finally { delete process.env.BXR_NO_BROWSER; } });
test('existing foreign launcher or modified manifest is preserved', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  const launcher = path.join(root, 'browser-native-chromium'); await fs.writeFile(launcher, 'foreign');
  await assert.rejects(connectOwnerBrowser(options), { code: 'registration_ownership_conflict' }); assert.equal(await fs.readFile(launcher, 'utf8'), 'foreign');
  await fs.unlink(launcher); const receipt = await connectOwnerBrowser(options);
  await fs.writeFile(receipt.manifestPath, 'foreign-manifest');
  await assert.rejects(removeOwnerBrowser(options), { code: 'registration_ownership_conflict' });
  assert.equal(await fs.readFile(receipt.manifestPath, 'utf8'), 'foreign-manifest');
  assert.ok(await fs.stat(launcher));
}));
test('changed build requires explicit owned removal instead of silent replacement', { skip: POSIX_ONLY }, async () => fixture(async (options, { browserResources }) => {
  const first = await connectOwnerBrowser(options); const bytes = await fs.readFile(first.manifestPath, 'utf8');
  await fs.writeFile(path.join(browserResources, 'build.json'), JSON.stringify({ mode: 'release', productionIds: ['c'.repeat(32)] }));
  await assert.rejects(connectOwnerBrowser(options), { code: 'registration_repair_required' });
  assert.equal(await fs.readFile(first.manifestPath, 'utf8'), bytes);
  await removeOwnerBrowser(options); const next = await connectOwnerBrowser(options);
  assert.deepEqual(JSON.parse(await fs.readFile(next.manifestPath, 'utf8')).allowed_origins, [`chrome-extension://${'c'.repeat(32)}/`]);
}));

test('failed initial installation can remove only its pending owned files', { skip: POSIX_ONLY }, async () => { process.env.BXR_NO_BROWSER = '1'; try { await fixture(async (options, { root }) => {
  await fs.writeFile(options.registrationHome, 'foreign-home-file');
  await assert.rejects(connectOwnerBrowser(options), { code: 'browser_registration_unavailable' });
  assert.equal((await removeOwnerBrowser(options)).status, 'removed');
  assert.equal(await fs.readFile(options.registrationHome, 'utf8'), 'foreign-home-file');
  await assert.rejects(fs.stat(path.join(root, 'browser-native-chromium')), { code: 'ENOENT' });
}); } finally { delete process.env.BXR_NO_BROWSER; } });


test('macOS Brave and Chrome share owned registration and removal', { skip: POSIX_ONLY }, async () => fixture(async options => {
  const braveOptions = { ...options, browser: 'brave' };
  const chromeOptions = { ...options, browser: 'chrome' };
  const brave = await connectOwnerBrowser(braveOptions);
  const chrome = await connectOwnerBrowser(chromeOptions);
  assert.equal(brave.registrationFamily, 'chrome');
  assert.deepEqual(brave.sharedBrowsers, ['brave', 'chrome']);
  assert.deepEqual(chrome.sharedBrowsers, brave.sharedBrowsers);
  assert.equal(brave.manifestPath, chrome.manifestPath);
  assert.equal(brave.receiptPath, chrome.receiptPath);
  assert.match(brave.manifestPath, /Google\/Chrome\/NativeMessagingHosts\/com\.murage\.browser\.json$/);
  assert.equal((await removeOwnerBrowser(braveOptions)).status, 'removed');
  assert.equal((await removeOwnerBrowser(chromeOptions)).status, 'not_registered');
}));

// The broker's config folder is under /tmp, which Mac and Linux empty at
// restart. With registrationDirectory the owned launcher and receipt survive,
// so Connect after a restart finds its own registration instead of calling
// the surviving browser manifest a foreign one.
test('a registration in its own folder survives the runtime folder being emptied at restart', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  const registrationDirectory = path.join(root, 'registration'); await fs.mkdir(registrationDirectory, { mode: 0o700 });
  const stable = { ...options, registrationDirectory };
  const first = await connectOwnerBrowser(stable);
  assert.ok(first.receiptPath.startsWith(registrationDirectory + path.sep));
  const manifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  assert.ok(manifest.path.startsWith(registrationDirectory + path.sep));
  assert.match(await fs.readFile(manifest.path, 'utf8'), new RegExp(options.configPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  // Restart: the runtime config goes away and the broker writes it again.
  const config = await fs.readFile(options.configPath); await fs.unlink(options.configPath);
  await fs.writeFile(options.configPath, config, { mode: 0o600 });
  assert.deepEqual(await connectOwnerBrowser(stable), first);
  assert.equal((await removeOwnerBrowser(stable)).status, 'removed');
  await assert.rejects(fs.stat(manifest.path), { code: 'ENOENT' });
  await assert.rejects(fs.stat(first.manifestPath), { code: 'ENOENT' });
}));

test('a registration beside the runtime config is lost at restart (why the folder moved)', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  const first = await connectOwnerBrowser(options);
  // Restart empties the runtime folder: launcher and receipt go, the browser's manifest stays.
  await fs.unlink(path.join(root, 'browser-native-chromium')); await fs.unlink(first.receiptPath);
  await assert.rejects(connectOwnerBrowser(options), { code: 'registration_ownership_conflict' });
  await fs.unlink(first.manifestPath);
}));

test('an AppImage registers the AppImage file and a helper copy outside the mount', { skip: POSIX_ONLY }, async () => fixture(async (options, { root, browserResources }) => {
  const registrationDirectory = path.join(root, 'registration'); await fs.mkdir(registrationDirectory, { mode: 0o700 });
  const appImage = path.join(root, 'Murage-0.1.61-x86_64.AppImage'); await fs.writeFile(appImage, '#!/bin/sh\n', { mode: 0o755 });
  const linux = { ...options, platform: 'linux', browser: 'chrome', registrationDirectory, appImage, electronPath: path.join(root, '.mount_MurageAB', 'murage') };
  await fs.mkdir(path.dirname(linux.electronPath)); await fs.writeFile(linux.electronPath, 'mount binary');
  const connected = await connectOwnerBrowser(linux);
  assert.match(connected.manifestPath, /\.config\/google-chrome\/NativeMessagingHosts\/com\.murage\.browser\.json$/);
  const manifest = JSON.parse(await fs.readFile(connected.manifestPath, 'utf8'));
  const launcher = await fs.readFile(manifest.path, 'utf8');
  const copy = path.join(registrationDirectory, 'native-host-chrome.mjs');
  assert.equal(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${appImage}' '${copy}' '${options.configPath}' "$@" --no-sandbox\n`);
  assert.doesNotMatch(launcher, /\.mount_/);
  assert.equal(await fs.readFile(copy, 'utf8'), '// fixture only\n');
  // An update keeps the AppImage path and brings a new helper script.
  await fs.writeFile(path.join(browserResources, 'native-host.mjs'), '// updated helper\n');
  assert.deepEqual(await connectOwnerBrowser(linux), connected);
  assert.equal(await fs.readFile(copy, 'utf8'), '// updated helper\n');
  assert.equal(await fs.readFile(manifest.path, 'utf8'), launcher);
  assert.equal((await removeOwnerBrowser(linux)).status, 'removed');
  await assert.rejects(fs.stat(copy), { code: 'ENOENT' });
  await assert.rejects(fs.stat(manifest.path), { code: 'ENOENT' });
}));

test('an AppImage path inside a mount, or on another platform, is refused', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  await assert.rejects(connectOwnerBrowser({ ...options, platform: 'linux', browser: 'chrome', appImage: '/tmp/.mount_MurageAB/murage' }), { code: 'invalid_registration_paths' });
  await assert.rejects(connectOwnerBrowser({ ...options, appImage: path.join(root, 'Murage.AppImage') }), { code: 'invalid_registration_paths' });
  await assert.rejects(connectOwnerBrowser({ ...options, registrationDirectory: 'relative' }), { code: 'invalid_registration_paths' });
}));

test('an AppImage helper copy Murage did not write, or that changed, is preserved and refused', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  const registrationDirectory = path.join(root, 'registration'); await fs.mkdir(registrationDirectory, { mode: 0o700 });
  const appImage = path.join(root, 'Murage.AppImage'); await fs.writeFile(appImage, '#!/bin/sh\n', { mode: 0o755 });
  const linux = { ...options, platform: 'linux', browser: 'chrome', registrationDirectory, appImage };
  const copy = path.join(registrationDirectory, 'native-host-chrome.mjs');
  await fs.writeFile(copy, '// someone else\n');
  await assert.rejects(connectOwnerBrowser(linux), { code: 'registration_ownership_conflict' });
  assert.equal(await fs.readFile(copy, 'utf8'), '// someone else\n');
  await fs.unlink(copy);
  await connectOwnerBrowser(linux);
  await fs.writeFile(copy, '// changed after registration\n');
  await assert.rejects(connectOwnerBrowser(linux), { code: 'registration_ownership_conflict' });
  await assert.rejects(removeOwnerBrowser(linux), { code: 'registration_ownership_conflict' });
  assert.equal(await fs.readFile(copy, 'utf8'), '// changed after registration\n');
}));

test('a temp file left by an interrupted write never blocks the next Connect', { skip: POSIX_ONLY }, async () => fixture(async (options, { root }) => {
  const registrationDirectory = path.join(root, 'registration'); await fs.mkdir(registrationDirectory, { mode: 0o700 });
  const appImage = path.join(root, 'Murage.AppImage'); await fs.writeFile(appImage, '#!/bin/sh\n', { mode: 0o755 });
  const linux = { ...options, platform: 'linux', browser: 'chrome', registrationDirectory, appImage };
  // What a crash between writing and renaming leaves behind.
  await fs.writeFile(path.join(registrationDirectory, 'registration-chrome.json.new'), 'partial');
  await fs.writeFile(path.join(registrationDirectory, 'native-host-chrome.mjs.new'), 'partial');
  assert.equal((await connectOwnerBrowser(linux)).status, 'installed');
  assert.equal((await removeOwnerBrowser(linux)).status, 'removed');
}));

// ---- Vultr Windows and Linux findings (W3 and the Linux folder rule), red-first ----
test('Linux and Mac: Connect creates nothing for a browser that is not installed', { skip: POSIX_ONLY }, async () => {
  process.env.BXR_NO_BROWSER = '1';
  try {
    await fixture(async options => {
      await assert.rejects(connectOwnerBrowser(options), { code: 'browser_not_installed' });
      await assert.rejects(fs.stat(options.registrationHome), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(path.dirname(options.configPath), 'browser-native-chromium')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(path.dirname(options.configPath), 'registration-chromium.json')), { code: 'ENOENT' });
    });
  } finally { delete process.env.BXR_NO_BROWSER; }
});
test('Mac Brave counts as installed from its own folder, and Chrome\'s folder is then created for it', { skip: POSIX_ONLY }, async () => {
  process.env.BXR_NO_BROWSER = '1';
  try {
    await fixture(async options => {
      await fs.mkdir(path.join(options.registrationHome, 'Library/Application Support/BraveSoftware/Brave-Browser'), { recursive: true });
      const connected = await connectOwnerBrowser({ ...options, browser: 'brave' });
      assert.match(connected.manifestPath, /Google\/Chrome\/NativeMessagingHosts/);
    });
  } finally { delete process.env.BXR_NO_BROWSER; }
});
test('a registry value that is not ours is a conflict found before anything is written (check before write)', async () => {
  const plan = { registry: { key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.murage.browser', value: 'C:\\ours.json' } };
  await assert.rejects(assertRegistryFree(plan, { read: async () => 'C:\\foreign.json' }), { code: 'registration_ownership_conflict' });
  await assertRegistryFree(plan, { read: async () => undefined });
  await assertRegistryFree(plan, { read: async () => 'C:\\ours.json' });
  await assertRegistryFree({}, undefined);
});
test('a failed first Connect leaves no owned file behind, and never touches a manifest that is not its own', { skip: POSIX_ONLY }, async () => fixture(async (_options, { root }) => {
  const launcher = path.join(root, 'launcher'), receipt = path.join(root, 'receipt.json'), manifest = path.join(root, 'manifest.json'), foreign = path.join(root, 'foreign.json');
  await fs.writeFile(launcher, 'x'); await fs.writeFile(receipt, 'x'); await fs.writeFile(manifest, 'ours'); await fs.writeFile(foreign, 'theirs');
  await rollbackFailedInstall({ files: [launcher, receipt], manifestPath: manifest, manifestText: 'ours' });
  for (const file of [launcher, receipt, manifest]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await rollbackFailedInstall({ files: [], manifestPath: foreign, manifestText: 'ours' }); assert.equal(await fs.readFile(foreign, 'utf8'), 'theirs');
}));
test('Windows adapter reads the default value of a key and treats failure as nothing known', async () => {
  const { windowsRegistrationAdapter } = await import('./browser-extension-windows.mjs');
  const key = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.murage.browser', value = 'C:\\Users\\x\\manifest.json';
  const registry = { key, value }, manifest = { name: 'com.murage.browser' };
  const asked = [];
  const found = windowsRegistrationAdapter('chrome', { query: async k => { asked.push(k); return `\r\n${key}\r\n    (Default)    REG_SZ    C:\\other\\m.json\r\n`; } });
  assert.equal(await found.read(registry, manifest), 'C:\\other\\m.json'); assert.deepEqual(asked, [key]);
  assert.equal(await windowsRegistrationAdapter('chrome', { query: async () => { throw new Error('ERROR: The system was unable to find the specified registry key'); } }).read(registry), undefined);
});
