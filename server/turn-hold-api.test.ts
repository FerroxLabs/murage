// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC1 full run (RC1-FULL-TURN rows 1 and 2): the memory worker's turn hold was
// taken only once the turn had its slot, and released before the engine was
// started, so background SQL ran in the turn's setup and while the engine
// started (rpc.initialize 646-987 ms instead of about 100). On a real server
// with memory on and the worker kept busy with background work, a turn on a
// fake ACP engine: no background statement runs from the turn's acceptance to
// its prompt, the hold ends at the prompt, and rpc.initialize stays under
// 150 ms. Background work runs before and after, so the probe is live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const FAKE_ACP = join(SERVER, "testing", "fake-acp-cli.ts");
let fixture: VerificationServer, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const file = (name: string) => join(fixture.info.dataDir, name);
const lines = (name: string) => { try { return readFileSync(file(name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

// In the server: every statement run as memory background work (an io-budget
// source starting "memory-") is logged with its time, the worker is woken every
// 20 ms, and its idle pass is always due and does one statement, so background
// work is queued the whole time. The turn hold's take and release are logged.
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const sqlite=await import('node:sqlite');const {pathToFileURL}=await import('node:url');
  process.env.MURAGE_TURN_TRACE='1';
  const dir=process.env.MURAGE_DATA_DIR;const server=${JSON.stringify(SERVER)};
  const append=(name,entry)=>fs.appendFileSync(path.join(dir,name),JSON.stringify({...entry,at:Date.now()})+String.fromCharCode(10));
  const {ioBudget}=await import(pathToFileURL(path.join(server,'io-budget.ts')).href);
  const proto=sqlite.StatementSync.prototype;
  for(const name of ['all','get','iterate','run']){const original=proto[name];proto[name]=function(...args){
    const source=ioBudget.currentSource();if(source&&source.startsWith('memory-'))append('background.jsonl',{source,sql:String(this.sourceSQL).slice(0,60)});
    return original.apply(this,args);};}
  const {MemoryWorkerController}=await import(pathToFileURL(path.join(server,'memory','worker-controller.ts')).href);
  const {database}=await import(pathToFileURL(path.join(server,'database.ts')).href);
  const hold=MemoryWorkerController.prototype.holdForTurn;
  MemoryWorkerController.prototype.holdForTurn=function(){append('hold.jsonl',{event:'taken'});const release=hold.call(this);let done=false;
    return ()=>{if(!done){done=true;append('hold.jsonl',{event:'released'});}return release();};};
  const start=MemoryWorkerController.prototype.start;
  MemoryWorkerController.prototype.start=function(){const controller=this;
    controller.options.onIdleConsolidation=async()=>{controller.nextConsolidationPoll=0;database().prepare("SELECT 'turn-hold-probe' AS probe").get();};
    setInterval(()=>controller.wake(),20).unref();
    return start.call(this);};
  const file=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  cfg.instances.grokfake={driver:'grokAgent',displayName:'Grok fixture',environment:{FAKE_ACP_MCP_CONNECT:'1',FAKE_ACP_MCP_TIMELINE:path.join(dir,'engine.jsonl')},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
  fs.writeFileSync(file,JSON.stringify(cfg));
`;

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBeLessThan(300);
}, 60_000);
afterAll(async () => { await fixture?.close(); });

it("from the turn's acceptance to its prompt no background work runs, and the engine starts at its own pace", { tags: ["perf-budget"], timeout: 120_000 }, async () => {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "grokfake");
  const bot = (await api("POST", "/api/bots", { name: "Held", modelSelection: { instanceId: "grokfake", model: instance.models.options[0]?.id ?? instance.models.default } })).body.bot;
  // the worker is doing background work before the send
  await until(() => lines("background.jsonl").some((entry) => entry.sql.includes("turn-hold-probe")), 20_000);
  const logFrom = readFileSync(fixture.info.logPath, "utf8").length;
  const posted = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello", threadId: bot.threadId });
  expect(posted.status).toBe(202);
  await until(() => lines("engine.jsonl").some((entry) => entry.event === "prompt"), 30_000);
  const prompt = lines("engine.jsonl").find((entry) => entry.event === "prompt")!.at as number;
  await until(() => lines("hold.jsonl").filter((entry) => entry.event === "released").length >= 1, 10_000);
  const holds = lines("hold.jsonl");
  const taken = holds.find((entry) => entry.event === "taken")!.at as number;
  const released = holds.find((entry) => entry.event === "released")!.at as number;
  // held to the prompt, not released when the engine was only being started
  expect(released).toBeGreaterThanOrEqual(prompt - 50);
  // nothing of the background ran while the turn was held
  const during = lines("background.jsonl").filter((entry) => entry.at > taken && entry.at < released);
  expect(during).toEqual([]);
  // and it runs again once the turn has gone out
  await until(() => lines("background.jsonl").some((entry) => entry.at > released && entry.sql.includes("turn-hold-probe")), 20_000);
  // the engine's handshake is not held up by background SQL
  const trace = readFileSync(fixture.info.logPath, "utf8").slice(logFrom);
  const initialize = [...trace.matchAll(/phase=rpc\.initialize .*?ms=(\d+)/g)].map((match) => Number(match[1]));
  expect(initialize.length).toBeGreaterThan(0);
  expect(Math.max(...initialize)).toBeLessThan(150);
});
