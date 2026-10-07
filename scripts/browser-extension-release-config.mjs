// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Murage for Chrome release identity: the Chrome Web Store item's ID and
// the public key from its dashboard (Package, View public key). Both are
// public. The committed file holds the handoff's placeholders until the owner
// creates the store item; the parser refuses them, so a release cannot ship
// without the real identity. No dependencies: release-guard.mjs imports this
// before `pnpm install`.
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BROWSER_EXTENSION_RELEASE_CONFIG = 'extensions/murage-browser/release.json';
const idPattern = /^[a-p]{32}$/;
export function extensionIdFromPublicKey(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error('invalid_public_manifest_key');
  const bytes = Buffer.from(value, 'base64');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa') throw Error('rsa_public_manifest_key_required');
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}
export function parseReleaseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['productionIds', 'publicKey'].includes(key)) || !Array.isArray(value.productionIds) || !value.productionIds.length || value.productionIds.length > 8 || value.productionIds.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(value.productionIds).size !== value.productionIds.length) throw Error('exact_production_ids_required');
  if (value.publicKey !== undefined && !value.productionIds.includes(extensionIdFromPublicKey(value.publicKey))) throw Error('production_key_id_mismatch');
  return { productionIds: [...value.productionIds], ...(value.publicKey ? { publicKey: value.publicKey } : {}) };
}
const PLACEHOLDER = /^REPLACE_WITH_/;
/** ready: a real identity with its store public key; placeholder: the committed
 * file, untouched; invalid: anything else (half edited, mismatched, extra). */
export function readBrowserExtensionReleaseConfig(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { return { status: 'invalid', reason: 'the release config is missing or not JSON' }; }
  if (value && Array.isArray(value.productionIds) && value.productionIds.every(id => typeof id === 'string' && PLACEHOLDER.test(id)) && typeof value.publicKey === 'string' && PLACEHOLDER.test(value.publicKey) && Object.keys(value).length === 2) return { status: 'placeholder' };
  try {
    const parsed = parseReleaseConfig(value);
    // The store link is derived from the key, so a release needs it.
    if (!parsed.publicKey) return { status: 'invalid', reason: 'the release config has no Chrome Web Store public key' };
    return { status: 'ready', path: file, productionIds: parsed.productionIds, publicKey: parsed.publicKey, chromeWebStoreId: extensionIdFromPublicKey(parsed.publicKey) };
  } catch (error) { return { status: 'invalid', reason: `the release config is not a valid identity (${error.message})` }; }
}
/** Problems with a packaged Resources/browser-extension/build.json; [] is clean. */
export function checkBrowserExtensionBuild(buildFile, configFile) {
  const config = readBrowserExtensionReleaseConfig(configFile);
  if (config.status !== 'ready') return ['the release config is not a real identity'];
  let build;
  try { build = JSON.parse(readFileSync(buildFile, 'utf8')); } catch { return ['build.json is missing or not JSON']; }
  const problems = [];
  if (build.mode !== 'release') problems.push(`build.json mode is ${build.mode}, not release`);
  if (build.developmentId !== undefined) problems.push('build.json carries a development ID');
  if (JSON.stringify(build.productionIds) !== JSON.stringify(config.productionIds)) problems.push('build.json IDs differ from the release config');
  if (build.chromeWebStoreId === undefined) problems.push('build.json has no Chrome Web Store ID');
  else if (build.chromeWebStoreId !== config.chromeWebStoreId) problems.push('build.json Chrome Web Store ID differs from the release config');
  // The unpacked ID follows the manifest key, so the packaged extension must
  // carry the dashboard key or its ID differs from the one the helper allows.
  let key;
  try { key = JSON.parse(readFileSync(join(dirname(buildFile), 'extension', 'manifest.json'), 'utf8')).key; } catch { /* reported below */ }
  if (key !== config.publicKey) problems.push('the packaged extension manifest does not carry the store public key');
  return problems;
}
