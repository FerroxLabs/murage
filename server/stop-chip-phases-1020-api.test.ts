// 1.0.20 STOP-CHIP (ROOTCAUSE fuigos4-fable item C; JOINT RULING STOP-VS-REFUSAL): an owner Stop writes exactly one "Stopped by you"
// line in every phase of a direct turn (queued, dispatch preparation, running, settling), never two, never an error card, and the
// next send works. Drives the real server over HTTP with the isolated fake Claude CLI. The engine's own tool servers come up slowly
// here (FAKE_CLAUDE_MCP_READY_MS), so a turn sits in dispatch preparation (the driver's MCP gate, before the prompt is written)
// long enough for a Stop to land there: the window real Claude Sonnet showed under load (scenario s5).
import { existsSync, readFileSync, rmSync } from "node:fs";
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
const reachedEngine = (text: string) => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(text);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, role: "Fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  return created.body.bot;
};
/** The thread settles with exactly one stop line and no error card, and stays that way after every late event has had time to land. */
const expectOneStopTerminal = async (bot: any) => {
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  await expect.poll(async () => (await chips(bot.threadId)).length, { timeout: 10_000 }).toBe(1);
  await sleep(PREP_MS + 1_500); // a late rejection, close or terminal event of the stopped turn has landed by now
  expect((await chips(bot.threadId)).map((m) => m.tool.ok)).toEqual([true]);
  expect(await errorRows(bot.threadId)).toEqual([]);
};
const expectNextSendAnswers = async (bot: any, marker: string) => {
  const before = (await replies(bot.threadId)).length;
  expect((await send(bot, `next send after stop ${marker}`)).status).toBe(202);
  await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 45_000 }).toBeGreaterThan(before);
  await expect.poll(() => busy(bot), { timeout: 30_000 }).toBe(false);
  expect(await chips(bot.threadId)).toHaveLength(1);
  expect(await errorRows(bot.threadId)).toEqual([]);
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

it("dispatch preparation: a Stop before the prompt reached the engine leaves exactly one stop line, and the next send answers", async () => {
  const bot = await createBot("Stop chip prep");
  const text = "stop chip dispatch preparation request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, text)).status).toBe(202);
  await expect.poll(() => busy(bot), { timeout: 10_000 }).toBe(true);
  await sleep(1_200);
  // still preparing: the engine has not been given the owner's words
  expect(reachedEngine(text)).toBe(false);
  expect((await stop(bot)).status).toBe(200);
  await expectOneStopTerminal(bot);
  // the stopped words never ran
  expect(reachedEngine(text)).toBe(false);
  expect(await replies(bot.threadId)).toEqual([]);
  await expectNextSendAnswers(bot, "prep");
}, 150_000);

it("dispatch preparation: a second Stop on the same turn adds no second stop line", async () => {
  const bot = await createBot("Stop chip prep twice");
  const text = "stop chip double stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, text)).status).toBe(202);
  await expect.poll(() => busy(bot), { timeout: 10_000 }).toBe(true);
  await sleep(1_200);
  expect(reachedEngine(text)).toBe(false);
  const [first, second] = await Promise.all([stop(bot), stop(bot)]);
  expect(first.status).toBe(200);
  expect([200, 409]).toContain(second.status);
  await stop(bot);
  await expectOneStopTerminal(bot);
  await expectNextSendAnswers(bot, "prep twice");
}, 150_000);

it("dispatch preparation: a Stop pressed at once after the send (the turn is still being set up) leaves exactly one stop line", async () => {
  const bot = await createBot("Stop chip setup");
  const text = "stop chip immediate stop request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, text)).status).toBe(202);
  expect((await stop(bot)).status).toBe(200);
  await expectOneStopTerminal(bot);
  expect(reachedEngine(text)).toBe(false);
  await expectNextSendAnswers(bot, "setup");
}, 150_000);

it("queued: a Stop while a second send waits behind the turn leaves one stop line for the stopped turn, and the thread goes on", async () => {
  const bot = await createBot("Stop chip queued");
  const held = "__fixture_hold_authority__ stop chip queued first request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, held)).status).toBe(202);
  await expect.poll(() => reachedEngine(held), { timeout: 30_000 }).toBe(true);
  expect([200, 202]).toContain((await send(bot, "stop chip queued second request")).status);
  expect((await stop(bot)).status).toBe(200);
  await expect.poll(() => busy(bot), { timeout: 60_000 }).toBe(false);
  await expect.poll(async () => (await chips(bot.threadId)).length, { timeout: 10_000 }).toBe(1);
  await sleep(PREP_MS + 1_500);
  expect(await chips(bot.threadId)).toHaveLength(1);
  expect(await errorRows(bot.threadId)).toEqual([]);
  await expect.poll(() => busy(bot), { timeout: 60_000 }).toBe(false);
  await expectNextSendAnswers(bot, "queued");
}, 240_000);

it("running: a Stop on a turn the engine is working on leaves exactly one stop line", async () => {
  const bot = await createBot("Stop chip running");
  const text = "__fixture_hold_authority__ stop chip running request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, text)).status).toBe(202);
  await expect.poll(() => reachedEngine(text), { timeout: 30_000 }).toBe(true);
  expect((await stop(bot)).status).toBe(200);
  await expectOneStopTerminal(bot);
  await expectNextSendAnswers(bot, "running");
}, 150_000);

it("settling: Stops that race the stopped turn's own end leave exactly one stop line", async () => {
  const bot = await createBot("Stop chip settling");
  const text = "__fixture_hold_authority__ stop chip settling request";
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await send(bot, text)).status).toBe(202);
  await expect.poll(() => reachedEngine(text), { timeout: 30_000 }).toBe(true);
  const first = stop(bot);
  // while the first Stop's close is settling, and again once it has
  const racing = await Promise.all([first, stop(bot), sleep(50).then(() => stop(bot))]);
  expect(racing[0].status).toBe(200);
  await stop(bot);
  await expectOneStopTerminal(bot);
  await expectNextSendAnswers(bot, "settling");
}, 150_000);
