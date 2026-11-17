// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owners: MAIN (terminal dispatch), recall-fix-i (capture); consumer owner: recall-fix-h (native bounds).
import { beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ioBudget } from '../io-budget.ts';
import * as native from '../io-meter.ts';
import * as chunks from './chunks.ts';
import { captureSource } from './capture.ts';
import { materializeTerminalMemory } from './terminal.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

beforeEach(() => {
  freshDataDir('active');
  new WritetimeFixture(database()).cert(true).ready(THREAD, true);
});

it.each([128, 65536, 2 * 65536, 2 * 65536 + 1])('native terminal input of %i bytes retains the shared time, slice and physical ceilings', bytes => {
  const db = database(), messageId = 'terminal', sourceId = `message:${THREAD}:${messageId}`;
  // The bound includes JSON metadata; put the payload exactly on either side of it.
  const metadataBytes = Buffer.byteLength(JSON.stringify({ text: '', kind: 'text', speaker: 'assistant', outcome: 'recorded' }));
  const text = 'x'.repeat(bytes - metadataBytes);
  storeAnchorMessage(db, THREAD, messageId, text, 'bot');
  captureSource(db, { id: sourceId, threadId: THREAD, messageId, turnId: 'turn', kind: 'text', speaker: 'assistant', outcome: 'recorded', text });
  expect(db.prepare('SELECT octet_length(payload) AS n FROM memory_source_versions WHERE source_id=?').get(sourceId)!.n).toBe(bytes);
  const registry = new InternalCapabilities(), generation = registry.begin('bot', THREAD);
  registry.bindProviderTurn(THREAD, generation, 'turn');
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, kind: 'memory', depth: 0, skillAuthoring: false });
  const claim = registry.resolve(`Bearer ${token}`)!;
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db), capture = chunks.captureWork;
  const finish = native.endBgGrant, nativeMs: number[] = [], payloads: number[] = [];
  const grants: ReturnType<typeof finish>[] = [];
  const measure = <T>(work: () => T): T => {
    const start = performance.now();
    try { return work(); } finally { nativeMs.push(performance.now() - start); }
  };
  const prepared = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ['get', 'all', 'run'] as const) {
      const original = statement[method].bind(statement);
      Reflect.set(statement, method, (...args: unknown[]) => measure(() => Reflect.apply(original, statement, args)));
    }
    return statement;
  });
  const executed = vi.spyOn(db, 'exec').mockImplementation(sql => measure(() => exec(sql)));
  const captured = vi.spyOn(chunks, 'captureWork').mockImplementation(work => {
    payloads.push(Buffer.byteLength(work.text));
    return capture(work);
  });
  const ended = vi.spyOn(native, 'endBgGrant').mockImplementation(() => { const state = finish(); grants.push(state); return state; });
  let result: ReturnType<typeof materializeTerminalMemory>, elapsed = 0;
  const started = performance.now();
  try { result = materializeTerminalMemory(registry, claim, messageId); }
  finally { elapsed = performance.now() - started; prepared.mockRestore(); executed.mockRestore(); captured.mockRestore(); ended.mockRestore(); }
  const job = db.prepare('SELECT status,cursor,coverage FROM memory_jobs WHERE source_id=?').get(sourceId)!;
  console.log(JSON.stringify({ bytes, elapsed, nativeOperations: nativeMs.length, maxNativeMs: Math.max(...nativeMs), payloads, grants, result: result! }));
  expect(nativeMs.length).toBeGreaterThan(0);
  expect(Math.max(...nativeMs), 'each native operation stays inside the existing 25 ms window').toBeLessThanOrEqual(25);
  expect(elapsed, 'claim, capture, publication and checkpoint share one 25 ms window').toBeLessThanOrEqual(25);
  expect(payloads.length).toBeLessThanOrEqual(2);
  for (const payload of payloads) expect(payload).toBeLessThanOrEqual(65536);
  expect(payloads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(2 * 65536);
  for (const grant of grants) {
    expect(grant.capBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(grant.usedBytes).toBeLessThanOrEqual(grant.capBytes);
    expect(grant.rawBytes).toBeLessThanOrEqual(grant.capBytes);
    expect(grant.refusedWrites).toBe(0);
  }
  expect(native.ioGrantSnapshot().live).toBe(false);
  expect(ioBudget.admissionState().reserved).toBe(0);
  if (bytes === 128) {
    expect(result!).toBe('complete');
    expect(job.status).toBe('complete');
    expect(grants.some(grant => grant.usedBytes > 0 && grant.rawBytes > 0)).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(1);
  }
  if (bytes > 2 * 65536) {
    expect(result!).toBe('pending');
    expect(payloads).toEqual([]);
    expect(grants).toEqual([]);
    expect(job).toMatchObject({ status: 'pending', cursor: 0 });
  }
  if (result! === 'complete') {
    const coverage = JSON.parse(String(job.coverage));
    expect(coverage.throughByte).toBe(coverage.totalBytes);
    expect(coverage.totalBytes).toBe(Buffer.byteLength(text));
  } else expect(job.status).not.toMatch(/^(complete|failed|cancelled)$/);
  registry.completeProviderTurn(THREAD, 'turn');
  expect(() => materializeTerminalMemory(registry, claim, messageId)).toThrow('MEMORY_UNAUTHORIZED');
});
