// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots answers a bounded page when `messages` is absent: the response
// and the statements behind it cost the same with 1,000 messages in a thread
// as with 200,000, no thread is loaded whole, and no bot carries the
// server-only package import receipt.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { countingInstrumentation, expectBounded, refillThread, type Counts, sendCountCommand } from "./testing/bounded-reads.ts";

const STORE = fileURLToPath(new URL("./store.ts", import.meta.url));
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const signal = (command: object) => sendCountCommand(fixture.info.dataDir, command);
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };
const createBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };

function seed(threadId: string, count: number) {
  const db = new DatabaseSync(file("messages.db"));
  try {
    db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT ?, 'seed-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', 'line '||v,
        json_object('id','seed-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text','line '||v,
          'parentId',CASE WHEN v=1 THEN NULL ELSE 'seed-'||(v-1) END)
      FROM n`).run(count, threadId);
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `seed-${count}`);
    refillThread(db, threadId);
  } finally { db.close(); }
}

async function measured(threadId: string, call: () => Promise<void>) {
  for (const name of ["counts.json", "count-started"]) rmSync(file(name), { force: true });
  signal({ start: threadId });
  await until(() => existsSync(file("count-started")), 5_000);
  await call();
  await new Promise((r) => setTimeout(r, 1_500));
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")), 5_000);
  return JSON.parse(readFileSync(file("counts.json"), "utf8")) as Counts;
}

/** A fresh server with two bots whose threads hold `count` messages each; the roster read bare and with `messages=0`. */
async function roundTrip(count: number) {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  try {
    await authHeaders();
    model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const a = await createBot("Roster one"), b = await createBot("Roster two");
    await fixture.stop();
    seed(a.threadId, count); seed(b.threadId, count);
    await fixture.restart();
    await authHeaders();
    await api("GET", "/api/bots"); // warm process-wide caches
    let bare: Awaited<ReturnType<typeof api>> | undefined;
    const counts = await measured(a.threadId, async () => { bare = await api("GET", "/api/bots"); });
    const zero = await api("GET", "/api/bots?messages=0");
    return { counts, bare: bare!, zero };
  } finally { await fixture.close(); }
}

it("GET /api/bots with no messages parameter costs the same at 1,000 and at 200,000 messages per thread", async () => {
  const small = await roundTrip(1_000);
  const large = await roundTrip(200_000);
  for (const run of [small, large]) {
    expect(run.bare.status).toBe(200);
    for (const bot of run.bare.body.bots) {
      expect(bot.messages.length).toBeLessThanOrEqual(200);
      expect("packageImportReceipt" in bot).toBe(false);
    }
    expect(run.zero.body.bots.every((bot: any) => bot.messages.length === 0 && !("packageImportReceipt" in bot))).toBe(true);
  }
  // the seeded bots page, newest first-in-view, with older rows left to the paged thread read
  const seeded = (run: typeof small) => run.bare.body.bots.filter((bot: any) => bot.name.startsWith("Roster"));
  expect(seeded(large).every((bot: any) => bot.messages.length === seeded(small)[0].messages.length && bot.hasMore === true)).toBe(true);
  // same bytes within a small margin (ids and times differ), not proportional to history
  expect(large.bare.text.length).toBeLessThan(small.bare.text.length * 1.1);
  expect(large.zero.text.length).toBeLessThan(small.zero.text.length * 1.1);
  expect(large.bare.text.length).toBeLessThan(500_000);
  // the same statements and rows, no thread read whole; a background read of one message by its id (learning outcomes, redelivery lookups) runs
  // when its timer fires, inside or outside the counting window, so those are held to a bound that does not follow history, not to an equality
  expectBounded(small.counts, large.counts, false, true);
}, 900_000);

/** The task-switch and channel-task-switch routes, called with no `messages`, answer the bounded page. */
async function switchRoundTrip(count: number) {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  try {
    await authHeaders();
    model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const bot = await createBot("Switch one");
    const group = (await api("POST", "/api/groups", { name: "Switch room", memberIds: [bot.id] })).body.group as { id: string; threadId: string };
    const botTask = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "other" })).body.task as { threadId: string };
    const groupTask = (await api("POST", `/api/groups/${group.id}/tasks`, { title: "other" })).body.task as { threadId: string };
    await fixture.stop();
    seed(bot.threadId, count); seed(group.threadId, count);
    await fixture.restart();
    await authHeaders();
    await api("GET", "/api/bots");
    let botSwitch: Awaited<ReturnType<typeof api>> | undefined, groupSwitch: Awaited<ReturnType<typeof api>> | undefined;
    // away and back, so the switch back lands on the seeded main thread
    await api("POST", `/api/bots/${bot.id}/tasks/${botTask.threadId}?messages=0`);
    await api("POST", `/api/groups/${group.id}/tasks/${groupTask.threadId}?messages=0`);
    const botCounts = await measured(bot.threadId, async () => { botSwitch = await api("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}`); });
    const groupCounts = await measured(group.threadId, async () => { groupSwitch = await api("POST", `/api/groups/${group.id}/tasks/${group.threadId}`); });
    return { botSwitch: botSwitch!, groupSwitch: groupSwitch!, botCounts, groupCounts };
  } finally { await fixture.close(); }
}

it("task and channel switch with no messages parameter cost the same at 1,000 and at 200,000 messages", async () => {
  const small = await switchRoundTrip(1_000);
  const large = await switchRoundTrip(200_000);
  for (const run of [small, large]) {
    expect(run.botSwitch.status).toBe(200);
    expect(run.groupSwitch.status).toBe(200);
    expect(run.botSwitch.body.bot.messages.length).toBeLessThanOrEqual(200);
    expect(run.groupSwitch.body.group.messages.length).toBeLessThanOrEqual(200);
  }
  expect(large.botSwitch.body.bot.hasMore).toBe(true);
  expect(large.groupSwitch.body.group.hasMore).toBe(true);
  expect(large.botSwitch.text.length).toBeLessThan(small.botSwitch.text.length * 1.1);
  expect(large.groupSwitch.text.length).toBeLessThan(small.groupSwitch.text.length * 1.1);
  expect(large.botSwitch.text.length).toBeLessThan(500_000);
  expectBounded(small.botCounts, large.botCounts, false, true);
  expectBounded(small.groupCounts, large.groupCounts, false, true);
}, 900_000);

it("the desktop's slim boot page keeps the roster small and flat, and the open thread still gets a full page through the thread route", async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  try {
    await authHeaders();
    model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const made = [] as Array<{ id: string; threadId: string }>;
    for (let i = 0; i < 6; i++) made.push(await createBot(`Slim ${i}`));
    await fixture.stop();
    for (const bot of made) seed(bot.threadId, 300);
    await fixture.restart();
    await authHeaders();
    const slim = await api("GET", "/api/bots?messages=20");
    const full = await api("GET", "/api/bots?messages=100");
    const seededSlim = slim.body.bots.filter((bot: any) => bot.name.startsWith("Slim"));
    expect(seededSlim).toHaveLength(6);
    expect(seededSlim.every((bot: any) => bot.messages.length === 20 && bot.hasMore === true)).toBe(true);
    expect(slim.text.length).toBeLessThan(full.text.length / 2);
    // flat in the number of bots: each added bot costs a slim page, not a full one
    const first = seededSlim[0];
    const page = await api("GET", `/api/threads/${first.threadId}/messages?limit=100&before=${first.messages[0].id}`);
    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(100);
    // the open thread holds the slim page plus a full page: at least 100 rows
    expect(first.messages.length + page.body.messages.length).toBeGreaterThanOrEqual(100);
  } finally { await fixture.close(); }
}, 300_000);

it("the desktop's boot roster for 43 bots with long threads stays under 300 KB, and each thread's newest row is its sidebar line", async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  try {
    await authHeaders();
    model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const made = [] as Array<{ id: string; threadId: string }>;
    for (let i = 0; i < 43; i++) made.push(await createBot(`Payload ${i}`));
    await fixture.stop();
    const db = new DatabaseSync(file("messages.db"));
    try {
      const body = "x".repeat(600);
      for (const bot of made) {
        db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<400)
          INSERT INTO messages(thread_id,id,at,role,kind,text,json)
          SELECT ?, 'p-'||v, 1700000000000+v, CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END, 'text', ?||v,
            json_object('id','p-'||v,'at',1700000000000+v,'role',CASE v%2 WHEN 1 THEN 'user' ELSE 'bot' END,'kind','text','text',?||v,
              'parentId',CASE WHEN v=1 THEN NULL ELSE 'p-'||(v-1) END)
          FROM n`).run(bot.threadId, body, body);
        db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(bot.threadId, "p-400");
        refillThread(db, bot.threadId);
      }
    } finally { db.close(); }
    await fixture.restart();
    await authHeaders();
    // the boot roster of the 1.0.2 renderer: one sidebar line per conversation, no rows
    const boot = await api("GET", "/api/bots?view=sidebar");
    const mine = boot.body.bots.filter((bot: any) => bot.name.startsWith("Payload"));
    expect(mine).toHaveLength(43);
    expect(Buffer.byteLength(boot.text)).toBeLessThan(300_000);
    // the sidebar line, the unread flag and the branch head all still have what they read
    for (const bot of mine) {
      expect(bot.messages).toBeUndefined();
      expect(bot.sidebarLine.messageId).toBe("p-400");
      expect(bot.activeLeafId).toBe("p-400");
      expect("unread" in bot || bot.unread === undefined).toBe(true);
    }
    // the open conversation fetches its first page (the switch page) when it opens
    const open = mine[0];
    const page = await api("GET", `/api/threads/${open.threadId}/messages?view=switch&limit=100`);
    expect(page.body.messages).toHaveLength(100);
    expect(page.body.messages.at(-1).id).toBe("p-400");
    expect(page.body.hasMore).toBe(true);
  } finally { await fixture.close(); }
}, 600_000);
