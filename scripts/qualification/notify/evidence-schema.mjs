// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Qualification evidence is not approval authority. A synthetic PASS never admits a real runner.
export const identityFields = Object.freeze(['checkId', 'platformId', 'osBuild', 'arch', 'packageFormat', 'surface', 'layoutId', 'capabilityStateId', 'captureToolId', 'captureToolVersion', 'backend', 'profileOrigin', 'profileKind', 'locale', 'scenario', 'pair', 'leg']);
export const platformContracts = Object.freeze({
  w10: { os: 'win32', release: /^Windows 10 22H2$/, session: 'GUI', arches: ['x64'] },
  w11: { os: 'win32', release: /^Windows 11 24H2$/, session: 'GUI', arches: ['x64'] },
  m14: { os: 'darwin', release: /^macOS 14$/, session: 'Aqua', arches: ['arm64', 'x64'] },
  m15: { os: 'darwin', release: /^macOS 15$/, session: 'Aqua', arches: ['arm64', 'x64'] },
  m26: { os: 'darwin', release: /^macOS 26$/, session: 'Aqua', arches: ['arm64', 'x64'] },
  gx: { os: 'linux', release: /^Ubuntu 24\.04 GNOME 46$/, session: 'X11', arches: ['x64'] },
  gw: { os: 'linux', release: /^Ubuntu 24\.04 GNOME 46$/, session: 'Wayland', arches: ['x64'] },
  kw: { os: 'linux', release: /^Fedora \d+ Plasma 6$/, session: 'Wayland', arches: ['x64'] },
});
export const packageFormats = Object.freeze({ win32: Object.freeze(['exe', 'zip']), darwin: Object.freeze(['dmg', 'zip']), linux: Object.freeze(['AppImage', 'deb']) });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function subcaseKey(row) {
  for (const field of identityFields) if (!text(row?.[field])) throw new Error(`identity-required:${field}`);
  // JSON tuple encoding is injective even when a field contains separators or escapes.
  return JSON.stringify(identityFields.map(field => row[field]));
}
export function validateAdmission(manifest, { now = Date.now() } = {}) {
  const errors = [], m = manifest ?? {};
  if (m.schemaVersion !== 1) errors.push('schema-version');
  if (!sha(m.productionRcFullSha) || !hash(m.productTreeHash)) errors.push('source-required');
  if (m.cpuUnit !== 'percent-one-logical-core') errors.push('cpu-unit');
  if (!time(m.frozenAt) || Date.parse(m.frozenAt) > now) errors.push('freeze-required');
  for (const commit of ['e10dcd6bd', '886fc55b7']) if (!m.requiredIntegrations?.includes(commit)) errors.push(`integration-required:${commit}`);
  errors.push(...validateInstrumentationMap(m.instrumentationMap, m.productTreeHash));
  const seen = new Set();
  for (const runner of Array.isArray(m.runners) ? m.runners : []) {
    const c = platformContracts[runner.platformId], key = `${runner.platformId}/${runner.arch}`;
    if (seen.has(key)) errors.push(`duplicate-runner:${key}`);
    seen.add(key);
    if (!c || c.os !== runner.os || !c.release.test(runner.osRelease) || c.session !== runner.session || !c.arches.includes(runner.arch)) errors.push(`wrong-platform:${key}`);
    if (!text(runner.osBuild) || /\b(latest|unknown|unverified)\b/i.test(runner.osBuild)) errors.push(`os-build:${key}`);
    if (!text(runner.operator) || /^(MAIN|NOTIFY[-_].*|NO runner|TBD)$/i.test(runner.operator)) errors.push(`operator-required:${key}`);
    if (!text(runner.runner) || runner.gui !== true || runner.nativeExecution !== true) errors.push(`native-gui-required:${key}`);
    if (!time(runner.expiresAt) || Date.parse(runner.expiresAt) <= now) errors.push(`expired-allocation:${key}`);
    for (const field of ['packageHash', 'installedHash', 'guiReceiptHash', 'profileHash', 'admissionReceiptHash']) if (!hash(runner[field])) errors.push(`${field}:${key}`);
    if (runner.sourceSha !== m.productionRcFullSha) errors.push(`source-mismatch:${key}`);
    const formats = packageFormats[runner.os] ?? [];
    if (!formats.includes(runner.packageFormat)) errors.push(`package-format:${key}`);
    const artifacts = Array.isArray(runner.artifacts) ? runner.artifacts : [], artifactFormats = new Set();
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object') { errors.push(`artifact-required:${key}`); continue; }
      if (!formats.includes(artifact.packageFormat) || artifactFormats.has(artifact.packageFormat)) errors.push(`artifact-format:${key}`);
      artifactFormats.add(artifact.packageFormat);
      if (!hash(artifact.packageHash) || !hash(artifact.installedHash) || artifact.sourceSha !== m.productionRcFullSha) errors.push(`artifact-identity:${key}`);
    }
    for (const format of formats) if (!artifactFormats.has(format)) errors.push(`missing-package:${key}/${format}`);
    const primary = artifacts.find(a => a?.packageFormat === runner.packageFormat);
    if (!primary || primary.packageHash !== runner.packageHash || primary.installedHash !== runner.installedHash) errors.push(`primary-package-mismatch:${key}`);
    if (runner.platformId === 'kw') for (const field of ['kernelBuild', 'compositorBuild', 'notificationServiceBuild']) if (!text(runner[field])) errors.push(`${field}:${key}`);
  }
  for (const [id, c] of Object.entries(platformContracts)) for (const arch of c.arches) if (!seen.has(`${id}/${arch}`)) errors.push(`missing-architecture:${id}/${arch}`);
  return errors;
}
// This closed set is intentionally narrower than general platform capability restrictions.
// Each nonnumerical limitation still requires a separate passing fallback assertion.
function designedNA(row) {
  if (['gx', 'gw', 'kw'].includes(row.platformId) && row.checkId === 'N1.native-load') return row.reason === 'linux-no-native-addon';
  // No platform hold is a qualification exemption. A Sean ruling must be
  // separately recorded and reviewed; none is supplied by this schema.
  return false;
}
export function aggregateEvidence({ expected = [], observed = [], productionRcFullSha, hashes = {} }) {
  const errors = [], required = new Map(), found = new Set();
  if (!sha(productionRcFullSha)) errors.push('source-required');
  if (!expected.length) errors.push('empty-checklist');
  for (const row of expected) {
    try { const key = subcaseKey(row); if (required.has(key)) errors.push('duplicate-expected'); required.set(key, row); }
    catch (error) { errors.push(error.message); }
  }
  let passed = 0, designed = 0;
  for (const row of observed) {
    let key;
    try { key = subcaseKey(row); } catch (error) { errors.push(error.message); continue; }
    if (found.has(key)) errors.push('duplicate-subcase');
    found.add(key);
    const declaration = required.get(key);
    if (!declaration) errors.push('unexpected-subcase');
    if (row.productionRcFullSha !== productionRcFullSha) errors.push('stale-source');
    if (!Array.isArray(row.evidence) || !row.evidence.length) errors.push('evidence-required');
    for (const artifact of row.evidence ?? []) {
      if (!text(artifact.path) || artifact.path.startsWith('/') || artifact.path.includes('\\') || artifact.path.split('/').some(p => p === '..' || p === '.' || p === '')) errors.push('unsafe-evidence-path');
      if (!hash(artifact.sha256) || hashes[artifact.path] !== artifact.sha256) errors.push('evidence-hash-mismatch');
    }
    if (row.checkId.startsWith('N5.') && row.status !== 'NA-DESIGN' && row.engineProvenance !== 'real') errors.push('real-engine-required');
    if (row.status === 'NA-DESIGN') {
      if (!designedNA(row) || declaration?.expectedStatus !== 'NA-DESIGN') errors.push('unauthorized-na');
      else designed++;
    } else if (row.status !== 'PASS') errors.push(`subcase-${row.status ?? 'missing-status'}`);
    else if (declaration?.expectedStatus === 'NA-DESIGN') errors.push('na-counted-as-pass');
    else passed++;
  }
  for (const key of required.keys()) if (!found.has(key)) errors.push('missing-subcase');
  return { status: errors.length ? (observed.some(r => r.status === 'FAIL') ? 'FAIL' : 'OPEN') : 'PASS', passed, designed, expected: required.size, errors };
}

// Logical module hashes are recorded before archive/signature wrappers. Signing
// differences require separate installed-byte receipts; this cannot approve them.
const instrumentationFiles = new Set([
  'electron/qualification-hooks.mjs', 'electron/rig-notify-counters.mjs',
  'electron/qualification/notify-main.mjs', 'electron/qualification/notify-preload.cjs',
  'scripts/qualification/notify/renderer-trace.ts', 'virtual:notify-qualification-trace',
]);
export function validateInstrumentationMap(map, productTreeHash) {
  const errors = [];
  if (!map || map.productionTree !== productTreeHash || map.qualificationBaseTree !== productTreeHash) return ['instrumentation-source-mismatch'];
  if (!hash(map.deltaHash) || map.reviewedDeltaHash !== map.deltaHash) errors.push('instrumentation-review-required');
  const production = map.productionFiles, qualification = map.qualificationFiles;
  if (!production || !qualification || !Object.keys(production).length || !Object.keys(qualification).length) return [...errors, 'instrumentation-files-required'];
  for (const file of new Set([...Object.keys(production), ...Object.keys(qualification)])) {
    const before = production[file], after = qualification[file];
    if ((before !== undefined && !hash(before)) || (after !== undefined && !hash(after))) errors.push(`instrumentation-file-hash:${file}`);
    if (before !== after && !instrumentationFiles.has(file)) errors.push(`unapproved-instrumentation:${file}`);
    if (before !== undefined && after === undefined) errors.push(`missing-product-file:${file}`);
  }
  return errors;
}
