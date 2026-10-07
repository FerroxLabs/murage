// SPDX-License-Identifier: AGPL-3.0-or-later
// T22 (item 3): the built extension must carry its own strings. Chrome refuses to load an extension whose manifest names a
// default_locale (or __MSG_ keys) that the folder does not hold. Both build paths are checked: the dev build and the packaged one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserExtension } from './build-browser-extension.mjs';
import { prepareBrowserExtension } from './prepare-browser-extension.mjs';
import { safeWipe } from '../server/testing/safe-wipe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'extensions/murage-browser');

async function checkLocales(extensionDir) {
  const locales = (await fs.readdir(path.join(source, '_locales'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(locales.length >= 8, 'the source holds every shipped language');
  for (const locale of locales) {
    const built = await fs.readFile(path.join(extensionDir, '_locales', locale, 'messages.json'), 'utf8');
    assert.equal(built, await fs.readFile(path.join(source, '_locales', locale, 'messages.json'), 'utf8'), `${locale} is copied whole`);
    JSON.parse(built);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.default_locale, 'the manifest names a default locale');
  assert.ok(locales.includes(manifest.default_locale), 'default_locale is one of the built locales');
  const messages = JSON.parse(await fs.readFile(path.join(extensionDir, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
  // Every __MSG_name__ the manifest uses resolves in the default locale.
  const used = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map(match => match[1]);
  assert.ok(used.length > 0);
  for (const key of used) assert.ok(messages[key]?.message, `${key} resolves in ${manifest.default_locale}`);
}

test('the dev build holds _locales/<each locale>/messages.json and the manifest default_locale resolves', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mbe-build-'));
  try { await buildBrowserExtension({ output: out, quiet: true }); await checkLocales(out); }
  finally { await safeWipe(out); }
});

test('the packaged build holds them too', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'mbe-prepare-'));
  try { await prepareBrowserExtension({ outDir: out, mode: 'development' }); await checkLocales(path.join(out, 'extension')); }
  finally { await safeWipe(out); }
});
