// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane T2, gap 2: a teammate's delegated reply is copied into the
// room that asked and into the pair room. Each copy names the original
// reply (Message.copyOf), so forgetting what the original used withholds
// the copies from bots too (room-withheld-recall.test.ts covers the rule).
//
// Real server with the repository's fake CLIs: Ember on a fake ACP engine
// that calls delegate_bot, Maple on the ordinary happy fixture.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const createBot = async (name: string, instanceId: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

posixOnly("a delegated reply copied into the room and the pair room", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 46_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.delegator={driver:'grokAgent',displayName:'Delegator fixture',environment:{FAKE_ACP_MODE:'delegate-peer'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("links each copy to the teammate's own reply, so it is withheld whenever that reply is", async () => {
    for (const bot of (await api("GET", "/api/bots?messages=0")).body.bots) {
      await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
    }
    const ember = await createBot("Ember", "delegator");
    const maple = await createBot("Maple", "verification");
    const createdRoom = await api("POST", "/api/groups", { name: "copy-room", memberIds: [ember.id, maple.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(createdRoom.status, JSON.stringify(createdRoom.body)).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Each of you: reply with one line. Ember first, then Maple." })).status).toBe(202);

    const copyInRoom = async () => (await messages(room.threadId)).find((message) =>
      message.kind === "text" && typeof message.text === "string" && message.text.startsWith("@Maple replied to the delegated task"));
    await expect.poll(async () => Boolean(await copyInRoom()), { timeout: 30000 }).toBe(true);
    const roomCopy = await copyInRoom();
    expect(roomCopy.copyOf?.messageIds?.length).toBeGreaterThan(0);
    // the original is Maple's own reply in the thread the handoff ran in
    const original = (await messages(roomCopy.copyOf.threadId)).find((message) => message.id === roomCopy.copyOf.messageIds[0]);
    expect(original).toMatchObject({ role: "bot", kind: "text" });
    expect(roomCopy.copyOf.threadId).not.toBe(room.threadId);
    expect(roomCopy.text).toContain(original.text);

    // the pair room's copy carries the same link
    const pair = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.dm && group.memberIds.includes(ember.id) && group.memberIds.includes(maple.id));
    expect(pair).toBeTruthy();
    const pairCopy = (await messages(pair.threadId)).find((message) => message.kind === "text" && message.from?.botId === maple.id);
    expect(pairCopy?.copyOf).toEqual(roomCopy.copyOf);
  }, 90000);
});
