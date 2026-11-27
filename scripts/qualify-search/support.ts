import { evidencePath } from '../evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { expect } from 'vitest';
import * as search from '../../server/message-search-index.ts';
import { DATA_DIR } from '../../server/config.ts';
import { closeDatabase, database } from '../../server/database.ts';
import { deleteThread, insertMessage } from '../../server/message-db.ts';
import { stopWalMaintenance } from '../../server/wal-maintenance.ts';

export { search, DATA_DIR, database, insertMessage, deleteThread };
export const smoke = process.env.MURAGE_QUAL_SMOKE === '1';
export const failBar = process.env.MURAGE_QUAL_FAIL_BAR;
export const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export type Event = { type: string; [key: string]: unknown };
export type Recovery = { state: string; consecutive: number; windowCount: number };
export const hooks = search.searchIndexTestHooks as typeof search.searchIndexTestHooks & {
  recovery?: (db: DatabaseSync) => Recovery;
};
export function recovery(db: DatabaseSync): Recovery | undefined { return hooks.recovery?.(db); }
export function rng(seed = 0x1019) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}
export function quantile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
export function stats(values: number[]) {
  return { n: values.length, p99: quantile(values, .99), max: values.length ? Math.max(...values) : null };
}
export async function until(test: () => boolean, id: string, ms = smoke ? 15_000 : 60_000) {
  const end = performance.now() + ms;
  while (!test() && performance.now() < end) await pause(20);
  expect(test(), 'ORACLE:' + id).toBe(true);
}
export function bytes(file: string) { return existsSync(file) ? statSync(file).size : 0; }
export function json(file: string, value: unknown) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export class Report {
  readonly pass: Record<string, boolean> = {};
  readonly computedPass: Record<string, boolean> = {};
  raw: Record<string, unknown> = {};
  readonly leg: string;
  constructor(leg: string) { this.leg = leg; }
  bar(id: string, value: boolean) { this.computedPass[id] = value; this.pass[id] = value; }
  finish() {
    if (failBar) expect(Object.hasOwn(this.pass, failBar), 'unknown injected bar').toBe(true);
    const file = evidencePath(this.leg + '.json', process.env.MURAGE_QUAL_EVIDENCE ?? evidencePath('evidence/r4'));
    json(file, { schema: 1, leg: this.leg, qualification: !smoke, smoke, injectedBar: failBar, raw: this.raw, computedPass: this.computedPass, pass: this.pass });
    expect(Object.entries(this.pass).filter(([, pass]) => !pass), 'ORACLE:' + this.leg).toEqual([]);
  }
}
export function observer(file = join(DATA_DIR, 'search.db')) {
  const db = new DatabaseSync(file);
  excluded.add(db); db.exec('PRAGMA busy_timeout=0');
  return db;
}
export function state(db: DatabaseSync, key: string) { return db.prepare('SELECT v FROM search_state WHERE k=?').get(key)?.v; }
export function healthy(db: DatabaseSync) {
  if (!search.messageSearchIndexReady(db)) return false;
  const r = recovery(db);
  if (r && r.state !== 'HEALTHY') return false;
  if (!existsSync(join(DATA_DIR, 'search.db'))) return false;
  const a = observer();
  try {
    return state(a, 'built') === undefined && Number(state(a, 'applied_seq')) >=
      Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM search_intents').get()!.n);
  } catch { return false; } finally { a.close(); }
}
export function pending(db: DatabaseSync) {
  let applied = 0;
  if (existsSync(join(DATA_DIR, 'search.db'))) {
    const a = observer(); try { applied = Number(state(a, 'applied_seq') ?? 0); } catch { /* reset unlinks it */ } finally { a.close(); }
  }
  const row = db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(8+8+8+8+COALESCE(length(CAST(thread_key AS BLOB)),0)),0) AS bytes FROM search_intents WHERE seq>?').get(applied)!;
  return { rows: Number(row.n), bytes: Number(row.bytes) };
}
export async function start(db: DatabaseSync) {
  search.startSearchIndex(db, join(DATA_DIR, 'messages.db'));
  await until(() => search.messageSearchIndexReady(db), 'reader-ready');
}
export async function stop() {
  hooks.halted = false; hooks.event = null; hooks.barrier = null;
  await search.stopSearchIndex(); closeDatabase(); await stopWalMaintenance();
}
export async function fresh() {
  const db = database(); await search.stopSearchIndex(); await stopWalMaintenance();
  db.exec('PRAGMA wal_autocheckpoint=0;PRAGMA journal_size_limit=0');
  return db;
}
export function seed(db: DatabaseSync, n: number) {
  const random = rng(); let textBytes = 0;
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'user','text',?,?)");
  for (let offset = 0; offset < n; offset += 1000) {
    db.exec('BEGIN IMMEDIATE');
    for (let i = offset; i < Math.min(n, offset + 1000); i++) {
      const p = random(), length = p < .001 ? 65536 : p < .011 ? 4096 : p < .5 ? 80 : 81 + Math.floor(random() * 80);
      const text = ('synthetic canary ' + i + ' ' + Math.floor(random() * 1e9).toString(36) + ' ').padEnd(length, ' abcdefghijklmnopqrstuvwxyz');
      const thread = i < Math.min(4000, n / 2) ? 'drop-' + (i < Math.min(2000, n / 4) ? 0 : 1) : 'seed-' + (i % 398);
      put.run(thread, 'seed-' + i, i + 1, text, JSON.stringify({ id: 'seed-' + i, at: i + 1, role: 'user', kind: 'text', text }));
      textBytes += Buffer.byteLength(text);
    }
    db.exec('COMMIT');
  }
  return textBytes;
}
export function send(id: number, text = 'qualification canary owner send') {
  const at = performance.now();
  insertMessage('qual-turn', { id: 'qual-' + id, at: 2_000_000 + id, role: 'user', kind: 'text', text });
  return performance.now() - at;
}
export function hashRows(db: DatabaseSync, sql = 'SELECT rowid,thread_id,id,kind,text,json FROM messages ORDER BY rowid') {
  const hash = createHash('sha256'); let count = 0;
  for (const row of db.prepare(sql).iterate()) { hash.update(JSON.stringify(row)); count++; }
  return { count, hash: hash.digest('hex') };
}
export function residue(marker: string) {
  return ['search.db', 'search.db-wal'].every(name => !existsSync(join(DATA_DIR, name)) || !readFileSync(join(DATA_DIR, name)).includes(Buffer.from(marker)));
}
export function integrity(file: string) {
  let db: DatabaseSync | undefined;
  try { db = observer(file); return db.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok'); }
  catch { return false; } finally { db?.close(); }
}

// Only called on the isolated working fixture, after its owner/reader closes.
export async function beginRebuild(db: DatabaseSync) {
  await search.stopSearchIndex(); hooks.halted = true;
  for (const name of ['search.db-wal', 'search.db-shm', 'search.db']) {
    const file = join(DATA_DIR, name); if (existsSync(file)) unlinkSync(file);
  }
  await start(db);
  const a = observer();
  try { return { builtCursor: state(a, 'built'), indexedRows: Number(a.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n) }; }
  finally { a.close(); }
}

export function preservationLedger(db: DatabaseSync) {
  const rows = new Map<number, {thread: string; encoded: string}>();
  const remember = (row: Record<string, unknown>) => rows.set(Number(row.rowid), {thread: String(row.thread_id), encoded: JSON.stringify(row)});
  for (const row of db.prepare('SELECT rowid,thread_id,id,kind,text,json FROM messages ORDER BY rowid').iterate()) remember(row);
  return {
    add(db: DatabaseSync, id: number) { remember(db.prepare("SELECT rowid,thread_id,id,kind,text,json FROM messages WHERE thread_id='qual-turn' AND id=?").get('qual-' + id)!); },
    dropThread(thread: string) { for (const [id, row] of rows) if (row.thread === thread) rows.delete(id); },
    hash() { const hash = createHash('sha256'); for (const [,row] of [...rows].sort(([a],[b])=>a-b)) hash.update(row.encoded); return {count: rows.size, hash: hash.digest('hex')}; },
  };
}
export function eld() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  let eld250 = 0, samples = 0;
  // Reset per 10ms observation so the count is actual observed long stalls,
  // rather than a single cumulative maximum sampled repeatedly.
  const timer = setInterval(() => { samples++; if (histogram.max >= 250e6) eld250++; histogram.reset(); }, 10);
  const cumulative = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable(); cumulative.enable();
  return () => { clearInterval(timer); histogram.disable(); cumulative.disable(); return { p99: cumulative.percentile(99) / 1e6, max: cumulative.max / 1e6, eld250, samples }; };
}
const excluded = new WeakSet<DatabaseSync>();
export type Bound = { statements: number; frames: number; scans: string[]; sql: string[] };
export function capture() {
  const proto = DatabaseSync.prototype, prepare = proto.prepare, exec = proto.exec;
  const probe = new DatabaseSync(':memory:');
  const stmt = Object.getPrototypeOf(probe.prepare('SELECT 1')) as StatementSync; probe.close();
  const connections = new WeakMap<StatementSync, DatabaseSync>(), descriptors = new Map<string, PropertyDescriptor>();
  let enabled = false, explain = false, inside = false;
  let sql: string[] = [], scans: string[] = [];
  const mainFTS: string[] = [];
  const record = (db: DatabaseSync, text: string, args: unknown[]) => {
    if (inside || excluded.has(db)) return;
    if (/\bmessages_fts\b/i.test(text) && mainFTS.length < 30) mainFTS.push(text);
    if (!enabled) return;
    sql.push(text);
    if (!explain) return;
    inside = true;
    try {
      const plan = prepare.call(db, 'EXPLAIN QUERY PLAN ' + text);
      const rows = Reflect.apply(descriptors.get('all')!.value, plan, args) as Array<{detail: string}>;
      const fixed=new Set(['SCAN CONSTANT ROW','SCAN sqlite_schema','SCAN temp.identity_epoch','SCAN pragma_data_version VIRTUAL TABLE INDEX 0:','SCAN e VIRTUAL TABLE INDEX 3:','SCAN (subquery-1)']);
      for(const row of rows){
        if(!/\bSCAN\b/.test(row.detail)||fixed.has(row.detail))continue;
        const bounded=[['memory_evidence',0],['memory_revoke_jobs',1],['memory_receipt_flips',0]] as const;
        const table=bounded.find(([name])=>row.detail.startsWith('SCAN '+name+' ')||row.detail==='SCAN '+name);
        if(table){
          const count=Number(prepare.call(db,'SELECT COUNT(*) AS n FROM '+table[0]).get()!.n);
          if(count<=table[1])continue;
        }
        scans.push(row.detail);
      }
    } finally { inside = false; }
  };
  proto.prepare = function(text: string) { const s = prepare.call(this, text); connections.set(s, this); return s; };
  for (const method of ['run', 'get', 'all', 'iterate'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(stmt, method)!; descriptors.set(method, descriptor);
    Object.defineProperty(stmt, method, { ...descriptor, value: function(this: StatementSync, ...args: unknown[]) {
      record(connections.get(this)!, this.sourceSQL, args); return Reflect.apply(descriptor.value, this, args);
    } });
  }
  proto.exec = function(text: string) {
    if (!enabled) { record(this, text, []); return exec.call(this, text); }
    let rest = text;
    while (rest.trim()) { const s = prepare.call(this, rest); record(this, s.sourceSQL, []); rest = rest.slice(s.sourceSQL.length); }
    return exec.call(this, text);
  };
  return { mainFTS,
    measure<T>(fn: () => T, plans = false): { result: T; bound: Bound; ms: number } {
      sql = []; scans = []; enabled = true; explain = plans;
      const before = bytes(join(DATA_DIR, 'messages.db-wal')), at = performance.now();
      try { const result = fn(); return { result, ms: performance.now() - at, bound: { statements: sql.length, sql: [...sql], scans: [...scans], frames: (bytes(join(DATA_DIR, 'messages.db-wal')) - before) / 4120 } }; }
      finally { enabled = false; explain = false; }
    },
    restore() { proto.prepare = prepare; proto.exec = exec; for (const [key, desc] of descriptors) Object.defineProperty(stmt, key, desc); },
  };
}
export function boundSample(trace: ReturnType<typeof capture>, begin: number, n = smoke ? 3 : 100) {
  const out: Bound[] = [];
  for (let i = 0; i < n; i++) out.push(trace.measure(() => send(begin + i), true).bound);
  return out;
}
export function sameBound(left: Bound[], right: Bound[]) {
  return left.length > 0 && right.length > 0 &&
    left.every(x => !x.scans.length) && right.every(x => !x.scans.length) &&
    JSON.stringify(left.map(x => [x.statements, x.frames])) === JSON.stringify(right.map(x => [x.statements, x.frames]));
}
