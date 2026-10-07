import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registrationPlan, unixLauncher, installRegistration, removeRegistration, browserRegistrationFamily } from './browser-extension-host-registration.mjs';
const base = { hostName: 'com.murage.test', launcherPath: '/fixture/host', productionIds: ['a'.repeat(32)], developmentIds: ['b'.repeat(32)] };
test('registration origins isolate dev and production and reject wildcards', () => {
  const prod = registrationPlan({ ...base, platform: 'darwin', browser: 'chrome', home: '/fixture' });
  const dev = registrationPlan({ ...base, platform: 'linux', browser: 'brave', home: '/fixture', development: true });
  assert.deepEqual(prod.manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.deepEqual(dev.manifest.allowed_origins, [`chrome-extension://${'b'.repeat(32)}/`]);
  assert.throws(() => registrationPlan({ ...base, platform: 'darwin', browser: 'chrome', home: '/fixture', productionIds: ['*'] }));
});
test('Windows emits explicit HKCU registration instruction and requires native adapter', async () => {
  const plan = registrationPlan({ ...base, platform: 'win32', browser: 'edge', launcherPath: 'C:\\fixture\\host.exe', manifestPath: 'C:\\fixture\\host.json' });
  assert.equal(plan.nativeLauncherRequired, true); assert.match(plan.registry.key, /^HKCU\\Software\\Microsoft\\Edge/);
  await assert.rejects(installRegistration(plan), /adapter_required/);
});
test('launcher uses explicit bundled Electron-as-Node paths without token arguments', () => {
  const launcher = unixLauncher({ electronPath: "/fixture/Murage's App", hostScriptPath: '/fixture/host.mjs', configPath: '/fixture/config.json' });
  assert.match(launcher, /ELECTRON_RUN_AS_NODE=1 exec/); assert.match(launcher, /"\$@"/); assert.equal(launcher.includes('token'), false);
  assert.throws(() => unixLauncher({ electronPath: '/bad\npath', hostScriptPath: '/host', configPath: '/config' }));
});
test('temporary install/remove is idempotent and preserves foreign registration', async () => {
  const root = await fs.mkdtemp(path.resolve('.registration-'));
  try {
    const plan = registrationPlan({ ...base, platform: 'linux', browser: 'chrome', home: root });
    await installRegistration(plan); await installRegistration(plan);
    assert.equal((await fs.stat(plan.manifestPath)).mode & 0o777, 0o600);
    await fs.writeFile(plan.manifestPath, '{}');
    await assert.rejects(installRegistration(plan), /ownership_conflict/); await assert.rejects(removeRegistration(plan), /ownership_conflict/);
    await fs.writeFile(plan.manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
    assert.equal(await removeRegistration(plan), true); assert.equal(await removeRegistration(plan), false);
  } finally { await fs.rm(root, { recursive: true }); }
});

test('matching symlink registration is not treated as owned', async () => {
  const root = await fs.mkdtemp(path.resolve('.registration-'));
  try {
    const plan = registrationPlan({ ...base, platform: 'linux', browser: 'chrome', home: root });
    await fs.mkdir(path.dirname(plan.manifestPath), { recursive: true });
    const foreign = path.join(root, 'foreign.json'); await fs.writeFile(foreign, JSON.stringify(plan.manifest, null, 2) + '\n');
    await fs.symlink(foreign, plan.manifestPath);
    await assert.rejects(installRegistration(plan), /ownership_conflict/); await assert.rejects(removeRegistration(plan), /ownership_conflict/);
    assert.ok(await fs.readFile(foreign));
  } finally { await fs.rm(root, { recursive: true }); }
});

test('macOS Brave uses the Chrome manifest directory and ownership family', () => {
  const chrome = registrationPlan({ ...base, platform: 'darwin', browser: 'chrome', home: '/fixture' });
  const brave = registrationPlan({ ...base, platform: 'darwin', browser: 'brave', home: '/fixture' });
  assert.deepEqual(brave, chrome);
  assert.equal(browserRegistrationFamily('brave', 'darwin'), 'chrome');
  assert.equal(browserRegistrationFamily('brave', 'win32'), 'chromium');
  assert.equal(browserRegistrationFamily('brave', 'linux'), 'brave');
});
