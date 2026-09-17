// Replying to a bot's message in a channel addresses that bot: it answers,
// not the room's lead, unless the reply text @mentions someone. The same
// routing applies to a reply sent while the channel was busy (queued by the
// server, then drained when the running turn settles).
//
// Real server with the repository's fake Claude CLI: the lead runs on a
// held instance (its turns stay open until the test releases them), the
// replied-to member on the ordinary happy instance.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const createBot = async (name: string, instanceId: string) => {
  const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === instanceId).models.options;
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: models[0].id } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};

posixOnly("channel reply routing", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 44_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.hold={driver:'claudeAgent',displayName:'Hold fixture',config:{cli:${JSON.stringify(join(SERVER_DIR, "testing", "fake-claude-cli.ts"))}},environment:{FAKE_CLAUDE_MODE:'hang',FAKE_CLAUDE_DUMP_EACH_TURN:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("answers a direct and a queued reply to a member with that member, not the lead", async () => {
    const lead = await createBot("Reply lead", "hold"), member = await createBot("Reply member", "verification");
    const createdRoom = await api("POST", "/api/groups", { name: "Reply room", memberIds: [lead.id, member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(createdRoom.status).toBe(201);
    const room = createdRoom.body.group as { id: string; threadId: string };
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
    const leadPrompt = (needle: string): number | undefined => {
      if (!existsSync(dumpFile)) return undefined;
      const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { pid: number; prompt: unknown; env: Record<string, string> };
      return dump.env.FAKE_CLAUDE_MODE === "hang" && JSON.stringify(dump.prompt).includes(needle) ? dump.pid : undefined;
    };

    // The member speaks once, by explicit mention.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Reply member say something" })).status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 20000 }).toBe(1);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const memberMessage = (await replies(room.threadId))[0];
    expect(memberMessage.from.botId).toBe(member.id);

    // Direct: a reply to the member's message, no mention. Had the held lead
    // been chosen, the room would never become idle.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "what did you mean?", replyToId: memberMessage.id })).status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 20000 }).toBe(2);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    expect((await replies(room.threadId))[1].from.botId).toBe(member.id);

    // Queued: the lead is held on an ordinary message; a reply to the member
    // sent meanwhile is queued, then drained when the lead's turn settles.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds this" })).status).toBe(202);
    await expect.poll(() => leadPrompt("lead holds this"), { timeout: 20000 }).toEqual(expect.any(Number));
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "and this one?", replyToId: memberMessage.id });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    writeFileSync(join(fixture.info.dataDir, "finish-fake", String(leadPrompt("lead holds this"))), "");
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 20000 }).toBe(3);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    expect((await replies(room.threadId))[2].from.botId).toBe(member.id);
    const thread = await messages(room.threadId);
    expect(thread.find(message => message.role === "user" && message.text === "and this one?")?.replyToId).toBe(memberMessage.id);
  }, 90000);
});
