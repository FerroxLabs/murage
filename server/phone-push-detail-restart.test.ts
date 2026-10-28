// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S16 (X1): a turn that used the owner's phone writes its push rows flagged, and the phone's detail fetch then reads the
// fixed generic text for them even with preview consent on, after dispatch teardown and after a restart. Same real-server fixture as
// phone-jobs-api.test.ts: the phone registers through the door envelope and the job is opened by a real owner turn.
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
const fence = (body: unknown) => `Before I post it:\n\n\`\`\`murage-question\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;

posixOnly("phone push rows are flagged and read generic (S16, X1)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "murage-phone-push-"));
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
      cfg.instances.tools={driver:'fakeAsk',displayName:'Tools',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
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

  it("a phone turn's done and question pushes are flagged, and detail is generic after teardown and after a restart", async () => {
    const bot = await createBot("Push flagged", { calendar: "read" });
    const token = await holdTurn(bot, "turn that reads the calendar");
    const call = deviceCall(token, CAL);
    const offer = (await phone("GET", "/api/phones/self/jobs")).body.jobs[0];
    const lease = (await phone("POST", `/api/phones/self/jobs/${offer.operationId}/lease`, { offerId: offer.offerId })).body;
    const result = { leaseToken: lease.leaseToken, ok: true, result: { events: [{ id: "ev-1", title: "Dr Lee", start: "2026-10-27T09:00:00-07:00", end: "2026-10-27T09:15:00-07:00", allDay: false, calendar: "Work", location: "Room 4", notes: "Bring the numbers" }], truncated: false } };
    expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, result)).status).toBe(200);
    expect((await call).body.ok).toBe(true);
    release(); await idle(bot.id);
    // a second turn on the same thread (the mark is on the thread) ends in a question card
    writeFileSync(join(askDir(), "reply.txt"), fence({ questions: [{ question: "Which day should I move it to?", options: [{ label: "Monday" }, { label: "Tuesday" }], multiSelect: false }] }));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "and then ask me", sendId: `phone-s16-${Date.now()}-${++counter}-padding` })).status).toBe(202);
    await idle(bot.id);
    await expect.poll(() => pushRows(bot.threadId).filter((r) => r.category === "done" || r.category === "question").length, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    const rows = pushRows(bot.threadId);
    const content = rows.filter((r) => r.category === "done" || r.category === "question");
    expect(content.every((r) => r.phone_used === 1), JSON.stringify(rows)).toBe(true);
    for (const r of content) {
      const read = await detail(r.event_ref);
      expect(read.status).toBe(200);
      expect({ title: read.body.title, body: read.body.body }).toEqual(GENERIC_TEXT[r.category as "done" | "question"]);
    }
    await fixture.restart();
    await connect();
    for (const r of content) {
      const read = await detail(r.event_ref);
      expect(read.status).toBe(200);
      expect({ title: read.body.title, body: read.body.body }).toEqual(GENERIC_TEXT[r.category as "done" | "question"]);
    }
  }, 240000);

  it("a thread that never used the phone is unflagged", async () => {
    const bot = await createBot("Push plain", {});
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "no phone", sendId: `phone-s16-${Date.now()}-${++counter}-padding` })).status).toBe(202);
    await idle(bot.id);
    await expect.poll(() => pushRows(bot.threadId).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    expect(pushRows(bot.threadId).every((r) => r.phone_used === 0)).toBe(true);
  }, 120000);
});
