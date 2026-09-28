// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A handoff queued in an "Everyone responds" channel to a teammate who is
// next in line in that same channel (0.1.60 Linux re-test 4, L4-1).
//
// Ember speaks first and delegates to Maple. Maple is still part of the
// room's turn, so the handoff parks ("waiting: they're busy"). When Maple's
// room reply settles, the room operation is still open for a moment, so
// the retry found Maple "busy" once more, parked again ("retry 2/3"), and
// nothing ever woke it: Maple was idle, the channel was idle, and the
// handoff sat there until a restart. Meanwhile the parked handoff counted
// as running work, so Back up now said "Murage was busy" with nothing to
// stop.
//
// Real server with the repository's fake CLIs: Ember on a fake ACP engine
// that calls delegate_bot, Maple on the ordinary happy fixture.
import { randomUUID } from "node:crypto";
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

posixOnly("a handoff to a teammate who was next in the same channel", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 45_000, span: 900 },
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

  it("runs the handoff once the teammate is free, and never holds up a backup while it only waits", async () => {
    // Only the two of them on the roster, so list_bots names Maple.
    for (const bot of (await api("GET", "/api/bots?messages=0")).body.bots) {
      await api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
    }
    const ember = await createBot("Ember", "delegator");
    const maple = await createBot("Maple", "verification");
    const createdRoom = await api("POST", "/api/groups", { name: "duo-room", memberIds: [ember.id, maple.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
    expect(createdRoom.status, JSON.stringify(createdRoom.body)).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Each of you: reply with one line. Ember first, then Maple." })).status).toBe(202);

    // Maple's delegated reply reaches the channel without any other event.
    const replied = async () => (await messages(room.threadId)).some((message) =>
      message.kind === "text" && typeof message.text === "string" && message.text.startsWith("@Maple replied to the delegated task"));
    await expect.poll(replied, { timeout: 30000 }).toBe(true).catch(async (error) => {
      const lines = (await messages(room.threadId)).map((message) => message.tool?.name ?? `${message.from?.name ?? message.role}: ${String(message.text ?? "").slice(0, 60)}`);
      throw new Error(`${error}\n${lines.join("\n")}`);
    });

    // Maple's room reply releasing it while the room still held Maple no
    // longer spends a retry, and no waiting line still offers Stop.
    const transcript = await messages(room.threadId);
    expect(transcript.some((message) => message.tool?.name?.includes("retry 2/"))).toBe(false);
    // Maple, still waiting her turn when Ember handed off, is held until her
    // own room reply: the handoff never costs her that turn (0.1.61 lane T).
    expect(transcript.some((message) => message.tool?.name?.includes("skipped this round"))).toBe(false);
    expect(transcript.some((message) => message.kind === "text" && message.from?.botId === maple.id && !String(message.text).startsWith("@Maple replied"))).toBe(true);
    expect(transcript.filter((message) => message.delegationWait)).toEqual([]);

    // And nothing is left that could hold a backup.
    const token = randomUUID();
    await expect.poll(async () => (await api("POST", "/api/backup-restart", { action: "prepare", token, occasion: "manual" })).status, { timeout: 20000 }).toBe(200);
    expect((await api("POST", "/api/backup-restart", { action: "cancel", token })).body).toEqual({ released: true });
  }, 90000);
});
