// Astra r11 P2 x2 (+ convergence): per-start and per-request recovery work follows PENDING rows, never history.
// Each probe runs the real recovery code against 1k and 100k completed rows, records the SQL it really issued, and asserts
// (a) the query plan uses the partial index and never scans the base table, (b) the plan is the same at both sizes, and
// (c) the partial index holds only the pending rows, so the rows a recovery can touch do not grow with history.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { ImageOperations } from "./image-operations.ts";
import { createOutputPublisher } from "./output-publication.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { RESTORE_HOLDS_DDL } from "./restore-fence.ts";
import { ownerSendsOwingWords } from "./room-requests.ts";
import { holdFencedFanouts } from "./restore-fanout.ts";
import { OWED_SHARED_SQL } from "./room-request-owed.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

type Recorded = { sql: string; args: unknown[] };
/** Records every statement the code under test runs, with the arguments it was run with. */
function record(db: DatabaseSync, run: () => void): Recorded[] {
  const seen: Recorded[] = [];
  const original = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = original(sql);
    const wrap = <K extends "all" | "get" | "run">(key: K) => {
      const fn = (statement[key] as (...a: unknown[]) => unknown).bind(statement);
      (statement as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => { seen.push({ sql, args }); return fn(...args); };
    };
    wrap("all"); wrap("get"); wrap("run");
    return statement;
  };
  try { run(); } finally { delete (db as { prepare?: unknown }).prepare; }
  return seen;
}
const planOf = (db: DatabaseSync, item: Recorded) => (db.prepare(`EXPLAIN QUERY PLAN ${item.sql}`).all(...(item.args as never[])) as Array<{ detail: string }>).map(row => row.detail);
/** A full scan of the table (or of its alias in the query): any `SCAN <name>` line that is not a scan of the small held list. */
const PENDING_ONLY = /USING (COVERING )?INDEX \w*(pending|awaiting|unannounced|owner_words|fanout_held|shared_owed|inflight)/;
const scansBaseTable = (plan: string[], table: string, ...aliases: string[]) => plan.some(line => [table, ...aliases].some(name => new RegExp(`^SCAN ${name}( |$)`).test(line)) && !PENDING_ONLY.test(line));
/** How many rows the partial index covers: its own WHERE is repeated so SQLite may use it, then the count is checked against the table. */
const countVia = (db: DatabaseSync, table: string, index: string) => {
  const sql = (db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(index) as { sql: string }).sql;
  const where = /\sWHERE\s([\s\S]*)$/.exec(sql)![1]!;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} INDEXED BY ${index} WHERE ${where}`).get() as { n: number }).n);
};

/** The plans of the statements touching `table` that the code issued, normalised so two runs compare equal. */
function plansFor(db: DatabaseSync, issued: Recorded[], table: string): string[][] {
  const unique = new Map<string, Recorded>();
  for (const item of issued) if (new RegExp(`\\b${table}\\b`).test(item.sql) && /^\s*SELECT/i.test(item.sql)) unique.set(item.sql, item);
  return [...unique.values()].map(item => planOf(db, item));
}

const SIZES = [1_000, 100_000];

function fill(db: DatabaseSync, total: number, rows: (i: number) => void): void {
  db.exec("BEGIN");
  try { for (let i = 0; i < total; i++) rows(i); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

it("image operations: startup recovery and request lookup stay flat from 1k to 100k completed rows", () => {
  const results: Array<{ plans: string[][]; pending: number; pendingHash: number; inflight: number; awaiting: number }> = [];
  for (const total of SIZES) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const db = database();
    initializeImageOperations(db); db.exec(RESTORE_HOLDS_DDL);
    const insert = db.prepare("INSERT INTO image_operations VALUES(?,?,?,?,?,?)");
    fill(db, total, i => insert.run(`done-${i}`, `gen-${i}`, `hash-${i % 50}`, i % 7 ? "published" : "not-dispatched", i % 7 ? "{}" : null, i));
    insert.run("pend-1", "gen-p1", "hash-1", "publish-pending", '{"receiptIds":["r"],"resumeKey":"k1"}', total + 1);
    insert.run("run-1", "gen-r1", "hash-1", "running", '{"resumeKey":"k1"}', total + 2);
    insert.run("wait-1", "gen-w1", "hash-1", "awaiting", null, total + 3);
    const operations = new ImageOperations({ store, waiting: () => {} });
    const ops = operations as unknown as { heldCandidates(resumeKey: string, hash: string): unknown[] };
    const actor = { botId: "b", threadId: "t", generation: randomUUID() };
    const issued = record(db, () => {
      operations.resumePendingPublications();
      operations.resumable(actor, "req-1", { prompt: "x" });
      ops.heldCandidates("k1", "hash-1");
      (operations as unknown as { turnOperations(a: { generation: string }): unknown }).turnOperations(actor);
    });
    const ctor = record(db, () => { new ImageOperations({ store, waiting: () => {} }); });
    const plans = [...plansFor(db, issued, "image_operations"), ...plansFor(db, ctor, "image_operations")];
    for (const plan of plans) expect(scansBaseTable(plan, "image_operations", "o"), plan.join(" | ")).toBe(false);
    results.push({
      plans, pending: countVia(db, "image_operations", "image_operations_pending"), pendingHash: countVia(db, "image_operations", "image_operations_pending_hash"),
      inflight: countVia(db, "image_operations", "image_operations_inflight_hash"), awaiting: countVia(db, "image_operations", "image_operations_awaiting"),
    });
  }
  expect(results[1]!.plans).toEqual(results[0]!.plans);
  for (const key of ["pending", "pendingHash", "inflight", "awaiting"] as const) expect(results[1]![key]).toBe(results[0]![key]);
  expect(results[0]).toMatchObject({ pending: 2, pendingHash: 2, inflight: 1, awaiting: 0 }); // the abandoned awaiting row was released by startup recovery
});

it("shell card recovery: producer index follows runs still owing a card, flat from 1k to 100k published outputs", () => {
  const results: Array<{ plans: string[][]; unannounced: number }> = [];
  for (const total of SIZES) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const db = database();
    db.exec(RESTORE_HOLDS_DDL);
    const insert = db.prepare("INSERT INTO output_publications(id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,artifact_id,message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'text/plain',1,'registered',?,?,?,?)");
    fill(db, total, i => insert.run(`done-${i}`, i % 5 ? "shell-output" : "assistant-image", "b", `t${i % 20}`, `run-${i}`, `outputs/${i}.txt`, "a".repeat(64), "art", `m-${i}`, i, i));
    insert.run("pend-1", "shell-output", "b", "t1", "run-pending", "outputs/p.txt", "b".repeat(64), "art-p", null, total + 1, total + 1);
    const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store, artifactScopes: () => [] });
    const issued = record(db, () => publisher.resumePending());
    const plans = plansFor(db, issued, "output_publications");
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(scansBaseTable(plan, "output_publications", "q"), plan.join(" | ")).toBe(false);
    const runsPlan = plans.find(plan => plan.some(line => line.includes("output_publications_unannounced")));
    expect(runsPlan, JSON.stringify(plans)).toBeTruthy();
    results.push({ plans, unannounced: countVia(db, "output_publications", "output_publications_unannounced") });
  }
  expect(results[1]!.plans).toEqual(results[0]!.plans);
  expect(results[1]!.unannounced).toBe(1);
  expect(results[0]!.unannounced).toBe(1);
});

it("room requests: owed owner words, fenced fan-out holds and owed shared results read only pending rows, flat from 1k to 100k", () => {
  const results: Array<{ plans: string[][]; words: number; fanout: number; shared: number }> = [];
  for (const total of SIZES) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    const stmt = db.prepare(`INSERT INTO room_requests(id,root_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,outcome_note,created_at,finished_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
    const insert = { run: (id: string, ...rest: Array<string | number | null>) => stmt.run(id, id, ...rest, `key-${id}`) };
    // history: delivered/kept/finished rows the recovery must never walk
    fill(db, total, i => {
      const kind = i % 4;
      if (kind === 0) insert.run(`h-${i}`, "g", "owner_send", "owner", null, null, "failed", "words", "owner_words_kept", null, i, i, "t");
      else if (kind === 1) insert.run(`h-${i}`, "g", "owner_send", "owner", null, null, "cancelled", "words", null, "cancelled by you", i, i, "t");
      else if (kind === 2) insert.run(`h-${i}`, "g", "ask", "bot", "b", "tt", "done", null, "delivered", null, i, i, "t");
      else insert.run(`h-${i}`, "g", "owner_send", "owner", null, null, "done", "words", null, null, i, i, "t");
    });
    insert.run("owed-words", "g", "owner_send", "owner", null, null, "failed", "words", null, null, total + 1, total + 1, "t");
    insert.run("fenced", "g", "owner_send", "owner", null, null, "done", "words", null, "restored_fanout", total + 2, total + 2, "t");
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES('owed-result', 'none')").run();   // recorded when the shared ask was created
    insert.run("owed-result", "g", "ask", "bot", "b", "tt", "done", null, null, null, total + 3, total + 3, "t");
    const issued = record(db, () => {
      expect(ownerSendsOwingWords(db).map(row => row.id)).toEqual(["owed-words"]);
      holdFencedFanouts(db, { accept: () => ({}) } as never, () => []);
    });
    const plans = plansFor(db, issued, "room_requests");
    expect(plans).toHaveLength(2);
    plans.push(planOf(db, { sql: OWED_SHARED_SQL, args: [] }));
    for (const plan of plans) expect(scansBaseTable(plan, "room_requests"), plan.join(" | ")).toBe(false);
    const joined = plans.map(plan => plan.join(" | ")).join(" || ");
    for (const name of ["room_requests_owner_words", "room_requests_fanout_held"]) expect(joined).toContain(name);
    expect(plans[2]!.join(" | ")).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_room_request_owed|USING PRIMARY KEY/);
    results.push({ plans, words: countVia(db, "room_requests", "room_requests_owner_words"), fanout: countVia(db, "room_requests", "room_requests_fanout_held"), shared: Number((db.prepare("SELECT COUNT(*) AS n FROM room_request_owed WHERE kind='shared_delivery' AND request_id LIKE 'owed-%'").get() as { n: number }).n) });
  }
  expect(results[1]!.plans).toEqual(results[0]!.plans);
  expect(results[0]).toMatchObject({ words: 1, fanout: 1 });
  expect(results[1]).toMatchObject({ words: 1, fanout: 1 });
  expect(results[0]!.shared).toBe(1);
  expect(results[1]!.shared).toBe(1);
});

it("the new indexes are idempotent on an existing database and the older data keeps working", () => {
  const db = database();
  initializeImageOperations(db);
  const names = ["image_operations_pending", "image_operations_pending_hash", "image_operations_inflight_hash", "image_operations_awaiting", "output_publications_unannounced", "room_requests_owner_words", "room_requests_fanout_held"];
  db.exec("DROP INDEX image_operations_pending; DROP INDEX output_publications_unannounced; DROP INDEX room_requests_owner_words");
  closeDatabase();
  const reopened = database();
  initializeImageOperations(reopened); // image_operations is created by ImageOperations at each start, not by database()
  for (const name of names) expect(reopened.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='index' AND name=?").get(name), name).toBeTruthy();
});
