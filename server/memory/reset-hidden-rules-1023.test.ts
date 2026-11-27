// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of both sides: q1023-seanclean (the command server/memory-reset-hidden-rules.ts and its steps in reset-hidden-rules.ts).
// The steps it calls are the revoke marker's (revoke-marker.ts, memory-revocation.ts), owned by the marker's lanes.
//
// A store whose revoke queue never drains while the app runs: open revoke jobs with pending windows over every conversation, a
// job that cannot be walked, a folded member no bulk carries, pending rows no job owns, and the recall views an earlier release
// left. Every witness enters through the command as a process (`node server/memory-reset-hidden-rules.ts --data-dir <folder>`,
// what the packaged app's hidden flag starts), on a messages.db made by the real open (database()) and real revoke commits:
//   W-CLEAN    after the command no job is open and no pending window stands; a line under a window reads "shown" again;
//              every revoke that could be walked was FINISHED (its marks stand, nothing it hid can be read again);
//              no record, source, message, tombstone or conversation deny row changed; the next open drops the leftover views;
//   W-KEEP     a revoke that cannot be walked stays exactly as it is, marks and windows (the command never withdraws a revoke), and a
//              deleted conversation's commit receipt stands, so the start-up replay of that deletion (capture.ts) writes nothing;
//   W-ORPHAN   pending rows no job owns go;
//   W-FLIP     a queued receipt flip is drained into its revoke and finished (the marker's flip drain is installed);
//   W-AGAIN    a second run finds nothing to do and changes nothing;
//   W-RUNNING  while another owner holds the data folder (the app is open) the command refuses and changes nothing;
//   W-DRY      --dry-run reports and changes nothing;
//   W-N1000    a thousand open jobs end the same way;
//   W-CLEANUP  a deleted conversation's clean-up job that is still owed (the owner's own committed deletion, the only walk that ends
//              words) is finished exactly as the app's runner finishes it; every row of every other conversation is unchanged, value for value;
//   W-FORGET   (q1023-cleanfix) a record Forget's owed clean-up job, finished by the command, tells the app's own forgotten-messages
//              hook for every source its step ends (server/forgotten-messages-hook.ts, what server/index.ts registers): the project text
//              citing those messages and the lead's sourceless cards after them go stale, and the messages leave the event log, as the
//              app's runner does;
//   W-FLAG     the packaged app's startup module (electron/main.mjs), loaded with the flag, runs the bundled command on the store
//              before any other module of the app runs (its flag entry electron/memory-reset-entry.mjs). q1023-cleanfix: never skipped;
//              when this checkout has no server bundle the witness builds it as the app's build does (scripts/bundle-server.mjs).
// "Unchanged" is by value: kept() digests every column of every row of the real tables, not their counts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { acquireDataDirLeaseForProcess } from '../data-dir-lease.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { captureThreadDeletion } from './capture.ts';
import { denyLookup } from './deny-read.ts';
import { FIRST_LSN } from './lineage-types.ts';
import { INLINE_REVOCATION } from './memory-revocation.ts';
import { commitRevoke } from './revoke-commit.ts';
import { ownerMemoryTicket } from './authority.ts';
import { forgetMemory, FORGET_INLINE_ROWS } from './forget.ts';
import { enqueueNode, markPending } from './revoke-marker.ts';
import { CONTENT, WritetimeFixture, testThreadNo } from './testing/writetime-fixture.ts';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND = process.env.MURAGE_RESET_COMMAND ?? join(SERVER_DIR, 'memory-reset-hidden-rules.ts'); // (or the bundled copy the app ships: dist-server/memory-reset-hidden-rules.js)

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

const one = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)?.n ?? 0);
const count = (table: string, where = '1') => one(`SELECT count(*) AS n FROM ${table} WHERE ${where}`);
const OPEN = "state NOT IN ('done','undone')";
/** What the command must settle, read from the file. */
const hidden = () => ({ jobsOpen: count('memory_revoke_jobs', OPEN), pending: count('memory_deny_pending') + count('memory_deny_pending_scope'), frontier: count('memory_revoke_frontier') });
/** Every column of every row a query returns, as "<rows>:<digest>". */
function digest(sql: string): string {
  const hash = createHash('sha256'); let rows = 0;
  for (const row of database().prepare(sql).iterate()) { hash.update(JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? String(value) : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value))); rows++; }
  return `${rows}:${hash.digest('hex').slice(0, 16)}`;
}
/** What the command must never change, by value. `where` narrows it to the rows outside one conversation (W-CLEANUP). */
const kept = (where: { messages?: string; sources?: string; versions?: string; tombstones?: string } = {}) => ({
  messages: digest(`SELECT * FROM messages WHERE ${where.messages ?? '1'} ORDER BY thread_id,id`),
  records: digest('SELECT * FROM memory_records ORDER BY id,version'),
  sources: digest(`SELECT * FROM memory_sources WHERE ${where.sources ?? '1'} ORDER BY id`),
  sourceVersions: digest(`SELECT * FROM memory_source_versions WHERE ${where.versions ?? '1'} ORDER BY source_id,revision`),
  evidence: digest('SELECT * FROM memory_evidence ORDER BY record_id,record_version,source_id,source_revision,start_byte'),
  tombstones: digest(`SELECT * FROM memory_tombstones WHERE ${where.tombstones ?? '1'} ORDER BY id`),
  denyRules: digest('SELECT * FROM memory_deny ORDER BY kind,id'),
  lineage: digest('SELECT * FROM memory_line_lineage ORDER BY 1,2'),
});
const mark = () => database().prepare("SELECT done,skipped FROM transcript_index_state WHERE name='recall_views_1022'").get() as { done: number; skipped: number } | undefined;
const verdict = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: 'generated' }] }, CONTENT).get(id)!.state;

/** The command, as the packaged app's flag starts it: its own process, on the closed store. */
function command(...args: string[]): { status: number | null; lines: Array<Record<string, any>>; last: Record<string, any> | undefined } {
  closeDatabase();
  const env: NodeJS.ProcessEnv = { ...process.env }; delete env.MURAGE_DATA_DIR; delete env.NODE_OPTIONS; delete env.VITEST;
  const done = spawnSync(process.execPath, [COMMAND, '--data-dir', DATA_DIR, ...args], { env, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  const lines = String(done.stdout ?? '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, any>);
  return { status: done.status, lines, last: lines[lines.length - 1] };
}

type Shape = { walkable: number; stuck?: boolean; orphans?: number; views?: number };
/** deny_line rows the store must hold once every walkable revoke is finished (half of them are not written yet when the command starts). */
let marksOwed = 0;
/** The stuck store. `walkable` line revokes (each a real commit on its own conversation, reopened as the runner left them: active, in
 *  its mark phase, a frontier node still to walk, a pending window on its conversation and the first of them one over every conversation;
 *  every second one has not written its mark yet: its walk owes it);
 *  `stuck`: a deleted conversation's revoke and a line revoke whose frontier does not parse, and a folded member no bulk carries. */
function stuckStore(shape: Shape): { deletionRevoke: number; stuckLineRevoke: number } {
  const db = database();
  const f = new WritetimeFixture(db);
  db.exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)!='array'"); // (the shape the real open checks: schema.ts SHAPES)
  const threads = shape.walkable + 3;
  db.exec('BEGIN');
  for (let t = 0; t < threads; t++) {
    for (let m = 0; m < 2; m++) { f.message(`t${t}`, `m${t}-${m}`, m % 2 ? 'bot' : 'user'); f.lineage(`t${t}`, `m${t}-${m}`, 10 + t * 4 + m, { generated: m % 2 === 1 }); }
    if (t < 20) { f.source(`src-${t}`, 's-room', { thread: `t${t}`, message: `m${t}-0` }); f.record(`rec-${t}`, 1, 's-room', [`src-${t}`], { assertion: 'owner-statement' }); }
  }
  db.exec('COMMIT');
  const reopen = db.prepare("INSERT OR REPLACE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,'mark','','active')");
  const job = (id: number) => db.prepare('SELECT kind,root,root_lsn,started_lsn FROM memory_revoke_jobs WHERE revoke_id=?').get(id) as { kind: string; root: string; root_lsn: number; started_lsn: number };
  const reopened: Array<{ id: number; row: ReturnType<typeof job>; thread: string; lsn: number }> = [];
  for (let t = 0; t < shape.walkable; t++) {
    db.exec('BEGIN IMMEDIATE');
    const id = commitRevoke(db, { kind: 'line', threadId: `t${t}`, messageIds: [`m${t}-1`], cause: 'branch-switch' });
    db.exec('COMMIT');
    reopened.push({ id, row: job(id), thread: `t${t}`, lsn: 10 + t * 4 + 1 }); // (read before the next commit prunes the finished row)
  }
  let deletionRevoke = 0, stuckLineRevoke = 0;
  const stuck: typeof reopened = [];
  if (shape.stuck) {
    const td = `t${shape.walkable}`, tl = `t${shape.walkable + 1}`;
    db.exec('BEGIN IMMEDIATE'); captureThreadDeletion(db, td); db.exec('COMMIT');
    deletionRevoke = one("SELECT revoke_id AS n FROM memory_deny_point WHERE thread_id=? AND lsn=? AND reason='delete-conversation'", td, FIRST_LSN);
    stuck.push({ id: deletionRevoke, row: job(deletionRevoke), thread: td, lsn: 0 });
    db.exec('BEGIN IMMEDIATE'); stuckLineRevoke = commitRevoke(db, { kind: 'line', threadId: tl, messageIds: [`m${shape.walkable + 1}-1`], cause: 'branch-switch' }); db.exec('COMMIT');
    stuck.push({ id: stuckLineRevoke, row: job(stuckLineRevoke), thread: tl, lsn: 0 });
  }
  db.exec('BEGIN IMMEDIATE');
  marksOwed = count('memory_deny_point');
  reopened.forEach((r, at) => {
    reopen.run(r.id, r.row.kind, r.row.root, r.row.root_lsn, r.row.started_lsn);
    enqueueNode(db, r.id, { kind: 'line', threadId: r.thread, lsn: r.lsn });
    markPending(db, r.id, r.thread, 0);
    // the walk had not reached this line yet: its mark is still owed
    if (at % 2 === 1) db.prepare('DELETE FROM memory_deny_point WHERE revoke_id=?').run(r.id);
  });
  if (reopened.length) db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',0,?)").run(reopened[0]!.id);
  for (const r of stuck) {
    reopen.run(r.id, r.row.kind, r.row.root, r.row.root_lsn, r.row.started_lsn);
    db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'not-a-node')").run(r.id);
    markPending(db, r.id, r.thread, 0);
  }
  if (shape.stuck) db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(900001,'line','{}',1,1,'mark','','folded')").run();
  for (let o = 0; o < (shape.orphans ?? 0); o++) db.prepare('INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,0,?)').run(`t${o % threads}`, 800_000 + o);
  db.exec('COMMIT');
  if (shape.views) {
    db.exec('CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID');
    db.exec("DELETE FROM transcript_index_state WHERE name='recall_views_1022'");
    db.exec('PRAGMA foreign_keys=OFF'); db.exec('BEGIN');
    const view = db.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,0,0,'ready',0,'',0)");
    for (let v = 0; v < shape.views; v++) view.run(`leftover-${String(v).padStart(4, '0')}`, 'g');
    const term = db.prepare('INSERT INTO memory_recall_view_terms(view_id,generation,term,sequence,record_id,version) VALUES(?,?,?,?,?,1)');
    for (let k = 0; k < 2_000; k++) term.run('leftover-0000', 'g', `leftover-term-${String(k).padStart(8, '0')}`, k, `rec-${k % 20}`);
    db.exec('COMMIT'); db.exec('PRAGMA foreign_keys=ON');
  }
  return { deletionRevoke, stuckLineRevoke };
}

it('W-CLEAN: the command ends every open revoke and pending window, finishes what can be walked, leaves every real row, and the next open drops the leftover views', () => {
  database();
  stuckStore({ walkable: 10, views: 40 });
  const before = { hidden: hidden(), kept: kept(), lines: count('memory_deny_point'), ranges: count('memory_deny_range'), untouched: verdict('t11', 'm11-1') };
  expect({ written: before.lines, owed: marksOwed }).toEqual({ written: 5, owed: 10 }); // five walks still owe their mark
  // the store as the app finds it: open jobs, a window over every conversation (a line of a conversation no revoke names reads "checking")
  expect(before.hidden).toEqual({ jobsOpen: 10, pending: 11, frontier: 10 });
  expect(before.untouched).toBe('checking');
  closeDatabase(); database(); // an open with the walks owed: the leftover views are withheld (recall-view-schema.ts forgetWorkOwed)
  expect({ views: count('memory_recall_views'), marked: mark() !== undefined }).toEqual({ views: 40, marked: false });

  const ran = command();
  database();
  // (1) nothing open, nothing pending: memory is no longer paused
  expect(hidden()).toEqual({ jobsOpen: 0, pending: 0, frontier: 0 });
  expect(verdict('t11', 'm11-1')).toBe('shown');
  // (2) finished, not withdrawn: every mark the revokes owed is written (the five still owed too), and what they hide is hidden
  expect(count('memory_deny_point')).toBe(marksOwed);
  expect(count('memory_deny_range')).toBe(before.ranges);
  expect([verdict('t2', 'm2-1'), verdict('t3', 'm3-1')]).toEqual(['withheld', 'withheld']);
  // (3) every real row is where it was
  expect(kept()).toEqual(before.kept);
  // (4) the command's own account, counts only
  expect(ran.status).toBe(0);
  expect(ran.last).toMatchObject({ type: 'murage:memory-reset', status: 'clean', quickCheck: 'ok' });
  expect(ran.last!.before).toMatchObject({ jobsOpen: 10 }); expect(ran.last!.after).toMatchObject({ jobsOpen: 0, pendingThreads: 0, pendingScopes: 0 });
  // (5) the next open drops the leftover views whole and marks the file
  closeDatabase(); database();
  expect({ views: count('memory_recall_views'), terms: count('memory_recall_view_terms') }).toEqual({ views: 0, terms: 0 });
  expect(mark()).toMatchObject({ done: 1 });
}, 300_000);

it('W-KEEP: a revoke that cannot be walked stays as it is, marks and windows; what can be walked is finished; a deletion replay writes nothing', () => {
  database();
  const { deletionRevoke, stuckLineRevoke } = stuckStore({ walkable: 4, stuck: true });
  const deleted = 't4';
  const stuck = () => ({ marks: count('memory_deny_point', `revoke_id IN (${deletionRevoke},${stuckLineRevoke})`), ranges: count('memory_deny_range', `revoke_id IN (${deletionRevoke},${stuckLineRevoke})`),
    windows: count('memory_deny_pending', `revoke_id IN (${deletionRevoke},${stuckLineRevoke})`) });
  const before = { kept: kept(), stuck: stuck() };
  expect(hidden().jobsOpen).toBe(7); // 4 walkable, the deletion, the line revoke, the folded member
  const ran = command();
  const db = database();
  // nothing was withdrawn: the three that cannot end are still open with their marks and windows, the four that can are finished
  expect({ open: hidden().jobsOpen, stuck: stuck() }).toEqual({ open: 3, stuck: before.stuck });
  expect(verdict('t5', 'm5-1')).not.toBe('shown');
  expect(count('memory_deny_point')).toBe(marksOwed);
  expect(kept()).toEqual(before.kept);
  expect(ran.last).toMatchObject({ status: 'incomplete' });
  expect(ran.last!.after).toMatchObject({ jobsOpen: 3 });
  expect(ran.status).toBe(2);
  // the deleted conversation's deny row and commit receipt stand, so the start-up replay of that deletion commits nothing new
  expect(one("SELECT count(*) AS n FROM memory_deny_point WHERE thread_id=? AND lsn=? AND reason='delete-conversation'", deleted, FIRST_LSN)).toBe(1);
  const jobsBefore = count('memory_revoke_jobs'), maxBefore = one('SELECT max(revoke_id) AS n FROM memory_revoke_jobs');
  db.exec('BEGIN IMMEDIATE'); captureThreadDeletion(db, deleted); db.exec('COMMIT');
  expect({ jobs: count('memory_revoke_jobs'), max: one('SELECT max(revoke_id) AS n FROM memory_revoke_jobs') }).toEqual({ jobs: jobsBefore, max: maxBefore });
}, 300_000);

it('W-ORPHAN: pending rows no job owns go with the rest', () => {
  database();
  stuckStore({ walkable: 2, orphans: 50 });
  expect(hidden().pending).toBe(53);
  const ran = command();
  database();
  expect(hidden()).toEqual({ jobsOpen: 0, pending: 0, frontier: 0 });
  expect(ran.last).toMatchObject({ status: 'clean', orphansCleared: 50 });
}, 300_000);

it('W-FLIP: a queued receipt flip is drained into its revoke and finished', () => {
  database();
  stuckStore({ walkable: 2 });
  const db = database();
  const f = new WritetimeFixture(db);
  // a revoked receipt whose flip the marker has not committed yet (the queue the v10 trigger memory_receipt_flip fills): while it is
  // queued no revoke advances (revoke-marker.ts runMarkerSlice)
  f.receipt('bundle-flip', 't7', 'instance-1', 'session-1', { state: 'revoked' });
  db.prepare('INSERT INTO memory_receipt_flips(thread_no,first_lsn,bundle_id) VALUES(?,?,?)').run(testThreadNo(db, 't7'), 10 + 7 * 4 + 1, 'bundle-flip');
  expect(count('memory_receipt_flips')).toBe(1);
  const ran = command();
  database();
  expect({ ...hidden(), flips: count('memory_receipt_flips') }).toEqual({ jobsOpen: 0, pending: 0, frontier: 0, flips: 0 });
  expect(ran.last).toMatchObject({ status: 'clean' });
}, 300_000);

it('W-AGAIN: a second run finds nothing to do and changes nothing', () => {
  database();
  stuckStore({ walkable: 3, orphans: 5 });
  command();
  database();
  const read = () => ({ hidden: hidden(), kept: kept(), lines: count('memory_deny_point'), ranges: count('memory_deny_range'), jobs: count('memory_revoke_jobs'),
    generation: one("SELECT value AS n FROM memory_lineage_lsn_meta WHERE key='deny_generation'"), reached: count('memory_revoke_reached') });
  const settled = read();
  const again = command();
  database();
  // nothing moved, not even the deny generation readers key their caches on
  expect(read()).toEqual(settled);
  expect(again.last).toMatchObject({ status: 'nothing-to-do' });
  expect(again.status).toBe(0);
  expect(settled.hidden).toEqual({ jobsOpen: 0, pending: 0, frontier: 0 }); // (and the first run had settled the store)
}, 300_000);

it('W-RUNNING: while another owner holds the data folder the command refuses and changes nothing', () => {
  database();
  stuckStore({ walkable: 3 });
  const before = hidden();
  closeDatabase();
  const lease = acquireDataDirLeaseForProcess(DATA_DIR, {}); // the app is open on this folder
  let ran: ReturnType<typeof command>;
  try { ran = command(); } finally { lease.release(); }
  database();
  expect(hidden()).toEqual(before);
  expect(ran!.last).toMatchObject({ status: 'refused', why: 'app-running-or-folder-held' });
  expect(ran!.status).toBe(3);
}, 300_000);

it('W-DRY: --dry-run reports the counts and changes nothing', () => {
  database();
  stuckStore({ walkable: 3 });
  const before = hidden();
  const ran = command('--dry-run');
  database();
  expect(hidden()).toEqual(before);
  expect(ran.last).toMatchObject({ status: 'dry-run', settled: false });
  expect(ran.last!.counts).toMatchObject({ jobsOpen: 3 });
  expect(ran.status).toBe(0);
}, 300_000);

it('W-N1000: a thousand open jobs end the same way', () => {
  database();
  stuckStore({ walkable: 1000 });
  const before = { kept: kept() };
  expect(hidden().jobsOpen).toBe(1000);
  const ran = command();
  database();
  expect(hidden()).toEqual({ jobsOpen: 0, pending: 0, frontier: 0 });
  expect(count('memory_deny_point')).toBe(marksOwed);
  expect(kept()).toEqual(before.kept);
  expect(ran.last).toMatchObject({ status: 'clean' });
}, 600_000);

it('W-CLEANUP: an owed clean-up job of a deleted conversation is finished as the runner finishes it; every other row is unchanged by value', () => {
  database();
  stuckStore({ walkable: 2 });
  const db = database();
  const f = new WritetimeFixture(db);
  // a conversation with more captured sources than its deletion ends inside the owner's own commit: the rest is a durable clean-up job
  db.exec('BEGIN');
  for (let n = 0; n < 300; n++) { f.message('tdel', `mdel-${n}`, n % 2 ? 'bot' : 'user'); f.lineage('tdel', `mdel-${n}`, 9_000 + n); f.source(`del-src-${n}`, 's-room', { thread: 'tdel', message: `mdel-${n}` }); }
  db.exec('COMMIT');
  // the owner deleted it (message-db.ts deleteThread) in a commit with no inline room left: the whole clean-up is a durable job
  const inline = { ...INLINE_REVOCATION };
  Object.assign(INLINE_REVOCATION, { rows: 1, ms: 0 });
  try { db.exec('BEGIN IMMEDIATE'); captureThreadDeletion(db, 'tdel'); db.exec('COMMIT'); } finally { Object.assign(INLINE_REVOCATION, inline); }
  const owed = () => count('memory_scope_bindings', "subject_type='system' AND subject_id='memory-revocation' AND state IN ('granted','revoked')");
  const live = () => one("SELECT count(*) AS n FROM memory_sources s WHERE s.thread_id='tdel' AND s.state<>'deleted' AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id)");
  const others = () => kept({ messages: "thread_id<>'tdel'", sources: "thread_id IS NOT 'tdel'", versions: "source_id NOT LIKE 'del-src-%'", tombstones: "target_id NOT LIKE 'del-src-%'" });
  const before = { owed: owed(), live: live(), others: others() };
  expect(before.owed).toBe(1);            // the deletion's clean-up is still owed
  expect(before.live).toBeGreaterThan(0); // and some of the deleted conversation's sources are not ended yet
  const ran = command();
  database();
  // the owner's deletion is finished: no clean-up owed, every source of the deleted conversation ended, nothing else open
  expect({ owed: owed(), live: live(), ...hidden() }).toEqual({ owed: 0, live: 0, jobsOpen: 0, pending: 0, frontier: 0 });
  // and nothing of any other conversation moved, value for value
  expect(others()).toEqual(before.others);
  expect(ran.last).toMatchObject({ status: 'clean' });
}, 300_000);

it('W-FORGET: a Forget job the command finishes tells the app\'s forgotten-messages hook for every source its step ends', () => {
  database();
  stuckStore({ walkable: 1 });
  const db = database();
  const f = new WritetimeFixture(db);
  // a project room whose record rests on more captured lines than the Forget ends in its own commit: the rest is its 'supporting' job
  const N = FORGET_INLINE_ROWS + 36, id = (n: number) => String(n).padStart(3, '0');
  db.exec('BEGIN');
  for (let n = 0; n < N; n++) { f.message('tproj', `mf-${id(n)}`, 'user'); f.source(`fsrc-${id(n)}`, 's-room', { thread: 'tproj', message: `mf-${id(n)}` }); }
  f.record('rec-forget', 1, 's-room', Array.from({ length: N }, (_, n) => `fsrc-${id(n)}`), { assertion: 'owner-statement' });
  db.exec('COMMIT');
  // the roster as the app saves it (store.ts bots.json, groups.json): the room is a project's
  writeFileSync(join(DATA_DIR, 'bots.json'), JSON.stringify([{ id: 'lead', threadId: 'lead-direct' }]));
  writeFileSync(join(DATA_DIR, 'groups.json'), JSON.stringify([{ id: 'proj', threadId: 'tproj', memberIds: ['lead'], channelProject: { goal: 'Launch' } }]));
  // derived project text citing the oldest line (the job's, not the commit's), and a lead's card that cites nothing, made after it
  db.prepare("INSERT INTO project_summaries(group_id,version,text,source_message_ids,made_by,at) VALUES('proj',1,'summary','[\"mf-000\"]','lead',?)").run(Date.now());
  db.prepare(`INSERT INTO project_work_items(id,group_id,number,title,state,position,source_message_ids,created_by,created_at,updated_at)
    VALUES('card-1','proj',1,'Card','todo',1,'[]','lead',?,?)`).run(Date.now() + 60_000, Date.now() + 60_000);
  // the owner's Forget, committed with no inline room left (an older build's commit told the hook of its inline rows only): the job owes the rest
  const inline = { ...INLINE_REVOCATION };
  Object.assign(INLINE_REVOCATION, { rows: 1, ms: 0 });
  try { forgetMemory(ownerMemoryTicket(), { kind: 'record', id: 'rec-forget' }); } finally { Object.assign(INLINE_REVOCATION, inline); }
  const jobLines = Array.from({ length: N - FORGET_INLINE_ROWS }, (_, n) => `mf-${id(n)}`);
  const told = () => ({
    summaryStale: one("SELECT stale AS n FROM project_summaries WHERE group_id='proj'"),
    cardStale: one("SELECT stale AS n FROM project_work_items WHERE id='card-1'"),
    eventLogForgets: count('sqlite_schema', "name='event_log_forgets'") ? one(`SELECT count(*) AS n FROM event_log_forgets WHERE thread_id='tproj' AND message_id IN (${jobLines.map(line => `'${line}'`).join(',')})`) : 0,
  });
  expect(count('memory_scope_bindings', "subject_type='system' AND subject_id='memory-revocation' AND state IN ('granted','revoked')")).toBeGreaterThan(0);
  expect(told()).toEqual({ summaryStale: 0, cardStale: 0, eventLogForgets: 0 });
  const ran = command();
  database();
  expect(ran.last).toMatchObject({ status: 'clean' });
  // every line the job's step ended went through the app's hook: the project text is stale and the event log forgets each of them
  expect(told()).toEqual({ summaryStale: 1, cardStale: 1, eventLogForgets: jobLines.length });
}, 300_000);

const APP_MAIN = join(SERVER_DIR, '..', 'electron', 'main.mjs');
/** The Electron runtime main.mjs links against, for a plain node child: the 'electron' module resolves to one exporting every name the
 * app's modules import from it (Electron's built-in; the npm package is only its path). Nothing of the app or of the command is replaced.
 * The first use of any of them is the app starting: it prints APP-STARTED and exits 97 (the flag launch must end before any). */
function electronRuntime(): string {
  const names = new Set<string>();
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); continue; }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) for (const name of match[1]!.split(',')) { const bare = name.trim().split(/\s+as\s+/)[0]!.trim(); if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare); }
  } };
  for (const dir of ['electron', 'shared']) walk(join(SERVER_DIR, '..', dir));
  const started = "const started = () => { process.stdout.write('APP-STARTED\\n'); process.exit(97); };\nconst electron = () => new Proxy(function () {}, { get: started, apply: started, construct: started, has: started, ownKeys: started });\n";
  const runtime = `${started}${[...names].map(name => `export const ${name} = electron();`).join('\n')}\nexport default electron();\n`;
  const dir = mkdtempSync(join(tmpdir(), 'w-flag-electron-'));
  writeFileSync(join(dir, 'hooks.mjs'), `export async function resolve(specifier, context, next) { return specifier === 'electron' ? { url: ${JSON.stringify(pathToFileURL(join(dir, 'electron.mjs')).href)}, shortCircuit: true } : next(specifier, context); }\n`);
  writeFileSync(join(dir, 'electron.mjs'), runtime);
  writeFileSync(join(dir, 'register.mjs'), `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});\n`);
  return join(dir, 'register.mjs');
}
const BUNDLED = join(SERVER_DIR, '..', 'dist-server', 'memory-reset-hidden-rules.js');
it("W-FLAG: the packaged app's startup module, loaded with the flag, runs the bundled command on the store", () => {
  { // the bundle the app ships, built from this checkout every run (never a stale one)
    const built = spawnSync(process.execPath, [join(SERVER_DIR, '..', 'scripts', 'bundle-server.mjs')], { cwd: join(SERVER_DIR, '..'), encoding: 'utf8', timeout: 600_000, windowsHide: true });
    expect({ bundle: built.status, built: existsSync(BUNDLED) }).toEqual({ bundle: 0, built: true });
  }
  database();
  stuckStore({ walkable: 3 });
  expect(hidden().jobsOpen).toBe(3);
  closeDatabase();
  const env: NodeJS.ProcessEnv = { ...process.env }; delete env.MURAGE_DATA_DIR; delete env.NODE_OPTIONS; delete env.VITEST; delete env.ELECTRON_RUN_AS_NODE;
  // the launch `<executable> --memory-reset-hidden-rules --data-dir <folder>`: the app's own startup module is loaded (its imports in their
  // order: the flag entry's first statement starts the bundled command with this executable and exits with its code, before the app runs)
  const runtime = electronRuntime();
  const done = spawnSync(process.execPath, ['--import', pathToFileURL(runtime).href, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(APP_MAIN).href)}); console.log('APP-WOULD-START');`,
    '--', '--memory-reset-hidden-rules', '--data-dir', DATA_DIR], { env, encoding: 'utf8', timeout: 240_000, windowsHide: true });
  removeTempDirSync(dirname(runtime));
  const lines = String(done.stdout ?? '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, any>);
  // the launch ran the command and ended: the app never started (no Electron use, no return to the app's own startup)
  expect({ status: done.status, appStarted: /APP-STARTED|APP-WOULD-START/.test(String(done.stdout)) }).toEqual({ status: 0, appStarted: false });
  database();
  expect(hidden()).toEqual({ jobsOpen: 0, pending: 0, frontier: 0 });
  expect(lines[lines.length - 1]).toMatchObject({ type: 'murage:memory-reset', status: 'clean' });
}, 300_000);
