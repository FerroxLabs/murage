// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: mem-r04-1019 mutations/witnesses; tafix-r4a shared verdict; int-train5w integration; trainred-r04 retire-too-late witness.
// Run inside an isolated test container; reports go to stdout, scratch stays outside the repository.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDecisionMutant } from '../test-truth/decision-mutant.test-helper.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';

const early = '  // Admission passed the refused-lease guard: receipts must join only this generation.\n  supersedeMemberTurns(turnLineage);\n';
const late = '        addTurnParents(turnLineage, turnShownRefs);\n';
const fence = '  accounting: "release" | "check-only" = "check-only"): void {\n';
const mutants = [
  {
    id: 'R04-retire-too-late', file: 'server/index.ts',
    changes: [[early, ''], [late, late + '        supersedeMemberTurns(turnLineage);\n']],
    // The completed predecessor stays open until the next admission retires it; the witness observes the
    // member's open turns at the first setup step after admission (forced point, exact rows).
    test: 'server/memory/r04-admission-retirement.test.ts', pattern: 'R04 retire at admission',
    assertions: ['expect(observations()).toEqual(['],
  },
  {
    id: 'R04-bypass-retained-fence', file: 'server/memory/send-fence.ts',
    changes: [[fence, fence + '  return;\n']],
    test: 'server/drivers/engine-release-atomic.test.ts', pattern: 'actual engine frame owns one writer transaction',
    assertions: ['expect(() => fencedSubmit(input, () => stream.write(frame), frame)).toThrow("MEMORY_CONTEXT_REVOKED")'],
  },
];
const scratch = mkdtempSync(join(tmpdir(), 'memory-retirement-mutants-'));
let certified = true;
try {
  for (const spec of mutants) {
    const original = readFileSync(spec.file, 'utf8');
    let changed = original;
    for (const [from, to] of spec.changes) {
      assert.equal(changed.split(from).length - 1, 1, `${spec.id}: mutation must match once`);
      changed = changed.replace(from, to);
    }
    const result = await verifyDecisionMutant({
      id: spec.id, dir: scratch, file: spec.test, assertions: spec.assertions,
      args: ['node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', spec.test, '-t', spec.pattern],
      mutate: () => writeFileSync(spec.file, changed), restore: () => writeFileSync(spec.file, original),
      timeout: 0, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(readFileSync(spec.file, 'utf8'), original);
    console.log(JSON.stringify(result));
    certified &&= result.killed;
  }
  assert.equal(certified, true, 'R04 mutants must die at their intended assertions');
} finally { safeWipeSync(scratch); }
