// Stopping a turn while a desktop action is already inside the driver.
//
// Every stop lever revokes the turn's authority, so no NEW action can start.
// This suite is about the action that already started: the harness must stop
// waiting for it, tell the driver with MCP `notifications/cancelled` naming the
// request it sent, settle the call, and still refuse the next action until the
// driver has actually answered the old one.
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
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal-line.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { persistentBoundProxyClient } from "./testing/persistent-agents-client.ts";

/** Windows never mounts the host desktop, so there is nothing to cancel.
 * macOS and Linux each mount the fake driver through their own real
 * descriptor (server/testing/fake-host-descriptor.ts). */
// DESIGN 1022-cua-windows D7 makes "This computer" mount on win32 too, but the fake host fixture
// (server/testing/fake-host-descriptor.ts) never publishes a win32 descriptor, so these cells stay off on Windows.
const HOST_COMPUTER = shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal: true }) && process.platform !== "win32";

const fakeDriverSource = `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.env.FIXTURE_DRIVER_LOG;
const gate = process.env.FIXTURE_HOLD_GATE;
const record = (frame) => appendFileSync(log, JSON.stringify({ ...frame, driverPid: process.pid }) + String.fromCharCode(10));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + String.fromCharCode(10));
const rl = createInterface({ input: process.stdin });
rl.on('close', () => record({ fixture: 'exited' }));
rl.on('line', async line => {
  const rpc = JSON.parse(line);
  record(rpc);
  if (rpc.id === undefined) return;
  if (rpc.method === 'initialize') return send(rpc.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cancel-fake-host', version: '1' } });
  if (rpc.method === 'tools/list') return send(rpc.id, { tools: [] });
  if (rpc.method === 'tools/call' && rpc.params.name === 'fixture_slow') {
    while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
    send(rpc.id, { content: [{ type: 'text', text: 'slow action finished' }] });
    return record({ fixture: 'replied', id: rpc.id });
  }
  send(rpc.id, { content: [{ type: 'text', text: 'quick action finished' }] });
});`;

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
${fakeHostDescriptorSource({ driverSource: fakeDriverSource, driverEnv: {
  FIXTURE_DRIVER_LOG: "path.join(dataDir, 'driver-frames.log')",
  FIXTURE_HOLD_GATE: "path.join(dataDir, 'hold-gate')",
} })}
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
// The engine closes 1 ms after SIGTERM while the stop gate exists; a test that
// removes it holds the Stop's close open until it puts the gate back.
process.env.FAKE_CLAUDE_SIGTERM_DELAY_MS = '1';
process.env.FAKE_CLAUDE_SIGTERM_GATE = path.join(dataDir, 'stop-gate');
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
const stopGatePath = () => join(fixture.info.dataDir, "stop-gate");
const frames = (): any[] => {
  try { return readFileSync(join(fixture.info.dataDir, "driver-frames.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
const isBusy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId)?.busy === true;
const text = (result: any) => (result?.content ?? []).map((part: any) => part.text).join(" ");
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<"still waiting">(resolve => setTimeout(() => resolve("still waiting"), ms))]);

// The native engine already owns its single-use shim. Exercise the admitted
// proxy with a bound fixture ingress and the real harness's turn authority.
const openComputer = async () => {
  const mounted = withTurnSecrets(dump())?.mcpConfig?.mcpServers?.computer;
  expect(mounted?.args?.some((arg: string) => arg.includes("host-computer-proxy")), "expected the admitted host computer proxy").toBe(true);
  const client = await persistentBoundProxyClient("hostComputer", mounted.command, mounted.args, mounted.env);
  try { await client.initialize(); return client; }
  catch (error) { await client.close(); throw error; }
};

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
  return { bot, client: await openComputer() };
};

/** Start the slow action and return the id the harness gave it on the wire
 * to the driver — the id a cancel notification must name. */
const startSlowAction = async (client: Awaited<ReturnType<typeof openComputer>>, signal?: AbortSignal) => {
  const mark = frames().length;
  const call = client.request("tools/call", { name: "fixture_slow", arguments: {} }, { signal });
  void call.catch(() => undefined);
  await expect.poll(() => frames().slice(mark).some(frame => frame.method === "tools/call"), { timeout: 10_000 }).toBe(true);
  const sent = frames().slice(mark).find(frame => frame.method === "tools/call");
  return { call, mark, driverRequestId: sent.id };
};

const terminal = { error: { code: -32099, data: { terminal: true } } };
async function expectSealed(client: Awaited<ReturnType<typeof openComputer>>, call: Promise<unknown>) {
  await expect(call).rejects.toThrow(/fixture proxy (closed|exited)/);
  expect(client.terminal()).toMatchObject(terminal);
}

/** Let the driver answer the old action and wait for its process to exit,
 * which is what the harness needs before it will admit another action. */
const releaseDriver = async (mark: number) => {
  const action = frames().slice(mark).find(frame => frame.method === "tools/call" && frame.params?.name === "fixture_slow");
  if (!action) return;
  writeFileSync(gatePath(), "1");
  try {
    // Readiness lists tools on another driver. Only this action's reply and
    // exit prove it is safe to remove the gate.
    const actionFrames = () => frames().slice(mark).filter(frame => frame.driverPid === action.driverPid);
    await expect.poll(() => actionFrames().some(frame => frame.fixture === "replied" && frame.id === action.id), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => actionFrames().some(frame => frame.fixture === "exited"), { timeout: 10_000 }).toBe(true);
  } finally {
    rmSync(gatePath(), { force: true });
  }
};

beforeAll(async () => {
  // Either fixture port, whichever is free; never the owner's 8799.
  for (const from of [18_799, 28_799]) {
    try { fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from, span: 1 } }); break; }
    catch (error) { if (from === 28_799 || !/no free port block/.test(String(error))) throw error; }
  }
  writeFileSync(stopGatePath(), "1");
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

const STOPS: Array<[string, boolean, (bot: any) => Promise<{ status: number }>]> = [
  ["the header Stop", true, bot => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })],
  ["taking the screen back", false, bot => api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" })],
  ["switching the bot's computer Off", true, bot => api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })],
  ["the local-computer interrupt", true, () => api("POST", "/api/local-computer/interrupt", {})],
];

it.runIf(HOST_COMPUTER).each(STOPS)("%s cancels a desktop action already in flight", async (label, revokesTurn, stop) => {
  const { bot, client } = await startComputerTurn(`cancel ${label}`);
  let mark = frames().length;
  try {
    const slow = await startSlowAction(client);
    mark = slow.mark;

    const stoppedAt = Date.now();
    expect((await stop(bot)).status).toBe(200);
    // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: a retired
    // consuming mount sends the authenticated terminal refusal.
    if (revokesTurn) await expectSealed(client, slow.call);
    else {
      const settled = await settledWithin(slow.call, 5_000);
      expect(settled, "the tool call was still waiting on the driver").not.toBe("still waiting");
      expect((settled as any).isError).toBe(true);
      expect(text(settled)).toMatch(/cancel/i);
      expect(text(settled)).toMatch(/may still have taken effect/i);
    }
    const elapsed = Date.now() - stoppedAt;

    // The call settles while the driver is still blocked inside the action.
    expect(elapsed).toBeLessThan(2_000);
    expect(frames().slice(mark).some(frame => frame.fixture === "replied")).toBe(false);

    // The driver was told, naming the exact request it is working on.
    const cancels = frames().slice(mark).filter(frame => frame.method === "notifications/cancelled");
    expect(cancels.map(frame => frame.params?.requestId)).toEqual([slow.driverRequestId]);

    // Nothing further reaches the driver.
    await expectSealed(client, client.request("tools/call", { name: "fixture_ping", arguments: {} }));
    expect(frames().slice(mark).filter(frame => frame.method === "tools/call")).toHaveLength(1);
  } finally {
    await releaseDriver(mark);
    await client.close();
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" }).catch(() => undefined);
    if (await isBusy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);

it.runIf(HOST_COMPUTER)("tells the person, in the chat, that a stopped desktop action may have finished anyway", async () => {
  const { bot, client } = await startComputerTurn("cancel note");
  let mark = frames().length;
  try {
    const slow = await startSlowAction(client);
    mark = slow.mark;
    // Hold the engine's close so the withdrawn action is answered while the
    // Stop is still unconfirmed: the order that used to win most races and
    // replace this line with "some of its context is no longer available".
    rmSync(stopGatePath(), { force: true });
    const stopped = api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    await expectSealed(client, slow.call);
    await expect.poll(() => frames().slice(mark).some(frame => frame.method === "notifications/cancelled"), { timeout: 5_000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    writeFileSync(stopGatePath(), "1");
    expect((await stopped).status).toBe(200);
    await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);
    const notes = async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as any[])
      .filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("Stopped"));
    // One stop line, and it is the one that says to look at the screen —
    // never "Stopped by you" as well (or instead).
    await expect.poll(async () => (await notes()).map((m) => m.tool.name), { timeout: 5_000 })
      .toEqual(["Stopped while an action was running on your screen. It may have finished anyway. Check the screen before retrying."]);
    // The owner's confirmed Stop ends the turn: no refusal row beside it.
    const lines = ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as any[]).map((m) => String(m.text ?? ""));
    expect(lines).not.toContain(LEDGER_REFUSAL_LINE);
  } finally {
    writeFileSync(stopGatePath(), "1");
    await releaseDriver(mark);
    await client.close();
    if (await isBusy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);

it.runIf(HOST_COMPUTER)("still says only \"Stopped by you\" when no desktop action was running", async () => {
  const { bot, client } = await startComputerTurn("cancel note idle");
  try {
    // A finished action is not a running one.
    const done = await client.request("tools/call", { name: "fixture_ping", arguments: {} }) as any;
    expect(text(done)).toBe("quick action finished");
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages as any[])
      .filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("Stopped")).map((m) => m.tool.name), { timeout: 5_000 })
      .toEqual(["Stopped by you"]);
  } finally {
    await client.close();
    if (await isBusy(bot.id)) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);

it.runIf(HOST_COMPUTER)("keeps the driver exclusive until the cancelled action has really answered", async () => {
  const first = await startComputerTurn("cancel exclusion");
  const { bot } = first;
  let next: Awaited<ReturnType<typeof openComputer>> | undefined;
  let mark = frames().length;
  try {
    const slow = await startSlowAction(first.client);
    mark = slow.mark;
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expectSealed(first.client, slow.call);
    await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);

    // A fresh turn with full authority is still refused: the cancelled action
    // may be running in the driver, so the screen is not free yet.
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ cancel exclusion next" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("cancel exclusion next");
    next = await openComputer();
    const refused = await next.request("tools/call", { name: "fixture_ping", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(frames().slice(mark).filter(frame => frame.method === "tools/call")).toHaveLength(1);

    // Once the driver really answers the old action, the screen is free.
    await releaseDriver(mark);
    // The harness frees the screen when it has seen the old driver process
    // exit, a beat after the "exited" frame is written; a refused ping sends
    // nothing to the driver, so asking again until it is admitted is harmless.
    await expect.poll(async () => text(await next!.request("tools/call", { name: "fixture_ping", arguments: {} })), { timeout: 15_000, interval: 250 }).toBe("quick action finished");
  } finally {
    await releaseDriver(mark);
    await first.client.close();
    await next?.close();
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
    mark = slow.mark;
    controller.abort();
    await expect.poll(() => frames().slice(mark).filter(frame => frame.method === "notifications/cancelled").map(frame => frame.params?.requestId), { timeout: 2_000 })
      .toEqual([slow.driverRequestId]);
    expect(frames().slice(mark).some(frame => frame.fixture === "replied")).toBe(false);
    expect(await settledWithin(slow.call, 500)).toBe("still waiting");
    expect(client.state()).toMatchObject({ sealed: false, refusals: 0 });
    expect(await isBusy(bot.id)).toBe(true);

    await releaseDriver(mark);
    await expect.poll(async () => text(await client.request("tools/call", { name: "fixture_ping", arguments: {} })), { timeout: 15_000, interval: 250 }).toBe("quick action finished");
  } finally {
    await releaseDriver(mark);
    await client.close();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }
}, 60_000);
