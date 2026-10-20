// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room member's turn scales with the new work, never with the room's
// history (sibling of turn-full-bounded-api): on a real server with the fake
// engine, the owner's message to a room and the member's whole turn (setup,
// transcript, recall exclusions, prompt, reply, settle) on a room of 1,000
// messages and on one of 200,000 read the same statements and rows, each an
// index search, and never load the room. Run with memory on and with it off
// (the two transcripts a room reads).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { countingInstrumentation, expectBounded, report, type Counts, sendCountCommand } from "./testing/bounded-reads.ts";
import { refillThread, waitForMessageWalk } from "./testing/bounded-reads.ts";

const STORE = fileURLToPath(new URL("./store.ts", import.meta.url));
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const signal = (command: object) => sendCountCommand(fixture.info.dataDir, command);
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };

type Room = { group: { id: string; threadId: string }; bot: { id: string } };
async function createRoom(name: string): Promise<Room> {
  const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string };
  const created = await api("POST", "/api/groups", { name: `${name} room`, memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
  expect(created.status).toBe(201);
  return { group: created.body.group, bot };
}

/** `count` text rows on the room's branch, straight into messages.db (server stopped). */
function seed(threadId: string, count: number) {
  const db = new DatabaseSync(file("messages.db"));
  try {
    const leaf = (db.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id=?").get(threadId) as { id: string | null } | undefined)?.id ?? null;
    db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT ?, 'seed-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
        json_object('id','seed-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,
          'parentId',CASE WHEN v=1 THEN ? ELSE 'seed-'||(v-1) END)
      FROM n`).run(count, threadId, leaf);
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `seed-${count}`);
    refillThread(db, threadId);
  } finally { db.close(); }
}

/** The owner's message to the room and the member's turn, until it has settled. */
async function measuredRoomTurn(room: Room, text: string) {
  for (const name of ["counts.json", "settled", "count-started"]) rmSync(file(name), { force: true });
  const since = Date.now();
  signal({ start: room.group.threadId, bot: room.bot.id });
  await until(() => existsSync(file("count-started")), 5_000);
  const posted = await api("POST", `/api/groups/${room.group.id}/messages`, { text });
  expect(posted.status).toBe(202);
  await until(() => existsSync(file("settled")), 60_000);
  await new Promise((r) => setTimeout(r, 1_500));
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")), 5_000);
  const replied = (() => { const db = new DatabaseSync(file("messages.db"), { readOnly: true }); try { return Number((db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND id NOT LIKE 'seed-%'").get(room.group.threadId) as { n: number }).n); } finally { db.close(); } })();
  // what the turn wrote, so a statement-count difference names the message behind it
  const written = (() => { const db = new DatabaseSync(file("messages.db"), { readOnly: true }); try { return (db.prepare("SELECT role,kind,substr(text,1,60) AS text FROM messages WHERE thread_id=? AND at>=? ORDER BY rowid").all(room.group.threadId, since) as Array<{ role: string; kind: string; text: string }>).map(m => `${m.role}/${m.kind}: ${m.text}`); } finally { db.close(); } })();
  return { counts: JSON.parse(readFileSync(file("counts.json"), "utf8")) as Counts, replied, written };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  await authHeaders();
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

it("a room member's whole turn reads the same statements and rows at 1,000 and at 200,000 room messages, each by index, memory on and off", async () => {
  const warm = await createRoom("Warm-up");
  const small = await createRoom("Thousand");
  const large = await createRoom("Two hundred thousand");
  await fixture.stop();
  seed(small.group.threadId, 1_000);
  seed(large.group.threadId, 200_000);
  await fixture.restart();
  await authHeaders();
  // the start-up index walk has filed the seeded history: its upserts follow its progress, not the thread, so they are not part of a turn
  await waitForMessageWalk(file("messages.db"));
  await measuredRoomTurn(warm, "hello");
  for (const mode of ["active", "off"]) {
    if (mode === "off") expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const a = await measuredRoomTurn(small, `what did we decide? (${mode})`);
    const b = await measuredRoomTurn(large, `what did we decide? (${mode})`);
    expect(a.replied).toBeGreaterThan(0);
    expect(b.replied).toBeGreaterThan(0);
    expect(a.counts.statements).toBeGreaterThan(0);
    report(`room ${mode}`, a.counts, b.counts);
    console.log(`[room ${mode}] written`, JSON.stringify({ small: a.written, large: b.written }, null, 1));
    // background capture of one more message of the turn is timing, not history: keyed reads are bounded, not equal
    expectBounded(a.counts, b.counts, false, true);
  }
}, 400_000);
