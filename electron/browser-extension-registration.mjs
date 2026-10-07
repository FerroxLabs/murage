// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readHostConfig } from './browser-extension-host.mjs';
import { createWindowsBrowserLauncher, windowsRegistrationAdapter, readPrivateWindowsJson, writePrivateWindowsJson } from './browser-extension-windows.mjs';
import { registrationPlan, unixLauncher, installRegistration, removeRegistration, browserRegistrationFamily, sharedRegistrationBrowsers, browserInstallEvidence } from '../scripts/browser-extension-host-registration.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export class BrowserRegistrationError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserRegistrationError'; this.code = code; }
}
const fail = (code, message = 'Browser helper setup needs repair. No existing registration was adopted.') => { throw new BrowserRegistrationError(code, message); };
function input(options) {
  if (options.ownerConfirmed !== true) fail('owner_consent_required', 'Confirm browser helper setup in Murage first.');
  if (!['chrome', 'edge', 'brave', 'chromium'].includes(options.browser)) fail('invalid_browser');
  const platform = options.platform ?? process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) fail('unsupported_platform');
  const paths = platform === 'win32' ? path.win32 : path;
  for (const value of [options.registrationHome, options.configPath]) if (typeof value !== 'string' || !paths.isAbsolute(value) || /[\r\n\0]/.test(value)) fail('invalid_registration_paths');
  if (paths.basename(options.configPath) !== 'native-host.json') fail('stable_config_required', 'Start the browser broker with its stable native-host.json config first.');
  // The broker's config lives beside its socket in a short runtime folder
  // (/tmp on Mac and Linux) that the system empties at restart. The owned
  // launcher and receipt go in registrationDirectory, a private folder that
  // survives a restart, when the caller supplies one.
  if (options.registrationDirectory !== undefined && (typeof options.registrationDirectory !== 'string' || !paths.isAbsolute(options.registrationDirectory) || /[\r\n\0]/.test(options.registrationDirectory))) fail('invalid_registration_paths');
  // An AppImage runs from a mount that exists only while that copy of Murage
  // is open; Chrome must start the helper from the AppImage file itself.
  const appImage = options.appImage;
  if (appImage !== undefined && (platform !== 'linux' || typeof appImage !== 'string' || !path.isAbsolute(appImage) || /[\r\n\0]/.test(appImage) || /(?:^|\/)\.mount_/.test(appImage))) fail('invalid_registration_paths');
  const directory = options.registrationDirectory ?? paths.dirname(options.configPath), family = browserRegistrationFamily(options.browser, platform);
  const sharedBrowsers = sharedRegistrationBrowsers(options.browser, platform);
  return { platform, paths, directory, family, sharedBrowsers, appImage, receiptPath: paths.join(directory, `registration-${family}.json`), launcherPath: paths.join(directory, `browser-native-${family}${platform === 'win32' ? '.exe' : ''}`),
    // The AppImage copy of the bundled helper script, outside the mount.
    stableHostScriptPath: appImage ? paths.join(directory, `native-host-${family}.mjs`) : undefined };
}
/** Copies the bundled helper script out of the AppImage mount. An existing
 * copy is replaced only when its bytes are the ones the receipt recorded
 * (ownedHash); anything else is someone else's file and stays. */
async function stageAppImageHostScript(bytes, target, ownedHash) {
  const current = await existing(target);
  if (current && (!current.isFile() || current.isSymbolicLink() || !ownedHash || !await matches(target, ownedHash))) fail('registration_ownership_conflict');
  if (current && hash(bytes) === ownedHash) return;
  const temp = `${target}.${randomUUID()}.new`;
  await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, target); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
async function readReceipt(file, platform) {
  try {
    if (platform === 'win32') return readPrivateWindowsJson(file);
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid?.()) fail('unsafe_registration_receipt');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > 16384) fail('unsafe_registration_receipt');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function writeReceipt(file, value, platform) {
  if (platform === 'win32') return writePrivateWindowsJson(file, value);
  // Unique per write: a leftover from an interrupted write never blocks the next.
  const temp = `${file}.${randomUUID()}.new`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, file); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
async function existing(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; } }
async function matches(file, digest) {
  const stat = await existing(file); return Boolean(stat?.isFile() && !stat.isSymbolicLink() && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && stat.size <= 2 * 1024 * 1024 && hash(await fs.readFile(file)) === digest);
}
function receiptPlan(receipt, options, state) {
  if (receipt?.version !== 1 || receipt.browser !== state.family || receipt.platform !== state.platform || receipt.registrationHome !== options.registrationHome || receipt.launcherPath !== state.launcherPath || receipt.configPath !== options.configPath || receipt.manifest?.name !== 'com.murage.browser') fail('registration_ownership_conflict');
  const origins = receipt.manifest.allowed_origins;
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => typeof origin !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin))) fail('invalid_registration_receipt');
  const plan = registrationPlan({ platform: state.platform, browser: options.browser, home: options.registrationHome, hostName: receipt.manifest.name, launcherPath: state.launcherPath, manifestPath: state.paths.join(state.directory, `manifest-${state.family}.json`), productionIds: origins.map(origin => origin.slice(19, -1)) });
  if (plan.manifestPath !== receipt.manifestPath || JSON.stringify(plan.manifest) !== JSON.stringify(receipt.manifest)) fail('registration_ownership_conflict');
  return plan;
}
async function requireOwnedFiles(receipt, state, allowPendingMissingManifest = false) {
  // The AppImage helper copy: absent (not staged yet) or exactly what we wrote.
  if (receipt.hostScriptHash !== undefined && await existing(receipt.hostScriptPath) && !await matches(receipt.hostScriptPath, receipt.hostScriptHash)) fail('registration_ownership_conflict');
  const manifestOwned = await matches(receipt.manifestPath, receipt.manifestHash) || (allowPendingMissingManifest && receipt.status === 'pending' && !await existing(receipt.manifestPath));
  if (!await matches(receipt.launcherPath, receipt.launcherHash) || !manifestOwned || (state.platform === 'win32' && !await matches(`${receipt.launcherPath}.launch`, receipt.launchConfigHash))) fail('registration_ownership_conflict');
}
/** Owner route only. Explicit paths are mandatory; never called during startup. */
/** Check before write: a registry value that is not ours is a conflict found before any file exists. */
export async function assertRegistryFree(plan, adapter) {
  if (!plan.registry || !adapter?.read) return;
  const value = await adapter.read(plan.registry);
  if (value !== undefined && value !== plan.registry.value) fail('registration_ownership_conflict');
}
/** Only a browser the owner has (and has opened) gets a NativeMessagingHosts folder from Murage. */
export async function assertBrowserInstalled({ platform, browser, home }) {
  if (platform === 'win32') return;
  for (const folder of browserInstallEvidence({ platform, browser, home })) {
    try { await fs.lstat(folder); return; } catch (error) { if (error.code === 'ENOTDIR') return; /* a home that is not a folder fails later, as before */ }
  }
  fail('browser_not_installed', 'This browser has not been opened on this computer yet, so there is nothing to connect. Open it once, then try again.');
}
/** Take back only what a failed first Connect wrote, so nothing owned is left behind. */
export async function rollbackFailedInstall({ files, manifestPath, manifestText }) {
  for (const file of files) await fs.rm(file, { force: true }).catch(() => {});
  try { if (manifestPath && await fs.readFile(manifestPath, 'utf8') === manifestText) await fs.unlink(manifestPath); } catch { /* not ours or not there */ }
}
export async function connectOwnerBrowser(options) {
  const state = input(options);
  try {
    // Validates the active private config and its socket/Windows credential ACL.
    readHostConfig(options.configPath);
    for (const value of [options.resourcesPath, options.electronPath]) if (typeof value !== 'string' || !state.paths.isAbsolute(value)) fail('missing_browser_resources');
    const resources = state.paths.join(options.resourcesPath, 'browser-extension');
    const bundledHostScriptPath = state.paths.join(resources, 'native-host.mjs');
    for (const file of [options.electronPath, bundledHostScriptPath, ...(state.appImage ? [state.appImage] : [])]) if (!(await fs.stat(file)).isFile()) fail('missing_browser_resources');
    // From an AppImage, Chrome runs the AppImage file as Node with a copy of
    // the helper script kept beside the launcher; neither path is in the mount.
    const electronPath = state.appImage ?? options.electronPath;
    const hostScriptPath = state.stableHostScriptPath ?? bundledHostScriptPath;
    const metadata = JSON.parse(await fs.readFile(state.paths.join(resources, 'build.json'), 'utf8'));
    const development = metadata.mode === 'development';
    const ids = development ? [metadata.developmentId] : metadata.mode === 'release' ? metadata.productionIds : [];
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) || new Set(ids).size !== ids.length) fail('extension_identity_required', 'This build has no approved browser extension ID. Use a configured development or release build.');
    const plan = registrationPlan({ platform: state.platform, browser: options.browser, home: options.registrationHome, hostName: 'com.murage.browser', launcherPath: state.launcherPath, manifestPath: state.paths.join(state.directory, `manifest-${state.family}.json`), development, developmentIds: development ? ids : [], productionIds: development ? [] : ids });
    const launcher = state.platform === 'win32' ? undefined : unixLauncher({ electronPath, hostScriptPath, configPath: options.configPath, appImage: Boolean(state.appImage) });
    const manifestText = JSON.stringify(plan.manifest, null, 2) + '\n';
    const previous = await readReceipt(state.receiptPath, state.platform);
    if (previous) {
      receiptPlan(previous, options, state); await requireOwnedFiles(previous, state);
      if (previous.status !== 'installed' || previous.manifestHash !== hash(manifestText) || previous.electronPath !== electronPath || previous.hostScriptPath !== hostScriptPath || (launcher && previous.launcherHash !== hash(launcher))) fail('registration_repair_required', 'Remove this owned helper registration, then Connect again to use the new build.');
      // An updated AppImage keeps its file path; its helper script may change.
      if (state.stableHostScriptPath) {
        const bytes = await fs.readFile(bundledHostScriptPath);
        await stageAppImageHostScript(bytes, hostScriptPath, previous.hostScriptHash);
        if (previous.hostScriptHash !== hash(bytes)) await writeReceipt(state.receiptPath, { ...previous, hostScriptHash: hash(bytes) }, state.platform);
      }
      return { status: 'installed', browser: options.browser, registrationFamily: state.family, sharedBrowsers: state.sharedBrowsers, manifestPath: plan.manifestPath, receiptPath: state.receiptPath, connected: false };
    }
    if (await existing(state.launcherPath) || await existing(plan.manifestPath) || await existing(`${state.launcherPath}.launch`)) fail('registration_ownership_conflict');
    const registryAdapter = state.platform === 'win32' ? (options.registryAdapter ?? windowsRegistrationAdapter(options.browser)) : undefined;
    await assertRegistryFree(plan, registryAdapter);
    await assertBrowserInstalled({ platform: state.platform, browser: options.browser, home: options.registrationHome });
    const hostScriptBytes = state.stableHostScriptPath ? await fs.readFile(bundledHostScriptPath) : undefined;
    if (hostScriptBytes && await existing(hostScriptPath)) fail('registration_ownership_conflict');
    const written = [state.launcherPath, ...(state.platform === 'win32' ? [`${state.launcherPath}.launch`] : []), state.receiptPath, ...(hostScriptBytes ? [hostScriptPath] : [])];
    try {
    if (state.platform === 'win32') createWindowsBrowserLauncher({ launcherPath: state.launcherPath, electronPath: options.electronPath, hostScriptPath, configPath: options.configPath });
    else await fs.writeFile(state.launcherPath, launcher, { mode: 0o700, flag: 'wx' });
    const receipt = { version: 1, status: 'pending', browser: state.family, platform: state.platform, registrationHome: options.registrationHome, configPath: options.configPath, electronPath, hostScriptPath, launcherPath: state.launcherPath, ...(hostScriptBytes ? { hostScriptHash: hash(hostScriptBytes) } : {}), manifestPath: plan.manifestPath, manifest: plan.manifest, manifestHash: hash(manifestText), launcherHash: hash(await fs.readFile(state.launcherPath)), ...(state.platform === 'win32' ? { launchConfigHash: hash(await fs.readFile(`${state.launcherPath}.launch`)) } : {}) };
    await writeReceipt(state.receiptPath, receipt, state.platform);
    if (hostScriptBytes) await stageAppImageHostScript(hostScriptBytes, hostScriptPath, undefined);
    await installRegistration(plan, state.platform === 'win32' ? { registryAdapter } : {});
    await writeReceipt(state.receiptPath, { ...receipt, status: 'installed' }, state.platform);
    } catch (error) { if (state.platform === 'win32') await rollbackFailedInstall({ files: written, manifestPath: plan.manifestPath, manifestText }); throw error; }
    return { status: 'installed', browser: options.browser, registrationFamily: state.family, sharedBrowsers: state.sharedBrowsers, manifestPath: plan.manifestPath, receiptPath: state.receiptPath, connected: false };
  } catch (error) { if (error instanceof BrowserRegistrationError) throw error; fail('browser_registration_unavailable', 'Browser helper setup could not finish. Check the helper resources and owned registration.'); }
}
export async function removeOwnerBrowser(options) {
  const state = input(options);
  try {
    const receipt = await readReceipt(state.receiptPath, state.platform);
    if (!receipt) return { status: 'not_registered', registrationFamily: state.family, sharedBrowsers: state.sharedBrowsers };
    const plan = receiptPlan(receipt, options, state); await requireOwnedFiles(receipt, state, true);
    // Remove works while a foreign registry value exists: that value is left alone, what Murage wrote goes.
    const adapter = state.platform === 'win32' ? (options.registryAdapter ?? windowsRegistrationAdapter(options.browser)) : undefined;
    const lenient = adapter && { ...adapter, removeIfEqual: async (registry, manifest) => { const value = await adapter.read?.(registry); if (value !== undefined && value !== registry.value) return; return adapter.removeIfEqual(registry, manifest); } };
    if (await existing(plan.manifestPath)) await removeRegistration(plan, lenient ? { registryAdapter: lenient } : {});
    await fs.unlink(state.launcherPath);
    if (state.platform === 'win32') await fs.unlink(`${state.launcherPath}.launch`);
    // The AppImage helper script copy, only at the one name this module uses.
    const copy = state.paths.join(state.directory, `native-host-${state.family}.mjs`);
    if (receipt.hostScriptPath === copy) await fs.rm(copy, { force: true });
    await fs.unlink(state.receiptPath);
    return { status: 'removed', registrationFamily: state.family, sharedBrowsers: state.sharedBrowsers };
  } catch (error) { if (error instanceof BrowserRegistrationError) throw error; fail('browser_registration_unavailable', 'Browser helper removal needs repair. Changed files were preserved.'); }
}
