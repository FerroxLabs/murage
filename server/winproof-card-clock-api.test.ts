// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WINTERRY (1.0.22), the card half of the five-minute no-first-response clock, on a real server:
// - MAIN-RULING WINTERRY-1022 (a): an ongoing project's routine runs as its card's own run, and that run is on the same clock as any
//   routine run (Astra/Opus 3bf7ba3e7d, Fable/Opus 5f9d58b2f0 H1);
// - MAIN q1022-winproof r4: the owner answering a card a routine run waits on carries the run on in a new turn, and that turn is the
//   owner's: never on the clock, even though the routine's run is still live on the thread (Fable/Opus 5f9d58b2f0 H2), in a room too
//   (Fable/Opus 76843fac2d H1: armRoomFirstResponseLimit's ownerContinuation, the owner's answer resumed as a room member turn).
//
// The fake ACP engine asks for an image through Murage's own generate_image tool (the paid image card a routine run waits on), and
// the turn that carries the run on after the answer shows nothing (FAKE_ACP_CONTINUATION_SILENT). The watchdog clock runs 120 times
// fast (as winterry-first-response-api.test.ts). Every outbound https request is refused.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const serverDir = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(serverDir, "testing", "fake-acp-cli.ts");
const SPEED = 120;
const sim = (minutes: number) => minutes * 60_000 / SPEED;
const bank = JSON.stringify([{ id: "c-openai", preset: "openai", label: "Fixture OpenAI", enabled: true, key: "sk-proj-FAKE_IMAGE_CLOCK", revision: "r1" }]);
let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const rows = <T,>(sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
const exec = (sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); db.prepare(sql).run(...args); } finally { db.close(); }
};
const NO_FIRST_RESPONSE = "error: the engine gave no first response for 5 minutes";
/** The named first-response stop lines stored on these threads. */
const namedStops = (threadIds: string[]) => rows<{ thread_id: string; json: string }>("SELECT thread_id, json FROM messages WHERE kind='activity'")
  .filter((row) => threadIds.includes(row.thread_id))
  .map((row) => String((JSON.parse(row.json) as any).tool?.name ?? ""))
  .filter((name) => name.startsWith(NO_FIRST_RESPONSE));
const botBusy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === botId)?.busy;

beforeAll(async () => {
  chmodSync(FAKE_ACP, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, env: { MURAGE_MODEL_PROVIDER_CONNECTIONS: bank } as Record<string, string>, instrumentationSource: `
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const fs=await import('node:fs');const path=await import('node:path');
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{ const url=String(input instanceof Request?input.url:input); if(url.startsWith('https://')) return Promise.reject(new Error('External network is refused in this fixture')); return originalFetch(input,init); };
    const SPEED=${SPEED};const t0=Date.now();
    const {TurnWatchdog}=await import(${JSON.stringify(pathToFileURL(join(serverDir, "turn-watchdog.ts")).href)});
    TurnWatchdog.prototype.now=function(){return t0+(Date.now()-t0)*SPEED};
    const watch=TurnWatchdog.prototype.start;
    TurnWatchdog.prototype.start=function(){this.opts={...this.opts,checkMs:100};return watch.call(this)};
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    // the routine's turn asks for an image and gives up on the tool after 1.5 s (three simulated minutes), so it ends with the card open
    cfg.instances.cardEngine={driver:'grokAgent',displayName:'Card engine',environment:{FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',FAKE_ACP_MODE:'project-image',FAKE_ACP_MCP_TIMEOUT_MS:'1500',FAKE_ACP_CONTINUATION_SILENT:'1'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
    // a room goal's lead asks for a key (request_credential) and pauses the goal on the owner; its resumed turn says nothing
    cfg.instances.keyEngine={driver:'grokAgent',displayName:'Key engine',environment:{FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',FAKE_ACP_MODE:'room-credential-goal'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
    // takes the turn and never sends anything
    cfg.instances.silentEngine={driver:'grokAgent',displayName:'Silent engine',environment:{FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',FAKE_ACP_MODE:'hang'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 70_000);
afterAll(async () => { await fixture?.close(); });

async function botOn(name: string, instanceId: string) {
  const engine = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: engine.models.options[0]?.id || engine.models.default || "fixture-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
async function runRoutine(body: Record<string, unknown>) {
  const created = await api("POST", "/api/routines", { prompt: "Make the morning picture", schedule: { type: "once", at: Date.now() + 3_600_000 }, timeoutMinutes: 60, ...body });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return started.body.run.id as string;
}
const runOf = async (runId: string) => ((await api("GET", "/api/routines")).body.runs as any[]).find((run) => run.id === runId);

it("the owner's answer to a card a routine run waits on carries the run on off the five-minute clock: no stop line after ten simulated minutes", async () => {
  const bot = await botOn("Picture routine", "cardEngine");
  const runId = await runRoutine({ name: "Morning picture", botId: bot.id });
  await expect.poll(async () => (await runOf(runId))?.threadId, { timeout: 20_000 }).toBeTruthy();
  const threadId = (await runOf(runId)).threadId as string;
  // the routine's own turn asked for the image and ended with the card still open: the run waits on the owner
  const shown = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[]).some((message) => message.card?.tool === "generate_image");
  await expect.poll(shown, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => { const run = await runOf(runId); return { turnEnded: run?.turnEnded, cards: run?.cardsOpen?.length, status: run?.status }; }, { timeout: 20_000 })
    .toEqual({ turnEnded: true, cards: 1, status: "needs-you" });
  await expect.poll(() => botBusy(bot.id), { timeout: 20_000 }).toBe(false);
  // the owner answers; the same run carries on in a new turn, which the engine takes and then says nothing
  const answered = await api("POST", `/api/threads/${threadId}/respond`, { requestId: (await runOf(runId)).cardsOpen[0], behavior: "deny" });
  expect(answered.status, JSON.stringify(answered.body)).toBeLessThan(300);
  await expect.poll(() => botBusy(bot.id), { timeout: 20_000 }).toBe(true);
  expect((await runOf(runId))?.status).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(namedStops([threadId, bot.threadId])).toEqual([]);
  // still the owner's turn at the end: not stopped by anything else either
  expect(await botBusy(bot.id)).toBe(true);
}, 90_000);

it("an ongoing project's routine run (its card's own run) whose engine never gives a first response is stopped at five minutes with the no first response line", async () => {
  const lead = await botOn("Desk lead", "silentEngine"), worker = await botOn("Desk worker", "silentEngine");
  const created = await api("POST", "/api/groups", { name: "Weekly desk", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
  expect(created.status).toBe(201);
  const room = created.body.group as { id: string; threadId: string };
  expect((await api("PATCH", `/api/groups/${room.id}`, { channelProject: { goal: "Weekly reports" } })).status).toBe(200);
  exec("DELETE FROM project_goals WHERE group_id=?", room.id);
  exec("UPDATE project_settings SET mode='ongoing' WHERE group_id=?", room.id);
  const sentAt = Date.now();
  await runRoutine({ name: "Weekly report", prompt: "Write the weekly report", target: "room-goal", groupId: room.id, botId: worker.id });
  // the routine queued its card's run (the routine's child) and that run is on the worker's desk
  await expect.poll(() => rows<{ state: string; outcome_note: string }>("SELECT state, outcome_note FROM room_requests WHERE group_id=? AND verb='routine'", room.id)[0], { timeout: 30_000 })
    .toMatchObject({ state: "done", outcome_note: "card run queued" });
  await expect.poll(() => rows<{ state: string }>("SELECT r.state FROM room_requests r JOIN room_requests p ON p.id=r.parent_id WHERE r.group_id=? AND r.verb='assign' AND p.verb='routine'", room.id)[0]?.state, { timeout: 30_000 })
    .not.toBe("queued");
  const cardThreads = () => rows<{ target_thread_id: string }>("SELECT target_thread_id FROM room_requests WHERE group_id=? AND verb='assign'", room.id).map((row) => row.target_thread_id);
  await expect.poll(() => namedStops([room.threadId, ...cardThreads()]).length, { timeout: sim(12) + 10_000, interval: 100 }).toBe(1);
  // five simulated minutes: not sooner, and long before the 60-minute silence limit
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(4));
}, 90_000);

// MAIN-RULING WINTERRY-1022 (a), the goal half (Astra 5f9d58b2f0): a project with a working goal hands its routine to the lead in the
// project's chat (a room member turn, armRoomFirstResponseLimit); a lead that never answers is stopped at five minutes too.
it("a goal-active project's routine whose lead never gives a first response is stopped at five minutes with the no first response line", async () => {
  const lead = await botOn("Goal lead", "silentEngine"), worker = await botOn("Goal worker", "silentEngine");
  const created = await api("POST", "/api/groups", { name: "Goal desk", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
  expect(created.status).toBe(201);
  const room = created.body.group as { id: string; threadId: string };
  expect((await api("PATCH", `/api/groups/${room.id}`, { channelProject: { goal: "Ship the desk" } })).status).toBe(200);
  exec("DELETE FROM project_goals WHERE group_id=?", room.id);
  exec("INSERT INTO project_goals (id, group_id, title, criteria, state, created_at, started_at) VALUES (?, ?, 'Ship', ?, 'working', 1, 1)", `goal-${room.id}`, room.id,
    JSON.stringify([{ id: "k1", text: "It ships", setBy: "owner", proposed: false, met: false }]));
  const sentAt = Date.now();
  await runRoutine({ name: "Goal report", prompt: "Write the goal report", target: "room-goal", groupId: room.id, botId: worker.id });
  // the routine went to the lead (the goal's), not to a card
  await expect.poll(() => rows<{ to_bot_id: string; work_item_id: string | null }>("SELECT to_bot_id, work_item_id FROM room_requests WHERE group_id=? AND verb='routine'", room.id)[0], { timeout: 30_000 })
    .toEqual({ to_bot_id: lead.id, work_item_id: null });
  const threads = () => [...new Set([room.threadId, ...rows<{ target_thread_id: string }>("SELECT target_thread_id FROM room_requests WHERE group_id=?", room.id).map((row) => row.target_thread_id)])];
  await expect.poll(() => namedStops(threads()).length, { timeout: sim(12) + 10_000, interval: 100 }).toBe(1);
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(sim(4));
}, 90_000);

// Fable/Opus 76843fac2d H1, the room half of MAIN q1022-winproof r4: a room goal routine's run pauses on the owner (needs-input) and
// stays live on the room thread, so a room member turn the owner's answer resumes carries that run's provenance (memberTurnAutomation).
// It is the owner's turn all the same: never on the five-minute clock (armRoomFirstResponseLimit ownerContinuation, index.ts room call).
it("the owner's answer to a key card a room goal routine waits on resumes the room turn off the five-minute clock: no stop line after ten simulated minutes", async () => {
  const lead = await botOn("Key lead", "keyEngine"), worker = await botOn("Key worker", "silentEngine");
  const created = await api("POST", "/api/groups", { name: "Key room", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
  expect(created.status).toBe(201);
  const room = created.body.group as { id: string; threadId: string };
  const runId = await runRoutine({ name: "Room key", prompt: "Set up the box", target: "room-goal", groupId: room.id, botId: lead.id });
  // the lead asked for the key in the room and paused the goal on the owner: the routine's run is live (waiting) on the goal's room thread
  await expect.poll(async () => (await runOf(runId))?.status, { timeout: 30_000 }).toBe("waiting");
  const threadId = (await runOf(runId)).threadId as string;
  const cards = () => rows<{ id: string; json: string }>("SELECT id, json FROM messages WHERE thread_id=? AND kind='secret'", threadId);
  await expect.poll(() => cards().length, { timeout: 20_000 }).toBe(1);
  // a key card names its asker only in a room's thread (the request-credential route): this is the room path, not a direct turn
  expect((JSON.parse(cards()[0]!.json) as any).from?.botId).toBe(lead.id);
  await expect.poll(() => botBusy(lead.id), { timeout: 20_000 }).toBe(false);
  // the owner answers the key card: the lead's room turn resumes (the engine takes it and then says nothing)
  const answered = await api("POST", `/api/bots/${lead.id}/secret-cards/${cards()[0]!.id}/dismiss`, { threadId });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  await expect.poll(() => botBusy(lead.id), { timeout: 20_000 }).toBe(true);
  expect((await runOf(runId))?.status).toBe("waiting");
  await new Promise((resolve) => setTimeout(resolve, sim(10)));
  expect(namedStops([threadId, room.threadId, lead.threadId])).toEqual([]);
  // still the owner's turn at the end: not stopped by anything else either
  expect(await botBusy(lead.id)).toBe(true);
}, 90_000);
