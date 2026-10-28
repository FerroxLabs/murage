// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S17 (X3): the per-thread phone mark is persisted on the task record. It survives a restart, is read whether or not the
// feature flag is on (Astra AS9), is never on the wire, and goes only with the conversation. Same real-server fixture as
// phone-push-detail-restart.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENERIC_TEXT } from "../shared/mobile-push.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
// the suite hands every fixture server this launch secret (testing/setup.ts): it is the door's token and the companion's launch proof here
const DOOR = "c".repeat(64);
const DEVICE = "22222222-2222-4222-8222-222222222222";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
let dir = "";

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
const arm = (name: string) => writeFileSync(join(askDir(), name), "");
const release = () => writeFileSync(join(askDir(), "release"), "");
let counter = 0;
const createBot = async (name: string, grant: Record<string, string>) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "tools", model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: grant })).status).toBe(200);
  return bot;
};
/** Starts an owner turn that stays open and returns its device token (the env the engine was handed). */
const holdTurn = async (bot: { id: string; threadId: string }, text: string) => {
  rmSync(join(askDir(), "phone-jobs-env.json"), { force: true });
  rmSync(join(askDir(), "live"), { force: true });
  arm("hold");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `phone-s14-${Date.now()}-${++counter}-padding` })).status).toBe(202);
  await expect.poll(() => existsSync(join(askDir(), "phone-jobs-env.json")) && existsSync(join(askDir(), "live")), { timeout: 30000 }).toBe(true);
  return (JSON.parse(readFileSync(join(askDir(), "phone-jobs-env.json"), "utf8")) as Record<string, string>).MURAGE_CONTROL_TOKEN!;
};
const deviceCall = (token: string, body: unknown) => api("POST", "/api/internal/device/call", body, { authorization: `Bearer ${token}` });
const CAL = { tool: "phone_calendar_read", args: { start: "2026-10-26T09:00:00Z", end: "2026-10-26T17:00:00Z" } };


const BINDING = "5d0f7a2e-3b1c-4e8a-9f6d-1c2b3a4d5e6f";
const pushRows = (threadId: string): Array<{ event_ref: string; category: string; kind: string; phone_used: number }> => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT event_ref, category, kind, phone_used FROM push_events WHERE thread_id=? ORDER BY created_at, rowid").all(threadId) as any[]; } finally { db.close(); }
};
const enrolBinding = async () => {
  // the push tables are made when the server opens its database: retry until they exist
  for (let attempt = 0; attempt < 150; attempt++) {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("INSERT OR REPLACE INTO push_bindings (binding_id, device_id, publisher_token, created_at, preview_content) VALUES (?,?,?,?,1)").run(BINDING, DEVICE, "murage_pt_s16", Date.now());
      return;
    } catch { /* not there yet */ } finally { db.close(); }
    await quiet(200);
  }
  throw new Error("push tables never appeared");
};
const detail = (ref: string) => api("GET", `/api/mobile/push/${ref}`, undefined, { ...companion, "x-murage-push-device": DEVICE, "x-murage-push-binding": BINDING, "x-murage-push-scope": "detail" });


const readBots = (): any[] => { const j = JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")); return Array.isArray(j) ? j : j.bots; };
const diskTask = (botId: string, threadId: string) => readBots().find((b) => b.id === botId)?.tasks?.find((t: any) => t.threadId === threadId);
/** One accepted phone call on the bot's open thread: marks the thread. */
const phoneTurn = async (bot: { id: string; threadId: string }, reply?: string) => {
  const token = await holdTurn(bot, "turn that reads the calendar");
  const call = deviceCall(token, CAL);
  const offer = (await phone("GET", "/api/phones/self/jobs")).body.jobs[0];
  const lease = (await phone("POST", `/api/phones/self/jobs/${offer.operationId}/lease`, { offerId: offer.offerId })).body;
    const result = { leaseToken: lease.leaseToken, ok: true, result: { events: [{ id: "ev-1", title: "Dr Lee", start: "2026-10-27T09:00:00-07:00", end: "2026-10-27T09:15:00-07:00", allDay: false, calendar: "Work", location: "Room 4", notes: "Bring the numbers" }], truncated: false } };
  expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, result)).status).toBe(200);
  expect((await call).body.ok).toBe(true);
  if (reply !== undefined) writeFileSync(join(askDir(), "reply.txt"), reply);
  release(); await idle(bot.id);
};
const plainTurn = async (bot: { id: string; threadId: string }, text: string, reply?: string) => {
  rmSync(join(askDir(), "reply.txt"), { force: true });
  if (reply !== undefined) writeFileSync(join(askDir(), "reply.txt"), reply);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `phone-s17-${Date.now()}-${++counter}-padding` })).status).toBe(202);
  await idle(bot.id);
};
/** What the Inspector's source holds: the thread's event log file, as written. */
const eventLog = (threadId: string): string => {
  const file = join(fixture.info.dataDir, "events", `${threadId}.ndjson`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
const assistantTexts = (threadId: string): string[] => eventLog(threadId).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text").map((e: any) => e.text as string);
const WITHHELD = "[phone turn text withheld]";
/** What a bug report would carry: the thread's native engine trace, every segment, as written. */
const nativeTrace = (threadId: string): string => {
  const base = join(fixture.info.dataDir, "native");
  return [`${threadId}.previous.ndjson`, `${threadId}.ndjson`].map((f) => (existsSync(join(base, f)) ? readFileSync(join(base, f), "utf8") : "")).join("");
};
/** A plain turn whose reply is `words`: the log keeps the shape and (for a marked thread) none of the words. */
const withheldAfter = async (bot: { id: string; threadId: string }, words: string) => {
  await plainTurn(bot, `ask for ${words}`, words);
  await expect.poll(() => assistantTexts(bot.threadId).filter((t) => t === WITHHELD).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  expect(eventLog(bot.threadId)).not.toContain(words);
  expect(assistantTexts(bot.threadId).every((t) => t === WITHHELD)).toBe(true);
};
const shownAfter = async (bot: { id: string; threadId: string }, words: string) => {
  await plainTurn(bot, `ask for ${words}`, words);
  await expect.poll(() => assistantTexts(bot.threadId).includes(words), { timeout: 30000 }).toBe(true);
};
const doneRows = (threadId: string) => pushRows(threadId).filter((r) => r.category === "done");
const genericDone = async (threadId: string, generic: boolean) => {
  await expect.poll(() => doneRows(threadId).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  const rows = doneRows(threadId);
  expect(rows.every((r) => r.phone_used === (generic ? 1 : 0)), JSON.stringify(rows)).toBe(true);
  const read = await detail(rows[rows.length - 1]!.event_ref);
  expect(read.status).toBe(200);
  const shown = { title: read.body.title, body: read.body.body };
  if (generic) expect(shown).toEqual(GENERIC_TEXT.done); else expect(shown).not.toEqual(GENERIC_TEXT.done);
};

posixOnly("the persisted per-thread phone mark (S17, X3)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "murage-phone-mark-"));
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
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(askDir(), { recursive: true });
    await connect();
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
    const registration = JSON.parse(readFileSync(join(SERVER_DIR, "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8")).registration.valid;
    expect((await phone("PUT", "/api/phones/self", registration)).status).toBe(200);
    await enrolBinding();
  }, 90000);
  afterAll(async () => { await fixture?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("a phone turn marks its own thread on disk, the mark is never on the wire, a plain bot has none, and a restart keeps it and its push flag", async () => {
    const bot = await createBot("Mark persisted", { calendar: "read" });
    const plain = await createBot("Mark plain", {});
    expect(diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBeUndefined();
    await phoneTurn(bot);
    const marked = diskTask(bot.id, bot.threadId);
    expect(typeof marked?.phoneUsedAt).toBe("number");
    expect(diskTask(plain.id, plain.threadId)?.phoneUsedAt).toBeUndefined();
    expect(JSON.stringify((await api("GET", "/api/bots")).body)).not.toContain("phoneUsedAt");
    expect(JSON.stringify((await api("GET", `/api/bots/${bot.id}`)).body)).not.toContain("phoneUsedAt");
    await fixture.restart();
    await connect();
    expect(diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe(marked.phoneUsedAt);
    // S16's open gap: after the restart a later plain turn still writes flagged rows and reads generic
    await plainTurn(bot, "plain turn after the restart");
    await genericDone(bot.threadId, true);
    // the unmarked bot still shows its text
    await plainTurn(plain, "plain bot turn");
    await genericDone(plain.threadId, false);
  }, 300000);

  it("AS9: marked while the flag was on, the flag turned off, a restart: the thread stays marked and generic, and an unmarked thread is untouched", async () => {
    const bot = await createBot("Mark flag off", { calendar: "read" });
    const other = await createBot("Mark flag off plain", {});
    await phoneTurn(bot);
    const at = diskTask(bot.id, bot.threadId)?.phoneUsedAt;
    expect(typeof at).toBe("number");
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    await fixture.restart();
    await connect();
    expect(diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe(at);
    await plainTurn(bot, "plain turn with the flag off");
    await genericDone(bot.threadId, true);
    await plainTurn(other, "plain turn, flag off");
    await genericDone(other.threadId, false);
    expect(diskTask(other.id, other.threadId)?.phoneUsedAt).toBeUndefined();
    expect(diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe(at);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 300000);

  it("deleting the conversation clears the mark, and the replacement conversation of that bot is unmarked", async () => {
    const bot = await createBot("Mark deleted", { calendar: "read" });
    await phoneTurn(bot);
    expect(typeof diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe("number");
    expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).status).toBe(200);
    const after = readBots().find((b) => b.id === bot.id);
    expect(after.tasks.some((t: any) => t.threadId === bot.threadId)).toBe(false);
    expect(after.tasks.length).toBeGreaterThanOrEqual(1);
    expect(after.tasks.every((t: any) => t.phoneUsedAt === undefined)).toBe(true);
    await fixture.restart();
    await connect();
    expect(readBots().find((b) => b.id === bot.id).tasks.every((t: any) => t.phoneUsedAt === undefined)).toBe(true);
  }, 240000);

  it("S18: a later plain turn on a marked thread has its reply text withheld in the event log, also after a restart; an unmarked thread keeps its text", async () => {
    const bot = await createBot("Log withheld", { calendar: "read" });
    const plain = await createBot("Log plain", {});
    await phoneTurn(bot);
    await withheldAfter(bot, "ZEBRA-ONE-after-phone");
    await fixture.restart();
    await connect();
    await withheldAfter(bot, "ZEBRA-TWO-after-restart");
    await shownAfter(plain, "OTTER-plain-visible");
    expect(assistantTexts(plain.threadId)).toContain("OTTER-plain-visible");
  }, 300000);

  it("S18: after a model switch on the marked thread (history replayed as text) the reply text is still withheld", async () => {
    const bot = await createBot("Log model switch", { calendar: "read" });
    await phoneTurn(bot);
    const switched = await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: { instanceId: "tools2", model: "ask-1" } });
    expect(switched.status).toBe(200);
    expect(typeof diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe("number");
    await withheldAfter(bot, "ZEBRA-THREE-after-switch");
  }, 300000);

  it("S18: an edit forks inside the same thread (no new task), the mark stays and the rerun's text is withheld", async () => {
    const bot = await createBot("Log edit fork", { calendar: "read" });
    await phoneTurn(bot);
    const before = readBots().find((b) => b.id === bot.id).tasks.length;
    await plainTurn(bot, "first plain question");
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    const source = (messages ?? []).find((m: any) => m.role === "user" && m.text === "first plain question");
    expect(source, "the user message to edit").toBeTruthy();
    writeFileSync(join(askDir(), "reply.txt"), "ZEBRA-FOUR-after-edit");
    const edited = await api("POST", `/api/bots/${bot.id}/messages/${source.id}/edit`, { threadId: bot.threadId, text: "edited plain question", sendId: `phone-s18-${Date.now()}-${++counter}-padding` });
    expect(edited.status).toBe(202);
    await idle(bot.id);
    const after = readBots().find((b) => b.id === bot.id);
    expect(after.tasks.length).toBe(before);
    expect(typeof diskTask(bot.id, bot.threadId)?.phoneUsedAt).toBe("number");
    await expect.poll(() => assistantTexts(bot.threadId).length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    expect(eventLog(bot.threadId)).not.toContain("ZEBRA-FOUR-after-edit");
    expect(assistantTexts(bot.threadId).every((t) => t === WITHHELD)).toBe(true);
  }, 300000);

  it("S18 AS9: marked with the flag on, the flag off, a restart, a model switch: the reply text stays withheld and an unmarked thread shows text", async () => {
    const bot = await createBot("Log flag off", { calendar: "read" });
    const other = await createBot("Log flag off plain", {});
    await phoneTurn(bot);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    await fixture.restart();
    await connect();
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: { instanceId: "tools2", model: "ask-1" } })).status).toBe(200);
    await withheldAfter(bot, "ZEBRA-FIVE-flag-off");
    await shownAfter(other, "OTTER-flag-off-visible");
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 300000);

  it("S19: the first phone call's args never reach the native trace, and the thread's trace holds no phone text afterwards", async () => {
    const bot = await createBot("Native first call", { calendar: "read" });
    await phoneTurn(bot, "PHONE-REPLY-FIRST");
    const trace = nativeTrace(bot.threadId);
    expect(trace).toContain('"source":"fakeAsk"');
    expect(trace).not.toContain("FIRST-CALL-ARGS-CANARY");
    // the first turn's own prompt frame is written before any phone call can mark the thread; only tool args and results are phone data
    await plainTurn(bot, "plain follow up after the phone turn");
    expect(nativeTrace(bot.threadId)).not.toContain("plain follow up after the phone turn");
  }, 300000);

  it("S19 AS9: marked with the flag on, the flag off, a restart, a model switch: the replay prompt's native trace has no phone text; an unmarked thread's trace is unchanged", async () => {
    const bot = await createBot("Native flag off", { calendar: "read" });
    const other = await createBot("Native flag off plain", {});
    await phoneTurn(bot, "PHONE-REPLY-ALPHA");
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    await fixture.restart();
    await connect();
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: { instanceId: "tools2", model: "ask-1" } })).status).toBe(200);
    await plainTurn(bot, "question after the switch");
    // the engine really was handed a replay prompt that carries the retained phone turn's text
    const dump = readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const replay = dump.filter((row: any) => row.threadId === bot.threadId && typeof row.text === "string").pop();
    expect(replay.text).toContain("PHONE-REPLY-ALPHA");
    const trace = nativeTrace(bot.threadId);
    expect(trace).toContain('"dir":"out"');
    for (const phoneText of ["PHONE-REPLY-ALPHA", "question after the switch", "FIRST-CALL-ARGS-CANARY"]) expect(trace, phoneText).not.toContain(phoneText);
    await plainTurn(other, "unmarked question stays visible");
    expect(nativeTrace(other.threadId)).toContain("unmarked question stays visible");
    expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
  }, 300000);
});
