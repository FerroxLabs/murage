import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import test from 'node:test';
import { join } from 'node:path';
import { createUpdaterCoordinator } from './updater-coordinator.mjs';

const MESSAGE = "Couldn't start the update installer. Murage stays on the current version.";
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const shellCalls = [], quits = [], nativeEvents = [];
  const electron = { autoUpdater: new EventEmitter(), shell: {
    openPath: async path => { shellCalls.push(path); },
  }};
  electron.autoUpdater.on('before-quit-for-update', () => nativeEvents.push('quit'));
  const load = Module._load;
  Module._load = (request, ...rest) => request === 'electron' ? electron : load(request, ...rest);
  t.after(() => { Module._load = load; });
  const { NsisUpdater } = createRequire(import.meta.url)('./vendor/electron-updater.cjs');
  const app = { version: '1.0.18', quit: () => quits.push('quit') };
  const updater = new NsisUpdater(null, app);
  updater.logger = { info() {}, warn() {}, error() {} };
  updater.downloadedUpdateHelper = {
    file: 'C:/murage-ci/update.exe', packageFile: null,
    downloadedFileInfo: { isAdminRightsRequired: false },
    versionInfo: { version: '1.0.19' },
  };
  let state = { currentVersion: app.version };
  const coordinator = createUpdaterCoordinator(updater, patch => { state = { ...state, ...patch }; });
  updater.downloadUpdate = async () => {
    updater.emit('update-downloaded', { version: '1.0.19' });
    return [updater.installerPath];
  };
  return { updater, app, coordinator, shellCalls, quits, nativeEvents, state: () => state };
}

for (const code of ['ENOENT', 'EACCES', 'UNKNOWN']) {
  test(`shipped NSIS .exe spawn ${code}: no shell, exact visible message, current version and staged state unchanged`, async t => {
    const h = fixture(t), launches = [];
    const staged = structuredClone(h.updater.downloadedUpdateHelper);
    h.updater.spawnLog = async (...args) => {
      launches.push(args);
      throw Object.assign(new Error('spawn ENOENT'), { code });
    };
    await h.coordinator.download();
    await h.coordinator.install();
    await tick(); await tick();
    assert.deepEqual(h.shellCalls, [], 'an .exe must never reach ShellExecute');
    assert.equal(h.state().message, MESSAGE);
    assert.equal(h.state().status, 'error');
    assert.equal(h.state().currentVersion, '1.0.18');
    assert.equal(h.app.version, '1.0.18');
    assert.equal(h.updater.currentVersion.version, '1.0.18');
    assert.deepEqual(h.updater.downloadedUpdateHelper, staged);
    assert.equal(h.updater.quitAndInstallCalled, false, 'failure must allow retry');
    assert.deepEqual(h.quits, []);
    assert.deepEqual(h.nativeEvents, []);
    assert.deepEqual(launches, [['C:/murage-ci/update.exe', ['--updated', '/S', '--force-run']]]);
  });
}

test('NSIS waits for the hidden spawn before quitting', async t => {
  const h = fixture(t);
  let resolveSpawn;
  h.updater.spawnLog = () => new Promise(resolve => { resolveSpawn = resolve; });
  await h.coordinator.download();
  await h.coordinator.install();
  await tick();
  assert.deepEqual(h.quits, [], 'no optimistic quit while spawn is pending');
  resolveSpawn(true);
  await tick(); await tick();
  assert.deepEqual(h.quits, ['quit']);
  assert.deepEqual(h.nativeEvents, ['quit']);
  assert.deepEqual(h.shellCalls, []);
});

test('ENOENT retry preserves the download and can launch the same installer successfully', async t => {
  const h = fixture(t);
  h.updater.spawnLog = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  await h.coordinator.download();
  await h.coordinator.install();
  await tick(); await tick();
  assert.equal(h.state().message, MESSAGE);
  const paths = [];
  h.updater.spawnLog = async path => { paths.push(path); return true; };
  await h.coordinator.install();
  await tick(); await tick();
  assert.deepEqual(paths, ['C:/murage-ci/update.exe']);
  assert.deepEqual(h.quits, ['quit']);
  assert.deepEqual(h.shellCalls, []);
});

test('explicit elevation failure also reports the safe message and keeps the current version', async t => {
  const h = fixture(t);
  const resourcePath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { value: 'C:/murage-ci/resources', configurable: true });
  t.after(() => {
    if (resourcePath) Object.defineProperty(process, 'resourcesPath', resourcePath);
    else delete process.resourcesPath;
  });
  h.updater.downloadedUpdateHelper.downloadedFileInfo.isAdminRightsRequired = true;
  const paths = [];
  h.updater.spawnLog = async path => { paths.push(path); throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); };
  await h.coordinator.download(); await h.coordinator.install();
  await tick(); await tick();
  assert.deepEqual(paths, [join('C:/murage-ci/resources', 'elevate.exe')]);
  assert.equal(h.state().message, MESSAGE);
  assert.deepEqual(h.quits, []);
  assert.deepEqual(h.shellCalls, []);
  assert.equal(h.app.version, '1.0.18');
});

// Isolate process.platform and the native boundary in a disposable child. This
// executes the real spawnLog and windowsHide preload, without launching an exe.
test('real NSIS spawnLog reaches the native boundary hidden and fails closed on ENOENT', () => {
  const helper = new URL('../shared/win-hide-child-process.mjs', import.meta.url).href;
  const vendor = new URL('./vendor/electron-updater.cjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    Object.defineProperty(process, 'platform', {value:'win32'});
    let calls = 0;
    cp.ChildProcess.prototype.spawn = function(options) {
      calls++;
      assert.equal(options.windowsHide, true);
      assert.equal(options.file, 'C:/murage-ci/update.exe');
      throw Object.assign(new Error('spawn ENOENT'), {code:'ENOENT'});
    };
    await import(${JSON.stringify(helper)});
    const {NsisUpdater} = (await import(${JSON.stringify(vendor)})).default;
    const updater = new NsisUpdater(null, {version:'1.0.18', quit() {assert.fail('must stay open')}});
    updater.logger = {info(){},warn(){},error(){}};
    updater.downloadedUpdateHelper = {file:'C:/murage-ci/update.exe',downloadedFileInfo:{isAdminRightsRequired:false}};
    const errors = [];
    updater.on('error', e => errors.push(e));
    await updater.quitAndInstall(true, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls,1);
    assert.equal(errors.length,1);
    assert.equal(errors[0].message, ${JSON.stringify(MESSAGE)});
    assert.equal(errors[0].cause.code,'ENOENT');
    assert.equal(updater.quitAndInstallCalled,false);
    assert.equal(updater.currentVersion.version,'1.0.18');
    console.log('hidden-native-ENOENT-refused');
  `], { encoding:'utf8', windowsHide:true, timeout:15000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /hidden-native-ENOENT-refused/);
});
