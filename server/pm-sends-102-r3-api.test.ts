// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 pre-release, owner sends, round 3 (Astra r2), through the real server:
//   B a restored room request is held: a lost-ack retry of its id is not admitted, only Send again with the current token
//   C a Send again token from before a later restore is rejected with the held chip
//   D Send again on a busy channel with roomsQueue off really releases the held chip
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { neutralizeRestoredSends } from "./send-store.ts";
import { prepareProjectTablesForRestore } from "./project-tables.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

function harness(features: string) {
  let fixture!: VerificationServer;
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const start = async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 45_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.hold={driver:'claudeAgent',displayName:'Hold fixture',config:{cli:${JSON.stringify(join(SERVER_DIR, "testing", "fake-claude-cli.ts"))}},environment:{FAKE_CLAUDE_MODE:'hang',FAKE_CLAUDE_DUMP_EACH_TURN:'1'}};
      cfg.features={...(cfg.features??{}),${features}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  };
  const makeRoom = async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "hold").models.options;
    const created = await api("POST", "/api/bots", { name: "Heldlead", modelSelection: { instanceId: "hold", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const room = await api("POST", "/api/groups", { name: "Held room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(room.status).toBe(201);
    return room.body.group as { id: string; threadId: string };
  };
  const heldLead = (needle: string): number | undefined => {
    const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
    if (!existsSync(dumpFile)) return undefined;
    const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { pid: number; prompt: unknown; env: Record<string, string> };
    return dump.env.FAKE_CLAUDE_MODE === "hang" && JSON.stringify(dump.prompt).includes(needle) ? dump.pid : undefined;
  };
  const busyRoom = async () => {
    const room = await makeRoom();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds the room" })).status).toBe(202);
    await expect.poll(() => heldLead("lead holds the room"), { timeout: 20000 }).toEqual(expect.any(Number));
    return room;
  };
  /** What a restore does to the waiting work (project-tables.ts prepareProjectTablesForRestore + send-store neutralizeRestoredSends). */
  const restore = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`UPDATE room_requests SET state='expired', outcome_note='restored', finished_at=?, waiting_since=NULL WHERE state IN ('queued','running','waiting_owner','waiting_bot') AND verb='owner_send' AND send_id IS NOT NULL`).run(Date.now());
      neutralizeRestoredSends(db);
      db.exec("COMMIT");
    } finally { db.close(); }
  };
  /** The real restore preparation (project-tables.ts) over a terminal request whose chip never persisted. */
  const failWithoutChipThenRestore = () => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE room_requests SET state='failed', finished_at=?, waiting_since=NULL WHERE verb='owner_send' AND state='queued'").run(Date.now());
      prepareProjectTablesForRestore(db, { groups: [], botIds: new Set(), now: Date.now() } as never);
      neutralizeRestoredSends(db);
      db.exec("COMMIT");
    } finally { db.close(); }
  };
  const sql = <T,>(query: string, ...args: string[]): T[] => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
  };
  const chip = (sendId: string) => sql<{ status: string; restore_held: number; restore_gen: string | null }>("SELECT status, restore_held, restore_gen FROM owner_sends WHERE send_id=?", sendId)[0];
  return { api, start, stop: async () => { await fixture?.close(); }, busyRoom, restore, failWithoutChipThenRestore, sql, chip };
}

posixOnly("B+C restored room requests (roomsQueue on)", () => {
  const h = harness("roomsQueue:true");
  beforeAll(h.start, 60000);
  afterAll(h.stop);

  it("a lost-ack retry of a restored room request is held; only Send again with the current token re-admits, and a later restore stales it", async () => {
    const room = await h.busyRoom();
    const body = { text: "words for the room", sendId: "r3_room_send_123456" };
    const queued = await h.api("POST", `/api/groups/${room.id}/messages`, body);
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    const requests = () => h.sql<{ state: string; outcome_note: string | null }>("SELECT state, outcome_note FROM room_requests WHERE verb='owner_send' AND send_id IS NOT NULL ORDER BY rowid");
    expect(requests().map((r) => r.state)).toEqual(["queued"]);

    h.restore(); // the backup restore expires the waiting request
    expect(requests()).toEqual([{ state: "expired", outcome_note: "restored" }]);

    // the lost-ack retry (same id, no resend): held, no new request, no transcript line
    const retry = await h.api("POST", `/api/groups/${room.id}/messages`, body);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ queued: true, held: true });
    expect(requests()).toHaveLength(1);
    const chipRow = h.chip(body.sendId)!;
    expect(chipRow).toMatchObject({ status: "refused", restore_held: 1 });
    const token = chipRow.restore_gen!;
    expect(token).toBeTruthy();

    // resend without a token, or with a guess: still held
    expect((await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true })).body.held).toBe(true);
    expect((await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: "guess" })).body.held).toBe(true);
    expect(requests()).toHaveLength(1);

    // the owner's Send again with the chip's token: a new attempt
    const again = await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: token });
    expect(again.status).toBe(202);
    expect(again.body.held).toBeUndefined();
    expect(again.body.queued).toBe(true);
    expect(requests().map((r) => r.state)).toEqual(["expired", "queued"]);

    // a second restore expires that attempt too; an automatic retry carrying the first press is stale
    h.restore();
    const stale = await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: token });
    expect(stale.body).toMatchObject({ queued: true, held: true });
    expect(requests().map((r) => r.state)).toEqual(["expired", "expired"]);
    const fresh = h.chip(body.sendId)!;
    expect(fresh.restore_gen).not.toBe(token);
    const second = await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: fresh.restore_gen });
    expect(second.body.held).toBeUndefined();
    expect(requests().map((r) => r.state)).toEqual(["expired", "expired", "queued"]);
  }, 120000);
});

posixOnly("D busy channel with roomsQueue off", () => {
  const h = harness("roomsQueue:false");
  beforeAll(h.start, 60000);
  afterAll(h.stop);

  it("Send again with the chip's token releases the held chip into the queue; a stale token does not", async () => {
    const room = await h.busyRoom();
    const body = { text: "waits in the fallback queue", sendId: "r3_fallback_123456" };
    const queued = await h.api("POST", `/api/groups/${room.id}/messages`, body);
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    expect(h.chip(body.sendId)).toMatchObject({ status: "queued", restore_held: 0 });

    h.restore();
    const held = h.chip(body.sendId)!;
    expect(held).toMatchObject({ status: "refused", restore_held: 1 });
    const first = held.restore_gen!;

    expect((await h.api("POST", `/api/groups/${room.id}/messages`, body)).body.held).toBe(true);
    h.restore(); // a second restore before the owner pressed anything: the first token is stale
    expect((await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: first })).body.held).toBe(true);
    expect(h.chip(body.sendId)).toMatchObject({ status: "refused", restore_held: 1 });

    const current = h.chip(body.sendId)!.restore_gen!;
    const released = await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: current });
    expect(released.status).toBe(202);
    expect(released.body.held).toBeUndefined();
    expect(released.body.queued).toBe(true);
    // the chip really left the held state: the row waits in the queue
    expect(h.chip(body.sendId)).toMatchObject({ status: "queued", restore_held: 0 });
  }, 120000);
});

posixOnly("r4 a terminal room send with no chip at backup time", () => {
  const h = harness("roomsQueue:true");
  beforeAll(h.start, 60000);
  afterAll(h.stop);

  it("a persisted pre-restore retry of its id is held and gets a restore-held chip, not a new request", async () => {
    const room = await h.busyRoom();
    const body = { text: "words with no chip yet", sendId: "r4_nochip_123456" };
    expect((await h.api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(202);
    h.failWithoutChipThenRestore();
    expect(h.chip(body.sendId)).toBeUndefined();
    const retry = await h.api("POST", `/api/groups/${room.id}/messages`, body);
    expect(retry.body).toMatchObject({ queued: true, held: true });
    expect(h.sql("SELECT 1 FROM room_requests WHERE verb='owner_send' AND send_id=?", body.sendId)).toHaveLength(1);
    const held = h.chip(body.sendId)!;
    expect(held).toMatchObject({ status: "refused", restore_held: 1 });
    const again = await h.api("POST", `/api/groups/${room.id}/messages`, { ...body, resend: true, restoreGen: held.restore_gen });
    expect(again.body.held).toBeUndefined();
  }, 120000);
});
