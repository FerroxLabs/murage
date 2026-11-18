// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function bindNativeProvenance(provenance, platform, arch) {
  const p = provenance;
  assert.ok(p && /^[a-f0-9]{40}$/.test(p.sourceSha ?? ''), 'NATIVE_SOURCE_REQUIRED');
  assert.equal(p.sourceSha, p.expectedSourceSha, 'NATIVE_SOURCE_MISMATCH');
  assert.ok(isHash(p.sourceSha256) && isHash(p.expectedSourceSha256), 'NATIVE_SOURCE_BYTES_REQUIRED');
  assert.equal(p.sourceSha256, p.expectedSourceSha256, 'NATIVE_SOURCE_BYTES_MISMATCH');
  assert.equal(p.target, `${platform}-${arch}`, 'NATIVE_TARGET_MISMATCH');
  assert.ok(Buffer.isBuffer(p.loadedBytes) && p.loadedBytes.length > 0, 'NATIVE_LOADED_BYTES_REQUIRED');
  const loadedSha256 = digest(p.loadedBytes);
  // A signed-byte mismatch is not waved through. After signing, a separate pinned
  // production/install mapping and a new runtime receipt are required by N1.
  assert.ok(isHash(p.buildSha256), 'NATIVE_BUILD_HASH_REQUIRED');
  assert.equal(loadedSha256, p.buildSha256, 'NATIVE_LOADED_BYTES_MISMATCH');
  return { stage: 'build-load', loaded: true, sourceSha: p.sourceSha, sourceSha256: p.sourceSha256,
    target: p.target, buildSha256: p.buildSha256, loadedSha256 };
}
function regularBytes(file) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 32 * 1024 * 1024, 'NATIVE_REGULAR_FILE_REQUIRED');
  return readFileSync(file);
}
// Only CI/source-preflight calls this. Operators use the separately built packaged
// supervisor; this helper is neither shipped in production nor a GUI admission.
export function readNativeProvenance(addonFile, kind, { expectedSourceSha = process.env.EXPECTED_SHA } = {}) {
  assert.ok(/^[a-f0-9]{40}$/.test(expectedSourceSha ?? ''), 'NATIVE_EXPECTED_SOURCE_REQUIRED');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(sourceSha, expectedSourceSha, 'NATIVE_CHECKOUT_MISMATCH');
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'native', 'scripts'], { cwd: root });
  const build = JSON.parse(regularBytes(path.join(path.dirname(addonFile), 'build.json')));
  const sources = kind === 'notification' ? ['native/notification-authorization/authorization.mm', 'native/notification-authorization/banners.mm', 'native/notification-authorization/lifetime.h', 'native/notification-authorization/readiness.h']
    : kind === 'presence' ? [`native/presence-guard/${process.platform === 'darwin' ? 'presence-mac.mm' : 'presence-win.cc'}`, 'native/presence-guard/lifetime.h', ...(process.platform === 'darwin' ? ['native/presence-guard/share-windows.def'] : [])] : null;
  assert.ok(sources, 'NATIVE_KIND_REQUIRED');
  const sourceDigest = createHash('sha256');
  for (const file of sources) sourceDigest.update(readFileSync(path.join(root, file)));
  const provenance = { sourceSha, expectedSourceSha, sourceSha256: sourceDigest.digest('hex'),
    expectedSourceSha256: build.sourceSha256, target: build.target, loadedBytes: regularBytes(addonFile), buildSha256: build.sha256 };
  bindNativeProvenance(provenance, process.platform, process.arch);
  return provenance;
}
export function verifyLoadedFileUnchanged(addonFile, provenance) {
  assert.equal(digest(regularBytes(addonFile)), digest(provenance.loadedBytes), 'NATIVE_CHANGED_DURING_LOAD');
}
