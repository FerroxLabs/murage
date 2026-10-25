// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I / SL-K, EXTENDED: a Slack channel turn that meets a limit, and Codex Default on a long thread.
// Each test names the owner's failure it prevents.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_CODEX = join(root, "server", "testing", "fake-codex-app-server.ts");

// ---- (i) a Slack channel turn at its limit: the plain line, never the owner's offer card ----------------------------
const secret = "0123456789abcdef".repeat(4);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const fakeApp = "xapp-fixture-private-not-real", fakeBot = "xoxb-fixture-private-not-real";
interface Trace { kind: string; op: string; channel?: string; text?: string; eventId?: string }

it("a Slack channel turn that meets its engine's limit gets the plain limit line and no offer card (a channel is not the owner's direct chat)", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-slack-limit-")), data = join(home, "data"), staticDir = join(home, "static");
  mkdirSync(data); mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Slack fixture</title>"); writeFileSync(join(staticDir, "assets/test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    fixtureClaude: { driver: "claudeAgent", config: { cli: join(root, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR: "Claude AI usage limit reached|" + (Math.floor(Date.now() / 1000) + 7200) } },
  } }));
  const port = await freePortBlock([0, 1]); let child: ChildProcess | undefined; let stderr = ""; const traces: Trace[] = [];
  const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...desktop, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const event = (id: string, text: string) => child!.send({ kind: "slack-fixture-event", body: {
    type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOWNER", user: "UOWNER", text },
  } });
  try {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_DEV_DESKTOP_SECRET: secret, PATH: process.env.PATH };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", pathToFileURL(join(root, "server/testing/slack-sdk-preload.mjs")).href, join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", chunk => { stderr += chunk; }); child.on("message", value => { if ((value as Trace)?.kind === "slack-fixture") traces.push(value as Trace); });
    await expect.poll(async () => { if (child!.exitCode !== null) throw new Error("Fixture exited: " + stderr); try { return (await request("GET", "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
    const candidate = (await request("GET", "/api/bots")).body.bots[0];
    expect((await request("PATCH", `/api/bots/${candidate.id}`, { name: "Fictional Slack Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off",
      modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } })).status).toBe(200);
    expect((await request("PATCH", "/api/config?secretStorage=external", { slack: { appToken: fakeApp, botToken: fakeBot, teamId: "TEAM", appId: "APP", ownerUserId: "UOWNER" } })).status).toBe(200);
    const paired = await request("POST", "/api/slack/pair", { targetBotId: candidate.id }); expect(paired.status).toBe(200);
    event("EvPAIR", "/pair " + paired.body.code);
    await expect.poll(async () => (await request("GET", "/api/slack/status")).body.paired).toBe(true);
    await expect.poll(() => traces.filter(t => t.op === "send").length).toBe(1);
    const bindings = (await request("POST", "/api/memory/action", { action: "humans" })).body.bindings;
    expect((await request("POST", "/api/memory/action", { action: "human-link", bindingId: bindings[0].id, expectedRevision: bindings[0].revision, as: "owner" })).status).toBe(200);
    const botThreads = async () => {
      const bot = (await request("GET", `/api/bots/${candidate.id}`)).body.bot;
      return [...new Set<string>([bot.threadId, ...(bot.tasks ?? []).map((t: any) => t.threadId)])];
    };
    event("EvLIMIT", "Summarize this synthetic note: the blue fixture is ready.");
    // the channel message ran, was refused at the limit, and the run now waits for the reset
    await expect.poll(async () => {
      const found: string[] = [];
      for (const id of await botThreads()) for (const m of (await request("GET", `/api/threads/${id}/messages?limit=100`)).body.messages ?? []) if (m.kind === "activity") found.push(String(m.tool?.name));
      return found.some(line => /Claude is at its limit; this run continues after it resets/.test(line));
    }, { timeout: 30000 }).toBe(true);
    // settle: nothing more arrives, and the engine's turn has ended
    await new Promise(resolve => setTimeout(resolve, 1500));
    const all: any[] = [];
    for (const id of await botThreads()) all.push(...(await request("GET", `/api/threads/${id}/messages?limit=100`)).body.messages ?? []);
    expect(all.some(m => m.card?.tool === "murage_limit_offer"), "no offer card in any thread of the bot").toBe(false);
    expect(all.filter(m => m.kind === "activity").map(m => String(m.tool?.name)).some(line => /is at its limit/.test(line)), "the plain limit line is in the conversation").toBe(true);
    // the channel sender is told, once, in the channel: which engine, and when it continues
    await expect.poll(() => traces.filter(t => t.op === "send" && /is at its limit/.test(t.text ?? "")).length, { timeout: 20000 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const told = traces.filter(t => t.op === "send" && /is at its limit/.test(t.text ?? ""));
    expect(told, "exactly one limit line reaches the channel").toHaveLength(1);
    expect(told[0].channel).toBe("DOWNER");
    expect(told[0].text, "names the engine and when it continues").toMatch(/Claude.*after it resets \(about /);
    expect(told[0].text, "no vendor, no em dash, no safety words, no offer").not.toMatch(/anthropic|\u2014|safe|unsafe|safety|Wait|next time/i);
    // the engine's raw refusal is never the bot's answer: not in the channel, not in the thread
    expect(traces.some(t => /usage limit reached/i.test(t.text ?? "")), "the raw limit text is not sent to the channel").toBe(false);
    expect(all.some(m => m.role === "bot" && m.kind !== "activity" && /usage limit reached/i.test(String(m.text ?? ""))), "the raw limit text is not a bot answer in the thread").toBe(false);
  } finally { await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); }
}, 60000);

// ---- (ii) Codex Default on a long thread: one fresh session, the history sent once ---------------------------------------
let fixture: VerificationServer, headers: Record<string, string>;
const callLog = () => join(fixture.info.dataDir, "codex-calls.log");
const codexCalls = (method: string) => existsSync(callLog()) ? readFileSync(callLog(), "utf8").split("\n").filter(line => line.endsWith(` ${method}`)).length : 0;
const turnStarts = (): string[] => { try { return (JSON.parse(readFileSync(join(fixture.info.dataDir, "codex-dump.json"), "utf8")).calls as Array<{ method: string; params: unknown }>)
  .filter(call => call.method === "turn/start").map(call => JSON.stringify(call.params)); } catch { return []; } };
const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> | null = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(extra ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const idle = (botId: string) => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy, { timeout: 30000 }).toBe(false);
const proof = async () => { const s = await api("GET", "/api/desktop-secret", undefined, null); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": s.body.secret }; };

beforeAll(async () => {
  chmodSync(FAKE_CODEX, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.codex={driver:'codex',displayName:'Codex fixture',environment:{FAKE_CODEX_MODE:'resume',FAKE_CODEX_DUMP:path.join(process.env.MURAGE_DATA_DIR,'codex-dump.json'),FAKE_CODEX_CALL_LOG:path.join(process.env.MURAGE_DATA_DIR,'codex-calls.log')},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  await proof();
}, 60000);
afterAll(async () => { await fixture?.close(); });

it("Codex moved to Default on a ~200-message thread starts one fresh session, sends the thread's replay window once, and never again on the next turn", async () => {
  const created = await api("POST", "/api/bots", { name: "Long Codex", modelSelection: { instanceId: "codex", model: "gpt-fake-default", effort: "high" } });
  expect(created.status).toBe(201);
  const b = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${b.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const TURNS = 100; // 100 owner words + 100 replies: a ~200-message thread
  for (let n = 0; n < TURNS; n++) {
    const text = `hist-${String(n).padStart(3, "0")}`;
    expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text })).status).toBe(202);
    await expect.poll(() => turnStarts().join("").includes(text), { timeout: 30000 }).toBe(true);
    await idle(b.id);
  }
  const startsBefore = codexCalls("thread/start");
  expect((await api("PATCH", `/api/bots/${b.id}/tasks/${b.threadId}`, { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).status).toBe(200);
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "default-one" })).status).toBe(202);
  await expect.poll(() => turnStarts().join("").includes("default-one"), { timeout: 30000 }).toBe(true);
  await idle(b.id);
  expect(codexCalls("thread/start"), "exactly one fresh session").toBe(startsBefore + 1);
  const first = turnStarts().filter(call => call.includes("default-one")).at(-1)!;
  const seen = (call: string, n: number) => call.split(`hist-${String(n).padStart(3, "0")}`).length - 1;
  // the replay is the newest 40 lines of the thread (a model with no stated window has no byte budget): sent once, in this one turn
  for (const n of [TURNS - 1, TURNS - 10]) expect(seen(first, n), `hist-${n} is in the one fresh turn's history, once`).toBe(1);
  expect(seen(first, 0), "older than the replay window: not sent").toBe(0);
  expect((await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "default-two" })).status).toBe(202);
  await expect.poll(() => turnStarts().join("").includes("default-two"), { timeout: 30000 }).toBe(true);
  await idle(b.id);
  expect(codexCalls("thread/start"), "the next Default turn resumes").toBe(startsBefore + 1);
  const second = turnStarts().filter(call => call.includes("default-two")).at(-1)!;
  expect(seen(second, TURNS - 1), "the history is not sent again").toBe(0);
}, 280000);
