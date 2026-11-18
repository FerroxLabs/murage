// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { killedMutation } from './mutation-proof.mjs';
test('BLOCK-4 mutation proof requires an assertion RED between two GREEN executions', () => {
  const proof = { before: { code: 0 }, red: { code: 1, output: 'AssertionError [ERR_ASSERTION]' }, after: { code: 0 } };
  assert.equal(killedMutation(proof), true);
  for (const change of [{ red: { code: 0 } }, { red: { code: 1, output: 'SyntaxError' } },
    { after: { code: 1 } }, { before: { code: 1 } }, { after: undefined }]) {
    assert.equal(killedMutation({ ...proof, ...change }), false);
  }
});
test('BLOCK-4 retained evidence demonstrates each review finding with a killed implementation mutant', { skip: !process.env.GATE_MUTATION_PROOF }, () => {
  const path = process.env.GATE_MUTATION_PROOF;
  assert.ok(existsSync(path), 'retained mutation evidence must exist');
  const proof = JSON.parse(readFileSync(path, 'utf8'));
  for (const finding of ['BLOCK-1', 'BLOCK-2', 'BLOCK-3', 'BLOCK-4', 'BLOCK-5']) {
    assert.ok(proof.some(p => p.finding === finding && p.implementationChanged && killedMutation(p)), finding);
  }
});
