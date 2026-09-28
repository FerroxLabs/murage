// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane T, speaker-only locking (O2). A chat round used to hold every
// responder for the whole round, so a teammate still waiting its turn could
// not take a direct message or a handoff: "this thread or its group is
// already working", or a handoff cancelled after three retries while that
// teammate sat idle in the same room. The round now holds a member only
// while it speaks.
//
// Real server: the first responder is on a fake pi engine held at its session
// handshake (FAKE_PI_SESSION_GATE), the second on the ordinary fixture.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
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
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("lets a teammate waiting in the round take a direct message, while the speaker stays held", async () => {
    const bot = async (name: string, instanceId: string) => {
      const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
      const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
      expect(created.status).toBe(201);
      const made = created.body.bot as { id: string; threadId: string };
      expect((await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
      return made;
    };
    const first = await bot("Quinn", "piGate"), second = await bot("Tess", "verification");
    const created = await api("POST", "/api/groups", { name: "Office", memberIds: [first.id, second.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };

    // Quinn speaks first and is held at the provider handshake.
    rmSync(gate, { force: true });
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Both of you: one line each." })).status).toBe(202);
    await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
    expect((await groupState(room.id)).busyBotId).toBe(first.id);

    const answered = async (threadId: string, text: string) => {
      const thread = await messages(threadId);
      const asked = thread.findIndex(message => message.role === "user" && message.text === text);
      return asked >= 0 && thread.slice(asked + 1).some(message => message.role === "bot" && message.kind === "text" && message.text);
    };
    // Tess is only waiting her turn: a direct message to her runs now, while
    // Quinn is still speaking, instead of waiting for the whole round.
    expect((await api("POST", `/api/bots/${second.id}/messages`, { threadId: second.threadId, text: "quick one while you wait" })).status).toBeLessThan(300);
    await expect.poll(() => answered(second.threadId, "quick one while you wait"), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(second.id)).busy, { timeout: 20000 }).toBe(false);
    // The speaker is still held: its own chat waits for the room turn.
    expect((await api("POST", `/api/bots/${first.id}/messages`, { threadId: first.threadId, text: "are you there?" })).status).toBeLessThan(300);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(await answered(first.threadId, "are you there?")).toBe(false);
    expect((await groupState(room.id)).busyBotId).toBe(first.id);

    // The round then carries on: Quinn answers, then Tess.
    writeFileSync(gate, "");
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 20000 }).toBe(true);
    const spoke = (await messages(room.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text).map(message => message.from?.botId);
    expect(spoke).toEqual([first.id, second.id]);
    expect((await messages(room.threadId)).some(message => typeof message.tool?.name === "string" && message.tool.name.includes("skipped this round"))).toBe(false);
  }, 90000);
});
