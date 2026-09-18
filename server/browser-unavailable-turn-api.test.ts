// A browser that cannot be bound never takes the turn down with it. Drives
// the real server over HTTP with the isolated fake Claude CLI and a fake
// agent-browser whose `--version` answer this suite controls: it can hang past
// the version-check budget, and it counts every `--version` spawn, which is
// the only way to see whether the check is repeated.
//
// What a person must see when the browser engine cannot be verified: the turn
// still runs and answers, without browser tools, the bot is told the browser
// is absent this turn, and the conversation carries one quiet note — never
// the red "This request hit a problem" card, which pointed at Provider
// settings for a failure no provider was involved in.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { AGENT_BROWSER_VERSION } from "./browser-engine-release.ts";
import { UNIFIED_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";
import { BROWSER_UNAVAILABLE_PREFIX } from "../shared/browser-unavailable.ts";

// The fixture writes the engine where the server resolves it, a version-check
// budget short enough that a hanging check times out inside the test, and a
// native relay that never launches anything (nothing in this suite drives a
// page; it only needs the binding decision).
const instrumentation = `
import { registerHooks } from 'node:module';
const fs = await import('node:fs');
const path = await import('node:path');
const dataDir = process.env.MURAGE_DATA_DIR;
const spawns = path.join(dataDir, 'version-spawns.log');
const mode = path.join(dataDir, 'engine-mode');
fs.writeFileSync(mode, 'hang\\n');
const binary = path.join(dataDir, 'fake-agent-browser');
fs.writeFileSync(binary, [
  '#!/bin/sh',
  'if [ "$1" != "--version" ]; then exit 1; fi',
  'echo spawn >> ' + JSON.stringify(spawns),
  'read current < ' + JSON.stringify(mode),
  'if [ "$current" = "hang" ]; then exec /bin/sleep 30; fi',
  'echo "agent-browser ${AGENT_BROWSER_VERSION}"',
  '',
].join('\\n'), { mode: 0o755 });
process.env.MURAGE_AGENT_BROWSER_PATH = binary;
const file = path.join(dataDir, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.features = { browser: true };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    export function createNativeBrowser() { return {
      request: async (method) => method === 'tools/list' ? { tools: [] } : { content: [] },
      protected: async () => false, resetStream() {}, input() {}, command: async () => '',
      connect: async () => 'fixture-stream', close: async () => {},
    }; }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    return { format: 'module-typescript', shortCircuit: true,
      source: source.replace(/AGENT_BROWSER_VERIFY_TIMEOUT_MS = [0-9_]+/, 'AGENT_BROWSER_VERIFY_TIMEOUT_MS = 750')
        .replace(/runEngine\\(binary, \\["--version"\\], env, 5000\\)/, 'runEngine(binary, ["--version"], env, 750)') };
  }
  return nextLoad(url, context);
} });
`;

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const messages = async (threadId: string) =>
  (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const activities = async (threadId: string, prefix: string) =>
  (await messages(threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith(prefix));
const versionSpawns = () => {
  const file = join(fixture.info.dataDir, "version-spawns.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
};
const setEngine = (mode: "hang" | "ok") => writeFileSync(join(fixture.info.dataDir, "engine-mode"), `${mode}\n`);
const dump = () => {
  try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; }
};
const createBot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  // The browser is left ON for the bot; only the unrelated surfaces are off.
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", composio: false })).status).toBe(200);
  return bot;
};
/** Send one message and wait until the turn has settled with the bot idle. */
const runTurn = async (bot: any, text: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  const busy = async () =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === bot.threadId)?.busy;
  // The fake dumps when the prompt reaches it; a failed setup never gets here.
  await expect.poll(async () => {
    const reached = JSON.stringify(dump()?.prompt ?? "").includes(text);
    const failed = (await activities(bot.threadId, "error:")).length > 0;
    return reached || failed;
  }, { timeout: 20_000 }).toBe(true);
  await expect.poll(busy, { timeout: 20_000 }).toBe(false);
  return dump();
};

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_799, span: 1 } });
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

it("runs on the fixture's own port and data dir, never the owner's live app", () => {
  expect(fixture.info.url).toBe("http://127.0.0.1:18799");
  expect(fixture.info.dataDir).not.toContain(".murage");
});

let first: any;

it("completes the turn without browser tools when the browser check times out, and says so quietly", async () => {
  setEngine("hang");
  first = await createBot("Browser check timeout fixture");
  const captured = await runTurn(first, "turn the transcript into a workbook");

  // The turn ran: nothing failed and the engine received the prompt.
  expect((await activities(first.threadId, "error:")).map((m) => m.tool.name)).toEqual([]);
  expect(captured, "the provider turn never started").not.toBeNull();
  expect(JSON.stringify(captured.prompt)).toContain("turn the transcript into a workbook");
  // No browser tools were mounted, and the bot was not told it had them.
  expect(captured.mcpConfig?.mcpServers?.browser).toBeUndefined();
  expect(captured.systemPrompt).not.toContain(UNIFIED_BROWSER_SYSTEM_PROMPT.trim().slice(0, 60));
  // The primer's browser-absent clause fired for this turn.
  expect(captured.systemPrompt).toMatch(/You do NOT have, this turn: [^\n]*Murage's built-in browser/);
  // One quiet, accurate note — not an error chip.
  const notes = await activities(first.threadId, BROWSER_UNAVAILABLE_PREFIX);
  expect(notes).toHaveLength(1);
  expect(notes[0].tool.name).toBe(`${BROWSER_UNAVAILABLE_PREFIX} agent-browser command timed out`);
  expect(notes[0].tool.ok).toBe(true);
  expect(versionSpawns()).toBe(1);
}, 60_000);

it("retries a failed check on the next turn, then verifies the binary once for every later turn and binding", async () => {
  setEngine("ok");
  const retried = await runTurn(first, "second turn after the engine recovered");
  // Retried, not cached as a failure: a second spawn, and the browser mounts.
  expect(versionSpawns()).toBe(2);
  expect(retried.mcpConfig?.mcpServers?.browser).toBeDefined();
  expect(await activities(first.threadId, BROWSER_UNAVAILABLE_PREFIX)).toHaveLength(1);

  // A different bot is a different binding (its own session), but the same
  // binary: the successful check is not repeated for it.
  const second = await createBot("Browser check cached fixture");
  const other = await runTurn(second, "a turn on another bot");
  expect(other.mcpConfig?.mcpServers?.browser).toBeDefined();
  await runTurn(first, "third turn on the first bot");
  expect(versionSpawns()).toBe(2);
  expect(await activities(second.threadId, "error:")).toEqual([]);
  expect(await activities(second.threadId, BROWSER_UNAVAILABLE_PREFIX)).toEqual([]);

  // A replaced binary (new size/mtime) is checked again.
  const binary = join(fixture.info.dataDir, "fake-agent-browser");
  appendFileSync(binary, "# replaced\n");
  const third = await createBot("Browser check replaced binary fixture");
  await runTurn(third, "a turn after the engine was replaced");
  expect(versionSpawns()).toBe(3);
}, 120_000);

// The same card fault, one layer over: a turn that fails because THIS
// device's computer was not ready is recorded with that source, so its card
// does not send the person to Provider settings either.
it.skipIf(process.platform === "win32")("tags a computer that was not ready as a local setup failure, not a provider one", async () => {
  const created = await api("POST", "/api/bots", { name: "Computer not ready fixture", modelSelection: { instanceId: "verification", model } });
  const bot = created.body.bot;
  // No CUA Driver descriptor exists in the fixture's data dir, so an explicit
  // "this computer" destination cannot be mounted.
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "use my computer", threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => (await activities(bot.threadId, "error:")).length, { timeout: 20_000 }).toBe(1);
  const [failure] = await activities(bot.threadId, "error:");
  expect(failure.tool.name).toBe("error: CUA Driver is not ready for this computer — check permissions and restart Murage");
  expect(failure.tool.localFailure).toBe("computer");
}, 60_000);

// A room member's turn binds its browser through the same path, and it used
// to throw out of the room turn entirely. It too goes on without the browser.
it("lets a room member's turn go on without the browser when the check times out", async () => {
  setEngine("hang");
  // A changed binary is checked again, so this check really runs (and hangs).
  appendFileSync(join(fixture.info.dataDir, "fake-agent-browser"), "# replaced again\n");
  const before = versionSpawns();
  const bot = await createBot("Room browser timeout fixture");
  const room = (await api("POST", "/api/groups", { name: "Browser timeout room", memberIds: [bot.id] })).body.group;
  expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn without a browser" })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes("room turn without a browser"), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === room.id)?.busyBotId ?? null, { timeout: 20_000 }).toBeNull();
  expect(dump().mcpConfig?.mcpServers?.browser).toBeUndefined();
  expect(await activities(room.threadId, "error:")).toEqual([]);
  const notes = await activities(room.threadId, BROWSER_UNAVAILABLE_PREFIX);
  expect(notes.map((m) => [m.tool.name, m.from?.botId])).toEqual([[`${BROWSER_UNAVAILABLE_PREFIX} agent-browser command timed out`, bot.id]]);
  expect(versionSpawns()).toBe(before + 1);
}, 60_000);
