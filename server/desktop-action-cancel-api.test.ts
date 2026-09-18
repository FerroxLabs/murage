// Stopping a turn while a desktop action is already inside the driver.
//
// Every stop lever revokes the turn's authority, so no NEW action can start.
// This suite is about the action that already started: the harness must stop
// waiting for it, tell the driver with MCP `notifications/cancelled` naming the
// request it sent, settle the tool call as cancelled, and still refuse the next
// action until the driver has actually answered the old one.
//
// It boots the real harness against a throwaway home with a fake host driver
// that blocks on `fixture_slow` until the test opens a gate, and that logs
// every frame it receives (notifications included) the moment it arrives.
//
// HEADLESS ONLY. Nothing here opens a window, captures a screen, or touches
// the owner's live app or data; the fixture's port is pinned clear of 8799.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";

/** Windows never mounts the host desktop, so there is nothing to cancel. */
const HOST_COMPUTER = shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal: true });

const fakeDriverSource = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.env.FIXTURE_DRIVER_LOG;
const gate = process.env.FIXTURE_HOLD_GATE;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + String.fromCharCode(10));
const rl = createInterface({ input: process.stdin });
rl.on('close', () => appendFileSync(log, JSON.stringify({ fixture: 'exited' }) + String.fromCharCode(10)));
rl.on('line', async line => {
  appendFileSync(log, line + String.fromCharCode(10));
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) return;
  if (rpc.method === 'initialize') return send(rpc.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cancel-fake-host', version: '1' } });
  if (rpc.method === 'tools/list') return send(rpc.id, { tools: [] });
  if (rpc.method === 'tools/call' && rpc.params.name === 'fixture_slow') {
    while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
    send(rpc.id, { content: [{ type: 'text', text: 'slow action finished' }] });
    return appendFileSync(log, JSON.stringify({ fixture: 'replied', id: rpc.id }) + String.fromCharCode(10));
  }
  send(rpc.id, { content: [{ type: 'text', text: 'quick action finished' }] });
});`;

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
const driver = path.join(dataDir, 'fake-host-driver.mjs');
fs.writeFileSync(driver, ${JSON.stringify(fakeDriverSource)});
fs.writeFileSync(path.join(dataDir, 'cua-connection.json'), JSON.stringify({
  mcpCommand: process.execPath,
  mcpArgs: [driver],
  mcpEnv: { FIXTURE_DRIVER_LOG: path.join(dataDir, 'driver-frames.log'), FIXTURE_HOLD_GATE: path.join(dataDir, 'hold-gate') },
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
const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; } };
const gatePath = () => join(fixture.info.dataDir, "hold-gate");
const frames = (): any[] => {
  try { return readFileSync(join(fixture.info.dataDir, "driver-frames.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
const isBusy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId)?.busy === true;
const text = (result: any) => (result?.content ?? []).map((part: any) => part.text).join(" ");
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<"still waiting">(resolve => setTimeout(() => resolve("still waiting"), ms))]);

/** A bot on this computer, holding a turn, with its own computer proxy open
 * exactly as its engine would open it. */
const startComputerTurn = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, browser: false, computer: "local" })).status).toBe(200);
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain(name);
  const mounted = dump()?.mcpConfig?.mcpServers?.computer;
  expect(mounted, "expected this computer to be mounted").toBeTruthy();
  const client = startHeadlessEngine({ ...mounted, env: { ...process.env, ...mounted.env } });
  await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cancel-test", version: "1" } });
  return { bot, client };
};

/** Start the slow action and return the id the harness gave it on the wire
 * to the driver — the id a cancel notification must name. */
const startSlowAction = async (client: EngineClient, signal?: AbortSignal) => {
  const mark = frames().length;
  const call = client.request("tools/call", { name: "fixture_slow", arguments: {} }, { signal });
  await expect.poll(() => frames().slice(mark).some(frame => frame.method === "tools/call"), { timeout: 10_000 }).toBe(true);
  const sent = frames().slice(mark).find(frame => frame.method === "tools/call");
  return { call, mark, driverRequestId: sent.id };
};

/** Let the driver answer the old action and wait for its process to exit,
 * which is what the harness needs before it will admit another action. */
const releaseDriver = async (mark: number) => {
  writeFileSync(gatePath(), "1");
  await expect.poll(() => frames().slice(mark).filter(frame => frame.fixture === "exited").length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  rmSync(gatePath(), { force: true });
};

beforeAll(async () => {
  // Either fixture port, whichever is free; never the owner's 8799.
  for (const from of [18_799, 28_799]) {
    try { fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from, span: 1 } }); break; }
    catch (error) { if (from === 28_799 || !/no free port block/.test(String(error))) throw error; }
  }
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => {
  if (fixture) writeFileSync(gatePath(), "1");
  await fixture?.close();
});

it("pins the fixture to a throwaway home and never the owner's live app", () => {
  expect(fixture.info.url).not.toContain(":8799");
  expect(fixture.info.dataDir).not.toContain(".murage");
});

const STOPS: Array<[string, (bot: any) => Promise<{ status: number }>]> = [
  ["the header Stop", bot => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })],
  ["taking the screen back", bot => api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" })],
  ["switching the bot's computer Off", bot => api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })],
  ["the local-computer interrupt", () => api("POST", "/api/local-computer/interrupt", {})],
];

it.runIf(HOST_COMPUTER).each(STOPS)("%s cancels a desktop action already in flight", async (label, stop) => {
  const { bot, client } = await startComputerTurn(`cancel ${label}`);
  let mark = frames().length;
  try {
    const slow = await startSlowAction(client);
    mark = slow.mark;

    const stoppedAt = Date.now();
    expect((await stop(bot)).status).toBe(200);
    const settled = await settledWithin(slow.call, 5_000);
    const elapsed = Date.now() - stoppedAt;

    // The tool call settles now, as cancelled, while the driver is still
    // blocked inside the action — not when the action or a watchdog ends.
    expect(settled, "the tool call was still waiting on the driver").not.toBe("still waiting");
    expect(elapsed).toBeLessThan(2_000);
    expect((settled as any).isError).toBe(true);
    expect(text(settled)).toMatch(/cancel/i);
    expect(text(settled)).toMatch(/may still have taken effect/i);
    expect(frames().slice(mark).some(frame => frame.fixture === "replied")).toBe(false);

    // The driver was told, naming the exact request it is working on.
    const cancels = frames().slice(mark).filter(frame => frame.method === "notifications/cancelled");
    expect(cancels.map(frame => frame.params?.requestId)).toEqual([slow.driverRequestId]);

    // Nothing further reaches the driver.
    const next = await client.request("tools/call", { name: "fixture_ping", arguments: {} }) as any;
    expect(next.isError).toBe(true);
    expect(frames().slice(mark).filter(frame => frame.method === "tools/call")).toHaveLength(1);
  } finally {
    await releaseDriver(mark);
    await client.close();
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" }).catch(() => undefined);
    if (await isBusy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);

it.runIf(HOST_COMPUTER)("keeps the driver exclusive until the cancelled action has really answered", async () => {
  const first = await startComputerTurn("cancel exclusion");
  const { bot } = first;
  let next: { client: EngineClient } | undefined;
  let mark = frames().length;
  try {
    const slow = await startSlowAction(first.client);
    mark = slow.mark;
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    expect(await settledWithin(slow.call, 5_000)).not.toBe("still waiting");
    await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);

    // A fresh turn with full authority is still refused: the cancelled action
    // may be running in the driver, so the screen is not free yet.
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ cancel exclusion next" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("cancel exclusion next");
    const mounted = dump()?.mcpConfig?.mcpServers?.computer;
    next = { client: startHeadlessEngine({ ...mounted, env: { ...process.env, ...mounted.env } }) };
    await next.client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cancel-test", version: "1" } });
    const refused = await next.client.request("tools/call", { name: "fixture_ping", arguments: {} }) as any;
    expect(refused.isError).toBe(true);
    expect(frames().slice(mark).filter(frame => frame.method === "tools/call")).toHaveLength(1);

    // Once the driver really answers the old action, the screen is free.
    await releaseDriver(mark);
    const admitted = await next.client.request("tools/call", { name: "fixture_ping", arguments: {} }) as any;
    expect(text(admitted)).toBe("quick action finished");
  } finally {
    await releaseDriver(mark);
    await first.client.close();
    await next?.client.close();
    if (await isBusy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);

it.runIf(HOST_COMPUTER)("forwards the engine's own cancel of a tool call through to the driver", async () => {
  const { bot, client } = await startComputerTurn("cancel from engine");
  let mark = frames().length;
  try {
    const controller = new AbortController();
    const slow = await startSlowAction(client, controller.signal);
    slow.call.catch(() => undefined);
    mark = slow.mark;
    controller.abort();
    await expect.poll(() => frames().slice(mark).filter(frame => frame.method === "notifications/cancelled").map(frame => frame.params?.requestId), { timeout: 2_000 })
      .toEqual([slow.driverRequestId]);
    expect(frames().slice(mark).some(frame => frame.fixture === "replied")).toBe(false);
    // MCP: the request the engine withdrew gets no response.
    expect(await settledWithin(slow.call, 500)).toBe("still waiting");
    // The turn itself was not stopped; only that one call was withdrawn.
    expect(await isBusy(bot.id)).toBe(true);
  } finally {
    await releaseDriver(mark);
    await client.close();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);
