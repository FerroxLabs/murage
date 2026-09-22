import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { inboxRequest, initializeInbox, listInbox, updateInboxState, type InboxAccess } from "./inbox.ts";

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
