// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { deleteThread, insertMessage, updateMessage } from "./message-db.ts";
import * as inboxVersion from "./inbox-version.ts";
import { messagesVersion, onMessagesChanged } from "./inbox-version.ts";
import { listInboxCached, type InboxAccess } from "./inbox.ts";
import type { Message } from "./store.ts";

const msg = (id: string, extra: Record<string, unknown>): Message => ({ id, at: 1, role: "bot", kind: "text", text: "x", ...extra }) as Message;
const access: InboxAccess = { owner: true, threads: [{ threadId: "t", label: "Bot" }] };

describe("inbox version and database pragmas", () => {
  beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

  it("sorts and caches in memory, and has the inbox index", () => {
    const db = database();
    expect(db.prepare("PRAGMA temp_store").get()).toMatchObject({ temp_store: 2 });
    expect(Number(db.prepare("PRAGMA cache_size").get()?.cache_size)).toBeLessThan(0);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_inbox'").get()).toBeTruthy();
  });

  it("bumps for Inbox-shaped writes, and not for a streaming reply", () => {
    database();
    let heard = 0; const stop = onMessagesChanged(() => { heard++; });
    const before = messagesVersion();
    insertMessage("t", msg("a", { kind: "text", text: "streaming" })); // not an Inbox row
    updateMessage("t", msg("a", { kind: "text", text: "streaming more" }));
    insertMessage("t", msg("u", { role: "user", kind: "text" }));
    expect(messagesVersion()).toBe(before);
    insertMessage("t", msg("c", { kind: "options", card: { requestId: "r", options: ["Allow"], tool: "Bash" } }));
    expect(messagesVersion()).toBe(before + 1);
    updateMessage("t", msg("c", { kind: "options", card: { requestId: "r", answered: "Allowed", options: [] } }));
    expect(messagesVersion()).toBe(before + 2);
    insertMessage("t", msg("f", { kind: "text", artifactIds: ["a".repeat(36)] }));
    expect(messagesVersion()).toBe(before + 3);
    deleteThread("t");
    expect(messagesVersion()).toBe(before + 4);
    expect(heard).toBe(4); stop();
  });

  it("a real write through message-db reaches the cached Inbox", () => {
    const db = database();
    expect(listInboxCached(db, { view: "decisions" }, access).decisions).toBe(0);
    insertMessage("t", msg("c", { kind: "options", card: { requestId: "r", options: ["Allow"], tool: "Bash" } }));
    expect(listInboxCached(db, { view: "decisions" }, access).decisions).toBe(1);
    updateMessage("t", msg("c", { kind: "options", card: { requestId: "r", answered: "Allowed", options: [] } }));
    expect(listInboxCached(db, { view: "decisions" }, access).decisions).toBe(0);
  });

  it("routine run and routine deletion frames change the Inbox; chat frames do not", () => {
    // Routine run RECORDS (not messages) feed the Inbox's roll-ups and its
    // "connection to restore" rows, which count in `decisions`. Without a
    // notice the badge waited for the 60 s fallback.
    const changes = (inboxVersion as Record<string, unknown>).frameChangesInbox as ((payload: Record<string, unknown>) => boolean) | undefined;
    expect(typeof changes).toBe("function");
    expect(changes!({ kind: "routine.run", run: {} })).toBe(true);
    expect(changes!({ kind: "routine.deleted", routineId: "r" })).toBe(true);
    for (const kind of ["message", "message.patch", "bot", "screen", "inbox.changed", "notify"]) expect(changes!({ kind })).toBe(false);
  });
});
