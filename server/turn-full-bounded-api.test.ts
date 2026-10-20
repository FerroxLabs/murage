// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-turn work scales with the new work, never with the thread's history.
// On a real server with the fake engine, one whole turn (the send, the turn's
// setup, the prompt, the engine's reply and the settle) on a thread of 1,000
// messages and on one of 200,000:
//   - reads the same statements and the same rows bound to that thread (the
//     memory lineage judge's keyed reads, whose count follows its cache, within a bound);
//   - every one of those statements is an index search (no table scan);
//   - the thread is never loaded whole;
//   - a send that names an image bound by a row far older than any tail still
//     carries it (found by index), and an onboarding card far older than the
//     append tail is still dismissed by the owner's line (found by index).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const createBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };
// A 1x1 PNG: what the turn reads when the image is bound.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// The server names its attachments under the data folder's real path (config.ts DATA_DIR): on macOS the temp folder is reached
// through the /var -> /private/var link, and a path spelled through the link is not one of Murage's attachments.
const imagePath = (threadId: string) => join(realpathSync(fixture.info.dataDir), "attachments", `old-${threadId.replace(/[^A-Za-z0-9-]/g, "")}.png`);

/** `count` text rows on the thread's active branch, straight into messages.db
 * (server stopped). The row 500 from the end binds an image; the row 300 from
 * the end is an onboarding card nobody typed past. */
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
    const image = imagePath(threadId);
    const imageRow = `seed-${count - 499}`;
    const imageJson = { id: imageRow, at: 1700000000000 + count - 499, role: "user", kind: "text", text: `<attached-image path="${image}" />\nline ${count - 499}`, parentId: `seed-${count - 500}`, attachments: [{ kind: "image", path: image, mime: "image/png" }] };
    db.prepare("UPDATE messages SET text=?, json=? WHERE thread_id=? AND id=?").run(imageJson.text, JSON.stringify(imageJson), threadId, imageRow);
    const cardRow = `seed-${count - 300}`;
    const cardJson = { id: cardRow, at: 1700000000000 + count - 300, role: "bot", kind: "options", text: "Pick one to start", parentId: `seed-${count - 301}`, card: { title: "Pick one to start", options: [{ id: "a", label: "A" }] } };
    db.prepare("UPDATE messages SET kind='options', text=?, json=? WHERE thread_id=? AND id=?").run(cardJson.text, JSON.stringify(cardJson), threadId, cardRow);
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `seed-${count}`);
    refillThread(db, threadId);
  } finally { db.close(); }
  mkdirSync(join(fixture.info.dataDir, "attachments"), { recursive: true });
  writeFileSync(imagePath(threadId), PNG);
}

/** One whole turn: the statements and rows bound to its thread from the POST until the turn has settled. */
async function measuredTurn(bot: { id: string; threadId: string }, text: string) {
  rmSync(file("counts.json"), { force: true });
  rmSync(file("settled"), { force: true });
  rmSync(file("count-started"), { force: true });
  signal({ start: bot.threadId });
  // the window is open in the server before the send is made
  await until(() => existsSync(file("count-started")), 5_000);
  const posted = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(posted.status).toBe(202);
  await until(() => existsSync(file("settled")), 60_000);
  // the settle's own follow-ups (publication, notification) finish after the idle release
  await new Promise((r) => setTimeout(r, 1_500));
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")), 5_000);
  return { counts: JSON.parse(readFileSync(file("counts.json"), "utf8")) as Counts, message: posted.body.message as { attachments?: Array<{ path: string }> } };
}

const stored = (threadId: string, id: string) => {
  const db = new DatabaseSync(file("messages.db"), { readOnly: true });
  try { return JSON.parse((db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { json: string }).json); } finally { db.close(); }
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };

it("one whole turn reads the same statements and rows at 1,000 and at 200,000 thread messages, each by index", async () => {
  const warm = await createBot("Warm-up");
  const small = await createBot("Thousand");
  const large = await createBot("Two hundred thousand");
  await fixture.stop();
  seed(small.threadId, 1_000);
  seed(large.threadId, 200_000);
  await fixture.restart();
  await authHeaders();
  // the start-up index walk has filed the seeded history: its upserts follow its progress, not the thread, so they are not part of a turn
  await waitForMessageWalk(file("messages.db"));
  // the first turn after a start warms process-wide caches; it is not measured against either thread
  await measuredTurn(warm, "hello");
  const a = await measuredTurn(small, "what did we decide?");
  const b = await measuredTurn(large, "what did we decide?");
  expect(a.counts.statements).toBeGreaterThan(0);
  report("plain", a.counts, b.counts);
  expectBounded(a.counts, b.counts);
  // the onboarding card 300 rows back was dismissed by the owner's line, found by index
  expect(stored(small.threadId, "seed-700").card.dismissed).toBe(true);
  expect(stored(large.threadId, "seed-199700").card.dismissed).toBe(true);

  // a send that names an image bound 500 rows back still carries it (the thread was filled, with its images, before the turn)
  const c = await measuredTurn(small, `<attached-image path="${imagePath(small.threadId)}" />\nwhat is in this one?`);
  const d = await measuredTurn(large, `<attached-image path="${imagePath(large.threadId)}" />\nwhat is in this one?`);
  expect(c.message.attachments?.map((item) => item.path)).toEqual([imagePath(small.threadId)]);
  expect(d.message.attachments?.map((item) => item.path)).toEqual([imagePath(large.threadId)]);
  report("image", c.counts, d.counts);
  expectBounded(c.counts, d.counts);
}, 300_000);
