// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { preservePost118Data, removePost118Data } from './installation-decision-downgrade.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

// 1.0.2's backup does not classify these 1.0.19 owner files, so the downgrade removes them;
// the owner keeps their bytes only through the preserved sibling folder.
const OWNER_FILES = { 'cloud-computer-archive.json': '{"archive":[1,2]}\n', 'cloud-computer-calls.json': '{"calls":["c1"]}\n', 'composio-admission.json': '{"waits":{"w1":true}}\n' };
let parent: string, root: string;
beforeEach(() => { parent = mkdtempSync(join(tmpdir(), 'murage-owner-state-')); root = join(parent, 'data'); mkdirSync(root); });
afterEach(() => { removeTempDirSync(parent); });

it('copies each 1.0.19 owner-state file byte-equal before the downgrade removes it', () => {
  for (const [name, bytes] of Object.entries(OWNER_FILES)) writeFileSync(join(root, name), bytes);
  writeFileSync(join(root, 'kept.json'), 'untouched');
  const preserved = preservePost118Data(root);
  expect(preserved).toBeTruthy();
  expect(readdirSync(preserved!).sort()).toEqual(Object.keys(OWNER_FILES).sort());
  for (const [name, bytes] of Object.entries(OWNER_FILES)) expect(readFileSync(join(preserved!, name), 'utf8'), name).toBe(bytes);
  expect(removePost118Data(root).sort()).toEqual(Object.keys(OWNER_FILES).sort());
  for (const name of Object.keys(OWNER_FILES)) expect(existsSync(join(root, name)), name).toBe(false);
  expect(readdirSync(root)).toEqual(['kept.json']);
  // the copy survives the removal
  for (const [name, bytes] of Object.entries(OWNER_FILES)) expect(readFileSync(join(preserved!, name), 'utf8'), name).toBe(bytes);
});
