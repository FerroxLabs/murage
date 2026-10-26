// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 Reply withheld, Revision 3b (lanes/release103/REPLY-WITHHELD-CONTRACT.md): every revoke still active when a v10 file (1.0.2's
// format) is upgraded is moved, inside the upgrade transaction, to one fresh commit slot S. A 1.0.2 round trip can leave a revoke whose cap
// is older than lines 1.0.2 wrote while its inherit holds were folded into older rows of the same revoke (e66f707e1 revoke-marker.ts:99);
// at S every stored line under those rows reads checking again, exactly as 1.0.2's uncapped read held it, and the walk caps at S.
// T1 to T7 are the contract's tests.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { downgradeInstallationMemorySchema } from "../installation-memory-downgrade.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { denyLookup } from "./deny-read.ts";
import type { LineageReader, PageLine } from "./lineage-types.ts";
import { INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { markerSlice } from "./revoke-marker.ts";
import { downgradeMemorySchema, migrateMemorySchema } from "./schema.ts";
import { BRANCH_TABLES_SQL } from "../branch-index.ts";
import { MESSAGES_SQL, testThreadNo } from "./testing/writetime-fixture.ts";

const CONTENT: LineageReader = { audience: null };
const inline = { ...INLINE_REVOCATION };
const dirs: string[] = [], dbs: DatabaseSync[] = [];
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation();
});
afterEach(() => {
  stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); closeDatabase();
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

function freshFile(): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "murage-rw3b-")); dirs.push(dir);
  const path = join(dir, "messages.db");
  const db = new DatabaseSync(path); dbs.push(db);
  migrateMemorySchema(db, "active");
  return { db, path };
}
const n = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number(Object.values(db.prepare(sql).get(...args) ?? { x: NaN })[0]);
const next = (db: DatabaseSync) => n(db, "SELECT next FROM memory_lsn WHERE id=1");
const generation = (db: DatabaseSync) => n(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'");
const version = (db: DatabaseSync) => n(db, "SELECT schema_version FROM memory_meta WHERE id=1");
const cap = (db: DatabaseSync, revoke: number) => n(db, "SELECT started_lsn FROM memory_revoke_jobs WHERE revoke_id=?", revoke);
const caps = (db: DatabaseSync) => db.prepare("SELECT revoke_id,started_lsn,state FROM memory_revoke_jobs ORDER BY revoke_id").all().map(row => `${row.revoke_id}:${row.started_lsn}:${row.state}`);
const job = (db: DatabaseSync, revoke: number, kind: string, started: number, state = "active", phase = "flow", root = "{}") =>
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,?,'',?)").run(revoke, kind, root, started, started, phase, state);
const gen = (...ids: string[]): PageLine[] => ids.map(messageId => ({ messageId, author: "generated" as const }));
const page = (db: DatabaseSync, thread: string, ...ids: string[]) =>
  Object.fromEntries([...denyLookup(db, { threadId: thread, lines: gen(...ids) }, CONTENT)].map(([id, verdict]) => [id, verdict.state === "checking" ? `checking:${(verdict as { reason?: string }).reason}` : verdict.state]));
/** A generated line and its lineage row, as the writetime fixture writes one (that fixture's scope rows are not valid for an upgrade). */
function reply(db: DatabaseSync, thread: string, id: string, lsn: number, turnLsn: number): void {
  db.exec(MESSAGES_SQL); db.exec(BRANCH_TABLES_SQL); // (the read gate seeks branch_change)
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','text','',?)").run(thread, id, Date.now(), JSON.stringify({ id, role: "bot" }));
  db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)").run(testThreadNo(db, thread), lsn, id, turnLsn);
  db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(lsn + 1);
}
/** The highest lsn position the file stores (lines, turns, pending since, range ends, sessions): Invariant I(i) says at most S. */
function highestStored(db: DatabaseSync): number {
  return Math.max(
    n(db, "SELECT coalesce(max(lsn),0) FROM memory_line_lineage"), n(db, "SELECT coalesce(max(turn_lsn),0) FROM memory_line_lineage"),
    n(db, "SELECT coalesce(max(since_lsn),0) FROM memory_deny_pending"), n(db, "SELECT coalesce(max(until_turn_lsn),0) FROM memory_deny_range"),
    n(db, "SELECT coalesce(max(last_lsn),0) FROM memory_session_lineage"));
}
/** 1.0.2's markPending, frozen from e66f707e1 server/memory/revoke-marker.ts:95-103: folds by revoke id, with no commit side. */
function markPending102(db: DatabaseSync, revokeId: number, node: string, since: number): boolean {
  const held = db.prepare("SELECT min(since_lsn) AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(node, revokeId)?.s;
  if (held !== null && held !== undefined && Number(held) <= since) return false;
  db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(node, since, revokeId);
  return true;
}
/** What 1.0.2 writes on the v10 file for a copy carried into T: a fresh line and turn above everything, its inherit hold folded. */
function write102Copy(db: DatabaseSync, thread: string, id: string, revoke: number): number {
  const turn = next(db), lsn = turn + 1;
  reply(db, thread, id, lsn, turn);
  expect(markPending102(db, revoke, thread, lsn)).toBe(false); // folded beneath T's older row
  return lsn;
}

it("T1 Astra's path through the real downgrade: a 1.0.2 copy folded under an active bulk's older row reads checking after the re-upgrade", () => {
  let db = database();
  reply(db, "T", "early", 15, 14);
  db.prepare("UPDATE memory_lsn SET next=30 WHERE id=1").run();
  job(db, 4, "bulk", 20, "active", "flow", '{"kind":"bulk","cause":"u2"}');
  db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',10,4),('T',12,4)").run();
  closeDatabase();
  downgradeInstallationMemorySchema(DATA_DIR, 10);
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  expect(version(raw)).toBe(10);
  write102Copy(raw, "T", "copy", 4); // turn 30, line 31: after bulk 4's cap of 20
  raw.close();
  db = database();
  expect(version(db)).toBe(13);
  const S = cap(db, 4);
  expect(S).toBe(next(db) - 1);
  expect(highestStored(db)).toBeLessThanOrEqual(S);
  expect(page(db, "T", "early", "copy")).toEqual({ early: "checking:pending", copy: "checking:pending" });
  // a turn begun after the open is a new turn: outside every capped window
  reply(db, "T", "fresh", next(db) + 1, next(db));
  expect(page(db, "T", "fresh").fresh).toBe("shown");
});

it("T2 the same round trip moves an ordinary line revoke and an inherit job to the one slot", () => {
  const { db } = freshFile();
  db.prepare("UPDATE memory_lsn SET next=40 WHERE id=1").run();
  job(db, 7, "line", 20); job(db, 8, "inherit", 25, "active", "mark", '{"kind":"inherit","cause":"inherit"}');
  db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('T',12,7),('U',22,8)").run();
  downgradeMemorySchema(db, 10);
  write102Copy(db, "T", "t-copy", 7); write102Copy(db, "U", "u-copy", 8);
  const before = next(db);
  migrateMemorySchema(db, "active");
  const S = before;
  expect(next(db)).toBe(S + 1);
  expect([cap(db, 7), cap(db, 8)]).toEqual([S, S]);
  expect(page(db, "T", "t-copy")["t-copy"]).toBe("checking:pending");
  expect(page(db, "U", "u-copy")["u-copy"]).toBe("checking:pending");
});

it("T3 opens that run no step: a current file is left as it is; a v10 file with no active job takes no slot", () => {
  const { db } = freshFile();
  // the shape 53d2336b0's repair rewrote: an active bulk whose own range row ends above its cap
  job(db, 4, "bulk", 20, "active", "flow", '{"kind":"bulk","cause":"u2"}');
  db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES('U',5,30,4,'forget')").run();
  db.prepare("UPDATE memory_lsn SET next=50 WHERE id=1").run();
  const state = () => [next(db), generation(db), ...caps(db)];
  const before = state();
  migrateMemorySchema(db, "active"); migrateMemorySchema(db, "active");
  expect(state()).toEqual(before);
  // (guard) a v10 file whose jobs are all finished: the upgrade takes no slot and moves no generation
  const other = freshFile().db;
  job(other, 5, "line", 20, "done");
  other.prepare("UPDATE memory_lsn SET next=60 WHERE id=1").run();
  downgradeMemorySchema(other, 10);
  const g = generation(other);
  migrateMemorySchema(other, "active");
  expect([version(other), next(other), generation(other), cap(other, 5)]).toEqual([13, 60, g, 20]);
});

it("T4 a seeding bulk beside an active job: only the active job moves; the seeding bulk keeps its row", () => {
  const { db } = freshFile();
  db.prepare("UPDATE memory_lsn SET next=70 WHERE id=1").run();
  job(db, 4, "bulk", 20, "seeding", "flow", '{"kind":"bulk","cause":"u2"}'); job(db, 6, "line", 30);
  downgradeMemorySchema(db, 10);
  const S = next(db), g = generation(db);
  migrateMemorySchema(db, "active");
  expect(caps(db)).toEqual(["4:20:seeding", `6:${S}:active`]);
  expect(generation(db)).toBe(g + 1);
});

it("T5 a failure inside the step rolls the whole upgrade back; the next open runs it", () => {
  const { db, path } = freshFile();
  db.prepare("UPDATE memory_lsn SET next=80 WHERE id=1").run();
  job(db, 6, "line", 30);
  downgradeMemorySchema(db, 10);
  const before = [version(db), next(db), generation(db), ...caps(db)];
  // the abort trigger goes in right after the meta-table rebuild (a trigger made earlier would follow the renamed table the migration drops)
  const exec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql: string) => {
    exec(sql);
    if (sql.includes("SELECT 'reader_door_epoch',next FROM memory_lsn")) exec(`CREATE TEMP TRIGGER rw3b_abort BEFORE UPDATE ON main.memory_lineage_lsn_meta
      WHEN NEW.key='deny_generation' BEGIN SELECT RAISE(ABORT,'rw3b abort'); END`);
  });
  expect(() => migrateMemorySchema(db, "active")).toThrow(/rw3b abort/);
  spy.mockRestore();
  db.close();
  const again = new DatabaseSync(path); dbs.push(again);
  expect([version(again), next(again), generation(again), ...caps(again)]).toEqual(before);
  migrateMemorySchema(again, "active");
  expect([version(again), cap(again, 6), next(again)]).toEqual([13, before[1], Number(before[1]) + 1]);
});

it("T6 after the step: a pre-step line of a later turn is held, and a card patched after the step keeps its uncapped flow row", () => {
  const { db } = freshFile();
  // job 9 (cap 20) holds T from 12; T has a line of turn 25 (after the old cap) that 1.0.2 wrote
  db.prepare("UPDATE memory_lsn SET next=20 WHERE id=1").run();
  job(db, 9, "line", 20);
  db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('T',12,9),('P',5,9)").run();
  downgradeMemorySchema(db, 10);
  reply(db, "T", "mid", 26, 25);
  migrateMemorySchema(db, "active");
  const S = cap(db, 9);
  expect(S).toBeGreaterThan(26);
  expect(page(db, "T", "mid").mid).toBe("checking:pending");
  // a routine card in T written after the step at L, patched with a ref job 9 reaches: its flow edge P -> T uses L; the flow phase seeds
  // T's row at L, above the cap and so uncapped (no clamp), and the card reads checking
  const L = next(db) + 1;
  reply(db, "T", "card", L, L - 1);
  db.prepare("INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES('P','T',?)").run(L);
  db.prepare(`INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(9,-1,'{"node":"P","since":5}')`).run();
  for (let i = 0; i < 40 && n(db, "SELECT count(*) FROM memory_deny_pending WHERE thread_id='T' AND revoke_id=9 AND since_lsn=?", L) === 0; i++) markerSlice(db, 2);
  expect(n(db, "SELECT count(*) FROM memory_deny_pending WHERE thread_id='T' AND revoke_id=9 AND since_lsn=?", L)).toBe(1);
  expect(page(db, "T", "card").card).toBe("checking:pending");
});

it("T7 the walk after the step caps at S: a fresh range marks a line of a turn between the old cap and S, nothing above S", () => {
  const { db } = freshFile();
  db.prepare("UPDATE memory_lsn SET next=20 WHERE id=1").run();
  // job 3 (cap 20) forgets T's line at 10; its range from 10 has not been walked
  reply(db, "T", "root", 10, 9);
  job(db, 3, "line", 20, "active", "mark", '{"kind":"line","threadId":"T","lsn":10}');
  db.prepare(`INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(3,1,'{"kind":"range","threadId":"T","fromLsn":10}')`).run();
  downgradeMemorySchema(db, 10);
  reply(db, "T", "mid", 26, 25); // 1.0.2 wrote it while job 3 was in flight
  migrateMemorySchema(db, "active");
  const S = cap(db, 3);
  // a session begun before S (in the span 1.0.2 ran) is reset; one begun at S is a new session
  db.prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES('T','i','during',24,28),('T','i','after',?,?)").run(S, S + 2);
  for (let i = 0; i < 50 && markerSlice(db, 64) === true; i++) { /* drain */ }
  expect(n(db, "SELECT coalesce(max(until_turn_lsn),0) FROM memory_deny_range WHERE revoke_id=3")).toBe(S);
  expect(page(db, "T", "mid").mid).toBe("withheld");
  expect(db.prepare("SELECT native_session FROM memory_deny_session WHERE revoke_id=3 ORDER BY native_session").all().map(row => row.native_session)).toEqual(["during"]);
  reply(db, "T", "late", next(db) + 1, next(db));
  expect(page(db, "T", "late").late).toBe("shown");
});
