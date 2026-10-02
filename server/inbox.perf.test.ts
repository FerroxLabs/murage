// SPDX-License-Identifier: AGPL-3.0-or-later
// Disk-burn regression (0.1.58 on): the Inbox projection used to be scanned
// 8 to 9 times per call with every message's full json in the window sort, so
// a 5 s poll spilled SQLite temp files continuously. These tests pin: scans
// per call, the cache answering repeat polls, the rewritten SQL returning
// exactly what the old SQL did, and the temp-file bound.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as inbox from "./inbox.ts";
import { initializeInbox, listInbox, owedThreads, type InboxAccess } from "./inbox.ts";
import * as legacy from "./inbox.legacy-reference.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const THREADS = 20, ROWS = 5000;
const access: InboxAccess = { owner: true, threads: Array.from({ length: THREADS }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}`, botId: `b${i}` })) };
const pad = "x".repeat(3800);

/** The cached entry point when it exists; falls back to the plain one so the
 *  suite fails on numbers, not on a missing export, against the old code. */
const cached = ((inbox as Record<string, unknown>).listInboxCached ?? listInbox) as typeof listInbox;

function seed(rows = ROWS) {
  const root = mkdtempSync(join(tmpdir(), "murage-inbox-perf-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const thread = `t${i % THREADS}`, at = 1_000_000 + i * 1000, id = `m${i}`;
    let m: Record<string, unknown>;
    switch (i % 10) {
      case 0: case 1: case 2: case 3: case 4: case 5: // routine runs, six in ten
        m = { kind: "routine.run", routineRun: { runId: `run${i}`, routineId: `r${i % 7}`, routineName: `Routine ${i % 7}`, status: i % 4 === 0 ? "failed" : "completed", error: i % 4 === 0 ? "401 unauthorized" : undefined, summary: i % 4 === 0 ? "" : `Found ${i} things`, blob: pad } };
        break;
      case 6: m = { kind: "activity", tool: { name: "Provider", ok: false, authRequired: i % 2 === 0 ? true : undefined, errorDetails: pad } }; break;
      case 7: m = { kind: "options", card: { requestId: `req${i % 40}`, title: "Command", options: ["Allow", "Deny"], tool: i % 3 === 0 ? "Bash" : undefined, expired: i % 9 === 0 ? true : undefined, answered: i % 5 === 0 ? "Allowed" : undefined, pad } }; break;
      case 8: m = { kind: "goal.run", goalRun: { runId: `goal${i}`, status: i % 2 ? "needs-input" : "done", detail: `Goal ${i}`, pad } }; break;
      default: m = { kind: "connector", connector: { resumeKey: `k${i % 5}`, slug: "gmail", status: i % 2 ? "connected" : "pending", pad } };
    }
    const value = { id, at, role: "bot", ...m };
    insert.run(thread, id, at, "bot", String(m.kind), null, JSON.stringify(value));
  }
  db.exec("COMMIT");
  return db;
}

/** Counts executions of the Inbox projection. "Bounded" ones are restricted to
 *  routine rows (kind filter in raw) and read from a narrow index range. */
function counting(db: DatabaseSync) {
  const counts = { full: 0, bounded: 0, other: 0 };
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("WITH raw AS")) return statement;
    const kind = /m\.kind IN \('routine\.run','goal\.run'(,'activity')?\)/.test(sql) ? "bounded" : "full";
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...a: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { counts[kind]++; return original(...args); };
    }
    return statement;
  };
  return counts;
}

it("one listInbox call scans the projection at most twice (was 8 to 9)", () => {
  const db = seed(), counts = counting(db);
  const page = listInbox(db, { view: "decisions" }, access);
  console.log(`[perf] listInbox decisions: full scans=${counts.full} bounded=${counts.bounded}`);
  expect(page.total).toBeGreaterThan(0);
  expect(counts.full).toBeLessThanOrEqual(2);
});

it("an hour of 5 s polls with nothing changing does zero extra scans after the first", () => {
  const db = seed(), counts = counting(db);
  let now = 5_000_000;
  const first = cached(db, { view: "decisions" }, access, now);
  const after = { ...counts };
  let polls = 0;
  for (let t = 5; t <= 3600; t += 5) {
    now += 5000; polls++;
    expect(cached(db, { view: "decisions" }, access, now)).toEqual(first);
    // Fail on the first repeat poll that scans, rather than grinding through 720 of them.
    if (counts.full + counts.bounded !== after.full + after.bounded) {
      console.log(`[perf] poll ${polls} of 720 scanned again: full=${counts.full - after.full} bounded=${counts.bounded - after.bounded}`);
      break;
    }
  }
  console.log(`[perf] 720 polls: first=${after.full + after.bounded} scans, extra=${counts.full + counts.bounded - after.full - after.bounded}`);
  expect(counts.full).toBe(after.full);
  expect(counts.bounded).toBe(after.bounded);
});

it("a message write invalidates the cache, then polls are cached again", () => {
  const db = seed(200), counts = counting(db);
  const first = cached(db, { view: "decisions" }, access, 5_000_000);
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run("t0", "fresh", 9_000_000, "bot", "options", null, JSON.stringify({ id: "fresh", at: 9_000_000, role: "bot", kind: "options", card: { requestId: "fresh-req", options: ["Allow"], tool: "Bash" } }));
  bumpMessagesVersion();
  const second = cached(db, { view: "decisions" }, access, 5_005_000);
  expect(second.decisions).toBe(first.decisions + 1);
  const scans = counts.full;
  cached(db, { view: "decisions" }, access, 5_010_000);
  expect(counts.full).toBe(scans);
});

it("a snooze running out ends the cached answer", () => {
  const db = seed(200);
  const first = cached(db, { view: "decisions" }, access, 5_000_000);
  const target = first.items[0];
  const state = db.prepare("INSERT INTO inbox_item_state(source_key,snoozed_until) VALUES(?,?)");
  state.run(Buffer.from(target.id, "base64url").toString("utf8"), 5_030_000);
  bumpMessagesVersion();
  const during = cached(db, { view: "decisions" }, access, 5_010_000);
  expect(during.items.some(item => item.id === target.id)).toBe(false);
  const after = cached(db, { view: "decisions" }, access, 5_040_000);
  expect(after.items.some(item => item.id === target.id)).toBe(true);
});

it("the rewritten queries return exactly what the old ones did, on every view", () => {
  const db = seed(1500);
  const views = ["decisions", "approvals", "questions", "connections", "routines", "to-read", "results", "all"] as const;
  for (const view of views) for (const page of [0, 1]) for (const includeSnoozed of [false, true]) {
    const query = { view, page, pageSize: 25, includeSnoozed };
    expect(listInbox(db, query, access, 9_000_000), `${view} p${page}`).toEqual(legacy.listInbox(db, query, access, 9_000_000));
  }
  expect(listInbox(db, { view: "all", query: "routine 3" }, access, 9_000_000)).toEqual(legacy.listInbox(db, { view: "all", query: "routine 3" }, access, 9_000_000));
  expect([...owedThreads(db, access)].sort()).toEqual([...legacy.owedThreads(db, access)].sort());
  expect(listInbox(db, { view: "decisions" }, access, 9_000_000).total).toBeGreaterThan(0);
}, 300_000);

it("the projection stays inside memory: temp-file writes are bounded", () => {
  const db = seed();
  db.exec("PRAGMA temp_store=FILE; PRAGMA cache_size=-2000");
  const before = process.resourceUsage().fsWrite;
  for (let i = 0; i < 5; i++) listInbox(db, { view: "decisions" }, access, 9_000_000);
  const blocks = process.resourceUsage().fsWrite - before;
  console.log(`[perf] temp_store=FILE, 5 calls: fsWrite blocks=${blocks}`);
  // 5 calls over ~20 MB of json used to write hundreds of MB. Narrow columns
  // sort in the 2 MB page cache, so this stays tiny.
  expect(blocks).toBeLessThan(2_000);
});

/** Every row shape the projection reads, plus the Inbox's own marks: read
 *  (current and stale), snoozed (running and run out), cleared (before and
 *  after newer activity), and duplicated source keys. */
function seedRich() {
  const db = seed(600);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const add = (thread: string, id: string, at: number, kind: string, body: Record<string, unknown>, role = "bot") => {
    const json = JSON.stringify({ id, at, role, kind, ...body });
    insert.run(thread, id, at, role, kind, null, json);
    return json;
  };
  const marks: Array<[string, string]> = [];
  for (let i = 0; i < 60; i++) {
    const thread = `t${i % THREADS}`, at = 8_000_000 + i * 997;
    add(thread, `sec${i}`, at, "secret", { secret: { requestKey: `key${i % 12}`, provided: i % 4 === 0 ? true : undefined, label: "API key", description: "never shown" } });
    add(thread, `mcp${i}`, at + 1, "mcpSignIn", { mcpSignIn: { resumeKey: `mk${i % 6}`, name: `Link ${i % 3}`, status: i % 3 === 0 ? "signed-in" : "pending", body: `Sign in to link ${i % 3}` } });
    add(thread, `dig${i}`, at + 2, "activity", { actorKind: "murage", murage: { kind: "status", digestDay: `2026-09-${10 + (i % 9)}` }, tool: { name: `Digest ${i}`, ok: true } });
    add(thread, `art${i}`, at + 3, "text", { text: i % 5 === 0 ? undefined : `Saved report ${i}`, artifactIds: [`${String(i % 30).padStart(4, "0")}${"a".repeat(32)}`] });
    add(thread, `gw${i}`, at + 4, "goal.run", { goalRun: { runId: `gw${i % 15}`, status: i % 2 ? "waiting" : "needs-input", detail: `Team asks ${i}` } });
    add(thread, `q${i}`, at + 5, "options", { card: { requestId: `qq${i % 25}`, title: "Question", options: ["A", "B"], expired: i % 7 === 0 ? true : undefined, unattended: i % 14 === 0 ? true : undefined, dismissed: i % 11 === 0 ? true : undefined, orphaned: i % 13 === 0 ? true : undefined } });
    add(thread, `pe${i}`, at + 6, "activity", { tool: { name: "Provider", ok: false, providerError: { code: 500 } } });
    add(thread, `u${i}`, at + 7, "text", { text: "a user line" }, "user");
  }
  // Marks on rows the plain listing returns, so each one changes something.
  const listed = listInbox(db, { view: "all", pageSize: 100 }, access, 9_000_000).items;
  const state = db.prepare("INSERT OR REPLACE INTO inbox_item_state(source_key,read_version,read_at,snoozed_until,cleared_at) VALUES(?,?,?,?,?)");
  listed.forEach((row, i) => {
    const key = Buffer.from(row.id, "base64url").toString("utf8");
    switch (i % 6) {
      case 0: state.run(key, row.version, 8_500_000, null, null); break; // read, current
      case 1: state.run(key, "stale", 8_500_000, null, null); break; // read, since changed
      case 2: state.run(key, null, null, 9_500_000, null); break; // snoozed past the first clock
      case 3: state.run(key, null, null, 8_900_000, null); break; // snooze already run out
      case 4: state.run(key, null, null, null, 9_999_999_999); break; // cleared, nothing newer
      default: state.run(key, null, null, null, 1); break; // cleared, newer activity since
    }
    marks.push([key, String(i % 6)]);
  });
  return { db, marks };
}

it("the rewritten queries match the old ones on every row shape, mark and search", () => {
  const { db, marks } = seedRich();
  expect(marks.length).toBeGreaterThan(30);
  const views = ["decisions", "approvals", "questions", "connections", "routines", "to-read", "results", "all"] as const;
  const searches = ["", "provider", "bot 3", "sign in"];
  let compared = 0;
  for (const now of [9_000_000, 9_600_000]) for (const view of views) for (const query of searches) for (const includeSnoozed of [false, true]) for (const page of query === "" ? [0, 2] : [0]) {
    const q = { view, page, pageSize: 10, includeSnoozed, query };
    const label = `${view} "${query}" snoozed=${includeSnoozed} p${page} now=${now}`;
    const mine = listInbox(db, q, access, now), theirs = legacy.listInbox(db, q, access, now);
    expect(mine, label).toEqual(theirs);
    if (now === 9_000_000) expect(cached(db, q, access, now), `cached ${label}`).toEqual(theirs);
    compared++;
  }
  const narrow: InboxAccess = { owner: true, threads: access.threads.slice(0, 3) };
  for (const view of views) expect(listInbox(db, { view }, narrow, 9_000_000), `narrow ${view}`).toEqual(legacy.listInbox(db, { view }, narrow, 9_000_000));
  expect([...owedThreads(db, access)].sort()).toEqual([...legacy.owedThreads(db, access)].sort());
  expect([...owedThreads(db, narrow)].sort()).toEqual([...legacy.owedThreads(db, narrow)].sort());
  const sample = listInbox(db, { view: "all", pageSize: 100 }, access, 9_000_000);
  expect(sample.decisions).toBeGreaterThan(0); expect(sample.toRead).toBeGreaterThan(0); expect(sample.unread).toBeLessThan(sample.items.length);
  expect(compared).toBe(160);
}, 600_000);

it("the routine rows are read once per audience, not once per view, page and search", () => {
  const db = seed(), counts = counting(db);
  for (const view of ["decisions", "routines", "all", "to-read"] as const) for (const page of [0, 1]) cached(db, { view, page }, access, 5_000_000);
  cached(db, { view: "all", query: "routine 3" }, access, 5_000_000);
  console.log(`[perf] 9 distinct cached answers: bounded (routine) scans=${counts.bounded}`);
  expect(counts.bounded).toBe(1);
});
