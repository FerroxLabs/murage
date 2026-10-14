// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A conversation export covers the whole visible branch, so it legitimately
// reads every row; it must not hold the event loop while it does. On a real
// server with a thread of 200,000 messages:
//   - both formats come back byte for byte what the one-shot export wrote
//     (checked against the same rows rendered the old way, in this test);
//   - the server's event loop is never held for long: the longest stall while
//     the export runs stays far under what one synchronous load of the thread
//     takes (a slice is 20 ms; the bound leaves room for GC and a busy host).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const file = (name: string) => join(fixture.info.dataDir, name);
const raw = async (path: string) => fetch(fixture.info.url + path, { headers });
const json = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const signal = (command: object) => { writeFileSync(file("lag-control.json"), JSON.stringify(command)); process.kill(fixture.info.pid, "SIGUSR2"); };
const lag = async (): Promise<number> => {
  signal({ dump: true });
  for (let i = 0; i < 200; i++) {
    try { const value = JSON.parse((await import("node:fs")).readFileSync(file("lag.json"), "utf8")); (await import("node:fs")).rmSync(file("lag.json")); return value.max; } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw new Error("no lag reading");
};

const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const {monitorEventLoopDelay}=await import('node:perf_hooks');
  const h=monitorEventLoopDelay({resolution:2});h.enable();
  process.on('SIGUSR2',()=>{const c=JSON.parse(fs.readFileSync(path.join(process.env.MURAGE_DATA_DIR,'lag-control.json'),'utf8'));
    if(c.reset){h.reset();return;}fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'lag.json'),JSON.stringify({max:h.max/1e6}));});
`;

const COUNT = 200_000;
type Row = Record<string, unknown>;
const rowFor = (v: number): Row => {
  const base = { id: `seed-${v}`, at: 1700000000000 + v, role: v % 2 ? "user" : "bot", parentId: v === 1 ? null : `seed-${v - 1}` };
  if (v % 20_000 === 0) return { ...base, role: "bot", kind: "activity", tool: { name: `Ran step ${v}`, ok: true } };
  if (v % 30_000 === 0) return { ...base, role: "bot", kind: "options", text: "Pick one", card: { title: `Pick ${v}`, options: [{ id: "a", label: "A" }], answered: "a" } };
  if (v % 50_000 === 0) return { ...base, role: "bot", kind: "screen", text: "frame", png: "AAAA", mime: "image/png" };
  return { ...base, kind: "text", text: `line ${v}\nsecond line "quoted" ${v}` };
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await json("GET", "/api/desktop-secret")).body.secret };
  model = (await json("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

it("exports a 200,000-message thread in both formats unchanged, without holding the event loop", async () => {
  const bot = (await json("POST", "/api/bots", { name: "Exporter", modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };
  await fixture.stop();
  const db = new DatabaseSync(file("messages.db"));
  const rows: Row[] = [];
  try {
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (let v = 1; v <= COUNT; v++) { const row = rowFor(v); rows.push(row); insert.run(bot.threadId, row.id as string, row.at as number, row.role as string, row.kind as string, (row.text as string | undefined) ?? null, JSON.stringify(row)); }
    db.exec("COMMIT");
    db.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id=excluded.active_leaf_id").run(bot.threadId, `seed-${COUNT}`);
  } finally { db.close(); }
  await fixture.restart();
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await json("GET", "/api/desktop-secret")).body.secret };

  signal({ reset: true });
  const asJson = await raw(`/api/threads/${bot.threadId}/export?format=json`);
  expect(asJson.status).toBe(200);
  const jsonBody = await asJson.text();
  const jsonLag = await lag();
  signal({ reset: true });
  const asMarkdown = await raw(`/api/threads/${bot.threadId}/export?format=markdown`);
  expect(asMarkdown.status).toBe(200);
  const markdownBody = await asMarkdown.text();
  const markdownLag = await lag();
  console.log("export event-loop stall, ms", { json: Math.round(jsonLag), markdown: Math.round(markdownLag) });

  // JSON: pixels stripped, one pretty-printed document, in conversation order
  const parsed = JSON.parse(jsonBody);
  expect(parsed.threadId).toBe(bot.threadId);
  expect(parsed.messages).toHaveLength(COUNT);
  expect(jsonBody).toBe(JSON.stringify({ name: parsed.name, threadId: bot.threadId, messages: rows.map(({ png: _png, mime: _mime, ...rest }) => rest).map((row) => JSON.parse(JSON.stringify(row))) }, null, 2));
  // markdown: as the one-shot export wrote it
  const lines: string[] = [`# ${parsed.name}`, ""];
  for (const row of rows) {
    const who = row.role === "user" ? "User" : "Exporter";
    if (row.kind === "text" && row.text) lines.push(`**${who}:**`, "", row.text as string, "");
    else if (row.kind === "activity") lines.push(`> ${(row.tool as { name: string }).name}`, "");
    else if (row.kind === "screen") lines.push("> [screen capture]", "");
    else if (row.kind === "options") lines.push(`> ${(row.card as { title: string }).title} (answered: ${(row.card as { answered: string }).answered})`, "");
  }
  expect(markdownBody).toBe(lines.join("\n"));
  // one synchronous load of this thread holds the loop for seconds; slices of 20 ms do not
  expect(jsonLag).toBeLessThan(200);
  expect(markdownLag).toBeLessThan(200);
}, 600_000);
