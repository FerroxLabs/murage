// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeTempDirSync } from './cleanup.ts';
import { fixtureDisplayApi, fixtureExecutionMessage } from './display-fixture.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'display-fixture-')), path = join(root, 'messages.db');
  const db = new DatabaseSync(path);
  cleanups.push(() => { db.close(); removeTempDirSync(root); });
  db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,json TEXT,thread_id TEXT NOT NULL DEFAULT 'thread')");
  let displayed: any[] = [];
  const sent: any[] = [];
  const add = (id: string, requestId = 'native-request', questions?: any[], thread = 'thread') => {
    const stored = { id, role: 'bot', kind: 'options', text: 'withheld fixture payload', card: { requestId, riskReason: 'pay', tool: questions ? 'AskUserQuestion' : 'Bash', summary: 'fixture command', ...(questions ? { questions } : {}) } };
    db.prepare('INSERT INTO messages(id,json,thread_id) VALUES(?,?,?)').run(id, JSON.stringify(stored), thread);
    return { id, role: 'bot', kind: 'options', text: 'public fixture text', card: { subtitle: 'public caption', requestHandle: `${questions ? 'q' : 'p'}.${id}`, ...(questions ? { questions: questions.map((question, q) => ({ ...question, id: `q.${q}`, handle: `q.${q}`, questionHandle: `q.${q}`, question: '«redacted»', options: question.options.map((_option: any, o: number) => ({ handle: `o.${q}.${o}`, label: `Option ${o + 1}` })) })) } : {}) } };
  };
  displayed = [add('shown')];
  const api = fixtureDisplayApi(() => path, async (method: string, route: string, body?: any, headers?: unknown): Promise<{ status: number; body: any }> => {
    sent.push({ method, route, body, headers });
    return { status: 200, body: method === 'GET' ? { messages: displayed } : { ok: true } };
  });
  const ownWrite = () => {
    const stored = { id: 'host-row', role: 'bot', kind: 'options', text: 'withheld host payload', card: { kind: 'own-write', requestId: 'host-request', writer: { stateRevision: 3, state: 'waiting' } } };
    db.prepare('INSERT INTO messages(id,json) VALUES(?,?)').run(stored.id, JSON.stringify(stored));
    const display = { ...stored, text: 'public host text', card: structuredClone(stored.card) };
    displayed = [display]; return display;
  };
  return { api, sent, add, displayed, ownWrite, show: (rows: any[]) => { displayed = rows; },
    rewrite: (id: string) => {
      const row = db.prepare('SELECT json FROM messages WHERE id=?').get(id)!;
      const stored = JSON.parse(String(row.json)); stored.card.questions[0].options.reverse();
      db.prepare('UPDATE messages SET json=? WHERE id=?').run(JSON.stringify(stored), id);
    },
  };
}

it('uses the observed public handle while preserving raw HTTP and caller headers', async () => {
  const f = fixture(), original = structuredClone(f.displayed);
  const evidence = await f.api('GET', '/api/threads/thread/messages');
  expect(evidence.body.messages[0].card.requestId).toBe('native-request');
  expect(evidence.body.messages[0].card.riskReason).toBe('pay');
  expect(evidence.body.messages[0].text).toBe('public fixture text');
  expect(evidence.body.messages[0].card.subtitle).toBe('public caption');
  expect(evidence.body.messages[0].card.tool).toBeUndefined();
  expect(evidence.body.messages[0].card.summary).toBeUndefined();
  expect(JSON.stringify(evidence)).not.toContain('withheld fixture payload');
  expect(fixtureExecutionMessage(evidence.body.messages[0]).text).toBe('withheld fixture payload');
  expect(() => fixtureExecutionMessage({ id: 'unseen' })).toThrow('not observed on HTTP');
  expect(f.displayed).toEqual(original);
  expect(f.displayed[0].card.requestId).toBeUndefined();
  const headers = { 'x-fixture-caller': 'owner' };
  await f.api('POST', '/api/threads/thread/respond', { requestId: 'native-request', behavior: 'allow' }, headers);
  expect(f.sent.at(-1)).toMatchObject({ body: { requestHandle: 'p.shown', action: 'allow' }, headers });
  expect(f.sent.at(-1).body.requestId).toBeUndefined();
});

it('does not create a handle for a stored request that was never displayed', async () => {
  const f = fixture(), body = { requestId: 'native-request', behavior: 'allow' };
  await f.api('POST', '/api/threads/thread/respond', body);
  expect(f.sent.at(-1).body).toBe(body);
});

it('does not select a newer presentation when a native request id was reused', async () => {
  const f = fixture();
  await f.api('GET', '/api/threads/thread/messages');
  f.show([f.add('replacement')]);
  await f.api('GET', '/api/threads/thread/messages');
  const body = { requestId: 'native-request', behavior: 'allow' };
  await f.api('POST', '/api/threads/thread/respond', body);
  expect(f.sent.at(-1).body).toBe(body);
});

it('rejects a public handle that does not belong to the displayed row', async () => {
  const f = fixture(); f.show([{ ...f.displayed[0], card: { requestHandle: 'p.other' } }]);
  await expect(f.api('GET', '/api/threads/thread/messages')).rejects.toThrow();
});

it('preserves masked question words while reading their execution identity', async () => {
  const f = fixture();
  f.show([f.add('question', 'question-request', [{ id: 'native-question', question: 'withheld question payload', header: 'Heading', options: [{ label: 'withheld option payload' }], multiSelect: false, allowOther: true }])]);
  const evidence = await f.api('GET', '/api/threads/thread/messages');
  const question = evidence.body.messages[0].card.questions[0];
  expect(question.id).toBe('native-question');
  expect(question.question).toBe('«redacted»');
  expect(question.options).toEqual([{ label: 'Option 1' }]);
  expect(JSON.stringify(evidence)).not.toContain('withheld question payload');
  expect(JSON.stringify(evidence)).not.toContain('withheld option payload');
});


it.each(['id', 'handle', 'questionHandle', 'optionHandle', 'optionCount'])(
  'rejects corrupted HTTP question controls: %s', async fault => {
    const f = fixture();
    const display = f.add('question', 'question-request', [{ id: 'native-question', question: 'private question', options: [{ label: 'private option' }], multiSelect: false, allowOther: true }]);
    const question = display.card.questions![0];
    if (fault === 'optionHandle') question.options[0].handle = 'o.0.7';
    else if (fault === 'optionCount') question.options.push({ handle: 'o.0.1', label: 'Option 2' });
    else question[fault as 'id' | 'handle' | 'questionHandle'] = 'q.7';
    f.show([display]);
    await expect(f.api('GET', '/api/threads/thread/messages')).rejects.toThrow();
  },
);

it('submits the question and option handles witnessed on HTTP', async () => {
  const f = fixture();
  const display = f.add('question', 'question-request', [{ id: 'native-question', question: 'private question', options: [{ label: 'first private option' }, { label: 'second private option' }], multiSelect: true, allowOther: true }]);
  f.show([display]);
  await f.api('GET', '/api/threads/thread/messages');
  const shown = structuredClone(display.card.questions![0]);
  f.rewrite('question');
  // The fixture transport can recycle its response object after the GET.
  display.card.questions![0].questionHandle = 'q.changed';
  display.card.questions![0].options[1].handle = 'o.changed';
  await f.api('POST', '/api/threads/thread/respond', { requestId: 'question-request', behavior: 'allow', answers: [{ id: 'native-question', selected: ['second private option'], other: 'fixture note' }] });
  expect(f.sent.at(-1).body).toEqual({ requestHandle: display.card.requestHandle, action: 'allow', answers: [{ questionHandle: shown.questionHandle, optionHandles: [shown.options[1].handle], other: 'fixture note' }] });
});


it('preserves the separate host own-write protocol without minting an execution handle', async () => {
  const f = fixture(), display = f.ownWrite();
  const result = await f.api('GET', '/api/threads/thread/messages');
  expect(result.body.messages[0]).toEqual(display);
  expect(JSON.stringify(result)).not.toContain('withheld host payload');
  const body = { requestId: 'host-request', action: 'allow', stateRevision: 3 };
  await f.api('POST', '/api/threads/thread/own-write', body);
  expect(f.sent.at(-1).body).toBe(body);
});

it('preserves a forged legacy task key on the original HTTP request', async () => {
  const f = fixture(); await f.api('GET', '/api/threads/thread/messages');
  const body = { requestId: 'native-request', behavior: 'allow', taskAllowKey: 'forged-fixture-key' };
  await f.api('POST', '/api/threads/thread/respond', body);
  expect(f.sent.at(-1).body).toBe(body);
});


it('keeps a reused native id scoped to each witnessed conversation', async () => {
  const f = fixture(), first = f.displayed[0], other = f.add('other-shown', 'native-request', undefined, 'other-thread');
  f.show([first, other]);
  await f.api('GET', '/api/bots');
  expect(first.card).not.toHaveProperty('requestId'); expect(other.card).not.toHaveProperty('requestId');
  await f.api('POST', '/api/threads/thread/respond', { requestId: 'native-request', behavior: 'allow' });
  expect(f.sent.at(-1).body).toEqual({ requestHandle: first.card.requestHandle, action: 'allow' });
  await f.api('POST', '/api/threads/other-thread/respond', { requestId: 'native-request', behavior: 'deny' });
  expect(f.sent.at(-1).body).toEqual({ requestHandle: other.card.requestHandle, action: 'deny' });
  const unseen = { requestId: 'native-request', behavior: 'allow' };
  await f.api('POST', '/api/threads/unseen-thread/respond', unseen);
  expect(f.sent.at(-1).body).toBe(unseen);
});


it.each(['requestHandle', 'action'])('preserves mixed legacy and opaque controls: %s', async key => {
  const f = fixture(); await f.api('GET', '/api/threads/thread/messages');
  const body = { requestId: 'native-request', behavior: 'allow', [key]: key === 'action' ? 'deny' : 'p.other' };
  await f.api('POST', '/api/threads/thread/respond', body);
  expect(f.sent.at(-1).body).toBe(body);
});
