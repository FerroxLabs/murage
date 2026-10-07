// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { registrationPlan, unixLauncher } from './browser-extension-host-registration.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
import { extensionIdFromPublicKey, parseReleaseConfig } from './browser-extension-release-config.mjs';
export { extensionIdFromPublicKey, parseReleaseConfig };
/** Produces an in-memory installation plan only; does not register a browser. */
export function prepareRegistration({ mode, productionIds = [], developmentId, platform, browser, home, launcherPath, manifestPath, electronPath, hostScriptPath, configPath }) {
  if (!['development', 'release'].includes(mode)) throw Error('explicit_registration_mode_required');
  const plan = registrationPlan({ platform, browser, home, hostName: 'com.murage.browser', launcherPath, manifestPath, development: mode === 'development', developmentIds: developmentId ? [developmentId] : [], productionIds });
  return { ...plan, ...(platform === 'win32' ? { blocker: 'Native helper build and Windows launcher/current-user pipe ACL qualification are required.' } : { launcher: unixLauncher({ electronPath, hostScriptPath, configPath }) }), configLifecycle: path.basename(configPath) === 'native-host.json' ? 'Stable alias supports clean restart; an occupied crash-stale alias requires explicit repair.' : 'The configPath is instance-specific. Restart requires a newly prepared launcher.' };
}
export async function prepareBrowserExtension({ root = projectRoot, outDir = path.join(root, 'dist-native/browser-extension'), mode = 'resources', releaseConfigPath, buildImpl = build } = {}) {
  if (!['resources', 'development', 'release'].includes(mode)) throw Error('invalid_build_mode');
  if (!path.isAbsolute(root) || !path.isAbsolute(outDir)) throw Error('absolute_build_paths_required');
  let productionIds = [], publicKey, developmentId;
  // Fail before output changes when a release identity has not been supplied.
  if (mode === 'release') {
    if (!releaseConfigPath || !path.isAbsolute(releaseConfigPath)) throw Error('release_config_required');
    ({ productionIds, publicKey } = parseReleaseConfig(JSON.parse(await fs.readFile(releaseConfigPath, 'utf8'))));
  }
  await fs.mkdir(outDir, { recursive: true });
  if (mode === 'development') {
    const keyPath = path.join(outDir, 'development-public-key.json');
    try { publicKey = JSON.parse(await fs.readFile(keyPath, 'utf8')).publicKey; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Private key is transient and discarded; unpacked identity needs public DER only.
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      await fs.writeFile(keyPath, JSON.stringify({ publicKey }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    developmentId = extensionIdFromPublicKey(publicKey);
  }
  const extensionDir = path.join(outDir, 'extension'); await fs.mkdir(extensionDir, { recursive: true });
  const source = path.join(root, 'extensions/murage-browser');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  delete manifest.key;
  if (publicKey) manifest.key = publicKey;
  await buildImpl({ entryPoints: [path.join(source, 'service-worker.mjs')], outfile: path.join(extensionDir, 'service-worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: 'silent' });
  await fs.writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.cp(path.join(source, 'icons'), path.join(extensionDir, 'icons'), { recursive: true });
  await fs.cp(path.join(source, 'sidepanel'), path.join(extensionDir, 'sidepanel'), { recursive: true });
  // The manifest's default_locale and __MSG_ names resolve here; without it Chrome refuses to load the extension.
  await fs.cp(path.join(source, '_locales'), path.join(extensionDir, '_locales'), { recursive: true });
  await buildImpl({
    entryPoints: { 'native-host': path.join(root, 'electron/browser-extension-host-entry.mjs'), 'browser-extension-mcp': path.join(root, 'server/drivers/browser-extension-mcp.ts'), registration: path.join(root, 'scripts/browser-extension-host-registration.mjs') },
    outdir: outDir, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent',
    banner: { js: 'import { createRequire as __browserRequire } from "node:module"; const require = __browserRequire(import.meta.url);' },
  });
  // The store item is the release ID whose key the dashboard gave; the app
  // links its listing only from this trusted value (browser-extension-listing.ts).
  const chromeWebStoreId = mode === 'release' && publicKey ? extensionIdFromPublicKey(publicKey) : undefined;
  const receipt = { version: 1, mode, extensionVersion: manifest.version, productionIds, ...(chromeWebStoreId ? { chromeWebStoreId } : {}), ...(developmentId ? { developmentId } : {}), registered: false, packagedNativeQualified: false, resources: ['native-host.mjs', 'browser-extension-mcp.mjs', 'registration.mjs', 'extension'] };
  await fs.writeFile(path.join(outDir, 'build.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { ...receipt, outDir, extensionDir };
}
export function preparationOptions(args, env = {}) {
  const options = env.MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG
    ? { mode: 'release', releaseConfigPath: env.MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG }
    : { mode: 'resources' };
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; const value = args[++index];
    if (!value || !['--mode', '--release-config', '--out'].includes(key)) throw Error('Usage: --mode resources|development|release [--release-config absolute.json] [--out absolute-directory]');
    options[key === '--mode' ? 'mode' : key === '--out' ? 'outDir' : 'releaseConfigPath'] = value;
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await prepareBrowserExtension(preparationOptions(process.argv.slice(2), process.env));
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
