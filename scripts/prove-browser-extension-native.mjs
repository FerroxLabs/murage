// SPDX-License-Identifier: AGPL-3.0-or-later
// Real production connectNative transport, temporary Chromium registration only.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import electron from 'electron';
import { prepareBrowserExtension } from './prepare-browser-extension.mjs';
import { unixLauncher } from './browser-extension-host-registration.mjs';
import { startBrowserExtensionBroker } from '../server/browser-extension-broker.ts';
import { createBrowserExtensionService } from '../server/browser-extension-service.ts';
// The extension declares minimum_chrome_version; Playwright's bundled Chromium
// can be older. MURAGE_PROVE_BROWSER_EXECUTABLE names an existing read-only
// Chromium or Chrome for Testing binary to prove against instead.
const proveBrowser = () => process.env.MURAGE_PROVE_BROWSER_EXECUTABLE ? { executablePath: process.env.MURAGE_PROVE_BROWSER_EXECUTABLE } : { channel: 'chromium' };

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts/browser-extension'); await fs.mkdir(artifacts, { recursive: true });
const run = await fs.mkdtemp(path.join(artifacts, 'native-'));
const stateDir = await fs.mkdtemp('/Volumes/Scratch/bxn-'); await fs.chmod(stateDir, 0o700);
const profile = path.join(run, 'profile'), fixtureHome = path.join(run, 'home'), temporary = path.join(run, 'tmp');
for (const directory of [profile, fixtureHome, temporary]) await fs.mkdir(directory, { mode: 0o700 });
const checks = [], eventErrors = []; let nativeDiagnostic;
const source = 'https://chromium.googlesource.com/chromium/src/+/refs/tags/143.0.7499.147/chrome/common/chrome_paths.cc';
await fs.writeFile(path.join(run, 'fixture-contract.json'), JSON.stringify({
  lookupEvidence: { source, lines: '488-493', rule: 'DIR_USER_NATIVE_MESSAGING is DIR_USER_DATA/NativeMessagingHosts' },
  preconditions: ['Fresh task-owned Mando userDataDir and browser HOME', 'Only profile/NativeMessagingHosts registration', 'Production worker connectNative unchanged', 'Private real Unix broker credential', 'Electron-as-Node native host', 'No external accounts or model providers'],
  operation: 'real hello, service binding, semantic navigation to loopback page, snapshot, Stop over native port',
  expected: 'Native hello proves lookup/launcher/auth framing; page text returns through native host; Stop blocks further dispatch',
  excluded: ['Branded Chrome/Edge/Brave', 'Windows', 'Installed Murage artifact', 'App approval-card HTTP route', 'Automatic private input pause'],
}, null, 2));
let context, broker, service, web, browserVersion;
let closing = false;
let status = 'FAIL', failure;
try {
  const build = await prepareBrowserExtension({ outDir: path.join(run, 'bundle'), mode: 'development' });
  broker = await startBrowserExtensionBroker({ stateDir, onMessage: (profileId, message) => { if (service && !closing) void service.handleMessage(profileId, message).catch(error => { eventErrors.push(String(error.message)); }); } });
  service = await createBrowserExtensionService({ broker, workspaceId: 'native_fixture', stateFile: path.join(stateDir, 'service.json'), askSite: async () => 'allow', askAction: async () => true });
  const launcherPath = path.join(run, 'native-host-launcher');
  const marker = path.join(run, 'launcher-invoked.txt');
  const launcher = unixLauncher({ electronPath: electron, hostScriptPath: path.join(build.outDir, 'native-host.mjs'), configPath: broker.configPath }).replace('#!/bin/sh\n', `#!/bin/sh\nexec 2> '${path.join(run, 'native-stderr.log')}'\nprintf '%s\\n' invoked >> '${marker}'\n`);
  await fs.writeFile(launcherPath, launcher, { mode: 0o700 });
  await fs.writeFile(path.join(run, 'launcher-evidence.json'), JSON.stringify({ text: launcher, mode: ((await fs.stat(launcherPath)).mode & 0o777).toString(8), electron }, null, 2));
  const registrationDir = path.join(profile, 'NativeMessagingHosts'); await fs.mkdir(registrationDir, { mode: 0o700 });
  const manifestPath = path.join(registrationDir, 'com.murage.browser.json');
  assert.ok(manifestPath.startsWith(profile + path.sep));
  await fs.writeFile(manifestPath, JSON.stringify({ name: 'com.murage.browser', description: 'Task-owned native integration fixture', path: launcherPath, type: 'stdio', allowed_origins: [`chrome-extension://${build.developmentId}/`] }), { flag: 'wx', mode: 0o600 });
  checks.push('registration_written_only_inside_fresh_user_data_dir');
  web = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><title>Native transport fixture</title><h1>Native transport fixture</h1><p>Local page, no account or provider.</p></html>'); });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${web.address().port}/`;
  context = await chromium.launchPersistentContext(profile, { ...proveBrowser(), headless: true, env: { HOME: fixtureHome, TMPDIR: temporary, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, args: ['--enable-logging', `--log-file=${path.join(run, 'chromium.log')}`, '--vmodule=native_message*=2,native_process*=2', `--disable-extensions-except=${build.extensionDir}`, `--load-extension=${build.extensionDir}`] });
  context.setDefaultTimeout(15000); browserVersion = context.browser().version();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).host, build.developmentId);
  const until = async (predicate, label) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(label); };
  try { await until(() => broker.profiles().length === 1, 'native_hello_not_received'); }
  catch (error) {
    nativeDiagnostic = await worker.evaluate(() => new Promise(resolve => {
      const diagnostic = chrome.runtime.connectNative('com.murage.browser');
      diagnostic.onDisconnect.addListener(() => resolve({ error: chrome.runtime.lastError?.message ?? 'disconnected' }));
      diagnostic.onMessage.addListener(message => { resolve({ messageType: message.type, code: message.error?.code }); diagnostic.disconnect(); });
      setTimeout(() => { resolve({ error: 'diagnostic_timeout' }); diagnostic.disconnect(); }, 3000);
    }));
    try { nativeDiagnostic.launcherInvoked = (await fs.readFile(marker, 'utf8')).includes('invoked'); } catch { nativeDiagnostic.launcherInvoked = false; }
    throw error;
  }
  checks.push('production_connectNative_lookup_Electron_launcher_mutual_auth_and_hello');
  const profileId = broker.profiles()[0].profileId;
  const binding = await service.ensureBinding({ botId: 'fixture_bot', threadId: 'fixture_thread', profileId }); checks.push('service_binding_created_through_native_port');
  await service.dispatch(binding.bindingId, 'agent_browser_open', { url }, () => true);
  await until(() => context.pages().some(page => page.url() === url), 'native_navigation_not_observed');
  const page = context.pages().find(page => page.url() === url); await page.waitForLoadState('load');
  checks.push('semantic_navigation_through_native_port');
  const snapshot = await service.dispatch(binding.bindingId, 'agent_browser_snapshot', {}, () => true);
  assert.ok(JSON.stringify(snapshot).includes('Native transport fixture'));
  checks.push('semantic_snapshot_roundtrip_through_native_port');
  await page.screenshot({ path: path.join(run, 'native-controlled-page.png') });
  await service.stop(binding.bindingId);
  await assert.rejects(() => service.dispatch(binding.bindingId, 'agent_browser_snapshot', {}, () => true), /binding_inactive/);
  const current = service.status().bindings.find(entry => entry.bindingId === binding.bindingId);
  const stopped = await broker.request(profileId, { version: 1, type: 'command', id: randomUUID(), bindingId: binding.bindingId, generation: current.generation, operation: 'status', params: {} });
  assert.equal(stopped.result.state, 'stopped');
  checks.push('native_Stop_persists_and_service_refuses_further_observation');
  status = 'PASS';
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  closing = true;
  await context?.close();
  await broker?.close();
  if (web) await new Promise(resolve => web.close(resolve));
  // Preserve bundle, contract and screenshots; remove only task-owned credentials/profile.
  for (const directory of [profile, fixtureHome, temporary, stateDir]) await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(path.join(run, 'native-host-launcher'), { force: true });
  const sourceHash = createHash('sha256').update(await fs.readFile(path.join(root, 'extensions/murage-browser/runtime.mjs'))).digest('hex');
  await fs.writeFile(path.join(run, 'receipt.json'), JSON.stringify({ status, nativeDiagnostic, browserVersion, platform: process.platform, checks, eventErrors, failure, runtimeSha256: sourceHash, nativeLookupSource: source, cleanup: 'Removed task-owned profile/registration, HOME, temp, launcher and credential/socket directory', limitations: ['Playwright Chromium/Chrome for Testing, not branded browser qualification', 'Development Electron executable, not installed Murage artifact', 'Site/action owner decisions are deterministic fixture callbacks; app approval-card route excluded', 'No Windows or Linux native qualification'] }, null, 2));
  process.stdout.write(JSON.stringify({ status, nativeDiagnostic, checks, eventErrors, failure: failure?.message, receipt: path.join(run, 'receipt.json') }, null, 2) + '\n');
  if (status !== 'PASS') process.exitCode = 1;
}
