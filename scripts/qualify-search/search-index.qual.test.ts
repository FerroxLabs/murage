// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, existsSync, openSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { MESSAGE_SEARCH_DDL } from '../../server/message-tables.ts';
import {
  DATA_DIR, Report, boundSample, bytes, capture, deleteThread, eld, fresh,
  hashRows, healthy, hooks, integrity, json, failBar, preservationLedger, observer, pause, pending, recovery,
  rng, search, seed, send, smoke, start, state, stats, stop, until, type Event,
} from './support.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const leg = process.env.MURAGE_QUAL;
afterEach(stop);

import {levels,prepareSegments} from './segments.ts';

it.runIf(/^q[12]-(103k|1m)$/.test(leg ?? ''))('Q1 sustained search qualification', { tags: ['qual'] }, async () => {
  const report = new Report(leg!);
  const n = smoke ? 120 : leg!.endsWith('1m') ? 1_040_000 : 103_000;
  const trace = capture();
  let finishELD: ReturnType<typeof eld> | undefined;
  const events: Event[] = [], steps: number[] = [], merges: number[] = [];
  const commits: Array<{ t: number; ms: number; window: string }> = [];
  const backlog: Array<{ t: number; rows: number; bytes: number; halt: boolean; writes: number }> = [];
  const drops: Array<{ t: number; cleared?: number; count: number }> = [];
  let pin: DatabaseSync | undefined, pinnedAt = 0, pinnedUntil = 0, pinnedAttempts = 0;
  try {
    const db = await fresh();
    const buildStart = performance.now(), textBytes = seed(db, n);
    hooks.halted = true;
    hooks.event = e => {
      if (events.length < 100) events.push({ type: e.type });
      if (e.type === 'stepped') {
        steps.push(Number(e['step-ms'])); merges.push(Number(e['merge-ms']));
        if (pin) pinnedAttempts += Number(e['qual-scrubs'] ?? 0);
      }
    };
    await start(db);
    const a = observer();
    try { a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',64)"); }
    finally { a.close(); }
    hooks.halted = false;
    await until(() => healthy(db), 'Q1-initial-build', smoke ? 15_000 : 30 * 60_000);
    const initialBuildMs = performance.now() - buildStart;
    {
      hooks.halted=true;await pause(smoke?50:500);
      report.raw.segmentFixture=await prepareSegments(smoke?1:Math.max(1,30*60_000-initialBuildMs));
      hooks.halted=false;
    }
    const layoutDb = observer(); let segmentLevels: number[];
    try {
      segmentLevels = levels(layoutDb);
      layoutDb.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',4);INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',16);INSERT INTO messages_fts(messages_fts,rank) VALUES('deletemerge',10)");
    } finally { layoutDb.close(); }
    // Fixture provenance is itself a blocking bar. A small or automatically
    // merged index cannot silently stand in for the specified crisis fixture.
    if (!smoke) {
      report.bar('segment-levels', [3,4,5].every(i => segmentLevels[i] === 15));
      report.bar('fixture-time',performance.now()-buildStart<=30*60_000);
    }
    trace.mainFTS.length = 0;
    if (failBar === 'main-fts') {
      db.exec('CREATE VIRTUAL TABLE temp.messages_fts USING fts5(t)');
      db.prepare('INSERT INTO temp.messages_fts(t) VALUES(?)').run('synthetic owner FTS violation');
    }
    for (let i = 0; i < 20; i++) send(-100 - i);
    const bound = boundSample(trace, 100_000);
    report.raw.bound = bound;
    finishELD = eld();
    const duration = smoke ? 12_000 : 50 * 60_000;
    const scale = smoke ? duration / (50 * 60_000) : 1;
    const at = performance.now(); let id = 0, nextWrite = 0, nextBurst = 60_000 * scale, lastSample = -Infinity;
    let dropped = 0, haltStart: { rows: number; writes: number } | undefined;
    let drainAt: number | undefined;
    const random = rng(0x1020);
    while (performance.now() - at < duration) {
      const t = performance.now() - at, halt = t >= 30 * 60_000 * scale && t < 40 * 60_000 * scale;
      if (halt && !hooks.halted) { haltStart = { rows: pending(db).rows, writes: id }; hooks.halted = true; }
      if (!halt && hooks.halted) { hooks.halted = false; drainAt = t; }
      const window = halt ? 'halt' : drainAt !== undefined ? 'drain' : pin ? 'pinned' : 'steady';
      if (t >= nextWrite) { commits.push({ t, window, ms: send(id++, 'qualification canary ' + Math.floor(random() * 1e7)) }); nextWrite += smoke ? 70 : 500; }
      if (t >= nextBurst && t < 30 * 60_000 * scale) {
        for (let i = 0; i < (smoke ? 2 : 50); i++) commits.push({ t, window: 'burst', ms: send(id++) });
        nextBurst += 60_000 * scale;
      }
      if (dropped < 2 && t >= (dropped === 0 ? 10 : 20) * 60_000 * scale) {
        const thread = 'drop-' + dropped;
        const count = Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id=?').get(thread)!.n);
        const measured = trace.measure(() => deleteThread(thread));
        commits.push({ t, window: 'drop', ms: measured.ms }); drops.push({ t, count }); dropped++;
      }
      // The second drop is deliberately also made while the reader is pinned:
      // a pin without a new deletion debt would not exercise scrub backoff.
      if (!pinnedAt && t >= 12 * 60_000 * scale) {
        pin = observer(); pin.exec('BEGIN;SELECT COUNT(*) FROM messages_fts'); pinnedAt = t; pinnedUntil = t + (smoke ? 60 : 60_000);
        send(900_000, 'temporary pinned deletion marker');
        deleteThread('qual-pin');
        db.exec('BEGIN IMMEDIATE'); search.dropThreadSearchRows(db, 'qual-turn'); db.exec('COMMIT');
      }
      if (pin && t >= pinnedUntil) { pin.exec('COMMIT'); pin.close(); pin = undefined; }
      if (t - lastSample >= (smoke ? 50 : 500)) {
        const p = pending(db); backlog.push({ t, ...p, halt, writes: id });
        if (halt && haltStart) report.bar('halt-linear', (report.pass['halt-linear'] ?? true) && p.rows - haltStart.rows <= id - haltStart.writes + 1);
        for (const drop of drops) if (drop.cleared === undefined && healthy(db)) {
          const b = observer(); try { if (state(b, 'debt') === undefined) drop.cleared = t; } finally { b.close(); }
        }
        if (drainAt !== undefined && report.raw.drainMs === undefined && p.rows === 0) report.raw.drainMs = t - drainAt;
        lastSample = t;
      }
      await pause(smoke ? 10 : 25);
    }
    if (pin) { pin.exec('COMMIT'); pin.close(); pin = undefined; }
    hooks.halted = false;
    await until(() => healthy(db), 'Q1-drain', smoke ? 15_000 : 10 * 60_000);
    const rebuildAt = performance.now();
    search.disableMessageSearchIndex(db, new Error('qualification forced reset'));
    await until(() => healthy(db), 'Q1-forced-rebuild', smoke ? 15_000 : 30 * 60_000);
    const rebuildMs = performance.now() - rebuildAt;
    const loop = finishELD(), owner = stats(commits.map(c => c.ms)), drainOwner = stats(commits.filter(c => c.window === 'drain').map(c => c.ms));
    const searchableBytes = Number(db.prepare("SELECT COALESCE(SUM(octet_length(text)),0) AS n FROM messages WHERE kind='text'").get()!.n);
    await search.stopSearchIndex();
    const finalBytes = bytes(join(DATA_DIR, 'search.db'));
    report.raw = Object.assign(report.raw, { n, seed: 0x1019, textBytes, searchableBytes, segmentLevels, initialBuildMs,
      owner, drainOwner, commits, backlog, drops, pinnedAttempts, eventLoop: loop, worker: stats(steps), merge: stats(merges),
      rebuildMs, rebuildRowsPerSecond: n / (rebuildMs / 1000), finalBytes, indexTextRatio: finalBytes / searchableBytes, mainFTSStatements: trace.mainFTS.length, events });
    report.bar('main-fts', trace.mainFTS.length === 0);
    report.bar('owner-commit', owner.p99 !== null && owner.p99 < 20 && owner.max! < 100);
    report.bar('event-loop', loop.p99 < 20 && loop.eld250 === 0 && loop.max < 250);
    report.bar('worker-step', steps.length > 0 && steps.every(x => Number.isFinite(x) && x <= 500));
    report.bar('merge-residual', merges.length > 0 && merges.every(x => Number.isFinite(x) && x <= 30_000));
    report.bar('intent-backlog', backlog.filter(x => !x.halt && x.t < 40 * 60_000 * scale).every(x => x.rows <= 2000 && x.bytes <= 240_000));
    report.bar('drop-cleared', drops.length === 2 && drops.every(x => x.cleared !== undefined && x.cleared - x.t - Math.max(0,Math.min(x.cleared,pinnedUntil)-Math.max(x.t,pinnedAt)) <= 5 * 60_000));
    report.bar('pinned-scrubs', pinnedAttempts <= 11);
    report.bar('halt-recovery', typeof report.raw.drainMs === 'number' && report.raw.drainMs <= 10 * 60_000 && drainOwner.n > 0 && drainOwner.p99! < 20);
    report.bar('rebuild-throughput', rebuildMs <= 30 * 60_000);
    report.bar('owner-scans', bound.every(x => x.scans.length === 0));
    if (!smoke) {
      const base = process.env.MURAGE_QUAL_LEGACY_REPORT;
      const baseline = base && JSON.parse(readFileSync(base, 'utf8'));
      report.raw.legacy = baseline || null;
      report.bar('legacy-baseline', !!baseline && baseline.pass?.legacy === true && baseline.raw?.base === 'b4dc27ea9' && baseline.raw?.n === 103_000);
      // Normalize both to searchable bytes because Q1's larger leg has 10x rows.
      report.bar('index-growth', !!baseline && finalBytes / searchableBytes <= 1.25 * baseline.raw.shadowBytes / baseline.raw.textBytes);
      // Retirement gets its own same-size legacy fixture, measured after all
      // workload measurements (never build legacy FTS on the owner turn).
      await search.stopSearchIndex();
      const retireDb = observer(join(DATA_DIR, 'legacy-retirement.db'));
      const legacyFixtureAt = performance.now();
      try {
        retireDb.exec('CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY,done,cursor,skipped)');
        retireDb.exec(MESSAGE_SEARCH_DDL);
        retireDb.prepare('ATTACH DATABASE ? AS source').run(join(DATA_DIR, 'messages.db'));
        retireDb.exec('INSERT INTO messages_fts(rowid,t) SELECT rowid,text FROM source.messages');
        retireDb.exec('DETACH DATABASE source');
        const retirementAt = performance.now(); search.settleInheritedSearchMerge(retireDb, false);
        const mainMs = performance.now() - retirementAt;
        report.raw.retirement = { mainMs, wallMs: performance.now() - legacyFixtureAt };
        report.bar('retirement', mainMs <= 20);
      } finally { retireDb.close(); }
    }
    // Raw per-leg report is also consumed by compare.ts; this enforces exact
    // T-BOUND equality across the two containers rather than independent caps.
    json(join(process.env.MURAGE_QUAL_EVIDENCE ?? 'evidence/r4', leg! + '-bound.json'), bound);
  } finally {
    if (pin) { try { pin.exec('ROLLBACK'); } finally { pin.close(); } }
    finishELD?.(); trace.restore();
  }
  report.finish();
});

it.runIf(leg === 'q2-diskfull')('Q2 actual filesystem exhaustion and recovery', { tags: ['qual'] }, async () => {
  const report = new Report('q2-diskfull');
  const db = await fresh(); seed(db, smoke ? 32 : 300); await start(db); await until(() => healthy(db), 'Q2-initial');
  const expected = preservationLedger(db);
  const before = hashRows(db), committed: number[] = [], rejected: number[] = [];
  const events: Event[] = [], states = new Set<string>(); let cycles = 0;
  hooks.event = event => { if (event.type === 'reset-ack') cycles++; if (events.length < 100) events.push({ type: event.type }); const r = recovery(db); if (r) states.add(r.state); };
  const fs = statfsSync(DATA_DIR);
  report.raw.filesystemType = fs.type;
  // Linux tmpfs magic; macOS mounted disk image is a different filesystem.
  report.bar('filesystem', process.platform !== 'linux' || fs.type === 0x01021994);
  const ballast = join(DATA_DIR, 'qualification-ballast');
  const fd = openSync(ballast, 'wx', 0o600); let ballastBytes = 0;
  try {
    const block = Buffer.alloc(256 * 1024, 0x61);
    while (Number(statfsSync(DATA_DIR).bavail) * Number(fs.bsize) > 1024 * 1024) {
      const available=Number(statfsSync(DATA_DIR).bavail)*Number(fs.bsize)-1024*1024;
      ballastBytes += writeSync(fd, block,0,Math.min(block.length,available));
    }
  } finally { closeSync(fd); }
  const freeAfterBallast = Number(statfsSync(DATA_DIR).bavail) * Number(fs.bsize);
  report.bar('ballast-free',freeAfterBallast<=1024*1024);
  let observedFull = false, partial = false, swallowed = false, maskedFull = 0;
  try {
    for (let i = 0; i < 200; i++) {
      const text=('diskfull qualification canary ' + i + ' ').repeat(1800);
      try { send(i, text); committed.push(i); expected.add(db,i); }
      catch (error) {
        const e = error as Error & { errcode?: number };
        if ((Number(e.errcode) & 255) === 13 || /SQLITE_FULL|database or disk is full/i.test(e.message)) observedFull = true;
        else if (/cannot rollback - no transaction is active/i.test(e.message)) maskedFull++;
        else throw error;
        rejected.push(i);
      }
      const row = db.prepare("SELECT text FROM messages WHERE thread_id='qual-turn' AND id=?").get('qual-' + i);
      partial ||= rejected.includes(i) && row !== undefined;
      swallowed ||= committed.includes(i) && (row === undefined || row.text!==text);
      await pause(smoke ? 2 : 10);
    }
    try { deleteThread('drop-0'); expected.dropThread('drop-0'); } catch (error) {
      if(/cannot rollback - no transaction is active/i.test(String(error)))maskedFull++;
      else if(!/full/i.test(String(error)))throw error;
    }
    search.disableMessageSearchIndex(db, new Error('disk-full forced reset'));
    const settleAt = performance.now();
    while (performance.now() - settleAt < (smoke ? 1000 : 45_000)) { const r = recovery(db); if (r) states.add(r.state); if (r && ['PARKED','DEFERRED'].includes(r.state)) break; await pause(20); }
    report.bar('atomic-owner', observedFull && maskedFull === 0 && !partial && !swallowed && committed.length + rejected.length === 200);
    report.bar('reset-bounded', cycles <= 8);
    if (!smoke) report.bar('recovery-state', states.has('RECOVERING') && (states.has('PARKED') || states.has('DEFERRED')));
    // Compare both snapshots to the pre-exhaustion ledger plus commits and the successful drop.
    report.raw.atFull = hashRows(db);
  } finally { if (existsSync(ballast)) unlinkSync(ballast); }
  const spaceAt = performance.now();
  if (smoke || recovery(db)?.state === 'PARKED') {
    report.raw.reopenRequired = true;
    await search.stopSearchIndex(); await start(db);
  }
  await until(() => healthy(db), 'Q2-space-recovery', Math.max(1,60_000-(performance.now()-spaceAt)));
  report.raw.spaceRecoveryMs = performance.now()-spaceAt;
  report.bar('space-recovery',Number(report.raw.spaceRecoveryMs)<=60_000);
  const after = hashRows(db);
  report.raw.expected = expected.hash();
  report.bar('no-loss', JSON.stringify(report.raw.atFull) === JSON.stringify(expected.hash()) && JSON.stringify(after) === JSON.stringify(expected.hash()));
  const index = observer();
  let found = true;
  try { for (const id of committed) { const rowid = db.prepare("SELECT rowid FROM messages WHERE thread_id='qual-turn' AND id=?").get('qual-' + id)!.rowid; found &&= index.prepare('SELECT 1 FROM messages_fts WHERE messages_fts MATCH ? AND rowid=?').get(search.trigramQuery('canary ' + id), rowid) !== undefined; } }
  finally { index.close(); }
  report.bar('findable', found);
  await search.stopSearchIndex();
  if (failBar === 'integrity') writeFileSync(join(DATA_DIR,'search.db'),Buffer.alloc(8192,0x61));
  const integrityChecks = {messages:integrity(join(DATA_DIR,'messages.db')),search:integrity(join(DATA_DIR,'search.db'))};
  report.raw.integrityChecks = integrityChecks;
  report.bar('integrity',integrityChecks.messages && integrityChecks.search);
  report.raw = Object.assign(report.raw, { before, after, committed: committed.length, rejected: rejected.length, observedFull, maskedFull, partial, swallowed, ballastBytes, freeAfterBallast, cycles, states: [...states], events });
  report.finish();
});

it.runIf(leg === 'q3-bound-1k')('Q3 synthetic 1k owner reference', {tags:['qual']}, async()=>{
  const trace=capture();
  try{
    const db=await fresh();seed(db,1000);await start(db);await until(()=>healthy(db),'Q3-1k');
    for(let i=0;i<20;i++)send(60_000+i);
    const bound=boundSample(trace,70_000,100);
    json(join(process.env.MURAGE_QUAL_EVIDENCE??'evidence/r4','q3-1k-bound.json'),bound);
    expect(bound.every(x=>!x.scans.length),'ORACLE:Q3-1k-scans').toBe(true);
  }finally{trace.restore();}
});
