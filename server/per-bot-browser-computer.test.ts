// Per-bot BROWSER and COMPUTER, driven end to end.
//
// The existing browser-*/computer-* suites are unit-level: they prove a
// controller keys its map correctly, or that a broker refuses a second claim.
// None of them answers the question an owner actually asks — "does THIS bot
// get ITS browser and ITS computer, and can it reach another bot's?" — because
// none of them runs two bots through the real server at once.
//
// This suite does. It boots the real harness (scripts/control-murage.ts, the
// same launcher server/bot-concurrency-api.test.ts uses) against a throwaway
// home, with:
//   * a fake CUA descriptor, so "this computer" mounts without the real driver
//   * a fake agent-browser binary plus a stubbed native relay, so the built-in
//     browser mounts and dispatches without launching Chrome
//   * two engine slots, so two bots can hold turns simultaneously
//
// HEADLESS ONLY. Nothing here opens a window, captures a screen, or touches
// the owner's ~/.murage; the fixture's port is pinned well clear of the live
// app's 8799.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { browserSessionId } from "./browser-engine.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";

/** Auto ("no computer chosen") only reaches this Mac on darwin — see
 * server/local-routing.ts:14. Everywhere else the auto-fallback assertions
 * below describe a branch the platform never takes, so they are skipped
 * rather than silently inverted. */
const AUTO_REACHES_HOST = shouldMountLocalComputer({
  requested: undefined,
  hostPlatform: process.platform,
  providerSupportsLocal: true,
});

// A host "driver" that can be made to block, so two bots can genuinely have a
// computer action outstanding at the same moment. `fixture_hold` returns only
// once `fixture_release` has been called on ITS OWN process, which is what
// makes the broker's single-flight rule observable from two bots.
const fakeHostSource = `import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const gate = process.env.FIXTURE_HOLD_GATE;
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'per-bot-fake-host', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: [
    { name: 'fixture_ping', description: 'No computer action', inputSchema: { type: 'object', properties: {} } },
    { name: 'fixture_hold', description: 'No computer action', inputSchema: { type: 'object', properties: {} } },
  ] };
  else if (rpc.method === 'tools/call' && rpc.params.name === 'fixture_ping') result = { content: [{ type: 'text', text: 'per-bot-pong' }] };
  else if (rpc.method === 'tools/call' && rpc.params.name === 'fixture_hold') {
    writeFileSync(gate + '.started', '1');
    while (gate && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
    result = { content: [{ type: 'text', text: 'per-bot-held' }] };
  }
  else result = { isError: true, content: [{ type: 'text', text: 'unsupported fixture request' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + String.fromCharCode(10));
}`;

// Runs inside the harness child, before server/index.ts loads. Everything it
// writes lives under the fixture's own throwaway data dir.
const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const { registerHooks } = await import('node:module');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);

// --- computer: a host CUA descriptor pointing at the blocking fake driver ---
// (macOS's legacy descriptor, or Linux's supervised one; see the helper)
${fakeHostDescriptorSource({ driverSource: fakeHostSource, driverEnv: {
  FIXTURE_HOST_SECRET: "'synthetic-host-only'",
  FIXTURE_HOLD_GATE: "path.join(dataDir, 'hold-gate')",
} })}

// --- browser: a resolvable "binary" plus a native relay that never launches ---
// resolveAgentBrowserBinary only requires MURAGE_AGENT_BROWSER_PATH to be a
// readable executable file; verifyAgentBrowserBinary and createNativeBrowser
// are replaced below so nothing is ever executed.
const browserBinary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(browserBinary, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = browserBinary;

// Every native session records the AGENT_BROWSER_SESSION it was created for,
// and every dispatch appends to that session's log. That log is the ground
// truth for "which bot drove which browser".
const sessionLog = path.join(dataDir, 'browser-sessions.json');
const record = \`function record(kind, session, extra) {
  const fs = require('node:fs');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(\${JSON.stringify(sessionLog)}, 'utf8')); } catch {}
  log.push({ kind, session, ...(extra ?? {}) });
  fs.writeFileSync(\${JSON.stringify(sessionLog)}, JSON.stringify(log));
}\`;
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    \${record}
    export function createNativeBrowser(spec) {
      const session = spec.env.AGENT_BROWSER_SESSION;
      record('create', session);
      return {
        request: async (method, call) => {
          record('request', session, { method, tool: call && call.name });
          return method === 'tools/list'
            ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'fixture page for ' + session }] };
        },
        protected: async () => false,
        resetStream() {}, input() {},
        command: async () => '',
        connect: async () => 'fixture-stream-' + session,
        close: async () => { record('close', session); },
      };
    }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start)
      + 'export async function verifyAgentBrowserBinary() {}' + String.fromCharCode(10)
      + source.slice(end) };
  }
  return nextLoad(url, context);
} });

// --- a second engine slot, so two bots can hold turns at once ---
const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.instances.second = { ...cfg.instances.verification, displayName: 'Second isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'second-dump.json') } };
// --- an engine that takes a moment to close after Stop, as the real CLI does
// while it tears down its MCP children ---
cfg.instances.slowclose = { ...cfg.instances.verification, displayName: 'Slow-closing isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'slowclose-dump.json'), FAKE_CLAUDE_SIGTERM_DELAY_MS: '600' } };
// --- an engine whose Stop is never confirmed, until the test allows it ---
cfg.instances.nostop = { ...cfg.instances.verification, displayName: 'Unconfirmed-stop isolated engine', environment: { FAKE_CLAUDE_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'nostop-dump.json') } };
const { ClaudeDriver } = await import(${JSON.stringify(new URL("./drivers/claude.ts", import.meta.url).href)});
const create = ClaudeDriver.create;
ClaudeDriver.create = async function (input) {
  const instance = await create.call(this, input);
  if (input.instanceId !== 'nostop') return instance;
  // Only a thread with a turn in flight is refused; an idle one confirms at
  // once, as every real engine's does.
  const running = new Set();
  const send = instance.adapter.sendTurn.bind(instance.adapter);
  instance.adapter.sendTurn = async (turn, ...rest) => { running.add(turn.threadId); return send(turn, ...rest); };
  const stop = instance.adapter.interruptTurn.bind(instance.adapter);
  instance.adapter.interruptTurn = async (threadId, turnId) => {
    if (running.has(threadId) && !fs.existsSync(path.join(dataDir, 'allow-stop'))) {
      // 'stop-throws' makes the refusal a rejection instead of an answer.
      if (fs.existsSync(path.join(dataDir, 'stop-throws'))) throw new Error('fixture engine refused to stop');
      return { closeConfirmed: false, reason: 'timeout' };
    }
    running.delete(threadId);
    return stop(threadId, turnId);
  };
  return instance;
};
fs.writeFileSync(file, JSON.stringify(cfg));
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
const dumpPath = (second: boolean) => second ? join(fixture.info.dataDir, "second-dump.json") : fixture.fixtureDumpPath;
const dump = (second: boolean) => {
  try { return JSON.parse(readFileSync(dumpPath(second), "utf8")); } catch { return null; }
};
/** The last prompt an extra engine slot recorded (see the instrumentation). */
const instanceDump = (instance: "slowclose" | "nostop") => {
  try { return JSON.parse(readFileSync(join(fixture.info.dataDir, `${instance}-dump.json`), "utf8")); } catch { return null; }
};
/** Send a turn to a bot on an extra engine slot and wait until it is dispatched. */
const startInstanceTurn = async (bot: any, label: string, instance: "slowclose" | "nostop") => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(instanceDump(instance)?.prompt ?? ""), { timeout: 15_000 }).toContain(label);
  return instanceDump(instance);
};
/** The emergency stop answers per thread, as `{ botId, threadId }` entries. */
const threadsIn = (entries: unknown): string[] => (Array.isArray(entries) ? entries : []).map((entry: any) => entry.threadId);
const botsIn = (entries: unknown): string[] => (Array.isArray(entries) ? entries : []).map((entry: any) => entry.botId);
const sessionLog = (): Array<{ kind: string; session: string; method?: string; tool?: string }> => {
  try { return JSON.parse(readFileSync(join(fixture.info.dataDir, "browser-sessions.json"), "utf8")); } catch { return []; }
};
const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const task = async (botId: string, threadId: string) => (await state(botId))?.tasks?.find((item: any) => item.threadId === threadId);

/** Create a bot on a named engine slot and return its record. */
const makeBot = async (name: string, instanceId: "verification" | "second" | "slowclose" | "nostop", patch: Record<string, unknown> = {}) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model } });
  expect(created.status, `create ${name}: ${JSON.stringify(created.body)}`).toBe(201);
  const bot = created.body.bot;
  const configured = await api("PATCH", `/api/bots/${bot.id}`, { composio: false, ...patch });
  expect(configured.status, `configure ${name}: ${JSON.stringify(configured.body)}`).toBe(200);
  return bot;
};

/** Send a turn and wait until the fake engine has recorded its prompt, so the
 * turn is genuinely dispatched (and therefore holding its resources). */
const startTurn = async (bot: any, label: string, second: boolean) => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump(second)?.prompt ?? ""), { timeout: 15_000 }).toContain(label);
  return dump(second);
};

/** The browser RPC exactly as the bot's own proxy issues it: the bearer is the
 * whole authority, and the session it reaches is chosen server-side from the
 * thread entry (server/index.ts:9061), never named by the caller. */
const browserRpc = (token: string, method = "tools/list") => fetch(`${fixture.info.url}/api/internal/unified-browser`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ method }),
});

/** The computer RPC exactly as the bot's own proxy issues it, but without the
 * proxy's error flattening — the proxy turns every failure into one generic
 * isError string, and the point here is WHICH refusal came back. */
const hostRpc = async (token: string, tool: string) => {
  const response = await fetch(`${fixture.info.url}/api/internal/host-computer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ method: "tools/call", params: { name: tool, arguments: {} } }),
  });
  return { status: response.status, body: await response.json() as any };
};

/** Config PATCHes that touch browserProfiles carry a compare-and-set snapshot. */
const patchBrowserProfiles = async (profiles: Array<{ id: string; name: string }>) => {
  const current = (await api("GET", "/api/config")).body as { browserProfiles?: Array<{ id: string; name: string }> };
  return api("PATCH", "/api/config", {
    browserProfiles: profiles,
    expectedBrowserProfiles: (current.browserProfiles ?? []).map(({ id, name }) => ({ id, name })),
  });
};

const mountedComputer = (captured: any) => captured?.mcpConfig?.mcpServers?.computer;
const mountedBrowser = (captured: any) => captured?.mcpConfig?.mcpServers?.browser;

/** Open the bot's own computer proxy exactly as its engine would. */
const openComputer = (captured: any): EngineClient => {
  const mounted = mountedComputer(captured);
  expect(mounted, "expected a computer server to be mounted").toBeTruthy();
  return startHeadlessEngine({ ...mounted, env: { ...process.env, ...mounted.env } });
};
const initialize = (client: EngineClient) =>
  client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "per-bot-test", version: "1" } });

beforeAll(async () => {
  // Pinned clear of the owner's live app (8799) — see the suite header.
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 28_799, span: 1 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
}, 60_000);

afterAll(async () => { await fixture?.close(); });

it("pins the fixture to its own port and never the owner's live app", () => {
  expect(fixture.info.url).toBe("http://127.0.0.1:28799");
  expect(fixture.info.dataDir).not.toContain(".murage");
});


// ---------------------------------------------------------------------------
// 2. Assignment is honoured, not defaulted
// ---------------------------------------------------------------------------

it("gives an explicitly-off bot no computer, and hands an unassigned bot this Mac", async () => {
  const off = await makeBot("Computer off", "verification", { computer: "off", browser: false });
  const auto = await makeBot("Computer auto", "second", { browser: false });
  try {
    expect((await state(off.id)).computer).toBe("off");
    // Auto is the absence of a choice, not a choice — nothing is stored.
    expect((await state(auto.id)).computer).toBeUndefined();

    const offTurn = await startTurn(off, "assignment-off", false);
    expect(mountedComputer(offTurn)).toBeUndefined();

    const autoTurn = await startTurn(auto, "assignment-auto", true);
    if (AUTO_REACHES_HOST) {
      // A bot the owner never gave a computer to is still handed the tools
      // for the owner's real desktop by the Auto fallback. Mounting touches
      // nothing: its first actual action waits on a one-time, per-bot
      // confirmation (server/host-computer-consent.ts, covered end to end in
      // server/auto-computer-consent-api.test.ts).
      const mounted = mountedComputer(autoTurn);
      expect(mounted, "unassigned bot reached the host computer").toBeTruthy();
      expect(mounted.args.some((arg: string) => arg.includes("host-computer-proxy"))).toBe(true);
      // Whatever it mounts, the real driver never crosses the turn boundary.
      expect(JSON.stringify(mounted)).not.toContain("fake-host-driver");
      expect(JSON.stringify(mounted)).not.toContain("synthetic-host-only");
      expect(mounted.env.MURAGE_BOT_ID).toBe(auto.id);
    } else {
      expect(mountedComputer(autoTurn)).toBeUndefined();
    }
  } finally {
    for (const bot of [off, auto]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 60_000);

it("gives a browser-off bot no browser and an unassigned bot its own private one", async () => {
  const off = await makeBot("Browser off", "verification", { browser: false });
  const on = await makeBot("Browser default", "second", {});
  let other: any;
  try {
    const offTurn = await startTurn(off, "browser-off", false);
    expect(mountedBrowser(offTurn)).toBeUndefined();

    const onTurn = await startTurn(on, "browser-default", true);
    const mounted = mountedBrowser(onTurn);
    expect(mounted, "a bot with no browserProfile still gets a browser").toBeTruthy();
    expect(mounted.env.MURAGE_BOT_ID).toBe(on.id);
    // Neither the session id nor the engine's encryption key may reach the turn.
    expect(mounted.env).not.toHaveProperty("AGENT_BROWSER_SESSION");
    expect(mounted.env).not.toHaveProperty("AGENT_BROWSER_ENCRYPTION_KEY");

    // Drive it, and confirm the session it lands on is the bot's OWN private
    // one — browser-engine.ts:169 hashes ["bot", botId] when no profile is
    // named, so there is no shared or default profile to fall back to.
    const before = sessionLog().length;
    expect((await browserRpc(mounted.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    await expect.poll(() => sessionLog().slice(before).some(entry => entry.kind === "request"), { timeout: 10_000 }).toBe(true);
    const onSession = sessionLog().slice(before).find(entry => entry.kind === "request")!.session;
    expect(onSession).toBe(browserSessionId(on.id, "", "original-installation"));

    // Observed, not computed: a SECOND unassigned bot must land somewhere
    // else. Deriving the expectation from browserSessionId alone would pass
    // even if every unassigned bot were funnelled into one shared session.
    other = await makeBot("Browser default two", "verification", {});
    const otherMount = mountedBrowser(await startTurn(other, "browser-default-2", false));
    const mark = sessionLog().length;
    expect((await browserRpc(otherMount.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    await expect.poll(() => sessionLog().slice(mark).some(entry => entry.kind === "request"), { timeout: 10_000 }).toBe(true);
    const otherSession = sessionLog().slice(mark).find(entry => entry.kind === "request")!.session;
    expect(otherSession).not.toBe(onSession);
  } finally {
    for (const bot of [off, on, other]) if (bot) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 90_000);

// ---------------------------------------------------------------------------
// 1. Ownership and isolation
// ---------------------------------------------------------------------------

it.runIf(AUTO_REACHES_HOST)("revokes only the stopped bot's computer, never its peer's", async () => {
  const first = await makeBot("Isolation A", "verification", { computer: "local", browser: false });
  const second = await makeBot("Isolation B", "second", { browser: false, hostComputerConsent: "allowed" });
  const clients: EngineClient[] = [];
  try {
    const a = await startTurn(first, "isolation-a", false);
    const b = await startTurn(second, "isolation-b", true);
    // Two bots, two separate capability grants on the one physical Mac.
    expect(mountedComputer(a).env.MURAGE_CONTROL_TOKEN).not.toBe(mountedComputer(b).env.MURAGE_CONTROL_TOKEN);
    expect(mountedComputer(a).env.MURAGE_BOT_ID).toBe(first.id);
    expect(mountedComputer(b).env.MURAGE_BOT_ID).toBe(second.id);

    for (const captured of [a, b]) { const client = openComputer(captured); clients.push(client); await initialize(client); }
    for (const client of clients) expect(await client.request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "per-bot-pong" }] });

    expect((await api("POST", `/api/bots/${first.id}/interrupt`, { threadId: first.threadId })).status).toBe(200);
    // A's grant dies with A's turn; B is untouched. If the grants were keyed
    // on anything shared (the host, the screen, the broker) this would take
    // B down with it.
    expect(await clients[0].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ isError: true });
    expect(await clients[1].request("tools/call", { name: "fixture_ping", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "per-bot-pong" }] });
  } finally {
    for (const client of clients) await client.close();
    for (const bot of [first, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 60_000);

it("keeps two bots on named profiles in separate browser sessions, and neither can name the other's", async () => {
  expect((await patchBrowserProfiles([{ id: "work", name: "Work" }, { id: "client", name: "Client" }])).status).toBe(200);
  const first = await makeBot("Browser work", "verification", { browserProfile: "work" });
  const second = await makeBot("Browser client", "second", { browserProfile: "client" });
  try {
    const a = mountedBrowser(await startTurn(first, "profiles-a", false));
    const b = mountedBrowser(await startTurn(second, "profiles-b", true));
    expect(a.env.MURAGE_CONTROL_TOKEN).not.toBe(b.env.MURAGE_CONTROL_TOKEN);

    const before = sessionLog().length;
    expect((await browserRpc(a.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    expect((await browserRpc(b.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    await expect.poll(() => sessionLog().length, { timeout: 10_000 }).toBeGreaterThan(before + 1);

    const workKey = browserSessionId(first.id, "work", "original-installation");
    const clientKey = browserSessionId(second.id, "client", "original-installation");
    expect(workKey).not.toBe(clientKey);
    const driven = new Set(sessionLog().slice(before).filter(entry => entry.kind === "request").map(entry => entry.session));
    // Observed: two bots, two distinct sessions. The size check is what makes
    // this fail if the two were ever collapsed onto one.
    expect(driven.size).toBe(2);
    expect(driven).toContain(workKey);
    expect(driven).toContain(clientKey);

    // The proxy sends no key at all; the server picks it from the thread
    // entry. So the only way to reach a session is to hold its turn's bearer,
    // and that bearer dies with the turn.
    expect((await api("POST", `/api/bots/${first.id}/interrupt`, { threadId: first.threadId })).status).toBe(200);
    expect([401, 403]).toContain((await browserRpc(a.env.MURAGE_CONTROL_TOKEN)).status);
    expect((await browserRpc(b.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
  } finally {
    for (const bot of [first, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await patchBrowserProfiles([]).catch(() => undefined);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// 3. Concurrency
// ---------------------------------------------------------------------------

it.runIf(AUTO_REACHES_HOST)("refuses a second bot's computer action outright instead of queueing it behind the first", async () => {
  const first = await makeBot("Contention A", "verification", { computer: "local", browser: false });
  const second = await makeBot("Contention B", "second", { computer: "local", browser: false });
  const gate = join(fixture.info.dataDir, "hold-gate");
  try {
    const a = mountedComputer(await startTurn(first, "contention-a", false));
    const b = mountedComputer(await startTurn(second, "contention-b", true));
    // Both turns are admitted and dispatched at once. The admission ledger
    // gives a host-computer turn only `screen:bot:<id>` (server/index.ts:4513),
    // which is per-bot, so nothing serialises these two at the turn level.
    expect(await task(first.id, first.threadId)).toMatchObject({ busy: true });
    expect(await task(second.id, second.threadId)).toMatchObject({ busy: true });
    expect(await task(second.id, second.threadId)).not.toHaveProperty("waitingFor.resource", "computer");

    const held = hostRpc(a.env.MURAGE_CONTROL_TOKEN, "fixture_hold");
    await expect.poll(() => existsSync(`${gate}.started`), { timeout: 15_000 }).toBe(true);

    // With A's action genuinely outstanding on the one shared host, B's call
    // is REFUSED — not queued. The 0.1.54 "tasks queue for busy resources"
    // work covers the turn-level resource ledger; the host computer is
    // excluded from it and falls to HostComputerBroker's single-flight rule
    // (server/host-computer-broker.ts:22), which is a deliberate 409 so a
    // queued click cannot land after the screen has moved on.
    const refused = await hostRpc(b.env.MURAGE_CONTROL_TOKEN, "fixture_ping");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Another computer action is in progress/u);
    expect(refused.body.error).toMatch(/was not performed/u);

    writeFileSync(gate, "1");
    expect((await held).status).toBe(200);
    // Once A's action is confirmed complete the host recycles for B — the
    // exclusion is per-action, not for the rest of A's turn.
    await expect.poll(async () => (await hostRpc(b.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status, { timeout: 15_000 }).toBe(200);
  } finally {
    rmSync(gate, { force: true }); rmSync(`${gate}.started`, { force: true });
    for (const bot of [first, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 90_000);

it("makes a second bot on the SAME browser profile wait for it rather than cross-assign", async () => {
  expect((await patchBrowserProfiles([{ id: "shared", name: "Shared" }])).status).toBe(200);
  const first = await makeBot("Shared browser A", "verification", { browserProfile: "shared", computer: "off" });
  const second = await makeBot("Shared browser B", "second", { browserProfile: "shared", computer: "off" });
  try {
    // One profile is one control boundary even across bots
    // (server/browser-control.ts:1). Both bots therefore resolve to the SAME
    // admission resource `browser:<key>`, so the second turn queues.
    expect(browserSessionId(first.id, "shared", "original-installation"))
      .toBe(browserSessionId(second.id, "shared", "original-installation"));

    await startTurn(first, "shared-a", false);
    expect((await api("POST", `/api/bots/${second.id}/messages`, { threadId: second.threadId, text: "__fixture_hold_authority__ shared-b" })).status).toBe(202);

    // B waits, visibly, on the browser — it is not handed a different session.
    await expect.poll(async () => (await task(second.id, second.threadId))?.waitingFor?.resource, { timeout: 20_000 }).toBe("browser");
    expect(JSON.stringify(dump(true)?.prompt ?? "")).not.toContain("shared-b");

    // Releasing A lets B through, onto the same shared session.
    expect((await api("POST", `/api/bots/${first.id}/interrupt`, { threadId: first.threadId })).status).toBe(200);
    await expect.poll(() => JSON.stringify(dump(true)?.prompt ?? ""), { timeout: 20_000 }).toContain("shared-b");
  } finally {
    for (const bot of [first, second]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await patchBrowserProfiles([]).catch(() => undefined);
  }
}, 90_000);

const LOCAL_MOUNTS = shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform, providerSupportsLocal: true });
it.each([
  { label: "screen", patch: { computer: "local", browser: false }, waits: "computer", runs: LOCAL_MOUNTS },
  { label: "browser", patch: { computer: "off" }, waits: "browser", runs: true },
])("queues a routine due while its own bot holds the $label, then runs it instead of failing", async ({ label, patch, waits, runs }) => {
  if (!runs) return;
  const bot = await makeBot(`Routine ${label} holder`, "verification", patch);
  const name = `Routine ${label} waiter`;
  const routine = (await api("POST", "/api/routines", { name, prompt: `__fixture_hold_authority__ routine-${label}-waiter`, botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false })).body.routine;
  let runId = "";
  try {
    await startTurn(bot, `routine-${label}-holder`, false);
    const started = await api("POST", `/api/routines/${routine.id}/run`);
    expect(started.status).toBe(201); runId = started.body.run.id;
    const routineTask = async () => (await state(bot.id))?.tasks?.find((item: any) => item.title === name);
    const runRecord = async () => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId);
    // The routine takes a free thread slot and then waits, visibly, for the
    // screen/browser its own bot's chat is holding.
    await expect.poll(async () => (await routineTask())?.waitingFor?.resource, { timeout: 20_000 }).toBe(waits);
    expect(JSON.stringify(dump(false)?.prompt ?? "")).not.toContain(`routine-${label}-waiter`);
    expect((await runRecord()).status).toBe("running");
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    await expect.poll(() => JSON.stringify(dump(false)?.prompt ?? ""), { timeout: 20_000 }).toContain(`routine-${label}-waiter`);
    expect((await routineTask()).waitingFor).toBeUndefined();
    expect((await runRecord())).toMatchObject({ status: "running" });
    expect((await runRecord()).error).toBeUndefined();
  } finally {
    if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await api("DELETE", `/api/routines/${routine.id}`).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("the stop-my-computer sweep cancels every routine sharing a host-computer bot, running or queued", async () => {
  const bot = await makeBot("Routine sweep", "verification", { computer: "local", browser: false });
  const made: string[] = [], runIds: string[] = [];
  const runRecord = async (runId: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId);
  try {
    for (const label of ["one", "two"]) {
      const routine = (await api("POST", "/api/routines", { name: `Sweep routine ${label}`, prompt: `__fixture_hold_authority__ sweep-routine-${label}`, botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false })).body.routine;
      made.push(routine.id);
      const started = await api("POST", `/api/routines/${routine.id}/run`);
      expect(started.status).toBe(201); runIds.push(started.body.run.id);
      if (label === "one") await expect.poll(() => JSON.stringify(dump(false)?.prompt ?? ""), { timeout: 20_000 }).toContain("sweep-routine-one");
    }
    // The second routine is admitted to a free slot and queues for the screen.
    await expect.poll(async () => (await state(bot.id))?.tasks?.find((item: any) => item.title === "Sweep routine two")?.waitingFor?.resource, { timeout: 20_000 }).toBe("computer");
    const swept = await api("POST", "/api/local-computer/interrupt", {});
    expect(swept.status).toBe(200);
    for (const runId of runIds) await expect.poll(async () => (await runRecord(runId))?.status, { timeout: 10_000 }).toBe("cancelled");
    expect(JSON.stringify(dump(false)?.prompt ?? "")).not.toContain("sweep-routine-two");
  } finally {
    for (const runId of runIds) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
    for (const id of made) await api("DELETE", `/api/routines/${id}`).catch(() => undefined);
  }
}, 90_000);

// ---------------------------------------------------------------------------
// 5. Capability honesty — does the block match what the bot actually has?
// ---------------------------------------------------------------------------

it("tells a bot the truth about its browser, and says nothing at all about a computer it lacks", async () => {
  const without = await makeBot("Primer without", "verification", { browser: false, computer: "off" });
  const with_ = await makeBot("Primer with", "second", { computer: "off" });
  try {
    const bare = (await startTurn(without, "primer-without", false)).systemPrompt as string;
    const browsing = (await startTurn(with_, "primer-with", true)).systemPrompt as string;

    // BROWSER — honest in both directions. This is the class of bug fixed this
    // release: the primer must not deny a browser to a bot that has one.
    expect(browsing).toMatch(/In this conversation you can[^\n]*browse in Murage's built-in browser/u);
    expect(bare).not.toMatch(/In this conversation you can[^\n]*built-in browser/u);
    expect(bare).toMatch(/You do NOT have, this turn:[^\n]*browser/u);
    // and the browser safety prompt rides with the mount, never without it
    expect(browsing).toMatch(/Take control/u);
    expect(bare).not.toMatch(/Take control/u);

    // COMPUTER — a gap, recorded rather than asserted as correct. The primer's
    // own rule 3 is "ABSENCE IS A FACT … each capability the bot does NOT have
    // is named", but INTEGRATION_FACTS.computer.absent and
    // .localComputer.absent are both "" (server/capabilities-primer.ts:60-67),
    // so a bot with computer:"off" is told nothing either way. It cannot
    // promise a computer it has, but nothing stops it denying one it lacks in
    // its own words, or promising one on a later turn.
    for (const prompt of [bare, browsing]) {
      expect(prompt).not.toMatch(/You do NOT have, this turn:[^\n]*computer/u);
      expect(prompt).not.toMatch(/In this conversation you can[^\n]*computer/u);
    }
  } finally {
    for (const bot of [without, with_]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 60_000);

it.runIf(AUTO_REACHES_HOST)("tells a bot that it can drive a computer whenever one is actually mounted", async () => {
  const auto = await makeBot("Primer auto computer", "verification", { browser: false });
  try {
    const prompt = (await startTurn(auto, "primer-auto-computer", false)).systemPrompt as string;
    // The system prompt's computer paragraph and the primer's "you can" list
    // must agree with the mount. index.ts:4932 adds the local paragraph.
    expect(prompt).toMatch(/act on the user's computer through the computer tools/u);
    expect(prompt).toMatch(/In this conversation you can[^\n]*drive a computer through the computer tools/u);
  } finally {
    await api("POST", `/api/bots/${auto.id}/interrupt`, { threadId: auto.threadId }).catch(() => undefined);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// 4. Lifecycle, and two recorded defects
// ---------------------------------------------------------------------------

// WAS A DEFECT (found and fixed 2026-09-18).
// server/index.ts filtered the "stop touching my computer" sweep to
// `bot.computer === "local"`, while the host RPC gate asked the wider and
// correct question (`undefined || "local"`). A bot that never chose a
// computer is handed the same host Mac by the auto-fallback at
// server/index.ts:4678-4693, and Auto is the DEFAULT for every bot the owner
// creates — so the one control that exists to yank a bot off the owner's
// desktop missed exactly the bots most likely to be on it, and still answered
// `{ ok: true }`. Both sites now ask `botUsesHostComputer`
// (server/local-routing.ts), so they cannot drift apart again.
it.runIf(AUTO_REACHES_HOST)("stops an unassigned bot that is driving this Mac, not only an explicitly-local one", async () => {
  const auto = await makeBot("Panic auto", "verification", { browser: false, hostComputerConsent: "allowed" });
  const explicit = await makeBot("Panic local", "second", { computer: "local", browser: false });
  try {
    const a = mountedComputer(await startTurn(auto, "panic-auto", false));
    const b = mountedComputer(await startTurn(explicit, "panic-local", true));
    expect(a, "the unassigned bot is on the host").toBeTruthy();
    expect(b).toBeTruthy();
    expect((await hostRpc(a.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status).toBe(200);
    expect((await hostRpc(b.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status).toBe(200);

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    // Success is now qualified by what it covered, so a caller can tell
    // "nothing was running" from "something is still on your screen".
    expect(stop.body.ok).toBe(true);
    expect(threadsIn(stop.body.stopped)).toContain(auto.threadId);
    expect(threadsIn(stop.body.stopped)).toContain(explicit.threadId);

    // Both are stopped, and neither bearer reaches the Mac any more.
    for (const bot of [auto, explicit]) {
      await expect.poll(async () => (await task(bot.id, bot.threadId))?.busy, { timeout: 15_000 }).toBe(false);
    }
    expect([401, 403]).toContain((await hostRpc(a.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);
    expect([401, 403]).toContain((await hostRpc(b.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);
  } finally {
    for (const bot of [auto, explicit]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 90_000);

// The other half of the same fix: widening the sweep must not turn it into
// "stop everything". A bot that is explicitly off this computer keeps working
// through a panic stop, and is not named in the answer either.
it.runIf(AUTO_REACHES_HOST)("leaves a bot that is not on this computer running through a panic stop", async () => {
  const auto = await makeBot("Panic scope auto", "verification", { browser: false, hostComputerConsent: "allowed" });
  const elsewhere = await makeBot("Panic scope off", "second", { computer: "off", browser: false });
  try {
    const a = mountedComputer(await startTurn(auto, "panic-scope-auto", false));
    expect(a, "the unassigned bot is on the host").toBeTruthy();
    await startTurn(elsewhere, "panic-scope-off", true);
    expect((await task(elsewhere.id, elsewhere.threadId))?.busy).toBe(true);

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(threadsIn(stop.body.stopped)).toContain(auto.threadId);
    expect(botsIn(stop.body.stopped)).not.toContain(elsewhere.id);

    await expect.poll(async () => (await task(auto.id, auto.threadId))?.busy, { timeout: 15_000 }).toBe(false);
    // Still working: this bot was never on the owner's screen.
    expect((await task(elsewhere.id, elsewhere.threadId))?.busy).toBe(true);
  } finally {
    for (const bot of [auto, elsewhere]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 90_000);

// WAS A DEFECT. The panic sweep sent each interrupt and swallowed the answer,
// so it reported a bot `stopped` even when its engine refused to confirm the
// stop and the turn kept running on the owner's screen. It now stops each bot
// the way the per-bot Stop does — a stop the engine does not confirm keeps the
// turn (and its leases) and is reported under `failed` — and still answers 200,
// because the Linux panel disables the driver straight after this call.
it.runIf(AUTO_REACHES_HOST)("reports a bot whose engine does not confirm the stop as failed, not stopped", async () => {
  const stubborn = await makeBot("Panic unconfirmed", "nostop", { computer: "local", browser: false });
  const willing = await makeBot("Panic confirmed", "second", { computer: "local", browser: false });
  const allow = join(fixture.info.dataDir, "allow-stop");
  try {
    const a = mountedComputer(await startInstanceTurn(stubborn, "panic-unconfirmed", "nostop"));
    expect(a, "the stubborn bot is on the host").toBeTruthy();
    await startTurn(willing, "panic-confirmed", true);

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(false);
    expect(stop.body.failed).toEqual([{ botId: stubborn.id, threadId: stubborn.threadId }]);
    expect(threadsIn(stop.body.stopped)).toContain(willing.threadId);
    expect(botsIn(stop.body.stopped)).not.toContain(stubborn.id);

    // The confirmed one really is idle; the unconfirmed one is not pretended
    // idle, and the thread says why.
    await expect.poll(async () => (await task(willing.id, willing.threadId))?.busy, { timeout: 15_000 }).toBe(false);
    expect((await task(stubborn.id, stubborn.threadId))?.busy).toBe(true);
    expect(JSON.stringify((await api("GET", `/api/threads/${stubborn.threadId}/messages`)).body)).toMatch(/provider stop is unconfirmed/u);
    // Its computer grant is gone regardless: the capability is revoked first.
    expect([401, 403]).toContain((await hostRpc(a.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);

    // Once the engine confirms, the same sweep reports it stopped.
    writeFileSync(allow, "1");
    const again = await api("POST", "/api/local-computer/interrupt", {});
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(threadsIn(again.body.stopped)).toContain(stubborn.threadId);
    await expect.poll(async () => (await task(stubborn.id, stubborn.threadId))?.busy, { timeout: 15_000 }).toBe(false);
  } finally {
    writeFileSync(allow, "1");
    for (const bot of [stubborn, willing]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    rmSync(allow, { force: true });
  }
}, 90_000);

// The same honesty for a bot that is working in a channel when the owner
// pulls the plug: the channel's stop is confirmed with the engine too, whether
// the engine answers "not closed" or its stop call fails outright.
it.runIf(AUTO_REACHES_HOST).each([
  { how: "answers that it has not closed", throws: false },
  { how: "throws", throws: true },
])("reports a channel member whose engine $how on stop as failed", async ({ throws }) => {
  const member = await makeBot(`Panic room ${throws ? "throws" : "unconfirmed"}`, "nostop", { computer: "local", browser: false });
  const allow = join(fixture.info.dataDir, "allow-stop");
  const thrower = join(fixture.info.dataDir, "stop-throws");
  if (throws) writeFileSync(thrower, "1");
  const room = (await api("POST", "/api/groups", {
    name: `Panic room ${throws ? "throws" : "unconfirmed"}`, memberIds: [member.id],
    setup: { bulletin: "Synthetic panic-stop fixture", defaultResponder: { kind: "member", botId: member.id } },
  })).body.group;
  try {
    expect((await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: `__fixture_hold_authority__ panic-room-${throws}` })).status).toBe(202);
    await expect.poll(() => JSON.stringify(instanceDump("nostop")?.prompt ?? ""), { timeout: 15_000 }).toContain(`panic-room-${throws}`);

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ ok: false, failed: [{ botId: member.id, threadId: room.threadId }] });
    expect(botsIn(stop.body.stopped)).not.toContain(member.id);

    writeFileSync(allow, "1");
    const again = await api("POST", "/api/local-computer/interrupt", {});
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
  } finally {
    writeFileSync(allow, "1");
    await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
    await api("POST", `/api/bots/${member.id}/interrupt`, { threadId: member.threadId }).catch(() => undefined);
    rmSync(allow, { force: true });
    rmSync(thrower, { force: true });
  }
}, 90_000);

// WAS A DEFECT. The emergency stop reached only each bot's primary thread, but
// a bot runs up to three threads at once (chats and routines), and any of them
// can be the one on this computer. It now stops every thread that holds this
// computer's grant, and every busy thread of a bot on this computer (those are
// queued for the same screen), and answers per thread.
it.runIf(LOCAL_MOUNTS)("the emergency stop reaches a thread on this computer that is not the bot's primary one", async () => {
  const bot = await makeBot("Emergency threads", "verification", { computer: "local", browser: false });
  const created: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const made = await api("POST", `/api/bots/${bot.id}/tasks`, {});
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    created.push(made.body.task.threadId);
  }
  const threads = [bot.threadId, ...created];
  const primary = (await state(bot.id)).threadId as string;
  expect(threads).toContain(primary);
  const onScreen = threads.find((threadId) => threadId !== primary)!;
  const queued = threads.filter((threadId) => threadId !== onScreen);
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: onScreen, text: "__fixture_hold_authority__ emergency-on-screen" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump(false)?.prompt ?? ""), { timeout: 15_000 }).toContain("emergency-on-screen");
    const mounted = mountedComputer(dump(false));
    expect(mounted, "the non-primary thread is on this computer").toBeTruthy();
    expect((await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status).toBe(200);
    // The other two, the primary among them, queue for the same screen.
    for (const threadId of queued) {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: `__fixture_hold_authority__ emergency-queued-${threadId}` })).status).toBe(202);
      await expect.poll(async () => (await task(bot.id, threadId))?.waitingFor?.resource, { timeout: 15_000 }).toBe("computer");
    }

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(true);
    for (const threadId of threads) expect(threadsIn(stop.body.stopped)).toContain(threadId);
    // The thread that held the screen has lost it, and nothing took it over.
    expect([401, 403]).toContain((await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);
    for (const threadId of threads) await expect.poll(async () => (await task(bot.id, threadId))?.busy, { timeout: 15_000 }).toBe(false);
    for (const threadId of queued) expect(JSON.stringify(dump(false)?.prompt ?? "")).not.toContain(`emergency-queued-${threadId}`);
  } finally {
    for (const threadId of threads) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId }).catch(() => undefined);
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("reports a routine's thread whose engine does not confirm the stop as failed", async () => {
  const bot = await makeBot("Emergency routine unconfirmed", "nostop", { computer: "local", browser: false });
  const routine = (await api("POST", "/api/routines", { name: "Emergency routine stubborn", prompt: "__fixture_hold_authority__ emergency-routine-stubborn", botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false })).body.routine;
  const allow = join(fixture.info.dataDir, "allow-stop");
  let runId = "";
  try {
    const started = await api("POST", `/api/routines/${routine.id}/run`);
    expect(started.status).toBe(201); runId = started.body.run.id;
    await expect.poll(() => JSON.stringify(instanceDump("nostop")?.prompt ?? ""), { timeout: 20_000 }).toContain("emergency-routine-stubborn");
    const threadId = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId).threadId as string;

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(false);
    expect(stop.body.failed).toContainEqual({ botId: bot.id, threadId });
    expect(threadsIn(stop.body.stopped)).not.toContain(threadId);
  } finally {
    writeFileSync(allow, "1");
    if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
    await api("POST", "/api/local-computer/interrupt", {}).catch(() => undefined);
    await api("DELETE", `/api/routines/${routine.id}`).catch(() => undefined);
    rmSync(allow, { force: true });
  }
}, 90_000);

it.runIf(LOCAL_MOUNTS)("the emergency stop stops a routine's thread that is on this computer, and names it", async () => {
  const bot = await makeBot("Emergency routine", "verification", { computer: "local", browser: false });
  const routine = (await api("POST", "/api/routines", { name: "Emergency routine run", prompt: "__fixture_hold_authority__ emergency-routine", botId: bot.id, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, enabled: false })).body.routine;
  let runId = "";
  const runRecord = async () => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === runId);
  try {
    const started = await api("POST", `/api/routines/${routine.id}/run`);
    expect(started.status).toBe(201); runId = started.body.run.id;
    await expect.poll(() => JSON.stringify(dump(false)?.prompt ?? ""), { timeout: 20_000 }).toContain("emergency-routine");
    const mounted = mountedComputer(dump(false));
    expect(mounted, "the routine's thread is on this computer").toBeTruthy();
    const threadId = (await runRecord()).threadId as string;
    expect(threadId).toBeTruthy();
    expect(threadId).not.toBe(bot.threadId);

    const stop = await api("POST", "/api/local-computer/interrupt", {});
    expect(stop.status).toBe(200);
    expect(stop.body.ok).toBe(true);
    expect(stop.body.stopped).toContainEqual({ botId: bot.id, threadId });
    await expect.poll(async () => (await runRecord())?.status, { timeout: 10_000 }).toBe("cancelled");
    expect([401, 403]).toContain((await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);
  } finally {
    if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
    await api("DELETE", `/api/routines/${routine.id}`).catch(() => undefined);
  }
}, 90_000);

// WAS A DEFECT (found and fixed 2026-09-18).
// server/index.ts memoised browser bindings under an UNTAGGED identity:
//     [realmId, partition && partition !== "guest" ? partition : botId, …]
// The middle slot was a partitionId OR a botId with nothing to tell them
// apart. Bot ids are lowercase UUIDs, which satisfy BROWSER_PROFILE_ID
// (/^[a-z0-9_-]{1,40}$/, server/config.ts:22), so an owner could create a
// profile whose id equals some bot's id through the ordinary config route and
// two different bots collapsed onto one native session and one cookie jar.
// browserSessionId itself was always safe — it tags ["profile", p] vs
// ["bot", id] (server/browser-engine.ts:169) — so only the memo collided,
// which also left the admission key (`unifiedBrowserKey`, which never
// consults the memo) disagreeing with the key actually dispatched. The memo
// now tags its slot the same way, so the collision cannot be spelled.
it("keeps two bots apart even when a browser profile is named after a bot's id", async () => {
  const owner = await makeBot("Collision owner", "verification", { computer: "off" });
  expect(owner.id).toMatch(/^[a-z0-9_-]{1,40}$/u);
  // The ordinary, validated config route accepts it.
  expect((await patchBrowserProfiles([{ id: owner.id, name: "Collision" }])).status).toBe(200);
  const victim = await makeBot("Collision victim", "second", { browserProfile: owner.id, computer: "off" });
  try {
    const ownerKey = browserSessionId(owner.id, "", "original-installation");
    const victimKey = browserSessionId(victim.id, owner.id, "original-installation");
    expect(ownerKey, "the id function itself keeps them apart").not.toBe(victimKey);

    const a = mountedBrowser(await startTurn(owner, "collide-owner", false));
    const b = mountedBrowser(await startTurn(victim, "collide-victim", true));
    const before = sessionLog().length;
    expect((await browserRpc(a.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    expect((await browserRpc(b.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);
    await expect.poll(() => sessionLog().slice(before).filter(entry => entry.kind === "request").length, { timeout: 10_000 }).toBeGreaterThan(1);

    const driven = new Set(sessionLog().slice(before).filter(entry => entry.kind === "request").map(entry => entry.session));
    // Two bots, two sessions, two cookie jars — the collision is gone. The
    // size check is what fails if the memo ever collapses them again.
    expect(driven.size).toBe(2);
    expect(driven).toContain(ownerKey);
    expect(driven).toContain(victimKey);
    // And the key actually dispatched is the one admission would have used.
    expect(driven).toEqual(new Set([ownerKey, victimKey]));
  } finally {
    for (const bot of [owner, victim]) await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
    await patchBrowserProfiles([]).catch(() => undefined);
  }
}, 90_000);

// A mutant that survived verification — dropping `entry.ownerId ===
// internalClaim.generation` on the browser RPC path (server/index.ts:9072) —
// is left UNCOVERED, deliberately. No public route can make that clause differ
// from its neighbours: the route demands a "computer"-kind token, and
// server/index.ts:8941 has already refused any claim whose generation is not
// the thread's current one, so a claim that reaches the clause always carries
// the thread's live generation. Making the ENTRY stale instead is the other
// half, and that was a real race — see the next test.

// WAS A DEFECT. After a Stop, the stopped turn's own `turn.completed` event
// arrives late (the engine is killed, then reports) and released the thread's
// browser binding with no owner scope — by then the binding belonged to the
// NEXT turn, so that turn's browser answered 403 "browser turn is no longer
// authorized" for its whole life (19 of 20 runs). The release is now scoped
// to the generation the completing provider turn was bound to.
it("keeps the browser working on the turn after a Stop, every time", async () => {
  const bot = await makeBot("Browser after stop", "slowclose", { computer: "off" });
  const statuses: number[] = [];
  const late: number[] = [];
  const tokens = new Set<string>();
  const refusals = new Set<string>();
  try {
    // Turn 0 has no Stop before it; turns 1..20 each follow one.
    for (let trial = 0; trial <= 20; trial += 1) {
      const mounted = mountedBrowser(await startInstanceTurn(bot, `after-stop-${trial}`, "slowclose"));
      expect(mounted, `trial ${trial} mounted a browser`).toBeTruthy();
      const token = mounted.env.MURAGE_CONTROL_TOKEN as string;
      // A fresh grant per turn — the old turn's bearer is never reused.
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
      const first = await browserRpc(token);
      statuses.push(first.status);
      // The engine takes 600ms to close after Stop, so the previous turn's
      // terminal event can land after this turn was granted its browser.
      // Wait past that, then ask again: the grant must survive the late
      // event, not merely win a race with it.
      await new Promise(resolve => setTimeout(resolve, 900));
      const again = await browserRpc(token);
      late.push(again.status);
      if (again.status !== 200) refusals.add(JSON.stringify(await again.json()));
      // Stop, and send the next message straight away, the way a person
      // does: nothing here waits for the stopped engine to finish closing.
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      // The stopped turn's bearer is dead.
      expect([401, 403]).toContain((await browserRpc(token)).status);
    }
    expect({ statuses, late, refusals: [...refusals] }).toEqual({ statuses: Array(21).fill(200), late: Array(21).fill(200), refusals: [] });
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }
}, 240_000);

it("drops every browser and computer grant when the app restarts, leaving nothing dispatchable", async () => {
  expect((await patchBrowserProfiles([{ id: "restart", name: "Restart" }])).status).toBe(200);
  const bot = await makeBot("Restart", "verification", { browserProfile: "restart", ...(AUTO_REACHES_HOST ? {} : { computer: "off" }) });
  const captured = await startTurn(bot, "restart-1", false);
  const browser = mountedBrowser(captured);
  const computer = mountedComputer(captured);
  expect((await browserRpc(browser.env.MURAGE_CONTROL_TOKEN)).status).toBe(200);

  await fixture.restart();

  // Tokens minted for the old process are worthless, and no turn survives to
  // re-authorize them: the capability dies with the process that granted it.
  expect([401, 403]).toContain((await browserRpc(browser.env.MURAGE_CONTROL_TOKEN)).status);
  if (computer) expect([401, 403]).toContain((await hostRpc(computer.env.MURAGE_CONTROL_TOKEN, "fixture_ping")).status);
  // And the task is not left claiming to be busy across the restart.
  await expect.poll(async () => (await task(bot.id, bot.threadId))?.busy, { timeout: 20_000 }).toBe(false);

  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  await patchBrowserProfiles([]).catch(() => undefined);
}, 90_000);
