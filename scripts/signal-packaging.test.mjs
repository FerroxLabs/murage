import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
import { configureSignalPackaging, assertNoSignalRuntime } from './signal-packaging.mjs';

const config = () => parse(readFileSync('electron-builder.yml', 'utf8'));
const runtime = row => /(?:^|\/)signal-runtime(?:\/|$)/.test(row.to ?? '');
it.each(['mac', 'win', 'linux'])('null G0 excludes every Signal copy from the effective %s packaging config, even stale staged inputs', platform => {
  const c = config(), original = structuredClone(c);
  const context = { packager: { config: c, platformSpecificBuildOptions: structuredClone(c[platform]) } };
  configureSignalPackaging(context, { g0: null });
  expect(c[platform].extraResources.filter(runtime)).toEqual([]);
  expect(c.extraResources.filter(runtime)).toEqual([]);
  expect(c.extraResources).toEqual(original.extraResources.filter(row => !runtime(row)));
  expect(context.packager.platformSpecificBuildOptions.extraResources.filter(runtime)).toEqual([]);
  expect(c[platform].extraResources).toEqual(original[platform].extraResources.filter(row => !runtime(row)));
  expect(c.beforePack).toBe('./scripts/signal-packaging.mjs');
});
it.each(['mac', 'win', 'linux'])('non-null G0 preserves all reviewed %s runtime copies', platform => {
  const c = config(), original = structuredClone(c);
  configureSignalPackaging({ packager: { config: c, platformSpecificBuildOptions: structuredClone(c[platform]) } }, { g0: {} });
  expect(c).toEqual(original);
  expect(c[platform].extraResources.some(runtime)).toBe(true);
});
it('rejects absent G0 instead of interpreting it as disabled', () => {
  expect(() => configureSignalPackaging({ packager: { config: config() } }, {})).toThrow(/g0/);
});
it('absence assertion accepts packages with no runtime and rejects directories and dangling links', () => {
  const root = mkdtempSync(join(tmpdir(), 'signal-off-package-'));
  try {
    expect(assertNoSignalRuntime(root)).toMatch(/Signal omitted/);
    expect(() => assertNoSignalRuntime(join(root, 'absent-app'))).toThrow();
    mkdirSync(join(root, 'signal-runtime'));
    expect(() => assertNoSignalRuntime(root)).toThrow(/signal-runtime/);
    safeWipeSync(join(root, 'signal-runtime'));
    mkdirSync(join(root, 'licenses', 'signal-runtime'), { recursive: true });
    expect(() => assertNoSignalRuntime(root)).toThrow(/signal-runtime/);
    safeWipeSync(join(root, 'licenses'));
    symlinkSync(join(root, 'absent'), join(root, 'signal-runtime'));
    expect(() => assertNoSignalRuntime(root)).toThrow(/signal-runtime/);
  } finally { safeWipeSync(root); }
});


// Exercise electron-builder's real resource matcher/copy path, including the
// Windows individual EXE copies. The fixture has no executable vendor bytes.
it.each(['mac', 'win', 'linux'])('actual %s resource copying excludes stale Signal bytes only for null G0', async platform => {
  const require = createRequire(import.meta.url);
  const builder = dirname(require.resolve('electron-builder/package.json'));
  const { getFileMatchers, copyFiles } = require(require.resolve('app-builder-lib/out/fileMatcher.js', { paths: [builder] }));
  const root = mkdtempSync(join(tmpdir(), 'signal-off-builder-'));
  try {
    const expand = value => value.replaceAll('${arch}', platform === 'mac' ? 'arm64' : 'x64');
    const original = config();
    original.extraResources = original.extraResources.filter(runtime);
    original[platform].extraResources = original[platform].extraResources.filter(runtime);
    for (const row of [...original.extraResources, ...original[platform].extraResources]) {
      const source = join(root, expand(row.from));
      if (source.endsWith('.exe')) { mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, 'fixture exe'); }
      else { mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'fixture.txt'), 'stale Signal bytes'); }
    }
    writeFileSync(join(root, 'keep.txt'), 'other resource');
    original.extraResources.push({ from: 'keep.txt', to: 'keep.txt' });
    for (const g0 of [null, { reviewed: true }]) {
      const c = structuredClone(original), resources = join(root, g0 === null ? 'off' : 'on');
      mkdirSync(resources);
      const effective = structuredClone(c[platform]);
      configureSignalPackaging({ packager: { config: c, platformSpecificBuildOptions: effective } }, { g0 });
      const matchers = getFileMatchers(c, 'extraResources', resources, { defaultSrc: root, globalOutDir: join(root, 'release'), macroExpander: expand, customBuildOptions: effective });
      await copyFiles(matchers);
      expect(readFileSync(join(resources, 'keep.txt'), 'utf8')).toBe('other resource');
      expect(existsSync(join(resources, 'signal-runtime'))).toBe(g0 !== null);
      expect(existsSync(join(resources, 'licenses/signal-runtime'))).toBe(g0 !== null);
      if (g0 === null) expect(assertNoSignalRuntime(resources)).toMatch(/Signal omitted/);
      if (platform === 'win') expect(existsSync(join(resources, 'signal-runtime/jre/bin/java.exe'))).toBe(g0 !== null);
    }
  } finally { safeWipeSync(root); }
});

// Use the hook selected by the real config, so this also runs on the rehearsal
// base where the Signal hook does not exist. Failure must be copied bytes.
it.each(['mac', 'win', 'linux'])('configured %s beforePack prevents baseline Signal resource copying with null G0', async platform => {
  const require = createRequire(import.meta.url);
  const builder = dirname(require.resolve('electron-builder/package.json'));
  const { getFileMatchers, copyFiles } = require(require.resolve('app-builder-lib/out/fileMatcher.js', { paths: [builder] }));
  const root = mkdtempSync(join(tmpdir(), 'signal-configured-hook-'));
  try {
    const c = config();
    const { default: hook } = await import(pathToFileURL(resolve(c.beforePack)).href);
    c.extraResources = c.extraResources.filter(runtime);
    c[platform].extraResources = c[platform].extraResources.filter(runtime);
    const expand = value => value.replaceAll('${arch}', platform === 'mac' ? 'arm64' : 'x64');
    for (const row of [...c.extraResources, ...c[platform].extraResources]) {
      const source = join(root, expand(row.from));
      if (source.endsWith('.exe')) { mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, 'fake exe'); }
      else { mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'fixture.txt'), 'fake staged Signal bytes'); }
    }
    const effective = structuredClone(c[platform]);
    await hook({ electronPlatformName: platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : 'linux', targets: [],
      packager: { config: c, platformSpecificBuildOptions: effective } });
    const resources = join(root, 'resources'); mkdirSync(resources);
    await copyFiles(getFileMatchers(c, 'extraResources', resources, { defaultSrc: root, globalOutDir: join(root, 'release'), macroExpander: expand, customBuildOptions: effective }));
    expect(existsSync(join(resources, 'signal-runtime')), 'baseline runtime bytes must be excluded').toBe(false);
    expect(existsSync(join(resources, 'licenses/signal-runtime')), 'baseline licence bytes must be excluded').toBe(false);
  } finally { safeWipeSync(root); }
});
