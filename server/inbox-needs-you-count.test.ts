// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE APPROVAL CARD IS ONE THING THAT NEEDS YOU (1.0.12, docs/designs/NEEDS-YOU-COUNT-1012.md).
//
// Reported from the owner's own use: "In the Needs you section it usually
// shows two things need you when it's one approval card." His approvals come
// mostly from routines. A routine run that opens a card is set to 'waiting'
// (or 'needs-you' when its run limit comes first) and its run card in the
// conversation the routine reports to was counted as owed beside the approval
// card itself. These run the real projection against real rows. The rule is
// applied when counting and listing only: the stored layout stays 4.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { InboxPage, InboxQuery } from "../shared/inbox.ts";
import { fillInboxProjection, inboxProjectionReady, inboxRequest, initializeInbox, isInboxProjectionObject, listInbox, listInboxCached, owedThreads, type InboxAccess } from "./inbox.ts";
import * as oracle from "./inbox.base-reference.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { deriveGroupedDecisions, projectOwedBeyondCards } from "./project-goals.ts";
import { createProjectCard } from "./project-cards.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = 1_700_000_000_000;
const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const root of roots.splice(0)) removeTempDirSync(root); });

// The bot's direct chat, the routine's own conversation (a task of the bot), and a project room.
const access: InboxAccess = { owner: true, threads: [
  { threadId: "dm", label: "Moss", botId: "moss" },
  { threadId: "routine-run", label: "Moss · Morning check", botId: "moss" },
  { threadId: "room", label: "Launch" },
] };

function fixture(file?: string) {
  const root = mkdtempSync(join(tmpdir(), "murage-needs-you-")); roots.push(root);
  const db = new DatabaseSync(file ?? join(root, "messages.db")); databases.push(db);
  if (!file) db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  return db;
}
function put(db: DatabaseSync, thread: string, message: Record<string, unknown>) {
  const value: Record<string, unknown> = { at: NOW - 60_000, role: "bot", ...message };
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, String(value.id), Number(value.at), String(value.role), String(value.kind), null, JSON.stringify(value));
}
const approval = (id: string, requestId: string) => ({ id, kind: "options", card: { requestId, title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], tool: "Bash" } });
const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, kind: "routine.run",
  routineRun: { runId: `run-${id}`, routineId: "morning", routineName: "Morning check", status, executionThreadId: "routine-run", ...extra } });
/** Everything the badge adds up, the way the page reads it: the umbrella and its three tabs. */
const needsYou = (db: DatabaseSync) => {
  const page = listInbox(db, { view: "decisions" }, access, NOW);
  return { decisions: page.decisions, tabs: page.approvals + page.questions + page.connections, rows: page.items.length };
};

it("one approval card in a direct chat is one", () => {
  const db = fixture();
  put(db, "dm", approval("card", "req-dm"));
  expect(needsYou(db)).toEqual({ decisions: 1, tabs: 1, rows: 1 });
});

it("one approval card raised by a routine run is one, not the card plus the run waiting on it", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "waiting", { summary: "rm -rf build" }));
  expect(needsYou(db)).toEqual({ decisions: 1, tabs: 1, rows: 1 });
  expect(listInbox(db, { view: "decisions" }, access, NOW).items[0]).toMatchObject({ segment: "approval", link: { threadId: "routine-run" } });
  // the run is still waiting, not failed, and the Routines list says so
  expect(listInbox(db, { view: "routines" }, access, NOW).routines).toMatchObject([{ routineName: "Morning check", verdict: "waiting", failed: 0 }]);
  // it is not a result either: it has not finished
  expect(listInbox(db, { view: "results" }, access, NOW).total).toBe(0);
  // and the run's conversation is not marked as owing a question
  expect(owedThreads(db, access)).toEqual(new Set(["routine-run"]));
});

it("the same holds once the run limit has come while the card waits (needs-you)", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "needs-you", { summary: "Waiting on you: rm -rf build." }));
  expect(needsYou(db)).toEqual({ decisions: 1, tabs: 1, rows: 1 });
  expect(listInbox(db, { view: "routines" }, access, NOW).routines).toMatchObject([{ verdict: "waiting" }]);
});

it("a run marked waiting for a request No limits answered itself owes nothing", () => {
  const db = fixture();
  put(db, "dm", run("receipt", "waiting", { summary: "ls" }));
  expect(needsYou(db)).toEqual({ decisions: 0, tabs: 0, rows: 0 });
});

it("a room goal that stopped to ask is still owed: it has no card of its own", () => {
  const db = fixture();
  put(db, "room", run("goal", "waiting", { goalStatus: "needs-input", summary: "The team needs your input" }));
  expect(needsYou(db)).toEqual({ decisions: 1, tabs: 1, rows: 1 });
});

it("one approval card in a project conversation is one, with the project's own row added", () => {
  const db = fixture();
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,?)`).run(NOW);
  const work = createProjectCard(db, { groupId: "grp", title: "Ship it", assigneeBotId: "dax", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["lead", "dax"], now: NOW });
  if (!work.ok) throw new Error("setup");
  // the work card waits on that approval: a live wait, never a dead one
  db.prepare("UPDATE project_work_items SET state='waiting', waiting_on=?, request_id=? WHERE id=?").run(JSON.stringify({ kind: "owner_approval" }), "req-room", work.card.id);
  put(db, "room", approval("card", "req-room"));
  const row = deriveGroupedDecisions(db, { groupId: "grp", openApprovals: [{ requestId: "req-room", summary: "rm -rf build" }], now: NOW });
  // GET /api/inbox: the Inbox's own count plus what the project row adds beyond the cards
  expect(needsYou(db).decisions + projectOwedBeyondCards(row)).toBe(1);
  // and a routine run inside the project waiting on that card adds nothing either
  put(db, "room", run("receipt", "waiting"));
  expect(needsYou(db).decisions + projectOwedBeyondCards(row)).toBe(1);
});

it("stays one through the run's whole life on the same message rows, and none once answered", () => {
  const db = fixture();
  put(db, "dm", run("receipt", "running"));
  expect(needsYou(db).decisions).toBe(0);
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "waiting"));
  expect(needsYou(db).decisions).toBe(1);
  put(db, "dm", run("receipt", "needs-you"));
  expect(needsYou(db).decisions).toBe(1);
  put(db, "routine-run", { ...approval("card", "req-routine"), card: { requestId: "req-routine", answered: "Allow", options: [], tool: "Bash" } });
  put(db, "dm", run("receipt", "completed", { summary: "Done." }));
  expect(needsYou(db)).toEqual({ decisions: 0, tabs: 0, rows: 0 });
  expect(listInbox(db, { view: "routines" }, access, NOW).routines).toMatchObject([{ verdict: "ok" }]);
});

// ── 1.0.12 read-time rule (design section 5, tests 1 to 11) ───────────────────

const question = (id: string, requestId: string, extra: Record<string, unknown> = {}) => ({ id, kind: "options", card: { requestId, title: "Which list?", options: ["A", "B"], ...extra } });
/** Every request goes through the public route the desktop and companion use. */
const get = (db: DatabaseSync, query: InboxQuery, now = NOW, cache = false) => (cache ? listInboxCached : listInbox)(db, query, access, now);
const post = (db: DatabaseSync, body: Record<string, unknown>) => inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: body as never }, access);
const findItem = (db: DatabaseSync, threadId: string, kind: string) => {
  const found = get(db, { view: "all", includeSnoozed: true, pageSize: 100 }).items.find(item => item.link.threadId === threadId && item.kind === kind);
  if (!found) throw new Error(`no ${kind} in ${threadId}`);
  return found;
};
/** Counts the shared correction read (the only statement that groups runs on cards). */
function counted(db: DatabaseSync) {
  let reads = 0;
  const proxy = new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property) as unknown;
    if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
    return (sql: string) => { if (sql.includes("GROUP BY thread_id, live, snoozed_until")) reads++; return target.prepare(sql); };
  } });
  return { db: proxy, reads: () => reads };
}
const ids = (page: InboxPage) => page.items.map(item => item.id);
/** The whole list walked by cursor, `size` rows a page. */
function walk(db: DatabaseSync, query: InboxQuery, size: number): string[] {
  const out: string[] = [];
  let next: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = get(db, { ...query, pageSize: size, ...(next ? { after: next } : {}) });
    out.push(...ids(page));
    if (!page.next) break;
    next = page.next;
  }
  return out;
}

it("1. the layout stays 4: the inbox objects are the 1.0.2 objects, and nothing is named _5", () => {
  const db = fixture();
  expect(db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='layout'").get()).toEqual({ cursor: 4 });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%\\_5' ESCAPE '\\'").all()).toEqual([]);
  type Obj = { type: string; name: string; tbl_name: string; sql: string | null };
  const fold = (rows: Obj[]) => rows.filter(isInboxProjectionObject).map(row => [row.type, row.name, row.tbl_name, (row.sql ?? "").replace(/\s+/g, " ").trim()].join("|")).sort();
  const fresh102 = (JSON.parse(readFileSync(join(import.meta.dirname, "testing", "schema-1.0.2-fresh.json"), "utf8")) as { objects: Obj[] }).objects;
  const ours = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all() as unknown as Obj[];
  expect(fold(ours)).toEqual(fold(fresh102));
});

it("2. a filled layout 4 file reopens with no retire and no refill", () => {
  const first = fixture();
  const file = (first.prepare("PRAGMA database_list").get() as { file: string }).file;
  put(first, "routine-run", question("q", "req-q"));
  put(first, "dm", run("receipt", "waiting"));
  for (let i = 0; i < 50; i++) put(first, "dm", { ...run(`done${i}`, "completed", { summary: `Done ${i}` }), at: NOW - 120_000 + i });
  fillInboxProjection(first);
  expect(inboxProjectionReady(first)).toBe(true);
  const markers = first.prepare("SELECT name,done,cursor FROM inbox_projection_state ORDER BY name").all();
  expect(markers).toContainEqual({ name: "layout", done: expect.anything(), cursor: 4 });
  expect(markers.find(row => (row as { name: string }).name === "inbox")).toMatchObject({ done: 1 });
  const items = first.prepare("SELECT source_key, rowid FROM inbox_items ORDER BY source_key").all();
  expect(items.length).toBe(52);
  first.close();
  const second = fixture(file); // a restart: a new handle on the same file, initializeInbox again
  expect(second.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'retired%'").all()).toEqual([]);
  expect(second.prepare("SELECT name,done,cursor FROM inbox_projection_state ORDER BY name").all()).toEqual(markers);
  expect(second.prepare("SELECT source_key, rowid FROM inbox_items ORDER BY source_key").all()).toEqual(items);
  expect(inboxProjectionReady(second)).toBe(true);
});

for (const status of ["waiting", "needs-you"]) {
  it(`3. a snoozed run on a card (${status}) is not taken off twice`, () => {
    const db = fixture();
    put(db, "routine-run", approval("card", "req-routine"));
    put(db, "dm", run("receipt", status));
    const runItem = findItem(db, "dm", "routine");
    const until = Date.now() + 60 * 60 * 1000;
    expect(post(db, { id: runItem.id, version: runItem.version, snoozedUntil: until }).status).toBe(200);
    const page = get(db, { view: "decisions" });
    expect({ decisions: page.decisions, approvals: page.approvals, questions: page.questions, questionThreads: page.questionThreads, total: page.total })
      .toEqual({ decisions: 1, approvals: 1, questions: 0, questionThreads: {}, total: 1 });
    expect(get(db, { view: "decisions", includeSnoozed: true }).total).toBe(1);
    expect(get(db, { view: "questions", includeSnoozed: true }).total).toBe(0);
  });
}

it("3b. a snooze that runs out with no write: the same numbers, and the shared read ran once", () => {
  const raw = fixture();
  put(raw, "routine-run", approval("card", "req-routine"));
  put(raw, "dm", run("receipt", "waiting"));
  const runItem = findItem(raw, "dm", "routine");
  const until = Date.now() + 60 * 60 * 1000;
  expect(post(raw, { id: runItem.id, version: runItem.version, snoozedUntil: until }).status).toBe(200);
  const { db, reads } = counted(raw);
  const numbers = (page: InboxPage) => ({ decisions: page.decisions, approvals: page.approvals, questions: page.questions, questionThreads: page.questionThreads, total: page.total });
  const before = numbers(get(db, { view: "decisions" }, until - 1000, true));
  const after = numbers(get(db, { view: "decisions" }, until + 1000, true));
  expect(before).toEqual({ decisions: 1, approvals: 1, questions: 0, questionThreads: {}, total: 1 });
  expect(after).toEqual(before);
  expect(reads()).toBe(1);
});

it("4. a run on a card cannot be cleared through the public route, and neither can its card", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "waiting"));
  const runItem = findItem(db, "dm", "routine"), cardItem = findItem(db, "routine-run", "request");
  expect(runItem).toMatchObject({ segment: "routine", decision: false });
  expect(runItem.clearable).toBeUndefined();
  expect(post(db, { id: cardItem.id, version: cardItem.version, cleared: true }).status).toBe(409);
  expect(post(db, { id: runItem.id, version: runItem.version, cleared: true }).status).toBe(409);
  expect(needsYou(db)).toEqual({ decisions: 1, tabs: 1, rows: 1 });
});

it("4b. a run on a card that was refused a clear asks a real question with its original time: it is counted and listed", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "waiting"));
  const runItem = findItem(db, "dm", "routine");
  expect(post(db, { id: runItem.id, version: runItem.version, cleared: true }).status).toBe(409);
  // The approval is answered, then the same receipt is patched in place: `at` does not move.
  put(db, "routine-run", { ...approval("card", "req-routine"), card: { requestId: "req-routine", answered: "Allow", options: [], tool: "Bash" } });
  put(db, "dm", run("receipt", "waiting", { goalStatus: "needs-input", summary: "The team needs your input" }));
  for (const cache of [false, true]) {
    bumpMessagesVersion();
    const page = get(db, { view: "decisions" }, NOW, cache);
    expect({ decisions: page.decisions, questions: page.questions, questionThreads: page.questionThreads }).toEqual({ decisions: 1, questions: 1, questionThreads: { dm: 1 } });
    expect(page.items.map(item => item.link.messageId)).toEqual(["receipt"]);
    expect(get(db, { view: "questions" }, NOW, cache).items.map(item => item.link.messageId)).toEqual(["receipt"]);
    expect(owedThreads(db, access)).toEqual(new Set(["dm"]));
  }
});

it("4c. a row already cleared when it comes under the rule keeps its mark, and the counters take it off once", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  // The arithmetic is defended whatever path leads here: paused is news, so it clears as in 1.0.10.
  put(db, "dm", run("receipt", "paused"));
  const paused = findItem(db, "dm", "routine");
  expect(paused.clearable).toBe(true);
  expect(post(db, { id: paused.id, version: paused.version, cleared: true }).status).toBe(200);
  put(db, "dm", run("receipt", "waiting"));
  bumpMessagesVersion();
  const expectCleared = () => {
    const page = get(db, { view: "decisions" });
    expect({ decisions: page.decisions, approvals: page.approvals, questions: page.questions }).toEqual({ decisions: 1, approvals: 1, questions: 0 });
    expect(get(db, { view: "decisions", includeSnoozed: true }).total).toBe(1);
    expect(get(db, { view: "questions", includeSnoozed: true }).total).toBe(0);
    expect(owedThreads(db, access)).toEqual(new Set(["routine-run"]));
  };
  expectCleared();
  // cleared and snoozed
  const again = findItem(db, "dm", "routine");
  expect(post(db, { id: again.id, version: again.version, snoozedUntil: Date.now() + 60 * 60 * 1000 }).status).toBe(200);
  expectCleared();
  // a real question in the run's thread is owed and attributed there
  put(db, "dm", question("ask", "req-ask"));
  const page = get(db, { view: "decisions" });
  expect({ decisions: page.decisions, questions: page.questions, questionThreads: page.questionThreads }).toEqual({ decisions: 2, questions: 1, questionThreads: { dm: 1 } });
  expect(owedThreads(db, access)).toEqual(new Set(["routine-run", "dm"]));
});

it("5. Decisions and Questions pages and cursors never hold a run on a card", () => {
  const db = fixture();
  put(db, "dm", { ...approval("c1", "r1"), at: NOW - 50_000 });
  put(db, "routine-run", { ...approval("c2", "r2"), at: NOW - 40_000 });
  put(db, "room", { ...approval("c3", "r3"), at: NOW - 30_000 });
  put(db, "dm", { ...run("w1", "waiting"), at: NOW - 20_000 });
  put(db, "room", { ...run("w2", "needs-you"), at: NOW - 10_000 });
  const p0 = get(db, { view: "decisions", pageSize: 2 }), p1 = get(db, { view: "decisions", pageSize: 2, page: 1 });
  expect(p0.total).toBe(3);
  expect([...p0.items, ...p1.items].map(item => item.kind)).toEqual(["request", "request", "request"]);
  expect(walk(db, { view: "decisions" }, 2)).toEqual([...ids(p0), ...ids(p1)]);
  expect(walk(db, { view: "decisions" }, 1)).toEqual([...ids(p0), ...ids(p1)]);

  const q = fixture();
  put(q, "dm", { ...question("qp1", "qr1"), at: NOW - 1_000 });
  put(q, "dm", { ...question("qp2", "qr2"), at: NOW - 2_000 });
  put(q, "dm", { ...run("mid", "waiting"), at: NOW - 3_000 });
  put(q, "room", { ...question("qm1", "qr3", { expired: 1, unattended: 1 }), at: NOW - 4_000 });
  put(q, "room", { ...question("qm2", "qr4", { expired: 1, unattended: 1 }), at: NOW - 5_000 });
  const all = get(q, { view: "questions", pageSize: 10 });
  expect(all.items.map(item => [item.status, item.kind])).toEqual([["pending", "request"], ["pending", "request"], ["missed", "request"], ["missed", "request"]]);
  expect(all.total).toBe(4);
  for (const size of [1, 2, 3]) expect(walk(q, { view: "questions" }, size)).toEqual(ids(all));

  const tie = fixture();
  put(tie, "dm", { ...approval("tb", "tie-b"), at: NOW - 1_000 });
  put(tie, "dm", { ...approval("ta", "tie-a"), at: NOW - 1_000 });
  put(tie, "dm", { ...run("tr", "waiting"), at: NOW - 1_000 });
  const tied = get(tie, { view: "decisions", pageSize: 10 });
  const keys = tied.items.map(item => Buffer.from(item.id, "base64url").toString("utf8"));
  expect(keys).toEqual([...keys].sort());
  expect(keys.length).toBe(2);
  expect(walk(tie, { view: "decisions" }, 1)).toEqual(ids(tied));
});

it("6. All and Routines keep the layout 4 order; the cursor walk equals the oracle's offset order", () => {
  const db = fixture();
  put(db, "dm", { ...run("oncard", "waiting", { summary: "Waiting on you: rm" }), at: NOW - 3_000 });
  put(db, "dm", { ...run("done", "completed", { routineId: "evening", routineName: "Evening check", summary: "All done" }), at: NOW - 2_000 });
  put(db, "routine-run", { ...approval("card", "req-routine"), at: NOW - 1_000 });
  const page = get(db, { view: "all", pageSize: 10 });
  expect(page.items.map(item => item.kind === "routine" ? item.status : "card")).toEqual(["card", "waiting", "completed"]);
  expect(page.items[1]).toMatchObject({ segment: "routine", decision: false });
  expect(page.items[1].clearable).toBeUndefined();
  const oracleOrder = (view: "all" | "routines") => {
    const out: string[] = [];
    for (let n = 0; n < 10; n++) { const p = oracle.listInbox(db, { view, pageSize: 1, page: n }, access, NOW); if (p.items.length === 0) break; out.push(...p.items.map(item => item.id)); }
    return out;
  };
  for (const size of [1, 2]) expect(walk(db, { view: "all" }, size)).toEqual(ids(page));
  expect(oracleOrder("all")).toEqual(ids(page));
  const oraclePage = oracle.listInbox(db, { view: "all", pageSize: 10 }, access, NOW);
  expect(oraclePage.items.map(item => [item.id, item.segment, item.decision])).toEqual(page.items.map(item => [item.id, item.segment, item.decision]));
  const routines = get(db, { view: "routines", pageSize: 10 });
  expect(routines.items.map(item => item.status)).toEqual(["waiting", "completed"]);
  for (const size of [1, 2]) expect(walk(db, { view: "routines" }, size)).toEqual(ids(routines));
  expect(oracleOrder("routines")).toEqual(ids(routines));
  expect(routines.routines?.find(row => row.routineName === "Morning check")).toMatchObject({ verdict: "waiting" });
});

it("7. search: a run on a card is not found in Decisions, and is found as a routine elsewhere", () => {
  const db = fixture();
  put(db, "routine-run", approval("card", "req-routine"));
  put(db, "dm", run("receipt", "waiting", { summary: "Zebra crossing check" }));
  const decisions = get(db, { view: "decisions", query: "zebra" });
  expect({ rows: decisions.items.length, total: decisions.total }).toEqual({ rows: 0, total: 0 });
  const routines = get(db, { view: "routines", query: "zebra" });
  expect(routines.items.map(item => item.status)).toEqual(["waiting"]);
  expect(routines.routines?.[0]).toMatchObject({ verdict: "waiting" });
  expect(get(db, { view: "all", query: "zebra" }).items).toMatchObject([{ segment: "routine", decision: false }]);
});

it("8. query plans: the correction read walks the decisions partial index; the page keeps its list index", () => {
  const raw = fixture();
  put(raw, "routine-run", approval("card", "req-routine"));
  put(raw, "dm", run("receipt", "waiting"));
  const seen: string[] = [];
  const db = new Proxy(raw, { get(target, property) {
    const value = Reflect.get(target, property) as unknown;
    if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
    return (sql: string) => { seen.push(sql); return target.prepare(sql); };
  } });
  listInbox(db, { view: "decisions" }, access, NOW);
  const plan = (sql: string) => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail);
  const correction = seen.find(sql => sql.includes("GROUP BY thread_id, live, snoozed_until"))!;
  const lines = plan(correction).filter(line => line.includes("inbox_items"));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toMatch(/inbox_items USING (COVERING )?INDEX inbox_items_v_decisions_4/);
  const pageSql = seen.find(sql => sql.includes("LIMIT ? OFFSET ?"))!;
  const pageLines = plan(pageSql).filter(line => / inbox_items( |$)/.test(line) && !line.includes("json_each"));
  expect(pageLines.length).toBeGreaterThan(0);
  for (const line of pageLines) expect(line).toMatch(/inbox_items USING (COVERING )?INDEX inbox_items_l_decisions_4/);
});

it("10. a project room across a restart, from the state the restart path leaves on disk", () => {
  const db = fixture();
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,?)`).run(NOW);
  const work = createProjectCard(db, { groupId: "grp", title: "Ship it", assigneeBotId: "dax", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["lead", "dax"], now: NOW });
  if (!work.ok) throw new Error("setup");
  db.prepare("UPDATE project_work_items SET state='waiting', waiting_on=?, request_id=? WHERE id=?").run(JSON.stringify({ kind: "owner_approval" }), "req-room", work.card.id);
  put(db, "room", approval("card", "req-room"));
  put(db, "room", run("receipt", "waiting"));
  const before = deriveGroupedDecisions(db, { groupId: "grp", openApprovals: [{ requestId: "req-room", summary: "rm -rf build" }], now: NOW });
  expect(needsYou(db).decisions + projectOwedBeyondCards(before)).toBe(1);
  expect(before.deadWaitCards.length).toBe(0);
  // the restart: the card is orphaned by the boot sweep, the work item waits on a restart, the run record failed and re-synced
  put(db, "room", { ...approval("card", "req-room"), card: { ...approval("card", "req-room").card, orphaned: 1 } });
  db.prepare("UPDATE project_work_items SET waiting_on=? WHERE id=?").run(JSON.stringify({ kind: "restart" }), work.card.id);
  put(db, "room", run("receipt", "failed", { error: "Murage restarted while this routine was running", summary: "Murage restarted while this routine was running" }));
  const after = deriveGroupedDecisions(db, { groupId: "grp", openApprovals: [], now: NOW });
  expect(after.deadWaitCards.length).toBe(1);
  expect(needsYou(db).decisions).toBe(0);
  expect(needsYou(db).decisions + projectOwedBeyondCards(after)).toBe(1);
  expect(get(db, { view: "routines" }).items.map(item => item.status)).toEqual(["failed"]);
  // variant: the run message left at waiting while its record failed is still not counted
  put(db, "room", run("receipt", "waiting"));
  expect(needsYou(db).decisions + projectOwedBeyondCards(after)).toBe(1);
});

it("11. an expired run row is outside the rule: counted, listed and guarded exactly as in 1.0.10", () => {
  const db = fixture();
  put(db, "dm", { ...run("odd", "waiting", { summary: "Odd row" }), card: { expired: 1 } });
  const decisions = get(db, { view: "decisions" });
  expect({ decisions: decisions.decisions, questions: decisions.questions, rows: decisions.items.length }).toEqual({ decisions: 1, questions: 1, rows: 0 });
  const questions = get(db, { view: "questions" });
  expect(questions.total).toBe(1);
  expect(questions.total).toBe(decisions.questions);
  expect(questions.items).toMatchObject([{ kind: "routine", decision: true }]);
  expect(questions.items[0].clearable).toBeUndefined();
  expect(post(db, { id: questions.items[0].id, version: questions.items[0].version, cleared: true }).status).toBe(409);
  // owed_open has an expired=0 term, so (as in 1.0.10) an expired row never keeps a conversation awake
  expect(owedThreads(db, access)).toEqual(new Set());
});
