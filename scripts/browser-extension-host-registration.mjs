// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';

const browserPaths = {
  darwin: { chrome: 'Library/Application Support/Google/Chrome/NativeMessagingHosts', edge: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', brave: 'Library/Application Support/Google/Chrome/NativeMessagingHosts', chromium: 'Library/Application Support/Chromium/NativeMessagingHosts' },
  linux: { chrome: '.config/google-chrome/NativeMessagingHosts', edge: '.config/microsoft-edge/NativeMessagingHosts', brave: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts', chromium: '.config/chromium/NativeMessagingHosts' },
};
// The browser's own user-data folder: proof it is installed (and has been opened), so Connect never creates
// NativeMessagingHosts folders for a browser the owner does not have. Mac Brave also reads Chrome's folder.
const installEvidence = {
  darwin: { chrome: ['Library/Application Support/Google/Chrome'], edge: ['Library/Application Support/Microsoft Edge'], brave: ['Library/Application Support/BraveSoftware/Brave-Browser', 'Library/Application Support/Google/Chrome'], chromium: ['Library/Application Support/Chromium'] },
  linux: { chrome: ['.config/google-chrome'], edge: ['.config/microsoft-edge'], brave: ['.config/BraveSoftware/Brave-Browser'], chromium: ['.config/chromium'] },
};
export function browserInstallEvidence({ platform, browser, home }) {
  const list = installEvidence[platform]?.[browser];
  if (!list || !path.isAbsolute(home)) throw Error('invalid_registration_target');
  return list.map(relative => path.join(home, relative));
}
const registryPaths = { chrome: 'Google\\Chrome', chromium: 'Chromium', edge: 'Microsoft\\Edge', brave: 'Chromium' };
// Brave 1.96.59 app/brave_main_delegate.cc redirects macOS native lookup to Chrome.
// Windows uses Chromium's first native-host lookup, then Chrome fallback.
export function browserRegistrationFamily(browser, platform) {
  if (browser === 'brave') return platform === 'darwin' ? 'chrome' : platform === 'win32' ? 'chromium' : browser;
  return browser;
}
/** Browsers that share one native-host registration with this one: Mac Brave
 * reads Chrome's folder, Windows Brave reads Chromium's registry key. */
export function sharedRegistrationBrowsers(browser, platform = process.platform) {
  const family = browserRegistrationFamily(browser, platform);
  return platform === 'win32' && family === 'chromium' ? ['brave', 'chromium'] : platform === 'darwin' && family === 'chrome' ? ['brave', 'chrome'] : [browser];
}
export function registrationPlan({ platform, browser, home, hostName, launcherPath, manifestPath, productionIds = [], developmentIds = [], development = false }) {
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(hostName)) throw Error('invalid_host_name');
  const paths = platform === 'win32' ? path.win32 : path;
  if (!paths.isAbsolute(launcherPath)) throw Error('absolute_launcher_required');
  const ids = development ? developmentIds : productionIds;
  if (!ids.length || ids.some(id => !/^[a-p]{32}$/.test(id)) || new Set(ids).size !== ids.length) throw Error('exact_extension_ids_required');
  if (productionIds.some(id => developmentIds.includes(id))) throw Error('development_production_ids_overlap');
  const manifest = { name: hostName, description: 'Murage browser connection', path: launcherPath, type: 'stdio', allowed_origins: ids.map(id => `chrome-extension://${id}/`) };
  if (platform === 'win32') {
    if (!registryPaths[browser] || !paths.isAbsolute(manifestPath ?? '')) throw Error('invalid_registration_target');
    return { manifest, manifestPath, registry: { key: `HKCU\\Software\\${registryPaths[browser]}\\NativeMessagingHosts\\${hostName}`, value: manifestPath }, nativeLauncherRequired: true };
  }
  const relative = browserPaths[platform]?.[browser];
  if (!relative || !path.isAbsolute(home)) throw Error('invalid_registration_target');
  return { manifest, manifestPath: path.join(home, relative, `${hostName}.json`) };
}
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
// electronPath is the AppImage file itself when appImage is set. Its AppRun
// puts --no-sandbox first unless an argument already is --no-sandbox, and
// Electron-as-Node refuses an option before the script, so the flag goes last
// (as the closed-app backup trigger does, backup-closed-profile.mjs).
export function unixLauncher({ electronPath, hostScriptPath, configPath, appImage = false }) {
  for (const value of [electronPath, hostScriptPath, configPath]) if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw Error('invalid_launcher_path');
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(electronPath)} ${shellQuote(hostScriptPath)} ${shellQuote(configPath)} "$@"${appImage ? ' --no-sandbox' : ''}\n`;
}
/** Caller supplies explicit paths. No implicit real home or registry mutation. */
export async function installRegistration(plan, { registryAdapter } = {}) {
  if (plan.registry && !registryAdapter) throw Error('windows_registry_adapter_required');
  if (plan.registry) registryAdapter.validate?.(plan.registry, plan.manifest);
  await fs.mkdir(path.dirname(plan.manifestPath), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(plan.manifest, null, 2) + '\n';
  try { await fs.writeFile(plan.manifestPath, content, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await fs.lstat(plan.manifestPath)).isFile() || await fs.readFile(plan.manifestPath, 'utf8') !== content) throw Error('registration_ownership_conflict');
  }
  if (plan.registry) await registryAdapter.installIfAbsentOrEqual(plan.registry, plan.manifest);
  return plan.manifestPath;
}
export async function removeRegistration(plan, { registryAdapter } = {}) {
  const expected = JSON.stringify(plan.manifest, null, 2) + '\n';
  let actual;
  try { if (!(await fs.lstat(plan.manifestPath)).isFile()) throw Error('registration_ownership_conflict'); actual = await fs.readFile(plan.manifestPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (actual !== expected) throw Error('registration_ownership_conflict');
  if (plan.registry) {
    if (!registryAdapter) throw Error('windows_registry_adapter_required');
    await registryAdapter.removeIfEqual(plan.registry, plan.manifest);
  }
  await fs.unlink(plan.manifestPath); return true;
}
