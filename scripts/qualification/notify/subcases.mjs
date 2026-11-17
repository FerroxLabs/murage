// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { identityFields, packageFormats, platformContracts, subcaseKey } from './evidence-schema.mjs';
export const locales = Object.freeze(['en', 'de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh']);
// Unique assertion/stimulus IDs, never a row-level N1/N2 summary as identity.
export const assertions = Object.freeze({
  P0: ['new-profile', 'upgrade-profile', 'mature-profile', 'gui-ready', 'production-smoke', 'dependencies'],
  N1: ['installed-bytes', 'source-map', 'native-load'],
  S0: ['ascii-95', 'combined-maxima', 'name-boundary', 'name-plus-one', 'title-boundary', 'title-plus-one', 'detail-boundary', 'detail-plus-one', 'multiline', 'tabs', 'unicode', 'hidden-detail', 'ellipsis', 'overflow', 'focus', 'capture-negative-control'],
  N2: ['combined-maxima', 'name-boundary', 'name-plus-one', 'title-boundary', 'title-plus-one', 'detail-boundary', 'detail-plus-one', 'unsupported-text', 'unknown-layout', 'stale-layout'],
  N3: ['allow', 'deny', 'reply-typed', 'reply-empty', 'reply-unsupported', 'open', 'double-click', 'replay', 'cross-surface-settlement', 'withdrawal', 'locked', 'unknown-lock', 'previews-on', 'previews-off', 'previews-changed-visible', 'oversized', 'stop-line', 's8r-refresh', 'draft-continuity', 'receipt-length', 'receipt-count', 'shortcut', 'pin', 'unpin', 'mute', 'system-action'],
  N4: ['fullscreen-off-on-off', 'sharing-off-on-off', 'focus-off-on-off', 'lock-off-on-off', 'pre-transition-token', 'fresh-release', 'pending-card', 'arriving-card', 'receiver-protected', 'receiver-unprotected'],
  N6: ['defaults', 'controls', 'reset', 'words', 'five-second-review', 'keyboard', 'screen-reader', 'search', 'settings-15-tasks', 'night-notification'],
});
function requireList(value, label) { if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !v)) throw new Error(`inventory-required:${label}`); return value; }
// Discovery inventory is frozen independently of observations. Exact OS/build/layout/capture
// facts must come from admission; there is deliberately no invented "default layout".
export function generateSubcases(manifest, inventory) {
  const rows = [], seen = new Set();
  const add = (runner, checkId, dimensions = {}) => {
    const row = { ...Object.fromEntries(identityFields.map(k => [k, 'none'])),
      checkId, platformId: runner.platformId, osBuild: runner.osBuild, arch: runner.arch,
      packageFormat: runner.packageFormat, ...dimensions };
    const key = subcaseKey(row); if (seen.has(key)) throw new Error('duplicate-declaration');
    seen.add(key); rows.push(row);
  };
  const executions = manifest.runners.flatMap(runner => {
    if (!Array.isArray(runner.artifacts) || !runner.artifacts.length) throw new Error('inventory-required:packages');
    return runner.artifacts.map(artifact => {
      if (!packageFormats[runner.os]?.includes(artifact.packageFormat)) throw new Error('inventory-required:package-format');
      return { ...runner, packageFormat: artifact.packageFormat };
    });
  });
  for (const runner of executions) {
    const i = inventory[runner.platformId + '/' + runner.arch];
    if (!i) throw new Error('inventory-required:runner');
    for (const group of ['P0', 'N1']) for (const assertion of assertions[group]) add(runner, `${group}.${assertion}`,
      group === 'N1' && assertion === 'native-load' && runner.os === 'linux' ? { expectedStatus: 'NA-DESIGN', reason: 'linux-no-native-addon' } : {});
    for (const surface of requireList(i.surfaces, 'surfaces')) {
      for (const layoutId of requireList(i.layouts?.[surface], 'layouts')) {
        for (const capabilityStateId of requireList(i.capabilityStates, 'capabilities')) {
          for (const locale of locales) {
            for (const group of ['S0', 'N2', 'N3']) for (const assertion of assertions[group]) add(runner, `${group}.${assertion}`, { surface, layoutId, capabilityStateId, locale });
          }
          if (!Array.isArray(i.captures) || !i.captures.length) throw new Error('inventory-required:captures');
          for (const capture of i.captures) {
            for (const field of ['captureToolId', 'captureToolVersion', 'backend']) requireList([capture[field]], field);
            for (const assertion of assertions.N4) add(runner, `N4.${assertion}`, { surface, layoutId, capabilityStateId, captureToolId: capture.captureToolId, captureToolVersion: capture.captureToolVersion, backend: capture.backend });
          }
        }
      }
    }
    for (const scenario of ['C', 'H', 'E', 'D', 'B']) {
      for (const pair of ['1', '2', '3']) for (const leg of ['off', 'on']) add(runner, `N5.${scenario}.${scenario === 'B' ? 'burst-drain' : 'cpu'}`, { scenario, pair, leg });
    }
    for (const locale of locales) for (const mode of ['simple', 'advanced']) for (const profileKind of ['new', 'upgrade', 'mature']) {
      for (const page of requireList(i.settingsPages, 'settings-pages')) for (const assertion of assertions.N6) add(runner, `N6.${page}.${mode}.${assertion}`, { locale, profileKind, profileOrigin: profileKind === 'new' ? 'new' : 'upgrade' });
    }
  }
  for (const [id, contract] of Object.entries(platformContracts)) for (const arch of contract.arches) if (!manifest.runners.some(r => r.platformId === id && r.arch === arch)) throw new Error(`missing-architecture:${id}/${arch}`);
  return rows;
}
export function checklistHash(rows) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
