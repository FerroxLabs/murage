// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots?messages=3 (the desktop's boot page) carries preview rows and a small task window, so a roster shaped like the owner's data (43 bots, 52
// rooms, large tool payloads, 15 tasks a bot) stays under 300 KB at any transcript size. A cut row says so (`truncated`), its page says `hasMore`, and
// opening the thread returns the full row.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { refillThread } from "./testing/bounded-reads.ts";
import { CARDS_BESIDE_HEADER, CARDS_BESIDE_VALUE } from "./task-delta.ts";
import { ROSTER_TASK_WINDOW } from "./task-window.ts";

const BOTS = 43, ROOMS = 52, BIG_ROWS = 10, TASKS = 15, BIG = 50_000, AT = 1_700_000_000_000;
let fixture: VerificationServer | undefined, headers: Record<string, string> = {};
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { ...headers, ...extra, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };

/** `rowsPerThread` stored rows in every thread; the newest `BIG_ROWS` rows across the roster are tool rows with 50 KB payloads. */
function seed(db: DatabaseSync, threadId: string, rowsPerThread: number, big: boolean) {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let v = 1; v <= rowsPerThread; v++) {
    const newest = v > rowsPerThread - 3, id = `${threadId.slice(0, 8)}-${v}`, parentId = v === 1 ? null : `${threadId.slice(0, 8)}-${v - 1}`;
    const heavy = big && newest && v === rowsPerThread;
    const message = heavy
      ? { id, at: AT + v, role: "bot", kind: "activity", text: "x".repeat(BIG), tool: { name: "Bash", ok: true, summary: "ran a command", errorDetails: "e".repeat(BIG) }, parentId }
      : { id, at: AT + v, role: v % 2 ? "user" : "bot", kind: "text", text: `line ${v}`, parentId };
    insert.run(threadId, id, AT + v, message.role, message.kind, message.text, JSON.stringify(message));
  }
  db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `${threadId.slice(0, 8)}-${rowsPerThread}`);
  db.exec("COMMIT");
  refillThread(db, threadId);
}

async function roundTrip(rowsPerThread: number) {
  fixture = await launchVerificationServer({});
  await authHeaders();
  const model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bots: Array<{ id: string; threadId: string }> = [];
  for (let i = 0; i < BOTS; i++) bots.push((await api("POST", "/api/bots", { name: `Roster ${i}`, modelSelection: { instanceId: "verification", model } })).body.bot);
  const rooms: Array<{ id: string; threadId: string }> = [];
  for (let i = 0; i < ROOMS; i++) rooms.push((await api("POST", "/api/groups", { name: `Room ${i}`, memberIds: [bots[i % BOTS]!.id] })).body.group);
  await fixture.stop();
  const path = join(fixture.info.dataDir, "bots.json");
  const records = JSON.parse(readFileSync(path, "utf8")) as any[];
  for (const record of records) {
    if (!bots.some((bot) => bot.id === record.id)) continue;
    const extra = Array.from({ length: TASKS }, (_, i) => ({ threadId: `t-${record.id.slice(0, 6)}-${i}`, title: `Task ${i}`, createdAt: AT + i, resumeCursors: {} }));
    record.tasks = [...(record.tasks ?? []), ...extra];
  }
  writeFileSync(path, JSON.stringify(records));
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { [...bots, ...rooms].forEach((owner, index) => seed(db, owner.threadId, rowsPerThread, index < BIG_ROWS)); } finally { db.close(); }
  await fixture.restart();
  await authHeaders();
  const roster = await api("GET", "/api/bots?messages=3", undefined, { [CARDS_BESIDE_HEADER]: CARDS_BESIDE_VALUE });
  return { roster, bots, rooms };
}

it("the boot roster of 43 bots and 52 rooms with ten 50 KB tool rows is under 300 KB, and the same with ten times the transcript", async () => {
  const small = await roundTrip(30);
  const smallBytes = small.roster.text.length;
  const smallBody = small.roster.body;
  expect(small.roster.status).toBe(200);
  for (const owner of [...smallBody.bots, ...smallBody.groups]) expect(owner.messages.length).toBeLessThanOrEqual(3);
  const seeded = smallBody.bots.filter((bot: any) => bot.name.startsWith("Roster"));
  expect(seeded).toHaveLength(BOTS);
  for (const bot of seeded) expect(bot.tasks.length).toBeLessThanOrEqual(ROSTER_TASK_WINDOW + 1 + 1);
  // every cut row is marked, and its page says there is more
  const cut = [...smallBody.bots, ...smallBody.groups].filter((owner: any) => owner.messages.some((m: any) => m.truncated));
  expect(cut.length).toBe(BIG_ROWS);
  for (const owner of cut) {
    expect(owner.hasMore).toBe(true);
    for (const message of owner.messages) if (message.truncated) expect(JSON.stringify(message).length).toBeLessThan(4_000);
  }
  // opening a cut thread returns the full row
  const target = cut[0];
  const full = await api("GET", `/api/threads/${target.threadId}/messages?limit=100`, undefined, { [CARDS_BESIDE_HEADER]: CARDS_BESIDE_VALUE });
  const heavy = full.body.messages.find((m: any) => m.kind === "activity");
  expect(heavy.truncated).toBeUndefined();
  expect(heavy.text.length).toBe(BIG);
  expect(heavy.tool.errorDetails.length).toBe(BIG);
  console.info("roster bytes", smallBytes);
  expect(smallBytes).toBeLessThan(300_000);
  await fixture!.close(); fixture = undefined;

  const large = await roundTrip(300);
  expect(Math.abs(large.roster.text.length - smallBytes)).toBeLessThan(smallBytes * 0.1);
}, 900_000);

it("with no messages parameter the roster answers the desktop's page of 3", async () => {
  fixture = await launchVerificationServer({});
  await authHeaders();
  const model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "Bare", modelSelection: { instanceId: "verification", model } })).body.bot;
  await fixture.stop();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { seed(db, bot.threadId, 40, false); } finally { db.close(); }
  await fixture.restart();
  await authHeaders();
  const bare = (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
  expect(bare.messages.length).toBeGreaterThan(3); expect(bare.messages.some((m: any) => m.truncated)).toBe(false);
  expect(bare.hasMore).toBe(false);
}, 300_000);
