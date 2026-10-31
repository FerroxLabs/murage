// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-off that a quit or a restart cuts short carries on by itself on the new server.
//
// The hand-off here only waits on a busy teammate when the server closes. Closing ends the teammate's turn, so the old process used to wake the
// hand-off and spend all its retries in a few milliseconds on an engine fleet that was already being disposed: it ended "This didn't start for @X. Send again
// or dismiss it.", the asking bot was never woken and the chain stalled until the owner pressed a button.
//
// Real server, real restart (SIGTERM), fake ACP engines. The teammate's engine holds its turn at a file gate.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const HELD = /didn't start for|Send again/;
const posixOnly = describe.skipIf(process.platform === "win32");

let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const signIn = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const line = (message: any) => String(message.tool?.name ?? message.text ?? "");
const dump = async (...threads: string[]) => (await Promise.all(threads.map(async thread => (await messages(thread)).map(message => `${thread.slice(0, 6)} ${message.role}/${message.kind} ${line(message).slice(0, 110)}`)))).flat().join("\n");
const createBot = async (name: string, instanceId: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
const leadGate = () => join(fixture.info.dataDir, "lead-gate");
const onlyThese = async (...ids: string[]) => {
  for (const bot of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${bot.id}`, { hidden: !ids.includes(bot.id) });
};
const busy = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id)?.busy === true;
const rows = (sql: string, ...args: string[]) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare(sql).all(...args) as any[]; } finally { db.close(); }
};
/** Every start of the hand-off mirrors one exchange into the teammate's conversation, so this counts launches. */
const launches = (rendered: any[]) => rendered.filter(message => /Message from @/.test(line(message))).length;

posixOnly("a hand-off cut short by a quit or a restart", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 44_000, span: 900 }, readyTimeoutMs: 90_000,
      instrumentationSource: `
      process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const fs=await import('node:fs');const path=await import('node:path');
      const data=process.env.MURAGE_DATA_DIR;const file=path.join(data,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const ready={FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized'};
      const cli=${JSON.stringify(FAKE_ACP)};
      cfg.instances.lead={driver:'grokAgent',displayName:'Lead fixture',environment:{...ready,FAKE_ACP_MODE:'delegate-peer',FAKE_ACP_PROMPT_DUMP:path.join(data,'lead-prompt.json')},config:{cli,fullAuto:true}};
      cfg.instances.gated={driver:'grokAgent',displayName:'Gated fixture',environment:{...ready,FAKE_ACP_MODE:'echo-gated',FAKE_ACP_GATE_FILE:path.join(data,'teammate-gate')},config:{cli,fullAuto:true}};
      cfg.instances.gatedLead={driver:'grokAgent',displayName:'Gated lead fixture',environment:{...ready,FAKE_ACP_MODE:'echo-gated',FAKE_ACP_GATE_FILE:path.join(data,'lead-gate')},config:{cli,fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "teammate-gate");
    await signIn();
  }, 120_000);
  afterAll(async () => { if (fixture) { writeFileSync(gate, "go"); writeFileSync(leadGate(), "go"); await fixture.close(); } });
  afterEach(async () => {
    // the teammate is held again for the next case, once nothing is running on the fixture
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.some((bot: any) => bot.busy), { timeout: 30_000 }).toBe(false);
    rmSync(gate, { force: true });
    rmSync(leadGate(), { force: true });
  }, 40_000);

  /** The teammate is busy with the owner's work, and a hand-off is parked on it. */
  const parkOn = async (helper: { id: string; threadId: string }, leadThread: string, ask: () => Promise<void>) => {
    expect((await api("POST", `/api/bots/${helper.id}/messages`, { text: "owner's own long job" })).status).toBe(202);
    await expect.poll(() => busy(helper.id), { timeout: 30_000 }).toBe(true);
    await ask();
    await expect.poll(async () => (await messages(leadThread)).some(message => /they're busy \(retry 1\//.test(line(message))), { timeout: 30_000 }).toBe(true);
  };
  const reachesAsker = (threadId: string, name: string) => expect.poll(async () => (await messages(threadId)).some(message => message.kind === "text" && line(message).startsWith(`@${name} replied to the delegated task`)), { timeout: 60_000 });

  it("a hand-off parked on a busy teammate runs on the new server, once, and wakes the bot that asked", async () => {
    const leadPrompt = join(fixture.info.dataDir, "lead-prompt.json");
    const lead = await createBot("Lead", "lead"), helper = await createBot("Helper", "gated");
    await onlyThese(lead.id, helper.id);
    await parkOn(helper, lead.threadId, async () => { expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "please pick this up" })).status).toBe(202); });

    rmSync(leadPrompt, { force: true });   // from here only the wake writes it
    await fixture.restart();
    await signIn();
    writeFileSync(gate, "go");

    await reachesAsker(lead.threadId, "Helper").toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId, helper.threadId)}\n${JSON.stringify(rows("SELECT id, phase, start_attempts, submitted_at, item FROM pending_delegations"))}`); });
    const leadLines = await messages(lead.threadId);
    expect(leadLines.filter(message => HELD.test(line(message))).map(line)).toEqual([]);
    expect(rows("SELECT id FROM pending_delegations")).toEqual([]);
    // it ran once: one exchange in the teammate's conversation, and the same one on the old server never got past the wait
    expect(launches(await messages(helper.threadId)), await dump(helper.threadId)).toBe(1);
    expect(leadLines.some(message => /retry 2\//.test(line(message))), await dump(lead.threadId)).toBe(false);
    // the asker was woken with the result: the turn the wake starts hands its engine the teammate's words
    await expect.poll(() => existsSync(leadPrompt) && /echo:/.test(readFileSync(leadPrompt, "utf8")), { timeout: 30_000 }).toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId)}`); });
  }, 180_000);

  it("a hand-off a team room made, parked on a busy teammate, runs on the new server and answers in the room", async () => {
    const lead = await createBot("RoomLead", "lead"), helper = await createBot("RoomHelper", "gated");
    await onlyThese(lead.id, helper.id);
    const made = await api("POST", "/api/groups", { name: "shutdown-room", memberIds: [lead.id, helper.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const room = made.body.group as { id: string; threadId: string };
    await parkOn(helper, room.threadId, async () => { expect([200, 202]).toContain((await api("POST", `/api/groups/${room.id}/messages`, { text: "please pick this up" })).status); });
    expect(rows("SELECT origin FROM pending_delegations WHERE to_bot_id=?", helper.id).map(row => row.origin)).toEqual(["room"]);

    await fixture.restart();
    await signIn();
    writeFileSync(gate, "go");

    await reachesAsker(room.threadId, "RoomHelper").toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(room.threadId, helper.threadId)}\n${JSON.stringify(rows("SELECT id, phase, origin, start_attempts, item FROM pending_delegations"))}\n${JSON.stringify(rows("SELECT id, verb, state, outcome_note, parent_id FROM room_requests ORDER BY created_at"))}`); });
    expect((await messages(room.threadId)).filter(message => HELD.test(line(message))).map(line)).toEqual([]);
    expect(launches(await messages(helper.threadId)), await dump(helper.threadId)).toBe(1);
  }, 180_000);

  it("a hand-off that is shared work, waiting on a busy shared teammate, runs on the new server, once", async () => {
    const lead = await createBot("SharedLead", "lead"), helper = await createBot("SharedHelper", "gated");
    await onlyThese(lead.id, helper.id);
    expect((await api("PATCH", `/api/bots/${lead.id}`, { section: "Sales", approvePeerComms: false })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${helper.id}`, { section: "Design", approvePeerComms: false })).status).toBe(200);
    await fixture.stop();
    const file = join(fixture.info.dataDir, "bots.json"), bots = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(bots.find((bot: any) => bot.id === helper.id), { sharedWith: { mode: "all", teams: [] }, partitionedAt: Date.now() });
    Object.assign(bots.find((bot: any) => bot.id === lead.id), { chiefOfStaff: true });
    writeFileSync(file, JSON.stringify(bots));
    await fixture.restart();
    await signIn();

    expect((await api("POST", `/api/bots/${helper.id}/messages`, { text: "owner's own long job" })).status).toBe(202);
    await expect.poll(() => busy(helper.id), { timeout: 30_000 }).toBe(true);
    expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "please pick this up" })).status).toBe(202);
    await expect.poll(() => rows("SELECT origin FROM pending_delegations WHERE to_bot_id=?", helper.id).map(row => row.origin), { timeout: 30_000 }).toEqual(["shared"]);

    await fixture.restart();
    await signIn();
    writeFileSync(gate, "go");

    const detail = async () => `${await dump(lead.threadId, helper.threadId)}\n${JSON.stringify(rows("SELECT id, phase, origin, start_attempts, item FROM pending_delegations"))}\n${JSON.stringify(rows("SELECT id, verb, state, outcome_note, refusal FROM room_requests ORDER BY created_at"))}`;
    await expect.poll(() => rows("SELECT id FROM pending_delegations WHERE to_bot_id=?", helper.id).length, { timeout: 60_000 }).toBe(0).catch(async error => { throw new Error(`${error}\n${await detail()}`); });
    expect((await messages(lead.threadId)).filter(message => HELD.test(line(message))).map(line)).toEqual([]);
    expect(rows("SELECT state FROM room_requests WHERE to_bot_id=? AND verb='ask'", helper.id).map(row => row.state), await detail()).toEqual(["done"]);
  }, 180_000);

  it("after a crash, with no close at all, the parked hand-off runs on the new server, once", async () => {
    const lead = await createBot("CrashLead", "lead"), helper = await createBot("CrashHelper", "gated");
    await onlyThese(lead.id, helper.id);
    await parkOn(helper, lead.threadId, async () => { expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "please pick this up" })).status).toBe(202); });

    fixture.child.kill("SIGKILL");
    await fixture.restart();
    await signIn();
    writeFileSync(gate, "go");

    await reachesAsker(lead.threadId, "CrashHelper").toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId, helper.threadId)}`); });
    expect((await messages(lead.threadId)).filter(message => HELD.test(line(message))).map(line)).toEqual([]);
    expect(launches(await messages(helper.threadId)), await dump(helper.threadId)).toBe(1);
  }, 180_000);

  /** The asker moves on to another job of the owner's, on an engine held at its own gate, after its hand-off is parked. */
  const askerBusyAgain = async (lead: { id: string; threadId: string }) => {
    await expect.poll(() => busy(lead.id), { timeout: 30_000 }).toBe(false);
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "gatedLead").models.options;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { modelSelection: { instanceId: "gatedLead", model: models[0].id } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "owner's next job" })).status).toBe(202);
    await expect.poll(() => busy(lead.id), { timeout: 30_000 }).toBe(true);
  };
  /** The wake's prompt carries the teammate's reply, and the gated engine echoes it. */
  const wokenWithReply = (threadId: string) => expect.poll(async () => (await messages(threadId)).some(message => message.kind === "text" && /^echo:/.test(line(message)) && /replied/.test(line(message))), { timeout: 60_000 });

  it("the asker is busy on its next job when the server closes: the hand-off still runs and the asker is still woken", async () => {
    const lead = await createBot("BusyLead", "lead"), helper = await createBot("BusyHelper", "gated");
    await onlyThese(lead.id, helper.id);
    await parkOn(helper, lead.threadId, async () => { expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "please pick this up" })).status).toBe(202); });
    await askerBusyAgain(lead);

    await fixture.restart();
    await signIn();
    writeFileSync(gate, "go");
    writeFileSync(leadGate(), "go");

    await reachesAsker(lead.threadId, "BusyHelper").toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId, helper.threadId)}`); });
    await wokenWithReply(lead.threadId).toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId)}`); });
    expect(launches(await messages(helper.threadId)), await dump(helper.threadId)).toBe(1);
  }, 180_000);

  it("a wake the asker is already owed when the server closes is not spent: it wakes the asker on the new server", async () => {
    const lead = await createBot("OwedLead", "lead"), helper = await createBot("OwedHelper", "gated");
    await onlyThese(lead.id, helper.id);
    await parkOn(helper, lead.threadId, async () => { expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: "please pick this up" })).status).toBe(202); });
    await askerBusyAgain(lead);
    writeFileSync(gate, "go");                                   // the teammate finishes and answers while the asker is still busy
    await reachesAsker(lead.threadId, "OwedHelper").toBe(true);

    await fixture.restart();
    await signIn();
    writeFileSync(leadGate(), "go");

    await wokenWithReply(lead.threadId).toBe(true).catch(async error => { throw new Error(`${error}\n${await dump(lead.threadId)}`); });
  }, 180_000);
});
