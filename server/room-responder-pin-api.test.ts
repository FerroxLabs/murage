// A room-call hand-down reaches ONLY the member who made it: the client pins
// the send with `responderId`, and the server routes to that member alone,
// whatever @mentions, @everyone or names the text carries (final-review I1).
// A pin for someone outside the room is refused. Real server, fake Claude CLI;
// the lead runs on a held instance so a wrongly routed send would leave the
// room busy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
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

posixOnly("room responder pin", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 44_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.hold={driver:'claudeAgent',displayName:'Hold fixture',config:{cli:${JSON.stringify(join(SERVER_DIR, "testing", "fake-claude-cli.ts"))}},environment:{FAKE_CLAUDE_MODE:'hang',FAKE_CLAUDE_DUMP_EACH_TURN:'1'}};
      cfg.instances.verification.environment={...(cfg.instances.verification.environment??{}),FAKE_CLAUDE_MENTION_MARKER:'MENTIONMARK',FAKE_CLAUDE_MENTION_REPLY:'@Chaintwo over to you.'};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const makeRoom = async () => {
    const lead = await createBot("Pinlead", "hold"), pinned = await createBot("Pintwo", "verification");
    const created = await api("POST", "/api/groups", { name: "Pin room", memberIds: [lead.id, pinned.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(created.status).toBe(201);
    return { lead, pinned, room: created.body.group as { id: string; threadId: string } };
  };

  it("a pinned send containing @Pinlead and @everyone starts only the pinned member", async () => {
    const { lead, pinned, room } = await makeRoom();
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pinlead and @everyone check the deploy", responderId: pinned.id, sendId: "pin_direct_123456" });
    expect(sent.status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 20000 }).toBe(1);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const said = await replies(room.threadId);
    expect(said.map((message) => message.from.botId)).toEqual([pinned.id]);
    expect(said.some((message) => message.from.botId === lead.id)).toBe(false);
  }, 90000);

  it("a pinned send that waits in the queue keeps its pin", async () => {
    const { lead, pinned, room } = await makeRoom();
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
    const leadPrompt = (needle: string): number | undefined => {
      if (!existsSync(dumpFile)) return undefined;
      const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { pid: number; prompt: unknown; env: Record<string, string> };
      return dump.env.FAKE_CLAUDE_MODE === "hang" && JSON.stringify(dump.prompt).includes(needle) ? dump.pid : undefined;
    };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds this" })).status).toBe(202);
    await expect.poll(() => leadPrompt("lead holds this"), { timeout: 20000 }).toEqual(expect.any(Number));
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pinlead @everyone and the queue", responderId: pinned.id, sendId: "pin_queued_123456" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    writeFileSync(join(fixture.info.dataDir, "finish-fake", String(leadPrompt("lead holds this"))), "");
    await expect.poll(async () => (await replies(room.threadId)).some((message) => message.from.botId === pinned.id), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const fromLead = (await replies(room.threadId)).filter((message) => message.from.botId === lead.id);
    expect(fromLead.every((message) => !String(message.text).includes("the queue"))).toBe(true);
    const pinnedReplies = (await replies(room.threadId)).filter((message) => message.from.botId === pinned.id);
    expect(pinnedReplies).toHaveLength(1);
  }, 90000);

  const refreshProof = async () => {
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  };
  const heldLead = (needle: string): number | undefined => {
    const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
    if (!existsSync(dumpFile)) return undefined;
    const dump = JSON.parse(readFileSync(dumpFile, "utf8")) as { pid: number; prompt: unknown; env: Record<string, string> };
    return dump.env.FAKE_CLAUDE_MODE === "hang" && JSON.stringify(dump.prompt).includes(needle) ? dump.pid : undefined;
  };
  const releaseLead = (needle: string) => writeFileSync(join(fixture.info.dataDir, "finish-fake", String(heldLead(needle))), "");

  it("a pinned @everyone send queued behind a busy room reaches only the pinned member after a restart", async () => {
    const { lead, pinned, room } = await makeRoom();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds restart" })).status).toBe(202);
    await expect.poll(() => heldLead("lead holds restart"), { timeout: 20000 }).toEqual(expect.any(Number));
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "@everyone wake up after restart", responderId: pinned.id, sendId: "pin_restart_123456" });
    expect(queued.status).toBe(202);
    expect(queued.body.queued).toBe(true);
    await fixture.restart();
    await refreshProof();
    await expect.poll(async () => (await replies(room.threadId)).some((message) => message.from.botId === pinned.id), { timeout: 30000 }).toBe(true);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
    const said = await replies(room.threadId);
    expect(said.every((message) => message.from.botId === pinned.id)).toBe(true);
    expect(said.some((message) => message.from.botId === lead.id)).toBe(false);
    const all = await messages(room.threadId);
    expect(all.find((message) => message.role === "user" && String(message.text).includes("wake up after restart"))?.responderBotId).toBe(pinned.id);
  }, 120000);

  it("a pinned send queued behind a busy room reaches only the pinned member after a drain", async () => {
    const { lead, pinned, room } = await makeRoom();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds drain" })).status).toBe(202);
    await expect.poll(() => heldLead("lead holds drain"), { timeout: 20000 }).toEqual(expect.any(Number));
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "@everyone drain this", responderId: pinned.id, sendId: "pin_drain_1234567" });
    expect(queued.body.queued).toBe(true);
    releaseLead("lead holds drain");
    await expect.poll(async () => (await replies(room.threadId)).some((message) => message.from.botId === pinned.id), { timeout: 30000 }).toBe(true);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
    const afterDrain = (await replies(room.threadId)).filter((message) => message.from.botId === lead.id && String(message.text).includes("drain this"));
    expect(afterDrain).toEqual([]);
  }, 120000);

  it("a pinned send queued after an ordinary send runs after it", async () => {
    const { pinned, room } = await makeRoom();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds order" })).status).toBe(202);
    await expect.poll(() => heldLead("lead holds order"), { timeout: 20000 }).toEqual(expect.any(Number));
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo first ordinary", sendId: "pin_order_a_123456" })).body.queued).toBe(true);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "second pinned", responderId: pinned.id, sendId: "pin_order_b_123456" })).body.queued).toBe(true);
    releaseLead("lead holds order");
    await expect.poll(async () => (await replies(room.threadId)).filter((message) => message.from.botId === pinned.id).length, { timeout: 40000 }).toBe(2);
    const users = (await messages(room.threadId)).filter((message) => message.role === "user").map((message) => String(message.text));
    expect(users.indexOf("@Pintwo first ordinary")).toBeGreaterThan(-1);
    expect(users.indexOf("@Pintwo first ordinary")).toBeLessThan(users.indexOf("second pinned"));
  }, 120000);

  it("a crash after acceptance, before the member turn starts, recovers to the pinned member only", async () => {
    const { lead, pinned, room } = await makeRoom();
    const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "@everyone crash recovery", responderId: pinned.id, sendId: "pin_crash_12345678" });
    expect(sent.status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 30000 }).toBe(1);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
    await fixture.stop();
    // as if the process ended after the owner message was accepted: no member turn, no reply
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      const user = db.prepare("SELECT id FROM messages WHERE thread_id=? AND role='user' ORDER BY at DESC LIMIT 1").get(room.threadId) as { id: string };
      const root = db.prepare("SELECT id FROM room_requests WHERE verb='owner_send' AND result_message_id=?").get(user.id) as { id: string };
      db.prepare("DELETE FROM room_requests WHERE root_id=? AND id<>?").run(root.id, root.id);
      db.prepare("DELETE FROM messages WHERE thread_id=? AND role='bot'").run(room.threadId);
      db.prepare("UPDATE thread_state SET active_leaf_id=? WHERE thread_id=?").run(user.id, room.threadId);
    } finally { db.close(); }
    await fixture.restart();
    await refreshProof();
    await expect.poll(async () => (await replies(room.threadId)).length, { timeout: 30000 }).toBeGreaterThan(0);
    await expect.poll(async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; }, { timeout: 30000 }).toBe(true);
    const said = await replies(room.threadId);
    expect(said.every((message) => message.from.botId === pinned.id)).toBe(true);
    expect(said.some((message) => message.from.botId === lead.id)).toBe(false);
  }, 120000);

  it("a retry of a send id with a different responder is refused, whichever way it differs", async () => {
    const { lead, pinned, room } = await makeRoom();
    const first = await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity", sendId: "pin_ident_a_123456" });
    expect(first.status).toBe(202);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity", sendId: "pin_ident_a_123456", responderId: pinned.id })).status).toBe(409);
    const second = await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity b", sendId: "pin_ident_b_123456", responderId: pinned.id });
    expect(second.status).toBe(202);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity b", sendId: "pin_ident_b_123456", responderId: lead.id })).status).toBe(409);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity b", sendId: "pin_ident_b_123456" })).status).toBe(409);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Pintwo identity b", sendId: "pin_ident_b_123456", responderId: pinned.id })).status).toBe(202);
  }, 120000);

  it("a retry of a queued pinned send with a different responder is refused", async () => {
    const { lead, pinned, room } = await makeRoom();
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "lead holds ident" })).status).toBe(202);
    await expect.poll(() => heldLead("lead holds ident"), { timeout: 20000 }).toEqual(expect.any(Number));
    const body = { text: "queued identity", sendId: "pin_qident_123456" };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, responderId: pinned.id })).body.queued).toBe(true);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, responderId: lead.id })).status).toBe(409);
    expect((await api("POST", `/api/groups/${room.id}/messages`, body)).status).toBe(409);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { ...body, responderId: pinned.id })).body.queued).toBe(true);
    releaseLead("lead holds ident");
  }, 120000);

  it("a pinned send never chains @mentions: the member's reply naming a teammate starts nobody", async () => {
    const one = await createBot("Chainone", "verification"), two = await createBot("Chaintwo", "verification");
    const created = await api("POST", "/api/groups", { name: "Chain room", memberIds: [one.id, two.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: one.id } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    await fixture.stop();
    // a room from before the turn engine follows one @mention hop
    const groupsFile = join(fixture.info.dataDir, "groups.json");
    const raw = JSON.parse(readFileSync(groupsFile, "utf8")) as Array<Record<string, unknown>>;
    for (const group of raw) if (group.id === room.id) delete group.mentionChain;
    writeFileSync(groupsFile, JSON.stringify(raw));
    await fixture.restart();
    await refreshProof();
    const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
    // control: unpinned, the chain runs
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Chainone MENTIONMARK control" })).status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).some((message) => message.from.botId === two.id), { timeout: 30000 }).toBe(true);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    const before = (await replies(room.threadId)).filter((message) => message.from.botId === two.id).length;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "MENTIONMARK pinned", responderId: one.id, sendId: "pin_chain_1234567" })).status).toBe(202);
    await expect.poll(async () => (await replies(room.threadId)).filter((message) => message.from.botId === one.id).length, { timeout: 30000 }).toBe(2);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    expect((await replies(room.threadId)).filter((message) => message.from.botId === two.id).length).toBe(before);
  }, 180000);

  it("refuses a pin for a bot that is not in the room, and starts nothing", async () => {
    const { room } = await makeRoom();
    const outsider = await createBot("Pinoutsider", "verification");
    const refused = await api("POST", `/api/groups/${room.id}/messages`, { text: "hello there", responderId: outsider.id, sendId: "pin_outside_123456" });
    expect(refused.status).toBe(409);
    const bad = await api("POST", `/api/groups/${room.id}/messages`, { text: "hello there", responderId: 12 });
    expect(bad.status).toBe(400);
    expect((await messages(room.threadId)).filter((message) => message.role === "user")).toEqual([]);
  }, 60000);
});
