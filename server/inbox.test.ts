import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { inboxRequest, initializeInbox, listInbox, owedThreads, updateInboxState, type InboxAccess } from "./inbox.ts";

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const access: InboxAccess = { owner: true, threads: [{ threadId: "thread", label: "Research bot", botId: "bot" }] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-inbox-")); roots.push(root);
  const file = join(root, "messages.db"), db = new DatabaseSync(file); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  return { db, file };
}
function put(db: DatabaseSync, message: Record<string, unknown>, thread = "thread") {
  const value = { id: "request", at: 100, role: "bot", kind: "options", card: { requestId: "approval-id", title: "Private command", subtitle: "Sensitive command", options: ["Allow", "Deny"], tool: "Bash" }, ...message };
  db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
    .run(thread, String(value.id), Number(value.at), String(value.role), String(value.kind), null, JSON.stringify(value));
}

it("groups repeat deliveries, survives restart and never answers a request when marked read", () => {
  const f = fixture(); put(f.db, {}); put(f.db, { id: "replay", at: 101 });
  const first = listInbox(f.db, {}, access).items[0];
  expect(first).toMatchObject({ duplicates: 2, status: "pending", decision: true, toRead: false, read: false, link: { threadId: "thread", messageId: "replay" } });
  const originals = f.db.prepare("SELECT json FROM messages ORDER BY id").all();
  updateInboxState(f.db, { id: first.id, version: first.version, read: true }, access);
  expect(f.db.prepare("SELECT json FROM messages ORDER BY id").all()).toEqual(originals);
  f.db.close(); const reopened = new DatabaseSync(f.file); databases.push(reopened); initializeInbox(reopened);
  expect(listInbox(reopened, {}, access)).toMatchObject({ total: 1, decisions: 1, items: [{ read: true, status: "pending" }] });
  put(reopened, { card: { requestId: "approval-id", answered: "Denied", options: [] } });
  expect(listInbox(reopened, {}, access).total).toBe(0);
  expect(listInbox(reopened, { view: "all" }, access).items[0]).toMatchObject({ id: first.id, status: "resolved", read: false, link: { messageId: "request" } });
});

it("source deletion and later status changes are authoritative, including stale updates", () => {
  const { db } = fixture(); put(db, {});
  const item = listInbox(db, {}, access).items[0];
  put(db, { card: { requestId: "approval-id", dismissed: true, options: [] } });
  expect(() => updateInboxState(db, { id: item.id, version: item.version, read: true }, access)).toThrow("changed");
  expect(listInbox(db, {}, access).total).toBe(0);
  db.prepare("DELETE FROM messages WHERE thread_id=?").run("thread");
  expect(listInbox(db, { view: "all" }, access).total).toBe(0);
  expect(() => updateInboxState(db, { id: item.id, version: item.version, read: true }, access)).toThrow("unavailable");
});

it("snooze is durable metadata, expires and can be cleared without resolving source state", () => {
  const { db } = fixture(); put(db, {});
  const item = listInbox(db, {}, access).items[0], now = 1_000_000;
  updateInboxState(db, { id: item.id, version: item.version, snoozedUntil: now + 60_000 }, access, now);
  expect(listInbox(db, {}, access, now).total).toBe(0);
  expect(listInbox(db, { includeSnoozed: true }, access, now).items[0]).toMatchObject({ status: "pending", read: false });
  expect(listInbox(db, {}, access, now + 60_001).total).toBe(1);
  updateInboxState(db, { id: item.id, version: item.version, snoozedUntil: null }, access, now);
  expect(listInbox(db, {}, access, now).items[0].snoozedUntil).toBeNull();
});

it("limits projection and updates to explicit permitted threads before searching or counting", () => {
  const { db } = fixture(); put(db, {}); put(db, { id: "private", kind: "routine.run", routineRun: { runId: "private-run", status: "failed", summary: "PRIVATE_OTHER_AUDIENCE", routineName: "Private" } }, "other");
  expect(listInbox(db, { view: "all", query: "PRIVATE_OTHER_AUDIENCE" }, access).total).toBe(0);
  expect(listInbox(db, { view: "all" }, { owner: true, threads: [] }).total).toBe(0);
  const privateItem = listInbox(db, { view: "all" }, { owner: true, threads: [{ threadId: "other", label: "Other" }] }).items[0];
  expect(() => updateInboxState(db, { id: privateItem.id, version: privateItem.version, read: true }, access)).toThrow("unavailable");
  expect(inboxRequest(db, { method: "GET", path: "/api/inbox" }, { ...access, owner: false }).status).toBe(404);
  expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: privateItem.id, version: privateItem.version, read: true } }, { ...access, owner: false }).status).toBe(404);
});

it("keeps credential/connector/card secrets out of summaries and redacts background output", () => {
  const { db } = fixture(), secret = "sk-" + "NotARealCredential".repeat(3);
  put(db, { kind: "secret", secret: { requestKey: "setup", label: secret, description: secret, error: secret } });
  put(db, { id: "connector", kind: "connector", connector: { resumeKey: "resume", slug: "github", status: "failed", label: secret, description: secret, error: secret } });
  put(db, { id: "option", card: { requestId: "request", title: secret, subtitle: secret, tool: secret } });
  put(db, { id: "routine", kind: "routine.run", routineRun: { runId: "run", status: "failed", routineName: "Routine", summary: secret } });
  const page = listInbox(db, { view: "all" }, access);
  expect(page.total).toBe(4);
  expect(JSON.stringify(page)).not.toContain(secret);
  expect(page.items.find(item => item.kind === "connection")?.summary).toBe("");
});

it("only shows explicit attention sources and meaningful background results, not direct replies or quiet runs", () => {
  const { db } = fixture();
  put(db, { id: "onboarding", card: { title: "Welcome", options: ["Start"] } });
  put(db, { id: "direct", kind: "text", turnTerminal: true, text: "A direct answer" });
  put(db, { id: "quiet", kind: "routine.run", routineRun: { runId: "quiet", status: "completed" } });
  put(db, { id: "progress", kind: "routine.run", routineRun: { runId: "progress", status: "running", summary: "Working" } });
  put(db, { id: "transient-tool", kind: "activity", tool: { name: "Retryable tool", ok: false } });
  expect(listInbox(db, { view: "all" }, access).total).toBe(0);
  put(db, { id: "report", kind: "routine.run", routineRun: { runId: "report-run", status: "completed", summary: "Found three relevant updates.", routineName: "Daily review", executionThreadId: "private-execution" } });
  put(db, { id: "error", kind: "activity", tool: { name: "Provider", ok: false, authRequired: true, errorDetails: "PRIVATE_ERROR" } });
  // A failed tool call is NEWS, not a decision: it goes to "to read" and the
  // default view, which is the decisions view, stays empty. Before the split
  // this sat under "Needs you" next to real approvals.
  expect(listInbox(db, {}, access)).toMatchObject({ total: 0, decisions: 0 });
  expect(listInbox(db, { view: "to-read" }, access)).toMatchObject({ total: 1, items: [{ kind: "error", status: "failed", toRead: true, decision: false }] });
  const results = listInbox(db, { view: "results" }, access);
  expect(results).toMatchObject({ total: 1, items: [{ title: "Daily review", link: { threadId: "thread", messageId: "report", runId: "report-run" } }] });
  expect(JSON.stringify(results)).not.toContain("private-execution");
});

it("keeps unanswered goal/routine attention durable after source run stops working", () => {
  const { db } = fixture();
  put(db, { id: "goal", kind: "goal.run", goalRun: { runId: "goal", status: "needs-input", detail: "Choose a delivery date." } });
  put(db, { id: "routine", kind: "routine.run", routineRun: { runId: "routine", status: "completed", goalStatus: "blocked", summary: "Needs a connection." } });
  expect(listInbox(db, { view: "all" }, access).items.map(item => item.status).sort()).toEqual(["blocked", "needs-input"]);
  // ...and they land in different piles. A goal waiting on an answer is a
  // decision; a run that stopped because a connection is missing is news.
  expect(listInbox(db, { view: "decisions" }, access).items.map(item => item.status)).toEqual(["needs-input"]);
  expect(listInbox(db, { view: "to-read" }, access).items.map(item => item.status)).toEqual(["blocked"]);
});

it("uses deterministic SQL pagination/search and an indexed message scope", () => {
  const { db } = fixture();
  for (let i = 0; i < 65; i++) put(db, { id: `run-${i}`, at: i, kind: "routine.run", routineRun: { runId: `run-${i}`, status: "completed", routineName: "Daily report", summary: `Result ${i}` } });
  const first = listInbox(db, { view: "results", pageSize: 25 }, access);
  const second = listInbox(db, { view: "results", pageSize: 25, page: 1 }, access);
  expect(first.total).toBe(65); expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(25);
  expect(first.items.some(item => second.items.some(other => other.id === item.id))).toBe(false);
  expect(first.items[0].link.runId).toBe("run-64");
  expect(listInbox(db, { view: "all", query: "Result 42" }, access).total).toBe(1);
  expect(listInbox(db, { view: "all", query: "research bot" }, access).total).toBe(65);
  expect(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE kind='routine.run' AND thread_id='thread' ORDER BY at DESC").all())).toContain("messages_inbox_kind_thread_at");
});

it("rejects malformed bounds and refuses any attempt to resolve or approve through the metadata API", () => {
  const { db } = fixture(); put(db, {});
  const item = listInbox(db, {}, access).items[0];
  for (const query of [{ page: -1 }, { pageSize: 101 }, { query: "x".repeat(201) }, { view: "wrong" }]) {
    expect(inboxRequest(db, { method: "GET", path: "/api/inbox", query: query as never }, access).status).toBe(400);
  }
  expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: item.id, version: item.version, read: true, approved: true } as never }, access).status).toBe(400);
  expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: item.id, version: item.version, snoozedUntil: Date.now() - 1 } }, access).status).toBe(400);
  expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state" }, access).status).toBe(400);
  expect(listInbox(db, {}, access).items[0].status).toBe("pending");
});

it("projects explicit saved-file identities without treating ordinary text as a deliverable", () => {
  const { db } = fixture(), artifactId = "12345678-1234-4123-8123-123456789abc";
  put(db, { id: "prose", kind: "text", text: "I saved /reports/file.html", turnTerminal: true });
  put(db, { id: "saved", kind: "text", text: "Saved file: Weekly report", artifactIds: [artifactId] });
  put(db, { id: "replayed", kind: "text", text: "Saved file: Weekly report", artifactIds: [artifactId], at: 101 });
  expect(listInbox(db, { view: "results" }, access)).toMatchObject({ total: 1, items: [{ kind: "artifact", duplicates: 2, link: { threadId: "thread", messageId: "replayed", artifactId } }] });
  expect(listInbox(db, {}, access).total).toBe(0);
});


it("approval attention spans tasks and rooms, ignores read and snooze, and excludes expired or settled requests", () => {
  const { db } = fixture();
  const all = { owner: true, threads: ["thread", "subtask", "room"].map(threadId => ({ threadId, label: threadId })) };
  for (const [index, tool] of ["Bash", "agents_delegate_bot", "generate_image", undefined].entries())
    put(db, { id: `ask-${index}`, card: { requestId: `ask-${index}`, tool, options: [] } }, index % 2 ? "subtask" : "room");
  put(db, { id: "routine", card: { requestId: "routine", routineRequest: {}, options: [] } });
  put(db, { id: "skill", card: { requestId: "skill", skillRequest: {}, options: [] } });
  put(db, { id: "expired", card: { requestId: "expired", expired: true, unattended: true } });
  put(db, { id: "cancelled", card: { requestId: "cancelled", dismissed: true } });
  put(db, { id: "memory", kind: "text", text: "automatic memory written" });
  const first = listInbox(db, { view: "decisions", pageSize: 1 }, all);
  expect(first.total).toBe(6); expect(first.items).toHaveLength(1);
  updateInboxState(db, { id: first.items[0].id, version: first.items[0].version, read: true, snoozedUntil: Date.now()+60000 }, all);
  // Reading a request never answers it, so it is still there. Snoozing hides
  // it until it comes back, and the checkbox shows it meanwhile. Neither has
  // resolved anything: both rows still read "pending".
  expect(listInbox(db, { view: "decisions" }, all).total).toBe(5);
  expect(listInbox(db, { view: "decisions", includeSnoozed: true }, all).total).toBe(6);
  expect(listInbox(db, { view: "decisions" }, access).total).toBe(2);
  expect(inboxRequest(db, { method: "GET", path: "/api/inbox", query: { view: "decisions" } }, { ...all, owner: false }).status).toBe(404);
  // Answering one removes it for good, snooze or no snooze: five were left
  // unanswered, and one of those five is still snoozed.
  put(db, { id: "skill", card: { requestId: "skill", skillRequest: {}, answered: "Denied" } });
  expect(listInbox(db, { view: "decisions", includeSnoozed: true }, all).total).toBe(5);
  expect(listInbox(db, { view: "decisions" }, all).total).toBe(4);
});

// THE OWNER'S MORNING, THROUGH THE REAL DATABASE AND THE REAL ROUTE.
//
// `inbox-rollup.test.ts` proves the rules against a list of runs. This proves
// the Inbox actually APPLIES them: that thirty six rows of routine runs reach
// the routines tab as one row per routine, and that the three lists a person
// is asked for are separated from each other and from the noise.
//
// The numbers are his. On 2026-09-22 he opened this with thirty six against
// it, thirty five of which were one provider outage listed once per run, and
// the one thing that needed him was invisible inside them.
const morning: InboxAccess = { owner: true, threads: [
  { threadId: "dax", label: "Dax (Closer)", botId: "dax" },
  { threadId: "moss", label: "Moss (Secretary)", botId: "moss" },
] };

const OVERLOAD = "API Error: 529 Overloaded. This is a server-side issue, usually temporary.";
const DEAD_TOKEN = "Gmail is not authorized. Reconnect the account to continue.";

function runRow(db: DatabaseSync, thread: string, name: string, index: number, at: number, failed: boolean, detail: string) {
  put(db, { id: `${thread}-${name}-${index}`, at, kind: "routine.run",
    routineRun: { runId: `${thread}-${name}-${index}`, status: failed ? "failed" : "completed", routineName: name, summary: detail } }, thread);
}

it("turns a morning of routine runs into one row per routine, and badges only what is asked", () => {
  const { db } = fixture();
  const T0 = 1_758_500_000_000, HOUR = 3_600_000;
  const now = T0 + 9 * HOUR;

  // 26 night-watch runs: 22 failed on provider overload, the last 4 clean.
  for (let index = 0; index < 26; index += 1) {
    runRow(db, "dax", "RWA night watch", index, T0 + index * 1_800_000, index < 22, index < 22 ? OVERLOAD : "Swept and drafted");
  }
  // 8 Trustpilot runs: 3 failed early, then fine.
  for (let index = 0; index < 8; index += 1) {
    runRow(db, "dax", "Trustpilot sweep", index, T0 + index * HOUR, index < 3, index < 3 ? OVERLOAD : "Every review answered");
  }
  // One clean brief, and one routine genuinely stopped by a dead login.
  runRow(db, "dax", "TC-TIDE morning brief", 0, T0 + 7 * HOUR, false, "Three movers");
  runRow(db, "moss", "Gmail triage", 0, T0 + 6 * HOUR, true, DEAD_TOKEN);

  // And the three things that genuinely require him, one of each kind.
  put(db, { id: "send", at: T0 + 8 * HOUR, kind: "options",
    card: { requestId: "send-id", title: "Send four drafted emails", options: ["Send", "Hold"], tool: "Gmail" } }, "dax");
  put(db, { id: "propose", at: T0 + 8 * HOUR, kind: "options",
    card: { requestId: "propose-id", title: "Make this a routine?", options: ["Yes", "No"], routineRequest: { requestId: "propose-id" } } }, "dax");
  put(db, { id: "reconnect", at: T0 + 8 * HOUR, kind: "connector",
    connector: { resumeKey: "gmail-resume", slug: "gmail", status: "pending" } }, "moss");

  const routines = listInbox(db, { view: "routines", pageSize: 100 }, morning, now);

  // THE WHOLE POINT. Thirty six runs went in; four rows come out.
  expect(routines.routines, "one row per routine, never per run").toHaveLength(4);
  const byName = Object.fromEntries(routines.routines!.map(entry => [entry.routineName, entry]));
  expect(byName["RWA night watch"]).toMatchObject({ runs: 26, failed: 22, verdict: "recovered" });
  expect(byName["Trustpilot sweep"]).toMatchObject({ runs: 8, failed: 3, verdict: "recovered" });
  expect(byName["TC-TIDE morning brief"]).toMatchObject({ verdict: "ok" });
  expect(byName["Gmail triage"]).toMatchObject({ verdict: "stuck", cause: "connection" });
  expect(byName["Gmail triage"]!.botLabel, "named by the bot the owner knows").toBe("Moss (Secretary)");

  // The routines list carries NO number of its own. A badge it can reach is a
  // badge that fills up by itself, which is the defect this replaced.
  const counted = listInbox(db, { view: "decisions", pageSize: 100 }, morning, now);
  expect(counted.decisions, "three things require him, and not one run does").toBe(3);
  expect(counted.approvals).toBe(1);
  expect(counted.questions).toBe(1);
  expect(counted.connections).toBe(1);
  expect(counted.approvals + counted.questions + counted.connections).toBe(counted.decisions);

  // Each list holds its own kind and nothing else.
  expect(listInbox(db, { view: "approvals" }, morning, now).items.map(i => i.segment)).toEqual(["approval"]);
  expect(listInbox(db, { view: "questions" }, morning, now).items.map(i => i.segment)).toEqual(["question"]);
  expect(listInbox(db, { view: "connections" }, morning, now).items.map(i => i.segment)).toEqual(["connection"]);

  // And the rollup is offered ONLY where it was asked for, so no other view
  // pays to compute it.
  expect(listInbox(db, { view: "decisions" }, morning, now).routines).toBeUndefined();
});

// THE BADGE SAID ONE AND EVERY TAB SAID NONE.
//
// `decisions` counts everything owed. The three tabs under it count by
// SEGMENT. Those two facts only agree while every owed thing has a segment
// one of the three tabs can show, and a routine run did not: a room goal
// coming back `needs-input` is parked by routines.ts at status 'waiting'
// with "The team needs your input" on it, which is owed, and it carried the
// segment 'routine', which is not counted anywhere.
//
// So the sidebar said one thing was waiting, Approvals said none, Decisions
// said none, Connections said none, and the only way to reach it was to
// scroll the umbrella. That is the defect the whole redesign exists to
// remove, rebuilt out of arithmetic.
//
// There was a test for this. It added up a hand-written page object whose
// numbers I had chosen to sum, so it could never have failed. This one runs
// the real query against a real row.
it("counts nothing under an umbrella no tab can lift", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  put(db, { id: "run", at: now - 60_000, kind: "routine.run",
    routineRun: { runId: "r1", routineName: "Morning digest", status: "waiting", goalStatus: "needs-input" } });
  const page = listInbox(db, {}, access, now);
  expect(page.decisions, "the run is owed").toBe(1);
  expect(page.approvals + page.questions + page.connections, "and reachable by a tab").toBe(page.decisions);
  expect(page.items[0]).toMatchObject({ segment: "question", kind: "routine", decision: true });
  // It is still one of its routine's runs: the rollup follows the kind, not
  // the refined segment, so the Routines list does not lose a run to it, and
  // the row it lands in can still be opened.
  expect(listInbox(db, { view: "routines" }, access, now).routines).toMatchObject([
    { routineName: "Morning digest", runs: 1, failed: 0, verdict: "waiting", link: { threadId: "thread", messageId: "run" } },
  ]);
});

it("counts a channel goal that stopped to ask, by the same rule", () => {
  const { db } = fixture();
  put(db, { id: "goal", at: 1_699_999_940_000, kind: "goal.run",
    goalRun: { runId: "g1", goal: "Ship it", status: "needs-input", coordinatorBotId: "b", coordinatorName: "Kessler", turnCount: 1, maxTurns: 9 } });
  const page = listInbox(db, {}, access, 1_700_000_000_000);
  expect(page.decisions).toBe(1);
  expect(page.approvals + page.questions + page.connections).toBe(page.decisions);
});

// THE NEGATIVE CONTROL, AND IT IS THE OWNER'S OWN RULE.
//
// If this passed by making every routine run owed, the badge would fill with
// the thirty five rows he asked to be rid of. A run that merely ran, failed,
// or is retrying asks for NOTHING, however badly it went.
it("still refuses to let a routine that merely ran ask for anything", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  put(db, { id: "ok", at: now - 120_000, kind: "routine.run", routineRun: { runId: "r1", routineName: "Digest", status: "completed", summary: "Sent" } });
  put(db, { id: "bad", at: now - 60_000, kind: "routine.run", routineRun: { runId: "r2", routineName: "Digest", status: "failed", error: "529 overloaded" } });
  const page = listInbox(db, {}, access, now);
  expect(page.decisions, "neither of them is owed").toBe(0);
  expect(page.approvals + page.questions + page.connections).toBe(0);
  const routines = listInbox(db, { view: "routines" }, access, now).routines;
  expect(routines, "both are still runs of the same routine").toMatchObject([{ runs: 2, failed: 1, verdict: "stuck" }]);
  expect(routines![0].verdict).not.toBe("waiting");
});

// THE ORIGINAL COMPLAINT, MADE WORSE BY THE THING BUILT TO FIX IT.
//
// The Inbox had four tabs: Needs you, To read, Results, All. The redesign
// replaced them with Approvals / Decisions / Connections / Routines /
// Results and DELETED "To read" without asking where its contents went.
//
// They went nowhere. An engine that is not signed in arrives as a failed
// `activity` row: it needs the owner's hands, which is the definition of a
// connection, but it is a log line with nothing on it to resolve, so it is
// 'failed' and never 'pending'. Connections asked for owed, Results asks for
// neither owed nor news, and To read no longer existed. A dead login was
// reachable only by scrolling All.
//
// That is the thirty sixth item. The one he could act on, invisible.
it("puts a dead login in the tab a person would look in for it", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  put(db, { id: "a1", at: now - 60_000, kind: "activity", card: null, tool: { ok: 0, authRequired: 1, name: "error: not signed in" } });
  const page = listInbox(db, { view: "connections" }, access, now);
  expect(page.total, "Connections is where somebody goes to find this").toBe(1);
  expect(page.items[0]).toMatchObject({ segment: "connection", title: "Sign in needed" });

  // AND IT STILL DOES NOT BADGE, which is the half that is easy to get
  // wrong. There is nothing on an activity row to resolve, so a count that
  // included it could never come down again: it would sit on the sidebar
  // for ever and teach him to ignore the number. The list is where you look;
  // the count is what is waiting on you.
  const counts = listInbox(db, {}, access, now);
  expect(counts.connections, "shown, not counted").toBe(0);
  expect(counts.decisions).toBe(0);
  expect(counts.approvals + counts.questions + counts.connections).toBe(counts.decisions);
});

it("says it once however many times it happens", () => {
  // RULE 3, for the kind of row that produces the most copies of itself: a
  // signed-out engine writes one of these every time a turn tries to use it.
  const { db } = fixture(), now = 1_700_000_000_000;
  for (let index = 0; index < 20; index += 1) {
    put(db, { id: `a${index}`, at: now - (20 - index) * 60_000, kind: "activity", card: null,
      tool: { ok: 0, authRequired: 1, name: `error: attempt ${index}` } });
  }
  const page = listInbox(db, { view: "connections" }, access, now);
  expect(page.total, "twenty attempts, one sentence").toBe(1);
  expect(page.items[0].duplicates).toBe(20);
});

it("leaves a request that expired where the approval used to be", () => {
  // "Kessler has a pending approval and I cannot find it. There is no
  // indication of where to look or whether it has expired." A missed request
  // is 'missed', which is news and not owed, so it was in no tab either.
  const { db } = fixture(), now = 1_700_000_000_000;
  put(db, { id: "live", at: now - 30_000 });
  put(db, { id: "gone", at: now - 60_000, card: { requestId: "old", title: "Send the invoice?", options: [], tool: "Bash", expired: 1, unattended: 1 } });
  const page = listInbox(db, { view: "approvals" }, access, now);
  expect(page.total).toBe(2);
  // Owed first: a request that expired last week must not sit above one that
  // is waiting now just because the list is sorted by time.
  expect(page.items.map(row => row.status)).toEqual(["pending", "missed"]);
  expect(page.approvals, "and only the live one is counted").toBe(1);
  // It says which one it is, in the tab it is sitting in. Every expired card
  // used to call itself a question because expiry is tested before the tool.
  expect(page.items.map(row => row.title)).toEqual(["Approval requested", "Approval expired"]);
  // The control: a card with nothing to run is still a question when it
  // expires. The fix was to stop calling BOTH of them questions, not to
  // start calling both of them approvals.
  put(db, { id: "asked", at: now - 90_000, card: { requestId: "ask", title: "Which account?", options: ["Work"], expired: 1, unattended: 1 } });
  expect(listInbox(db, { view: "questions" }, access, now).items.map(row => row.title)).toEqual(["Question expired"]);
});

// THE NEGATIVE CONTROL FOR ALL THREE.
//
// Each of the above is satisfied by loosening a filter, and loosening the
// wrong one turns Approvals back into the undifferentiated list this
// replaced. Routine runs and finished work are not requests and must not
// appear in any of the three, however they ended.
it("does not let a tab for requests fill up with things that happened", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  put(db, { id: "run", at: now - 60_000, kind: "routine.run", card: null, routineRun: { runId: "r1", routineName: "Digest", status: "failed", error: "529 overloaded" } });
  put(db, { id: "weather", at: now - 50_000, kind: "activity", card: null, tool: { ok: 0, providerError: { kind: "overloaded" }, name: "error: 529" } });
  for (const view of ["approvals", "questions", "connections"] as const) {
    expect(listInbox(db, { view }, access, now).total, `${view} must stay a list of requests`).toBe(0);
  }
  const counts = listInbox(db, {}, access, now);
  expect(counts.decisions).toBe(0);
  expect(counts.approvals + counts.questions + counts.connections).toBe(0);
  expect(listInbox(db, { view: "routines" }, access, now).total, "they are still reported").toBe(2);
});

// THE CREDENTIAL NOTHING ELSE IN THE PRODUCT IS LOOKING FOR.
//
// A connector is checked while somebody watches it being authorized and
// never again. The only code that creates one is an endpoint the bot POSTs
// to, and the live re-check is polled by the card while it is on screen.
// Nothing sweeps in the background.
//
// So a token that dies three weeks after it was connected, during a run at
// three in the morning, leaves ONE trace anywhere: the error on that run.
// Before this it reached the owner as a line of grey text on a routine row
// that deliberately never badges, which is another way of saying it did not
// reach him.
it("raises a dead credential that only the runs know about", () => {
  const { db } = fixture(), T0 = 1_758_500_000_000, HOUR = 3_600_000, now = T0 + 9 * HOUR;
  runRow(db, "moss", "Gmail triage", 0, T0 + 5 * HOUR, true, DEAD_TOKEN);
  runRow(db, "moss", "Inbox sweep", 0, T0 + 6 * HOUR, true, DEAD_TOKEN);

  const page = listInbox(db, { view: "connections" }, morning, now);
  expect(page.restore, "one row, naming everything stopped behind it").toMatchObject([
    { routines: ["Inbox sweep", "Gmail triage"], bots: ["Moss (Secretary)"] },
  ]);
  expect(page.connections, "and it is a number he can act on").toBe(1);
  expect(page.decisions, "in the umbrella too, or the parts stop summing").toBe(1);
  expect(page.approvals + page.questions + page.connections).toBe(page.decisions);
});

it("stops asking the moment a run works again", () => {
  // It clears ITSELF, which is why it is allowed to badge at all and the
  // signed-out activity row is not. The verdict is the last run.
  const { db } = fixture(), T0 = 1_758_500_000_000, HOUR = 3_600_000, now = T0 + 9 * HOUR;
  runRow(db, "moss", "Gmail triage", 0, T0 + 5 * HOUR, true, DEAD_TOKEN);
  expect(listInbox(db, {}, morning, now).decisions).toBe(1);
  runRow(db, "moss", "Gmail triage", 1, T0 + 6 * HOUR, false, "Sorted");
  const after = listInbox(db, {}, morning, now);
  expect(after.decisions, "reconnected, so nothing is owed").toBe(0);
  expect(after.restore).toBeUndefined();
});

// THE TWO NEGATIVE CONTROLS, AND THE FIRST ONE IS THE EXPENSIVE ONE.
it("does not ask twice for the same dead connection", () => {
  // The morning fixture already carries both a pending connector card and a
  // routine failing on the same dead Gmail. Wiring this counted it twice and
  // that test went from three owed things to four. This is a LAST RESORT
  // detector: when something is already asking, it says nothing.
  const { db } = fixture(), T0 = 1_758_500_000_000, HOUR = 3_600_000, now = T0 + 9 * HOUR;
  runRow(db, "moss", "Gmail triage", 0, T0 + 5 * HOUR, true, DEAD_TOKEN);
  put(db, { id: "reconnect", at: T0 + 8 * HOUR, kind: "connector",
    connector: { resumeKey: "gmail-resume", slug: "gmail", status: "pending" } }, "moss");
  const page = listInbox(db, {}, morning, now);
  expect(page.connections, "the card is the ask; this stays quiet behind it").toBe(1);
  expect(page.decisions).toBe(1);
  expect(page.restore).toBeUndefined();
});

it("never raises provider weather, however long it lasts", () => {
  // Rule 2, and the reason the cause is read before anything is raised. A
  // provider having a bad week needs patience, not the owner, and a badge
  // that means "wait" is the badge this redesign exists to remove.
  const { db } = fixture(), T0 = 1_758_500_000_000, HOUR = 3_600_000, now = T0 + 9 * HOUR;
  for (let index = 0; index < 12; index += 1) {
    runRow(db, "dax", "RWA night watch", index, T0 + index * 1_800_000, true, OVERLOAD);
  }
  const page = listInbox(db, {}, morning, now);
  expect(page.decisions, "twelve failures and nothing owed").toBe(0);
  expect(page.restore).toBeUndefined();
  expect(listInbox(db, { view: "routines" }, morning, now).routines, "still reported, loudly")
    .toMatchObject([{ routineName: "RWA night watch", verdict: "stuck", cause: "upstream" }]);
});

it("an open request to connect an app can be set aside, and then stops being owed", () => {
  const { db } = fixture();
  const connector = { resumeKey: "resume", slug: "gmail", status: "required", label: "Gmail", description: "Read mail" };
  put(db, { id: "connect", kind: "connector", connector });
  put(db, {});
  const page = listInbox(db, { view: "connections" }, access);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ kind: "connection", dismissible: true, botId: "bot" });
  // an approval is answered, never dismissed from here
  expect(listInbox(db, { view: "approvals" }, access).items[0].dismissible).toBeUndefined();
  // what connector-cards/:id/dismiss writes
  put(db, { id: "connect", kind: "connector", connector: { ...connector, dismissed: true } });
  expect(listInbox(db, { view: "connections" }, access)).toMatchObject({ total: 0, connections: 0 });
  expect(listInbox(db, { view: "all" }, access).items.find(item => item.kind === "connection")).toMatchObject({ status: "resolved" });
  expect(listInbox(db, { view: "all" }, access).items.find(item => item.kind === "connection")?.dismissible).toBeUndefined();
});

it("a failure owing nothing can be cleared until it happens again; a waiting request cannot", () => {
  const { db } = fixture();
  const failure = (id: string, at: number) => put(db, { id, at, kind: "activity", tool: { name: "Setup needed", ok: false, authRequired: true, errorDetails: "Not signed in" } });
  failure("fail-1", 100); failure("fail-2", 200); put(db, {});
  const shown = listInbox(db, { view: "connections" }, access, 1_000);
  const error = shown.items.find(item => item.kind === "error")!;
  expect(error).toMatchObject({ clearable: true, duplicates: 2 });
  const request = listInbox(db, { view: "approvals" }, access, 1_000).items[0];
  expect(request.clearable).toBeUndefined();
  expect(() => updateInboxState(db, { id: request.id, version: request.version, cleared: true }, access, 1_000)).toThrow("Answer it");

  updateInboxState(db, { id: error.id, version: error.version, cleared: true }, access, 1_000);
  expect(listInbox(db, { view: "connections" }, access, 1_001).items.find(item => item.kind === "error")).toBeUndefined();
  expect(listInbox(db, {}, access, 1_001).toRead).toBe(0);
  // the same failure again, later: back
  failure("fail-3", 2_000);
  expect(listInbox(db, { view: "connections" }, access, 2_001).items.find(item => item.kind === "error")).toMatchObject({ duplicates: 3 });
});

it("an Inbox database from before clearing gains the column and keeps its read marks", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-inbox-old-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  db.exec("CREATE TABLE inbox_item_state (source_key TEXT PRIMARY KEY, read_version TEXT, read_at INTEGER, snoozed_until INTEGER)");
  db.prepare("INSERT INTO inbox_item_state VALUES('k','v',1,NULL)").run();
  initializeInbox(db); initializeInbox(db);
  expect((db.prepare("PRAGMA table_info(inbox_item_state)").all() as Array<{ name: string }>).map(c => c.name)).toEqual(["source_key", "read_version", "read_at", "snoozed_until", "cleared_at"]);
  expect(db.prepare("SELECT read_version FROM inbox_item_state WHERE source_key='k'").get()).toEqual({ read_version: "v" });
});

// THE QUESTION BADGE ATTRIBUTES, IT NEVER ADDS.
//
// A conversation row shows how many questions are waiting in it. Those
// numbers are the Decisions segment's `questions` split by thread, so they
// sum to it exactly, count nothing the umbrella does not, and follow the
// same live rules (an item the owner snoozed in the Inbox is not counted).
it("splits the questions count by conversation without adding to any total", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  const scope: InboxAccess = { owner: true, threads: [
    { threadId: "thread", label: "Research bot", botId: "bot" }, { threadId: "other", label: "Writer", botId: "writer" }, { threadId: "room", label: "Launch" }] };
  put(db, { id: "ask-1", at: now - 5_000, card: { requestId: "ask-1", title: "Which format?", options: ["A", "B"] } });
  put(db, { id: "ask-2", at: now - 4_000, card: { requestId: "ask-2", title: "Which tone?", options: ["Warm", "Plain"] } });
  put(db, { id: "approve", at: now - 3_000, card: { requestId: "approve", title: "Send it", options: ["Allow", "Deny"], tool: "Gmail" } }, "other");
  put(db, { id: "ask-room", at: now - 2_000, card: { requestId: "ask-room", title: "Ship Friday?", options: ["Yes", "No"] } }, "room");
  put(db, { id: "answered", at: now - 1_000, card: { requestId: "answered", title: "Old", options: [], answered: "Yes" } }, "other");
  const page = listInbox(db, { view: "decisions" }, scope, now);
  expect(page.questionThreads).toEqual({ thread: 2, room: 1 });
  expect(Object.values(page.questionThreads!).reduce((sum, n) => sum + n, 0)).toBe(page.questions);
  expect(page.decisions).toBe(4);
  // Snoozing one question in the Inbox removes it from both numbers alike.
  const ask = listInbox(db, { view: "questions" }, scope, now).items.find(item => item.link.messageId === "ask-1")!;
  updateInboxState(db, { id: ask.id, version: ask.version, snoozedUntil: now + 60_000 }, scope, now);
  const after = listInbox(db, { view: "decisions" }, scope, now);
  expect(after.questionThreads).toEqual({ thread: 1, room: 1 });
  expect(after.questions).toBe(2);
  // Only the view the sidebar polls pays for the split.
  expect(listInbox(db, { view: "all" }, scope, now).questionThreads).toBeUndefined();
});

it("names every conversation that owes the owner something, snoozed in the Inbox or not", () => {
  const { db } = fixture(), now = 1_700_000_000_000;
  const scope: InboxAccess = { owner: true, threads: [
    { threadId: "thread", label: "Research bot", botId: "bot" }, { threadId: "other", label: "Writer", botId: "writer" }, { threadId: "quiet", label: "Quiet" }] };
  put(db, { id: "approve", at: now - 3_000 });
  put(db, { id: "ask", at: now - 2_000, card: { requestId: "ask", title: "Which?", options: ["A"] } }, "other");
  put(db, { id: "done", at: now - 1_000, card: { requestId: "done", title: "Old", options: [], answered: "A" } }, "quiet");
  const ask = listInbox(db, { view: "questions" }, scope, now).items[0]!;
  updateInboxState(db, { id: ask.id, version: ask.version, snoozedUntil: now + 60_000 }, scope, now);
  expect([...owedThreads(db, scope)].sort()).toEqual(["other", "thread"]);
});
