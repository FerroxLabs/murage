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
  expect(first).toMatchObject({ duplicates: 2, status: "pending", needsYou: true, read: false, link: { threadId: "thread", messageId: "replay" } });
  const originals = f.db.prepare("SELECT json FROM messages ORDER BY id").all();
  updateInboxState(f.db, { id: first.id, version: first.version, read: true }, access);
  expect(f.db.prepare("SELECT json FROM messages ORDER BY id").all()).toEqual(originals);
  f.db.close(); const reopened = new DatabaseSync(f.file); databases.push(reopened); initializeInbox(reopened);
  expect(listInbox(reopened, {}, access)).toMatchObject({ total: 1, needsYou: 1, items: [{ read: true, status: "pending" }] });
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
  const privateItem = listInbox(db, {}, { owner: true, threads: [{ threadId: "other", label: "Other" }] }).items[0];
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

it("only shows explicit needs-you sources and meaningful background results, not direct replies or quiet runs", () => {
  const { db } = fixture();
  put(db, { id: "onboarding", card: { title: "Welcome", options: ["Start"] } });
  put(db, { id: "direct", kind: "text", turnTerminal: true, text: "A direct answer" });
  put(db, { id: "quiet", kind: "routine.run", routineRun: { runId: "quiet", status: "completed" } });
  put(db, { id: "progress", kind: "routine.run", routineRun: { runId: "progress", status: "running", summary: "Working" } });
  put(db, { id: "transient-tool", kind: "activity", tool: { name: "Retryable tool", ok: false } });
  expect(listInbox(db, { view: "all" }, access).total).toBe(0);
  put(db, { id: "report", kind: "routine.run", routineRun: { runId: "report-run", status: "completed", summary: "Found three relevant updates.", routineName: "Daily review", executionThreadId: "private-execution" } });
  put(db, { id: "error", kind: "activity", tool: { name: "Provider", ok: false, authRequired: true, errorDetails: "PRIVATE_ERROR" } });
  expect(listInbox(db, {}, access)).toMatchObject({ total: 1, items: [{ kind: "error", status: "failed" }] });
  const results = listInbox(db, { view: "results" }, access);
  expect(results).toMatchObject({ total: 1, items: [{ title: "Daily review", link: { threadId: "thread", messageId: "report", runId: "report-run" } }] });
  expect(JSON.stringify(results)).not.toContain("private-execution");
});

it("keeps unanswered goal/routine attention durable after source run stops working", () => {
  const { db } = fixture();
  put(db, { id: "goal", kind: "goal.run", goalRun: { runId: "goal", status: "needs-input", detail: "Choose a delivery date." } });
  put(db, { id: "routine", kind: "routine.run", routineRun: { runId: "routine", status: "completed", goalStatus: "blocked", summary: "Needs a connection." } });
  expect(listInbox(db, {}, access).items.map(item => item.status).sort()).toEqual(["blocked", "needs-input"]);
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
