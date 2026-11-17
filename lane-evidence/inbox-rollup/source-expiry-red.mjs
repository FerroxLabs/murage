// Isolated, fake-only diagnostic for the unresolved source-activation edge.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeInbox, inboxBadgeRequest } from '../../server/inbox.ts';
import { inboxRollupBadgeAccess } from '../../server/inbox-routine-lifecycle.ts';
const NOW = 1_800_000_000_000, WINDOW = 14 * 86_400_000;
let now = NOW;
const clock = Date.now; Date.now = () => now;
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))');
  initializeInbox(db);
  const message = { id: 'queued-card', at: NOW - 1, role: 'bot', kind: 'routine.run', routineRun: {
    runId: 'run', routineId: 'routine', routineName: 'Routine', status: 'failed', summary: '401 unauthorized',
  } };
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('thread', message.id, message.at, message.role, message.kind, '', JSON.stringify(message));
  const run = { id: 'run', routineId: 'routine', routineName: 'Routine', threadId: 'thread', botId: 'bot', target: 'bot', runOn: 'ember',
    scheduledFor: NOW - 1, startedAt: NOW, finishedAt: NOW + 1, createdAt: NOW - 1, manual: true, status: 'failed', error: '401 unauthorized' };
  const source = { listRuns: () => [run] };
  const store = { bots: [{ id: 'bot', name: 'Bot', threadId: 'thread' }], groups: [], bot: () => ({ hidden: false }),
    botByThread: () => ({ hidden: false }), groupByThread: () => undefined, group: () => undefined, onChange: () => () => {} };
  const legacy = () => [{ runId: run.id, routineId: run.routineId, routineName: run.routineName, threadId: run.threadId,
    at: run.startedAt, status: run.status, error: run.error }];
  const request = { method: 'GET', path: '/api/inbox', query: { view: 'decisions', page: 0, pageSize: 1 } };
  inboxRollupBadgeAccess(db, store, source, legacy);
  await new Promise(resolve => setImmediate(resolve));
  now = NOW + WINDOW;
  const expected = inboxBadgeRequest(db, request, { owner: true, threads: [{ threadId: 'thread', label: 'Bot' }], routineRuns: legacy() }).body.decisions;
  const actual = inboxBadgeRequest(db, request, inboxRollupBadgeAccess(db, store, source, legacy)).body.decisions;
  console.log(JSON.stringify({ case: 'card-expires-before-record', expected, actual, cutoff: now - WINDOW, cardAt: message.at, recordAt: run.startedAt }));
  assert.equal(actual, expected, 'expired card must unmask its still-in-window record');
} finally { db.close(); Date.now = clock; }
