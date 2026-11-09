// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const json = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const lock = path => parse(readFileSync(resolve(path), 'utf8'));
const root = lock('pnpm-lock.yaml');

it('patches Zod in both standalone runtime manifests and locks', () => {
  const relay = lock('cloudflare/push-relay/pnpm-lock.yaml');
  expect(json('cloudflare/push-relay/package.json').dependencies.zod).toBe('4.6.7');
  expect(relay.importers['.'].dependencies.zod).toEqual({ specifier: '4.6.7', version: '4.6.7' });
  expect(Object.keys(relay.packages).filter(key => key.startsWith('zod@'))).toEqual(['zod@4.6.7']);
  expect(relay.packages['zod@4.6.7']).toEqual(root.packages['zod@4.6.7']);
  const portal = json('cloud-portal/package-lock.json');
  expect(json('cloud-portal/package.json').devDependencies.zod).toBe('4.6.7');
  expect(portal.packages[''].devDependencies.zod).toBe('4.6.7');
  expect(portal.packages['node_modules/zod']).toMatchObject({ version: '4.6.7',
    resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz', integrity: root.packages['zod@4.6.7'].resolution.integrity });
});

it.each(['apps/mobile', 'cloudflare/push-relay'])('patches the complete standalone Vitest family in %s', dir => {
  const data = lock(`${dir}/pnpm-lock.yaml`);
  expect(json(`${dir}/package.json`).devDependencies.vitest).toBe('4.1.12');
  expect(data.importers['.'].devDependencies.vitest.specifier).toBe('4.1.12');
  expect(data.importers['.'].devDependencies.vitest.version).toMatch(/^4\.1\.12\(/);
  const family = Object.keys(data.packages).filter(key => /^(vitest|@vitest\/[^@]+)@/.test(key));
  expect(family).toHaveLength(8);
  for (const key of family) {
    expect(key).toMatch(/@4\.1\.12$/);
    expect(data.packages[key]).toEqual(root.packages[key]);
  }
  // Catch dangling or stale snapshot references after an offline lock update.
  for (const snapshot of Object.values(data.snapshots)) {
    for (const [name, version] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
      expect(data.snapshots, `${name}@${version}`).toHaveProperty(`${name}@${version}`);
    }
  }
});

it('patches the standalone Capacitor → rimraf → glob → minimatch path', () => {
  const data = lock('apps/mobile/pnpm-lock.yaml');
  expect(data.overrides).toEqual(json('apps/mobile/package.json').pnpm.overrides);
  expect(data.overrides['minimatch@>=7 <11.0.1']).toBe('11.0.1');
  expect(Object.keys(data.packages).filter(key => key.startsWith('minimatch@'))).toEqual(['minimatch@11.0.1']);
  expect(data.packages['minimatch@11.0.1']).toEqual(root.packages['minimatch@11.0.1']);
  expect(data.snapshots['minimatch@11.0.1']).toEqual(root.snapshots['minimatch@11.0.1']);
  const cap = data.snapshots['@capacitor/cli@8.5.2'];
  const rimraf = data.snapshots[`rimraf@${cap.dependencies.rimraf}`];
  const glob = data.snapshots[`glob@${rimraf.dependencies.glob}`];
  expect(glob.dependencies.minimatch).toBe('11.0.1');
});

it('accounts for all eight incidental workspace resolutions and their consumers', () => {
  const rows = json('lane-evidence/incidental-resolutions.json');
  expect(rows.map(row => row.name).sort()).toEqual(['chai', '@jridgewell/sourcemap-codec', 'es-module-lexer', 'obug', 'picomatch', 'std-env', 'tinyrainbow', 'tinyexec'].sort());
  for (const row of rows) {
    expect(row.reason.length).toBeGreaterThan(40);
    expect(row.from).not.toBe(row.to);
    expect(root.packages).toHaveProperty(`${row.name}@${row.to}`);
    for (const consumer of row.consumers) {
      const snapshots = Object.entries(root.snapshots).filter(([key]) => key.split('(')[0] === consumer);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const [, snapshot] of snapshots) expect(snapshot.dependencies[row.name]).toBe(row.to);
    }
  }
});

// The control plane is a workspace importer, unlike the standalone applications.
it('pins the control-plane Vitest manifest to its workspace importer', () => {
  const version = json('cloudflare/control-plane/package.json').devDependencies.vitest;
  expect(version).toBe('4.1.12');
  expect(root.importers['cloudflare/control-plane'].devDependencies.vitest.specifier).toBe(version);
});

it.each(['apps/mobile', 'cloudflare/push-relay'])('enforces workspace security floors throughout standalone %s', dir => {
  const data = lock(`${dir}/pnpm-lock.yaml`);
  const workspace = lock('pnpm-workspace.yaml');
  const floors = { sharp: ['sharp', '0.35.5'], undici: ['undici@>=7 <7.30.1', '7.30.1'], 'source-map-js': ['source-map-js@<1.2.2', '1.2.2'] };
  expect(data.overrides).toEqual(json(`${dir}/package.json`).pnpm?.overrides);
  for (const [name, [selector, version]] of Object.entries(floors)) {
    const keys = Object.keys(data.packages).filter(key => key.startsWith(name + '@'));
    if (dir === 'apps/mobile' && name !== 'source-map-js') {
      expect(keys).toEqual([]);
      continue;
    }
    expect(data.overrides[selector]).toBe(workspace.overrides[selector]);
    expect(keys).toEqual([name + '@' + version]);
    expect(data.packages[keys[0]]).toEqual(root.packages[keys[0]]);
    const resolved = name === 'sharp' ? version + '(@types/node@26.6.3)' : version;
    const rootKey = name === 'sharp' ? keys[0] + '(@types/node@26.2.0)' : keys[0];
    const expected = structuredClone(root.snapshots[rootKey]);
    if (name === 'sharp') expected.optionalDependencies['@types/node'] = '26.6.3';
    expect(data.snapshots[name + '@' + resolved]).toEqual(expected);
    const consumers = Object.values(data.snapshots).filter(snapshot => snapshot.dependencies?.[name]);
    expect(consumers.length).toBeGreaterThan(0);
    for (const consumer of consumers) expect(consumer.dependencies[name]).toBe(resolved);
  }
  for (const importer of Object.values(data.importers)) {
    for (const [name, entry] of Object.entries({ ...importer.dependencies, ...importer.devDependencies })) {
      expect(data.snapshots, `${name}@${entry.version}`).toHaveProperty(`${name}@${entry.version}`);
    }
  }
  // Include sharp's platform binaries and libvips, not just the JS wrapper.
  for (const key of Object.keys(data.packages).filter(key => key.startsWith('@img/sharp-'))) {
    expect(data.packages[key]).toEqual(root.packages[key]);
    expect(data.snapshots[key]).toEqual(root.snapshots[key]);
  }
});
