// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { englishLiterals } from './english-inventory.mjs';
export const inventoryFiles = ['gate-1019.mjs', 'judge.mjs', 'smooth-receipt.mjs', 'owned-shards.mjs', 'mutations.mjs', 'mutation-proof.mjs'];
test('BLOCK-5 every English runner literal is inventoried as operator-only copy', () => {
  const doc = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('Operator English inventory'), 'English inventory must exist');
  assert.ok(doc.includes('No shipped application copy'), 'inventory distinguishes application copy');
  for (const file of inventoryFiles) {
    const url = new URL(file, import.meta.url); if (!existsSync(url)) continue;
    for (const literal of englishLiterals(readFileSync(url, 'utf8'))) {
      assert.ok(doc.includes(JSON.stringify(literal)), `${file}: missing English literal ${literal}`);
    }
  }
});
