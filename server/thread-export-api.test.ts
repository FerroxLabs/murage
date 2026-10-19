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
//     Rows written straight into the file are also rows the background search
//     fill has not seen, so this measures the export while that fill runs, as
//     on the first start after an upgrade; a fill piece that read every text
//     row past its cursor once held the loop ~150-250 ms here on its own
//     (message-search-fill-scale.test.ts).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
// The server is told what to do through a control file it polls (no POSIX signal: Windows has no SIGUSR2). Each command carries a
// sequence number and is acknowledged once applied, so a reset has taken effect before the request it precedes is sent.
let seq = 0;
const signal = async (command: object) => {
  const mine = ++seq;
  writeFileSync(file("lag-control.json"), JSON.stringify({ ...command, seq: mine }));
  for (let i = 0; i < 400; i++) {
    try { if (JSON.parse(readFileSync(file("lag-ack.json"), "utf8")).seq === mine) return; } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the server never acknowledged command ${mine}`);
};
const lag = async (): Promise<number> => {
  await signal({ dump: true });
  const value = JSON.parse(readFileSync(file("lag.json"), "utf8"));
  rmSync(file("lag.json"));
  return value.max;
};

const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const {monitorEventLoopDelay}=await import('node:perf_hooks');
  const h=monitorEventLoopDelay({resolution:2});h.enable();
  const control=path.join(process.env.MURAGE_DATA_DIR,'lag-control.json'),ack=path.join(process.env.MURAGE_DATA_DIR,'lag-ack.json');let done=0;
  setInterval(()=>{let c;try{c=JSON.parse(fs.readFileSync(control,'utf8'));}catch{return;}
    if(!c||c.seq===done)return;done=c.seq;
    if(c.reset)h.reset();else fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'lag.json'),JSON.stringify({max:h.max/1e6}));
    fs.writeFileSync(ack,JSON.stringify({seq:c.seq}));},10).unref();
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

it("exports a 200,000-message thread in both formats unchanged, without holding the event loop", { tags: ["perf-budget"], timeout: 600_000 }, async () => {
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

  await signal({ reset: true });
  const asJson = await raw(`/api/threads/${bot.threadId}/export?format=json`);
  expect(asJson.status).toBe(200);
  const jsonBody = await asJson.text();
  const jsonLag = await lag();
  await signal({ reset: true });
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
});
