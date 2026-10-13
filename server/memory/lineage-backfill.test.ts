// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S5 (DESIGN-WRITETIME 4): the lineage backfill of an upgraded history, killed and resumed; its per-slice cost at 1k and 100k messages;
// the promoted thread first; U2 blocked on the S0 revoke stub (nothing ready, nothing shown) and finished with a working commit; the
// sliced v10 -> v9 downgrade marking every post-upgrade generated line unprovable for the older build; and the upgrade screen's progress.
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RevokeRoot } from "./lineage-types.ts";

// the S0 stub answers 0; a test that needs U2 to finish switches in a commit that records its roots
const mock = { works: false };
const commits: RevokeRoot[] = [];

const { DATA_DIR } = await import("../config.ts");
const { closeDatabase, database } = await import("../database.ts");
const { downgradeMemorySchema, rootSetMembers } = await import("./schema.ts");
const { citedMemoSizeForTest, lineageBackfillSlice, lineageCertProgress, lineageDowngradeSlice, promoteLineageThread, resetLineageBackfillForTest, setLineageSeedCommitForTest, STALE_MEM_LSN, upgradeMarkerJobs } = await import("./lineage-backfill.ts");
setLineageSeedCommitForTest((_tx, root) => { if (!mock.works) return 0; commits.push(root); return commits.length; });
const { buildLegacyHistory, lineageDump, markUpgraded } = await import("./testing/legacy-history-fixture.ts");
const { testThreadNo } = await import("./testing/writetime-fixture.ts");
const { backgroundJobsPending, backgroundStatus, startBackgroundUpgradeWork } = await import("./upgrade-background.ts");

function reset(): void { closeDatabase(); resetLineageBackfillForTest(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); commits.length = 0; mock.works = false; }
beforeEach(reset);
afterEach(() => { mock.works = false; });

/** A clock that moves `step` ms per reading: a slice's size is then a number of readings, the same on every machine. */
const ticking = (step = 1) => { let t = 0; return () => (t += step); };
function runToEnd(db: DatabaseSync, budgetMs = 50, clock = ticking()): number {
  let slices = 0;
  while (lineageBackfillSlice(db, { budgetMs, now: clock }).more) if (++slices > 1_000_000) throw new Error("no end");
  return slices;
}

describe("U1 rows", () => {
  it("writes a row for every message: old lsns below 1 in insertion order, owner lines plain, receipts folded, copies and roots carried", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 7, threads: 4, lines: 40, copies: 0.2 });
    // a stale receipt (an older policy revision) on the first bot line that has one
    const staleThread = history.threads[0]!, stale = history.lines.get(staleThread)!.find(line => line.receipt)!;
    db.prepare("UPDATE memory_disclosures SET policy_revision=-1 WHERE bundle_id=?").run(stale.receipt);
    markUpgraded(db);
    // the generated history holds chained sets the RC could not prove: their lines get no row, and what was captured from them and the
    // receipts resting on it become U2 roots (a working commit lets U2 finish)
    mock.works = true;
    runToEnd(db);
    const cert = lineageCertProgress(db);
    // no deny fact was added to this history: U2 commits only the unprovable lines' sources and the receipts the RC held bad, then the
    // certificate turns ready
    expect(cert).toMatchObject({ phase: "done", ready: true });
    const rows = db.prepare("SELECT t.thread_id AS t,l.lsn,l.message_id AS m,(l.turn_lsn IS NOT NULL) AS g,l.turn_lsn AS tl,l.mem_lsn AS ml FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no ORDER BY t.thread_id,l.lsn").all();
    const total = Number(db.prepare("SELECT count(*) AS n FROM messages").get()!.n);
    const unprovable = rows.length;
    expect(unprovable).toBeLessThanOrEqual(total);
    for (const row of rows) expect(Number(row.lsn)).toBeLessThan(1);
    // positional order inside a thread is insertion order
    for (const thread of history.threads) {
      const lsns = rows.filter(row => row.t === thread).map(row => Number(row.lsn));
      expect([...lsns].sort((a, b) => a - b)).toEqual(lsns);
      const ids = rows.filter(row => row.t === thread).map(row => String(row.m));
      const inOrder = history.lines.get(thread)!.map(line => line.id).filter(id => ids.includes(id));
      expect(ids).toEqual(inOrder);
    }
    // owner lines: generated 0, no turn
    for (const row of rows.filter(row => String(row.m).match(/^m\d*[02468]$/))) { expect(row.g).toBe(0); expect(row.tl).toBe(null); }
    // the stale receipt's line and every later line of its thread read below every watermark
    const staleRow = rows.find(row => row.t === staleThread && row.m === stale.id)!;
    expect(Number(staleRow.ml)).toBe(STALE_MEM_LSN);
    for (const row of rows.filter(row => row.t === staleThread && Number(row.lsn) > Number(staleRow.lsn))) expect(Number(row.ml)).toBe(STALE_MEM_LSN);
    // every copy carries its origin (point carry, flow edge)
    for (const [thread, lines] of history.lines) for (const line of lines) {
      if (!line.copyOf) continue;
      const child = rows.find(row => row.t === thread && row.m === line.id);
      if (!child) continue; // unprovable ancestry: no row, reads "checking"
      const origin = rows.find(row => row.t === line.copyOf!.threadId && row.m === line.copyOf!.messageIds[0]);
      expect(origin, "an origin earlier in the history has its row").toBeTruthy();
      if (line.copyOf.threadId !== thread) {
        expect(db.prepare("SELECT 1 AS x FROM memory_lineage_carry WHERE parent_thread_no=? AND to_lsn=? AND from_lsn=? AND child_kind=0 AND child_thread_no=? AND child_ref=?").get(testThreadNo(db, line.copyOf.threadId), origin!.lsn, origin!.lsn, testThreadNo(db, thread), String(child.lsn))).toBeTruthy();
        expect(db.prepare("SELECT 1 AS x FROM memory_thread_flow WHERE from_thread=? AND to_thread=?").get(line.copyOf.threadId, thread)).toBeTruthy();
      }
    }
    // captures and sessions
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_line_capture").get()!.n)).toBeGreaterThan(0);
    // a session resting on a chained set the RC could not prove gets no row (it resets), as the RC reset it
    const provableSessions = history.sessions.filter(session => { const set = db.prepare("SELECT set_id AS s FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(session.threadId, session.driverInstance, session.nativeSession)?.s; return typeof set === "string" && rootSetMembers(db, set) !== null; }).length;
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_session_lineage").get()!.n)).toBe(provableSessions);
    // nothing for U2 was committed
    for (const root of commits) expect(`${root.kind}:${"cause" in root ? root.cause : ""}`).toMatch(/^(memory:unprovable|receipt:receipt-revoked)$/);
  });

  it("a line resting on the unprovable root set or on a root that is gone gets no row (reads \"checking\", never shown)", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 3, threads: 2, lines: 20, rootSets: 0, copies: 0 });
    const thread = history.threads[0]!, bot = history.lines.get(thread)!.filter(line => line.role === "bot");
    db.prepare("INSERT OR REPLACE INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,'')").run(thread, bot[0]!.id);
    db.prepare("INSERT OR REPLACE INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, bot[1]!.id, "rs-missing");
    markUpgraded(db);
    runToEnd(db);
    const has = (id: string) => Boolean(db.prepare("SELECT 1 AS x FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(testThreadNo(db, thread), id));
    expect(has(bot[0]!.id)).toBe(false);
    expect(has(bot[1]!.id)).toBe(false);
    expect(has(bot[2]!.id)).toBe(true);
  });
});

describe("kill and resume", () => {
  it("a run killed at random points (mid slice and between slices, with the connection closed) writes exactly what an uninterrupted run writes", () => {
    const options = { seed: 11, threads: 6, lines: 60, copies: 0.1 };
    mock.works = true;
    let db = database();
    buildLegacyHistory(db, options);
    markUpgraded(db);
    runToEnd(db, 5);
    const reference = lineageDump(db);
    expect(reference.line!.length).toBeGreaterThan(200);

    reset();
    mock.works = true;
    db = database();
    buildLegacyHistory(db, options);
    markUpgraded(db);
    let kills = 0, slices = 0;
    for (let round = 0; round < 10_000; round++) {
      // a kill: the clock throws partway through a slice; the slice's transaction is lost, its cursor with it
      let readings = 0;
      const limit = 3 + (round * 7) % 23;
      const clock = () => { if (++readings > limit && round % 3 === 0) throw Object.assign(new Error("killed"), { killed: true }); return readings; };
      let more = true;
      try { more = lineageBackfillSlice(db, { budgetMs: 5, now: clock }).more; slices++; }
      catch (error) { expect((error as { killed?: boolean }).killed).toBe(true); kills++; expect(db.isTransaction).toBe(false); }
      if (round % 5 === 4) { closeDatabase(); resetLineageBackfillForTest(); db = database(); } // the process ends; promotions and caches go with it
      if (!more) break;
    }
    expect(kills).toBeGreaterThan(3);
    expect(slices).toBeGreaterThan(10);
    expect(lineageCertProgress(db).phase).toBe("done");
    expect(lineageDump(db)).toEqual(reference);
  });
});

/** Counts what each statement does: executions and rows returned, and keeps the SQL so its plans can be read. */
function metered(db: DatabaseSync) {
  const stats = { executions: 0, rows: 0, sql: new Set<string>() };
  const wrap = (statement: StatementSync, sql: string) => new Proxy(statement, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "all") return (...args: unknown[]) => { stats.executions++; stats.sql.add(sql); const rows = (value as (...a: unknown[]) => unknown[]).apply(target, args); stats.rows += rows.length; return rows; };
      if (key === "get") return (...args: unknown[]) => { stats.executions++; stats.sql.add(sql); const row = (value as (...a: unknown[]) => unknown).apply(target, args); if (row !== undefined) stats.rows++; return row; };
      if (key === "run") return (...args: unknown[]) => { stats.executions++; stats.sql.add(sql); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as DatabaseSync, stats, reset() { stats.executions = 0; stats.rows = 0; stats.sql.clear(); } };
}
/** Same shape at any size: every thread like every other, so a late slice meets the same rows whatever came before. */
function uniformHistory(db: DatabaseSync, messages: number): void {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let at = 0; at < messages; at++) insert.run(`u${Math.floor(at / 100)}`, `m${at % 100}`, at, at % 2 ? "bot" : "user", "text", "x", "{}");
  db.exec("COMMIT");
}

describe("cost per slice is flat in history", () => {
  it("the last slice of U1 runs the same statements and reads the same rows at 1k and 100k messages, every one a seek", () => {
    const measure = (messages: number) => {
      reset();
      const db = database();
      uniformHistory(db, messages);
      markUpgraded(db);
      const meter = metered(db);
      // one clock reading per line and a budget of 100: each slice is exactly one thread of 100 messages; the last one is metered
      const clock = ticking();
      const cursorRowid = () => { const text = String(db.prepare("SELECT cursor FROM memory_lineage_cert WHERE id=1").get()!.cursor); return text ? Number(JSON.parse(text).rowid) : 0; };
      let last = { executions: 0, rows: 0 }, sql: string[] = [];
      for (;;) {
        const before = cursorRowid();
        meter.reset();
        const more = lineageBackfillSlice(meter.db, { budgetMs: 100, now: clock }).more;
        if (before === messages - 100) { last = { executions: meter.stats.executions, rows: meter.stats.rows }; sql = [...meter.stats.sql]; expect(cursorRowid()).toBe(messages); }
        if (!more || lineageCertProgress(db).phase !== "u1") break;
      }
      // the plan of every statement the slice ran: no full read of a table that grows with the history
      expect(sql.length).toBeGreaterThan(3);
      for (const text of sql) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all().map(row => String(row.detail));
        for (const step of plan) expect(step, text).not.toMatch(/^SCAN (?!.*VIRTUAL TABLE)/); // a seek or a json_each, never a scan
      }
      return last;
    };
    const small = measure(1_000), large = measure(100_000);
    expect(small.executions).toBeGreaterThan(0);
    expect(large).toEqual(small);
  }, 600_000);

  it("promoting a thread is constant time and its rows come first", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 5, threads: 5, lines: 60, copies: 0, rootSets: 0 });
    markUpgraded(db);
    const target = history.threads[3]!;
    promoteLineageThread(target);
    lineageBackfillSlice(db, { budgetMs: 100, now: ticking() });
    const rows = db.prepare("SELECT t.thread_id AS t,count(*) AS n FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no GROUP BY t.thread_id").all();
    const of = (thread: string) => Number(rows.find(row => row.t === thread)?.n ?? 0);
    expect(of(target)).toBe(60);
    for (const thread of history.threads) if (thread !== target) expect(of(thread)).toBeLessThan(60);
  });
});

describe("U2 seed", () => {
  it("against the S0 revoke stub, U2 stops with nothing committed: the certificate stays not ready (every generated line reads \"checking\")", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 4, threads: 2, lines: 20 });
    db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,0,1)").run(history.threads[0]);
    markUpgraded(db);
    runToEnd(db);
    expect(lineageCertProgress(db)).toMatchObject({ phase: "u2", ready: false });
    expect(commits).toEqual([]);
    expect(lineageBackfillSlice(db).more).toBe(false); // no scheduler spins on it
  });

  it("with a working revoke commit every deny fact becomes a root once and the certificate turns ready in the last seed's transaction", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 9, threads: 3, lines: 30, rootSets: 0, copies: 0 });
    const thread = history.threads[1]!;
    const bot = history.lines.get(thread)!.filter(line => line.role === "bot");
    db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t1','source',?,1,NULL,0,'owner-forget',1)").run(`message:${thread}:${bot[0]!.id}`);
    db.prepare("INSERT OR IGNORE INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot','settled',NULL,'active')").run(`message:${thread}:${bot[0]!.id}`, history.scopeOf.get(thread)!, thread, bot[0]!.id);
    db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id=?").run(thread, bot[1]!.id);
    db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(history.docs[2]);
    db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,0,1)").run(history.threads[2]);
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(history.receipts[0]);
    markUpgraded(db);
    mock.works = true;
    runToEnd(db, 5);
    const cert = lineageCertProgress(db);
    expect(cert).toMatchObject({ phase: "done", ready: true });
    expect(cert.done).toBe(cert.total);
    const kinds = commits.map(root => `${root.kind}:${"cause" in root ? root.cause : ""}`).sort();
    // each deny fact once; besides them only receipts the RC held bad on content (citing the forgotten or retired source)
    expect([...new Set(kinds)]).toEqual(["line:forget", "line:hide", "memory:forget", "memory:retire", "receipt:receipt-content", "receipt:receipt-revoked", "thread:delete-conversation"]);
    for (const kind of ["line:forget", "line:hide", "memory:forget", "memory:retire", "thread:delete-conversation"]) expect(kinds.filter(k => k === kind), kind).toHaveLength(1);
    expect(lineageBackfillSlice(db).more).toBe(false);
  });
});

describe("v10 -> v9 downgrade", () => {
  function writtenByNewBuild(db: DatabaseSync) {
    // lines 1.0.2 wrote (lsn >= lineage_upgrade_lsn = 1), and deny marks on old and new lines
    const history = buildLegacyHistory(db, { seed: 13, threads: 2, lines: 12, rootSets: 0, copies: 0 });
    markUpgraded(db);
    mock.works = true;
    runToEnd(db);
    const thread = history.threads[0]!;
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,'{}')");
    for (let at = 0; at < 4; at++) {
      insert.run(thread, `new${at}`, 1_000 + at, at % 2 ? "bot" : "user", "text", "x");
      db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)").run(testThreadNo(db, thread), 1 + at, `new${at}`, at % 2 ? at : null);
    }
    db.prepare("UPDATE memory_lsn SET next=5 WHERE id=1").run();
    const oldBot = history.lines.get(history.threads[1]!)!.filter(line => line.role === "bot");
    const lsnOf = (t: string, m: string) => Number(db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(testThreadNo(db, t), m)!.lsn);
    db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,1,2,'forget')").run(history.threads[1], lsnOf(history.threads[1]!, oldBot[0]!.id));
    db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES(?,?,?,2,'forget')").run(history.threads[1], lsnOf(history.threads[1]!, oldBot[2]!.id), 0);
    db.prepare("INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,3)").run(thread, "d", "s9");
    return { history, thread, oldBot };
  }
  const flag = (db: DatabaseSync, t: string, m: string) => db.prepare("SELECT json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE thread_id=? AND id=?").get(t, m)?.w;

  it("marks every generated line 1.0.2 wrote unprovable, every denied line withheld, every denied session reset, then drops v10", () => {
    const db = database();
    const { history, thread, oldBot } = writtenByNewBuild(db);
    const result = downgradeMemorySchema(db, 9);
    expect(result.status).toBe("downgraded");
    expect(Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version)).toBe(9);
    // new generated lines: the unprovable set (1.0.1 and the RC withhold it); new owner lines untouched
    expect(db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id='new1'").get(thread)?.set_id).toBe("");
    expect(db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id='new3'").get(thread)?.set_id).toBe("");
    expect(db.prepare("SELECT 1 AS x FROM memory_output_roots WHERE thread_id=? AND message_id='new0'").get(thread)).toBeUndefined();
    // deny_line and deny_range: withheldFromBots on the generated lines they cover
    expect(flag(db, history.threads[1]!, oldBot[0]!.id)).toBe(1);
    expect(flag(db, history.threads[1]!, oldBot[1]!.id)).toBe(null);
    for (const line of oldBot.slice(3)) expect(flag(db, history.threads[1]!, line.id)).toBe(1);
    // deny_session: the session resets in the older build
    expect(db.prepare("SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance='d' AND native_session='s9'").get(thread)?.set_id).toBe("");
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='memory_line_lineage'").get()).toBeUndefined();
  });

  it("a downgrade stopped part way resumes where it was, and one that finds 1.0.2 wrote since starts the marking again", () => {
    const db = database();
    const { thread } = writtenByNewBuild(db);
    // a few slices, then the process stops
    let readings = 0;
    expect(lineageDowngradeSlice(db, { budgetMs: 1, now: () => ++readings }).done).toBe(false);
    expect(lineageCertProgress(db).phase).toBe("down");
    // 1.0.2 runs again and writes a generated line before the downgrade is retried
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,2000,'bot','text','x','{}')").run(thread, "late");
    db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,5,'late',5,NULL,NULL)").run(testThreadNo(db, thread));
    db.prepare("UPDATE memory_lsn SET next=6 WHERE id=1").run();
    expect(downgradeMemorySchema(db, 9).status).toBe("downgraded");
    expect(db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id='late'").get(thread)?.set_id).toBe("");
  });
});

describe("upgrade screen", () => {
  it("the progress moves through every phase (U1s, U1m, U1f, U2) and holds the last unit for the ready certificate", () => {
    const db = database();
    buildLegacyHistory(db, { seed: 22, threads: 4, lines: 60 });
    markUpgraded(db);
    mock.works = true;
    const byPhase = new Map<string, number[]>();
    const clock = ticking();
    for (let slices = 0; slices < 100_000; slices++) {
      const step = lineageBackfillSlice(db, { budgetMs: 2, now: clock });
      const cert = lineageCertProgress(db);
      (byPhase.get(cert.phase) ?? byPhase.set(cert.phase, []).get(cert.phase)!).push(cert.done);
      if (!cert.ready) expect(cert.done).toBeLessThan(cert.total);
      if (!step.more) break;
    }
    const all = [...byPhase.values()].flat();
    for (let at = 1; at < all.length; at++) expect(all[at]!).toBeGreaterThanOrEqual(all[at - 1]!);
    const top = (phase: string) => Math.max(...(byPhase.get(phase) ?? [-1]));
    // each later phase ends above where the one before it ended: the strip never sits on one value from U1s to U2
    expect(top("u1")).toBeLessThan(top("u1s") + 1);
    for (const phase of ["u1s", "u1m", "u1f", "u2"]) expect(byPhase.has(phase) || phase === "u1s" || phase === "u1f", phase).toBe(true);
    expect(new Set(all).size).toBeGreaterThan(6);
    expect(lineageCertProgress(db).ready).toBe(true);
    expect(lineageCertProgress(db).done).toBe(lineageCertProgress(db).total);
  });
  it("the write-time backfill is a background job whose progress reads the certificate: rows walked of rows to walk, done when ready", async () => {
    const db = database();
    buildLegacyHistory(db, { seed: 21, threads: 4, lines: 80 });
    markUpgraded(db);
    mock.works = true;
    expect(backgroundJobsPending(db)).toContain("writetime");
    const seen: Array<{ done: number; total: number; overall: number }> = [];
    const handle = startBackgroundUpgradeWork(db, { sliceMs: 1, pauseMs: 0, afterSlice: job => {
      if (job !== "writetime") return;
      const status = backgroundStatus(db);
      const phase = status.progress?.phases.find(p => p.id === "writetime");
      const cert = lineageCertProgress(db);
      if (phase) { expect(phase.total).toBe(Math.max(cert.total, 1)); seen.push({ done: phase.done, total: phase.total, overall: status.progress!.overall }); }
    } });
    await handle.done;
    expect(lineageCertProgress(db).ready).toBe(true);
    expect(seen.length).toBeGreaterThan(3);
    for (let at = 1; at < seen.length; at++) { expect(seen[at]!.done).toBeGreaterThanOrEqual(seen[at - 1]!.done); expect(seen[at]!.overall).toBeGreaterThanOrEqual(seen[at - 1]!.overall); }
    expect(seen.some(step => step.done > 0 && step.done < step.total), "a real fraction in between").toBe(true);
    expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
    expect(backgroundJobsPending(db)).not.toContain("writetime");
  });
});

/** Counts the executions of every statement whose text matches, on one connection (the proxy sees each prepare, so it must go in before the first slice). */
function countStatements(db: DatabaseSync, patterns: Record<string, RegExp>): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(patterns).map(name => [name, 0]));
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const statement = real(sql);
    const hit = Object.entries(patterns).filter(([, pattern]) => pattern.test(sql)).map(([name]) => name);
    if (!hit.length) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      if (key === "all" || key === "get" || key === "run") return (...args: unknown[]) => { for (const name of hit) counts[name]!++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
  };
  return counts;
}

describe("RC3 upgrade progress on a resumed file", () => {
  it("a certificate that began under Preview 2 (total = span + 1, a cursor in hand) gets its total recomputed and its bar moves", () => {
    const db = database();
    buildLegacyHistory(db, { seed: 31, threads: 3, lines: 40 });
    markUpgraded(db);
    mock.works = true;
    const clock = ticking();
    for (let slices = 0; slices < 3; slices++) lineageBackfillSlice(db, { budgetMs: 2, now: clock });
    const row = db.prepare("SELECT cursor FROM memory_lineage_cert WHERE id=1").get()!;
    const cursor = JSON.parse(String(row.cursor)) as { top: number; low: number };
    const span = cursor.top - cursor.low + 1;
    db.prepare("UPDATE memory_lineage_cert SET total=? WHERE id=1").run(span + 1); // the Preview 2 shape
    const before = lineageCertProgress(db);
    expect(before.ready).toBe(false);
    lineageBackfillSlice(db, { budgetMs: 2, now: clock });
    const after = lineageCertProgress(db);
    expect(after.total).toBeGreaterThan(span + 1);
    expect(after.done).toBeLessThan(after.total - 1);
    // and the bar still reaches 100% on the resumed file
    runToEnd(db);
    const end = lineageCertProgress(db);
    expect(end).toMatchObject({ ready: true });
    expect(end.done).toBe(end.total);
  });

  it("the cited-verdict memo lasts across slices: the recursive record read runs once per cited record, 10 receipts or 2,000", () => {
    const run = (receipts: number): { recursive: number; kept: number } => {
      reset();
      const db = database();
      const history = buildLegacyHistory(db, { seed: 41, threads: 2, lines: 12, records: 1, rootSets: 0, copies: 0 });
      const thread = history.threads[0]!, scope = history.scopeOf.get(thread)!, doc = history.docs[0]!;
      for (let at = 0; at < 5; at++) {
        db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact','text','observed','active',0,0,NULL,NULL,0)").run(`cite-${at}`, scope);
        db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,3)").run(`cite-${at}`, doc);
      }
      const cited = JSON.stringify(Array.from({ length: 5 }, (_, at) => ({ id: `cite-${at}`, version: 1 })));
      const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','s',?,'[]','[]',0,0,0,'delivered',9)");
      for (let at = 0; at < receipts; at++) insert.run(`zz-rc-${String(at).padStart(6, "0")}`, thread, cited);
      markUpgraded(db);
      mock.works = true;
      const counts = countStatements(db, { recursive: /WITH RECURSIVE parents/ });
      runToEnd(db, 1, ticking(1)); // about one row per slice
      return { recursive: counts.recursive!, kept: citedMemoSizeForTest(db) };
    };
    const few = run(10), many = run(2_000);
    expect(few.recursive).toBeGreaterThan(0);
    expect(many.recursive).toBe(few.recursive);
  }, 120_000);

  it("a change of the file's data revision clears the cited memo, so a stale verdict is never kept", () => {
    const db = database();
    const history = buildLegacyHistory(db, { seed: 42, threads: 2, lines: 12, records: 1, rootSets: 0, copies: 0 });
    const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','s',?,'[]','[]',0,0,0,'delivered',9)");
    for (let at = 0; at < 30; at++) insert.run(`zz-${String(at).padStart(3, "0")}`, history.threads[0], JSON.stringify([{ id: `rec:${history.threads[0]}`, version: 1 }]));
    markUpgraded(db);
    mock.works = true;
    const recursive = countStatements(db, { n: /WITH RECURSIVE parents/ });
    const clock = ticking();
    let guard = 0;
    while (recursive.n === 0 && lineageBackfillSlice(db, { budgetMs: 1, now: clock }).more) if (++guard > 100_000) throw new Error("no cited verdict");
    expect(citedMemoSizeForTest(db)).toBeGreaterThan(0);
    // the revision moves: the next receipt that cites the record reads it again (the old verdict is not trusted)
    const before = recursive.n;
    db.prepare("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1").run();
    for (let slices = 0; slices < 100_000 && recursive.n === before; slices++) if (!lineageBackfillSlice(db, { budgetMs: 1, now: clock }).more) break;
    expect(recursive.n).toBeGreaterThan(before);
  });
});

describe("the strip's marker phase", () => {
  it("a ready certificate with the seed's bulk revokes still walking is a writetime job with a marker phase, and the job ends when the marker has", async () => {
    setLineageSeedCommitForTest(null); // the real revoke commit: U2 opens the bulk revokes
    try {
      const db = database();
      const history = buildLegacyHistory(db, { seed: 45, threads: 3, lines: 30, rootSets: 0, copies: 0 });
      db.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,0,1)").run(history.threads[2]);
      markUpgraded(db);
      runToEnd(db);
      expect(lineageCertProgress(db).ready).toBe(true);
      expect(upgradeMarkerJobs(db)).toBeGreaterThan(0);
      expect(backgroundJobsPending(db)).toContain("writetime");
      const phases = new Set<string>();
      const handle = startBackgroundUpgradeWork(db, { sliceMs: 5, pauseMs: 0, afterSlice: job => { if (job === "writetime") { const marker = backgroundStatus(db).progress?.phases.find(phase => phase.id === "marker"); if (marker && marker.total > 0) phases.add(marker.state); } } });
      await handle.done;
      expect(phases.size).toBeGreaterThan(0); // the strip had a marker phase with a size of its own
      expect(upgradeMarkerJobs(db)).toBe(0);
      expect(backgroundJobsPending(db)).not.toContain("writetime");
    } finally { setLineageSeedCommitForTest((_tx, root) => { if (!mock.works) return 0; commits.push(root); return commits.length; }); }
  }, 120_000);
});
