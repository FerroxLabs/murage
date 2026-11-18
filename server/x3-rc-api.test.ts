import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeTestHome, removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { cleanupAfter } from "./testing/cleanup-after.ts";
import { freePortBlock } from "./testing/ports.ts";
import { raiseLevel } from "./testing/raise-level.ts";
import { prepareMemoryMeterFixture } from "./memory/testing/native-meter-fixture.ts";

// A real isolated server and a local fake engine. The fake requests permission;
// it never executes the command or calls an external provider.
const server = dirname(fileURLToPath(import.meta.url));
let home: string, base: string, child: ChildProcess, stderr = "";
let headers: Record<string, string> = {};
const writePaths = ["/tmp/murage-mcp-Ab12Cd/mcp.json", "/work/shell-snapshots/fixture.sh", "/tmp/murage-render-" + "a".repeat(16) + "/mcp.json"];
const rootGlobs = ["/*", "/**"];
const ready = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" };
const evidence = process.env.X3_FIXTURE_EVIDENCE;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (evidence) appendFileSync(join(evidence, "requests.jsonl"), JSON.stringify({ method, path, body, status: response.status }) + "\n");
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  if (evidence) mkdirSync(evidence, { recursive: true });
  home = makeTestHome("murage-x3-rc-api-");
  prepareMemoryMeterFixture(home);
  mkdirSync(join(home, ".murage"), { recursive: true });
  mkdirSync(join(home, "project"));
  writeFileSync(join(home, "project", "fixture-credentials.json"), "{}");
  mkdirSync(join(home, "root-fixture"));
  writeFileSync(join(home, "root-fixture", "credentials.json"), "{}");
  writeFileSync(join(home, "root-fixture", "README.md"), "fixture");
  writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    glob: { driver: "grokAgent", environment: { ...ready, FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_SESSION: "1", FAKE_ACP_DUMP: join(home, "permission-dump.json"), FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: "cat " + JSON.stringify(join(home, "project").replaceAll("\\", "/")) + "/fixture-*" },
      config: { cli: join(server, "testing", "fake-acp-cli.ts"), fullAuto: false } },
    ...Object.fromEntries(rootGlobs.map((glob, index) => ["root" + index, {
      driver: "grokAgent", environment: { ...ready, FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_SESSION: "1",
        FAKE_ACP_DUMP: join(home, `root-${index}.json`), FAKE_ACP_TOOL_KIND: "think", FAKE_ACP_PERMISSION_COMMAND: "cat " + glob },
      config: { cli: join(server, "testing", "fake-acp-cli.ts"), fullAuto: false },
    }])),
    ...Object.fromEntries(writePaths.map((path, index) => ["write" + index, {
      driver: "grokAgent", environment: { ...ready, FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_SESSION: "1",
        FAKE_ACP_DUMP: join(home, `write-${index}.json`),
        FAKE_ACP_PERMISSION_TOOLCALL: JSON.stringify({ toolCallId: "write", kind: "edit", title: "Write " + path,
          rawInput: { file_path: path, content: "rm -rf /" }, locations: [{ path }] }) },
      config: { cli: join(server, "testing", "fake-acp-cli.ts"), fullAuto: false },
    }])),
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const preload = join(home, "fake-engine-setup.mjs");
  // Give the isolated server a tiny filesystem-root listing backed by real
  // temporary files. No host-root file is created; command strings stay inert.
  writeFileSync(preload, `import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const opendir = fs.opendir;
const root = await fs.realpath('/');
// Real synchronous fixture reads avoid worker-pool scheduling consuming X3's 50 ms budget.
fs.realpath = async (path, options) => nativeFs.realpathSync.native(path, options);
fs.opendir = async (path, options) => {
  if (path !== root && path !== ${JSON.stringify(join(home, "project"))}) return opendir(path, options);
  const directory = nativeFs.opendirSync(path === root ? ${JSON.stringify(join(home, "root-fixture"))} : path, options);
  directory.read = async () => directory.readSync();
  directory.close = async () => directory.closeSync();
  return directory;
};
syncBuiltinESMExports();
globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
`);
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--import", pathToFileURL(join(server, "testing", "idle-load-preload.mjs")).href, join(server, "index.ts")], {
    windowsHide: true, cwd: join(server, ".."), env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      MURAGE_ENGINE_EXCLUSION_PATH: process.env.MURAGE_ENGINE_EXCLUSION_PATH,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.resume();
  child.stderr!.on("data", data => { stderr += data; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`Isolated server did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status, stderr).toBe(200);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 40_000);
afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (evidence) {
    writeFileSync(join(evidence, "server.log"), stderr);
    writeFileSync(join(evidence, "launch.json"), JSON.stringify({ url: base, pid: child?.pid, home }, null, 2));
  }
  if (home) await removeTempDir(home);
});

for (const globFixture of [
  { instanceId: "glob", dump: "permission-dump.json", title: "X3 RC registry:" },
  ...rootGlobs.map((glob, index) => ({ instanceId: "root" + index, dump: `root-${index}.json`, title: `X3 RC root fixture cat ${glob}:` })),
]) for (const level of ["Full access", "No limits"] as const) it(`${globFixture.title} ${level} receives the prepared glob finding`, async () => {
  const created = await api("POST", "/api/bots", { name: "Glob fixture", modelSelection: { instanceId: globFixture.instanceId, model: "fake-model" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot;
  await cleanupAfter(async () => {
  expect((await api("PATCH", `/api/bots/${bot.id}`, { cwd: join(home, "project"), computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true, noLimits: level === "No limits", ...(level === "No limits" ? { acknowledgeNoLimits: true } : {}) })).status).toBe(200);
  const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id);
  expect(state.tasks.find((task: any) => task.threadId === bot.threadId)).toMatchObject({ fullAccess: true, noLimits: level === "No limits" });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Read the fixture" })).status).toBe(202);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
  if (level === "Full access") {
    await expect.poll(async () => (await messages()).some(row => row.card?.requestHandle && !row.card.answered), { timeout: 25_000 }).toBe(true).catch(async error => { throw new Error(JSON.stringify({ cause: String(error), messages: await messages(), stderr: stderr.slice(-5000) })); });
    const card = (await messages()).find(row => row.card?.requestHandle && !row.card.answered);
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestHandle: card.card.requestHandle, action: "deny" })).status).toBe(200);
    await expect.poll(() => JSON.parse(readFileSync(join(home, globFixture.dump), "utf8")).decision, { timeout: 5_000 })
      .toMatchObject({ outcome: { outcome: "selected", optionId: "reject" } });
  } else {
    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id);
      return state?.tasks.find((task: any) => task.threadId === bot.threadId)?.busy === false;
    }, { timeout: 25_000 }).toBe(true);
    expect((await messages()).filter(row => row.card?.requestHandle)).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(home, globFixture.dump), "utf8")).decision).toMatchObject({ outcome: { outcome: "selected", optionId: "allow-once" } });
  }
  if (evidence) writeFileSync(join(evidence, `${globFixture.instanceId}-${level.replaceAll(" ", "-")}.json`), JSON.stringify({
    fixture: globFixture.title, level, messages: await messages(), decision: JSON.parse(readFileSync(join(home, globFixture.dump), "utf8")).decision,
  }, null, 2));
  }, () => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }), "interrupt");
});

for (const [index, path] of writePaths.entries()) for (const level of ["Full access", "No limits"] as const)
  it(`X3 RC Write API ${level}: ${path}`, async () => {
    const created = await api("POST", "/api/bots", { name: "Write fixture", modelSelection: { instanceId: "write" + index, model: "fake-model" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    await cleanupAfter(async () => {
    expect((await api("PATCH", `/api/bots/${bot.id}`, { cwd: join(home, "project"), computer: "off", browser: false, composio: false })).status).toBe(200);
    expect((await raiseLevel(api, bot.id, { fullAccess: true, acknowledgeFullAccess: true,
      noLimits: level === "No limits", ...(level === "No limits" ? { acknowledgeNoLimits: true } : {}) })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Write the fake fixture" })).status).toBe(202);
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    if (level === "Full access") {
      await expect.poll(async () => (await messages()).some(row => row.card?.requestHandle && !row.card.answered), { timeout: 25_000 }).toBe(true).catch(async error => { throw new Error(JSON.stringify({ cause: String(error), messages: await messages(), stderr: stderr.slice(-5000) })); });
      const card = (await messages()).find(row => row.card?.requestHandle && !row.card.answered);
      expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestHandle: card.card.requestHandle, action: "deny" })).status).toBe(200);
    } else {
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id);
        return state?.tasks.find((task: any) => task.threadId === bot.threadId)?.busy === false;
      }, { timeout: 25_000 }).toBe(true).catch(async error => { throw new Error(JSON.stringify({ cause: String(error), messages: await messages(), stderr: stderr.slice(-5000) })); });
      expect((await messages()).filter(row => row.card?.requestHandle)).toHaveLength(0);
    }
    await expect.poll(() => JSON.parse(readFileSync(join(home, `write-${index}.json`), "utf8")).decision, { timeout: 5_000 })
      .toMatchObject({ outcome: { outcome: "selected", optionId: level === "No limits" ? "allow-once" : "reject" } });
    }, () => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }), "interrupt");
  });
