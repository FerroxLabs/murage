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
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { AGENT_BROWSER_VERSION } from "./browser-engine-release.ts";
import { UNIFIED_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";
import { BROWSER_UNAVAILABLE_PREFIX } from "../shared/browser-unavailable.ts";

// The fixture writes the engine where the server resolves it, a version-check
// budget short enough that a hanging check times out inside the test, and a
// native relay that never launches a browser. Most tests need only the binding
// decision; the default-on floor test reads one declared consent-button fixture.
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
// Windows cannot execute a script as a program, and the real engine there is
// a native .exe. The same fake engine, written for node, stands in for it:
// only the spawn of this one fake path is routed through node below, and the
// binary file above is still what the server resolves, stamps and re-checks.
const windows = process.platform === 'win32';
const engineScript = path.join(dataDir, 'fake-agent-browser.mjs');
if (windows) fs.writeFileSync(engineScript, [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  "if (process.argv[2] !== '--version') process.exit(1);",
  'appendFileSync(' + JSON.stringify(spawns) + ", 'spawn' + String.fromCharCode(10));",
  'if (readFileSync(' + JSON.stringify(mode) + ", 'utf8').trim() === 'hang') setTimeout(() => {}, 30_000);",
  "else console.log('agent-browser ${AGENT_BROWSER_VERSION}');",
  '',
].join(String.fromCharCode(10)));
// Leave features.browser absent: every binding in this suite uses the shipped default.
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: \`
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    export function createNativeBrowser() { return {
      request: async (method, params) => {
        if (method === 'tools/list') return { tools: [] };
        appendFileSync(join(process.env.MURAGE_DATA_DIR, 'browser-calls.jsonl'), JSON.stringify({ name: params?.name }) + String.fromCharCode(10));
        return { content: [{ type: 'text', text: params?.name === 'agent_browser_get_html' ? '<button>I agree to the terms and conditions</button>' : 'Fixture page' }] };
      },
      protected: async () => false, resetStream() {}, input() {}, command: async () => '',
      connect: async () => 'fixture-stream', close: async () => {},
    }; }
  \` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = fs.readFileSync(new URL(url), 'utf8');
    // A node start on a loaded Windows runner can take most of a 750 ms
    // budget; the hanging engine still sleeps far past either budget.
    const budget = windows ? '5000' : '750';
    let patched = source.replace(/AGENT_BROWSER_VERIFY_TIMEOUT_MS = [0-9_]+/, 'AGENT_BROWSER_VERIFY_TIMEOUT_MS = ' + budget)
      .replace(/runEngine\\(binary, \\["--version"\\], env, 5000\\)/, 'runEngine(binary, ["--version"], env, ' + budget + ')');
    if (windows) {
      const anchor = 'const child = spawn(binary, args, {';
      if (!patched.includes(anchor)) throw new Error('Browser engine spawn fixture anchor changed');
      const fake = 'resolve(binary) === resolve(' + JSON.stringify(binary) + ')';
      patched = patched.replace(anchor, 'const child = spawn(' + fake + ' ? process.execPath : binary, ' + fake + ' ? [' + JSON.stringify(engineScript) + ', ...args] : args, {');
    }
    return { format: 'module-typescript', shortCircuit: true, source: patched };
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
  expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).features ?? {}).not.toHaveProperty("browser");
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

// A bot set to "this computer" before local control is enabled still gets its
// turn: no error card, the engine receives the message, and the bot is told
// how to enable local control if the person asks for a computer action.
it.skipIf(process.platform === "win32")("runs the turn when 'this computer' is chosen but local control is not enabled", async () => {
  const created = await api("POST", "/api/bots", { name: "Computer not ready fixture", modelSelection: { instanceId: "verification", model } });
  const bot = created.body.bot;
  // No CUA Driver descriptor exists in the fixture's data dir, so an explicit
  // "this computer" destination cannot be mounted.
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", browser: false, composio: false })).status).toBe(200);
  const reached = await runTurn(bot, "use my computer");
  expect(await activities(bot.threadId, "error:")).toEqual([]);
  expect(String(reached?.systemPrompt ?? "")).toContain("local control is not enabled yet");
  expect(reached?.mcpConfig?.mcpServers?.computer).toBeUndefined();
  // One status note on the first such turn, not on every turn.
  const note = "Local control is off, so this bot can't use the computer yet. Turn it on in Settings > Computer.";
  const notes = async () => (await messages(bot.threadId)).filter((m: any) => m.text === note && m.murage?.kind === "status");
  expect(await notes()).toHaveLength(1);
  await runTurn(bot, "use my computer again");
  expect(await notes()).toHaveLength(1);
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

it("a bot set to the owner's browser gets a short hint instead of browser tools when Murage for Chrome is not connected", async () => {
  setEngine("ok");
  const bot = await createBot("Owner browser not connected fixture");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "extension" })).status).toBe(200);
  const captured = await runTurn(bot, "check my signed-in dashboard");
  expect(captured.mcpConfig?.mcpServers?.browser).toBeUndefined();
  expect(captured.systemPrompt).not.toContain(UNIFIED_BROWSER_SYSTEM_PROMPT.trim().slice(0, 60));
  expect(captured.systemPrompt).toContain("Murage for Chrome");
  expect(captured.systemPrompt).toContain("request_browser_connection");
  expect((await activities(bot.threadId, "error:")).map((m) => m.tool.name)).toEqual([]);
}, 60_000);

it("keeps the per-bot browser switch in force when the workspace browser defaults on", async () => {
  setEngine("ok");
  const bot = await createBot("Default browser bot switch fixture");
  expect((await api("GET", "/api/config")).body.features.browser).toBe(true);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { browser: false })).status).toBe(200);
  const disabled = await runTurn(bot, "work with the browser switched off for this bot");
  expect(disabled.mcpConfig?.mcpServers?.browser).toBeUndefined();
  expect((await api("PATCH", `/api/bots/${bot.id}`, { browser: true })).status).toBe(200);
  const enabled = await runTurn(bot, "work with this bot's browser enabled");
  expect(enabled.mcpConfig?.mcpServers?.browser).toBeDefined();
  expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).features ?? {}).not.toHaveProperty("browser");
}, 60_000);

// Real server admission and mounted stdio proxy; only the engine version response
// and page relay are fixtures. A consent button must reach the floor before input.
it("hands a consent step to the owner on a default-on browser turn", async () => {
  setEngine("ok");
  const bot = await createBot("Default browser floor fixture");
  let proxy: ChildProcess | undefined;
  try {
    rmSync(fixture.fixtureDumpPath, { force: true });
    const callsFile = join(fixture.info.dataDir, "browser-calls.jsonl");
    rmSync(callsFile, { force: true });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "__fixture_hold_authority__ inspect the terms page", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => dump()?.mcpConfig?.mcpServers?.browser?.env?.MURAGE_BOT_ID, { timeout: 20_000 }).toBe(bot.id);
    const mounted = dump().mcpConfig.mcpServers.browser as { command: string; args: string[]; env: Record<string, string> };
    expect((await api("GET", "/api/config")).body.features.browser).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).features ?? {}).not.toHaveProperty("browser");
    proxy = spawn(mounted.command, mounted.args, {
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, MURAGE_DATA_DIR: fixture.info.dataDir, ...mounted.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proxy.stdout!.on("data", (chunk) => { stdout += chunk; });
    proxy.stderr!.resume();
    const child = proxy;
    const closed = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Browser proxy fixture timed out")); }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    proxy.stdin!.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_click", arguments: { selector: "#accept" } } }) + "\n");
    expect(await closed).toBe(0);
    const reply = JSON.parse(stdout.trim());
    // The built-in floor answers with plain hand-off text (floorToolResult), not an error result,
    // so every engine reads it the same way; it must name the consent step.
    expect(reply.result).toEqual({ content: [{ type: "text", text: expect.stringMatching(/^YOUR TURN: This step needs you in person \(agree to the site's terms or consent\)\./) }] });
    const calls = readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).name);
    expect(calls).toEqual(["agent_browser_get_html"]);
  } finally {
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) proxy.kill();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  }
}, 60_000);

