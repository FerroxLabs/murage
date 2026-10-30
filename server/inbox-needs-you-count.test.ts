// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE APPROVAL CARD IS ONE THING THAT NEEDS YOU (1.0.11).
//
// Reported from the owner's own use: "In the Needs you section it usually
// shows two things need you when it's one approval card." His approvals come
// mostly from routines. A routine run that opens a card is set to 'waiting'
// (or 'needs-you' when its run limit comes first) and its run card in the
// conversation the routine reports to was counted as owed beside the approval
// card itself. These run the real projection against real rows.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeInbox, listInbox, owedThreads, type InboxAccess } from "./inbox.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { deriveGroupedDecisions, projectOwedBeyondCards } from "./project-goals.ts";
import { createProjectCard } from "./project-cards.ts";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-needs-you-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
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
