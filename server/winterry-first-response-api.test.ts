// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WINTERRY (1.0.22, customer report 2026-11-25): an engine that takes the turn and then shows no first sign of life (on Windows
// it sat on a prompt nobody could see) used to hold the conversation for the whole silence limit and end with the no activity
// line (a routine: its run limit, with nobody watching). The real server now stops a ROUTINE run's turn like that at the
// first-response limit (five minutes) and says why; an engine that is streaming, and an owner's own chat, are not on that clock.
//
// The real server runs against the fake pi CLI with the watchdog clock sped up 120 times (as room-turn-silence-api.test.ts).
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";
import { fixtureDisplayApi } from "./testing/display-fixture.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const SPEED = 120;
/** Real milliseconds for simulated minutes. */
const sim = (minutes: number) => minutes * 60_000 / SPEED;
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = fixtureDisplayApi(() => join(fixture.info.dataDir, "messages.db"), async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
});
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const stopLines = async (threadId: string) => (await messages(threadId))
  .map((message) => String(message.tool?.name ?? ""))
  .filter((name) => /no activity|no first response|inactive thread|exceeded/.test(name));

beforeAll(async () => {
  chmodSync(join(serverDir, "testing/fake-codex-app-server.ts"), 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const fs=await import('node:fs');const path=await import('node:path');
    const SPEED=${SPEED};const t0=Date.now();
    const {TurnWatchdog}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "turn-watchdog.ts")).href)});
    TurnWatchdog.prototype.now=function(){return t0+(Date.now()-t0)*SPEED};
    const watch=TurnWatchdog.prototype.start;
    TurnWatchdog.prototype.start=function(){this.opts={...this.opts,checkMs:100};return watch.call(this)};
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    // MAIN-RULING WINTERRY-1022 (b): the engine says it hit a rate limit and will retry in ten minutes, then sends nothing more
    const retryScript=path.join(process.env.MURAGE_DATA_DIR,'retry-script.json');
    fs.writeFileSync(retryScript,JSON.stringify([{type:'agent_start'},{type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:10*60_000,errorMessage:'429 Too Many Requests: rate limit reached'}]));
    // R-PLAN-QUESTION-DROPPED: the engine's whole first output is a plan (a <todo> block pi turns into plan.updated alone), then it works on silently
    const planScript=path.join(process.env.MURAGE_DATA_DIR,'plan-script.json');
    fs.writeFileSync(planScript,JSON.stringify([{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},
      {type:'message_update',usage:{input:0,output:0},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'<todo>\\n- [ ] Read the inbox\\n- [ ] Write the report\\n</todo>'}}]));
    for(const [id,environment] of [
      ['engineRetry',{FAKE_PI_SCRIPT:retryScript}],
      ['enginePlan',{FAKE_PI_SCRIPT:planScript}],
      ['engineStream',{FAKE_PI_MODE:'stream',FAKE_PI_STREAM_EVERY_MS:'${sim(1)}',FAKE_PI_STREAM_FOR_MS:'${sim(12)}'}],
      ['engineSilent',{FAKE_PI_MODE:'hold'}],
    ])cfg.instances[id]={driver:'piAgent',displayName:id,config:{cli:${JSON.stringify(join(serverDir, "testing/fake-pi-cli.ts"))},fullAuto:true},environment};
    // QW Q3: Codex posts an async question (request_user_input_async) as the turn's whole output, then keeps working silently
    cfg.instances.engineAsks={driver:'codex',displayName:'engineAsks',config:{cli:${JSON.stringify(join(serverDir, "testing/fake-codex-app-server.ts"))},fullAuto:true},
      environment:{FAKE_CODEX_MODE:'async-question',FAKE_CODEX_ASYNC_QUESTION_ONLY:'1',FAKE_CODEX_ASYNC_QUESTION_GATE:path.join(process.env.MURAGE_DATA_DIR,'asks.never')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

async function botOn(name: string, instanceId: string, model = "ollama-cloud/glm-5.2") {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot as { id: string; threadId: string };
}
/** Every thread the server knows for this bot's work: its own, its rooms', and the ones its routine runs name. */
async function threadIds(): Promise<string[]> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) { if (key === "threadId" && typeof item === "string") found.add(item); else walk(item); }
  };
  walk((await api("GET", "/api/bots?messages=0")).body);
  walk((await api("GET", "/api/routines")).body);
  return [...found];
}
const allStopLines = async () => (await Promise.all((await threadIds()).map((threadId) => stopLines(threadId)))).flat();
const botBusy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === botId)?.busy;
/** The stop lines the server stored for this bot's work, read from the database: its routine runs' threads and its own thread
 * (a direct turn's line), and any line it speaks in a room (a room or project routine writes on the room's own task thread). */
const storedStopLines = async (bot: { id: string; threadId: string }) => {
  const threads = new Set([bot.threadId, ...((await api("GET", "/api/routines")).body.runs as any[]).filter((run) => run.botId === bot.id && run.threadId).map((run) => run.threadId as string)]);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT thread_id, json FROM messages WHERE kind='activity'").all() as Array<{ thread_id: string; json: string }>)
      .map((row) => ({ thread: row.thread_id, message: JSON.parse(row.json) as any }))
      .filter(({ thread, message }) => threads.has(thread) || message.from?.botId === bot.id)
      .map(({ message }) => String(message.tool?.name ?? ""))
      .filter((name) => /no activity|no first response|inactive thread|exceeded|stopped/.test(name));
  } finally { db.close(); }
};
const NO_FIRST_RESPONSE = "error: the engine gave no first response for 5 minutes";
const namedStops = async (bot: { id: string; threadId: string }) => (await storedStopLines(bot)).filter((line) => line.startsWith(NO_FIRST_RESPONSE)).length;
async function room(member: { id: string }, name: string) {
  const created = await api("POST", "/api/groups", { name, memberIds: [member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } });
  expect(created.status).toBe(201);
  return created.body.group as { id: string; threadId: string };
}
async function runRoutine(botId: string, name: string, target: Record<string, unknown> = {}) {
  const created = await api("POST", "/api/routines", { botId, name, prompt: "Write the morning report", schedule: { type: "once", at: Date.now() + 3_600_000 }, ...target });
  expect(created.status).toBeLessThan(300);
  const started = await api("POST", `/api/routines/${created.body.routine.id}/run`, {});
  expect(started.status).toBeLessThan(300);
}

it("a routine run whose engine never gives a first response is stopped at five minutes with the no first response line", async () => {
  const bot = await botOn("Morning routine", "engineSilent");
  const sentAt = Date.now();
  await runRoutine(bot.id, "Morning report");
  await expect.poll(allStopLines, { timeout: sim(12), interval: 100 }).toEqual([
    "error: the engine gave no first response for 5 minutes: the turn was stopped",
  ]);
  // five simulated minutes: not sooner, and long before the 60-minute silence limit
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(4));
  await expect.poll(() => botBusy(bot.id), { timeout: 20_000 }).toBe(false);
}, 60_000);

it("an owner's own chat on the same silent engine is not on the routine clock: no stop line after ten simulated minutes", async () => {
  const bot = await botOn("Owner chat", "engineSilent");
  const before = (await allStopLines()).length;
  const posted = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Say nothing", threadId: bot.threadId });
  expect(posted.status).toBeLessThan(300);
  await expect.poll(() => botBusy(bot.id), { timeout: 10_000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(await stopLines(bot.threadId)).toEqual([]);
  expect((await allStopLines()).length).toBe(before);
  expect(await botBusy(bot.id)).toBe(true);
}, 60_000);

it("a routine run whose engine is streaming is never stopped by the first-response limit: twelve simulated minutes finish", async () => {
  const bot = await botOn("Steady routine", "engineStream");
  const before = (await allStopLines()).length;
  await runRoutine(bot.id, "Long report");
  await expect.poll(async () => (await Promise.all((await threadIds()).map((threadId) => messages(threadId)))).flat().some((message) => String(message.text ?? "").includes("long reply done")), { timeout: sim(12) + 15_000, interval: 250 }).toBe(true);
  expect((await allStopLines()).length).toBe(before);
}, 60_000);

// MAIN-RULING WINTERRY-1022 (a): room routines get the same clock (Astra 2f0bf1f54b/2aec0899e4 H2).
it("a room routine whose engine never gives a first response is stopped at five minutes with the no first response line", async () => {
  const bot = await botOn("Room routine", "engineSilent");
  const group = await room(bot, "Morning room");
  const sentAt = Date.now();
  await runRoutine(bot.id, "Room report", { target: "room-goal", groupId: group.id });
  await expect.poll(() => namedStops(bot), { timeout: sim(12), interval: 100 }).toBe(1);
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(4));
}, 60_000);

it("an owner's own message in a room on the same silent engine is not on the routine clock: no stop line after ten simulated minutes", async () => {
  const bot = await botOn("Room owner chat", "engineSilent");
  const group = await room(bot, "Owner room");
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "Say nothing" })).status).toBe(202);
  await expect.poll(() => botBusy(bot.id), { timeout: 10_000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(await storedStopLines(bot)).toEqual([]);
}, 60_000);

// MAIN-RULING WINTERRY-1022 (b): a known rate-limit retry wait pauses the clock; it runs on once the wait is over.
it("a routine whose engine waits out a ten-minute rate-limit retry is not stopped during the wait, and is stopped once it stays silent after it", async () => {
  const bot = await botOn("Limited routine", "engineRetry");
  const sentAt = Date.now();
  await runRoutine(bot.id, "Limited report");
  await new Promise((resolve) => setTimeout(resolve, sim(12)));
  expect(await namedStops(bot)).toBe(0);
  await expect.poll(() => namedStops(bot), { timeout: sim(12), interval: 100 }).toBe(1);
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(14));
}, 60_000);

// R-PLAN-QUESTION-DROPPED (fable-r4 Astra High, carried): a plan is the engine's first response, not a lifecycle event.
it("a routine whose engine's first output is a plan alone is not stopped by the first-response limit", async () => {
  const bot = await botOn("Planning routine", "enginePlan");
  await runRoutine(bot.id, "Planned report");
  await expect.poll(() => botBusy(bot.id), { timeout: 10_000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(await storedStopLines(bot)).toEqual([]);
  // still working at the end of the wait: not stopped, not ended by anything else either
  expect(await botBusy(bot.id)).toBe(true);
}, 60_000);

// R-PLAN-QUESTION-DROPPED, the question half (MAIN q1022-winproof r4): Codex's async question is its first response.
it("a routine whose engine's first output is an async question alone is not stopped by the first-response limit", async () => {
  const bot = await botOn("Asking routine", "engineAsks", "gpt-fake-default");
  await runRoutine(bot.id, "Asked report");
  await expect.poll(() => botBusy(bot.id), { timeout: 15_000 }).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(await storedStopLines(bot)).toEqual([]);
  expect(await botBusy(bot.id)).toBe(true);
}, 60_000);
