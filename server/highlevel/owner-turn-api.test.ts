// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HL-RO allow gate (1.0.17, designs/HL-RO-ALLOW-GATE-1104.md section 3), driven through the real server and startTurn with a
// fake engine that records whether integrations.highlevel was mounted. The HighLevel location is faked at the connection source
// only (no network); the grant goes through the real PUT route. The engine must mount the agents server (FAKE_ASK_TOOLS), or no
// turn could mount HighLevel and every negative row would pass for nothing: the positive row proves the mount on head and base.
// The queued-drain, ask-answer, card-continuation, held-continuation and edit-and-rerun rows fail on 4de80ecbf, whose deny-list
// gate mounted HighLevel on each; the manual routine row fails on bdb32ec95 (pre-gate).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HIGHLEVEL_READ_TOOL_NAMES } from "../../shared/highlevel.ts";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { HIGHLEVEL_CLOSED_LINE } from "./owner-turn.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const posixOnly = describe.skipIf(process.platform === "win32");
const CONNECTION = "hl_fixture1";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
let counter = 0;

const askDir = () => join(fixture.info.dataDir, "ask");
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const idle = async (id: string) => { await expect.poll(async () => (await botState(id))?.busy, { timeout: 30000 }).toBe(false); };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const arm = (name: string) => writeFileSync(join(askDir(), name), "");
const reset = () => { for (const name of ["hold", "live", "release", "agents-env.json", "no-tools"]) rmSync(join(askDir(), name), { force: true }); };
const live = async () => { await expect.poll(() => existsSync(join(askDir(), "live")), { timeout: 20000 }).toBe(true); };
const release = () => writeFileSync(join(askDir(), "release"), "");
/** Every turn the fake engine started on the thread, in order (steers excluded). */
const turns = (threadId: string): any[] => {
  try { return readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.threadId === threadId && !row.steer); } catch { return []; }
};
const allRows = (): any[] => {
  try { return readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => !row.steer); } catch { return []; }
};
const settleTurns = async (threadId: string, count: number) => { await expect.poll(() => turns(threadId).length, { timeout: 30000 }).toBe(count); };
/** The held turn's agents env (its comms token), once the engine has it live. */
const liveEnv = async () => {
  await live();
  await expect.poll(() => existsSync(join(askDir(), "agents-env.json")), { timeout: 20000 }).toBe(true);
  return JSON.parse(readFileSync(join(askDir(), "agents-env.json"), "utf8")) as Record<string, string>;
};
const internal = async (token: string, path: string, body: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
/** A fresh owner line whose held turn files a browser-setup card; the turn then ends. Returns the card's message id. */
const browserCard = async (bot: { id: string; threadId: string }, words: string) => {
  reset(); arm("hold");
  expect((await send(bot, words)).status).toBe(202);
  const env = await liveEnv();
  const card = await internal(env.MURAGE_COMMS_TOKEN!, "/api/internal/request-browser-connection", { reason: "Use the signed-in page" });
  expect(card.status).toBe(201);
  release();
  await idle(bot.id);
  await settleTurns(bot.threadId, 1);
  expect(turns(bot.threadId)[0].highlevel).toBe(true);
  return card.body.messageId as string;
};
const send = (bot: { id: string; threadId: string }, text: string) =>
  api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `hl-ro-${Date.now()}-${++counter}-padding` });
const grant = (botId: string) => api("PUT", `/api/highlevel/bots/${botId}/access`, { grants: [{ connectionId: CONNECTION, ceiling: "read", tools: [HIGHLEVEL_READ_TOOL_NAMES[0]] }] });
const grantedBot = async (name: string, instanceId = "queues") => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await grant(bot.id)).status).toBe(200);
  return bot;
};

posixOnly("HL-RO: HighLevel mounts only on the owner's own fresh line, through the real startTurn", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      const { PHONE_JOBS_ENGINES } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "phone-jobs-engines.ts")).href)});
      PHONE_JOBS_ENGINES.fakeAsk = { mounts: true, where: 'test fixture' };
      // a confirmed HighLevel location, at the connection source only: nothing here reaches the network
      const { PrivateTokenLeaseSource } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "highlevel", "private-token.ts")).href)});
      const view = { connectionId: ${JSON.stringify(CONNECTION)}, locationId: 'loc_fixture', companyId: 'co_fixture', epoch: 1, state: 'connected' };
      PrivateTokenLeaseSource.prototype.ownerView = function () { return { connectionId: view.connectionId, locationId: view.locationId, state: 'connected', confirmedAt: new Date().toISOString() }; };
      PrivateTokenLeaseSource.prototype.connection = async function (id) { return id === view.connectionId ? { ...view } : undefined; };
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.queues={driver:'fakeAsk',displayName:'Queues',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
      cfg.instances.switchable={driver:'fakeAsk',displayName:'Switchable',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'switch'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(askDir(), { recursive: true });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("a fresh desktop send at idle mounts HighLevel, and its primer has no closed line", async () => {
    const bot = await grantedBot("HL RO fresh");
    reset();
    expect((await send(bot, "fresh owner line")).status).toBe(202);
    await settleTurns(bot.threadId, 1);
    const [row] = turns(bot.threadId);
    expect(row.highlevel).toBe(true);
    expect(row.system).not.toContain(HIGHLEVEL_CLOSED_LINE);
    await idle(bot.id);
  }, 90000);

  it("a line queued behind a busy turn and drained later gets no HighLevel, and the bot is told how it opens", async () => {
    const bot = await grantedBot("HL RO queued");
    reset(); arm("hold");
    expect((await send(bot, "first, held")).status).toBe(202);
    await live();
    expect((await send(bot, "second, queued")).status).toBe(202);
    release();
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.role === "user").length, { timeout: 30000 }).toBe(2);
    await idle(bot.id);
    await settleTurns(bot.threadId, 2);
    const rows = turns(bot.threadId);
    expect(rows[0].highlevel).toBe(true);
    expect(rows[1].highlevel).toBeUndefined();
    expect(rows[1].system).toContain(HIGHLEVEL_CLOSED_LINE);
    reset();
  }, 120000);

  it("edit-and-rerun gets no HighLevel", async () => {
    const bot = await grantedBot("HL RO edit");
    reset();
    expect((await send(bot, "before the edit")).status).toBe(202);
    await settleTurns(bot.threadId, 1);
    await idle(bot.id);
    const source = (await messages(bot.threadId)).find((m) => m.role === "user" && m.kind === "text");
    expect(source).toBeTruthy();
    const edited = await api("POST", `/api/bots/${bot.id}/messages/${source.id}/edit`, { text: "after the edit", sendId: `hl-ro-edit-${Date.now()}-padding-padding` });
    expect(edited.status).toBe(202);
    // the rerun may run on a forked thread: find it by its words
    const rerun = () => allRows().filter((row) => String(row.text ?? "").includes("after the edit"));
    await expect.poll(() => rerun().length, { timeout: 30000 }).toBe(1);
    expect(turns(bot.threadId)[0].highlevel).toBe(true);
    expect(rerun()[0].highlevel).toBeUndefined();
    await idle(bot.id);
  }, 90000);

  it("an ask-card answer gets no HighLevel", async () => {
    const bot = await grantedBot("HL RO answer");
    reset(); arm("hold");
    expect((await send(bot, "ask me first")).status).toBe(202);
    const env = await liveEnv();
    const asked = await internal(env.MURAGE_COMMS_TOKEN!, "/api/internal/ask-user", { questions: [{ question: "Which channel?", options: [{ label: "Email" }, { label: "Slack" }], multiSelect: true }] });
    expect(asked.status).toBe(201);
    const card = (await messages(bot.threadId)).find((m) => m.id === asked.body.messageId);
    release();
    await idle(bot.id);
    await settleTurns(bot.threadId, 1);
    expect(turns(bot.threadId)[0].highlevel).toBe(true);
    const answered = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "answer", answers: [{ id: "q1", selected: ["Email"] }] });
    expect(answered.status).toBe(200);
    await settleTurns(bot.threadId, 2);
    expect(turns(bot.threadId)[1].highlevel).toBeUndefined();
    await idle(bot.id);
  }, 90000);

  it("a direct-thread card continuation (browser setup declined) gets no HighLevel", async () => {
    const bot = await grantedBot("HL RO card");
    const messageId = await browserCard(bot, "card owner line");
    expect((await api("POST", `/api/threads/${bot.threadId}/browser-setup/${messageId}`, { action: "decline" })).status).toBe(200);
    await settleTurns(bot.threadId, 2);
    const rows = turns(bot.threadId);
    expect(rows[1].text).toContain("declined optional browser connection");
    expect(rows[1].highlevel).toBeUndefined();
    await idle(bot.id);
  }, 90000);

  it("a held card continuation, carried on once the engine has tools again, gets no HighLevel", async () => {
    // the engine reports no tools for a while instead of the bot changing engines: an engine change ends the HighLevel grant
    // (its role binding), and the row would then pass for nothing
    const bot = await grantedBot("HL RO held", "switchable");
    const messageId = await browserCard(bot, "held owner line");
    arm("no-tools");
    // on a route with no tools the continuation is held, never dispatched (startTurnAdmitting copies its opts as JSON)
    expect((await api("POST", `/api/threads/${bot.threadId}/browser-setup/${messageId}`, { action: "decline" })).status).toBe(200);
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.threadId}/browser-setup/${messageId}`)).body.setup?.resumed, { timeout: 20000 }).toBe(true);
    await idle(bot.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(turns(bot.threadId)).toHaveLength(1);
    // tools again; saving the same grant changes the bot, which walks its held items: the held drain starts it with
    // cardContinuation and heldContinuationId
    rmSync(join(askDir(), "no-tools"), { force: true });
    expect((await grant(bot.id)).status).toBe(200);
    await settleTurns(bot.threadId, 2);
    const rows = turns(bot.threadId);
    expect(rows[1].text).toContain("declined optional browser connection");
    expect(rows[1].highlevel).toBeUndefined();
    await idle(bot.id);
    // the grant still mounts: a fresh owner line on this bot gets HighLevel, so the row above was not vacuous
    expect((await send(bot, "fresh after the held one")).status).toBe(202);
    await settleTurns(bot.threadId, 3);
    expect(turns(bot.threadId)[2].highlevel).toBe(true);
    await idle(bot.id);
  }, 120000);

  it("a manual routine run gets no HighLevel (fails on bdb32ec95, before any gate)", async () => {
    const bot = await grantedBot("HL RO routine");
    reset();
    const created = await api("POST", "/api/routines", { name: "HL RO sweep", prompt: "HLRO manual routine words", botId: bot.id, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, permissionMode: "ask" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`)).status).toBe(201);
    const ran = () => allRows().filter((row) => String(row.text ?? "").includes("HLRO manual routine words"));
    await expect.poll(() => ran().length, { timeout: 30000 }).toBeGreaterThan(0);
    expect(ran()[0].highlevel).toBeUndefined();
    await idle(bot.id);
  }, 90000);
});
