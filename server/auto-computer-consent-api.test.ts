// A bot left on the Auto computer destination reaches THIS Mac. Before it
// first acts on the screen, the owner confirms once for that bot, and the
// answer is remembered. A bot explicitly set to "This computer" is the
// owner's own choice and is never asked.
//
// Drives the real server over HTTP with the fake Claude CLI and a fake host
// driver descriptor. HEADLESS ONLY: nothing here opens a window or captures a
// screen; the fixture port is probed from a band clear of the live app's 8799, and the data
// directory is a throwaway temp dir.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";

/** Auto reaches this computer only on macOS (server/local-routing.ts). */
const AUTO_REACHES_HOST = shouldMountLocalComputer({ requested: undefined, hostPlatform: process.platform, providerSupportsLocal: true });

const fakeHostSource = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.env.FIXTURE_HOST_LOG;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'consent-fake-host', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [{ name: 'fixture_ping', description: 'No computer action', inputSchema: { type: 'object', properties: {} } }] };
  else if (rpc.method === 'tools/call') { appendFileSync(log, rpc.params.name + String.fromCharCode(10)); result = { content: [{ type: 'text', text: 'consent-pong' }] }; }
  else result = { isError: true, content: [{ type: 'text', text: 'unsupported fixture request' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + String.fromCharCode(10));
}`;

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
const driver = path.join(dataDir, 'fake-host-driver.mjs');
fs.writeFileSync(driver, '#!' + process.execPath + String.fromCharCode(10) + ${JSON.stringify(fakeHostSource)});
fs.chmodSync(driver, 0o755);
fs.writeFileSync(path.join(dataDir, 'cua-connection.json'), JSON.stringify({
  mode: 'embedded',
  status: 'ready',
  socketPath: path.join(dataDir, 'cua.sock'),
  mcpCommand: driver,
  mcpArgs: ['mcp'],
  mcpEnv: { FIXTURE_HOST_LOG: path.join(dataDir, 'host-calls.log') },
}));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;

let fixture: VerificationServer;
let model: string;
let headers: Record<string, string> = {};

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
};
const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const consentCards = async (threadId: string) => (await messages(threadId)).filter((message) => message.card?.tool === "local_computer_consent");
const hostCalls = () => {
  const file = `${fixture.info.dataDir}/host-calls.log`;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
};
const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };

const makeBot = async (name: string, patch: Record<string, unknown> = {}) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { browser: false, composio: false, ...patch })).status).toBe(200);
  return bot;
};
/** Start a held turn and return the host computer the engine was handed. */
const startTurn = async (bot: any, label: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain(label);
  return dump()?.mcpConfig?.mcpServers?.computer;
};
const stopTurn = (bot: any) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
/** The computer RPC exactly as the bot's own proxy issues it. */
const hostRpc = async (token: string, method: "tools/call" | "tools/list" = "tools/call") => {
  const response = await fetch(`${fixture.info.url}/api/internal/host-computer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(method === "tools/call" ? { method, params: { name: "fixture_ping", arguments: {} } } : { method }),
  });
  return { status: response.status, body: await response.json() as any };
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_799, span: 200 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => { await fixture?.close(); });

it("runs on its own port with a throwaway data directory", () => {
  // Other suites share this band, so the port is probed from it rather than pinned.
  const port = Number(new URL(fixture.info.url).port);
  expect(port).toBeGreaterThanOrEqual(18_799);
  expect(port).toBeLessThan(19_000);
  expect(fixture.info.dataDir).not.toContain(".murage");
});

it.runIf(AUTO_REACHES_HOST)("asks once before a bot on Auto first acts on this computer, and remembers Allow", async () => {
  const bot = await makeBot("Consent allow");
  try {
    expect((await state(bot.id)).computer).toBeUndefined();
    const mounted = await startTurn(bot, "consent-allow");
    expect(mounted, "Auto still mounts this computer before anyone is asked").toBeTruthy();
    // Mounting is not touching, and neither is listing the tools: no card
    // until the bot actually acts.
    const listed = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN, "tools/list");
    expect(JSON.stringify(listed.body)).toContain("fixture_ping");
    expect(await consentCards(bot.threadId)).toHaveLength(0);

    let settled = false;
    const first = hostRpc(mounted.env.MURAGE_CONTROL_TOKEN).finally(() => { settled = true; });
    await expect.poll(async () => (await consentCards(bot.threadId)).length, { timeout: 10_000 }).toBe(1);
    const [card] = await consentCards(bot.threadId);
    expect(card.card.title).toContain("use this computer");
    // The action waits on the person, and nothing reached the screen yet.
    expect(settled).toBe(false);
    expect(hostCalls()).toBe(0);

    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
    const answered = await first;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain("consent-pong");
    expect((await state(bot.id)).hostComputerConsent).toBe("allowed");

    // Remembered: the next action goes straight through, with no new card.
    const second = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN);
    expect(JSON.stringify(second.body)).toContain("consent-pong");
    expect(await consentCards(bot.threadId)).toHaveLength(1);
    expect(hostCalls()).toBe(2);
  } finally { await stopTurn(bot); }
}, 60_000);

it.runIf(AUTO_REACHES_HOST)("remembers Don't allow and keeps the bot off this computer on later turns", async () => {
  const bot = await makeBot("Consent deny");
  const before = hostCalls();
  try {
    const mounted = await startTurn(bot, "consent-deny");
    const pending = hostRpc(mounted.env.MURAGE_CONTROL_TOKEN);
    await expect.poll(async () => (await consentCards(bot.threadId)).length, { timeout: 10_000 }).toBe(1);
    const [card] = await consentCards(bot.threadId);
    // answered through the bot route this time; both respond routes resolve it
    expect((await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
    const refused = await pending;
    expect(refused.body.isError).toBe(true);
    expect(JSON.stringify(refused.body)).toMatch(/chose not to let/);
    expect(hostCalls()).toBe(before);
    expect((await state(bot.id)).hostComputerConsent).toBe("declined");
  } finally { await stopTurn(bot); }
  await expect.poll(async () => (await state(bot.id)).busy, { timeout: 10_000 }).toBe(false);
  // A declined bot is not handed this computer again.
  const next = await startTurn(bot, "consent-deny-next");
  try {
    expect(next).toBeUndefined();
  } finally { await stopTurn(bot); }
}, 60_000);

it.runIf(AUTO_REACHES_HOST)("never asks a bot the owner explicitly set to This computer", async () => {
  const bot = await makeBot("Consent explicit", { computer: "local" });
  try {
    const mounted = await startTurn(bot, "consent-explicit");
    const result = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN);
    expect(JSON.stringify(result.body)).toContain("consent-pong");
    expect(await consentCards(bot.threadId)).toHaveLength(0);
  } finally { await stopTurn(bot); }
}, 60_000);

it.runIf(AUTO_REACHES_HOST)("treats the existing Auto-on-this-computer warning as the confirmation", async () => {
  // The desktop dialog that acknowledges Auto mode on this computer is the
  // same consent; asking again right after it would be a second prompt for
  // one decision.
  const bot = await makeBot("Consent acknowledged", { autoApprove: true, acknowledgeLocalAuto: true });
  expect((await state(bot.id)).hostComputerConsent).toBe("allowed");
}, 30_000);

it.runIf(AUTO_REACHES_HOST)("lets the owner reset a remembered answer so the bot asks again", async () => {
  const bot = await makeBot("Consent reset", { hostComputerConsent: "declined" });
  expect((await state(bot.id)).hostComputerConsent).toBe("declined");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { hostComputerConsent: null })).status).toBe(200);
  expect((await state(bot.id)).hostComputerConsent).toBe("ask");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { hostComputerConsent: "sometimes" })).status).toBe(400);
}, 30_000);
