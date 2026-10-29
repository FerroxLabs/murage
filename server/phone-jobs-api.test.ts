// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S12 and S14 end to end through the real server and the in-process ask fixture engine. No test seam opens a job or
// registers a phone: the phone registers through PUT /api/phones/self with the door's phone envelope, and jobs are opened by a real owner
// turn whose phone-jobs tool call reaches /api/internal/device/call. Grant-narrowing revokes are read from job outcomes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDir } from "./testing/cleanup.ts";

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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
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
const REM = { tool: "phone_reminders_read", args: {} };
const state = async (p: Promise<unknown>) => Promise.race([p.then((v) => ({ settled: v })), quiet(400).then(() => "pending" as const)]);
const dumpRows = (threadId: string): any[] => {
  try { return readFileSync(join(askDir(), "dump.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.threadId === threadId && !row.steer); } catch { return []; }
};

posixOnly("phone job routes through the real server (S12, S14)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "murage-phone-jobs-"));
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
  }, 90000);
  afterAll(async () => { await fixture?.close(); if (dir) await removeTempDir(dir); });

  it("GET /api/phones/offered carries flag: true only while features.phoneTools is on (the Cloud card reads it)", async () => {
    const ask = () => api("GET", "/api/phones/offered", undefined, companion);
    const on = await ask();
    expect(on.status).toBe(200);
    expect(on.body.flag).toBe(true);
    // share and ask has its own flag (phoneShareAsk): phoneTools alone never turns it on
    expect(on.body.shareAsk).toBe(false);
    expect((await api("PATCH", "/api/config", { features: { phoneTools: false } })).status).toBe(200);
    try {
      const off = await ask();
      expect(off.body).toEqual({ offered: false, flag: false, shareAsk: false });
    } finally {
      expect((await api("PATCH", "/api/config", { features: { phoneTools: true } })).status).toBe(200);
    }
    expect((await ask()).body.flag).toBe(true);
  });

  it("every phone route refuses the desktop secret, the companion's launch proof, a bare door token and a scope without a device", async () => {
    const routes: Array<[string, string]> = [
      ["PUT", "/api/phones/self"], ["GET", "/api/phones/self/jobs"], ["GET", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001"],
      ["POST", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001/lease"], ["POST", "/api/phones/self/foreground"], ["DELETE", "/api/phones/self"],
    ];
    const callers: Array<[string, Record<string, string>]> = [
      ["desktop secret", headers], ["companion proof", companion],
      ["bare door token", { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR }],
      ["scope without device", { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-scope": "jobs" }],
      ["wrong scope", { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-device": DEVICE, "x-murage-phone-scope": "owner-phone" }],
    ];
    for (const [who, extra] of callers) for (const [method, path] of routes) {
      const res = await api(method, path, method === "GET" ? undefined : {}, extra);
      expect(res.status, `${who} ${method} ${path}`).toBe(403);
    }
    expect((await phone("GET", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001")).body).toEqual({ handled: true, reason: "unknown" });
    // the companion routes take the launch proof only; the desktop lists
    // (a caller that proved nothing gets the plain 404 a companion route gives, the companion on a desktop route the 403)
    expect([403, 404]).toContain((await api("POST", "/api/phones/revoke", { deviceId: DEVICE, reason: "removed" }, envelope(DEVICE))).status);
    expect((await api("GET", "/api/phones", undefined, companion)).status).toBe(403);
    expect(((await api("GET", "/api/phones")).body.phones as any[]).map((p) => p.deviceId)).toContain(DEVICE);
  }, 60000);

  it("narrowing a grant ends only that bot's jobs for the dropped capability: leased as may have run, queued as did not run", async () => {
    const bot = await createBot("Jobs narrow", { calendar: "read", reminders: "read" });
    const bystander = await createBot("Jobs bystander", { calendar: "read" });
    const tokenA = await holdTurn(bot, "turn for the narrowed bot");
    const tokenB = await holdTurn(bystander, "turn for the bystander");
    // the first calendar job is the head job: the phone takes it and leases it, so every later job waits behind it
    const leased = deviceCall(tokenA, CAL);
    const head = (await phone("GET", "/api/phones/self/jobs")).body.jobs[0];
    expect(head.action).toBe("calendar.read");
    expect((await phone("POST", `/api/phones/self/jobs/${head.operationId}/lease`, { offerId: head.offerId })).body.active).toBe(true);
    const queuedCalendar = deviceCall(tokenA, CAL);
    const queuedReminders = deviceCall(tokenA, REM);
    const bystanderCalendar = deviceCall(tokenB, CAL);
    await quiet(800);
    // narrowing: calendar goes, reminders stays
    expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: { reminders: "read" } })).status).toBe(200);
    expect((await leased).body).toMatchObject({ ok: false, code: "timeout" }); // may have run
    expect((await queuedCalendar).body).toMatchObject({ ok: false, code: "denied" }); // did not run
    expect(await state(queuedReminders)).toBe("pending");
    expect(await state(bystanderCalendar)).toBe("pending");
    // widening or re-sending the same grant revokes nothing; dropping the last capability ends the rest; the bystander's job is left alone
    expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: { reminders: "read" } })).status).toBe(200);
    expect(await state(queuedReminders)).toBe("pending"); // re-sending the grant revoked nothing
    expect((await api("PATCH", `/api/bots/${bot.id}`, { phoneApps: {} })).status).toBe(200);
    expect((await queuedReminders).body).toMatchObject({ ok: false, code: "denied" });
    expect(await state(bystanderCalendar)).toBe("pending");
    release(); await quiet(500); release();
    await idle(bot.id); await idle(bystander.id);
    expect((await bystanderCalendar).status).toBeGreaterThan(0);
  }, 180000);

  it("a job completes through the real routes: poll, lease, result; the thread gets one activity row that names the action and the phone, never the contents", async () => {
    const bot = await createBot("Jobs complete", { calendar: "read" });
    const token = await holdTurn(bot, "turn that reads the calendar");
    const call = deviceCall(token, CAL);
    const offer = (await phone("GET", "/api/phones/self/jobs")).body.jobs[0];
    expect(offer).toMatchObject({ action: "calendar.read", capability: "calendar", bot: { id: bot.id } });
    const byRef = await phone("GET", `/api/phones/self/jobs?eventRef=${createHash("sha256").update("murage-phone-job-event-ref/1\n" + offer.operationId).digest("hex")}`);
    expect(byRef.status).toBe(200);
    const lease = (await phone("POST", `/api/phones/self/jobs/${offer.operationId}/lease`, { offerId: (byRef.body.jobs?.[0] ?? offer).offerId })).body;
    expect(lease.active).toBe(true);
    expect((await phone("GET", `/api/phones/self/jobs/${offer.operationId}`)).body).toMatchObject({ leased: true });
    const result = { leaseToken: lease.leaseToken, ok: true, result: { events: [{ id: "ev-1", title: "Standup SECRET-TITLE", start: "2026-10-27T09:00:00-07:00", end: "2026-10-27T09:15:00-07:00", allDay: false, calendar: "Work", location: "Room 4", notes: "Bring the numbers" }], truncated: false } };
    expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, result)).status).toBe(200);
    const done = (await call).body;
    expect(done.ok).toBe(true);
    expect(JSON.parse(done.text).phone).toBeTruthy();
    expect((await phone("GET", `/api/phones/self/jobs/${offer.operationId}`)).body).toEqual({ handled: true, reason: "done" });
    const rows = (await messages(bot.threadId)).filter((m) => m.kind === "activity" && /on the iPhone$/.test(m.tool?.name ?? ""));
    expect(rows.map((m) => m.tool.name)).toEqual(["Read your calendar on the iPhone"]);
    expect(JSON.stringify(await messages(bot.threadId))).not.toContain("SECRET-TITLE");
    // a late second answer for the same job is refused
    expect((await phone("POST", `/api/phones/self/jobs/${offer.operationId}/result`, result)).status).toBe(409);
    release(); await idle(bot.id);
  }, 120000);

  it("the barrier: after a revoke every phone route refuses the device even with a valid door envelope, across a restart, until minted", async () => {
    const bot = await createBot("Jobs barrier", { calendar: "read" });
    const token = await holdTurn(bot, "turn that is open when the phone is removed");
    const call = deviceCall(token, CAL);
    const offer = (await phone("GET", "/api/phones/self/jobs")).body.jobs[0];
    expect(offer).toBeTruthy();
    const revoked = await api("POST", "/api/phones/revoke", { deviceId: DEVICE, reason: "removed" }, companion);
    expect(revoked).toMatchObject({ status: 200, body: { revoked: 1 } });
    expect((await call).body).toMatchObject({ ok: false, code: "denied" });
    release(); await idle(bot.id);
    const registration = JSON.parse(readFileSync(join(SERVER_DIR, "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8")).registration.valid;
    const refuseAll = async () => {
      const op = offer.operationId;
      for (const [method, path, body] of [
        ["PUT", "/api/phones/self", registration], ["GET", "/api/phones/self/jobs", undefined], ["GET", `/api/phones/self/jobs/${op}`, undefined],
        ["POST", `/api/phones/self/jobs/${op}/lease`, { offerId: offer.offerId }], ["POST", `/api/phones/self/jobs/${op}/decline`, { offerId: offer.offerId }],
        ["POST", `/api/phones/self/jobs/${op}/result`, { leaseToken: "x".repeat(43), ok: true }], ["POST", "/api/phones/self/foreground", { active: false }],
      ] as const) {
        const res = await phone(method, path, body);
        expect({ path, status: res.status, body: res.body }, `${method} ${path}`).toEqual({ path, status: 403, body: { error: "revoked" } });
      }
    };
    await refuseAll();
    expect(((await api("GET", "/api/phones")).body.phones as any[]).map((p) => p.deviceId)).not.toContain(DEVICE);
    // a bot turn that would use the phone gets no phone tools: the registration is gone
    const bare = await createBot("Jobs barrier after", { calendar: "read" });
    expect((await api("POST", `/api/bots/${bare.id}/messages`, { threadId: bare.threadId, text: "after the revoke", sendId: `phone-s14-${Date.now()}-${++counter}-padding` })).status).toBe(202);
    await expect.poll(() => dumpRows(bare.threadId).length, { timeout: 30000 }).toBe(1);
    expect(dumpRows(bare.threadId)[0].phoneJobs).toBeUndefined();
    await idle(bare.id);
    // the barrier is on messages.db: a restarted harness still refuses
    await fixture.restart();
    await connect();
    await refuseAll();
    // only minted ends it; the unrelated device is never affected
    expect((await phone("PUT", "/api/phones/self", registration, "33333333-3333-4333-8333-333333333333")).status).toBe(200);
    expect([403, 404]).toContain((await api("POST", "/api/phones/minted", { deviceId: DEVICE }, envelope(DEVICE))).status);
    expect(await api("POST", "/api/phones/minted", { deviceId: DEVICE }, companion)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await phone("PUT", "/api/phones/self", registration)).status).toBe(200);
    expect(((await api("GET", "/api/phones")).body.phones as any[]).map((p) => p.deviceId)).toContain(DEVICE);
    // switch-off from the phone bars it the same way, and a second switch-off is still 200
    expect((await phone("DELETE", "/api/phones/self")).status).toBe(200);
    expect((await phone("DELETE", "/api/phones/self")).status).toBe(200);
    expect((await phone("PUT", "/api/phones/self", registration)).status).toBe(403);
  }, 240000);
});
