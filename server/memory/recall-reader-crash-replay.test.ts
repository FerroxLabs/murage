// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: B2 recall-reader-crash. Replay primitive consumer owner: new3-g5; MAIN integrates.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { FreshReplaySessionConfirmation, withCurrentReplaySessionChange } from './fresh-replay-session.ts';
import { captureSendReplayProof, currentSendReplaySessionProof, extendConfirmedReplayProof, sendReplaySessionCurrent } from './replay-lineage.ts';
import { ReleaseBudget, withReleaseBudgets } from './release-budget.ts';
import { sessionKeyOf } from './session-incarnation.ts';

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec("INSERT INTO send_replay_epochs VALUES('chat',1)");
});
afterEach(() => closeDatabase());
const key = () => sessionKeyOf('chat', 'engine', 'native', 2);
const current = () => sendReplaySessionCurrent('chat', 'engine', key().nativeSession);
function row(id: string, text = id) {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,1,'user','text',?,?)")
    .run(id, text, JSON.stringify({ id, text }));
}
function retained(history: number) {
  const ids = Array.from({ length: history }, (_, i) => `history-${i}`);
  for (const id of ids) row(id);
  const first = new FreshReplaySessionConfirmation(captureSendReplayProof('chat', ids), 'engine', () => {}, { generation: 'first-generation' });
  first.accepted('first-turn'); first.engineWritten(); first.sessionStarted('first-turn', key(), true);
  withCurrentReplaySessionChange('chat', 'engine', key().nativeSession, ['killed-input'], () => {
    row('killed-input', 'private cancelled fixture words');
    database().exec("INSERT INTO send_replay_exclusions VALUES('chat','killed-input',NULL,'not_submitted',1); UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  });
  closeDatabase(); database();
  expect(current()).toBe(true);
  return currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!;
}

const statements: number[] = [];
it.each([1, 16, 256])('accepts after restart at history %i without retaining excluded bytes', history => {
  retained(history); row('next-input'); row('withheld-root');
  const proof = captureSendReplayProof('chat', ['killed-input'], new Map([
    ['killed-input', [{ threadId: 'chat', messageId: 'withheld-root' }]],
  ]));
  expect(proof.excludedIds.has('killed-input')).toBe(true);
  const next = new FreshReplaySessionConfirmation(proof, 'engine', () => {},
    { ownMessageIds: ['next-input'], retainedSession: key().nativeSession, generation: 'next-generation' });
  next.engineWritten();
  const budget = new ReleaseBudget(() => { throw new Error('unexpected release exhaustion'); });
  withReleaseBudgets([budget], () => next.accepted('next-turn'));
  statements.push(budget.counts.statements);
  expect(budget.counts.statements).toBeGreaterThan(0);
  expect(budget.counts.statements).toBeLessThanOrEqual(24);
  expect(statements.every(n => n === statements[0])).toBe(true);
  expect(current()).toBe(true);
  for (const reopened of [false, true]) {
    if (reopened) { closeDatabase(); database(); }
    const kept = currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!;
    expect(kept.messageIds).toHaveLength(history + 1);
    expect(kept.messageIds).toContain('next-input');
    expect(kept.messageIds).not.toContain('killed-input');
    expect(kept.copyRoots.has('killed-input')).toBe(false);
    const bytes = database().prepare("SELECT text FROM messages WHERE thread_id='chat' AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
      .all(JSON.stringify(kept.messageIds)).map(r => r.text).join('\n');
    expect(bytes).toContain('next-input');
    expect(bytes).not.toContain('private cancelled fixture words');
  }
  const durable = JSON.stringify({
    base: database().prepare('SELECT proof FROM send_replay_sessions').all(),
    delta: database().prepare('SELECT kind,node_key,json FROM send_replay_session_nodes').all(),
  });
  expect(durable).not.toContain('killed-input');
  expect(durable).not.toContain('withheld-root');
  expect(database().prepare("SELECT reason FROM send_replay_exclusions WHERE message_id='killed-input'").get()?.reason).toBe('not_submitted');
});

it.each([1, 16, 256])('an unknown excluded input still refuses at history %i', history => {
  const kept = retained(history); row('unknown-input');
  withCurrentReplaySessionChange('chat', 'engine', key().nativeSession, ['unknown-input'], () => {
    database().exec("INSERT INTO send_replay_exclusions VALUES('chat','unknown-input',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=3 WHERE thread_id='chat'");
  });
  const currentKept = currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!;
  const proof = captureSendReplayProof('chat', ['killed-input']);
  expect(proof.excludedIds.has('unknown-input')).toBe(false);
  expect(() => transaction(() => extendConfirmedReplayProof(currentKept, proof, ['unknown-input']))).toThrow('SEND_REPLAY_CHANGED');
  expect(currentSendReplaySessionProof('chat', 'engine', key().nativeSession)!.messageIds).toEqual(kept.messageIds);
});

it.each([1, 16, 256])('changed history still refuses at history %i', history => {
  const kept = retained(history), proof = captureSendReplayProof('chat', ['killed-input']);
  database().exec("INSERT INTO send_replay_exclusions VALUES('chat','history-0',NULL,'uncertain',1); UPDATE send_replay_epochs SET revision=3 WHERE thread_id='chat'");
  expect(() => transaction(() => extendConfirmedReplayProof(kept, proof, []))).toThrow('SEND_REPLAY_CHANGED');
  expect(current()).toBe(false);
});

it.each([1, 16, 256])('a positively excluded owned input still refuses at history %i', history => {
  const kept = retained(history), proof = captureSendReplayProof('chat', ['killed-input']);
  expect(() => transaction(() => extendConfirmedReplayProof(kept, proof, ['killed-input']))).toThrow('SEND_REPLAY_CHANGED');
});
