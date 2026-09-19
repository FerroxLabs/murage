// A bot whose built-in browser is protected keeps its browser tools and is
// told why they refuse. Drives the real server over HTTP with the isolated
// fake Claude CLI, the real unified-browser proxy (spawned from the mounted
// integration exactly as an engine spawns it) and a stubbed native relay whose
// "page is sensitive" answer this suite controls. Nothing launches Chrome.
//
// The failure this pins: once a profile was protected, tools/list was refused
// too, the proxy turned the refusal into a result with no tools in it, and the
// engine connected a browser server with zero tools while the prompt still
// said the bot had a browser. Bots then reached for other browsers.
//
// HEADLESS ONLY; the fixture's port is pinned clear of the owner's live app.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { UNIFIED_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";

const instrumentation = `
import { registerHooks } from 'node:module';
const fs = await import('node:fs');
const path = await import('node:path');
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
const binary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(binary, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = binary;
const sensitive = path.join(dataDir, 'page-is-sensitive');
const file = path.join(dataDir, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.features = { browser: true };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    import { existsSync } from 'node:fs';
    export function createNativeBrowser() { return {
      request: async (method) => method === 'tools/list'
        ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }, { name: 'agent_browser_open', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'fixture page' }] },
      protected: async () => existsSync(\${JSON.stringify(sensitive)}),
      resetStream() {}, input() {}, command: async () => '',
      connect: async () => 'fixture-stream', close: async () => {},
    }; }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start)
      + 'export async function verifyAgentBrowserBinary() {}' + String.fromCharCode(10) + source.slice(end) };
  }
  return nextLoad(url, context);
} });
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
const sensitiveFlag = () => join(fixture.info.dataDir, "page-is-sensitive");
/** Start a turn that holds its browser authority until it is interrupted. */
const holdTurn = async (bot: any, label: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 20_000 }).toContain(label);
  return dump();
};
const stopTurn = async (bot: any) => {
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId)?.busy, { timeout: 20_000 }).toBe(false);
};
const openBrowser = async (captured: any): Promise<EngineClient> => {
  const mounted = captured?.mcpConfig?.mcpServers?.browser;
  expect(mounted, "the built-in browser should be mounted").toBeTruthy();
  const client = startHeadlessEngine({ ...mounted, env: { ...process.env, ...mounted.env } });
  await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "browser-lock-test", version: "1" } });
  return client;
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_799, span: 1 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

it("runs on the fixture's own port and data dir, never the owner's live app", () => {
  expect(fixture.info.url).toBe("http://127.0.0.1:18799");
  expect(fixture.info.dataDir).not.toContain(".murage");
});

it("keeps the browser's tools listed once its page is protected, and every refusal says why", async () => {
  const created = await api("POST", "/api/bots", { name: "Protected page fixture", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", composio: false })).status).toBe(200);
  let client: EngineClient | undefined;
  try {
    const first = await holdTurn(bot, "before-the-lock");
    // Unlocked: the prompt is the plain browser prompt and says nothing of a lock.
    expect(first.systemPrompt).toContain(UNIFIED_BROWSER_SYSTEM_PROMPT);
    expect(first.systemPrompt).not.toContain("is locked");
    client = await openBrowser(first);
    expect(((await client.request("tools/list", {})) as any).tools).toHaveLength(2);

    writeFileSync(sensitiveFlag(), "1");
    const refused = await client.request("tools/call", { name: "agent_browser_snapshot", arguments: {} }) as any;
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("password, one-time-code or payment field, an embedded frame");
    expect(refused.content[0].text).toContain("Do not switch to another browser");
    // The lock does not empty the tool list (the next turn's fresh connection is checked below).
    expect(((await client.request("tools/list", {})) as any).tools?.length ?? 0).toBe(2);
    await client.close(); client = undefined;
    await stopTurn(bot);

    // The next turn starts on a locked profile, and is told so up front.
    const second = await holdTurn(bot, "after-the-lock");
    expect(second.systemPrompt).toContain("Your browser is locked:");
    expect(second.systemPrompt).toMatch(/never use another browser, a browser plugin, or run the browser program yourself/i);
    expect(second.systemPrompt).toMatch(/In this conversation you can [^\n]*use Murage's built-in browser once its lock is cleared/);
    client = await openBrowser(second);
    expect(((await client.request("tools/list", {})) as any).tools?.length ?? 0).toBe(2);

    // Leaving the sensitive page for an ordinary one gives the bot its browser back.
    rmSync(sensitiveFlag(), { force: true });
    const left = await client.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com/" } }) as any;
    expect(left.isError).not.toBe(true);
    expect(((await client.request("tools/call", { name: "agent_browser_snapshot", arguments: {} })) as any).content[0].text).toBe("fixture page");
    await client.close(); client = undefined;
    await stopTurn(bot);
    const third = await holdTurn(bot, "after-leaving");
    expect(third.systemPrompt).not.toContain("Your browser is locked:");
  } finally {
    await client?.close();
    if (existsSync(sensitiveFlag())) rmSync(sensitiveFlag());
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 120_000);
