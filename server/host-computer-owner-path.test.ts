// DESIGN 1022-cua-windows R10c / W-C5 (D17 a, b): taking a bot off this computer reaches EVERY thread of that bot.
//
// Booted production server (launchVerificationServer), the fake Claude CLI, and a fake host driver published as the
// host platform's own descriptor (server/testing/fake-host-descriptor.ts), so the host route, the broker and the
// settings route are the unmodified production ones. The bot's SECOND thread holds the screen and its host grant;
// the owner then moves the bot off "This computer" with the real PATCH /api/bots/:id, which interrupts only the
// bot's primary thread. Before D17 the second thread kept its bind-time grant and its next click reached the driver.
// HEADLESS ONLY: nothing touches a real screen; the data directory is a throwaway temp dir.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { hostRefusalText } from "./drivers/host-computer-proxy.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { spawnBoundProxy } from "./testing/bound-proxy-fixture.ts";

// The rows run on the CI host's own platform, linux (design R10c): there "This computer" mounts the fixture and Auto
// never reaches the host, so after the PATCH only the missing selection term could let a click through. On darwin
// Auto still mounts the host, and on win32 the fixture publishes no descriptor.
const LOCAL_MOUNTS = process.platform === "linux" && shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal: true });

// Every tools/call is appended to a log (the ground truth for "reached the driver"); fixture_hold answers only once
// its gate file exists.
const fakeHostSource = `import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const log = process.env.FIXTURE_HOST_LOG;
const gate = process.env.FIXTURE_HOLD_GATE;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  let result;
  if (rpc.method === 'initialize') appendFileSync(log + '.sessions', '1' + String.fromCharCode(10));
  if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'owner-path-fake-host', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [
    { name: 'fixture_ping', description: 'No computer action', inputSchema: { type: 'object', properties: {} } },
    { name: 'fixture_hold', description: 'No computer action', inputSchema: { type: 'object', properties: {} } },
  ] };
  else if (rpc.method === 'tools/call') {
    appendFileSync(log, rpc.params.name + String.fromCharCode(10));
    if (rpc.params.name === 'fixture_die') process.exit(3);
    if (rpc.params.name === 'fixture_hold') {
      writeFileSync(gate + '.started', '1');
      while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
    }
    result = { content: [{ type: 'text', text: 'owner-path-pong' }] };
  }
  else result = { isError: true, content: [{ type: 'text', text: 'unsupported fixture request' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + String.fromCharCode(10));
}`;

const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
${fakeHostDescriptorSource({ driverSource: fakeHostSource, driverEnv: {
  FIXTURE_HOST_LOG: "path.join(dataDir, 'host-calls.log')",
  FIXTURE_HOLD_GATE: "path.join(dataDir, 'hold-gate')",
} })}
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
// ASTRA 731e1aebde (driver-exited over HTTP): main's retired:G reaches the harness only through handleHostMessage
// (server/index.ts:2072), whose wire format admits only win32 generations, and a win32 descriptor needs the pinned
// driver bytes. This stands in for main alone: once 'retire-request' appears it hands the generation of the descriptor
// the turn mounted to the real broker's retireGeneration (what handleHostMessage calls), then republishes the
// descriptor under a fresh generation, as main does when it starts G+1. The route, the broker and the proxy are unchanged.
{
  const { randomUUID } = await import('node:crypto');
  const { HostComputerBroker } = await import(${JSON.stringify(new URL("./host-computer-broker.ts", import.meta.url).href)});
  const brokers = new Set();
  const dispatch = HostComputerBroker.prototype.dispatch;
  HostComputerBroker.prototype.dispatch = function (...args) { brokers.add(this); return dispatch.apply(this, args); };
  const request = path.join(dataDir, 'retire-request');
  setInterval(() => {
    if (!fs.existsSync(request)) return;
    fs.rmSync(request, { force: true });
    const file = path.join(dataDir, 'cua-connection.json');
    const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const broker of brokers) broker.retireGeneration(descriptor.generation, { exitConfirmed: true });
    fs.writeFileSync(file, JSON.stringify({ ...descriptor, generation: randomUUID() }));
    fs.writeFileSync(request + '.done', String(brokers.size));
  }, 25).unref();
}
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
const hostCalls = () => {
  const file = join(fixture.info.dataDir, "host-calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};
const hostSessions = () => {
  const file = join(fixture.info.dataDir, "host-calls.log.sessions");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
};
const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
const hostRpc = async (token: string, tool: string) => {
  const response = await fetch(`${fixture.info.url}/api/internal/host-computer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ method: "tools/call", params: { name: tool, arguments: {} } }),
  });
  return { status: response.status, body: await response.json() as any };
};

/** A bot on "This computer" whose second (non-primary) thread runs a held owner turn holding the screen. */
async function secondThreadOnScreen(name: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, browser: false, computer: "local" })).status).toBe(200);
  const made = await api("POST", `/api/bots/${bot.id}/tasks`, {});
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const primary = (await state(bot.id)).threadId as string;
  const second = [bot.threadId as string, made.body.task.threadId as string].find((threadId) => threadId !== primary)!;
  expect(second, "a thread that is not the bot's primary one").toBeTruthy();
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: second, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain(name);
  const mounted = dump()?.mcpConfig?.mcpServers?.computer;
  expect(mounted, "the second thread is on this computer").toBeTruthy();
  return { bot, second, token: mounted.env.MURAGE_CONTROL_TOKEN as string };
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 23_799, span: 200 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => { await fixture?.close(); });

for (const [label, computer] of [["Auto", null], ["cloud", "cloud"], ["off", "off"]] as const) {
  it.runIf(LOCAL_MOUNTS)(`W-C5 (b) row B, computer -> ${label}: the second thread's next click answers 409 host-off bot-off and reaches no driver`, async () => {
    const { bot, second, token } = await secondThreadOnScreen(`wc5-b-${label}`);
    try {
      const settled = await hostRpc(token, "fixture_ping");
      // setup, own lines: the engine got its reply and nothing is held, so the proxy queue is empty
      expect(settled.status).toBe(200);
      const before = hostCalls().length;
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer })).status).toBe(200);
      expect((await state(bot.id)).tasks?.find((item: any) => item.threadId === second)?.busy, "the second thread's turn still runs").toBe(true);
      const refused = await hostRpc(token, "fixture_ping");
      expect({ status: refused.status, code: refused.body.code, cause: refused.body.cause }, expect.getState().currentTestName).toEqual({ status: 409, code: "host-off", cause: "bot-off" });
      expect(hostCalls().length, "0 new frames reached the driver").toBe(before);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
    }
  }, 90_000);
}

it.runIf(LOCAL_MOUNTS)("W-C5 (d) the mount is not sealed: back on This computer, the same turn's next call reaches the driver", async () => {
  const { bot, second, token } = await secondThreadOnScreen("wc5-d");
  try {
    expect((await hostRpc(token, "fixture_ping")).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);
    expect((await hostRpc(token, "fixture_ping")).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
    const before = hostCalls().length;
    const again = await hostRpc(token, "fixture_ping");
    expect(again.status).toBe(200);
    expect(hostCalls().length).toBe(before + 1);
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("W-C5 (a) row A: a click held inside the driver is withdrawn by the 100 ms poll (under 1.5 s with the PATCH round trip) and answers sent:true", async () => {
  const gate = join(fixture.info.dataDir, "hold-gate");
  rmSync(gate, { force: true });
  rmSync(`${gate}.started`, { force: true });
  const { bot, second, token } = await secondThreadOnScreen("wc5-a");
  try {
    const held = hostRpc(token, "fixture_hold");
    await expect.poll(() => existsSync(`${gate}.started`), { timeout: 15_000 }).toBe(true);
    const moved = Date.now();
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);
    // bounded: a click that is never withdrawn is a failed assertion here, not a hung test
    const answer = await Promise.race([held, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))]);
    expect(answer, "the held click was withdrawn while the turn ran").not.toBeNull();
    expect(Date.now() - moved).toBeLessThan(1_500);
    expect({ status: answer!.status, code: answer!.body.code, cause: answer!.body.cause, sent: answer!.body.sent }).toEqual({ status: 409, code: "host-off", cause: "bot-off", sent: true });
  } finally {
    writeFileSync(gate, "1");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);

// DESIGN R10b / W-C4 (P3 r4 boundary): with Local control on and a ready descriptor of the host's own platform, a bot
// on Auto gets no host computer at the real turn entry (owner send route -> startTurnAdmitting and its computer
// blocks); only an explicit "This computer" mounts it. The fake engine reports the MCP servers it was started with.
async function autoTurn(name: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, browser: false, computer: null })).status).toBe(200);
  rmSync(fixture.fixtureDumpPath, { force: true });
  const sessions = hostSessions();
  const calls = hostCalls().length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain(name);
  return { bot, sessions, calls, servers: dump()?.mcpConfig?.mcpServers ?? {} };
}

it.runIf(LOCAL_MOUNTS)("W-C4 (a) a bot on Auto: the engine is started with no host-computer MCP server", async () => {
  const { bot, servers } = await autoTurn("wc4-a");
  try {
    expect(Object.keys(servers), expect.getState().currentTestName).not.toContain("computer");
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("W-C4 (b) a bot on Auto: 0 broker sessions and 0 driver frames after the turn's reply arrived", async () => {
  const { bot, sessions, calls } = await autoTurn("wc4-b");
  try {
    expect((await state(bot.id)).busy, "the Auto turn is running").toBe(true);
    expect({ sessions: hostSessions() - sessions, frames: hostCalls().length - calls }, expect.getState().currentTestName).toEqual({ sessions: 0, frames: 0 });
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("W-C4 (c) control: the owner sets the bot to This computer -> next turn mounts the host, 1 session, 1 call reaches the driver", async () => {
  const { bot } = await autoTurn("wc4-c-auto");
  await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
  await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15_000 }).toBe(false);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
  rmSync(fixture.fixtureDumpPath, { force: true });
  const sessions = hostSessions();
  const calls = hostCalls().length;
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "__fixture_hold_authority__ wc4-c-local" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("wc4-c-local");
    const mounted = dump()?.mcpConfig?.mcpServers?.computer;
    expect(mounted, expect.getState().currentTestName).toBeTruthy();
    const answer = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN as string, "fixture_ping");
    expect(answer.status).toBe(200);
    expect({ sessions: hostSessions() - sessions, frames: hostCalls().length - calls }).toEqual({ sessions: 1, frames: 1 });
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
  }
}, 90_000);

// OPUS H1 on 7b894ab0dc (D17): the grant binds the setting the mount was decided on (the turn-start snapshot), never
// a store read after the resource wait. The bot's PRIMARY thread holds the screen; its second thread queues behind it
// for the same screen; the owner moves the bot to Auto with the real PATCH, which interrupts only the primary thread,
// so the queued thread is then admitted and mounts the host from its "This computer" snapshot. Its first click must be
// refused bot-off: before the fix the grant read Auto after the wait and the click reached the driver.
it.runIf(LOCAL_MOUNTS)("OPUS-H1 revoke during the resource wait: the queued thread's first click answers 409 host-off bot-off and reaches no driver", async () => {
  const created = await api("POST", "/api/bots", { name: "opus-h1", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, browser: false, computer: "local" })).status).toBe(200);
  const made = await api("POST", `/api/bots/${bot.id}/tasks`, {});
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const primary = (await state(bot.id)).threadId as string;
  const second = [bot.threadId as string, made.body.task.threadId as string].find((threadId) => threadId !== primary)!;
  try {
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: primary, text: "__fixture_hold_authority__ opus-h1-primary" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("opus-h1-primary");
    expect(dump()?.mcpConfig?.mcpServers?.computer, "the primary thread holds this computer").toBeTruthy();
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: second, text: "__fixture_hold_authority__ opus-h1-queued" })).status).toBe(202);
    await expect.poll(async () => Boolean((await state(bot.id)).tasks?.find((item: any) => item.threadId === second)?.waitingFor), { timeout: 15_000 }).toBe(true);
    expect(dump(), "the queued thread has not started its engine").toBeNull();
    // with two runs of the bot live, the route admits a settings change only together with a browser choice
    // (index.ts patchBot route.14 guard); the owner's chooser sends the built-in browser here
    const preview = await api("GET", `/api/bots/${bot.id}/browser-choice/preview?mode=builtin`);
    expect(preview.status).toBe(200);
    const moved = await api("PATCH", `/api/bots/${bot.id}`, { computer: null, browserChoice: { mode: "builtin", baseRevision: preview.body.baseRevision, disclosureKey: preview.body.disclosure.disclosureKey } });
    // 202: the browser choice waits for the running turns; the computer setting itself is applied now
    expect([200, 202], JSON.stringify(moved.body)).toContain(moved.status);
    expect((await state(bot.id)).computer ?? null, "the bot is off This computer").toBeNull();
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("opus-h1-queued");
    const mounted = dump()?.mcpConfig?.mcpServers?.computer;
    expect(mounted, "the queued thread mounted from its This computer snapshot").toBeTruthy();
    const before = hostCalls().length;
    const refused = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN as string, "fixture_ping");
    expect({ status: refused.status, code: refused.body.code, cause: refused.body.cause }, expect.getState().currentTestName).toEqual({ status: 409, code: "host-off", cause: "bot-off" });
    expect(hostCalls().length, "0 new frames reached the driver").toBe(before);
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: primary }).catch(() => undefined);
  }
}, 90_000);

// ASTRA 731e1aebde: the driver-exited branch of the host route (server/index.ts:31605) over HTTP, and the bot's text
// for driver-exited and driver-lost from the REAL proxy the engine runs (spawned from the turn's own computer mount,
// server/drivers/host-computer-proxy.ts:94), not from hostRefusalText. A click is held inside the driver; main confirms
// the driver of that generation exited (retired:G, the instrumentation's stand-in for main); the waiting call answers
// 409 driver-exited sent:true. Before r8 the route dropped the code and sent (409 with the message only) and the proxy
// said "unavailable". Each retire is followed by a fresh generation, so every later cell's turn mounts G+1.
const retireMountedGeneration = async () => {
  const done = join(fixture.info.dataDir, "retire-request.done");
  rmSync(done, { force: true });
  writeFileSync(join(fixture.info.dataDir, "retire-request"), "1");
  await expect.poll(() => existsSync(done), { timeout: 15_000 }).toBe(true);
  expect(readFileSync(done, "utf8"), "main's retire reached the harness broker").toBe("1");
};
const resetHoldGate = () => {
  const gate = join(fixture.info.dataDir, "hold-gate");
  rmSync(gate, { force: true });
  rmSync(`${gate}.started`, { force: true });
  return gate;
};
/** The real host-computer proxy from this turn's mount, behind the house release fixture: send() one tools/call. */
async function mountedProxy() {
  const mounted = dump()?.mcpConfig?.mcpServers?.computer;
  const proxy = await spawnBoundProxy("hostComputer", mounted.command, mounted.args ?? [], { env: { ...mounted.env } });
  const replies = new Map<number, any>();
  let buffered = "", stderr = "", id = 1;
  proxy.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  proxy.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      try { const rpc = JSON.parse(line); if (rpc.id !== undefined) replies.set(rpc.id, rpc); } catch { /* not a reply */ }
    }
  });
  const request = (method: string, params: object) => {
    const current = id++;
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    return async () => {
      // no assertion here: a proxy that never answers (it sealed on a 500) is the cell's own behavioural failure
      for (let waited = 0; !replies.has(current) && waited < 15_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      return replies.get(current) ?? { unanswered: true, exit: proxy.exitCode, stderr: stderr.slice(-400) };
    };
  };
  expect((await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "owner-path", version: "1" } })())?.result?.serverInfo?.name, "the proxy started").toBe("murage-host-computer");
  return { call: (tool: string) => request("tools/call", { name: tool, arguments: {} }), close: () => proxy.kill() };
}

it.runIf(LOCAL_MOUNTS)("W-K4 route: main retires the generation while a click is held in its driver -> the waiting call answers 409 driver-exited sent:true at the host route", async () => {
  const gate = resetHoldGate();
  const { bot, second, token } = await secondThreadOnScreen("wk4-exited-route");
  try {
    const held = hostRpc(token, "fixture_hold");
    await expect.poll(() => existsSync(`${gate}.started`), { timeout: 15_000 }).toBe(true);
    await retireMountedGeneration();
    const exited = await held;
    expect({ status: exited.status, code: exited.body.code, sent: exited.body.sent }, expect.getState().currentTestName).toEqual({ status: 409, code: "driver-exited", sent: true });
  } finally {
    writeFileSync(gate, "1");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("W-K4 proxy: the same retire under a click the real proxy carries -> the bot reads that the driver stopped and the action may have partly happened", async () => {
  const gate = resetHoldGate();
  const { bot, second } = await secondThreadOnScreen("wk4-exited-proxy");
  const proxy = await mountedProxy();
  try {
    const reply = proxy.call("fixture_hold");
    await expect.poll(() => existsSync(`${gate}.started`), { timeout: 15_000 }).toBe(true);
    await retireMountedGeneration();
    const answer = await reply();
    expect({ isError: answer?.result?.isError, text: answer?.result?.content?.[0]?.text }, expect.getState().currentTestName).toEqual({ isError: true, text: "This computer's driver stopped while this action ran. It may have partly happened; check the screen before continuing." });
  } finally {
    proxy.close();
    writeFileSync(gate, "1");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("W-K6 proxy: a driver child that exits under a click the real proxy carries -> the bot reads that the connection broke and the action may have partly happened", async () => {
  const { bot, second } = await secondThreadOnScreen("wk6-lost-proxy");
  const proxy = await mountedProxy();
  try {
    const answer = await proxy.call("fixture_die")();
    expect({ isError: answer?.result?.isError, text: answer?.result?.content?.[0]?.text }, expect.getState().currentTestName).toEqual({ isError: true, text: "This computer's driver connection broke while this action ran. It may have partly happened; check the screen before continuing." });
  } finally {
    proxy.close();
    // the lost action keeps the claim until main retires G (C8); retire it so the next cell's turn mounts G+1
    await retireMountedGeneration();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);

// ASTRA precheck on caf3fd457a (r8): W-K6 at the HTTP boundary. The fake host's MCP child exits after taking the click
// (C8 / D16 a), through the booted server's real host route and broker: the answer is 409 with code driver-lost and
// sent:true (before: the outer handler answered 409 with the message only), and the proxy's text for that body is the
// D16 sentence, not the generic "unavailable". LAST in this file: the lost action keeps the claim and nothing retires
// it afterwards, so no later cell may need the host.
it.runIf(LOCAL_MOUNTS)("W-K6 route: a driver child that exits under a click answers 409 driver-lost sent:true at the host route, and the proxy says the action may have partly happened", async () => {
  const { bot, second, token } = await secondThreadOnScreen("wk6-route");
  try {
    const before = hostCalls().length;
    const lost = await hostRpc(token, "fixture_die");
    expect(hostCalls().length, "the click reached the driver").toBe(before + 1);
    expect({ status: lost.status, code: lost.body.code, sent: lost.body.sent }, expect.getState().currentTestName).toEqual({ status: 409, code: "driver-lost", sent: true });
    expect(hostRefusalText(lost.body) ?? "(no D16 text)").toMatch(/connection broke while this action ran\. It may have partly happened/);
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
  }
}, 90_000);
