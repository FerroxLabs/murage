// SPDX-License-Identifier: AGPL-3.0-or-later
// The write-time projection shows exactly what base showed: the same items,
// in the same order, with the same counts, of every age. Base (2441af103,
// frozen in inbox.base-reference.ts) is the oracle: it computes every answer
// from the messages table. Only the routine roll-up was ever windowed.
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxPage, InboxQuery } from "../shared/inbox.ts";
import * as base from "./inbox.base-reference.ts";
import { fillInboxProjection, initializeInbox, inboxProjectionReady, listInbox, listInboxCached, owedThreads, updateInboxState, type InboxAccess } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";

const NOW = 1_790_000_000_000, DAY = 24 * 60 * 60 * 1000, THREADS = 12;
const access: InboxAccess = { owner: true, threads: Array.from({ length: THREADS }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}`, botId: `b${i}` })) };
const narrow: InboxAccess = { owner: true, threads: access.threads.slice(0, 4) };
const VIEWS = ["decisions", "approvals", "questions", "connections", "routines", "to-read", "results", "all"] as const;
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });

/** Every row shape, of every age from today to over a year: most are older
 *  than fourteen days. Replayed copies share a source key. */
function messages(db: DatabaseSync) {
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const add = (thread: string, id: string, at: number, kind: string, body: Record<string, unknown>, role = "bot") =>
    insert.run(thread, id, at, role, kind, null, JSON.stringify({ id, at, role, kind, ...body }));
  for (let i = 0; i < 240; i++) {
    const thread = `t${i % THREADS}`;
    // ages spread from minutes to 400 days; two in three are past the old window
    const at = NOW - (i % 3 === 0 ? (i * 37) % 13 : 15 + ((i * 53) % 385)) * DAY - i * 1000;
    add(thread, `run${i}`, at, "routine.run", { routineRun: { runId: `run${i % 200}`, routineId: `r${i % 7}`, routineName: `Routine ${i % 7}`, status: i % 4 === 0 ? "failed" : i % 9 === 0 ? "waiting" : "completed", error: i % 4 === 0 ? "401 unauthorized" : undefined, summary: i % 8 === 0 ? "" : `Found ${i} things` } });
    add(thread, `card${i}`, at + 1, "options", { card: { requestId: `req${i % 90}`, title: "Command", options: ["Allow", "Deny"], tool: i % 3 === 0 ? "Bash" : undefined, expired: i % 9 === 0 ? true : undefined, unattended: i % 18 === 0 ? true : undefined, answered: i % 5 === 0 ? "Allow" : undefined, orphaned: i % 31 === 0 ? true : undefined } });
    add(thread, `goal${i}`, at + 2, "goal.run", { goalRun: { runId: `goal${i % 100}`, status: i % 2 ? "needs-input" : "done", detail: `Goal ${i}` } });
    add(thread, `conn${i}`, at + 3, "connector", { connector: { resumeKey: `k${i % 9}`, slug: "gmail", status: i % 2 ? "connected" : "pending" } });
    add(thread, `sec${i}`, at + 4, "secret", { secret: { requestKey: `key${i % 15}`, provided: i % 4 === 0 ? true : undefined } });
    add(thread, `mcp${i}`, at + 5, "mcpSignIn", { mcpSignIn: { resumeKey: `mk${i % 6}`, name: `Link ${i % 3}`, status: i % 3 === 0 ? "signed-in" : "pending", body: `Sign in to link ${i % 3}` } });
    add(thread, `dig${i}`, at + 6, "activity", { actorKind: "murage", murage: { kind: "status", digestDay: `2026-0${1 + (i % 9)}-1${i % 10}` }, tool: { name: `Digest ${i}`, ok: true } });
    add(thread, `auth${i}`, at + 7, "activity", { tool: { name: "Engine", ok: false, authRequired: i % 2 === 0 ? true : undefined, providerError: i % 2 ? { httpStatus: 503 } : undefined } });
    add(thread, `art${i}`, at + 8, "text", { text: i % 5 === 0 ? undefined : `Saved report ${i}`, artifactIds: [`${String(i % 40).padStart(4, "0")}${"a".repeat(32)}`] });
    add(thread, `u${i}`, at + 9, "text", { text: "a user line" }, "user");
  }
}

/** Read, snooze and clear marks on items of every age, through the product's own update. */
function mark(db: DatabaseSync) {
  const listed = base.listInbox(db, { view: "all", pageSize: 100, page: 1 }, access, NOW).items.concat(base.listInbox(db, { view: "all", pageSize: 100, page: 4 }, access, NOW).items);
  listed.forEach((row, i) => {
    const update = i % 5 === 0 ? { read: true } : i % 5 === 1 ? { snoozedUntil: NOW + DAY } : i % 5 === 2 ? { snoozedUntil: NOW + 60_000 } : i % 5 === 3 && row.clearable ? { cleared: true as const } : null;
    if (update) updateInboxState(db, { id: row.id, version: row.version, ...update }, access, NOW - 120_000);
  });
  return listed.length;
}

function seeded() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  messages(db);
  // An installation that predates the projection: the history is there before it.
  initializeInbox(db);
  expect(inboxProjectionReady(db)).toBe(false);
  fillInboxProjection(db);
  expect(inboxProjectionReady(db)).toBe(true);
  expect(mark(db)).toBeGreaterThan(100);
  return db;
}

/** The answer without the cursor base never had. */
const plain = (page: InboxPage) => ({ ...page, next: undefined });

describe("Inbox projection against base", () => {
  const db = seeded();

  it("holds items older than fourteen days in All, Results and To-read, as base does", () => {
    for (const view of ["all", "results", "to-read"] as const) {
      const old = (page: number) => base.listInbox(db, { view, page, pageSize: 100 }, access, NOW).items.filter(item => item.at < NOW - 14 * DAY).length;
      const last = Math.ceil(base.listInbox(db, { view, pageSize: 100 }, access, NOW).total / 100) - 1;
      expect(old(last), view).toBeGreaterThan(0);
      for (const page of [0, last]) expect(plain(listInbox(db, { view, page, pageSize: 100 }, access, NOW)), `${view} p${page}`).toEqual(base.listInbox(db, { view, page, pageSize: 100 }, access, NOW));
    }
  });

  // Over 500 comparisons, read-only and CPU-bound: Linux 20-39 s, macOS 29-38 s, Windows 46-47 s on hosted runners (nightly
  // 39345477364, CI 39357825825 and 39358028036), so the suite's 45 s default does not fit Windows.
  it("returns the same items, order and counts on every view, page, search, scope and clock", { tags: ["nightly"], timeout: 150_000 }, () => {
    let compared = 0;
    for (const now of [NOW, NOW + 2 * 60_000, NOW + 2 * DAY]) for (const view of VIEWS) for (const query of ["", "provider", "bot 3", "sign in", "routine 4"])
      for (const includeSnoozed of [false, true]) for (const page of query === "" ? [0, 1, 3, 40] : [0, 1]) for (const scope of query === "" ? [access, narrow] : [access]) {
        const q: InboxQuery = { view, page, pageSize: 25, includeSnoozed, query };
        const label = `${view} "${query}" snoozed=${includeSnoozed} p${page} now=${now} scope=${scope.threads.length}`;
        const theirs = base.listInbox(db, q, scope, now);
        expect(plain(listInbox(db, q, scope, now)), label).toEqual(theirs);
        bumpMessagesVersion();
        expect(plain(listInboxCached(db, q, scope, now)), `cached ${label}`).toEqual(theirs);
        compared++;
      }
    expect(compared).toBeGreaterThan(500);
    for (const scope of [access, narrow]) expect([...owedThreads(db, scope)].sort()).toEqual([...base.owedThreads(db, scope)].sort());
    const sample = listInbox(db, { view: "all" }, access, NOW);
    expect(sample.total).toBeGreaterThan(1000);
    expect(sample.decisions).toBeGreaterThan(0); expect(sample.toRead).toBeGreaterThan(0); expect(sample.questions).toBeGreaterThan(0);
  });

  it("walks every page by cursor to exactly base's whole list", () => {
    for (const view of VIEWS) for (const includeSnoozed of [false, true]) {
      const theirs = base.listInbox(db, { view, pageSize: 100, includeSnoozed }, access, NOW);
      const everything: string[] = [];
      for (let page = 0; page * 100 < theirs.total; page++) everything.push(...base.listInbox(db, { view, page, pageSize: 100, includeSnoozed }, access, NOW).items.map(item => item.id));
      const walked: string[] = [];
      let after: string | undefined, pages = 0;
      do {
        const answer = listInbox(db, { view, pageSize: 25, includeSnoozed, ...(after ? { after } : {}) }, access, NOW);
        walked.push(...answer.items.map(item => item.id));
        after = answer.next; pages++;
      } while (after && pages < 1000);
      expect(walked, `${view} snoozed=${includeSnoozed}`).toEqual(everything);
    }
  });

  it("keeps the counts exact through writes: new copies, answers, deletions and marks", () => {
    const insert = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
    const put = (thread: string, id: string, at: number, body: Record<string, unknown>) => insert.run(thread, id, at, "bot", "options", null, JSON.stringify({ id, at, role: "bot", kind: "options", ...body }));
    put("t1", "late", NOW - 400 * DAY, { card: { requestId: "req3", title: "Command", options: ["Allow"], tool: "Bash" } }); // an old replay of an existing key
    put("t2", "fresh", NOW, { card: { requestId: "fresh", title: "Command", options: ["Allow"], tool: "Bash" } });
    put("t2", "fresh", NOW, { card: { requestId: "fresh", title: "Command", options: ["Allow"], tool: "Bash", answered: "Allow" } }); // answered in place (replace)
    db.prepare("UPDATE messages SET json=json_set(json,'$.card.answered','Deny') WHERE thread_id='t5' AND id='card17'").run();
    db.prepare("DELETE FROM messages WHERE thread_id='t0' AND id IN ('run0','card12','conn24')").run();
    const row = listInbox(db, { view: "decisions" }, access, NOW).items[0];
    updateInboxState(db, { id: row.id, version: row.version, snoozedUntil: NOW + DAY }, access, NOW);
    for (const view of VIEWS) for (const scope of [access, narrow]) for (const page of [0, 2])
      expect(plain(listInbox(db, { view, page }, scope, NOW)), `${view} p${page}`).toEqual(base.listInbox(db, { view, page }, scope, NOW));
    expect([...owedThreads(db, access)].sort()).toEqual([...base.owedThreads(db, access)].sort());
  });

  it("counts from the kept counters, never by reading the items", () => {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    try {
      for (const view of VIEWS) listInbox(db, { view }, access, NOW);
    } finally { (db as unknown as { prepare: unknown }).prepare = prepare; }
    for (const sql of seen) {
      expect(sql).not.toMatch(/COUNT\(\*\)/);
      if (!/FROM inbox_items/.test(sql)) continue;
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null)) as Array<{ detail: string }>).map(row => row.detail).join("\n");
      expect(plan, sql).not.toMatch(/SCAN inbox_items\b(?! USING)/);
      expect(plan, sql).not.toMatch(/SCAN messages\b/);
    }
  });
});
