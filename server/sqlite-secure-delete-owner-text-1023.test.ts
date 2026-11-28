// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-sqlite-fix (FABLE n4:7148 High on q1022-sqlite-opus 2a7e681b55; owner: q1023-sqlite-fix). Invariant: every transaction that removes or
// rewrites the owner's typed words runs with secure_delete=ON on its connection (server/secure-delete.ts). The connection's default is FAST (database.ts).
// These rows are the sites the 1.0.22 witness did not drive: the boot purge of an owner-deleted conversation's sends (boot-recoveries.ts recoverOwnerSends:
// purgeOrphans + scrubOwnerSendsOfGoneThreads) and the room-request retention delete (pruneTerminalRoomRequests). Each row enters through the production
// function on the real handle and reads PRAGMA secure_delete at the write through a TEMP-trigger probe.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { recoverOwnerSends } from "./boot-recoveries.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { insertRoomRequest, pruneTerminalRoomRequests, ROOM_REQUEST_RETENTION_MS } from "./room-requests.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { DatabaseSync } from "node:sqlite";
import { initializeOwnerSends, sendStore, SendStore } from "./send-store.ts";
import { validateProjectRows } from "./project-tables.ts";
import { Store } from "./store.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { probeSecureDelete } from "./testing/secure-delete-probe.ts";

const words = "ZQX-owner-words ".repeat(300);
const lineage = (rootThreadId: string) => ({ rootThreadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false });
const shortWords = "ZQX-owner-words ".repeat(200);
const mode = () => Number((database().prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);

beforeEach(async () => {
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  initializeProjectTables(database());
  sendStore.use(() => database());
});
let own: DatabaseSync | null = null;
afterEach(async () => { own?.close(); own = null; sendStore.reset(); closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); });

const boot = () => recoverOwnerSends({ database: () => database(), live: () => false, threadIsLive: () => false, broadcastSends: () => {}, io: {} as never });
const ownerSend = (threadId: string, key: string) => insertRoomRequest(database(), {
  groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: key, lineage: lineage(threadId), targetThreadId: threadId,
  payloadText: words, sendId: `send-${key}-123456`, priority: "owner", now: 1,
} as never).request;

it("SITE boot purge of a deleted conversation's owner_sends (send-store.ts purgeOrphans via boot-recoveries.ts recoverOwnerSends) runs at secure_delete ON", () => {
  sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tDel", text: words, status: "refused", notice: "refused", fingerprint: sendFingerprint("tDel") });
  recordOwnerDeletion(database(), "tDel");
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends");
  try { boot(); } finally { probe.stop(); }
  expect(database().prepare("SELECT count(*) AS n FROM owner_sends").get(), "the deleted conversation's send rows are gone").toEqual({ n: 0 });
  expect(probe.modes.length, "purgeOrphans reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "purgeOrphans ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE boot scrub of a deleted conversation's room-request payload (room-requests.ts scrubOwnerSendsOfThread via recoverOwnerSends) runs at secure_delete ON", () => {
  const id = ownerSend("tDel2", "scrub").id;
  recordOwnerDeletion(database(), "tDel2");
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "room_requests", { update: "payload_text" });
  try { boot(); } finally { probe.stop(); }
  expect(database().prepare("SELECT payload_text AS p FROM room_requests WHERE id=?").get(id), "the words are gone").toEqual({ p: null });
  expect(probe.modes.length, "scrubOwnerSendsOfThread reached its payload rewrite").toBeGreaterThan(0);
  expect(probe.modes, "scrubOwnerSendsOfThread ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE room-request retention delete (room-requests.ts pruneTerminalRoomRequests) runs at secure_delete ON", () => {
  const id = ownerSend("tOld", "prune").id;
  database().prepare("UPDATE room_requests SET state='done', finished_at=5 WHERE id=?").run(id);
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "room_requests");
  let pruned = 0;
  try { pruned = pruneTerminalRoomRequests(database(), 5 + ROOM_REQUEST_RETENTION_MS + 1000); } finally { probe.stop(); }
  expect(pruned, "the retained row was pruned").toBe(1);
  expect(probe.modes.length, "pruneTerminalRoomRequests reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "pruneTerminalRoomRequests ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

// channel deletion (store.ts deleteGroup -> project-tables.ts deleteProjectRows) and its boot crash repair (project-migration.ts reconcileProjectRecords)
// delete the channel's room_requests rows, which hold the owner's typed words
const channelStore = () => new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
const channelWithSend = async (clientId: string) => {
  const store = channelStore();
  const bot = store.createBot({ name: "Member" }, { seedMessages: false })!;
  const { createProjectRows } = await import("./project-new.ts");
  createProjectRows(database(), { clientId, purpose: "Report", mode: "bots", members: [bot.id] }, [{ id: bot.id, name: bot.name }], 1000);
  const migration = await import("./project-migration.ts");
  migration.reconcileProjectRecords(store);
  const send = insertRoomRequest(database(), {
    groupId: clientId, verb: "owner_send", fromKind: "owner", admissionKey: `k-${clientId}`, lineage: lineage(`t-${clientId}`), targetThreadId: `t-${clientId}`,
    payloadText: words, sendId: `send-${clientId}-123456`, priority: "owner", now: 1,
  } as never).request;
  return { store, migration, send };
};

it("SITE channel deletion (store.ts deleteGroup -> project-tables.ts deleteProjectRows) removes the channel's room requests at secure_delete ON", async () => {
  const { store, send } = await channelWithSend("live-group");
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "room_requests");
  try { expect(store.deleteGroup("live-group")).toBe(true); } finally { probe.stop(); }
  expect(database().prepare("SELECT count(*) AS n FROM room_requests WHERE id=?").get(send.id), "the channel's request row is gone").toEqual({ n: 0 });
  expect(probe.modes.length, "deleteProjectRows reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "deleteProjectRows ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE boot crash repair of a deleted channel (project-migration.ts reconcileProjectRecords -> deleteProjectRows) removes its room requests at secure_delete ON", async () => {
  const { store, migration, send } = await channelWithSend("crash-group");
  const real = (store as unknown as { saveGroups(): void }).saveGroups;
  const crash = vi.spyOn(store as unknown as { saveGroups(): void }, "saveGroups").mockImplementation(function (this: unknown) { real.call(this); throw new Error("crash"); });
  expect(() => store.deleteGroup("crash-group")).toThrow("crash");
  crash.mockRestore();
  expect(database().prepare("SELECT count(*) AS n FROM room_requests WHERE id=?").get(send.id), "the crash left the request row").toEqual({ n: 1 });
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "room_requests");
  try { migration.reconcileProjectRecords(store); } finally { probe.stop(); }
  expect(database().prepare("SELECT count(*) AS n FROM room_requests WHERE id=?").get(send.id), "the repair removed the request row").toEqual({ n: 0 });
  expect(probe.modes.length, "the repair reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "the repair ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

// the send chip's own writes: dismissing a refused chip blanks its words (send-store.ts cancel -> settle) and a fresh send retires the stale
// failed/refused one (send-store.ts retire, index.ts); and the project brief's version cap deletes owner-written versions (project-records.ts)
it("SITE dismissing a refused send chip (send-store.ts cancel -> settle) blanks its words at secure_delete ON", () => {
  const row = sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tC", queueId: "q-cancel", text: words, status: "refused", notice: "refused", fingerprint: sendFingerprint("tC") }).row;
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try { expect(sendStore.cancel("b1", "q-cancel")?.seq).toBe(row.seq); } finally { probe.stop(); }
  expect(database().prepare("SELECT text AS t FROM owner_sends WHERE seq=?").get(row.seq), "the words are blanked").toEqual({ t: "" });
  expect(probe.modes.length, "settle reached its rewrite").toBeGreaterThan(0);
  expect(probe.modes, "settle ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE retiring a stale refused send chip (send-store.ts retire) deletes its row at secure_delete ON", () => {
  const row = sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tR", text: words, status: "refused", notice: "refused", fingerprint: sendFingerprint("tR") }).row;
  // retire keeps a receipt-backed chip (a legacy chip has no receipt): the row under test is a legacy one
  database().prepare("DELETE FROM send_attempts WHERE thread_id=? AND send_id=?").run("tR", row.sendId);
  expect(sendStore.attemptFor(sendStore.bySeq(row.seq)!), "a legacy chip, no receipt").toBeUndefined();
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends");
  try { sendStore.retire(row.seq); } finally { probe.stop(); }
  expect(database().prepare("SELECT count(*) AS n FROM owner_sends WHERE seq=?").get(row.seq), "the row is gone").toEqual({ n: 0 });
  expect(probe.modes.length, "retire reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "retire ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE project brief version cap (project-briefs.ts patchProjectBrief -> project-records.ts insertProjectBriefVersion) deletes old versions at secure_delete ON", async () => {
  const store = channelStore();
  const bot = store.createBot({ name: "Member" }, { seedMessages: false })!;
  const { createProjectRows } = await import("./project-new.ts");
  createProjectRows(database(), { clientId: "brief-group", purpose: "Report", mode: "bots", members: [bot.id] }, [{ id: bot.id, name: bot.name }], 1000);
  (await import("./project-migration.ts")).reconcileProjectRecords(store);
  const { patchProjectBrief } = await import("./project-briefs.ts");
  const { PROJECT_BRIEF_MAX_VERSIONS, currentProjectBrief } = await import("./project-records.ts");
  const db = database();
  const first = currentProjectBrief(db, "brief-group")!;
  for (let version = first.version + 1; version <= PROJECT_BRIEF_MAX_VERSIONS; version++) {
    db.prepare("INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("brief-group", version, "s", shortWords, shortWords, "[]", "[]", "owner", "owner_edit", 1);
  }
  db.exec("PRAGMA secure_delete=FAST"); // the arrangement above may have written briefs; the probed write starts from the connection's default
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(db, "project_briefs");
  try { expect(patchProjectBrief(db, { groupId: "brief-group", expectedVersion: PROJECT_BRIEF_MAX_VERSIONS, rules: "new rules", now: 2 }).ok).toBe(true); } finally { probe.stop(); }
  expect(probe.modes.length, "the version cap reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "the version cap ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

// the rest of the send chip's own rewrites: an unconfirmed row's words leave when it is answered or its turn ends (send-store.ts scrub), a restart
// turns a stopped queued send into a refused chip without its prompt (send-store.ts recover), a legacy resend deletes the prior chip (send-store.ts
// accept), and an activation repair resets a brief entry list whose shape is invalid (project-tables.ts validateProjectRows)
it("SITE an unconfirmed send's words leave when it is answered (send-store.ts scrub) at secure_delete ON", () => {
  const row = sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tU", text: words, status: "sending", fingerprint: sendFingerprint("tU") }).row;
  database().prepare("UPDATE owner_sends SET status='unconfirmed', message_id='m-u', prompt=? WHERE seq=?").run(words, row.seq);
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try { sendStore.scrub(row.seq); } finally { probe.stop(); }
  expect(database().prepare("SELECT text AS t, prompt AS p FROM owner_sends WHERE seq=?").get(row.seq), "the words are gone").toEqual({ t: "", p: null });
  expect(probe.modes.length, "scrub reached its rewrite").toBeGreaterThan(0);
  expect(probe.modes, "scrub ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE boot recovery of a stopped queued send (send-store.ts recover) drops its prompt at secure_delete ON", () => {
  const row = sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tS", text: words, status: "queued", fingerprint: sendFingerprint("tS") }).row;
  database().prepare("UPDATE owner_sends SET stopped=1, prompt=? WHERE seq=?").run(words, row.seq);
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "prompt" });
  try { sendStore.recover(); } finally { probe.stop(); }
  expect(database().prepare("SELECT status AS s, prompt AS p FROM owner_sends WHERE seq=?").get(row.seq), "the stopped send is a refused chip without its prompt").toEqual({ s: "refused", p: null });
  expect(probe.modes.length, "recover reached its rewrite").toBeGreaterThan(0);
  expect(probe.modes, "recover ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE a legacy resend deletes the prior chip (send-store.ts accept, no receipt schema) at secure_delete ON", () => {
  const db = own = new DatabaseSync(":memory:");
  db.exec("PRAGMA secure_delete=FAST");
  initializeOwnerSends(db);
  const store = new SendStore(() => db);
  const input = { kind: "bot" as const, ownerId: "b1", threadId: "tL", sendId: "s-legacy", text: words, fingerprint: sendFingerprint("tL") };
  const first = store.accept({ ...input, status: "refused", notice: "refused" }).row;
  expect(store.attempts(), "the receipt schema is not active (legacy)").toBeUndefined();
  expect(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(db, "owner_sends");
  let again: ReturnType<SendStore["accept"]>;
  try { again = store.accept({ ...input }); } finally { probe.stop(); }
  expect(again.kind, "the resend replaced the prior chip").toBe("new");
  expect(db.prepare("SELECT count(*) AS n FROM owner_sends WHERE seq=?").get(first.seq), "the prior row is gone").toEqual({ n: 0 });
  expect(probe.modes.length, "accept reached the prior chip's delete").toBeGreaterThan(0);
  expect(probe.modes, "accept ran the delete at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete), "the connection is back at FAST afterwards").toBe(2);
});

it("SITE an activation repair of a brief whose entry list has an invalid shape (project-tables.ts validateProjectRows) rewrites it at secure_delete ON", () => {
  const db = own = new DatabaseSync(":memory:");
  db.exec("PRAGMA secure_delete=FAST");
  initializeProjectTables(db);
  const crowd = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, text: `${words.slice(0, 200)}${i}` })));
  db.prepare("INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("g-fix", 1, "s", "d", "r", crowd, "[]", "owner", "owner_edit", 1);
  expect(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(db, "project_briefs", { update: "where_work_is" });
  try { validateProjectRows(db, { groups: [], botIds: new Set(), now: 2 }); } finally { probe.stop(); }
  expect(db.prepare("SELECT where_work_is AS w FROM project_briefs WHERE group_id='g-fix'").get(), "the invalid list was reset").toEqual({ w: "[]" });
  expect(probe.modes.length, "the repair reached its rewrite").toBeGreaterThan(0);
  expect(probe.modes, "the repair ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete), "the connection is back at FAST afterwards").toBe(2);
});
