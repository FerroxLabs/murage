// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, owner sends, round 4 (Astra r3):
//   1 a restore holds EVERY retryable send (refused, failed), not only the waiting ones
//   2 bot / channel removal records proof for each thread BEFORE the registry forgets them; purge honours group:<id>
//   3 a confirmed channel deletion is honoured even when it left the roster empty
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerDeletedThread, recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import { insertRoomRequest, ownerSendsOwingWords, markOwnerWordsKept, OWNER_CANCEL_NOTE, RESTORE_EXPIRED_NOTE } from "./room-requests.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { initializeOwnerSends, neutralizeRestoredSends, sendStore, SendStore } from "./send-store.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

describe("1 a restore holds every retryable send", () => {
  const input = { kind: "bot" as const, ownerId: "b1", threadId: "t1", text: "do the thing", sendId: "s1", fingerprint: sendFingerprint("do the thing") };
  const make = () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    return { db, store: new SendStore(() => db) };
  };

  it("a refusal backed up, retried (persisted), then restored: the retry is held until a post-restore Send again", () => {
    const { db, store } = make();
    store.accept({ ...input, status: "refused", notice: "refused" });
    // the backup holds the refusal; later the owner pressed Send again, which persisted a retry, then the backup came back
    neutralizeRestoredSends(db);
    const held = store.bySendId("t1", "s1")!;
    expect(held).toMatchObject({ status: "refused", restoreHeld: true });
    expect(held.restoreGen).toBeTruthy();
    const retry = store.accept({ ...input });
    expect(retry.kind).toBe("existing");
    expect(store.accept({ ...input, resend: true, restoreGen: "stale" }).kind).toBe("existing");
    expect(store.bySendId("t1", "s1")!.status).toBe("refused");
    const press = store.accept({ ...input, resend: true, restoreGen: held.restoreGen! });
    expect(press.kind).toBe("new");
    expect(press.row.restoreHeld).toBe(false);
  });

  it("a failed send is held the same way, and a second restore moves the token", () => {
    const { db, store } = make();
    const row = store.accept({ ...input, status: "sending" }).row;
    store.settle(row.seq, "failed");
    neutralizeRestoredSends(db);
    const held = store.bySendId("t1", "s1")!;
    expect(held).toMatchObject({ status: "failed", restoreHeld: true });
    expect(store.accept({ ...input }).kind).toBe("existing");
    neutralizeRestoredSends(db);
    const second = store.bySendId("t1", "s1")!;
    expect(second.restoreGen).not.toBe(held.restoreGen);
    expect(store.accept({ ...input, resend: true, restoreGen: held.restoreGen! }).kind).toBe("existing");
    expect(store.accept({ ...input, resend: true, restoreGen: second.restoreGen! }).kind).toBe("new");
  });

  it("a terminal room-request refusal row (made with a queue id) is held too", () => {
    const { db, store } = make();
    store.accept({ ...input, sendId: undefined, queueId: "q1", status: "refused", notice: "refused" });
    neutralizeRestoredSends(db);
    expect((db.prepare("SELECT restore_held AS h, restore_gen AS g FROM owner_sends WHERE queue_id='q1'").get() as { h: number; g: string | null })).toMatchObject({ h: 1 });
  });
});

describe("2 and 3 deletion proof precedes the registry", () => {
  beforeEach(() => {
    closeMessageDb();
    removeTempDirSync(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
    initializeProjectTables(database());
    sendStore.use(() => database());
  });
  afterEach(() => { vi.restoreAllMocks(); sendStore.reset(); closeMessageDb(); });

  const chip = (kind: "bot" | "group", ownerId: string, threadId: string) =>
    sendStore.accept({ kind, ownerId, threadId, text: `words ${threadId}`, status: "refused", notice: "refused", fingerprint: sendFingerprint(threadId) });
  const sendRows = () => (database().prepare("SELECT thread_id AS t FROM owner_sends ORDER BY seq").all() as Array<{ t: string }>).map((r) => r.t);

  it("a crash after the bot left the registry, before any thread cleanup, still lets startup purge every task's sends", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Second", false)!;
    chip("bot", bot.id, bot.threadId); chip("bot", bot.id, task.threadId);
    vi.spyOn(store as unknown as { pruneMessageAllow(id: string): void }, "pruneMessageAllow").mockImplementation(() => { throw new Error("crash"); });
    expect(() => store.deleteBot(bot.id)).toThrow("crash");
    expect(sendRows()).toEqual([bot.threadId, task.threadId]); // the cleanup never ran
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(true);
    expect(ownerDeletedThread(database(), task.threadId)).toBe(true);
    const gone = sendStore.purgeOrphans((t, o) => Boolean(store.bot(o)) && t !== "");
    expect(gone.sort()).toEqual([bot.threadId, task.threadId].sort());
    expect(sendRows()).toEqual([]);
  });

  it("a bot whose registry write failed keeps its conversations: the proof is withdrawn", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    vi.spyOn(store as unknown as { saveBots(b: unknown): void }, "saveBots").mockImplementation(() => { throw new Error("disk"); });
    expect(() => store.deleteBot(bot.id)).toThrow("disk");
    expect(ownerDeletedThread(database(), bot.threadId)).toBe(false);
    expect(store.bot(bot.id)).toBeTruthy();
  });

  it("a crash after the channel left the registry still purges its threads' sends (thread and group records)", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const group = store.createGroup("Room", [bot.id]);
    chip("group", group.id, group.threadId);
    const real = (store as unknown as { saveGroups(): void }).saveGroups;
    vi.spyOn(store as unknown as { saveGroups(): void }, "saveGroups").mockImplementation(function (this: unknown) { real.call(this); throw new Error("crash"); });
    expect(() => store.deleteGroup(group.id)).toThrow("crash");
    expect(ownerDeletedThread(database(), group.threadId)).toBe(true);
    expect(sendStore.purgeOrphans(() => false)).toEqual([group.threadId]);
    expect(sendRows()).toEqual([]);
  });

  it("purge honours the group record alone for that group's threads (older crash residue), and never another group's", () => {
    recordOwnerDeletion(database(), "group:gA");
    chip("group", "gA", "tA"); chip("group", "gB", "tB"); chip("bot", "gA", "tBot");
    expect(sendStore.purgeOrphans(() => false)).toEqual(["tA"]);
    expect(sendRows()).toEqual(["tB", "tBot"]);
  });

  it("deleting the last channel, then a crash before the project rows go: the next boot removes them despite the empty roster", async () => {
    const migration = await import("./project-migration.ts");
    const records = await import("./project-records.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ name: "Member" }, { seedMessages: false })!;
    const { createProjectRows } = await import("./project-new.ts");
    createProjectRows(database(), { clientId: "last-group", purpose: "Report", mode: "bots", members: [bot.id] }, [{ id: bot.id, name: bot.name }], 1000);
    migration.reconcileProjectRecords(store);
    expect(store.group("last-group")).toBeTruthy();
    store.groups.filter((g) => g.id !== "last-group").forEach((g) => store.deleteGroup(g.id));
    const real = (store as unknown as { saveGroups(): void }).saveGroups;
    vi.spyOn(store as unknown as { saveGroups(): void }, "saveGroups").mockImplementation(function (this: unknown) { real.call(this); throw new Error("crash"); });
    expect(() => store.deleteGroup("last-group")).toThrow("crash");
    vi.restoreAllMocks();
    expect(store.groups).toHaveLength(0);
    expect(records.projectSettingsFor(database(), "last-group")).not.toBeNull(); // the crash left the rows
    migration.reconcileProjectRecords(store);
    expect(records.projectSettingsFor(database(), "last-group")).toBeNull();
  });

  it("an empty roster still protects project rows that have no recorded deletion", async () => {
    const migration = await import("./project-migration.ts");
    const records = await import("./project-records.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ name: "Member" }, { seedMessages: false })!;
    const { createProjectRows } = await import("./project-new.ts");
    createProjectRows(database(), { clientId: "kept", purpose: "Report", mode: "bots", members: [bot.id] }, [{ id: bot.id, name: bot.name }], 1000);
    migration.reconcileProjectRecords(store);
    (store as unknown as { groups: unknown[] }).groups = [];
    migration.reconcileProjectRecords(store);
    expect(records.projectSettingsFor(database(), "kept")).not.toBeNull();
  });
});

describe("4 a terminal room owner send awaiting its chip is fenced by a restore", () => {
  const lineage = (rootThreadId: string) => ({ rootThreadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
  const seed = (db: DatabaseSync, key: string, state: string, extra = "") => {
    const r = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage: lineage("t1"), targetThreadId: "t1", payloadText: "words", sendId: `send-${key}-123456`, priority: "owner", now: 1 } as never).request;
    db.prepare(`UPDATE room_requests SET state=?, finished_at=5 ${extra} WHERE id=?`).run(state, r.id);
    return r.id;
  };
  it("failed, expired, unknown and cancelled requests owing a chip get the restore mark; kept, owner-cancelled and done ones do not", () => {
    const db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    const ids = { failed: seed(db, "a", "failed"), expired: seed(db, "b", "expired"), unknown: seed(db, "c", "unknown"), cancelled: seed(db, "d", "cancelled"),
      kept: seed(db, "e", "failed"), owner: seed(db, "f", "cancelled"), done: seed(db, "g", "done") };
    markOwnerWordsKept(db, ids.kept);
    db.prepare("UPDATE room_requests SET outcome_note=? WHERE id=?").run(OWNER_CANCEL_NOTE, ids.owner);
    prepareProjectTablesForRestore(db, { groups: [], botIds: new Set(), now: 9 } as never);
    const note = (id: string) => (db.prepare("SELECT outcome_note AS n FROM room_requests WHERE id=?").get(id) as { n: string | null }).n;
    for (const id of [ids.failed, ids.expired, ids.unknown, ids.cancelled]) expect(note(id)).toBe(RESTORE_EXPIRED_NOTE);
    expect(note(ids.kept)).not.toBe(RESTORE_EXPIRED_NOTE);
    expect(note(ids.owner)).toBe(OWNER_CANCEL_NOTE);
    expect(note(ids.done)).not.toBe(RESTORE_EXPIRED_NOTE);
    // startup recovery sees the mark on every request it will turn into a chip
    expect(ownerSendsOwingWords(db, 10).map((r) => r.outcomeNote)).toEqual([RESTORE_EXPIRED_NOTE, RESTORE_EXPIRED_NOTE, RESTORE_EXPIRED_NOTE, RESTORE_EXPIRED_NOTE]);
  });
});
