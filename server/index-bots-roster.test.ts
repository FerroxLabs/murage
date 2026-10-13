// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/bots answers a bounded page when `messages` is absent: the response
// and the statements behind it cost the same with 1,000 messages in a thread
// as with 200,000, no thread is loaded whole, and no bot carries the
// server-only package import receipt.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { countingInstrumentation, expectBounded, refillThread, type Counts } from "./testing/bounded-reads.ts";

const STORE = fileURLToPath(new URL("./store.ts", import.meta.url));
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const signal = (command: object) => { writeFileSync(file("count-control.json"), JSON.stringify(command)); process.kill(fixture.info.pid, "SIGUSR2"); };
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
  // the same statements and rows, no thread read whole
  expectBounded(small.counts, large.counts);
}, 900_000);
