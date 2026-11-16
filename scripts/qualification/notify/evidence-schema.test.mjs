import { describe, expect, it } from 'vitest';
import { aggregateEvidence, identityFields, subcaseKey, validateAdmission } from './evidence-schema.mjs';
const sha = 'a'.repeat(40), hash = 'b'.repeat(64), now = Date.parse('2026-11-10T12:00:00Z');
const platforms = [
  ['w10', 'Windows 10 22H2', 'win32', 'GUI', ['x64']],
  ['w11', 'Windows 11 24H2', 'win32', 'GUI', ['x64']],
  ...['14', '15', '26'].map(v => ['m' + v, 'macOS ' + v, 'darwin', 'Aqua', ['arm64', 'x64']]),
  ['gx', 'Ubuntu 24.04 GNOME 46', 'linux', 'X11', ['x64']],
  ['gw', 'Ubuntu 24.04 GNOME 46', 'linux', 'Wayland', ['x64']],
  ['kw', 'Fedora 43 Plasma 6', 'linux', 'Wayland', ['x64']],
];
export function manifestFixture() {
  return { schemaVersion: 1, productionRcFullSha: sha, productTreeHash: hash,
    cpuUnit: 'percent-one-logical-core', frozenAt: '2026-11-10T10:00:00Z',
    requiredIntegrations: ['e10dcd6bd', '886fc55b7'],
    instrumentationMap: { productionTree: hash, qualificationBaseTree: hash, deltaHash: hash, reviewedDeltaHash: hash, productionFiles: { 'electron/main.mjs': hash }, qualificationFiles: { 'electron/main.mjs': hash } },
    runners: platforms.flatMap(([platformId, osRelease, os, session, arches]) => arches.map(arch => ({
      platformId, osRelease, osBuild: osRelease + ' exact-build', os, session, arch,
      operator: 'fixture-operator', runner: 'fixture-' + platformId + '-' + arch,
      gui: true, nativeExecution: true, expiresAt: '2026-11-11T00:00:00Z',
      packageFormat: os === 'darwin' ? 'dmg' : os === 'win32' ? 'exe' : 'AppImage',
      packageHash: hash, installedHash: hash, sourceSha: sha,
      artifacts: (os === 'darwin' ? ['dmg', 'zip'] : os === 'win32' ? ['exe', 'zip'] : ['AppImage', 'deb']).map(packageFormat => ({ packageFormat, packageHash: hash, installedHash: hash, sourceSha: sha })),
      guiReceiptHash: hash, profileHash: hash, admissionReceiptHash: hash,
      kernelBuild: 'fixture-kernel', compositorBuild: 'fixture-compositor', notificationServiceBuild: 'fixture-service',
    }))),
  };
}
function row(extra = {}) {
  return { ...Object.fromEntries(identityFields.map(k => [k, 'none'])), checkId: 'N3.allow.single', platformId: 'w10',
    osBuild: 'Windows 10 22H2 exact-build', arch: 'x64', packageFormat: 'exe', surface: 'banner',
    profileKind: 'new', captureToolId: 'none', status: 'PASS', productionRcFullSha: sha,
    evidence: [{ path: 'w10/x64/N3/allow.json', sha256: hash }], ...extra };
}
function aggregate(expected, observed, extra = {}) {
  return aggregateEvidence({ expected, observed, productionRcFullSha: sha, hashes: { 'w10/x64/N3/allow.json': hash }, ...extra });
}
describe('T8 admission before measurement', () => {
  it('admits a complete synthetic manifest (not an OS receipt)', () => expect(validateAdmission(manifestFixture(), { now })).toEqual([]));
  it.each([
    ['wrong OS', m => { m.runners[0].osRelease = 'Windows Server 2025'; }],
    ['wrong session', m => { m.runners.find(r => r.platformId === 'gw').session = 'X11'; }],
    ['missing GUI', m => { m.runners[0].gui = false; }],
    ['missing operator', m => { m.runners[0].operator = ''; }],
    ['role as operator', m => { m.runners[0].operator = 'NOTIFY-RIG'; }],
    ['missing hash', m => { delete m.runners[0].installedHash; }],
    ['expired allocation', m => { m.runners[0].expiresAt = '2026-11-09T00:00:00Z'; }],
    ['omitted x64', m => { m.runners = m.runners.filter(r => !(r.platformId === 'm26' && r.arch === 'x64')); }],
    ['duplicate architecture', m => { m.runners.push(m.runners[0]); }],
    ['Rosetta performance', m => { m.runners.find(r => r.platformId === 'm15' && r.arch === 'x64').nativeExecution = false; }],
    ['Fedora latest', m => { m.runners.find(r => r.platformId === 'kw').osRelease = 'Fedora latest'; }],
    ['old RC', m => { m.runners[0].sourceSha = 'c'.repeat(40); }],
    ['wrong units', m => { m.cpuUnit = 'cores'; }],
    ['missing instrumentation map', m => { delete m.instrumentationMap; }],
  ])('rejects %s', (_name, mutate) => { const m = manifestFixture(); mutate(m); expect(validateAdmission(m, { now }).length).toBeGreaterThan(0); });
});
describe('T8 collision-free frozen identity and closure', () => {
  it.each(['checkId', 'captureToolId', 'profileKind', 'captureToolVersion', 'layoutId', 'arch'])('distinguishes %s', field => {
    expect(subcaseKey(row({ [field]: 'first' }))).not.toBe(subcaseKey(row({ [field]: 'second' })));
  });
  it('admits a complete synthetic fixture', () => expect(aggregate([row()], [row()]).status).toBe('PASS'));
  it.each([
    ['missing subcase', () => []],
    ['duplicate subcase', () => [row(), row()]],
    ['unexpected subcase', () => [row(), row({ checkId: 'N3.deny.single' })]],
    ['old RC', () => [row({ productionRcFullSha: 'c'.repeat(40) })]],
    ['missing identity', () => { const r = row(); delete r.captureToolId; return [r]; }],
    ['NA counted as PASS', () => [row({ status: 'NA-DESIGN' })]],
    ['failed assertion', () => [row({ status: 'FAIL' })]],
    ['unmeasured row', () => [row({ status: 'OPEN', reason: 'rig-not-qualified' })]],
    ['altered hash', () => [row({ evidence: [{ path: 'w10/x64/N3/allow.json', sha256: 'c'.repeat(64) }] })]],
    ['no artifacts', () => [row({ evidence: [] })]],
  ])('refuses %s', (_name, observed) => expect(aggregate([row()], observed()).status).not.toBe('PASS'));
  it('does not cross-credit capture tools, profiles or actions', () => {
    for (const field of ['captureToolId', 'profileKind', 'checkId']) {
      expect(aggregate([row({ [field]: 'A' }), row({ [field]: 'B' })], [row({ [field]: 'A' })]).status).not.toBe('PASS');
    }
  });
  it('rejects an empty checklist', () => expect(aggregate([], []).status).not.toBe('PASS'));
  it('does not let a fake engine qualify N5', () => {
    const r = row({ checkId: 'N5.C.cpu', scenario: 'C', engineProvenance: 'fake', claimedEngineProvenance: 'real' });
    expect(aggregate([r], [r]).status).not.toBe('PASS');
  });
});

import { generateSubcases, checklistHash, locales } from './subcases.mjs';
describe('T8 independent checklist generation', () => {
  function input() {
    const manifest = manifestFixture();
    return { manifest, inventory: Object.fromEntries(manifest.runners.map(r => [`${r.platformId}/${r.arch}`, {
      surfaces: ['banner', 'menu'], layouts: { banner: ['light-normal', 'dark-large'], menu: ['light-normal', 'dark-large'] },
      capabilityStates: ['granted', 'denied', 'unavailable'],
      captures: [{ captureToolId: 'zoom', captureToolVersion: 'fixture-1', backend: 'fixture' }, { captureToolId: 'teams', captureToolVersion: 'fixture-1', backend: 'fixture' }],
      settingsPages: ['notifications'],
    }])) };
  }
  it('expands every shipped architecture, locale, capture, profile and scenario without collisions', () => {
    const { manifest, inventory } = input(), rows = generateSubcases(manifest, inventory);
    expect(new Set(rows.map(subcaseKey)).size).toBe(rows.length);
    for (const r of manifest.runners) for (const scenario of ['C', 'H', 'E', 'D', 'B']) {
      const selected = rows.filter(row => row.platformId === r.platformId && row.arch === r.arch && row.scenario === scenario);
      expect(selected.length).toBe(r.artifacts.length * 6);
    }
    expect(new Set(rows.filter(r => r.checkId.startsWith('N6.')).map(r => r.profileKind))).toEqual(new Set(['new', 'upgrade', 'mature']));
    expect(new Set(rows.filter(r => r.locale !== 'none').map(r => r.locale))).toEqual(new Set(locales));
    expect(checklistHash(rows)).toMatch(/^[a-f0-9]{64}$/);
    expect(checklistHash(rows.slice(1))).not.toBe(checklistHash(rows));
  });
  it('cannot invent a layout, capture inventory or shipped architecture', () => {
    const { manifest, inventory } = input();
    delete inventory['w10/x64'].layouts.banner;
    expect(() => generateSubcases(manifest, inventory)).toThrow('inventory-required');
    const next = input(); next.inventory['w10/x64'].captures = [];
    expect(() => generateSubcases(next.manifest, next.inventory)).toThrow('inventory-required');
    const last = input(); last.manifest.runners = last.manifest.runners.filter(r => r.platformId !== 'm26');
    expect(() => generateSubcases(last.manifest, last.inventory)).toThrow('missing-architecture');
  });
});

describe('T8 instrumentation mapping', () => {
  it('refuses an unapproved instrumentation delta even with matching RC labels', () => {
    const m = manifestFixture();
    m.instrumentationMap = { productionTree: hash, qualificationBaseTree: hash, deltaHash: hash, reviewedDeltaHash: hash,
      productionFiles: { 'server/desktop-attention.ts': hash }, qualificationFiles: { 'server/desktop-attention.ts': 'c'.repeat(64) } };
    expect(validateAdmission(m, { now }).length).toBeGreaterThan(0);
  });
  it('refuses an unrelated qualification base and an unreviewed delta', () => {
    const m = manifestFixture();
    m.instrumentationMap = { productionTree: hash, qualificationBaseTree: 'c'.repeat(64), deltaHash: hash, reviewedDeltaHash: 'd'.repeat(64), productionFiles: {}, qualificationFiles: {} };
    expect(validateAdmission(m, { now }).length).toBeGreaterThan(0);
  });
});

describe('T10 all shipped package formats', () => {
  it('does not silently omit a shipped archive format', () => {
    const m = manifestFixture();
    m.runners[0].artifacts = [{ packageFormat: 'exe', packageHash: hash, installedHash: hash, sourceSha: sha }];
    expect(validateAdmission(m, { now }).length).toBeGreaterThan(0);
  });
});

it('keeps the designed Linux native limitation separate from passing package/dependency proof', () => {
  const native = row({ checkId: 'N1.native-load', platformId: 'gx', status: 'NA-DESIGN', expectedStatus: 'NA-DESIGN', reason: 'linux-no-native-addon' });
  const installed = row({ checkId: 'N1.installed-bytes', platformId: 'gx' });
  const result = aggregate([native, installed], [native, installed]);
  expect(result.status).toBe('PASS'); expect(result.passed).toBe(1); expect(result.designed).toBe(1);
  expect(aggregate([native, installed], [native]).status).toBe('OPEN');
});

it('does not turn a platform hold into a passing CPU qualification', () => {
  const r = row({ platformId: 'gw', checkId: 'N5.E.cpu', scenario: 'E', status: 'NA-DESIGN', expectedStatus: 'NA-DESIGN', reason: 'wayland-floats-disabled' });
  expect(aggregate([r], [r]).status).toBe('OPEN');
});
