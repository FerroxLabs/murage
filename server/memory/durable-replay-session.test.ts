// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable replay producer: tri3-g2-e. Accepted-write correlation: tri3-g7-d.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downgradeReplaySessionsTo117 } from '../installation-memory-downgrade.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { FreshReplaySessionConfirmation, withCurrentReplaySessionChange } from './fresh-replay-session.ts';
import { captureSendReplayProof, sendReplaySessionCurrent, currentSendReplaySessionProof } from './replay-lineage.ts';
import { sessionKeyOf } from './session-incarnation.ts';
import { registeredSnapshotObjects, sanitizeStagedRestoreMarks } from '../installation-database-snapshot.ts';
import { APP_SCHEMA_102_ADDITIONS } from '../installation-app-schema-downgrade.ts';
import { ADDED_TABLE_LIFECYCLE } from '../added-table-lifecycle.ts';
import { neutralizeRestoredSends } from '../send-store.ts';

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec("INSERT INTO send_replay_epochs VALUES('chat',1)");
});
afterEach(() => closeDatabase());
const key = (n = 2) => sessionKeyOf('chat', 'engine', 'native', n);
const current = (n = 2) => sendReplaySessionCurrent('chat', 'engine', key(n).nativeSession);
function row(thread: string, id: string, copyOf?: { threadId: string; messageIds: string[] }) {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'user','text','fixture',?)")
    .run(thread, id, JSON.stringify({ id, ...(copyOf ? { copyOf } : {}) }));
}
function receipt(ids: string[] = [], generation = 'generation') {
  return new FreshReplaySessionConfirmation(captureSendReplayProof('chat', ids), 'engine', () => {},
    { generation } as { generation: string });
}
function confirm(ids: string[] = []) {
  const r = receipt(ids); r.accepted('turn'); r.engineWritten(); r.sessionStarted('turn', key(), true); return r;
}
function reopen() { closeDatabase(); database(); }
it('a generation-bound accepted fresh write survives database close and reopen', () => {
  row('chat', 'history'); confirm(['history']); expect(current()).toBe(true);
  reopen(); expect(current()).toBe(true);
  expect(sendReplaySessionCurrent('chat', 'other-engine', key().nativeSession)).toBe(false);
  expect(sendReplaySessionCurrent('other-chat', 'engine', key().nativeSession)).toBe(false);
  expect(current(3)).toBe(false);
});
it.each(['no-write', 'resumed', 'wrong-turn', 'stopped'])('never persists %s confirmation', mode => {
  const r = mode === 'stopped' ? new FreshReplaySessionConfirmation(captureSendReplayProof('chat', []), 'engine', () => { throw new Error('stopped'); }, { generation: 'generation' } as { generation: string }) : receipt();
  r.accepted('turn');
  if (mode !== 'no-write') r.engineWritten();
  if (mode === 'stopped') expect(() => r.sessionStarted('turn', key(), true)).toThrow('stopped');
  else r.sessionStarted(mode === 'wrong-turn' ? 'old-turn' : 'turn', key(), mode !== 'resumed');
  reopen(); expect(current()).toBe(false);
});
it.each(['exclusion', 'retarget'])('a persisted copy still refuses an original %s after restart', mode => {
  row('source', 'origin'); row('other-source', 'origin');
  row('chat', 'copy', { threadId: 'source', messageIds: ['origin'] }); confirm(['copy']);
  reopen(); expect(current()).toBe(true);
  if (mode === 'exclusion') database().exec("INSERT INTO send_replay_exclusions VALUES('source','origin',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('source',1)");
  else database().prepare("UPDATE messages SET json=? WHERE thread_id='chat' AND id='copy'").run(JSON.stringify({ copyOf: { threadId: 'other-source', messageIds: ['origin'] } }));
  reopen(); expect(current()).toBe(false);
});
it('owned send bookkeeping persists its updated proof, but a stale proof never revives', () => {
  confirm(); reopen(); expect(current()).toBe(true);
  withCurrentReplaySessionChange('chat', 'engine', key().nativeSession, ['queued'], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('chat','queued',NULL,'not_submitted',1); UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  });
  reopen(); expect(current()).toBe(true);
  database().exec("UPDATE send_replay_epochs SET revision=3 WHERE thread_id='chat'");
  withCurrentReplaySessionChange('chat', 'engine', key().nativeSession, ['next'], () => {
    database().exec("UPDATE send_replay_epochs SET revision=4 WHERE thread_id='chat'");
  });
  reopen(); expect(current()).toBe(false);
});
it('continued delivered copied input joins the durable dependency set', () => {
  confirm(); row('source', 'origin'); row('chat', 'copy', { threadId: 'source', messageIds: ['origin'] });
  const r = new FreshReplaySessionConfirmation(captureSendReplayProof('chat', ['copy']), 'engine', () => {},
    { retainedSession: key().nativeSession, generation: 'next-generation' } as { retainedSession: string; generation: string });
  r.accepted('next-turn'); r.engineWritten();
  reopen(); expect(current()).toBe(true);
  database().exec("INSERT INTO send_replay_exclusions VALUES('source','origin',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('source',1)");
  reopen(); expect(current()).toBe(false);
});

it('a committed receipt includes exactly the fresh owner input actually written', () => {
  row('source', 'origin'); row('chat', 'owner-line', { threadId: 'source', messageIds: ['origin'] });
  const r = new FreshReplaySessionConfirmation(captureSendReplayProof('chat', []), 'engine', () => {},
    { generation: 'generation', ownMessageIds: ['owner-line'] });
  r.accepted('turn'); r.sessionStarted('turn', key(), true); r.engineWritten();
  reopen(); expect(current()).toBe(true);
  database().exec("INSERT INTO send_replay_exclusions VALUES('source','origin',NULL,'uncertain',1); INSERT INTO send_replay_epochs VALUES('source',1)");
  reopen(); expect(current()).toBe(false);
});
it('malformed durable metadata refuses rather than falling back to legacy context', () => {
  confirm(); database().exec("UPDATE send_replay_sessions SET proof='{}'");
  reopen(); expect(current()).toBe(false);
});
it('a rolled back own transition cannot publish a durable epoch refresh', () => {
  confirm(); const db = database();
  db.exec('BEGIN');
  withCurrentReplaySessionChange('chat', 'engine', key().nativeSession, ['queued'], () => {
    db.exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  });
  db.exec('ROLLBACK'); reopen(); expect(current()).toBe(true);
  expect(database().prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='chat'").get()?.revision).toBe(1);
});

it('backup staging drops only the positive native proof and retains replay exclusions', () => {
  confirm(); database().exec("INSERT INTO send_replay_exclusions VALUES('chat','held',NULL,'uncertain',1)");
  const db = database(), epochs = db.prepare('SELECT * FROM send_replay_epochs').all();
  sanitizeStagedRestoreMarks(db);
  expect(db.prepare('SELECT * FROM send_replay_epochs').all()).toEqual(epochs);
  expect(db.prepare('SELECT message_id FROM send_replay_exclusions').all()).toEqual([{ message_id: 'held' }]);
  reopen(); expect(current()).toBe(false);
});
it('durable replay metadata is registered for snapshot, lifecycle and downgrade', () => {
  expect(registeredSnapshotObjects().has('send_replay_sessions')).toBe(true);
  expect(APP_SCHEMA_102_ADDITIONS.tables).toContain('send_replay_sessions');
  expect(ADDED_TABLE_LIFECYCLE.send_replay_sessions).toMatchObject({ kind: 'marker' });
});

it('rolling back the actual confirmation never authorizes the cached session', () => {
  const db = database(); db.exec('BEGIN'); confirm(); db.exec('ROLLBACK');
  expect(current()).toBe(false);
  reopen(); expect(current()).toBe(false);
});

it('restoring an earlier archive also drops its positive native receipt', () => {
  confirm(); neutralizeRestoredSends(database()); reopen();
  expect(current()).toBe(false);
  expect(database().prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='chat'").get()?.revision).toBe(1);
});

it('a restore with no send epochs still refuses unknown old provider context', () => {
  database().exec('DELETE FROM send_replay_epochs'); confirm(); expect(current()).toBe(true);
  neutralizeRestoredSends(database()); reopen(); expect(current()).toBe(false);
  confirm(); reopen(); expect(current()).toBe(true);
});

it('capacity eviction retains a refreshed current receipt even when it sorts last', () => {
  confirm(); const db = database();
  db.exec(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<511)
    INSERT INTO send_replay_sessions(thread_id,driver_instance,native_session,generation,provider_turn_id,proof)
    SELECT r.thread_id,printf('before-%03d',n.v),r.native_session,r.generation,r.provider_turn_id,r.proof
    FROM send_replay_sessions r,n WHERE r.driver_instance='engine'`);
  expect(db.prepare('SELECT count(*) AS n FROM send_replay_sessions').get()!.n).toBe(512);
  confirm(); reopen();
  expect(current()).toBe(true);
  expect(database().prepare('SELECT count(*) AS n FROM send_replay_sessions').get()!.n).toBe(512);
  expect(database().prepare("SELECT revision FROM send_replay_epochs WHERE thread_id='chat'").get()!.revision).toBe(1);
});


it('M-order reopening preserves append order through an order-sensitive shared copy budget', () => {
  const leaves = Array.from({ length: 200 }, (_, i) => `leaf${i}`), prefix = Array.from({ length: 160 }, (_, i) => `prefix${i}`);
  for (const id of [...leaves, ...prefix]) row('source', id);
  row('source', 'shared', { threadId: 'source', messageIds: leaves });
  row('chat', 'z-first', { threadId: 'source', messageIds: ['shared'] });
  row('chat', 'a-second', { threadId: 'source', messageIds: [...prefix, 'shared'] });
  confirm();
  const append = (id: string, n: number) => {
    const r = new FreshReplaySessionConfirmation(captureSendReplayProof('chat', [id]), 'engine', () => {},
      { retainedSession: key().nativeSession, generation: `next-${n}` });
    r.accepted(`turn-${n}`); r.engineWritten();
  };
  append('z-first', 1); append('a-second', 2);
  const before = currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!;
  expect(before.messageIds).toEqual(['z-first', 'a-second']); expect([...before.excludedIds]).toEqual([]);
  expect([...captureSendReplayProof('chat', ['a-second', 'z-first']).excludedIds]).toEqual(['a-second', 'z-first']);
  reopen(); expect(current()).toBe(true);
  const after = currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!;
  expect(after.messageIds).toEqual(before.messageIds); expect([...after.excludedIds]).toEqual([...before.excludedIds]); expect(after.ancestry).toBe(before.ancestry);
});

// Replay receipt producer: tri3-g2-e. Downgrade consumer: c4-misc-c2.
it('downgrade removes positive replay proof only after durably clearing every retained context', () => {
  confirm();
  database().exec("INSERT INTO send_replay_exclusions VALUES('chat','held',NULL,'uncertain',1)");
  const negative = database().prepare('SELECT * FROM send_replay_exclusions').all();
  const epochs = database().prepare('SELECT * FROM send_replay_epochs').all();
  const context = { resumeCursors: { engine: 'native' }, resumePolicies: { engine: 'policy' }, replayPending: { engine: true }, resumeSeals: { engine: 'seal' }, resumeIncarnations: { engine: 2 } };
  writeFileSync(join(DATA_DIR,'bots.json'),JSON.stringify([{ id:'fixture-bot', ...context, tasks:[{id:'fixture-task',...context}] }]));
  writeFileSync(join(DATA_DIR,'groups.json'),JSON.stringify([{ id:'fixture-group', ...context, tasks:[{id:'fixture-room-task',...context}] }]));
  downgradeReplaySessionsTo117(DATA_DIR,database());
  expect(JSON.parse(readFileSync(join(DATA_DIR,'bots.json'),'utf8'))).toEqual([{id:'fixture-bot',tasks:[{id:'fixture-task'}]}]);
  expect(JSON.parse(readFileSync(join(DATA_DIR,'groups.json'),'utf8'))).toEqual([{id:'fixture-group',tasks:[{id:'fixture-room-task'}]}]);
  expect(database().prepare("SELECT name FROM sqlite_schema WHERE name IN ('send_replay_sessions','send_replay_session_nodes')").all()).toEqual([]);
  expect(database().prepare('SELECT * FROM send_replay_exclusions').all()).toEqual(negative);
  expect(database().prepare('SELECT * FROM send_replay_epochs').all()).toEqual(epochs);
  expect(() => downgradeReplaySessionsTo117(DATA_DIR,database())).not.toThrow();
});
it('unreadable retained context aborts the downgrade before any positive replay proof leaves', () => {
  confirm();
  writeFileSync(join(DATA_DIR,'bots.json'),JSON.stringify([{id:'fixture-bot',resumeCursors:{engine:'native'}}]));
  writeFileSync(join(DATA_DIR,'groups.json'),'invalid fixture JSON');
  const before = readFileSync(join(DATA_DIR,'bots.json'),'utf8');
  expect(() => downgradeReplaySessionsTo117(DATA_DIR,database())).toThrow();
  expect(readFileSync(join(DATA_DIR,'bots.json'),'utf8')).toBe(before);
  expect(database().prepare('SELECT count(*) AS n FROM send_replay_sessions').get()?.n).toBe(1);
});
