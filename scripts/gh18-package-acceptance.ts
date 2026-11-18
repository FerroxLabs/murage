// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real read predicates over the database the packaged owner action changes.
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { denyLookup, memoryLookup, sessionLookup } from '../server/memory/deny-read.ts';
import { memoryRefKey } from '../server/memory/lineage-types.ts';
import { sessionKeyOf } from '../server/memory/session-incarnation.ts';
import { sessionAudienceChanged } from '../server/session-audience.ts';
import { CONTENT, OWNER, MEMBER, WritetimeFixture } from '../server/memory/testing/writetime-fixture.ts';

export function seedPackageReaders(db: DatabaseSync, thread: string) {
  const fx = new WritetimeFixture(db);
  fx.footprint(918010, ['s-room']).ready(thread, true)
    .reply(thread, 'package-hidden-line', 918010, { footprint: 918010 })
    .reply(thread, 'package-clean-line', 918011, { footprint: 918010 })
    .denyLine(thread, 918010, 918002)
    .record('package-hidden-memory', 1, 's-room').denyMemory('record', 'package-hidden-memory', 1, 918002)
    .record('package-forgotten-memory', 1, 's-room').tombstone('record', 'package-forgotten-memory', 1)
    .sessionLineage(thread, 'member', 'package-member-session', 1, 918011)
    .denySession(thread, 'member', 'package-member-session', 918002);
  // Unit lineage fixtures omit display fields. The real renderer also needs
  // the normal persisted message envelope, including a valid timestamp.
  for (const id of ['package-hidden-line', 'package-clean-line']) {
    const text = id === 'package-hidden-line' ? 'PACKAGE_HIDDEN_LINE' : 'PACKAGE_VISIBLE_LINE';
    const message = { id, at: Date.now(), role: 'bot', kind: 'text', text };
    db.prepare('UPDATE messages SET text=?,json=? WHERE thread_id=? AND id=?').run(text, JSON.stringify(message), thread, id);
  }
}
export function packageReaderProjection(db: DatabaseSync, thread: string) {
  const refs = [{ kind: 'record' as const, id: 'package-hidden-memory', version: 1 }, { kind: 'record' as const, id: 'package-forgotten-memory', version: 1 }];
  const projection = [CONTENT, OWNER, MEMBER].map(reader => ({
    lines: ['package-hidden-line', 'package-clean-line'].map(messageId => denyLookup(db, { threadId: thread, lines: [{ messageId, author: 'generated' }] }, reader).get(messageId)),
    records: refs.map(ref => memoryLookup(db, [ref], reader).get(memoryRefKey(ref))),
    reachableMemberSession: sessionLookup(db, sessionKeyOf(thread, 'member', 'package-member-session'), reader),
  }));
  for (const reader of projection) {
    assert.equal(reader.lines[0]?.state, 'withheld'); assert.equal(reader.lines[1]?.state, 'shown');
    assert.equal(reader.records[0]?.state, 'withheld'); assert.equal(reader.records[1]?.state, 'withheld');
    assert.equal(reader.reachableMemberSession.state, 'withheld');
  }
  // Owner-native sessions are not reachable by a nonowner, before or after
  // the clear. Test the selector used by real turn admission, not a label.
  for (const recorded of [undefined, 'owner', 'owner|x2:partition']) {
    assert.equal(sessionAudienceChanged(recorded, true, 'person:package-member'), true);
  }
  return projection;
}
