// 1.0.20 STOP-PREP (customer-visible hang, Stop family of Sean's demo): the owner sends while a turn is still in dispatch preparation
// (the words wait behind it), then presses Stop. The waiting words must never be lost silently, and the thread must answer the next
// send. On dev/1020q-late 1beb0da49e the stopped generation was retired by the guarded send's give-back, which released the run but
// left the generation's owed release cleanup pending, so the queue drain refused the thread for good: the waiting words never became a
// line and every later send waited behind them. Real server over HTTP, fake Claude CLI held in its MCP readiness wait (PREP_MS).
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { TURN_STOPPED_NOTE } from "./turn-outcome.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;
const PREP_MS = 4_000;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const chips = async (threadId: string) => (await messages(threadId)).filter((m) => m.kind === "activity" && m.tool?.name === TURN_STOPPED_NOTE);
const errorRows = async (threadId: string) => (await messages(threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("error:"));
const replies = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "bot" && m.kind === "text" && !m.murage && !m.murageLine && m.actorKind !== "murage");
const busy = async (bot: any) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId).busy === true;
const send = async (bot: any, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
const stop = async (bot: any) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, role: "Fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  return created.body.bot;
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
    const fs=await import('node:fs'),path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.verification.environment={...cfg.instances.verification.environment,FAKE_CLAUDE_MCP_READY_MS:JSON.stringify({agents:${PREP_MS}})};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const engines = (await api("GET", "/api/instances")).body.instances;
  model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 120_000);
afterAll(async () => { await fixture?.close(); });

const userLines = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "user").map((m) => String(m.text));

/** Send, let the turn reach dispatch preparation, send again (the words wait behind it), Stop, then check what the owner sees. */
const stopWithWordsQueued = async (name: string) => {
  const bot = await createBot(name);
  const first = `${name}: first words, stopped in preparation`;
  const queued = `${name}: words sent while the turn was preparing`;
  const next = `${name}: the next send after the Stop`;
  expect((await send(bot, first)).status).toBe(202);
  await expect.poll(() => busy(bot), { timeout: 10_000 }).toBe(true);
  await sleep(1_200);
  expect((await send(bot, queued)).status).toBe(202);
  expect((await stop(bot)).status).toBe(200);
  // (1) the waiting words are kept: they become the owner's line and the thread answers them, after the stopped turn ends
  await expect.poll(() => userLines(bot.threadId), { timeout: 45_000 }).toContain(queued);
  await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 45_000 }).toBeGreaterThan(0);
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  expect((await chips(bot.threadId)).length).toBeLessThanOrEqual(1);
  expect(await errorRows(bot.threadId)).toEqual([]);
  // (2) the thread is not stuck: the next send becomes a line and is answered
  const before = (await replies(bot.threadId)).length;
  expect((await send(bot, next)).status).toBe(202);
  await expect.poll(() => userLines(bot.threadId), { timeout: 45_000 }).toContain(next);
  await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 45_000 }).toBeGreaterThan(before);
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  expect(await errorRows(bot.threadId)).toEqual([]);
  // each of the owner's lines appears once
  const lines = await userLines(bot.threadId);
  for (const text of [first, queued, next]) expect(lines.filter((line) => line === text)).toHaveLength(1);
};

it("words queued behind a turn in dispatch preparation survive a Stop and run, and the next send answers", async () => {
  await stopWithWordsQueued("Stop prep queued");
}, 180_000);
