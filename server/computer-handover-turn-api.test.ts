// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser to computer handover (1.0.22) at the real turn admission. Drives the real server over HTTP with the isolated
// fake Claude CLI, a fake "this computer" descriptor (so local control really mounts through readCuaConnection) and a
// fake agent-browser whose `--version` check this suite makes hang or pass. The engine's dumped system prompt is the
// witness: the mint's refusal reason must reach the handover layer (server/index.ts, the `handoverUnavailable` store
// after the browser mint) and the layer must be appended to the browser prompt (the `handoverLayerForTurn` term).
// server/computer-handover.test.ts covers the text itself; this file covers only that index.ts wires it into a turn.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { AGENT_BROWSER_VERSION } from "./browser-engine-release.ts";
import { BROWSER_UNAVAILABLE_PREFIX } from "../shared/browser-unavailable.ts";
import { handoverStatusLine } from "./computer-handover.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { confirmedBrowserFields } from "./testing/browser-choice.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

/** "This computer" mounts only on macOS and Linux; elsewhere there is no handover to witness. */
const LOCAL_MOUNTS = shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal: true });

const fakeHostSource = `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'handover-fake-host', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'fixture_ping', description: 'No computer action', inputSchema: { type: 'object', properties: {} } }] };
  else result = { isError: true, content: [{ type: 'text', text: 'unsupported fixture request' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + String.fromCharCode(10));
}`;

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const { registerHooks } = await import('node:module');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);

${fakeHostDescriptorSource({ driverSource: fakeHostSource, driverEnv: { FIXTURE_HOST_SECRET: "'synthetic-host-only'" } })}

const mode = path.join(dataDir, 'engine-mode');
fs.writeFileSync(mode, 'hang\\n');
const binary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(binary, [
  '#!/bin/sh',
  'if [ "$1" != "--version" ]; then exit 1; fi',
  'read current < ' + JSON.stringify(mode),
  'if [ "$current" = "hang" ]; then exec /bin/sleep 30; fi',
  'echo "agent-browser ${AGENT_BROWSER_VERSION}"',
  '',
].join('\\n'), { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = binary;
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    export function createNativeBrowser() { return {
      request: async (method) => method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'Fixture page' }] },
      protected: async () => false, resetStream() {}, input() {}, command: async () => '',
      connect: async () => 'fixture-stream', close: async () => {},
    }; }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    // Each anchor is checked on its own, so a moved anchor fails here instead of a silent 20 s check or a refused launch.
    const anchors = [/AGENT_BROWSER_VERIFY_TIMEOUT_MS = [0-9_]+/, 'export function agentBrowserIntegration('];
    for (const anchor of anchors) if (!(typeof anchor === 'string' ? source.includes(anchor) : anchor.test(source))) throw new Error('Browser engine fixture anchor changed: ' + anchor);
    // A short version-check budget so a hanging check fails inside the test.
    const patched = source.replace(anchors[0], 'AGENT_BROWSER_VERIFY_TIMEOUT_MS = 750')
      // Container hosts refuse real engine launches; the native relay above is fake, so mount a stub spec instead.
      .replace(anchors[1], 'function unusedRealAgentBrowserIntegration(')
      + String.fromCharCode(10) + 'export function agentBrowserIntegration(input) { return { command: input.binaryPath, args: [], env: { HOME: input.dataDir, AGENT_BROWSER_SESSION: input.session, AGENT_BROWSER_SOCKET_DIR: input.dataDir } }; }';
    return { format: 'module-typescript', shortCircuit: true, source: patched };
  }
  return nextLoad(url, context);
} });
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;

const api = async (method: string, path: string, body?: unknown) => {
  if (method === "PATCH" && path.startsWith("/api/bots/") && body && typeof body === "object" && ("useMyChrome" in body || "browserTransport" in body))
    body = await confirmedBrowserFields(fixture.info.url, headers, path, body as Record<string, unknown>);
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
/** Set the next check's answer and change the binary, so the next turn really runs a fresh check whatever ran before. */
const setEngine = (mode: "hang" | "ok") => {
  writeFileSync(join(fixture.info.dataDir, "engine-mode"), `${mode}\n`);
  appendFileSync(join(fixture.info.dataDir, "fake-agent-browser"), `# ${mode} ${Date.now()}\n`);
};
/** The quiet browser-unavailable notes the turn left in its conversation. */
const unavailableNotes = async (threadId: string) =>
  ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[])
    .filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith(BROWSER_UNAVAILABLE_PREFIX)).map((m) => String(m.tool.name));
const dump = () => {
  try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); } catch { return null; }
};
const createBot = async (name: string, patch: Record<string, unknown>) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  const patched = await api("PATCH", `/api/bots/${bot.id}`, { composio: false, ...patch });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  return bot;
};
/** Send one message and return what the engine was given once the turn settled. */
const runTurn = async (bot: any, text: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes(text), { timeout: 20_000 }).toBe(true);
  const busy = async () =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId)?.busy;
  await expect.poll(busy, { timeout: 20_000 }).toBe(false);
  const captured = dump();
  expect(captured, "the provider turn never started").not.toBeNull();
  return { system: String(captured.systemPrompt ?? ""), servers: captured.mcpConfig?.mcpServers ?? {} };
};

beforeAll(async () => {
  if (!LOCAL_MOUNTS) return;
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_699, span: 1 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

it.runIf(LOCAL_MOUNTS)("a built-in browser whose check fails, on this computer: the turn is told to hand over with the unavailable line", async () => {
  setEngine("hang");
  const bot = await createBot("Handover built-in fixture", { computer: "local" });
  const turn = await runTurn(bot, "book the table on the site");
  // Real mounts: this computer is on, the browser is not.
  expect(turn.servers.computer, "this computer did not mount").toBeDefined();
  expect(turn.servers.browser).toBeUndefined();
  expect(turn.system).toContain(handoverStatusLine("unavailable"));
  expect(turn.system).toContain("BROWSER TO COMPUTER: the browser route cannot serve this turn");
}, 60_000);

it.runIf(LOCAL_MOUNTS)("the same failed check with the computer off adds no handover instruction", async () => {
  setEngine("hang");
  const bot = await createBot("Handover computer off fixture", { computer: "off" });
  const turn = await runTurn(bot, "book the table without a computer");
  expect(turn.servers.computer).toBeUndefined();
  expect(turn.servers.browser).toBeUndefined();
  // The same coded refusal as the first test really happened on this turn; only the computer differs.
  expect(await unavailableNotes(bot.threadId)).toEqual([expect.stringContaining("browser-cause:builtin_restart")]);
  expect(turn.system).not.toContain("BROWSER TO COMPUTER");
}, 60_000);

it.runIf(LOCAL_MOUNTS)("the owner's browser never set up, on this computer: the extension hint and the setup handover line", async () => {
  setEngine("ok");
  const bot = await createBot("Handover extension fixture", { computer: "local" });
  expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "extension" })).status).toBe(200);
  const turn = await runTurn(bot, "check my order in my browser");
  expect(turn.servers.computer, "this computer did not mount").toBeDefined();
  expect(turn.servers.browser).toBeUndefined();
  // The extension branch of the mint: its own hint, then the handover for its code (no extension ever connected here).
  expect(turn.system).toContain("browser-cause:browser_extension_setup_required");
  expect(turn.system).toContain(handoverStatusLine("setup_required"));
}, 60_000);

it.runIf(LOCAL_MOUNTS)("a mounted browser on this computer carries the mid-turn handover rule", async () => {
  setEngine("ok");
  const bot = await createBot("Handover mounted fixture", { computer: "local" });
  const turn = await runTurn(bot, "read the menu page");
  expect(turn.servers.computer, "this computer did not mount").toBeDefined();
  expect(turn.servers.browser, "the browser did not mount").toBeDefined();
  expect(turn.system).toContain("BROWSER TO COMPUTER: if a browser tool reports browser_extension_setup_required");
}, 60_000);
