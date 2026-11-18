import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkPackagedShell, checkSourceShell, shellViolations } from './check-os-shell.mjs';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';

const raw = 'require("electron").shell.openPath(installerPath);';
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'murage-shell-package-'));
  t.after(() => safeWipeSync(root));
  return root;
};
const put = (root, file, content) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
function archive(root, members) {
  const tree = { files: {} }, data = [];
  let offset = 0;
  for (const [file, source] of Object.entries(members)) {
    const parts = file.split('/'), name = parts.pop();
    let parent = tree;
    for (const part of parts) parent = parent.files[part] ??= { files: {} };
    const bytes = Buffer.from(source);
    parent.files[name] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length; data.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4); json.copy(padded);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + padded.length, 4);
  prefix.writeUInt32LE(4 + padded.length, 8); prefix.writeUInt32LE(json.length, 12);
  put(root, 'resources/app.asar', Buffer.concat([prefix, padded, ...data]));
}

for (const extension of ['mjs', 'cjs', 'js', 'ts']) {
  test(`package inventory rejects raw shell in vendor and bundled node_modules .${extension}, loose and ASAR`, t => {
    const root = fixture(t);
    const members = {
      [`electron/vendor/updater.${extension}`]: raw,
      [`node_modules/nested/node_modules/dep/launch.${extension}`]: raw,
      [`electron/fixtures/launch.${extension}`]: raw,
      [`electron/testing/launch.${extension}`]: raw,
      [`node_modules/dep/launch.test.${extension}`]: raw,
    };
    archive(root, members);
    for (const [file, source] of Object.entries(members)) put(root, `resources/server/${file}`, source);
    const result = checkPackagedShell(root);
    assert.equal(result.files.length, 8, 'only test files are excluded');
    assert.equal(result.failures.length, 8);
    assert.ok(result.failures.some(f => f.includes(`app.asar/node_modules/nested/node_modules/dep/launch.${extension}`)));
    assert.ok(result.failures.some(f => f.includes(`resources/server/electron/vendor/updater.${extension}`)));
  });
}

test('source inventory follows shipping config into bundled node_modules, every extension', t => {
  const root = fixture(t);
  put(root, 'electron-builder.yml', 'files: [electron/**]\nextraResources:\n  - from: dist-server\n    to: server\n');
  put(root, 'electron-builder.qualification.yml', '{}');
  for (const ext of ['mjs', 'cjs', 'js', 'ts']) {
    put(root, `electron/vendor/fixture.${ext}`, raw);
    put(root, `dist-server/node_modules/dep/fixture.${ext}`, raw);
  }
  const result = checkSourceShell(root);
  assert.equal(result.files.length, 8);
  assert.equal(result.failures.length, 8);
});

test('the exact vendor mutant is rejected by the shipped-byte package scanner', t => {
  const root = fixture(t);
  const vendor = readFileSync(new URL('../electron/vendor/electron-updater.cjs', import.meta.url), 'utf8');
  archive(root, { 'electron/vendor/electron-updater.cjs': vendor });
  assert.deepEqual(checkPackagedShell(root).failures, []);
  archive(root, { 'electron/vendor/electron-updater.cjs': vendor + '\n' + raw });
  assert.match(checkPackagedShell(root).failures.join('\n'), /electron-updater.cjs.*raw shell/);
});

test('legitimate CJS Electron imports remain allowed without granting shell aliases', () => {
  for (const source of ['const {app,ipcRenderer: ipc}=require("electron")', 'require("electron").app.quit()', 'new (require("electron")).Notification({})']) {
    assert.deepEqual(shellViolations(source, 'electron/vendor/fixture.cjs'), []);
  }
  assert.ok(shellViolations('const {app,...rest}=require("electron")', 'electron/preload.cjs').length);
  assert.ok(shellViolations('require("electron")[unknown]()', 'electron/preload.cjs').length);
  assert.ok(shellViolations('import {shell as electronShell} from "electron";', 'node_modules/dep/main.mjs').length);
});

test('the wrapper itself is scanned and cannot acquire or export raw Electron shell', () => {
  assert.ok(shellViolations('export {shell} from "electron";', 'electron/os-shell.mjs').length);
  assert.ok(shellViolations('const {shell}=require("electron")', 'electron/os-shell.mjs').length);
});

test('a directory with .test. in its name cannot exclude shipped production JS', t => {
  const root = fixture(t);
  const file = 'node_modules/dependency.test.name/production.js';
  put(root, file, raw);
  archive(root, { [file]: raw });
  const result = checkPackagedShell(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.failures.length, 2);
});
