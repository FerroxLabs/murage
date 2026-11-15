// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindNativeProvenance, readNativeProvenance, verifyLoadedFileUnchanged } from './qualification/notify/native-provenance.mjs';
export function collectNotificationEvidence({ addon, provenance, platform = process.platform, arch = process.arch }) {
  assert.equal(platform, 'darwin', 'NOTIFICATION_MAC_REQUIRED');
  const identity = bindNativeProvenance(provenance, platform, arch);
  const expected = ['status', 'request', 'registerCategories', 'post', 'remove', 'onResponse'];
  const exports = Object.getOwnPropertyNames(addon).sort();
  for (const name of expected) assert.equal(typeof addon[name], 'function', `NOTIFICATION_EXPORT_REQUIRED:${name}`);
  assert.deepEqual(exports, [...expected].sort());
  return { ...identity, platform, arch, node: process.version, exports, addonMethodsCalled: false, authorizationMethodsCalled: false, osPermissionRequested: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'NOTIFICATION_EVIDENCE_PATHS_REQUIRED');
  const addonFile = path.resolve(process.argv[2]);
  const provenance = readNativeProvenance(addonFile, 'notification');
  const addon = createRequire(import.meta.url)(addonFile);
  const evidence = collectNotificationEvidence({ addon, provenance });
  verifyLoadedFileUnchanged(addonFile, provenance);
  writeFileSync(process.argv[3], JSON.stringify(evidence, null, 2) + '\n');
}
