// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: MAIN (terminal); consumer owner: recall-fix-h (uninstrumented window).
import { beforeEach, expect, it } from 'vitest';
import { database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { captureSource } from './capture.ts';
import { materializeTerminalMemory } from './terminal.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

beforeEach(() => {
  freshDataDir('active');
  new WritetimeFixture(database()).cert(true).ready(THREAD, true);
});

it.each([128, 65536, 2 * 65536, 2 * 65536 + 1])('the uninstrumented %i-byte terminal attempt shares one 25 ms window', bytes => {
  const db = database(), sourceId = `message:${THREAD}:terminal`;
  const text = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify({ text: '', kind: 'text', speaker: 'assistant', outcome: 'recorded' })));
  storeAnchorMessage(db, THREAD, 'terminal', text, 'bot');
  captureSource(db, { id: sourceId, threadId: THREAD, messageId: 'terminal', turnId: 'turn', kind: 'text', speaker: 'assistant', outcome: 'recorded', text });
  expect(db.prepare('SELECT octet_length(payload) AS n FROM memory_source_versions WHERE source_id=?').get(sourceId)!.n).toBe(bytes);
  const registry = new InternalCapabilities(), generation = registry.begin('bot', THREAD);
  registry.bindProviderTurn(THREAD, generation, 'turn');
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, kind: 'memory', depth: 0, skillAuthoring: false });
  const claim = registry.resolve(`Bearer ${token}`)!;
  const start = performance.now();
  const result = materializeTerminalMemory(registry, claim, 'terminal');
  const elapsed = performance.now() - start;
  console.log(JSON.stringify({ bytes, elapsed, result }));
  expect(elapsed).toBeLessThanOrEqual(25);
  const job = db.prepare('SELECT status,coverage FROM memory_jobs WHERE source_id=?').get(sourceId)!;
  if (bytes === 128) expect(result).toBe('complete');
  if (bytes > 2 * 65536) expect(result).toBe('pending');
  if (result === 'complete') {
    const coverage = JSON.parse(String(job.coverage));
    expect(coverage.throughByte).toBe(coverage.totalBytes);
    expect(coverage.totalBytes).toBe(Buffer.byteLength(text));
  } else expect(job.status).not.toMatch(/^(complete|failed|cancelled)$/);
});
