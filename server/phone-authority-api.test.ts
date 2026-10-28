// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S11 end to end through the real server and the in-process ask fixture engine: the phone authority is minted only
// for the owner's own fresh turn (the idle entry of admitDirectSend), is carried across a limit failover only when the first turn
// held it, and is never minted for a queued line, an unproven send, a room or a refused-steer re-entry. Whether a turn holds the
// authority is read from what the engine was handed: a turn that holds it gets the phone-jobs MCP mount (and no withheld note in its
// system prompt); a turn that does not gets neither. Every turn the fake engine starts is one row in its dump.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHONE_COPY } from "./phones/copy.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
// the suite already hands every fixture server this launch secret (testing/setup.ts), so it is the paired phone's credential here
const DOOR = "c".repeat(64);
const SCENARIOS = ["a1", "a1c", "a2", "a2b", "a5", "a6", "a7", "a8a", "a8b", "a9a", "a9b", "a9c", "a10"];
const TOOL_SCENARIOS = ["m1", "m2"];
const NOMOUNT_KIND = "fakeAskNoPhoneJobs";
let fixture: VerificationServer;
let headers: Record<string, string> = {};

const askDir = () => join(fixture.info.dataDir, "ask");
const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> | null = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(extra ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const connect = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
/** The door's phone envelope for one device (companion/src/phone-door.ts phoneForwardHeaders): the registration fixture registers through the real PUT route. */
const phoneEnvelope = (deviceId: string): Record<string, string> => ({ "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-device": deviceId, "x-murage-phone-scope": "jobs" });
const PHONE_DEVICE = "11111111-1111-4111-8111-111111111111";
const companion = { "x-test-bare-loopback": "1", "x-murage-companion": "1", "x-murage-companion-token": DOOR };
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const idle = async (id: string) => { await expect.poll(async () => (await botState(id))?.busy, { timeout: 30000 }).toBe(false); };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const arm = (name: string) => writeFileSync(join(askDir(), name), "");
const reset = () => { for (const name of ["hold", "live", "release", "limit", "refuse-steer", "refuse-steer-idle", "reply.txt"]) rmSync(join(askDir(), name), { force: true }); };
const live = async () => { await expect.poll(() => existsSync(join(askDir(), "live")), { timeout: 20000 }).toBe(true); };
const release = () => writeFileSync(join(askDir(), "release"), "");

/** Every turn the fake engine started on the thread, in order (steers excluded). A row with phoneJobs is a turn that held the authority. */
const turns = (threadId: string): any[] => {
  try { return readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.threadId === threadId && !row.steer); } catch { return []; }
};
const dumpRows = turns;
const minted = (threadId: string) => turns(threadId).filter((row) => row.phoneJobs !== undefined);
const snapshot = async (threadId: string) => JSON.stringify({
  lines: (await messages(threadId)).map((m) => `${m.role}/${m.kind}${m.steered ? "/steered" : ""}: ${String(m.text ?? m.tool?.name ?? m.card?.tool ?? "").slice(0, 60)}`),
  turns: turns(threadId).map((row) => ({ minted: row.phoneJobs !== undefined })),
});

let counter = 0;
const createBot = async (name: string, instanceId: string, grant = true) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  if (grant) expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: { calendar: "read" } })).status).toBe(200);
  return bot;
};
const send = (bot: { id: string; threadId: string }, text: string, extra: Record<string, string> | null = headers) =>
  api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `phone-s11-${Date.now()}-${++counter}-padding` }, extra);
const setBackup = async (bot: { id: string }, instanceId: string) => {
  const res = await api("PUT", `/api/bots/${bot.id}/limit-backup`, { selection: { instanceId, model: "ask-1" }, routines: false });
  expect(res.status).toBe(200);
};
const settleTurns = async (threadId: string, count: number) => { await expect.poll(() => turns(threadId).length, { timeout: 30000 }).toBe(count); };

posixOnly("phone authority wiring through the real server (S11)", () => {
  beforeAll(async () => {
    const names = JSON.stringify(SCENARIOS);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      BUILT_IN_DRIVERS.push(makeAskDriver(${JSON.stringify(NOMOUNT_KIND)}));
      // the fixture kinds join the S13b table the way a real engine does: one mounts phoneJobs, the other (like antigravity) has agentsMcp but does not
      const { PHONE_JOBS_ENGINES } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "phone-jobs-engines.ts")).href)});
      PHONE_JOBS_ENGINES.fakeAsk = { mounts: true, where: 'test fixture' };
      PHONE_JOBS_ENGINES[${JSON.stringify(NOMOUNT_KIND)}] = { mounts: false, why: 'test fixture' };
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      for (const name of ${names}) {
        cfg.instances['src-'+name]={driver:'fakeAsk',displayName:'Source '+name,environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
        cfg.instances['bk-'+name]={driver:'fakeAsk',displayName:'Backup '+name,environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
      }
      for (const name of ${JSON.stringify(TOOL_SCENARIOS)}) {
        cfg.instances['src-'+name]={driver:'fakeAsk',displayName:'Source '+name,environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
      }
      cfg.instances['src-nomount']={driver:${JSON.stringify(NOMOUNT_KIND)},displayName:'Source nomount',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
      cfg.instances.queues={driver:'fakeAsk',displayName:'Queues',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(askDir(), { recursive: true });
    await connect();
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
    // one registered phone that reports everything (the registration fixture the native twins read), registered through the real route
    const registration = JSON.parse(readFileSync(join(SERVER_DIR, "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8")).registration.valid;
    expect((await api("PUT", "/api/phones/self", registration, phoneEnvelope(PHONE_DEVICE))).status).toBe(200);
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("1: an idle owner desktop send mints once; a companion send from the paired phone mints too", async () => {
    const bot = await createBot("Phone s11 one", "src-a1");
    expect((await send(bot, "hello from the desktop")).status).toBe(202);
    await settleTurns(bot.threadId, 1);
    expect(minted(bot.threadId)).toHaveLength(1);
    await idle(bot.id);
    const phone = await createBot("Phone s11 companion", "src-a1c");
    expect((await send(phone, "hello from the phone", companion)).status).toBe(202);
    await settleTurns(phone.threadId, 1);
    expect(minted(phone.threadId)).toHaveLength(1);
    await idle(phone.id);
  }, 90000);

  it("1b: with the feature off the same idle send does not mint", async () => {
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    const bot = await createBot("Phone s11 off", "src-a1", false);
    expect((await send(bot, "hello with the feature off")).status).toBe(202);
    await settleTurns(bot.threadId, 1);
    expect(minted(bot.threadId)).toHaveLength(0);
    await idle(bot.id);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 90000);

  it("2: an owner send steered into a running turn does not mint; a fresh send after the turn ends does (D22)", async () => {
    const bot = await createBot("Phone s11 steer", "src-a2");
    reset(); arm("hold");
    expect((await send(bot, "first, held")).status).toBe(202);
    await live();
    expect(minted(bot.threadId)).toHaveLength(1);
    const heldToken = readEnv("phone-jobs-env.json").MURAGE_CONTROL_TOKEN;
    const steered = await send(bot, "second, steered");
    expect(steered.status).toBe(202);
    await quiet(500);
    // the steer went into the running turn: no new turn started, and the running turn still holds the one authority
    expect(turns(bot.threadId)).toHaveLength(1);
    expect(minted(bot.threadId)).toHaveLength(1);
    release(); await idle(bot.id);
    expect((await send(bot, "third, fresh")).status).toBe(202);
    await expect.poll(() => minted(bot.threadId).length, { timeout: 20000 }).toBe(2);
    expect(turns(bot.threadId)).toHaveLength(2);
    // a new generation: its device token is not the first turn's
    await expect.poll(() => readEnv("phone-jobs-env.json").MURAGE_CONTROL_TOKEN, { timeout: 10000 }).not.toBe(heldToken);
    await idle(bot.id);
  }, 120000);

  it("2b: a refused steer that returns to an idle bot runs the line through runIt() with no entry: no decision, no authority", async () => {
    const bot = await createBot("Phone s11 refused steer", "src-a2b");
    reset(); arm("hold");
    expect((await send(bot, "first, held")).status).toBe(202);
    await live();
    expect(minted(bot.threadId)).toHaveLength(1);
    arm("refuse-steer-idle");
    expect((await send(bot, "second, steer refused while the turn ends")).status).toBe(202);
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.role === "user" && m.text === "second, steer refused while the turn ends").length, { timeout: 30000 }).toBeGreaterThan(0);
    await idle(bot.id);
    await quiet(500);
    // the refused-steer re-entry started its own turn but is not the idle entry: nothing was minted for it
    expect(minted(bot.threadId)).toHaveLength(1);
    expect((await botState(bot.id)).busy).toBe(false);
    // S20: the bot is told too. The first turn held the authority (no withheld note); the re-entry turn has none, so it is told the phone is for direct asks only
    const rows = dumpRows(bot.threadId);
    expect(rows).toHaveLength(2);
    expect(rows[0].system).not.toContain(PHONE_COPY.withheld);
    expect(rows[1].system).toContain(PHONE_COPY.withheld);
  }, 120000);

  it("5: a line queued behind a busy turn and drained later does not mint", async () => {
    const bot = await createBot("Phone s11 queued", "queues");
    reset(); arm("hold");
    expect((await send(bot, "first, held")).status).toBe(202);
    await live();
    expect(minted(bot.threadId)).toHaveLength(1);
    expect((await send(bot, "second, queued")).status).toBe(202);
    release();
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.role === "user").length, { timeout: 30000 }).toBe(2);
    await idle(bot.id); await quiet(500);
    expect(minted(bot.threadId)).toHaveLength(1);
    // S20: the drained line has no authority, so its turn carries the withheld note and the held first turn does not
    const rows = dumpRows(bot.threadId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].system).not.toContain(PHONE_COPY.withheld);
    expect(rows[rows.length - 1].system).toContain(PHONE_COPY.withheld);
  }, 120000);

  it("6: an unproven send is decided ineligible and does not mint", async () => {
    const bot = await createBot("Phone s11 unproven", "src-a6");
    expect((await send(bot, "words nobody proved", null)).status).toBe(202);
    await settleTurns(bot.threadId, 1);
    expect(minted(bot.threadId)).toHaveLength(0);
    await idle(bot.id);
    // S20: an unproven send holds no authority, so the bot is told the phone is for direct asks only
    expect(dumpRows(bot.threadId).map((row) => row.system as string).every((system) => system.includes(PHONE_COPY.withheld))).toBe(true);
    expect(dumpRows(bot.threadId)).toHaveLength(1);
  }, 90000);

  it("7: a room thread never reaches the direct path, so it neither decides nor mints", async () => {
    const member = await createBot("Phone s11 room member", "src-a7");
    const other = await createBot("Phone s11 room other", "src-a7");
    const room = (await api("POST", "/api/groups", { name: "Phone s11 room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group as { id: string; threadId: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello room", sendId: `phone-s11-room-${Date.now()}-padding` })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).some((m) => m.role === "bot"), { timeout: 30000 }).toBe(true);
    await quiet(500);
    expect(minted(room.threadId)).toHaveLength(0);
  }, 90000);

  it("8: a failover of an authorised turn is minted again through the carry; a failover of a drained line is not", async () => {
    const held = await createBot("Phone s11 failover held", "src-a8a");
    await setBackup(held, "bk-a8a");
    reset(); arm("limit");
    expect((await send(held, "limit then failover")).status).toBe(202);
    await settleTurns(held.threadId, 2);
    // the source turn and the failover turn both hold the authority (the failover carries eligibility, never origin)
    expect(minted(held.threadId)).toHaveLength(2);
    await idle(held.id);

    const drained = await createBot("Phone s11 failover drained", "src-a8b");
    await setBackup(drained, "bk-a8b");
    reset(); arm("hold");
    expect((await send(drained, "first, held")).status).toBe(202);
    await live();
    arm("refuse-steer");
    expect((await send(drained, "second, queued behind the held turn")).status).toBe(202);
    arm("limit"); release();
    // the drained turn is the one that meets the limit (its engine refuses it at start). A drained line carries no origin, so it is not the
    // owner's direct turn: it never fails over and never offers a card. It also never decided or minted, which is what X2 needs.
    await expect.poll(() => existsSync(join(askDir(), "limit")), { timeout: 30000 }).toBe(false);
    await idle(drained.id); await quiet(1000);
    const lines = JSON.stringify(await messages(drained.threadId));
    expect(lines).not.toMatch(/hit its limit/);
    expect((await messages(drained.threadId)).some((m) => m.card?.tool === "murage_limit_offer")).toBe(false);
    expect(minted(drained.threadId)).toHaveLength(1);
    expect(turns(drained.threadId)[0].phoneJobs).toBeDefined();
  }, 150000);

  it("9: a limit card answered from the desktop mints on the resend; the same card answered after a restart does not", async () => {
    const live1 = await createBot("Phone s11 card live", "src-a9a");
    reset(); arm("limit");
    expect((await send(live1, "limit with no backup")).status).toBe(202);
    await settleTurns(live1.threadId, 1);
    const cardOf = async (threadId: string) => { let found: any; await expect.poll(async () => (found = (await messages(threadId)).find((m) => m.card?.tool === "murage_limit_offer")) !== undefined, { timeout: 30000 }).toBe(true).catch(async (error) => { console.log("S11 diag card", await snapshot(threadId)); throw error; }); return found.card; };
    const card = await cardOf(live1.threadId);
    const label = card.options.find((option: string) => /^Backup a9a/.test(option)) ?? card.options.find((option: string) => option !== "Wait");
    expect(label).toBeTruthy();
    await idle(live1.id);
    expect((await api("POST", `/api/threads/${live1.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: label })).status).toBe(200);
    await expect.poll(() => minted(live1.threadId).length, { timeout: 30000 }).toBe(2);
    await idle(live1.id);

    const restarted = await createBot("Phone s11 card restart", "src-a9b");
    reset(); arm("limit");
    expect((await send(restarted, "limit then restart")).status).toBe(202);
    const card2 = await cardOf(restarted.threadId);
    const label2 = card2.options.find((option: string) => /^Backup a9b/.test(option));
    expect(label2).toBeTruthy();
    await idle(restarted.id);
    await fixture.restart();
    await connect();
    expect((await api("POST", `/api/threads/${restarted.threadId}/respond`, { requestId: card2.requestId, behavior: "answer", message: label2 })).status).toBe(200);
    await expect.poll(() => turns(restarted.threadId).length, { timeout: 30000 }).toBe(2);
    // the carry did not survive the restart: the resend turn holds no authority and is told so
    expect(minted(restarted.threadId)).toHaveLength(1);
    expect(turns(restarted.threadId)[1].phoneJobs).toBeUndefined();
    expect(turns(restarted.threadId)[1].system).toContain(PHONE_COPY.withheld);
    await idle(restarted.id);

    const drained = await createBot("Phone s11 card drained", "src-a9c");
    reset(); arm("hold");
    expect((await send(drained, "first, held")).status).toBe(202);
    await live();
    arm("refuse-steer");
    expect((await send(drained, "second, queued")).status).toBe(202);
    arm("limit"); release();
    await expect.poll(() => existsSync(join(askDir(), "limit")), { timeout: 30000 }).toBe(false);
    await idle(drained.id); await quiet(1000);
    // a drained line has no direct-owner origin: no card is offered for it, so there is nothing to answer, and no resend that could mint
    expect((await messages(drained.threadId)).some((m) => m.card?.tool === "murage_limit_offer")).toBe(false);
    expect(minted(drained.threadId)).toHaveLength(1);
  }, 240000);

  it("10: a failover of a turn the paired phone sent carries ownerActs only through the carry", async () => {
    const bot = await createBot("Phone s11 companion failover", "src-a10");
    await setBackup(bot, "bk-a10");
    reset(); arm("limit");
    expect((await send(bot, "phone words then limit", companion)).status).toBe(202);
    await expect.poll(() => minted(bot.threadId).length, { timeout: 30000 }).toBe(2);
    await idle(bot.id);
  }, 120000);

  // ---- S13: the phone-jobs MCP mount is observable in the fake engine's dump ----
  const readEnv = (name: string) => JSON.parse(readFileSync(join(askDir(), name), "utf8")) as Record<string, string>;
  const deviceCall = (token: string, body: unknown) => api("POST", "/api/internal/device/call", body, { authorization: `Bearer ${token}` });
  const CALENDAR_TOOLS = "phone_calendar_read,phone_calendar_find_free_time";

  it("11: an owner's idle send mounts exactly the granted and reported tools; an unproven send, no grant and the flag off mount nothing", async () => {
    const bot = await createBot("Phone s13 mount", "src-m1");
    expect((await send(bot, "hello from the desktop")).status).toBe(202);
    await expect.poll(() => dumpRows(bot.threadId).length, { timeout: 30000 }).toBe(1);
    expect(dumpRows(bot.threadId)[0].phoneJobs).toEqual({ tools: CALENDAR_TOOLS, hasToken: true });
    // S20: the owner's turn that holds the tools gets the instruction lines and no withheld note
    for (const line of PHONE_COPY.instructions) expect(dumpRows(bot.threadId)[0].system).toContain(line);
    expect(dumpRows(bot.threadId)[0].system).not.toContain(PHONE_COPY.withheld);
    await idle(bot.id);
    expect((await send(bot, "words nobody proved", null)).status).toBe(202);
    await expect.poll(() => dumpRows(bot.threadId).length, { timeout: 30000 }).toBe(2);
    expect(dumpRows(bot.threadId)[1].phoneJobs).toBeUndefined();
    expect(dumpRows(bot.threadId)[1].system).toContain(PHONE_COPY.withheld);
    expect(dumpRows(bot.threadId)[1].system).not.toContain(PHONE_COPY.instructions[0]);
    await idle(bot.id);

    const ungranted = await createBot("Phone s13 no grant", "src-m1", false);
    expect((await send(ungranted, "hello, no grant")).status).toBe(202);
    await expect.poll(() => dumpRows(ungranted.threadId).length, { timeout: 30000 }).toBe(1);
    expect(dumpRows(ungranted.threadId)[0].phoneJobs).toBeUndefined();
    // S20: a bot with no grant gets no phone lines at all
    expect(dumpRows(ungranted.threadId)[0].system).not.toContain(PHONE_COPY.withheld);
    expect(dumpRows(ungranted.threadId)[0].system).not.toContain(PHONE_COPY.instructions[0]);
    await idle(ungranted.id);

    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    expect((await send(bot, "hello with the feature off")).status).toBe(202);
    await expect.poll(() => dumpRows(bot.threadId).length, { timeout: 30000 }).toBe(3);
    expect(dumpRows(bot.threadId)[2].phoneJobs).toBeUndefined();
    // S20: with the feature off the bot hears nothing about a phone
    expect(dumpRows(bot.threadId)[2].system).not.toContain(PHONE_COPY.withheld);
    await idle(bot.id);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 120000);

  it("12: an engine that has agentsMcp but does not mount phoneJobs (antigravity, openclaw) gets no integrations.phoneJobs", async () => {
    const bot = await createBot("Phone s14 no mount", "src-nomount");
    expect((await send(bot, "hello to an engine without phone tools")).status).toBe(202);
    await expect.poll(() => dumpRows(bot.threadId).length, { timeout: 30000 }).toBe(1);
    expect(dumpRows(bot.threadId)[0].phoneJobs).toBeUndefined();
    await idle(bot.id);
  }, 120000);

  it("12b: S21: an engine that cannot mount phone tools is not given the withheld note, on a turn with no authority", async () => {
    const bot = await createBot("Phone s21 no mount unproven", "src-nomount");
    expect((await send(bot, "words nobody proved, to an engine without phone tools", null)).status).toBe(202);
    await expect.poll(() => dumpRows(bot.threadId).length, { timeout: 30000 }).toBe(1);
    expect(minted(bot.threadId)).toHaveLength(0);
    expect(dumpRows(bot.threadId)[0].system).not.toContain(PHONE_COPY.withheld);
    await idle(bot.id);
    // the same send to an engine that does mount them still gets the note (case 6), so the gate is the engine and nothing else
  }, 120000);

  it("12: the device route answers only the turn's own device token, per call, and a stale or other-kind token gets nothing", async () => {
    const bot = await createBot("Phone s13 route", "src-m2");
    reset(); arm("hold");
    expect((await send(bot, "held turn")).status).toBe(202);
    await live();
    await expect.poll(() => existsSync(join(askDir(), "phone-jobs-env.json")), { timeout: 20000 }).toBe(true);
    const env = readEnv("phone-jobs-env.json");
    expect(env.MURAGE_PHONE_TOOLS).toBe(CALENDAR_TOOLS);
    const device = env.MURAGE_CONTROL_TOKEN;
    // a tool the grant does not allow, and arguments that fail the schema: refused, and no job is opened (they would otherwise wait on the phone)
    expect((await deviceCall(device, { tool: "phone_call_dial", args: { number: "5551234" } })).body).toMatchObject({ ok: false, code: "refused" });
    expect((await deviceCall(device, { tool: "phone_calendar_read", args: { start: "tomorrow" } })).body).toMatchObject({ ok: false, code: "invalid_args" });
    expect((await deviceCall(device, { tool: "not_a_tool", args: {} })).body).toMatchObject({ ok: false, code: "refused" });
    // the agents token of the same turn is another kind: 403 on the device path
    const agents = readEnv("agents-env.json");
    expect((await deviceCall(agents.MURAGE_COMMS_TOKEN, { tool: "phone_calendar_read", args: {} })).status).toBe(403);
    // the device token does not reach the agents routes either
    expect((await api("GET", "/api/internal/agents", undefined, { authorization: `Bearer ${device}` })).status).toBe(403);
    release(); await idle(bot.id);
    // the turn ended: the token is dead
    expect((await deviceCall(device, { tool: "phone_calendar_read", args: {} })).status).toBe(401);
  }, 120000);
});
