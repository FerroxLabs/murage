// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S23: the flag-on end-to-end matrix, through the real server and the in-process ask fixture engine. No test seam: the
// phone registers through PUT /api/phones/self with the door's phone envelope, jobs are opened by a real owner turn whose phone tool call
// reaches /api/internal/device/call, and every claim is read from what the product shows: the engine's dump (the MCP mount and the system
// prompt), job outcomes, the event log and native trace on disk, and push rows and the phone's detail fetch.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TEXT } from "../shared/mobile-push.ts";
import { PHONE_COPY } from "./phones/copy.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
// the suite hands every fixture server this launch secret (testing/setup.ts): it is the door's token and the companion's launch proof here
const DOOR = "c".repeat(64);
const DEVICE = "22222222-2222-4222-8222-222222222222";
const BINDING = "5d0f7a2e-3b1c-4e8a-9f6d-1c2b3a4d5e6f";
const MATRIX = ["x1", "x1c", "x2", "x5", "x6", "x7", "x8a", "x8b", "x9a", "x9b"];
const WITHHELD_TEXT = "[phone turn text withheld]";
const WITHHELD_RESULT = "[phone result withheld]";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
let dir = "";
let registration: any;

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
/** The door's phone envelope (companion/src/phone-door.ts phoneForwardHeaders). */
const envelope = (deviceId: string): Record<string, string> => ({ "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-device": deviceId, "x-murage-phone-scope": "jobs" });
const companion = { "x-test-bare-loopback": "1", "x-murage-companion": "1", "x-murage-companion-token": DOOR };
const phone = (method: string, path: string, body?: unknown, deviceId = DEVICE) => api(method, path, body, envelope(deviceId));
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const idle = async (id: string) => { await expect.poll(async () => (await botState(id))?.busy, { timeout: 30000 }).toBe(false); };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const arm = (name: string) => writeFileSync(join(askDir(), name), "");
const release = () => writeFileSync(join(askDir(), "release"), "");
const reset = () => { for (const name of ["hold", "live", "release", "limit", "refuse-steer", "refuse-steer-idle", "reply.txt", "tool-event.txt"]) rmSync(join(askDir(), name), { force: true }); };
const live = async () => { await expect.poll(() => existsSync(join(askDir(), "live")), { timeout: 20000 }).toBe(true); };
const readEnv = (name: string) => JSON.parse(readFileSync(join(askDir(), name), "utf8")) as Record<string, string>;
let counter = 0;
const sendId = () => `phone-s23-${Date.now()}-${++counter}-padding`;

const createBot = async (name: string, instanceId: string, grant: Record<string, string> | null = { calendar: "read" }) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  if (grant) expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: grant })).status).toBe(200);
  return bot;
};
const send = (bot: { id: string; threadId: string }, text: string, extra: Record<string, string> | null = headers) =>
  api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: sendId() }, extra);
const setBackup = async (bot: { id: string }, instanceId: string) => {
  expect((await api("PUT", `/api/bots/${bot.id}/limit-backup`, { selection: { instanceId, model: "ask-1" }, routines: false })).status).toBe(200);
};
/** Starts an owner turn that stays open and returns its device token (the env the engine was handed). */
const holdTurn = async (bot: { id: string; threadId: string }, text: string) => {
  rmSync(join(askDir(), "phone-jobs-env.json"), { force: true });
  rmSync(join(askDir(), "live"), { force: true });
  arm("hold");
  expect((await send(bot, text)).status).toBe(202);
  await expect.poll(() => existsSync(join(askDir(), "phone-jobs-env.json")) && existsSync(join(askDir(), "live")), { timeout: 30000 }).toBe(true);
  return readEnv("phone-jobs-env.json").MURAGE_CONTROL_TOKEN!;
};
const deviceCall = (token: string, body: unknown) => api("POST", "/api/internal/device/call", body, { authorization: `Bearer ${token}` });
const CAL = { tool: "phone_calendar_read", args: { start: "2026-10-26T09:00:00Z", end: "2026-10-26T17:00:00Z" } };
const EVENT = { id: "ev-1", title: "Standup SECRET-TITLE", start: "2026-10-27T09:00:00-07:00", end: "2026-10-27T09:15:00-07:00", allDay: false, calendar: "Work", location: "Room 4", notes: "Bring the numbers" };
const offerOf = async () => { const jobs = (await phone("GET", "/api/phones/self/jobs")).body.jobs; expect(jobs).toHaveLength(1); return jobs[0]; };
const lease = async (offer: any) => (await phone("POST", `/api/phones/self/jobs/${offer.operationId}/lease`, { offerId: offer.offerId })).body;
const answer = (leaseToken: string) => ({ leaseToken, ok: true, result: { events: [EVENT], truncated: false } });

/** Every turn the fake engine started on the thread, in order (steers excluded). A row with phoneJobs is a turn that held the authority. */
const turns = (threadId: string): any[] => {
  try { return readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.threadId === threadId && !row.steer); } catch { return []; }
};
const minted = (threadId: string) => turns(threadId).filter((row) => row.phoneJobs !== undefined);

const eventLog = (threadId: string): string => {
  const file = join(fixture.info.dataDir, "events", `${threadId}.ndjson`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const assistantTexts = (threadId: string): string[] => eventLog(threadId).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text").map((e: any) => e.text as string);
const nativeTrace = (threadId: string): string => {
  const base = join(fixture.info.dataDir, "native");
  return [`${threadId}.previous.ndjson`, `${threadId}.ndjson`].map((f) => (existsSync(join(base, f)) ? readFileSync(join(base, f), "utf8") : "")).join("");
};
const pushRows = (threadId: string): Array<{ event_ref: string; category: string; phone_used: number }> => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT event_ref, category, phone_used FROM push_events WHERE thread_id=? ORDER BY created_at, rowid").all(threadId) as any[]; } finally { db.close(); }
};
const enrolBinding = async () => {
  // the push tables are made when the server opens its database: retry until they exist
  for (let attempt = 0; attempt < 150; attempt++) {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("INSERT OR REPLACE INTO push_bindings (binding_id, device_id, publisher_token, created_at, preview_content) VALUES (?,?,?,?,1)").run(BINDING, DEVICE, "murage_pt_s23", Date.now());
      return;
    } catch { /* not there yet */ } finally { db.close(); }
    await quiet(200);
  }
  throw new Error("push tables never appeared");
};
const detail = (ref: string) => api("GET", `/api/mobile/push/${ref}`, undefined, { ...companion, "x-murage-push-device": DEVICE, "x-murage-push-binding": BINDING, "x-murage-push-scope": "detail" });
const genericDone = async (threadId: string, generic: boolean) => {
  await expect.poll(() => pushRows(threadId).filter((r) => r.category === "done").length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  const rows = pushRows(threadId).filter((r) => r.category === "done");
  expect(rows.every((r) => r.phone_used === (generic ? 1 : 0)), JSON.stringify(rows)).toBe(true);
  const read = await detail(rows[rows.length - 1]!.event_ref);
  expect(read.status).toBe(200);
  const shown = { title: read.body.title, body: read.body.body };
  if (generic) expect(shown).toEqual(GENERIC_TEXT.done); else expect(shown).not.toEqual(GENERIC_TEXT.done);
};
const plainTurn = async (bot: { id: string; threadId: string }, text: string, reply?: string) => {
  reset();
  if (reply !== undefined) writeFileSync(join(askDir(), "reply.txt"), reply);
  expect((await send(bot, text)).status).toBe(202);
  await idle(bot.id);
};
const withheldAfter = async (bot: { id: string; threadId: string }, words: string) => {
  await plainTurn(bot, `ask for ${words}`, words);
  await expect.poll(() => assistantTexts(bot.threadId).filter((t) => t === WITHHELD_TEXT).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  expect(eventLog(bot.threadId)).not.toContain(words);
  expect(assistantTexts(bot.threadId).every((t) => t === WITHHELD_TEXT)).toBe(true);
};
/** One accepted phone call on the bot's open thread (poll, lease, result), ending the turn. Marks the thread. */
const phoneTurn = async (bot: { id: string; threadId: string }) => {
  reset();
  const token = await holdTurn(bot, "turn that reads the calendar");
  const call = deviceCall(token, CAL);
  const offer = await offerOf();
  const taken = await lease(offer);
  expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, answer(taken.leaseToken))).status).toBe(200);
  expect((await call).body.ok).toBe(true);
  release(); await idle(bot.id);
};
/** The companion's mint call is the only thing that clears the barrier; the phone then registers again. */
const mintAndRegister = async () => {
  expect(await api("POST", "/api/phones/minted", { deviceId: DEVICE }, companion)).toMatchObject({ status: 200, body: { ok: true } });
  expect((await phone("PUT", "/api/phones/self", registration)).status).toBe(200);
};

posixOnly("phone tools flag-on end to end (S23)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "murage-phones-e2e-"));
    const names = JSON.stringify(MATRIX);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      const { PHONE_JOBS_ENGINES } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "phone-jobs-engines.ts")).href)});
      PHONE_JOBS_ENGINES.fakeAsk = { mounts: true, where: 'test fixture' };
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.tools={driver:'fakeAsk',displayName:'Tools',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1',FAKE_ASK_NATIVE:'1'}};
      cfg.instances.tools2={driver:'fakeAsk',displayName:'Tools two',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1',FAKE_ASK_NATIVE:'1'}};
      for (const name of ${names}) {
        cfg.instances['src-'+name]={driver:'fakeAsk',displayName:'Source '+name,environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
        cfg.instances['bk-'+name]={driver:'fakeAsk',displayName:'Backup '+name,environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_STEER:'1',FAKE_ASK_TOOLS:'1'}};
      }
      cfg.instances.queues={driver:'fakeAsk',displayName:'Queues',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(askDir(), { recursive: true });
    await connect();
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
    registration = JSON.parse(readFileSync(join(SERVER_DIR, "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8")).registration.valid;
    await enrolBinding();
  }, 120000);
  afterAll(async () => { await fixture?.close(); if (dir) await removeTempDir(dir); });

  it("register, ask, poll, lease, result: the bot reads the result and the phone name, and nothing of the phone reaches the log, the native trace or the push", async () => {
    // register
    expect((await phone("PUT", "/api/phones/self", registration)).status).toBe(200);
    const listed = ((await api("GET", "/api/phones")).body.phones as any[]).find((p) => p.deviceId === DEVICE);
    expect(listed?.name).toBe(registration.name);
    const bot = await createBot("E2E happy", "tools");
    reset();
    const token = await holdTurn(bot, "turn that reads the calendar");
    // the owner's turn held the authority: the engine was handed the phone tools and the instruction lines, not the withheld note
    expect(turns(bot.threadId)[0].phoneJobs).toMatchObject({ hasToken: true });
    expect(turns(bot.threadId)[0].system).not.toContain(PHONE_COPY.withheld);
    // owner sends; the phone polls and gets the offer; lease; result
    const call = deviceCall(token, CAL);
    const offer = await offerOf();
    expect(offer).toMatchObject({ action: "calendar.read", capability: "calendar", bot: { id: bot.id } });
    const taken = await lease(offer);
    expect(taken.active).toBe(true);
    writeFileSync(join(askDir(), "tool-event.txt"), "TOOL-RESULT-CANARY standup SECRET-TITLE");
    writeFileSync(join(askDir(), "reply.txt"), "BOT-REPLY-CANARY");
    expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, answer(taken.leaseToken))).status).toBe(200);
    const done = (await call).body;
    expect(done.ok).toBe(true);
    // the bot reads the result and the phone's name
    expect(JSON.parse(done.text)).toMatchObject({ phone: registration.name, result: { events: [{ title: EVENT.title }] } });
    release(); await idle(bot.id);
    // the event log on disk: the shapes stay, the words do not
    await expect.poll(() => eventLog(bot.threadId).includes(WITHHELD_RESULT) && eventLog(bot.threadId).includes(WITHHELD_TEXT), { timeout: 30000 }).toBe(true);
    for (const canary of ["TOOL-RESULT-CANARY", "SECRET-TITLE", "BOT-REPLY-CANARY"]) expect(eventLog(bot.threadId), canary).not.toContain(canary);
    // the native trace holds no result text
    const trace = nativeTrace(bot.threadId);
    for (const canary of ["TOOL-RESULT-CANARY", "SECRET-TITLE", "BOT-REPLY-CANARY", "Bring the numbers", "FIRST-CALL-ARGS-CANARY"]) expect(trace, canary).not.toContain(canary);
    // the thread's transcript names the action and the phone, never the contents
    expect(JSON.stringify(await messages(bot.threadId))).not.toContain("SECRET-TITLE");
    // the done push row is flagged and the phone's detail fetch reads the fixed generic text
    await genericDone(bot.threadId, true);
    // a later plain turn in the same thread is withheld
    await withheldAfter(bot, "ZEBRA-E2E-later-turn");
    const plain = await createBot("E2E plain", "tools", null);
    await plainTurn(plain, "no phone here", "OTTER-E2E-visible");
    await expect.poll(() => assistantTexts(plain.threadId).includes("OTTER-E2E-visible"), { timeout: 30000 }).toBe(true);
    await genericDone(plain.threadId, false);
  }, 300000);

  it("the F4 matrix end to end: which turns hold the authority, read from the tools the engine was handed", async () => {
    // an idle owner send from the desktop and a send from the paired phone both hold it
    const a = await createBot("F4 desktop", "src-x1");
    reset();
    expect((await send(a, "hello from the desktop")).status).toBe(202);
    await expect.poll(() => minted(a.threadId).length, { timeout: 30000 }).toBe(1);
    await idle(a.id);
    const c = await createBot("F4 companion", "src-x1c");
    expect((await send(c, "hello from the phone", companion)).status).toBe(202);
    await expect.poll(() => minted(c.threadId).length, { timeout: 30000 }).toBe(1);
    await idle(c.id);

    // a send steered into a running turn starts nothing and adds no authority; a fresh send after the turn ends holds its own
    const steer = await createBot("F4 steer", "src-x2");
    reset(); arm("hold");
    expect((await send(steer, "first, held")).status).toBe(202);
    await live();
    expect(minted(steer.threadId)).toHaveLength(1);
    expect((await send(steer, "second, steered")).status).toBe(202);
    await quiet(500);
    expect(turns(steer.threadId)).toHaveLength(1);
    release(); await idle(steer.id);
    expect((await send(steer, "third, fresh")).status).toBe(202);
    await expect.poll(() => minted(steer.threadId).length, { timeout: 30000 }).toBe(2);
    await idle(steer.id);

    // a line queued behind a busy turn and drained later holds nothing, and is told so
    const queued = await createBot("F4 queued", "queues");
    reset(); arm("hold");
    expect((await send(queued, "first, held")).status).toBe(202);
    await live();
    expect((await send(queued, "second, queued")).status).toBe(202);
    release();
    await expect.poll(async () => (await messages(queued.threadId)).filter((m) => m.role === "user").length, { timeout: 30000 }).toBe(2);
    await idle(queued.id); await quiet(500);
    expect(minted(queued.threadId)).toHaveLength(1);
    const queuedRows = turns(queued.threadId);
    expect(queuedRows[queuedRows.length - 1].system).toContain(PHONE_COPY.withheld);

    // an unproven send holds nothing
    const unproven = await createBot("F4 unproven", "src-x6");
    reset();
    expect((await send(unproven, "words nobody proved", null)).status).toBe(202);
    await expect.poll(() => turns(unproven.threadId).length, { timeout: 30000 }).toBe(1);
    expect(minted(unproven.threadId)).toHaveLength(0);
    await idle(unproven.id);

    // a room never reaches the direct path
    const member = await createBot("F4 room member", "src-x7");
    const other = await createBot("F4 room other", "src-x7");
    const room = (await api("POST", "/api/groups", { name: "F4 room", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body.group as { id: string; threadId: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "hello room", sendId: sendId() })).status).toBe(202);
    await expect.poll(async () => (await messages(room.threadId)).some((m) => m.role === "bot"), { timeout: 30000 }).toBe(true);
    await quiet(500);
    expect(minted(room.threadId)).toHaveLength(0);

    // a failover of an authorised turn carries eligibility; a failover of a drained line does not
    const held = await createBot("F4 failover held", "src-x8a");
    await setBackup(held, "bk-x8a");
    reset(); arm("limit");
    expect((await send(held, "limit then failover")).status).toBe(202);
    await expect.poll(() => minted(held.threadId).length, { timeout: 30000 }).toBe(2);
    await idle(held.id);
    const drained = await createBot("F4 failover drained", "src-x8b");
    await setBackup(drained, "bk-x8b");
    reset(); arm("hold");
    expect((await send(drained, "first, held")).status).toBe(202);
    await live();
    arm("refuse-steer");
    expect((await send(drained, "second, queued behind the held turn")).status).toBe(202);
    arm("limit"); release();
    await expect.poll(() => existsSync(join(askDir(), "limit")), { timeout: 30000 }).toBe(false);
    await idle(drained.id); await quiet(1000);
    expect(minted(drained.threadId)).toHaveLength(1);
    expect((await messages(drained.threadId)).some((m) => m.card?.tool === "murage_limit_offer")).toBe(false);

    // a limit card answered from the desktop holds the authority on the resend; answered after a restart it does not
    const cardOf = async (threadId: string) => { let found: any; await expect.poll(async () => (found = (await messages(threadId)).find((m) => m.card?.tool === "murage_limit_offer")) !== undefined, { timeout: 30000 }).toBe(true); return found.card; };
    const card1 = await createBot("F4 card live", "src-x9a");
    reset(); arm("limit");
    expect((await send(card1, "limit with no backup")).status).toBe(202);
    const live1 = await cardOf(card1.threadId);
    await idle(card1.id);
    expect((await api("POST", `/api/threads/${card1.threadId}/respond`, { requestId: live1.requestId, behavior: "answer", message: live1.options.find((o: string) => /^Backup x9a/.test(o)) })).status).toBe(200);
    await expect.poll(() => minted(card1.threadId).length, { timeout: 30000 }).toBe(2);
    await idle(card1.id);
    const card2 = await createBot("F4 card restart", "src-x9b");
    reset(); arm("limit");
    expect((await send(card2, "limit then restart")).status).toBe(202);
    const live2 = await cardOf(card2.threadId);
    await idle(card2.id);
    await fixture.restart();
    await connect();
    expect((await api("POST", `/api/threads/${card2.threadId}/respond`, { requestId: live2.requestId, behavior: "answer", message: live2.options.find((o: string) => /^Backup x9b/.test(o)) })).status).toBe(200);
    await expect.poll(() => turns(card2.threadId).length, { timeout: 30000 }).toBe(2);
    expect(minted(card2.threadId)).toHaveLength(1);
    expect(turns(card2.threadId)[1].system).toContain(PHONE_COPY.withheld);
    await idle(card2.id);
  }, 420000);

  it("a revoke before the lease says it did not run; a revoke after the lease says it may have run", async () => {
    const early = await createBot("E2E revoke early", "tools");
    const tokenEarly = await holdTurn(early, "turn open when the phone is removed before it leases");
    const beforeLease = deviceCall(tokenEarly, CAL);
    await offerOf();
    expect(await api("POST", "/api/phones/revoke", { deviceId: DEVICE, reason: "removed" }, companion)).toMatchObject({ status: 200, body: { revoked: 1 } });
    const didNotRun = (await beforeLease).body;
    expect(didNotRun).toMatchObject({ ok: false, code: "denied" });
    expect(didNotRun.text).toBe(PHONE_COPY.accessChanged);
    release(); await idle(early.id);
    await mintAndRegister();

    const late = await createBot("E2E revoke late", "tools");
    const tokenLate = await holdTurn(late, "turn open when the phone is removed after it leases");
    const afterLease = deviceCall(tokenLate, CAL);
    const offer = await offerOf();
    expect((await lease(offer)).active).toBe(true);
    expect(await api("POST", "/api/phones/revoke", { deviceId: DEVICE, reason: "removed" }, companion)).toMatchObject({ status: 200, body: { revoked: 1 } });
    const mayHaveRun = (await afterLease).body;
    expect(mayHaveRun).toMatchObject({ ok: false, code: "timeout" });
    expect(mayHaveRun.text).toBe(PHONE_COPY.mayHaveRun);
    release(); await idle(late.id);
    await mintAndRegister();
  }, 240000);

  it("D12: a restart with a parked job fails it offline, and it is never offered again", async () => {
    const bot = await createBot("E2E parked", "tools");
    const token = await holdTurn(bot, "turn open across a restart");
    const call = deviceCall(token, CAL).catch(() => null);
    const offer = await offerOf();
    // the app leaves the foreground: the job goes back to the queue and, after the park delay, is parked with the push
    expect((await phone("POST", "/api/phones/self/foreground", { active: false })).status).toBe(200);
    await quiet(3600);
    await fixture.restart();
    await connect();
    await call;
    expect((await phone("GET", "/api/phones/self/jobs")).body.jobs).toEqual([]);
    expect((await phone("GET", `/api/phones/self/jobs/${offer.operationId}`)).body).toEqual({ handled: true, reason: "unknown" });
    expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/lease`, { offerId: offer.offerId })).body.active).not.toBe(true);
    await quiet(500);
    expect((await phone("GET", "/api/phones/self/jobs")).body.jobs).toEqual([]);
  }, 240000);

  it("AS2: a revoke whose door clear never arrives bars the phone, a new job request, and a restart, until a fresh mint", async () => {
    const bot = await createBot("E2E barrier", "tools");
    const token = await holdTurn(bot, "turn open when the phone is removed");
    expect(await api("POST", "/api/phones/revoke", { deviceId: DEVICE, reason: "removed" }, companion)).toMatchObject({ status: 200 });
    // the door's clear (POST /api/phones/minted) is never sent
    const refused = async () => {
      expect(await phone("PUT", "/api/phones/self", registration)).toMatchObject({ status: 403, body: { error: "revoked" } });
      expect(await phone("GET", "/api/phones/self/jobs")).toMatchObject({ status: 403, body: { error: "revoked" } });
    };
    await refused();
    // a new job request for that phone gets nothing: it is refused or ended, and no job is offered
    const request = await deviceCall(token, CAL);
    expect(request.body.ok).not.toBe(true);
    await refused();
    release(); await idle(bot.id);
    expect(((await api("GET", "/api/phones")).body.phones as any[]).map((p) => p.deviceId)).not.toContain(DEVICE);
    await fixture.restart();
    await connect();
    await refused();
    await mintAndRegister();
    expect(((await api("GET", "/api/phones")).body.phones as any[]).map((p) => p.deviceId)).toContain(DEVICE);
  }, 240000);

  it("AS9: marked with the flag on, the flag off, a restart: the next done push and the event log stay withheld", async () => {
    const bot = await createBot("E2E flag off", "tools");
    const other = await createBot("E2E flag off plain", "tools", null);
    await phoneTurn(bot);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    await fixture.restart();
    await connect();
    await withheldAfter(bot, "ZEBRA-E2E-flag-off");
    await genericDone(bot.threadId, true);
    await plainTurn(other, "plain turn with the flag off", "OTTER-E2E-flag-off");
    await expect.poll(() => assistantTexts(other.threadId).includes("OTTER-E2E-flag-off"), { timeout: 30000 }).toBe(true);
    await genericDone(other.threadId, false);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 300000);
});
