// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane M acceptance through the real server (fake engine, memory active):
//  - "What this project remembers" is not empty after a project session: the
//    project's own chat now captures into the project's memory (PM3, the
//    baseline showed 0 records there and 14 to 25 in the chat's own scope);
//  - a member's direct chat knows its project: its next direct turn carries
//    "What I've been working on" naming the project and its own last reply
//    there (the baseline: "I don't have a record of work on the Tallyroo
//    Launch project").
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { turnSecret } from "./turn-credential.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, model: string;
let sequence = 0;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
  return value;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const marker = () => `(turn number ${++sequence} end)`;
async function prompted(send: (text: string) => Promise<unknown>, text: string) {
  const tag = marker();
  await send(`${text} ${tag}`);
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return JSON.stringify(dump.prompt);
}

posixOnly("project memory and a member's working context", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("fills the project's memory and tells the member's direct chat what it did there", async () => {
    const create = async (name: string) => {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
      return bot as { id: string; threadId: string };
    };
    const reed = await create("Reed"), cole = await create("Cole");
    const project = (await api("POST", "/api/groups", { name: "Tallyroo Launch", memberIds: [reed.id, cole.id], setup: { bulletin: "Never promise a discount.", defaultResponder: { kind: "member", botId: reed.id } }, channelProject: { goal: "Launch Tallyroo on the 14th" } })).group as { id: string; threadId: string };
    const firstTurn = await prompted(text => api("POST", `/api/groups/${project.id}/messages`, { text }), "The launch date is the 14th and the annual plan is 120.");
    // the project's layers: the brief in the system prompt in place of the
    // room's instructions, the joining note in the message on the first turn
    const system = String(readJson(fixture.fixtureDumpPath)?.systemPrompt ?? "");
    expect(system).toContain("<owner-rules>\nNever promise a discount.\n</owner-rules>");
    expect(system).not.toContain("Room bulletin");
    expect(firstTurn).toContain("<project-status>");
    expect(firstTurn).toContain("first turn in the project");
    const secondTurn = await prompted(text => api("POST", `/api/groups/${project.id}/messages`, { text }), "Thanks, Reed.");
    expect(secondTurn).not.toContain("first turn in the project");
    const thread = (await api("GET", `/api/threads/${project.threadId}/messages?limit=50`)).messages as any[];
    const reply = thread.filter(message => message.role === "bot" && message.kind === "text" && message.from?.botId === reed.id && message.text?.trim()).at(-1);
    expect(reply, JSON.stringify(thread.map(message => [message.role, message.kind, message.text]))).toBeTruthy();

    // What this project remembers: the room scope now holds the session.
    await expect.poll(async () => {
      const scope = (await api("GET", "/api/memory/status")).scopes?.find((item: any) => item.kind === "room" && item.ownerKey === project.id);
      if (!scope) return 0;
      return ((await api("POST", "/api/memory/action", { action: "list", scopeId: scope.id, state: "active" })).records ?? []).length;
    }, { timeout: 20000 }).toBeGreaterThan(0);

    // The member's direct chat knows its project, once per session.
    const first = await prompted(text => api("POST", `/api/bots/${reed.id}/messages`, { threadId: reed.threadId, text }), "What did you do in the launch project?");
    expect(first).toContain("<working-context>");
    expect(first).toContain(`Project \\"Tallyroo Launch\\"`);
    expect(first).toContain(String(reply.text).split("\n")[0]!.trim().slice(0, 40).replace(/"/g, '\\\\\\"'));
    // (a resumed session is not sent it twice: working-context.test.ts; a
    // turn whose memory context was refreshed starts over and gets it again)
    // Astra r1 #12: saving the notebook is a write the section can show at once
    const saved = await api("PUT", `/api/bots/${reed.id}/memory`, { text: "# Memory\n- launch on the 14th\n" });
    expect(typeof saved.lastWrittenAt).toBe("number");
    // a teammate who was never asked has nothing of Reed's
    const teammate = await prompted(text => api("POST", `/api/bots/${cole.id}/messages`, { threadId: cole.threadId, text }), "Anything new?");
    expect(teammate).not.toContain(String(reply.text).split("\n")[0]!.trim().slice(0, 40));
  }, 90000);

  it("lists lane M's project tools on a project turn and serves them for the turn's own request", async () => {
    const create = async (name: string) => {
      const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot;
      await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
      return bot as { id: string; threadId: string };
    };
    const lead = await create("Lena"), member = await create("Milo");
    const project = (await api("POST", "/api/groups", { name: "Tools project", memberIds: [lead.id, member.id], setup: { bulletin: "Plain words.", defaultResponder: { kind: "member", botId: lead.id } }, channelProject: { goal: "Ship" } })).group as { id: string; threadId: string };
    await prompted(text => api("POST", `/api/groups/${project.id}/messages`, { text }), "First message for the tools test.");
    const tag = marker();
    await api("POST", `/api/groups/${project.id}/messages`, { text: `Hold this turn ${tag}\n__fixture_hold_authority__` });
    let dump: any;
    await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
    try {
      const find = (value: any): Record<string, string> | undefined => {
        if (!value || typeof value !== "object") return undefined;
        if (typeof value.env?.MURAGE_COMMS_TOKEN === "string" || typeof value.env?.MURAGE_CRED_FILE === "string" && value.env?.MURAGE_PROJECT_ROLE) return value.env;
        for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
        return undefined;
      };
      const env = find(dump.mcpConfig);
      expect(env?.MURAGE_PROJECT_ROLE).toBe("lead");
      const call = async (name: string, body: unknown) => {
        const response = await fetch(new URL(`/api/internal/project/${name}`, env!.MURAGE_HARNESS_URL), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${turnSecret("MURAGE_COMMS_TOKEN", env!)}` }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };
      const read = await call("read-messages", { limit: 5 });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.messages.some((message: any) => message.speaker === "Owner" && String(message.text).includes("First message for the tools test."))).toBe(true);
      const first = read.body.messages.find((message: any) => String(message.text).includes("First message"));
      const summary = await call("summary-update", { text: "We are shipping.", sourceMessageIds: [first.id] });
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      // the member-only tool is refused to the lead, and a foreign thread to anyone
      expect((await call("suggest", { botId: member.id, why: "x" })).status).toBe(403);
      expect((await call("read-messages", { threadId: lead.threadId })).status).toBe(403);
    } finally {
      writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "");
      await expect.poll(idle, { timeout: 20000 }).toBe(true);
    }
  }, 90000);
});
