// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Steer visibility, round 5, against a real server with its own data folder: the rows of
// the send ledger are written the way a crash or an earlier attempt leaves them, and the
// routes and the startup recovery must give the answers the lane promises.
//   - every start finishes a send that has no visible receipt (an in-flight one and an
//     "unconfirmed" one), line and notice together;
//   - a cancelled send id never executes, even when the room is idle by the time it comes back;
//   - a send id whose earlier attempt failed is a NEW attempt, never an acknowledgement of the
//     old transcript line.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { sendFingerprint } from "./send-idempotency.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const hash = (fingerprint: string) => createHash("sha256").update(fingerprint).digest("hex");
const dbFile = () => join(fixture.info.dataDir, "messages.db");
/** Edit the ledger with the server stopped, then start it again (so every start-up pass runs over those rows). */
const withLedger = async (edit: (db: DatabaseSync) => void) => {
  await fixture.stop();
  const db = new DatabaseSync(dbFile());
  try { edit(db); } finally { db.close(); }
  await fixture.restart();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const ledger = <T,>(read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(dbFile(), { readOnly: true });
  try { return read(db); } finally { db.close(); }
};
const insert = (db: DatabaseSync, row: { kind: "bot" | "group"; owner: string; thread: string; sendId: string; text: string; status: string; fingerprint: string; messageId?: string }) =>
  db.prepare(`INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, status, dispatched, message_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.kind, row.owner, row.thread, row.sendId, `q-${row.sendId}`, row.fingerprint, row.text, row.status, row.status === "dispatched" ? 1 : 0, row.messageId ?? null, Date.now(), Date.now());

describe.skipIf(process.platform === "win32")("steer visibility round 5", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("1. every start gives an in-flight send and a receipt-less unconfirmed send their line and notice together", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Recovery fixture" })).body.bot;
    await withLedger((db) => {
      insert(db, { kind: "bot", owner: bot.id, thread: bot.threadId, sendId: "send-r5-inflight-0001", text: "R5_IN_FLIGHT words", status: "dispatched", fingerprint: hash("x") });
      insert(db, { kind: "bot", owner: bot.id, thread: bot.threadId, sendId: "send-r5-hidden-000001", text: "R5_HIDDEN words", status: "unconfirmed", fingerprint: hash("y") });
    });
    const lines = await messages(bot.threadId);
    for (const text of ["R5_IN_FLIGHT words", "R5_HIDDEN words"]) {
      const line = lines.find((m) => m.role === "user" && m.text === text);
      expect(line, text).toBeDefined();
      expect(line.steerUnconfirmed).toBe(true);
    }
    expect(lines.filter((m) => m.kind === "activity" && m.tool?.name === "send-notice:notConfirmed")).toHaveLength(2);
    const rows = ledger((db) => db.prepare("SELECT status, notice, message_id, text FROM owner_sends WHERE send_id IN ('send-r5-inflight-0001','send-r5-hidden-000001')").all() as any[]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "unconfirmed", notice: "notConfirmed", text: "" });
      expect(lines.some((m) => m.id === row.message_id)).toBe(true);
    }
    // the next start writes nothing more
    await withLedger(() => {});
    expect((await messages(bot.threadId)).filter((m) => m.tool?.name === "send-notice:notConfirmed")).toHaveLength(2);
  }, 180000);

  it("3. a cancelled room send never executes when its id comes back after the room went idle", async () => {
    const member = (await api("POST", "/api/bots", { name: "Room member" })).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Cancel room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group;
    const sendId = "send-r5-cancelled-0001";
    await withLedger((db) => insert(db, { kind: "group", owner: room.id, thread: room.threadId, sendId, text: "R5_CANCELLED words", status: "cancelled", fingerprint: hash(sendFingerprint("R5_CANCELLED words", undefined, "chat", undefined)) }));
    const retry = await api("POST", `/api/groups/${room.id}/messages`, { text: "R5_CANCELLED words", sendId });
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ ok: true, cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await messages(room.threadId)).some((m) => m.role === "user" && m.text === "R5_CANCELLED words")).toBe(false);
    // different words under that id are a conflict, not a way around the cancellation
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "something else", sendId })).status).toBe(409);
  }, 120000);

  it("5. a send id whose earlier attempt failed is sent again as a new attempt, for a bot and for a room", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Retry fixture" })).body.bot;
    const sendId = "send-r5-failed-bot-001";
    const first = await api("POST", `/api/bots/${bot.id}/messages`, { text: "R5_RETRY words", sendId, threadId: bot.threadId });
    expect(first.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 60000 }).toBe(false);
    const before = (await messages(bot.threadId)).filter((m) => m.role === "user" && m.text === "R5_RETRY words");
    expect(before).toHaveLength(1);
    // its late refusal leaves the row failed, with the old line still in the transcript
    await withLedger((db) => { db.prepare("UPDATE owner_sends SET status='failed' WHERE send_id=?").run(sendId); });
    const again = await api("POST", `/api/bots/${bot.id}/messages`, { text: "R5_RETRY words", sendId, threadId: bot.threadId });
    expect(again.status).toBe(202);
    expect(again.body.message?.id).toBeDefined();
    expect(again.body.message.id).not.toBe(before[0].id);
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.role === "user" && m.text === "R5_RETRY words").length, { timeout: 30000 }).toBe(2);

    const member = (await api("POST", "/api/bots", { name: "Retry room member" })).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Retry room", memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group;
    const roomSend = "send-r5-failed-room-01";
    await withLedger((db) => insert(db, { kind: "group", owner: room.id, thread: room.threadId, sendId: roomSend, text: "R5_ROOM_RETRY words", status: "refused", fingerprint: hash(sendFingerprint("R5_ROOM_RETRY words", undefined, "chat", undefined)) }));
    const roomAgain = await api("POST", `/api/groups/${room.id}/messages`, { text: "R5_ROOM_RETRY words", sendId: roomSend });
    expect(roomAgain.status).toBe(202);
    expect(roomAgain.body.message?.text).toBe("R5_ROOM_RETRY words");
    expect(ledger((db) => db.prepare("SELECT status FROM owner_sends WHERE send_id=?").all(roomSend) as any[])).toEqual([]);
  }, 240000);
});
