// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots?view=sidebar (the 1.0.2 boot roster, desktop and phone) carries one sidebar line per conversation and no transcript rows, so a
// roster shaped like the owner's data (43 bots, 52 rooms, a 428-task bot, long rows, 25 KB tool rows, long descriptions) stays under 300 KB and
// does not grow with history. Every other listing (`?messages=N`, no parameter) answers whole rows, never cut. Design:
// ROSTER-SIDEBARLINE-DESIGN.md section 8, tests 1 to 6 and 16.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { refillThread, waitForMessageWalk } from "./testing/bounded-reads.ts";
import { openSse } from "./testing/sse.ts";
import { CARDS_BESIDE_HEADER, CARDS_BESIDE_VALUE } from "./task-delta.ts";
import { ROSTER_TASK_WINDOW, unreadKeep } from "./task-window.ts";
import { ROSTER_DESCRIPTION_CHARS } from "./transcript-page.ts";
import { SIDEBAR_TEXT_CHARS } from "../shared/sidebar-line.ts";

const BOTS = 43, ROOMS = 52, BIG_ROWS = 10, BIG = 25_000, AT = 1_700_000_000_000;
/** Shaped like the owner's workspace (rc9 data test): one bot with 428 tasks of which 395 are unread, five more with 25 to 52, the rest with two;
 * every task with its folder, usage, model and grants; text rows of 1,900 characters; descriptions of 1,500 characters; an installed package's playbook. */
const TASKS_PER_BOT = (i: number) => [428, 52, 46, 38, 32, 25][i] ?? 2, UNREAD_TASKS = 395, TEXT = 1_900, DESCRIPTION = 1_500, PLAYBOOK = 2_000;
const COMPANION_TOKEN = "c".repeat(64);
let fixture: VerificationServer | undefined, headers: Record<string, string> = {};
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { ...headers, ...extra, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };
const modelOf = async () => (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
const beside = { [CARDS_BESIDE_HEADER]: CARDS_BESIDE_VALUE };
const rowId = (threadId: string, v: number) => `${threadId.slice(0, 8)}-${v}`;

type Row = Record<string, unknown> & { id: string; at: number; role: string; kind: string; text?: string };
function insertRows(db: DatabaseSync, threadId: string, rows: Row[], leaf: string) {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (const row of rows) insert.run(threadId, row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
  db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, leaf);
  db.exec("COMMIT");
  refillThread(db, threadId);
}

/** `rowsPerThread` stored rows in every thread, the newest three long text rows (sender, copy stamps); in the first BIG_ROWS threads the newest
 * row is a tool row with a 25 KB payload and a 25 KB error report. */
function seed(db: DatabaseSync, threadId: string, rowsPerThread: number, big: boolean) {
  const rows: Row[] = [];
  for (let v = 1; v <= rowsPerThread; v++) {
    const newest = v > rowsPerThread - 3, id = rowId(threadId, v), parentId = v === 1 ? null : rowId(threadId, v - 1);
    const heavy = big && newest && v === rowsPerThread;
    rows.push(heavy
      ? { id, at: AT + v, role: "bot", kind: "activity", text: "x".repeat(BIG), tool: { name: "Bash", ok: true, summary: "ran a command", output: "o".repeat(BIG), errorDetails: "e".repeat(BIG) }, parentId }
      : newest
        ? { id, at: AT + v, role: "bot", kind: "text", text: `line ${v} `.padEnd(TEXT, "words of a long reply "), parentId, from: { botId: threadId, name: "Writer", color: "amber" }, copyOf: { threadId, messageIds: [id, id, id] }, turnId: id }
        : { id, at: AT + v, role: v % 2 ? "user" : "bot", kind: "text", text: `line ${v}`, parentId });
  }
  insertRows(db, threadId, rows, rowId(threadId, rowsPerThread));
}

async function ownerShaped(rowsPerThread: number) {
  fixture = await launchVerificationServer({});
  await authHeaders();
  const model = await modelOf();
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
  const roster = await api("GET", "/api/bots?view=sidebar", undefined, beside);
  return { roster, bots, rooms };
}

it("test 1 / 16: view=sidebar on the owner-shaped fixture carries no rows, one small line each, under 300 KB, and does not grow with history", async () => {
  const small = await ownerShaped(30);
  expect(small.roster.status).toBe(200);
  const body = small.roster.body;
  const seededBots = body.bots.filter((bot: any) => bot.name.startsWith("Roster"));
  const seededRooms = body.groups.filter((group: any) => group.name.startsWith("Room"));
  expect(seededBots).toHaveLength(BOTS);
  expect(seededRooms).toHaveLength(ROOMS);
  for (const owner of [...body.bots, ...body.groups]) {
    for (const key of ["messages", "hasMore", "openCards", "openCardsLeaf", "openCardsPending", "olderFrom", "threadVersion"]) expect(owner, key).not.toHaveProperty(key);
  }
  for (const owner of [...seededBots, ...seededRooms]) {
    const line = owner.sidebarLine;
    expect(line).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(512);
    if (line.text) expect([...line.text].length).toBeLessThanOrEqual(SIDEBAR_TEXT_CHARS);
    expect(line).not.toHaveProperty("truncated");
    expect(JSON.stringify(line)).not.toMatch(/copyOf|errorDetails|"output"|turnId/);
  }
  // the bot line is the stored head; a heavy tool row is a line of its name and outcome
  const heavyBot = seededBots.find((bot: any) => bot.id === small.bots[0]!.id);
  expect(heavyBot.sidebarLine).toMatchObject({ messageId: rowId(heavyBot.threadId, 30), kind: "activity", tool: { name: "Bash", ok: true } });
  expect(heavyBot.activeLeafId).toBe(rowId(heavyBot.threadId, 30));
  for (const room of seededRooms) expect(room.messagesTotal).toBe(30);
  const textRoom = seededRooms.find((room: any) => room.sidebarLine.kind === "text");
  expect(textRoom.sidebarLine.from).toEqual({ botId: textRoom.threadId, name: "Writer", color: "amber" });
  // the record stays the listing's: a task window, the first lines of a long description, no playbooks
  for (const bot of seededBots) {
    expect(bot.tasks.length).toBeLessThanOrEqual(ROSTER_TASK_WINDOW + unreadKeep(ROSTER_TASK_WINDOW) + 1);
    expect(bot.playbooks).toBeUndefined();
    expect(bot.descriptionCut).toBe(true);
    expect([...bot.description].length).toBe(ROSTER_DESCRIPTION_CHARS);
  }
  const smallBytes = small.roster.text.length;
  console.info("view=sidebar roster bytes", smallBytes);
  expect(smallBytes).toBeLessThan(300_000);
  // opening a conversation is its first page: whole rows
  const page = await api("GET", `/api/threads/${heavyBot.threadId}/messages?view=switch&limit=100`, undefined, beside);
  const heavy = page.body.messages.find((m: any) => m.kind === "activity");
  expect(heavy.text.length).toBe(BIG);
  expect(heavy.tool.errorDetails.length).toBe(BIG);
  await fixture!.close(); fixture = undefined;

  // ten times the transcript: the body does not move with history (only row ids and counts change length)
  const large = await ownerShaped(300);
  console.info("view=sidebar roster bytes at 10x history", large.roster.text.length);
  expect(Math.abs(large.roster.text.length - smallBytes)).toBeLessThan(2_000);
}, 900_000);

it("test 2: a bot's line is its selected branch head, not its newest stored row; a room's line is its newest row", async () => {
  fixture = await launchVerificationServer({});
  await authHeaders();
  const model = await modelOf();
  const bot = (await api("POST", "/api/bots", { name: "Forked", modelSelection: { instanceId: "verification", model } })).body.bot;
  const room = (await api("POST", "/api/groups", { name: "Room", memberIds: [bot.id] })).body.group;
  await fixture.stop();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    // 1..10 in a chain; then a newer fork off 5 (11 to 13) is stored after them; the selected head stays at 10
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: rowId(bot.threadId, i + 1), at: AT + i + 1, role: i % 2 ? "bot" : "user", kind: "text", text: `main ${i + 1}`, parentId: i ? rowId(bot.threadId, i) : null }));
    rows.push(...[11, 12, 13].map((v) => ({ id: rowId(bot.threadId, v), at: AT + v, role: v % 2 ? "user" : "bot", kind: "text", text: `fork ${v}`, parentId: v === 11 ? rowId(bot.threadId, 5) : rowId(bot.threadId, v - 1) })));
    insertRows(db, bot.threadId, rows, rowId(bot.threadId, 10));
    seed(db, room.threadId, 7, false);
  } finally { db.close(); }
  await fixture.restart();
  await authHeaders();
  const body = (await api("GET", "/api/bots?view=sidebar", undefined, beside)).body;
  const entry = body.bots.find((candidate: any) => candidate.id === bot.id);
  expect(entry.sidebarLine).toMatchObject({ messageId: rowId(bot.threadId, 10), text: "main 10" });
  expect(entry.activeLeafId).toBe(rowId(bot.threadId, 10));
  const roomEntry = body.groups.find((candidate: any) => candidate.id === room.id);
  expect(roomEntry.sidebarLine.messageId).toBe(rowId(room.threadId, 7));
  // test 4: a branch move sends the new head's line on the thread frame
  const stream = await openSse(fixture.info.url + "/api/events", headers);
  try {
    await stream.until((frame) => frame.kind === "hello");
    expect((await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: rowId(bot.threadId, 13), threadId: bot.threadId })).status).toBe(200);
    const frame = await stream.until((candidate) => candidate.kind === "thread" && candidate.threadId === bot.threadId);
    expect(frame.activeLeafId).toBe(rowId(bot.threadId, 13));
    expect(frame.sidebarLine).toMatchObject({ messageId: rowId(bot.threadId, 13), text: "fork 13", role: "user" });
  } finally { await stream.close(); }
  expect((await api("GET", "/api/bots?view=sidebar")).body.bots.find((candidate: any) => candidate.id === bot.id).sidebarLine.messageId).toBe(rowId(bot.threadId, 13));
  // test 5: messagesTotal is the stored count
  expect(roomEntry.messagesTotal).toBe(7);
  // `view` wins over `messages`
  const both = (await api("GET", "/api/bots?view=sidebar&messages=5")).body;
  expect(both.bots.every((candidate: any) => !("messages" in candidate))).toBe(true);
}, 300_000);

it("test 3: ?messages=3, ?messages=1 and no parameter answer whole rows, widened to the branch head, hasMore only when rows remain", async () => {
  fixture = await launchVerificationServer({});
  await authHeaders();
  const model = await modelOf();
  const bot = (await api("POST", "/api/bots", { name: "Whole", modelSelection: { instanceId: "verification", model } })).body.bot;
  const short = (await api("POST", "/api/bots", { name: "Short", modelSelection: { instanceId: "verification", model } })).body.bot;
  await fixture.stop();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    // 60 long rows; row 20 is an open request card; the selected head is row 40 (a newer fork 41..60 grew past it)
    const rows: Row[] = [];
    for (let v = 1; v <= 60; v++) {
      const parentId = v === 1 ? null : v === 41 ? rowId(bot.threadId, 30) : rowId(bot.threadId, v - 1);
      rows.push(v === 20
        ? { id: rowId(bot.threadId, v), at: AT + v, role: "bot", kind: "options", card: { title: "Allow the deploy?", subtitle: "", options: ["Yes", "No"], requestId: "req-20" }, parentId }
        : { id: rowId(bot.threadId, v), at: AT + v, role: v % 2 ? "user" : "bot", kind: "text", text: `row ${v} `.padEnd(TEXT, "words "), parentId });
    }
    insertRows(db, bot.threadId, rows, rowId(bot.threadId, 40));
    seed(db, short.threadId, 30, false);
  } finally { db.close(); }
  await fixture.restart();
  await authHeaders();
  // the card index is an upgrade job over seeded history; the widening reads it
  await waitForMessageWalk(join(fixture.info.dataDir, "messages.db"));
  for (const query of ["?messages=3", "?messages=1", ""]) {
    for (const extra of [{}, beside]) {
      const response = await api("GET", `/api/bots${query}`, undefined, extra);
      expect(response.status).toBe(200);
      expect(response.text, query).not.toContain("\"truncated\"");
      const entry = response.body.bots.find((candidate: any) => candidate.id === bot.id);
      const ids = entry.messages.map((m: any) => m.id);
      // every seeded text row whole (the server may add a notice of its own at restart, about the settled card)
      for (const message of entry.messages) if (message.kind === "text" && message.id.startsWith(`${bot.threadId.slice(0, 8)}-`)) expect(message.text.length).toBe(TEXT);
      // widened back to the selected head
      expect(ids).toContain(rowId(bot.threadId, 40));
      expect(entry.activeLeafId).toBe(rowId(bot.threadId, 40));
      // A card seeded with a request id is settled at restart (its turn is gone), so it is not open here; the open-card widening of these
      // pages is unchanged code, covered by transcript-page.test.ts ("the old card inside its page" / "the card beside it").
      for (const message of entry.messages) if (message.card?.requestId === "req-20") expect(message.card.title).toBe("Allow the deploy?");
      expect(entry.hasMore).toBe(ids.length < 60 && !ids.includes(rowId(bot.threadId, 1)));
      const whole = response.body.bots.find((candidate: any) => candidate.id === short.id);
      const limit = query ? Number(query.split("=")[1]) : 100;
      // (the server's own greeting rows sit beside the 30 seeded ones)
      const seeded = whole.messages.filter((m: any) => m.id.startsWith(`${short.threadId.slice(0, 8)}-`));
      expect(whole.messages.length).toBeGreaterThanOrEqual(limit === 100 ? 30 : limit);
      if (!query) { expect(seeded).toHaveLength(30); expect(whole.hasMore).toBe(false); } else expect(whole.hasMore).toBe(true);
    }
  }
}, 300_000);

it("test 6: a script's grant and the companion see only the conversations they may, in view=sidebar too", async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN } });
  await authHeaders();
  const model = await modelOf();
  const mine = (await api("POST", "/api/bots", { name: "GrantedBot", modelSelection: { instanceId: "verification", model } })).body.bot;
  const other = (await api("POST", "/api/bots", { name: "OtherBotCanary", modelSelection: { instanceId: "verification", model } })).body.bot;
  const hiddenBot = (await api("POST", "/api/bots", { name: "HiddenBotCanary", modelSelection: { instanceId: "verification", model } })).body.bot;
  const room = (await api("POST", "/api/groups", { name: "RoomCanary", memberIds: [other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body.group;
  const quiet = (await api("POST", "/api/groups", { name: "QuietRoomCanary", memberIds: [other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body.group;
  await api("PATCH", `/api/bots/${hiddenBot.id}`, { hidden: true });
  await api("PATCH", `/api/groups/${quiet.id}`, { hidden: true });
  const grant = await api("POST", "/api/mcp-grants", { botId: mine.id });
  expect(grant.status, grant.text).toBe(201);
  const bare = { "x-test-bare-loopback": "1" };
  // without the desktop's proof: each caller is only who it says it is
  const as = async (extra: Record<string, string>) => {
    const response = await fetch(fixture!.info.url + "/api/bots?view=sidebar", { headers: extra });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text };
  };
  const asGrant = await as({ ...bare, authorization: `Bearer ${grant.body.token}` });
  expect(asGrant.status).toBe(200);
  expect(asGrant.body.bots.map((bot: any) => bot.id)).toEqual([mine.id]);
  expect(asGrant.body.groups).toEqual([]);
  for (const absent of ["OtherBotCanary", "RoomCanary", other.id, room.id]) expect(asGrant.text, absent).not.toContain(absent);
  const phone = { ...bare, "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };
  const asPhone = await as(phone);
  expect(asPhone.status).toBe(200);
  const phoneBots = asPhone.body.bots.map((bot: any) => bot.id), phoneRooms = asPhone.body.groups.map((group: any) => group.id);
  expect(phoneBots).toContain(mine.id);
  expect(phoneBots).not.toContain(hiddenBot.id);
  expect(phoneRooms).toContain(room.id);
  expect(phoneRooms).not.toContain(quiet.id);
  for (const owner of [...asPhone.body.bots, ...asPhone.body.groups]) expect(owner).not.toHaveProperty("messages");
  expect(asPhone.text).not.toContain("HiddenBotCanary");
  expect(asPhone.text).not.toContain("QuietRoomCanary");
}, 300_000);
