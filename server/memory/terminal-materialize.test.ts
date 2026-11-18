// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-f. Consumer owner: MAIN (Amendment A bounds).
import { beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { database, transaction } from '../database.ts';
import { holdWritersForIndexBuild } from '../db-busy.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ioBudget } from '../io-budget.ts';
import { beginBgGrant, endBgGrant, ioGrantSnapshot, ioMeterSqlDeadline, ioMeterWallTime } from '../io-meter.ts';
import * as native from '../io-meter.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import * as cpu from './chunks.ts';
import { claimMemoryJob, MEMORY_CLAIM_SQL, publishMemoryWork } from './jobs.ts';
import { materializeTerminalMemory } from './terminal.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

beforeEach(() => {
  freshDataDir('active');
  new WritetimeFixture(database()).cert(true).ready(THREAD, true);
});

function turn(text = 'The fixture gate is green.', messageId = 'terminal', orphanMs?: number) {
  const db = database();
  storeAnchorMessage(db, THREAD, messageId, text, 'bot');
  captureSource(db, { id: `message:${THREAD}:${messageId}`, threadId: THREAD, messageId, turnId: 'turn', kind: 'text', speaker: 'assistant', outcome: 'recorded', text });
  const now = ioMeterWallTime();
  const registry = new InternalCapabilities(orphanMs === undefined ? {} : { now: () => now, orphanMs }), generation = registry.begin('bot', THREAD);
  registry.bindProviderTurn(THREAD, generation, 'turn');
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, kind: 'memory', depth: 0, skillAuthoring: false });
  return { registry, claim: registry.resolve(`Bearer ${token}`)!, generation };
}
const jobs = () => database().prepare('SELECT source_id,status,cursor FROM memory_jobs ORDER BY rowid').all();

it('an already complete exact job reconciles its receipt without duplicating records or moving the head', () => {
  const t = turn(), w = claimMemoryJob('other')!, db = database();
  publishMemoryWork(w, 'other', captureWork(w));
  expect(refreshMemoryCheckpoint(w.id).status).toBe('updated');
  const records = db.prepare('SELECT * FROM memory_records ORDER BY id,version').all(), head = db.prepare('SELECT * FROM memory_checkpoint_heads').get();
  expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('complete');
  expect(db.prepare('SELECT * FROM memory_records ORDER BY id,version').all()).toEqual(records);
  expect(db.prepare('SELECT * FROM memory_checkpoint_heads').get()).toEqual(head);
  expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(1);
});

it('materializes only the exact terminal source, without claiming old work or a view', () => {
  captureSource(database(), { id: 'old-prompt', threadId: THREAD, kind: 'text', speaker: 'owner', outcome: 'recorded', text: 'Older work.' });
  const t = turn(), before = Number(database().prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  let outcome: 'complete' | 'pending' | undefined;
  expect(() => { outcome = materializeTerminalMemory(t.registry, t.claim, 'terminal'); }).not.toThrow();
  expect(outcome).toBe('complete');
  expect(jobs()).toEqual([expect.objectContaining({ source_id: 'old-prompt', status: 'pending', cursor: 0 }), expect.objectContaining({ source_id: `message:${THREAD}:terminal`, status: 'complete' })]);
  expect(database().prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n).toBe(before);
  expect(database().prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(1);
  t.registry.completeProviderTurn(THREAD, 'turn');
  expect(() => materializeTerminalMemory(t.registry, t.claim, 'terminal')).toThrow('MEMORY_UNAUTHORIZED');
});

it('compiles repeated terminal authority queries once and executes each check', () => {
  const t = turn(), db = database();
  const prepare = vi.spyOn(db, 'prepare');
  try {
    expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('complete');
    const statements = prepare.mock.calls.flatMap(([sql], index) =>
      sql.startsWith('SELECT s.*,octet_length(v.payload) AS payload_bytes')
        ? [prepare.mock.results[index]!.value] : []);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(statements[1]);
  } finally { prepare.mockRestore(); }
});

it('true idle refuses even with byte room; a duplicate delivery cannot buy another allowance', () => {
  const t = turn();
  ioBudget.setIsIdle(() => true);
  try {
    expect(ioBudget.backgroundRoom()).toBeGreaterThan(0);
    expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
  } finally { ioBudget.setIsIdle(() => false); }
  expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
  expect(jobs()[0]).toMatchObject({ status: 'pending', cursor: 0 });
});

it('a source above two slices stays partial with exact coverage and no checkpoint', () => {
  const t = turn('x'.repeat(3 * 65536));
  expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
  expect(Number(jobs()[0]!.cursor)).toBeLessThanOrEqual(2 * 65536);
  expect(jobs()[0]!.status).not.toBe('complete');
  expect(database().prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(0);
});

it('a held writer gate gives up without claiming, waiting or consuming an attempt', () => {
  const t = turn();
  holdWritersForIndexBuild(true);
  try { expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending'); }
  finally { holdWritersForIndexBuild(false); }
  expect(database().prepare('SELECT status,attempts,lease_generation FROM memory_jobs').get()).toMatchObject({ status: 'pending', attempts: 0, lease_generation: 0 });
});

it('a real foreign writer lock is zero-wait and leaves the source recoverable', () => {
  const t = turn(), writer = new DatabaseSync(join(DATA_DIR, 'messages.db'));
  writer.exec('BEGIN IMMEDIATE');
  const start = ioMeterWallTime();
  try {
    expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
    expect(ioMeterWallTime() - start).toBeLessThanOrEqual(25);
    expect(jobs()[0]).toMatchObject({ status: 'pending', cursor: 0 });
  } finally { writer.exec('ROLLBACK'); writer.close(); }
});

it.each(['transaction', 'native-grant'])('cannot borrow an enclosing %s or its allowance', enclosing => {
  const t = turn();
  if (enclosing === 'transaction') {
    expect(transaction(() => materializeTerminalMemory(t.registry, t.claim, 'terminal'))).toBe('pending');
  } else {
    beginBgGrant({ bytes: 1024 * 1024, expiresAt: ioMeterWallTime() + 1000 });
    try { expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending'); }
    finally { endBgGrant(); }
  }
  expect(jobs()[0]).toMatchObject({ status: 'pending', cursor: 0 });
});

it('even tiny claim slices cannot acquire a third slice', () => {
  const t = turn('abc'), db = database(), prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => prepare(sql === MEMORY_CLAIM_SQL.payload ? sql.replace('65536', '1') : sql));
  try {
    expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
    expect(jobs()[0]).toMatchObject({ status: 'partial', cursor: 2 });
  } finally { spy.mockRestore(); }
});

it('does not steal a lease or publish a withdrawn source', () => {
  const t = turn(), work = claimMemoryJob('other')!;
  expect(work).toBeTruthy();
  expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending');
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(work.sourceId);
  expect(() => publishMemoryWork(work, 'other', captureWork(work))).toThrow('STALE_MEMORY_SOURCE');
  expect(database().prepare('SELECT count(*) AS n FROM memory_records').get()!.n).toBe(0);
});

it.each(['before-claim', 'before-publication'])('write-time source withdrawal %s prevents materialization', cut => {
  const t = turn(), db = database(), withdraw = () => new WritetimeFixture(db).denyMemory('source', `message:${THREAD}:terminal`, 1);
  const capture = cpu.captureWork;
  if (cut === 'before-claim') withdraw();
  const spy = vi.spyOn(cpu, 'captureWork').mockImplementation(work => {
    if (cut === 'before-publication') withdraw();
    return capture(work);
  });
  try { expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending'); }
  finally { spy.mockRestore(); }
  expect(jobs()[0]!.status).not.toBe('complete');
  expect(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(0);
});

it('a revoked capability refuses before memory reads or writes', () => {
  const t = turn(), prepare = vi.spyOn(database(), 'prepare'), before = jobs();
  t.registry.revokeGeneration(THREAD, t.generation);
  prepare.mockClear();
  expect(() => materializeTerminalMemory(t.registry, t.claim, 'terminal')).toThrow('MEMORY_UNAUTHORIZED');
  expect(prepare).not.toHaveBeenCalled();
  expect(jobs()).toEqual(before);
  prepare.mockRestore();
});

it('missing native deadline enforcement leaves the exact job pending', () => {
  const t = turn(), spy = vi.spyOn(native, 'ioMeterSqlDeadline').mockReturnValue(false);
  try { expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending'); }
  finally { spy.mockRestore(); }
  expect(jobs()[0]).toMatchObject({ status: 'pending', cursor: 0 });
});

it('a stricter outer deadline expiring during claim starts no CPU capture', () => {
  const t = turn(), db = database(), prepare = db.prepare.bind(db), actualWall = native.ioMeterWallTime;
  const deadline = actualWall() + 20;
  let afterClaim = false;
  const clock = vi.spyOn(native, 'ioMeterWallTime').mockImplementation(() => afterClaim ? deadline + 1 : actualWall());
  const capture = vi.spyOn(cpu, 'captureWork');
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql === MEMORY_CLAIM_SQL.payload) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { const row = Reflect.apply(get, statement, args); afterClaim = true; return row; };
    }
    return statement;
  });
  try {
    expect(ioBudget.withSyncSource('fixture-outer', () => materializeTerminalMemory(t.registry, t.claim, 'terminal'), deadline)).toBe('pending');
    expect(afterClaim).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); capture.mockRestore(); clock.mockRestore(); }
  expect(jobs()[0]!.status).not.toBe('complete');
  expect(db.prepare('SELECT count(*) AS n FROM memory_records').get()!.n).toBe(0);
});

it('native expiry interrupts a running SQL statement before it completes', () => {
  expect(ioMeterSqlDeadline()).toBe(true);
  const start = ioMeterWallTime();
  database().prepare('SELECT murage_grant_deadline(1)').get();
  beginBgGrant({ bytes: 1024 * 1024, expiresAt: start + 5 });
  try {
    expect(() => database().prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n').get()).toThrow(/interrupt/i);
    expect(ioMeterWallTime() - start).toBeLessThanOrEqual(25);
  } finally { endBgGrant(); database().prepare('SELECT murage_grant_deadline(0)').get(); }
  expect(database().prepare('SELECT 1 AS n').get()!.n).toBe(1);
});

it.each([undefined, 20])('the terminal admission interrupts a slow claim within the shared window (remaining %s)', remaining => {
  const t = turn('The fixture gate is green.', 'terminal', remaining), db = database(), prepare = db.prepare.bind(db);
  const actualBegin = native.beginBgGrant, actualWall = native.ioMeterWallTime, expirations: number[] = [];
  let started: number | undefined;
  const wall = vi.spyOn(native, 'ioMeterWallTime').mockImplementation(() => { const at = actualWall(); started ??= at; return at; });
  const begin = vi.spyOn(native, 'beginBgGrant').mockImplementation(ticket => { expirations.push(ticket.expiresAt); actualBegin(ticket); });
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql === MEMORY_CLAIM_SQL.payload) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n').get();
        return Reflect.apply(get, statement, args);
      };
    }
    return statement;
  });
  try { expect(materializeTerminalMemory(t.registry, t.claim, 'terminal')).toBe('pending'); }
  finally { spy.mockRestore(); wall.mockRestore(); begin.mockRestore(); }
  expect(started).toBeDefined();
  expect(expirations.length).toBeGreaterThan(0);
  for (const expiry of expirations) expect(expiry).toBeLessThanOrEqual(Math.min(started! + 25, t.claim.expiresAt));
  expect(jobs()[0]).toMatchObject({ status: 'pending', cursor: 0 });
  expect(ioGrantSnapshot().live).toBe(false);
  expect(ioBudget.admissionState().reserved).toBe(0);
});

it('an oversized legacy checkpoint is not hydrated or replaced by the bounded terminal refresh', () => {
  const first = turn();
  expect(materializeTerminalMemory(first.registry, first.claim, 'terminal')).toBe('complete');
  const db = database(), head = db.prepare('SELECT * FROM memory_checkpoint_heads').get()!;
  db.prepare('UPDATE memory_checkpoint_members SET handles=? WHERE record_id=? AND record_version=?')
    .run(JSON.stringify(Array.from({length: 5000}, (_, n) => ({sourceId: `legacy-${n}`, revision: 1, startByte: 0, endByte: 1}))), head.record_id, head.record_version);
  const second = turn('The fixture shed is blue.', 'second'), prepare = db.prepare.bind(db);
  let hydrated = 0;
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql), get = statement.get.bind(statement);
    statement.get = (...args) => {
      const row = Reflect.apply(get, statement, args);
      if (typeof row?.handles === 'string') hydrated += Buffer.byteLength(row.handles);
      return row;
    };
    return statement;
  });
  try { expect(materializeTerminalMemory(second.registry, second.claim, 'second')).toBe('pending'); }
  finally { spy.mockRestore(); }
  expect(hydrated).toBe(0);
  expect(jobs().at(-1)).toMatchObject({ status: 'pending', cursor: 0 });
  expect(db.prepare('SELECT * FROM memory_checkpoint_heads').get()).toEqual(head);
  expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()!.n).toBe(1);
});
