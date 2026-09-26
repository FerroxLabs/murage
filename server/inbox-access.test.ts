// The Inbox, asked for through the browser door.
//
// `inboxRequest` has always been scoped by an explicit list of threads; what
// this file pins is who gets which list. The desktop gets every thread, as it
// always has. A request the companion proved it forwarded gets the threads
// the phone's sidebar shows — the same `visibleToCompanion` answer the live
// stream and the transcript routes give — and nothing else gets anything.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { InboxPage, InboxQuery } from "../shared/inbox.ts";
import { createCompanionAuthority } from "./companion-authority.ts";
import { companionInboxRoute, inboxAccessFor, inboxDoor, type InboxRosterStore } from "./inbox-access.ts";
import { inboxRequest, initializeInbox } from "./inbox.ts";
import { desktopSurfaceSecret } from "./sse-visibility.ts";

const PROOF = "c".repeat(64);
const proven = createCompanionAuthority(PROOF);

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-inbox-access-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  return db;
}
/** One pending approval per thread, each with its own request id. */
function seed(db: DatabaseSync) {
  ALL.forEach((thread, index) => {
    const value = { id: `m-${thread}`, at: 100 + index, role: "bot", kind: "options",
      card: { requestId: `r-${thread}`, title: "Run a command", options: ["Allow", "Deny"], tool: "Bash" } };
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
      .run(thread, value.id, value.at, value.role, value.kind, null, JSON.stringify(value));
  });
}
const ALL = ["t-open", "t-open-task", "t-secret", "t-secret-task", "t-room", "t-dm"];

/** The world in a few lines: an open bot with a task, a hidden bot with a
 *  task, a room, and the bot⇄bot channel the harness makes on its own. */
function world() {
  type Titled = { threadId: string; title: string };
  const bots: Array<{ id: string; name: string; threadId: string; hidden?: boolean; tasks: Titled[] }> = [
    { id: "open", name: "Open", threadId: "t-open", tasks: [{ threadId: "t-open-task", title: "Draft" }] },
    { id: "secret", name: "Secret", threadId: "t-secret", hidden: true, tasks: [{ threadId: "t-secret-task", title: "Payroll" }] },
  ];
  const groups: Array<{ id: string; name: string; threadId: string; dm?: boolean; tasks: Titled[] }> = [
    { id: "room", name: "Room", threadId: "t-room", tasks: [] },
    { id: "dm", name: "Open ⇄ Secret", threadId: "t-dm", dm: true, tasks: [] },
  ];
  const owns = (record: { threadId: string; tasks: Titled[] }, threadId: string) =>
    record.threadId === threadId || record.tasks.some(task => task.threadId === threadId);
  const store: InboxRosterStore = {
    bots, groups,
    bot: id => bots.find(bot => bot.id === id) ?? null,
    botByThread: threadId => bots.find(bot => owns(bot, threadId)) ?? null,
    group: id => groups.find(group => group.id === id),
    groupByThread: threadId => groups.find(group => owns(group, threadId)),
  };
  return { store, bots };
}
const list = (db: DatabaseSync, door: Parameters<typeof inboxAccessFor>[1], store: InboxRosterStore, query: InboxQuery = { view: "all" }) =>
  inboxRequest(db, { method: "GET", path: "/api/inbox", query }, inboxAccessFor(store, door));
const threadsOf = (page: InboxPage) => new Set(page.items.map(item => item.link.threadId));

describe("which door is asking", () => {
  it("names the desktop only when it proves itself", () => {
    expect(inboxDoor({ "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret() }, null, proven)).toBe("desktop");
    expect(inboxDoor({ "x-murage-surface": "desktop" }, null, proven)).toBe("unproven");
  });

  it("names the companion by its private launch proof, not by the marker", () => {
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": PROOF }, null, proven)).toBe("companion");
    // The marker is typeable by any local process. It earns nothing alone.
    expect(inboxDoor({ "x-murage-companion": "1" }, null, proven)).toBe("unproven");
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": "d".repeat(64) }, null, proven)).toBe("unproven");
  });

  it("does not let a companion-stamped request talk its way up to the desktop", () => {
    const query = new URLSearchParams({ surface: "desktop", surfaceSecret: desktopSurfaceSecret() });
    expect(inboxDoor({ "x-murage-companion": "1", "x-murage-companion-token": PROOF }, query, proven)).toBe("companion");
  });
});

describe("which Inbox routes the companion door opens", () => {
  it("opens the list and the state write, and nothing else under the prefix", () => {
    expect(companionInboxRoute("GET", "/api/inbox")).toBe(true);
    expect(companionInboxRoute("POST", "/api/inbox/state")).toBe(true);
    expect(companionInboxRoute("POST", "/api/inbox")).toBe(false);
    expect(companionInboxRoute("GET", "/api/inbox/state")).toBe(false);
    expect(companionInboxRoute("GET", "/api/inbox/other")).toBe(false);
  });
});

describe("the remote Inbox", () => {
  it("shows the companion only the threads its sidebar shows", () => {
    const db = fixture(); seed(db);
    const result = list(db, "companion", world().store);
    expect(result.status).toBe(200);
    expect(threadsOf(result.body as InboxPage)).toEqual(new Set(["t-open", "t-open-task", "t-room"]));
    expect((result.body as InboxPage).decisions).toBe(3);
  });

  it("never lets a hidden thread in through search, a label or a count", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    for (const query of ["Secret", "Payroll"]) {
      const result = list(db, "companion", store, { view: "all", query });
      expect(result.status).toBe(200);
      expect((result.body as InboxPage).total, query).toBe(0);
    }
    const page = list(db, "companion", store, { view: "approvals" }).body as InboxPage;
    expect(page.approvals).toBe(3);
    expect(JSON.stringify(page)).not.toMatch(/Secret|Payroll/);
  });

  it("follows a bot hidden after the phone last looked", () => {
    const db = fixture(); seed(db);
    const { store, bots } = world();
    bots[0].hidden = true;
    expect(threadsOf(list(db, "companion", store).body as InboxPage)).toEqual(new Set(["t-room"]));
  });

  it("refuses a state change to a hidden thread, and writes nothing", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    const everything = (list(db, "desktop", store).body as InboxPage).items;
    for (const thread of ["t-secret", "t-secret-task", "t-dm"]) {
      const hidden = everything.find(item => item.link.threadId === thread)!;
      const result = inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: hidden.id, version: hidden.version, read: true } },
        inboxAccessFor(store, "companion"));
      expect(result.status, thread).toBe(404);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox_item_state").get()).toEqual({ n: 0 });
  });

  it("lets the companion mark a visible item read", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    const visible = (list(db, "companion", store).body as InboxPage).items.find(item => item.link.threadId === "t-open")!;
    const result = inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: visible.id, version: visible.version, read: true } },
      inboxAccessFor(store, "companion"));
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect((list(db, "companion", store).body as InboxPage).items.find(item => item.id === visible.id)?.read).toBe(true);
  });

  it("still answers 404 to a caller no door vouched for", () => {
    const db = fixture(); seed(db);
    const { store } = world();
    expect(list(db, "unproven", store).status).toBe(404);
    const any = (list(db, "desktop", store).body as InboxPage).items[0];
    expect(inboxRequest(db, { method: "POST", path: "/api/inbox/state", body: { id: any.id, version: any.version, read: true } },
      inboxAccessFor(store, "unproven")).status).toBe(404);
  });
});

describe("the desktop Inbox is unchanged", () => {
  it("gets every thread, labelled exactly as the route built them before", () => {
    expect(inboxAccessFor(world().store, "desktop")).toEqual({ owner: true, threads: [
      { threadId: "t-open", label: "Open", botId: "open" },
      { threadId: "t-open-task", label: "Open · Draft", botId: "open" },
      { threadId: "t-secret", label: "Secret", botId: "secret" },
      { threadId: "t-secret-task", label: "Secret · Payroll", botId: "secret" },
      { threadId: "t-room", label: "Room" },
      { threadId: "t-dm", label: "Open ⇄ Secret" },
    ] });
  });

  it("sees hidden bots and bot⇄bot rooms, as it always has", () => {
    const db = fixture(); seed(db);
    expect(threadsOf(list(db, "desktop", world().store).body as InboxPage)).toEqual(new Set(ALL));
  });
});
