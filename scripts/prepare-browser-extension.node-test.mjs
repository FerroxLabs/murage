// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { build } from 'esbuild';
import { prepareBrowserExtension, parseReleaseConfig, prepareRegistration, preparationOptions } from './prepare-browser-extension.mjs';
import { FrameDecoder } from '../electron/browser-extension-host.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

test('release requires supplied exact IDs before producing files', async () => {
  assert.throws(() => parseReleaseConfig({ productionIds: [] }), /exact_production/);
  assert.throws(() => parseReleaseConfig({ productionIds: ['*'] }), /exact_production/);
  assert.throws(() => parseReleaseConfig({ productionIds: ['a'.repeat(32), 'a'.repeat(32)] }), /exact_production/);
  assert.deepEqual(parseReleaseConfig({ productionIds: ['a'.repeat(32)] }), { productionIds: ['a'.repeat(32)] });
  await assert.rejects(prepareBrowserExtension({ mode: 'release', outDir: path.join(root, 'dist-native/never-created-release') }), /release_config_required/);
});
test('registration plan requires explicit identity and embeds only config path', () => {
  const input = { mode: 'release', platform: 'darwin', browser: 'chrome', home: '/fixture', launcherPath: '/fixture/launcher', electronPath: '/fixture/Murage', hostScriptPath: '/fixture/native-host.mjs', configPath: '/fixture/current-broker.json' };
  assert.throws(() => prepareRegistration(input), /exact_extension/);
  const plan = prepareRegistration({ ...input, productionIds: ['a'.repeat(32)] });
  assert.deepEqual(plan.manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.match(plan.launcher, /ELECTRON_RUN_AS_NODE=1 exec/); assert.match(plan.launcher, /current-broker.json/);
  assert.match(plan.configLifecycle, /Restart requires/); assert.equal(plan.launcher.includes('token'), false);
});
test('packaging points at staged resources and preparation is in the build chain', async () => {
  const config = parse(await fs.readFile(path.join(root, 'electron-builder.yml'), 'utf8'));
  const resource = config.extraResources.find(resource => resource.to === 'browser-extension');
  assert.equal(resource.from, 'dist-native/browser-extension'); assert.ok(resource.filter.includes('!development-public-key.json'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['package:prepare'], /pnpm prepare:browser-extension/);
  assert.equal(pkg.scripts['prepare:browser-extension'], 'node scripts/prepare-browser-extension.mjs');
  assert.equal(preparationOptions([], {}).mode, 'resources');
  assert.equal(preparationOptions([], { MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG: '/fixture/release.json' }).mode, 'release');
});
test('real bundle runs independently, dev identity stays stable, resources mode strips dev identity', async () => {
  await fs.mkdir(path.join(root, 'dist-native'), { recursive: true });
  const outDir = await fs.mkdtemp(path.join(root, 'dist-native/browser-preparation-'));
  try {
    const first = await prepareBrowserExtension({ outDir, mode: 'development' });
    const next = await prepareBrowserExtension({ outDir, mode: 'development' }); assert.equal(next.developmentId, first.developmentId);
    assert.match(first.developmentId, /^[a-p]{32}$/);
    const publicConfig = JSON.parse(await fs.readFile(path.join(outDir, 'development-public-key.json'), 'utf8'));
    assert.deepEqual(Object.keys(publicConfig), ['publicKey']);
    assert.throws(() => parseReleaseConfig({ productionIds: ['a'.repeat(32)], publicKey: publicConfig.publicKey }), /production_key_id_mismatch/);
    const host = spawnSync(process.execPath, [path.join(outDir, 'native-host.mjs'), path.join(outDir, 'absent-config')], { env: {} });
    assert.equal(host.status, 0); assert.equal(host.stderr.length, 0);
    const messages = []; new FrameDecoder(message => messages.push(message)).push(host.stdout); assert.equal(messages[0].error.code, 'host_unavailable');
    const clientConfig = path.join(outDir, 'client.json'); await fs.chmod(outDir, 0o700);
    await fs.writeFile(clientConfig, JSON.stringify({ endpoint: 'http://127.0.0.1:54321/api/browser-extension/mcp', clientId: 'fixture', token: 'a'.repeat(43) }), { mode: 0o600 });
    const mcp = spawnSync(process.execPath, [path.join(outDir, 'browser-extension-mcp.mjs')], { env: { MURAGE_BROWSER_MCP_CONFIG: clientConfig }, input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', encoding: 'utf8' });
    assert.equal(mcp.status, 0, mcp.stderr); assert.equal(mcp.stderr, ''); assert.equal(JSON.parse(mcp.stdout).result.serverInfo.name, 'murage-browser');
    await fs.rm(clientConfig);
    const receipt = await prepareBrowserExtension({ outDir, mode: 'resources' });
    assert.equal(receipt.registered, false); assert.deepEqual(receipt.productionIds, []);
    const manifest = JSON.parse(await fs.readFile(path.join(receipt.extensionDir, 'manifest.json'), 'utf8')); assert.equal(manifest.key, undefined);
    const worker = await fs.readFile(path.join(receipt.extensionDir, 'service-worker.js'), 'utf8'); assert.equal(worker.includes('../../shared/'), false);
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
});

test('bundled library import never executes native host CLI', async () => {
  const outDir = await fs.mkdtemp(path.join(root, 'dist-native/browser-core-'));
  try {
    const output = path.join(outDir, 'probe.mjs');
    await build({ stdin: { contents: "import {FrameDecoder} from './electron/browser-extension-host.mjs'; new FrameDecoder(()=>{}); console.log('library-ok');", resolveDir: root }, bundle: true, format: 'esm', platform: 'node', outfile: output });
    const child = spawnSync(process.execPath, [output], { env: {}, encoding: 'utf8' });
    assert.equal(child.status, 0); assert.equal(child.stdout, 'library-ok\n'); assert.equal(child.stderr, '');
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
});

test('standard preparation CLI preserves explicitly supplied release identity', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'dist-native/browser-release-config-'));
  try {
    const config = path.join(directory, 'release.json');
    await fs.writeFile(config, JSON.stringify({ productionIds: ['a'.repeat(32)] }));
    const output = path.join(directory, 'output');
    const child = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-browser-extension.mjs'), '--out', output], {
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG: config }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(await fs.readFile(path.join(output, 'build.json'), 'utf8'));
    assert.equal(receipt.mode, 'release'); assert.deepEqual(receipt.productionIds, ['a'.repeat(32)]); assert.equal(receipt.registered, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a release build with the dashboard public key records its Chrome Web Store item for the listing link', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { extensionIdFromPublicKey } = await import('./browser-extension-release-config.mjs');
  const directory = await fs.mkdtemp(path.join(root, 'dist-native/browser-release-key-'));
  try {
    const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const id = extensionIdFromPublicKey(publicKey);
    const config = path.join(directory, 'release.json');
    await fs.writeFile(config, JSON.stringify({ productionIds: [id], publicKey }));
    const receipt = await prepareBrowserExtension({ mode: 'release', releaseConfigPath: config, outDir: path.join(directory, 'output') });
    assert.equal(receipt.chromeWebStoreId, id);
    assert.equal(receipt.developmentId, undefined);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'output', 'extension', 'manifest.json'), 'utf8'));
    assert.equal(manifest.key, publicKey);
    const built = JSON.parse(await fs.readFile(path.join(directory, 'output', 'build.json'), 'utf8'));
    assert.equal(built.chromeWebStoreId, id);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Chrome stable was 153 when 0.1.61 was built; the floor is stable minus two
// (plan L6), qualified on Chrome for Testing 151 and 153. Edge and Brave
// apply the same Chromium version floor.
test('the extension declares its qualified minimum Chrome version and the build keeps it', async () => {
  const source = JSON.parse(await fs.readFile(path.join(root, 'extensions/murage-browser/manifest.json'), 'utf8'));
  assert.equal(source.minimum_chrome_version, '151');
  const outDir = await fs.mkdtemp(path.join(root, 'dist-native/browser-minimum-'));
  try {
    await prepareBrowserExtension({ mode: 'resources', outDir });
    assert.equal(JSON.parse(await fs.readFile(path.join(outDir, 'extension', 'manifest.json'), 'utf8')).minimum_chrome_version, '151');
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
});
