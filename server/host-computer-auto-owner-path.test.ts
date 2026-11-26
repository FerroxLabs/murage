// ASTRA r5 (TEST-EVIDENCE on 4e3d2628f0), DESIGN 1022-cua-windows D17: the macOS AUTO mount (server/index.ts, the
// `wants === undefined` host mount after the resource waits) binds the setting the mount was decided on (Auto),
// never a store read after the wait. On a macOS owner the bot's primary thread holds the screen on Auto, its second
// thread queues behind it, the owner moves the bot off this computer with the real PATCH (which interrupts only the
// primary thread), and the queued thread then mounts the host from its Auto snapshot: its first click must be refused
// host-off bot-off. The server child reports itself as darwin (process.platform) before anything loads, so the real
// Auto mount site runs on the Linux CI host; the fixture publishes the darwin (legacy) descriptor.
// HEADLESS ONLY: nothing touches a real screen; the data directory is a throwaway temp dir.
// NOT ON A WINDOWS HOST: the darwin spoof also turns on the POSIX directory fsync (server/atomic.ts syncDirectory skips it
// only for win32), and NTFS refuses a directory fsync with EPERM, so the child never boots (Windows host run of 731e1aebde).
// A real Windows owner reports win32 and skips that fsync; this cell is about the macOS Auto mount, which Linux CI runs.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

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
Object.defineProperty(process, 'platform', { value: 'darwin' });
const fs = await import('node:fs');
const path = await import('node:path');
process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR;
const dataDir = fs.realpathSync(process.env.MURAGE_DATA_DIR);
${fakeHostDescriptorSource({ driverSource: fakeHostSource, driverEnv: {
  FIXTURE_HOST_LOG: "path.join(dataDir, 'host-calls.log')",
  FIXTURE_HOLD_GATE: "path.join(dataDir, 'hold-gate')",
} })}
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;

const DARWIN_SPOOF_HOST = process.platform !== "win32";
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
const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
const hostRpc = async (token: string, tool: string) => {
  const response = await fetch(`${fixture.info.url}/api/internal/host-computer`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ method: "tools/call", params: { name: tool, arguments: {} } }),
  });
  return { status: response.status, body: await response.json() as any };
};

beforeAll(async () => {
  if (!DARWIN_SPOOF_HOST) return;
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 24_199, span: 200 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => { await fixture?.close(); });

it.runIf(DARWIN_SPOOF_HOST)("ASTRA-R5 Auto mount: the owner moves the bot off this computer while a second Auto thread waits -> its first click answers 409 host-off bot-off and reaches no driver", async () => {
  const created = await api("POST", "/api/bots", { name: "astra-r5-auto", modelSelection: { instanceId: "verification", model } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, browser: false, computer: null })).status).toBe(200);
  const made = await api("POST", `/api/bots/${bot.id}/tasks`, {});
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const primary = (await state(bot.id)).threadId as string;
  const second = [bot.threadId as string, made.body.task.threadId as string].find((threadId) => threadId !== primary)!;
  try {
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: primary, text: "__fixture_hold_authority__ astra-r5-primary" })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("astra-r5-primary");
    expect(dump()?.mcpConfig?.mcpServers?.computer, "the primary Auto thread holds this computer (macOS Auto mount)").toBeTruthy();
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: second, text: "__fixture_hold_authority__ astra-r5-queued" })).status).toBe(202);
    await expect.poll(async () => Boolean((await state(bot.id)).tasks?.find((item: any) => item.threadId === second)?.waitingFor), { timeout: 15_000 }).toBe(true);
    expect(dump(), "the queued thread has not started its engine").toBeNull();
    const preview = await api("GET", `/api/bots/${bot.id}/browser-choice/preview?mode=builtin`);
    expect(preview.status).toBe(200);
    const moved = await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browserChoice: { mode: "builtin", baseRevision: preview.body.baseRevision, disclosureKey: preview.body.disclosure.disclosureKey } });
    expect([200, 202], JSON.stringify(moved.body)).toContain(moved.status);
    expect((await state(bot.id)).computer, "the bot is off this computer").toBe("off");
    // the PATCH interrupts only a bot that was on "This computer"; an Auto primary run ends by the owner's own Stop
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: primary })).status).toBe(200);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 15_000 }).toContain("astra-r5-queued");
    const mounted = dump()?.mcpConfig?.mcpServers?.computer;
    expect(mounted, "the queued thread mounted the host from its Auto snapshot").toBeTruthy();
    const before = hostCalls().length;
    const refused = await hostRpc(mounted.env.MURAGE_CONTROL_TOKEN as string, "fixture_ping");
    expect({ status: refused.status, code: refused.body.code, cause: refused.body.cause }, expect.getState().currentTestName).toEqual({ status: 409, code: "host-off", cause: "bot-off" });
    expect(hostCalls().length, "0 new frames reached the driver").toBe(before);
  } finally {
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: second }).catch(() => undefined);
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: primary }).catch(() => undefined);
  }
}, 90_000);
