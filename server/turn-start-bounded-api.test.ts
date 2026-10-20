// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC1 (rc1-chat, rows 1 and 2): the first send to a 201,575-message thread
// loaded the whole transcript inside the POST (745 ms of SQL before
// `context.built`), and the reply waited behind the turn's 3.5 s setup block.
// On a real server with the fake engine:
//   - a send and its turn start read the same statements and the same rows
//     from a thread of 1,000 messages as from one of 200,000;
//   - the send is answered within its 1 s budget while the turn's setup is
//     held for 3 s, and the setup still runs (after the answer).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countControlSource, refillThread, sendCountCommand } from "./testing/bounded-reads.ts";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const ROUTINES = fileURLToPath(new URL("./routines.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./memory/worker-controller.ts", import.meta.url));
let fixture: VerificationServer, headers: Record<string, string> = {}, model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const signal = (command: object) => sendCountCommand(fixture.info.dataDir, command);
const dumpWall = (): number | null => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).promptWallMs ?? null; } catch { return null; } };
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

// Counts, in the server process, every statement bound to the watched thread
// id and the rows it returned; a count-control command starts a window or writes the counts.
// A marker file holds the turn's setup (RoutineManager.notePinnedBundle, which
// every direct turn's setup calls) for 3 s, the way a slow setup does.
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const sqlite=await import('node:sqlite');const {pathToFileURL}=await import('node:url');
  process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  const dir=process.env.MURAGE_DATA_DIR;let watched=null;let frozen=false;let counts={statements:0,rows:0,bySql:{}};
  const proto=sqlite.StatementSync.prototype;
  for(const name of ['all','get','iterate','run']){const original=proto[name];proto[name]=function(...args){const result=original.apply(this,args);
    if(watched!==null&&!frozen&&args.some(arg=>arg===watched||(arg&&typeof arg==='object'&&Object.values(arg).includes(watched)))){counts.statements++;
      const rows=name==='all'?result.length:name==='get'?(result?1:0):0;counts.rows+=rows;
      const key=String(this.sourceSQL).replace(/\\s+/g,' ').slice(0,160);const entry=counts.bySql[key]??={statements:0,rows:0};entry.statements++;entry.rows+=rows;}
    return result;};}
  ${countControlSource(`(command)=>{
    if(command.start){watched=command.start;frozen=false;counts={statements:0,rows:0,bySql:{}};fs.writeFileSync(path.join(dir,'window-open'),String(command.start));}
    else{fs.writeFileSync(path.join(dir,'counts.json'),JSON.stringify(counts));watched=null;}}`)}
  // The window ends where the turn hands its prompt to the engine (the turn hold's release), not at the dump signal: what the memory worker
  // publishes after that point (it waits for the hold) lands a variable moment later and is not the turn start's cost.
  const {MemoryWorkerController}=await import(pathToFileURL(${JSON.stringify(WORKER)}).href);
  const hold=MemoryWorkerController.prototype.holdForTurn;
  MemoryWorkerController.prototype.holdForTurn=function(...args){const release=hold.apply(this,args);return()=>{frozen=true;return release();};};
  const {RoutineManager}=await import(pathToFileURL(${JSON.stringify(ROUTINES)}).href);
  const note=RoutineManager.prototype.notePinnedBundle;
  RoutineManager.prototype.notePinnedBundle=function(...args){
    if(fs.existsSync(path.join(dir,'slow-setup')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);
    return note.apply(this,args);};
`;

// The fake engine gives every new bot a random greeting, and recall reads a thread's own sources when one shares a word with the prompt
// ("what", "we"): a greeting that happened to match made that thread's turn judge the hit, four more statements than a thread whose
// greeting did not, in about one run in three. The probe shares no word with any greeting, so the figures compare history size only.
const PROBE_TEXT = "Kestrel quorum ledger zxv";
const createBot = async (name: string) => (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };

/** Append `count` text rows to the thread's active branch, straight into messages.db (server stopped). */
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

/** The first send after a restart: the statements and rows bound to its thread from the POST to the engine's prompt. */
async function measuredSend(bot: { id: string; threadId: string }) {
  rmSync(fixture.fixtureDumpPath, { force: true });
  rmSync(file("counts.json"), { force: true });
  rmSync(file("window-open"), { force: true });
  signal({ start: bot.threadId });
  // the command can run after the POST when the loop is busy: post only once the server has opened the window
  await until(() => existsSync(file("window-open")), 15_000);
  const posted = await api("POST", `/api/bots/${bot.id}/messages`, { text: PROBE_TEXT, threadId: bot.threadId });
  expect(posted.status).toBe(202);
  await until(() => dumpWall() !== null, 30_000);
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")), 5_000);
  const counts = JSON.parse(readFileSync(file("counts.json"), "utf8")) as { statements: number; rows: number; bySql: Record<string, { statements: number; rows: number }> };
  const prompt = JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt);
  return { counts, prompt };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret }; };

it("a send and its turn start read the same statements and rows at 1,000 and at 200,000 thread messages", async () => {
  const warm = await createBot("Warm-up");
  const small = await createBot("Thousand");
  const large = await createBot("Two hundred thousand");
  await fixture.stop();
  seed(small.threadId, 1_000);
  seed(large.threadId, 200_000);
  await fixture.restart();
  await authHeaders();
  // the first turn after a start warms process-wide caches; it is not measured against either thread
  await measuredSend(warm);
  await new Promise((r) => setTimeout(r, 1_500));
  const a = await measuredSend(small);
  // the small bot's turn finishes before the large one is sent (one engine dump)
  await new Promise((r) => setTimeout(r, 1_500));
  const b = await measuredSend(large);
  expect(a.counts.statements).toBeGreaterThan(0);
  // per statement first, so a difference names the read that grew
  expect(b.counts.bySql).toEqual(a.counts.bySql);
  expect(b.counts).toEqual(a.counts);
  // the replay names no count it did not read
  expect(b.prompt).not.toMatch(/\d+ earlier lines of this conversation are not shown/);
}, 240_000);

it("the send is answered within its 1 s budget while the turn's setup is held for 3 s, and the setup still runs", async () => {
  const bot = await createBot("Slow setup");
  rmSync(fixture.fixtureDumpPath, { force: true });
  writeFileSync(file("slow-setup"), "1");
  try {
    const started = Date.now();
    const posted = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello", threadId: bot.threadId });
    const answeredMs = Date.now() - started;
    expect(posted.status).toBe(202);
    expect(posted.body.message?.text).toBe("hello");
    expect(answeredMs).toBeLessThan(1_000);
    // the held setup ran after the answer, and the turn reached the engine
    await until(() => dumpWall() !== null, 30_000);
    expect(dumpWall()! - started).toBeGreaterThanOrEqual(3_000);
  } finally { rmSync(file("slow-setup"), { force: true }); }
}, 60_000);
