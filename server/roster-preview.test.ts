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
import { ROSTER_TASK_WINDOW, unreadKeep } from "./task-window.ts";
import { ROSTER_DESCRIPTION_CHARS, ROSTER_TEXT_CHARS } from "./transcript-page.ts";

const BOTS = 43, ROOMS = 52, BIG_ROWS = 10, BIG = 50_000, AT = 1_700_000_000_000;
/** Shaped like the owner's workspace (rc9 data test): one bot with 428 tasks of which 395 are unread, five more with 25 to 52, the rest with two;
 * every task with its folder, usage, model and grants; text rows of 1,900 characters; descriptions of 1,500 characters; an installed package's playbook. */
const TASKS_PER_BOT = (i: number) => [428, 52, 46, 38, 32, 25][i] ?? 2, UNREAD_TASKS = 395, TEXT = 1_900, DESCRIPTION = 1_500, PLAYBOOK = 2_000;
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
      : newest
        ? { id, at: AT + v, role: "bot", kind: "text", text: `line ${v} `.padEnd(TEXT, "words of a long reply "), parentId, from: { botId: threadId, name: "Writer", color: "amber" }, copyOf: { threadId, messageIds: [id, id, id] }, turnId: id }
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
    const index = bots.findIndex((bot) => bot.id === record.id);
    if (index < 0) continue;
    const extra = Array.from({ length: TASKS_PER_BOT(index) }, (_, i) => ({
      threadId: `t-${record.id.slice(0, 6)}-${i}`, title: `Task ${i}: a client engagement with a longer name`, createdAt: AT + i, resumeCursors: {},
      cwd: `/home/owner/projects/client-work/2026/engagements/task-${i}`, usage: { input: 12_345, output: 2_345, cachedInput: 1_000, costUsd: 0.123, turns: 7 },
      modelSelection: { instanceId: "verification", model }, alwaysAllow: ["Bash:*"], ...(index === 0 && i < UNREAD_TASKS ? { unread: true } : {}),
    }));
    record.tasks = [...(record.tasks ?? []), ...extra];
    record.description = "about this bot ".repeat(DESCRIPTION / 15).slice(0, DESCRIPTION);
    record.playbooks = [{ key: "pb-1", name: "Playbook", summary: "a skill", instructions: "step ".repeat(PLAYBOOK / 5) }];
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
  // the task window: the newest ROSTER_TASK_WINDOW, the newest few unread-only ones, the open one; never the 395 unread tasks
  for (const bot of seeded) expect(bot.tasks.length).toBeLessThanOrEqual(ROSTER_TASK_WINDOW + unreadKeep(ROSTER_TASK_WINDOW) + 1);
  const heavyBot = seeded.find((bot: any) => bot.id === small.bots[0]!.id);
  expect(heavyBot.tasksTotal).toBeGreaterThanOrEqual(TASKS_PER_BOT(0));
  expect(heavyBot.tasks.filter((task: any) => task.unread).length).toBeGreaterThan(0);
  // the roster carries the first lines of a long description and no playbooks; the whole record is one request away
  for (const bot of seeded) {
    expect(bot.playbooks).toBeUndefined();
    expect(bot.descriptionCut).toBe(true);
    expect([...bot.description].length).toBe(ROSTER_DESCRIPTION_CHARS);
    for (const task of bot.tasks) if (task.threadId !== bot.threadId) expect(task.cwd).toMatch(/^\/Users\/owner/);
  }
  const detail = await api("GET", `/api/bots/${heavyBot.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.bot.description.length).toBe(DESCRIPTION);
  expect(detail.body.bot.descriptionCut).toBeUndefined();
  expect(detail.body.bot.playbooks).toHaveLength(1);
  expect(detail.body.bot.messages).toBeUndefined();
  expect((await api("GET", "/api/bots/nope")).status).toBe(404);
  // every cut row is marked, and its page says there is more: a 1,900-character text row is cut to its first lines and loses the fields only the open thread reads
  const cut = [...smallBody.bots, ...smallBody.groups].filter((owner: any) => owner.messages.some((m: any) => m.truncated));
  expect(cut.length).toBe(BOTS + ROOMS);
  for (const owner of cut) {
    expect(owner.hasMore).toBe(true);
    for (const message of owner.messages) if (message.truncated) expect(JSON.stringify(message).length).toBeLessThan(4_000);
    const text = owner.messages.find((m: any) => m.kind === "text" && m.truncated);
    expect([...text.text].length).toBe(ROSTER_TEXT_CHARS);
    expect(text.copyOf).toBeUndefined();
    expect(text.from).toEqual({ botId: owner.threadId, name: "Writer", color: "amber" });
  }
  // opening a cut thread returns the full row
  const target = cut.find((owner: any) => owner.messages.some((m: any) => m.kind === "activity"));
  const full = await api("GET", `/api/threads/${target.threadId}/messages?limit=100`, undefined, { [CARDS_BESIDE_HEADER]: CARDS_BESIDE_VALUE });
  const heavy = full.body.messages.find((m: any) => m.kind === "activity");
  expect(heavy.truncated).toBeUndefined();
  expect(heavy.text.length).toBe(BIG);
  expect(heavy.tool.errorDetails.length).toBe(BIG);
  const fullText = full.body.messages.find((m: any) => m.kind === "text" && m.copyOf);
  expect(fullText.text.length).toBe(TEXT);
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
