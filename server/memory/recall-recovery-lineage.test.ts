// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: scopes7c-r2 (foundation A1), retained lineage guards.
// Consumer owner: recall-s1s2d, reader admission before recovery receipt joins.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { addTurnParents, closeTurnLineage, freezeLineageReader, memberTurnId, openTurnLineage, runningTurnFor, supersedeMemberTurns } from './lineage-write.ts';
import { assertRetainedFence, prepareRetainedFence } from './send-fence.ts';
import { CONTENT, WritetimeFixture } from './testing/writetime-fixture.ts';
import { TurnSubmissionBoundary } from '../turn-dispatch-guard.ts';
import type { LineageRef, TurnLineage } from './lineage-types.ts';

// Execute the shipped admission callback, with real retained fences and the
// exact connection. No policy or receipt-join implementation is copied here.
function admit(venue: 'direct' | 'room', f: WritetimeFixture, turn: TurnLineage) {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const name = venue === 'direct' ? 'finalizeDirectReader' : 'finalizeRoomReader';
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let statement: ts.VariableStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name)) statement = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const start = statement?.getStart(ast) ?? -1;
  const end = statement?.getEnd() ?? -1;
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const callback = stripTypeScriptTypes(source.slice(start, end));
  const invoke = new Function('prepareRetainedFence', 'supersedeMemberTurns', 'freezeLineageReader', 'turnLineage', 'roomTurnLineage', 'submissionBoundary', 'ledgerLease', 'database', 'roomOwnerAudience', 'continueOwnerPending',
    // 1.0.20 A-5: the direct callback's new free variable; undefined is the non-owner default (no pending continuation)
    callback + `return ${name};`)(prepareRetainedFence, supersedeMemberTurns, freezeLineageReader, turn, turn, new TurnSubmissionBoundary(), { onLedgerRefused: vi.fn() }, () => f.db, true, undefined);
  return venue === 'direct' ? invoke(CONTENT) : invoke(['s-room']);
}

for (const venue of ['direct', 'room'] as const) for (const sealed of [false, true]) {
  it(`${venue}: recovery receipt joins only its successor, with a ${sealed ? 'sealed' : 'revoked'} predecessor`, () => {
    const f = new WritetimeFixture().receipt('old-receipt', 'fixture-thread', 'driver', 'old-session').receipt('new-receipt', 'fixture-thread', 'driver', 'new-session');
    const old = openTurnLineage(f.db, { threadId: 'fixture-thread', turnId: memberTurnId('reader') });
    const peer = openTurnLineage(f.db, { threadId: 'fixture-thread', turnId: memberTurnId('peer') });
    let next: TurnLineage | undefined;
    const oldRef: LineageRef = { kind: 'receipt', bundleId: 'old-receipt', lsn: old.turnLsn, scopeIds: [] };
    const newRef: LineageRef = { kind: 'receipt', bundleId: 'new-receipt', lsn: old.turnLsn, scopeIds: [] };
    try {
      prepareRetainedFence(old, CONTENT, vi.fn(), f.db);
      prepareRetainedFence(peer, CONTENT, vi.fn(), f.db);
      addTurnParents(old, [oldRef]);
      f.db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='old-receipt'").run();
      if (sealed) expect(() => assertRetainedFence(old, f.db)).toThrow('MEMORY_CONTEXT_REVOKED');
      next = openTurnLineage(f.db, { threadId: 'fixture-thread', turnId: memberTurnId('reader') });
      admit(venue, f, next);
      // This is the same member lookup used by receiptJoinsTurn. The new
      // receipt must never revalidate or attach to an earlier generation.
      const joining = runningTurnFor('fixture-thread', 'reader')!;
      expect(() => addTurnParents(joining, [newRef])).not.toThrow();
      expect(joining).toBe(next);
      expect(next.parents).toEqual([newRef]);
      expect(old.parents).toEqual([oldRef]);
      expect(runningTurnFor('fixture-thread', 'peer')).toBe(peer);
      expect(() => assertRetainedFence(peer, f.db)).not.toThrow();
      expect(() => assertRetainedFence(old, f.db)).toThrow('MEMORY_CONTEXT_REVOKED');
    } finally {
      if (next) closeTurnLineage(next);
      closeTurnLineage(old); closeTurnLineage(peer); f.close();
    }
  });
}
