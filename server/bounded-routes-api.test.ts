// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The card, setup-question, edit and image routes read by key or index, never
// the conversation (sibling of turn-full-bounded-api): on a real server with
// the fake engine, each route reads the same statements and rows, every one an
// index search, on a thread of 2,000 messages and on one of 200,000, and
// neither is ever loaded whole.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { countingInstrumentation, expectBounded, report, type Counts, sendCountCommand } from "./testing/bounded-reads.ts";
import { refillThread } from "./testing/bounded-reads.ts";

const STORE = fileURLToPath(new URL("./store.ts", import.meta.url));
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text, type: response.headers.get("content-type") ?? "" };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const signal = (command: object) => sendCountCommand(fixture.info.dataDir, command);
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };
const createBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** `count` rows on the thread's active branch (server stopped). From the end: a screen frame 50
 * back, a plain card 200 back, an intake narrow card 300 back after its answered open card, a
 * user line 101 back that an edit replaces. */
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
    const put = (offset: number, kind: string, extra: Record<string, unknown>) => {
      const id = `seed-${count - offset}`;
      const json = { id, at: 1700000000000 + count - offset, role: "bot", kind, parentId: `seed-${count - offset - 1}`, ...extra };
      db.prepare("UPDATE messages SET role='bot', kind=?, text=?, json=? WHERE thread_id=? AND id=?").run(kind, (extra.text as string | undefined) ?? null, JSON.stringify(json), threadId, id);
      return id;
    };
    put(50, "screen", { png: PNG, mime: "image/png" });
    put(200, "options", { text: "Plain", card: { title: "Plain", options: [{ id: "a", label: "A" }] } });
    put(310, "options", { text: "Open", card: { title: "What do you want me for?", options: [], intake: { step: "open", asked: 1 }, answered: "a bakery" } });
    put(300, "options", { text: "Narrow", card: { title: "One real thing", options: [], intake: { step: "narrow", asked: 1 } } });
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(threadId, `seed-${count}`);
    refillThread(db, threadId);
  } finally { db.close(); }
}

/** One route call: the statements and rows bound to the thread from the request until it has
 * settled (a turn's end for the edit, a short wait for the others). */
async function measured(bot: { id: string; threadId: string }, call: () => Promise<void>, settle: "idle" | "delay") {
  for (const name of ["counts.json", "settled", "count-started"]) rmSync(file(name), { force: true });
  signal({ start: bot.threadId });
  await until(() => existsSync(file("count-started")), 5_000);
  await call();
  if (settle === "idle") await until(() => existsSync(file("settled")), 60_000);
  await new Promise((r) => setTimeout(r, 1_500));
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")), 5_000);
  return JSON.parse(readFileSync(file("counts.json"), "utf8")) as Counts;
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: countingInstrumentation(STORE) });
  await authHeaders();
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

const routes = (count: number) => ({
  card: { id: `seed-${count - 200}` },
  narrow: { id: `seed-${count - 300}` },
  screen: { id: `seed-${count - 50}` },
  edit: { id: `seed-${count - 101}` },
});

it("the card, intake, edit and image routes read the same statements and rows at 2,000 and at 200,000 thread messages, each by index", async () => {
  const warm = await createBot("Warm-up");
  const small = await createBot("Thousand");
  const large = await createBot("Two hundred thousand");
  await fixture.stop();
  seed(warm.threadId, 2_000);
  seed(small.threadId, 2_000);
  seed(large.threadId, 200_000);
  await fixture.restart();
  await authHeaders();

  const steps: Array<{ name: string; settle: "idle" | "delay"; call: (bot: { id: string; threadId: string }, count: number) => Promise<void> }> = [
    { name: "card", settle: "delay", call: async (bot, count) => {
      const r = await api("PATCH", `/api/bots/${bot.id}/cards/${routes(count).card.id}`, { dismissed: true });
      expect(r.status).toBe(200);
    } },
    { name: "image", settle: "delay", call: async (bot, count) => {
      const r = await api("GET", `/api/threads/${bot.threadId}/messages/${routes(count).screen.id}/image`);
      expect(r.status).toBe(200);
    } },
    { name: "intake", settle: "delay", call: async (bot, count) => {
      const r = await api("POST", `/api/bots/${bot.id}/intake`, { messageId: routes(count).narrow.id, text: "I sell cakes" });
      expect([200, 202]).toContain(r.status);
    } },
    { name: "edit", settle: "idle", call: async (bot, count) => {
      const r = await api("POST", `/api/bots/${bot.id}/messages/${routes(count).edit.id}/edit`, { text: "what did we decide, then?", threadId: bot.threadId });
      expect(r.status).toBe(202);
    } },
  ];
  // the first calls warm process-wide caches; they are not measured against either thread
  for (const step of steps) await measured(warm, () => step.call(warm, 2_000), step.settle);
  for (const step of steps) {
    const a = await measured(small, () => step.call(small, 2_000), step.settle);
    const b = await measured(large, () => step.call(large, 200_000), step.settle);
    expect(a.statements).toBeGreaterThan(0);
    report(step.name, a, b);
    // an edit sets aside what was learned from words that left the branch: tables of one row per signal, not per message
    expectBounded(a, b, step.name === "edit", step.name === "edit");
  }
}, 600_000);
