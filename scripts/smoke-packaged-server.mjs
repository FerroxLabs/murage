// Prove the built server actually STARTS with no node_modules in reach.
//
// 0.1.24 shipped a server that died on every launch with
//   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
// because `tsc` leaves bare imports verbatim and the packaged app carries no
// node_modules. Every existing gate passed it: the unit suite runs in the repo
// (where zod resolves), and the packaging check only asserts index.js EXISTS.
//
// So this copies dist-server OUT of the repo before running it. Inside the
// repo a bare import still resolves by walking up to ./node_modules and the
// test passes on a build that would be dead in the field — which is precisely
// how the bug escaped. The copy is the whole point; do not "simplify" it away.
import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { waitForExit } from "../server/testing/cleanup.ts";
import { raiseLevel } from "../server/testing/raise-level.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "murage-smoke-"));
const home = mkdtempSync(join(tmpdir(), "murage-smoke-home-"));
const port = 21000 + Math.floor(Math.random() * 9000);
const base = `http://127.0.0.1:${port}`;
const dataDir = join(home, ".murage");
const qualifyFuigoTurn = process.platform === "linux";

// MURAGE_SMOKE_DIST lets the release workflow aim this at a packaged app's
// Resources/server tree instead of the repo build.
cpSync(process.env.MURAGE_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });

const fuigoParent = join(staging, "fuigo-fixture-parent");
const workspace = join(home, "workspace");
if (qualifyFuigoTurn) {
  const cli = join(root, "server", "testing", "fake-acp-cli.ts");
  mkdirSync(workspace);
  mkdirSync(join(home, ".fuigo"));
  writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
  writeFileSync(join(workspace, "AGENTS.md"), "# Fixture\nPackaged Fuigo turn complete\n");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    engineDiscovery: "explicit",
    instances: {
      fuigo: { driver: "fuigoAgent", config: { cli, fullAuto: false },
        environment: { FAKE_ACP_MODE: "folder-trust", FAKE_ACP_TRUST_V: "2", FAKE_ACP_VERSION: "1.0.40",
          FAKE_ACP_MCP_READY: "1", FAKE_ACP_PARENT_LOG: fuigoParent } },
    },
  }));
}

const unexpectedHostLaunch = join(staging, "fuigo-host-launch");
const launchObserver = join(staging, "observe-fuigo-launch.mjs");
writeFileSync(launchObserver, `
import cp from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["spawn", "spawnSync", "fork", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    if (args.slice(0, 2).flat().some(arg => typeof arg === "string" && /host-main\\.[tj]s(?:$|["'\\s])/.test(arg))) {
      writeFileSync(${JSON.stringify(unexpectedHostLaunch)}, "");
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
`);
const child = spawn(process.execPath, ["--import", pathToFileURL(launchObserver).href, join(staging, "server", "index.js")], {
  cwd: staging,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    MURAGE_PORT: String(port),
    MURAGE_WEBHOOK_PORT: String(port + 1),
    ...(qualifyFuigoTurn ? { MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" } : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best-effort by design. Windows holds file handles open a little longer than
// the process that owned them, so removing the scratch dir immediately after
// the kill raises EPERM; Linux runners can raise EACCES the same way. Scratch
// cleanup must never decide whether the build is good — it failed a green run
// on Windows once already, and see f66d30f for the same lesson on Linux.
const cleanup = async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  for (const dir of [staging, home]) {
    try {
      safeWipeSync(dir, { maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it; the assertion below is what matters */
    }
  }
};

const deadline = Date.now() + 45_000;
let listening = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = res.ok ? await res.json() : null;
    if (health?.app === "murage" && health.pid === child.pid) {
      listening = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// Serving /api/health is necessary but nowhere near sufficient. Bundling
// relocates import.meta.url, so a module that used to sit in drivers/ resolves
// its sibling paths from the bundle's directory instead — one level too high.
// The 0.1.24 candidate booted and answered /api/health perfectly while every
// spawned proxy pointed outside Resources/server, silently killing permission
// prompts, computer use and dweb. So check the paths the server ACTUALLY
// resolved, from inside the staged copy, before calling the build good.
const probe = join(staging, "server", "probe-proxy-paths.mjs");
writeFileSync(
  probe,
  [
    'import { existsSync } from "node:fs";',
    'import { SPAWNED_PROXIES } from "./proxy-paths.js";',
    'import { wipeGuardEnvironment } from "./env-path.js";',
    'import { delimiter, relative, isAbsolute, sep, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const guardPath = wipeGuardEnvironment({ PATH: "" }, "fixture-guard").PATH.split(delimiter)[0];',
    'const rel = relative(fileURLToPath(new URL(".", import.meta.url)), guardPath);',
    'if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || !existsSync(join(guardPath, "guard.sh"))) throw Error("packaged wipe guard PATH leaves server resources");',
    "const missing = Object.entries(SPAWNED_PROXIES).filter(([, p]) => !existsSync(p));",
    "console.log(JSON.stringify({ resolved: SPAWNED_PROXIES, missing }));",
  ].join("\n"),
);

let proxyReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { cwd: staging });
  proxyReport = JSON.parse(stdout);
} catch (error) {
  proxyReport = { error: String((error && error.message) || error) };
}

// The public MCP process is a second packaged entry point. Send a request and
// close stdin immediately: this proves both that the bundle has no external
// dependencies and that shutdown lets the final JSON-RPC frame drain.
let mcpReport = null;
if (listening) {
  const mcp = spawn(process.execPath, [join(staging, "server", "mcp-server.js")], {
    cwd: staging,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  mcp.stdout.on("data", (chunk) => (stdout += chunk));
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } },
  });
  const health = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_system_health", arguments: {} },
  });
  mcp.stdin.write(`${initialize}\n${health}\n`);
  const healthDeadline = Date.now() + 8_000;
  while (Date.now() < healthDeadline && !stdout.split("\n").some((line) => line.includes('"id":2'))) {
    if (mcp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The ping is deliberately followed by EOF without waiting. If the stdio
  // close path exits before buffered frames drain, id 3 will be missing.
  mcp.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  const closed = new Promise((resolve) => mcp.once("close", (code, signal) => resolve({ code, signal })));
  let timeout;
  const exit = await Promise.race([
    closed,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exit.timeout) {
    await waitForExit(mcp, { signal: "SIGTERM" });
  }
  try {
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    mcpReport = { exit, responses, stderr };
  } catch (error) {
    mcpReport = { exit, stdout, stderr, error: String(error) };
  }
}

let fuigoError;
if (listening && qualifyFuigoTurn) {
  try {
    const secret = await fetch(`${base}/api/desktop-secret`).then(response => response.json());
    const request = async (method, path, body) => {
      const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const created = await request("POST", "/api/bots", { name: "Fuigo fixture", modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
    assert.equal(created.status, 201, "create the packaged smoke fixture bot");
    const { id, threadId } = created.body.bot;
    assert.equal((await request("PATCH", `/api/bots/${id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status, 200);
    assert.equal((await request("PATCH", `/api/bots/${id}/tasks/${threadId}`, { cwd: workspace })).status, 200);
    assert.equal((await raiseLevel(request, id, { noLimits: true, acknowledgeNoLimits: true })).status, 200);
    assert.equal((await request("POST", `/api/bots/${id}/messages`, { threadId, text: "Read the fixture instructions" })).status, 202);
    let replied = false;
    const turnDeadline = Date.now() + 30_000;
    while (Date.now() < turnDeadline) {
      const { body } = await request("GET", `/api/threads/${threadId}/messages?limit=50`);
      replied = body.messages?.some(message => message.role === "bot" && message.text?.includes("Packaged Fuigo turn complete"));
      if (replied) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(replied, true, "the packaged coordinator delivered the Fuigo fixture reply");
    assert.ok(existsSync(fuigoParent), "the Fuigo fixture recorded its parent");
    assert.deepEqual([...new Set(readFileSync(fuigoParent, "utf8").trim().split("\n").map(Number))], [child.pid], "the packaged coordinator launched Fuigo directly");
  } catch (error) { fuigoError = error; }
}

const hostLaunched = existsSync(unexpectedHostLaunch);
const custodyCreated = existsSync(join(dataDir, "hosted-custody.jsonl"));
await cleanup();

if (!listening) {
  console.error(`the packaged server never served /api/health on port ${port}.`);
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

if (fuigoError) throw fuigoError;
// The forwarder is inlined into the packaged bundle, so its init counter is the module evaluation observable.
const reason = process.platform === "win32" ? "dump_policy_unavailable" : "hosted_unqualified";
const fuigoMode = output.split(/\r?\n/).find(line => line.startsWith("[fuigo-mode]"));
assert.equal(fuigoMode, `[fuigo-mode] mode=COORDINATOR reason=${reason} driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=0`);
assert.equal(hostLaunched, false, "packaged coordinator launched a hosted process");
assert.equal(custodyCreated, false, "packaged coordinator left a custody file");

if (!proxyReport || proxyReport.error || proxyReport.missing.length > 0) {
  console.error("spawned proxy paths do not resolve inside the packaged server dir:");
  console.error(JSON.stringify(proxyReport, null, 2));
  console.error("\nthe server would still answer /api/health — and every one of these");
  console.error("features would be dead: permission prompts, computer use, dweb, peer comms.");
  process.exit(1);
}

if (
  !mcpReport ||
  mcpReport.error ||
  mcpReport.exit?.timeout ||
  mcpReport.exit?.code !== 0 ||
  mcpReport.responses?.find((response) => response.id === 1)?.result?.serverInfo?.name !== "murage-mcp" ||
  mcpReport.responses?.find((response) => response.id === 2)?.result?.structuredContent?.status !== "connected" ||
  JSON.stringify(mcpReport.responses?.find((response) => response.id === 3)?.result) !== "{}"
) {
  console.error("the packaged MCP stdio server failed its initialize-health-and-drain smoke test:");
  console.error(JSON.stringify(mcpReport, null, 2));
  process.exit(1);
}

const count = Object.keys(proxyReport.resolved).length;
console.log(`packaged server started with no node_modules in reach (port ${port}, owned pid ${child.pid}) ✓`);
console.log(`all ${count} spawned proxy paths resolve inside the packaged server dir ✓`);
console.log("packaged MCP stdio server reached the API and flushed its final frames ✓");
