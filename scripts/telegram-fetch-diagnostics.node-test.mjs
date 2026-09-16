import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeTelegramFetch } from './telegram-fetch-diagnostics.mjs';

test('observer preserves response and exact arguments without recording credentials', async () => {
  const url = 'https://api.telegram.org/botPRIVATE_TOKEN/getMe', options = { method: 'POST', body: '{}' };
  const response = new Response('{}'), records = [];
  const wrapped = observeTelegramFetch(async (actual, init) => { assert.equal(actual, url); assert.equal(init, options); return response; }, value => records.push(value));
  assert.equal(await wrapped(url, options), response);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 200);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TOKEN|https|body/);
});
test('failure records only allowlisted codes and rethrows the original error once', async () => {
  const error = new TypeError('PRIVATE_TOKEN', { cause: { code: 'PRIVATE_TOKEN', errors: [{ code: 'ENETUNREACH', address: 'PRIVATE_TOKEN' }] } });
  const records = []; let calls = 0;
  const wrapped = observeTelegramFetch(async () => { calls++; throw error; }, value => records.push(value));
  await assert.rejects(wrapped('https://api.telegram.org/botPRIVATE_TOKEN/getMe'), actual => actual === error);
  assert.equal(calls, 1);
  assert.equal(records[0].code, 'unclassified');
  assert.deepEqual(records[0].nestedCodes, ['ENETUNREACH']);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TOKEN/);
});
test('unrelated traffic and observer failures do not alter the request', async () => {
  const response = new Response('{}'); let records = 0;
  const wrapped = observeTelegramFetch(async () => response, () => { records++; throw Error('observer'); });
  assert.equal(await wrapped('https://example.invalid/getMe'), response);
  assert.equal(records, 0);
  assert.equal(await wrapped('https://api.telegram.org/botPRIVATE_TOKEN/getMe'), response);
  assert.equal(records, 1);
});
