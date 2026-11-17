// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import { expect, vi } from 'vitest';
import { initializeProjectTables } from '../project-tables.ts';
import { source, wiring, routine } from './fixture.ts';
export const helpers = ['chainIds', 'awaitSharedChainSaves', 'governingSharedSource', 'sharedSourceIdentity', 'heldKeys', 'retireSharedKeys', 'retireForCompletion'];
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function deferred() { let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; }); return { done, resolve }; }
export function fixture() {
  const db = new DatabaseSync(':memory:');
  initializeProjectTables(db);
  const saved = new Map<string, any>(), saves = new Map<string, any>();
  const ops = { statements: 0, rows: 0, reads: 0, lists: 0, examined: 0, deletes: 0, lookups: 0 };
  const sqlSet = new Set<string>();
  const database = () => ({ prepare(sql: string) {
    sqlSet.add(sql);
    const statement = db.prepare(sql);
    return {
      all(...args: any[]) { ops.statements++; const rows = statement.all(...args); ops.rows += rows.length; return rows; },
      get(...args: any[]) { ops.statements++; const row = statement.get(...args); ops.rows += Number(!!row); return row; },
    };
  } });
  const key = (id: string, kind = 'background-job') => ({ botId: 'source', id: kind === 'background-job' ? `shared-peer:${id}` : id, kind, threadId: 's' });
  function insert(id: string, state = 'done', verb = 'ask', parent?: string, capture = false, group = 'g') {
    db.prepare(`INSERT INTO room_requests(id,root_id,parent_id,group_id,verb,from_kind,from_bot_id,origin,root_thread_id,audience_fingerprint,not_owner_audience,unattended,admission_key,state,created_at) VALUES (?,?,?,?,?,'bot','source','server','s','owner',0,0,?,?,0)`)
      .run(id, 'root', parent ?? null, group, verb, id, state);
    if (capture) saved.set(JSON.stringify(key(id)), { actor: 'owner-routine', initiator: { ...routine, sourceRunId: id } });
    return row(id);
  }
  function row(id: string): any { const r = db.prepare('SELECT * FROM room_requests WHERE id=?').get(id); return r && { ...r, parentId: r.parent_id, fromBotId: r.from_bot_id, groupId: r.group_id }; }
  const canonical = (k: any) => JSON.stringify(Object.fromEntries(Object.entries(k).sort(([a], [b]) => a.localeCompare(b))));
  const globals: any = {
    database, decisionSharedSaves: saves, sharedRetireCursor: undefined, sharedRetireRunning: false,
    readContinuation: vi.fn((k: any) => { ops.reads++; return saved.get(canonical(k)); }),
    deleteContinuation: vi.fn((k: any) => { ops.deletes++; saved.delete(canonical(k)); return Promise.resolve(); }),
    listContinuations: vi.fn((filter: any) => {
      ops.lists++;
      // Ordered partial-index double: only namespace entries are examined, with
      // one lookahead. Unrelated S1 key families never enter this index.
      const keys = [...saved.keys()].sort().filter(k => { const x = JSON.parse(k); return x.kind === filter.kind && x.id.startsWith('shared-peer:') && filter.namespace === 'shared-peer' && (!filter.after || k > filter.after); }).slice(0, filter.limit + 1);
      ops.examined += keys.length;
      const page = keys.slice(0, filter.limit);
      return { keys: page.map(k => JSON.parse(k)), ...(keys.length > filter.limit ? { next: page.at(-1) } : {}) };
    }),
    requestSourceThread: () => 's',
    roomRequest: (_db: any, id: string) => {
      ops.lookups++;
      const r = database().prepare('SELECT * FROM room_requests WHERE id=?').get(id) as any;
      return r ? { ...r, parentId: r.parent_id, fromBotId: r.from_bot_id, groupId: r.group_id } : null;
    },
    isTerminalRoomRequestState: (s: string) => ['done', 'failed', 'expired', 'cancelled', 'unknown'].includes(s),
    store: { group: () => undefined, bot: () => ({}) }, queueMicrotask,
    dropDelegationsOf: vi.fn(), roomRequestsChanged: vi.fn(), interruptRequestTurns: vi.fn(), pumpRoomDispatcher: vi.fn(),
    sharedQueuedCeiling: () => ({ permissionMode: 'auto', triggerSource: 'schedule' }),
    peerRoutineTurnOptions: (_a: any, _b: any, _c: any, queued: any) => queued,
    sharedRequestEventId: () => undefined, requestRunCoordination: () => undefined,
    console: { error: vi.fn() },
  };
  function make() {
    return wiring(['retireDecisionSharedSources', 'sharedTurnOptions', 'afterRoomCompletion', ...helpers.filter(n => source.includes('function ' + n + '('))], globals);
  }
  function plan() {
    for (const sql of sqlSet) {
      expect(sql).not.toMatch(/WITH RECURSIVE/i);
      const args = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'g');
      const details = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(r => String(r.detail)).join('\n');
      expect(details).not.toMatch(/SCAN room_requests|USE TEMP B-TREE/);
      for (const line of details.split('\n').filter(l => /room_requests/.test(l))) expect(line).toMatch(/SEARCH room_requests USING (?:INDEX room_requests_group_state|INDEX sqlite_autoindex_room_requests_1|PRIMARY KEY)/);
    }
  }
  return { db, saved, saves, ops, sqlSet, globals, key, insert, row, make, plan, close: () => db.close() };
}
