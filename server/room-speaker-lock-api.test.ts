// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 room transcript fix (O2). A chat round held every responder until the whole
// round ended, so a teammate that had already answered could not take a
// direct message or a handoff while the others were still speaking: the
// handoff parked ("waiting, they're busy"), and in a long round was
// cancelled after three retries. The round now releases each responder when
// its own turn ends. One still waiting its turn stays held, so a handoff
// never makes it miss its own room reply ("busy in another conversation:
// skipped this round").
//
// Real server: the last responder is on a fake pi engine held at its session
// handshake (FAKE_PI_SESSION_GATE), so the round is provably still running.
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);

posixOnly("a chat round holds only the member that is speaking", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate')}};
      cfg.instances.delegator={driver:'grokAgent',displayName:'Delegator fixture',environment:{FAKE_ACP_MODE:'delegate-peer'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const bot = async (name: string, instanceId: string) => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
    expect(created.status).toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return made;
  };
  const answered = async (threadId: string, text: string) => {
    const thread = await messages(threadId);
    const asked = thread.findIndex(message => message.role === "user" && message.text === text);
    return asked >= 0 && thread.slice(asked + 1).some(message => message.role === "bot" && message.kind === "text" && message.text);
  };
  const skipped = async (threadId: string) => (await messages(threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("skipped this round"));

  it("lets a member that has answered take a direct message while the round goes on, and holds the one still to speak", async () => {
    const tess = await bot("Tess", "verification"), quinn = await bot("Quinn", "piGate");
    const created = await api("POST", "/api/groups", { name: "Office", memberIds: [tess.id, quinn.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };

    // Tess answers first; Quinn is then held at the provider handshake.
    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Both of you: one line each." })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    expect((await groupState(room.id)).busyBotId).toBe(quinn.id);

    // Tess has answered: a direct message to her runs now, not after the round.
    expect((await api("POST", `/api/bots/${tess.id}/messages`, { threadId: tess.threadId, text: "quick one after your line" })).status).toBeLessThan(300);
    await expect.poll(() => answered(tess.threadId, "quick one after your line"), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(tess.id)).busy, { timeout: 20000 }).toBe(false);
    // Quinn is still speaking: her own chat waits for the room turn.
    expect((await api("POST", `/api/bots/${quinn.id}/messages`, { threadId: quinn.threadId, text: "are you there?" })).status).toBeLessThan(300);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await answered(quinn.threadId, "are you there?")).toBe(false);
    expect((await groupState(room.id)).busyBotId).toBe(quinn.id);

    writeFileSync(gate, "");
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 20000 }).toBe(true);
    const spoke = (await messages(room.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text).map(message => message.from?.botId);
    expect(spoke).toEqual([tess.id, quinn.id]);
    expect(await skipped(room.threadId)).toBe(false);
  }, 90000);

  it("runs a handoff to a teammate right after that teammate's own room reply, while the round is still going", async () => {
    // The roster lists the newest bot first, so list_bots names Maple first
    // to Ember and the delegator hands off to her.
    for (const existing of (await api("GET", "/api/bots?messages=0")).body.bots) await api("PATCH", `/api/bots/${existing.id}`, { hidden: true });
    const quinn = await bot("Quinn", "piGate"), maple = await bot("Maple", "verification"), ember = await bot("Ember", "delegator");
    const created = await api("POST", "/api/groups", { name: "Trio", memberIds: [ember.id, maple.id, quinn.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const room = created.body.group as { id: string; threadId: string };

    rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Each of you: one line, in turn." })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 20000 }).toBe(true);
    // Quinn, last, is still speaking; Maple's handoff has already run.
    const delegated = async () => (await messages(room.threadId)).some(message => message.kind === "text" && typeof message.text === "string" && message.text.startsWith("@Maple replied to the delegated task"));
    await expect.poll(delegated, { timeout: 30000 }).toBe(true).catch(async (error) => {
      throw new Error(`${error}\n${(await messages(room.threadId)).map(message => `${message.from?.name ?? message.role}: ${message.tool?.name ?? String(message.text ?? "").slice(0, 80)}`).join("\n")}`);
    });
    expect((await groupState(room.id)).busyBotId).toBe(quinn.id);

    writeFileSync(gate, "");
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 20000 }).toBe(true);
    const thread = await messages(room.threadId);
    // Maple answered in the room herself: the handoff never cost her that turn
    expect(thread.some(message => message.role === "bot" && message.kind === "text" && message.from?.botId === maple.id && !String(message.text).startsWith("@Maple replied"))).toBe(true);
    expect(await skipped(room.threadId)).toBe(false);
    expect(thread.some(message => /retry 2\//.test(message.tool?.name ?? ""))).toBe(false);
  }, 120000);
});
