// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine "/" commands through the real HTTP routes and real turns, on a real
// server with its own data directory (launchVerificationServer gives the child
// its own MURAGE_DATA_DIR and port; nothing touches the owner's). The engine is
// the fake Claude Code CLI with its command list switched on: names on init,
// descriptions in the answer to the SDK's `initialize` request.
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string> = {};

const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = (await api("GET", "/api/bots?messages=0")).body; return !state.bots.some((bot: any) => bot.busy); };
const promptOf = (dump: any) => {
  const content = dump?.prompt?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((block: any) => block.text ?? "").join("") : "";
};

posixOnly("engine commands", () => {
  let bot: { id: string; threadId: string };

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1'; process.env.FAKE_CLAUDE_COMMANDS='1';",
    });
    const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    bot = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is unknown before the engine has run, then lists what it reported, cached on disk", async () => {
    expect(await api("GET", `/api/bots/${bot.id}/engine-commands`)).toEqual({
      status: 200,
      body: { engine: "Claude Code", driver: "claudeAgent", status: "unknown", commands: [] },
    });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hello there ENGINE_CMD_FIRST" })).status).toBeLessThan(300);
    await expect.poll(async () => (await api("GET", `/api/bots/${bot.id}/engine-commands`)).body.status, { timeout: 20000 }).toBe("ready");
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const listed = (await api("GET", `/api/bots/${bot.id}/engine-commands`)).body;
    // statusline is terminal-only by Claude Code's own report; clear is one
    // Murage keeps out
    expect(listed.commands).toEqual([
      { name: "compact", description: "Clear conversation history but keep a summary in context", hint: "<optional custom summarization instructions>" },
      { name: "context", description: "Show current context usage" },
      { name: "review", description: "Review a pull request" },
    ]);
    expect(readJson(`${fixture.info.dataDir}/engine-commands.json`).bots[bot.id].claudeAgent.commands).toEqual(listed.commands);
  }, 60000);

  it("answers the companion surfaces that can see the bot, and no one for a bot that is not there", async () => {
    // Phone and web chat with the same bots, so their composers get the same
    // menu; visibility follows visibleToCompanion like the bot's other reads.
    expect(await api("GET", `/api/bots/${bot.id}/engine-commands`, undefined, {})).toMatchObject({ status: 200, body: { status: "ready" } });
    expect((await api("GET", "/api/bots/no-such-bot/engine-commands")).status).toBe(404);
  });

  it("runs an engine command only for the owner's own surfaces", async () => {
    for (const unproven of [{}, { "x-murage-companion": "1" }, { "x-murage-surface": "desktop" }] as Array<Record<string, string>>) {
      const refused = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "/review" }, unproven);
      expect(refused.status, JSON.stringify(unproven)).toBe(403);
    }
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as Array<{ role: string; text?: string }>;
    expect(messages.some((message) => message.role === "user" && message.text === "/review")).toBe(false);
    // ordinary words from the same callers are still taken
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "a plain note, not a command" }, {})).status).toBe(202);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "/review" })).status).toBe(202);
    await expect.poll(() => promptOf(readJson(fixture.fixtureDumpPath)), { timeout: 20000 }).toBe("/review");
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
  }, 60000);

  it("sends a picked command to the engine as the command alone and shows its answer", async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "/context" })).status).toBeLessThan(300);
    await expect.poll(() => promptOf(readJson(fixture.fixtureDumpPath)), { timeout: 20000 }).toBe("/context");
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const state = (await api("GET", "/api/bots?messages=20")).body;
    const messages = state.bots.find((entry: any) => entry.id === bot.id).messages as Array<{ role: string; text?: string }>;
    expect(messages.some((message) => message.role === "bot" && message.text?.includes("FAKE_CONTEXT 12k of 200k tokens used"))).toBe(true);
  }, 60000);
});
