import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HostComputerBroker, hostComputerSession } from "../server/host-computer-broker.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(root, "dist-native", "cua-linux-x64", "cua-driver");
if (process.platform !== "linux") throw new Error("the X11 input smoke is Linux-only");
if (!process.env.DISPLAY) throw new Error("the X11 input smoke needs an active DISPLAY");
if (!existsSync(driver)) throw new Error(`missing staged Cua Driver: ${driver}`);

const prefix = "murage-cua-x11-input-";
const sandbox = mkdtempSync(path.join(tmpdir(), prefix));
if (path.dirname(sandbox) !== path.resolve(tmpdir()) || !path.basename(sandbox).startsWith(prefix)) {
  throw new Error(`unexpected smoke directory: ${sandbox}`);
}
const runtime = path.join(sandbox, "runtime");
const home = path.join(sandbox, "home");
const socketPath = path.join(runtime, "driver.sock");
const pidFile = path.join(runtime, "driver.pid");
mkdirSync(runtime, { mode: 0o700 });
mkdirSync(home, { mode: 0o700 });
chmodSync(runtime, 0o700);
chmodSync(home, 0o700);

const title = `Murage CUA input safety ${process.pid}`;
const xev = spawn(
  "xev",
  ["-name", title, "-geometry", "320x180+40+40"],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let xevOutput = "";
for (const stream of [xev.stdout, xev.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    xevOutput += chunk;
  });
}

const driverProcess = spawn(
  driver,
  [
    "serve",
    "--embedded",
    "--no-overlay",
    "--socket",
    socketPath,
    "--pid-file",
    pidFile,
    "--permission-mode",
    "standard",
  ],
  {
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
      XDG_SESSION_TYPE: "x11",
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    },
    stdio: ["pipe", "ignore", "pipe"],
  },
);
let driverError = "";
driverProcess.stderr.setEncoding("utf8");
driverProcess.stderr.on("data", (chunk) => {
  driverError += chunk;
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(probe, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (driverProcess.exitCode !== null || driverProcess.signalCode !== null) {
      throw new Error(
        `Cua Driver exited before ${description}: ${driverProcess.exitCode ?? driverProcess.signalCode}\n${driverError}`,
      );
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}\n${driverError}\n${xevOutput}`);
}

function driverRequest(method) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let response = "";
    client.setEncoding("utf8");
    client.once("connect", () => client.write(`${JSON.stringify({ method })}\n`));
    client.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      client.end();
      try {
        resolve(JSON.parse(response.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    client.once("error", reject);
  });
}

// Every action goes through the server's own broker, one dispatch per tool
// call, exactly as /api/internal/host-computer does (server/index.ts). The
// driver remembers which windows were read per MCP connection, so this is the
// path that has to keep a turn's read and its next click together.
const mcpSpec = {
  command: driver,
  args: ["mcp", "--embedded", "--socket", socketPath],
  env: {
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    XDG_SESSION_TYPE: "x11",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  },
};
const broker = new HostComputerBroker();
// the server's own session key (server/index.ts /api/internal/host-computer)
const turn = (bot, revision = 0, thread = `thread-${bot}`) => hostComputerSession(bot, thread, `generation-${bot}`, revision);
const call = (session, name, args) =>
  broker.dispatch(mcpSpec, "tools/call", { name, arguments: args }, () => true, undefined, session);

function assertToolResult(result, name) {
  if (result?.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
  return result;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  const deadline = Date.now() + 2_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(25);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

try {
  const windowId = await until(async () => {
    if (xev.exitCode !== null || xev.signalCode !== null) {
      throw new Error(`xev exited before its test window appeared:\n${xevOutput}`);
    }
    const { stdout } = await execFileAsync("xdotool", [
      "search",
      "--onlyvisible",
      "--name",
      `^${title}$`,
    ]);
    return stdout.trim().split(/\s+/)[0] || null;
  }, "the unrelated X11 test window");
  if (!windowId) throw new Error("xev test window did not appear");
  // 0.55.0 sends foreground input only to the window a window manager made active.
  await until(async () => /window id/.test((await execFileAsync("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"])).stdout),
    "an EWMH window manager (run one, e.g. xfwm4 --compositor=off, before this smoke)");

  const metadata = await until(
    async () => {
      if (!existsSync(socketPath)) return null;
      const response = await driverRequest("metadata");
      return response?.ok === true ? response.result : null;
    },
    "the overlay-free driver handshake",
  );
  if (metadata.driver_version !== "0.55.0" || metadata.embedded !== true) {
    throw new Error(`unexpected driver metadata: ${JSON.stringify(metadata)}`);
  }

  const { stdout: tree } = await execFileAsync("xwininfo", ["-root", "-tree"]);
  if (tree.includes("Cua.AgentCursorOverlay")) {
    throw new Error("Cua created its full-screen cursor overlay despite --no-overlay");
  }

  const listed = await broker.dispatch(mcpSpec, "tools/list", {}, () => true, undefined, turn("bot-a"));
  const toolNames = new Set(listed.tools.map(({ name }) => name));
  for (const required of ["get_window_state", "click", "type_text", "press_key"]) {
    if (!toolNames.has(required)) throw new Error(`Cua MCP did not expose ${required}`);
  }

  xevOutput = "";
  const ident = { pid: xev.pid, window_id: Number(windowId) };
  const target = { ...ident, x: 80, y: 80, scope: "window", delivery_mode: "foreground" };
  // 0.55.0 refuses a pixel action on a window this connection has not read.
  // Another bot (and the same bot after a person took control, a new control
  // revision) must not act on bot A's read.
  assertToolResult(await call(turn("bot-a"), "get_window_state", ident), "get_window_state");
  for (const [who, session] of [["another bot", turn("bot-b")], ["a new control revision", turn("bot-a", 1)]]) {
    const refused = await call(session, "click", target);
    if (!refused?.isError || !/not been read yet|belongs to another session/.test(refused.content?.[0]?.text ?? "")) {
      throw new Error(`${who} clicked on a window it never read: ${JSON.stringify(refused)}`);
    }
  }
  if (/ButtonPress event/.test(xevOutput)) throw new Error("a refused click still reached the window");
  // bot-a's revision-0 session was replaced above, so it reads again first.
  assertToolResult(await call(turn("bot-a"), "get_window_state", ident), "get_window_state");
  // A second thread of the same bot mounts this computer (tools/list) and reads
  // on its own connection; that must not retire the first thread's read.
  const sibling = turn("bot-a", 0, "thread-bot-a-2");
  await broker.dispatch(mcpSpec, "tools/list", {}, () => true, undefined, sibling);
  assertToolResult(await call(sibling, "get_window_state", ident), "get_window_state (second thread)");
  assertToolResult(await call(turn("bot-a"), "click", target), "click");
  assertToolResult(await call(turn("bot-a"), "type_text", { ...target, text: "a" }), "type_text");
  assertToolResult(await call(turn("bot-a"), "press_key", { ...target, key: "Return" }), "press_key");
  assertToolResult(await call(sibling, "click", target), "click (second thread, on its own read)");
  await until(
    async () => /ButtonPress event/.test(xevOutput) && /KeyPress event/.test(xevOutput),
    "an unrelated X11 window to receive pointer and keyboard input",
  );
  console.log(
    "[smoke-cua-x11-input] OK: no full-screen Cua overlay; through HostComputerBroker.dispatch (one call each) get_window_state, click, type_text and press_key reached an unrelated window, a second thread of the same bot read and clicked without retiring the first thread's read, and another bot or control revision could not act on that read",
  );
} finally {
  await broker.drain().catch((error) => {
    console.error(`[smoke-cua-x11-input] broker cleanup: ${error.message}`);
    process.exitCode = 1;
  });
  await stop(driverProcess);
  if (xev.exitCode === null && xev.signalCode === null) xev.kill("SIGTERM");
  safeWipeSync(sandbox);
}
