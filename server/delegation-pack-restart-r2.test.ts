// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the shipped selection block, including its real reset-accounting
// call. This also runs against the starting commit's earlier block spelling.
it.each([
  { pack: true, tainted: false, suppressed: false, command: false, rewind: false, fresh: true, restarted: true, counted: false },
  { pack: true, tainted: true, suppressed: false, command: false, rewind: false, fresh: true, restarted: true, counted: true },
  { pack: true, tainted: false, suppressed: true, command: false, rewind: false, fresh: false, restarted: false, counted: false },
  { pack: true, tainted: false, suppressed: false, command: true, rewind: false, fresh: false, restarted: false, counted: false },
  { pack: true, tainted: false, suppressed: false, command: false, rewind: true, fresh: false, restarted: false, counted: false },
  { pack: false, tainted: true, suppressed: false, command: false, rewind: false, fresh: true, restarted: true, counted: true },
])('T-PACK-RESTART $pack/$tainted/$suppressed/$command/$rewind keeps pack freshness separate from sealed-session accounting', row => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const from = Math.max(source.indexOf('  const packStartsFresh ='), source.indexOf('  const preparingDelegationContext ='));
  const to = source.indexOf('  // Messages this thread owes the engine', from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const noteSealedTurn = vi.fn();
  const env = { memoryLastResort: false, opts: row.pack ? { delegationRun: 'run', packId: 'pack', packSuppressed: row.suppressed } : {},
    engineCommand: row.command, task: { lastInstanceId: 'engine' }, instanceId: 'engine', sessionTainted: () => row.tainted,
    rewound: row.rewind, audienceMoved: false, contractMoved: false, engineFresh: false, instance: { keepsNoSession: false },
    noteSealedTurn, threadId: 'thread' };
  const code = ts.transpileModule(source.slice(from, to) + '; return {fresh, sessionRestarted};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const selected = new Function(...Object.keys(env), code)(...Object.values(env));
  expect(selected).toEqual({ fresh: row.fresh, sessionRestarted: row.restarted });
  expect(noteSealedTurn).toHaveBeenCalledTimes(row.counted ? 1 : 0);
});
