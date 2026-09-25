// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// About me never reaches someone who is not the owner. Real index.ts, the
// scripted Slack SDK (slack-sdk-preload.mjs) and the fake Claude CLI dumping
// each turn: a verified Slack account linked to another person gets a turn
// with no About me in it, and the same account linked to the owner (the
// owner messaging their own bot from Slack) gets it, the rule MEMORY.md and
// the team brief already follow. Discord is proven the same way; Telegram
// reaches the same threadHumanPrincipal gate through observeVerifiedHuman
// but has no scripted fixture here.
// Synthetic fixture text only; loopback server, no network or credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ABOUT = "ABOUT_ME_CHANNEL_CANARY I live in Galway and run the shop alone.";
const NOTEBOOK = "NOTEBOOK_CHANNEL_CANARY the owner's private note.";

it.skipIf(process.platform === "win32")("keeps About me out of a Slack turn for another person and gives it to the owner's own Slack messages", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-about-me-channels-")), data = join(home, "data"), staticDir = join(home, "static"), dump = join(home, "turn.json");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>About me fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixtureClaude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } } }));
  const port = await freePortBlock([0, 1]), secret = "fedcba9876543210".repeat(4);
  const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  let child: ChildProcess | undefined, stderr = "";
  const traces: Array<{ kind: string; eventId?: string }> = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown) => { const result = await request(method, path, body); expect(result.status, JSON.stringify(result.body)).toBeLessThan(300); return result.body; };
  const event = (id: string, text: string, user = "UOTHER") => child!.send({ kind: "slack-fixture-event", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000), authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOTHER", user, text } } });
  const dumped = () => existsSync(dump) ? readFileSync(dump, "utf8") : "";
  const turnFor = async (botId: string, tag: string) => {
    await expect.poll(() => dumped().includes(tag), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === botId).busy, { timeout: 15000 }).toBe(true);
    return String(JSON.parse(dumped()).systemPrompt ?? "");
  };
  const relink = async (as: "owner" | "person") => {
    const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings[0];
    return api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as });
  };
  try {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", join(root, "server/testing/slack-sdk-preload.mjs"), join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (value) => { if ((value as any)?.kind === "slack-fixture") traces.push(value as any); });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error(stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);

    const bot = (await api("GET", "/api/bots")).bots[0];
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Synthetic Shop Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off", browser: false, composio: false, modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
    await api("PUT", "/api/about-me", { text: ABOUT });
    await api("PUT", `/api/bots/${bot.id}/memory`, { text: `# Memory\n\n- ${NOTEBOOK}\n` });

    // The owner at the desktop: it rides.
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "OWNER_DESKTOP_TURN" });
    expect(await turnFor(bot.id, "OWNER_DESKTOP_TURN")).toContain(ABOUT);

    await api("PATCH", "/api/config?secretStorage=external", { slack: { appToken: "xapp-fixture-not-real", botToken: "xoxb-fixture-not-real", teamId: "TEAM", appId: "APP", ownerUserId: "UOTHER" } });
    const pairing = await api("POST", "/api/slack/pair", { targetBotId: bot.id });
    event("EvPAIR", "/pair " + pairing.code);
    await expect.poll(async () => (await api("GET", "/api/slack/status")).paired).toBe(true);

    // Another person on Slack: neither About me nor the owner's notebook.
    await relink("person");
    event("EvPERSON", "SLACK_PERSON_TURN");
    const person = await turnFor(bot.id, "SLACK_PERSON_TURN");
    expect(person).not.toContain(ABOUT);
    expect(person).not.toContain("<about-the-owner>");
    expect(person).not.toContain(NOTEBOOK);

    // The same Slack account linked to the owner: the owner's own channel message.
    await relink("owner");
    event("EvOWNER", "SLACK_OWNER_TURN");
    const owner = await turnFor(bot.id, "SLACK_OWNER_TURN");
    expect(owner).toContain(ABOUT);
    expect(owner).toContain(NOTEBOOK);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 120_000);

it.skipIf(process.platform === "win32")("keeps About me out of a Discord turn for another person and gives it to the owner's own Discord messages", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-about-me-discord-")), data = join(home, "data"), staticDir = join(home, "static"), dump = join(home, "turn.json");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>About me fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fixtureClaude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } } }));
  const port = await freePortBlock([0, 1]), secret = "0f1e2d3c4b5a6978".repeat(4);
  const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  let child: ChildProcess | undefined, stderr = "";
  const traces: Array<{ kind: string; op: string }> = [];
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const api = async (method: string, path: string, body?: unknown) => { const result = await request(method, path, body); expect(result.status, JSON.stringify(result.body)).toBeLessThan(300); return result.body; };
  const ids = new Map<string, string>();
  const event = (id: string, text: string) => {
    if (!ids.has(id)) ids.set(id, String(100 + ids.size));
    child!.send({ kind: "discord-fixture-event", body: { id: ids.get(id), channelId: "14", channel: { type: 1 }, author: { id: "13", bot: false }, guildId: null, webhookId: null, type: 0, content: text, createdTimestamp: Date.now(), attachments: { size: 0 }, components: [] } });
  };
  const dumped = () => existsSync(dump) ? readFileSync(dump, "utf8") : "";
  const turnFor = async (botId: string, tag: string) => {
    await expect.poll(() => dumped().includes(tag), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.find((item: any) => item.id === botId).busy, { timeout: 15000 }).toBe(true);
    return String(JSON.parse(dumped()).systemPrompt ?? "");
  };
  const relink = async (as: "owner" | "person") => {
    const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings[0];
    return api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as });
  };
  try {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH, FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_DUMP_EACH_TURN: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", join(root, "server/testing/discord-sdk-preload.mjs"), join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (value) => { if ((value as any)?.kind === "discord-fixture") traces.push(value as any); });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error(stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);

    const bot = (await api("GET", "/api/bots")).bots[0];
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Synthetic Shop Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off", browser: false, composio: false, modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
    await api("PUT", "/api/about-me", { text: ABOUT });
    await api("PATCH", "/api/config?secretStorage=external", { discord: { botToken: "discord-fixture-private-not-real", applicationId: "11", ownerUserId: "13" } });
    const pairing = await api("POST", "/api/discord/pair", { targetBotId: bot.id });
    event("EvPAIR", "/pair " + pairing.code);
    await expect.poll(async () => (await api("GET", "/api/discord/status")).paired).toBe(true);
    await expect.poll(() => traces.filter((t) => t.op === "send").length).toBe(1);
    event("EvYES", "yes");
    await expect.poll(() => traces.filter((t) => t.op === "send").length).toBe(2);

    await relink("person");
    event("EvPERSON", "DISCORD_PERSON_TURN");
    const person = await turnFor(bot.id, "DISCORD_PERSON_TURN");
    expect(person).not.toContain(ABOUT);
    expect(person).not.toContain("<about-the-owner>");

    await relink("owner");
    event("EvOWNER", "DISCORD_OWNER_TURN");
    expect(await turnFor(bot.id, "DISCORD_OWNER_TURN")).toContain(ABOUT);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
}, 120_000);
