// Synthetic staging and actual production boot wiring; no live Signal account.
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { cpSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import { parse } from 'yaml';
import { makeSyntheticRuntime } from './fixtures/signal-test-runtime.mjs';
import { stageRuntime } from './stage-signal-runtime.mjs';
import { bootSignalRuntime } from '../server/channels/signal/boot.ts';
import { SIGNAL_RUNTIME_RESOURCE, SIGNAL_FIXTURE_SOURCE, signalFixtureDir, signalRuntimeDir } from '../server/channels/signal/runtime-paths.mjs';
vi.mock('node:crypto', async original => { const mod = await original(); return { ...mod, createHash: vi.fn(mod.createHash) }; });
const roots = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() { const f = makeSyntheticRuntime(); roots.push(f.root); return f; }
const modes = (root, pin) => ({
 packaged: { pin, resourcesPath: join(root, 'resources'), moduleUrl: pathToFileURL(join(root, 'app/server/index.js')).href, platform: 'linux', arch: 'x64' },
 bundled: { pin, moduleUrl: pathToFileURL(join(root, 'app/server/index.js')).href, platform: 'linux', arch: 'x64' },
 native: { pin, moduleUrl: pathToFileURL(join(root, 'app/server/index.ts')).href, platform: 'linux', arch: 'x64' },
});
test.each(['packaged', 'bundled', 'native'])('T-PATH-CONTRACT: staged evidence activates only its own %s location', async mode => {
 const f = fixture(), options = modes(f.root, f.pin), selected = options[mode];
 const expected = mode === 'packaged' ? join(f.root, 'resources/signal-runtime') : mode === 'bundled' ? join(f.root, 'app/signal-runtime') : join(f.root, 'app/dist-native/signal-runtime/linux-x64');
 expect(signalRuntimeDir(selected)).toBe(expected);
 await stageRuntime({ ...f, destination: expected, host: { platform: 'linux', arch: 'x64' } });
 const boot = bootSignalRuntime(selected);
 expect(boot.runtimeDir).toBe(expected); expect(boot.fixtureDir).toBe(join(expected, 'g0')); expect(signalFixtureDir(expected)).toBe(boot.fixtureDir);
 expect(boot.adapters.verified).toBe(true); expect(boot.adapters.linkProtocol.unlink).toBeDefined();
 for (const [other, paths] of Object.entries(options)) if (other !== mode) expect(bootSignalRuntime(paths).adapters.verified).toBe(false);
 renameSync(boot.fixtureDir, join(f.root, 'misplaced-evidence'));
 cpSync(join(f.root, 'misplaced-evidence'), join(expected, 'fixtures/g0'), { recursive: true });
 expect(bootSignalRuntime(selected).adapters.verified).toBe(false);
});
test('T-PATH-CONTRACT: packager and bundled mode use the shared resource', () => {
 expect(signalRuntimeDir({ moduleUrl: 'file:///X/server/index.js' })).toBe('/X/signal-runtime');
 const config = parse(readFileSync('electron-builder.yml', 'utf8'));
 const found = [];
 const walk = value => { if (!value || typeof value !== 'object') return;
  if (typeof value.from === 'string' && value.from.startsWith('dist-native/signal-runtime/')) {
   const [target, ...parts] = value.from.slice('dist-native/signal-runtime/'.length).split('/');
   // Windows copies upstream EXEs individually to preserve their signatures.
   expect(value.to).toBe([SIGNAL_RUNTIME_RESOURCE, ...parts].join('/'));
   if (!parts.length) found.push(target.replace('${arch}', 'arm64'));
  }
  Object.values(value).forEach(walk);
 };
 expect(config.mac.target.some(target => target.arch.includes('arm64'))).toBe(true);
 walk(config); expect(found.sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
});
const production = () => readFileSync('server/index.ts', 'utf8');
test('T-PATH-CONTRACT: index calls exactly the specified boot entry and uses its runtime for host verification', () => {
 const source = production();
 const expected = `bootSignalRuntime({ pin: signalRuntimePin as unknown as RuntimePin, moduleUrl: import.meta.url,
  resourcesPath: process.env.MURAGE_RESOURCES_PATH ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  platform: process.platform, arch: process.arch })`;
 expect(source.match(/bootSignalRuntime\(/g)).toHaveLength(1);
 expect(source.replace(/\s+/g, '')).toContain(expected.replace(/\s+/g, ''));
 expect(source).not.toMatch(/loadSignalAdapters\(|signalRuntimeDir\(|["']signal-runtime["']/);
 expect(source).toContain('const runtimeDir = signalBoot.runtimeDir;');
});
test('T-PATH-CONTRACT: production consumers have no second spelling', () => {
 const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(row => row.isDirectory() ? walk(join(root, row.name)) : [join(root, row.name)]);
 for (const file of [...walk('server'), ...walk('scripts')].filter(file => /\.(?:ts|mjs)$/.test(file) && !/test|fixtures\//.test(file) && !file.endsWith('runtime-paths.mjs'))) {
  const source = readFileSync(file, 'utf8');
  expect(source, file).not.toMatch(/["']fixtures\/g0["']|join\([^\n]*["']signal-runtime["']|["']g0["']/);
  expect(source, file).not.toContain('"' + SIGNAL_FIXTURE_SOURCE + '"');
 }
});
test('T-ENABLED-CACHED: valid evidence activates and subsequent production checks hash zero fixtures', async () => {
 const f = fixture(), options = modes(f.root, f.pin).packaged;
 await stageRuntime({ ...f, destination: signalRuntimeDir(options), host: { platform: 'linux', arch: 'x64' } });
 const signalBoot = bootSignalRuntime(options); expect(signalBoot.adapters.verified).toBe(true);
 const fn = production().match(/function signalEnabled\(\) \{[\s\S]*?\n\}/)[0];
 const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
 const enabled = new Function('signalBoot', 'signalRuntimePin', 'isCloudHome', `${js}; return signalEnabled;`)(signalBoot, f.pin, () => false);
 expect(crypto.createHash.mock.calls.length).toBeGreaterThan(0); crypto.createHash.mockClear();
 for (let i = 0; i < 10; i++) expect(enabled()).toBe(true);
 expect(crypto.createHash).not.toHaveBeenCalled();
 const closed = new Function('signalBoot', 'signalRuntimePin', 'isCloudHome', `${js}; return signalEnabled;`)({ adapters: { verified: false } }, f.pin, () => false);
 expect(closed()).toBe(false);
});
