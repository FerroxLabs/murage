import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(
  process.env.OMB_SMOKE_EXECUTABLE ?? path.join(root, "release", "linux-unpacked", "openmausbot"),
);
if (!existsSync(executable)) throw new Error(`[smoke-linux-package] missing executable: ${executable}`);

const sandbox = mkdtempSync(path.join(tmpdir(), "omb-linux-smoke-"));
const home = path.join(sandbox, "home");
const xdgConfig = path.join(sandbox, "config");
const xdgRuntime = path.join(sandbox, "runtime");
const marker = path.join(sandbox, "cua-invocations.ndjson");
const fakeState = path.join(sandbox, "cua-serve-count");
const sentinel = path.join(sandbox, "cua-driver");
mkdirSync(path.join(home, ".openmausbot"), { recursive: true });
mkdirSync(xdgConfig, { recursive: true });
mkdirSync(xdgRuntime, { recursive: true, mode: 0o700 });
chmodSync(xdgRuntime, 0o700);
writeFileSync(
  path.join(home, ".openmausbot", "config.json"),
  JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
);
for (const appName of ["openmausbot", "OpenMausBot"]) {
  const userData = path.join(xdgConfig, appName);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  writeFileSync(
    path.join(userData, "cua-local-control.json"),
    JSON.stringify({ schemaVersion: 1, linuxLocalControlEnabled: true }),
    { mode: 0o600 },
  );
}
writeFileSync(
  sentinel,
  `#!${process.execPath}
const { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const marker = ${JSON.stringify(marker)};
const state = ${JSON.stringify(fakeState)};
const args = process.argv.slice(2);
appendFileSync(marker, JSON.stringify({ pid: process.pid, args }) + "\\n");
const after = (flag) => { const index = args.indexOf(flag); return index === -1 ? null : args[index + 1]; };
if (args.includes("--version")) {
  process.stdout.write("cua-driver 0.19.3\\n");
  process.exit(0);
}
if (args[0] === "manifest") {
  const binary = realpathSync(process.argv[1]);
  process.stdout.write(JSON.stringify({
    schema_version: "1",
    binary_version: "0.19.3",
    binary_path: binary,
    mcp_invocation: { command: binary, args: ["mcp"] },
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "doctor" && args.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: true, probes: [
    { label: "binary", status: "ok", message: "cua-driver 0.19.3" },
    { label: "display server", status: "ok", message: "X11 (DISPLAY=:99)" },
    { label: "X11 connection", status: "warn", message: "no top-level windows in Xvfb" },
    { label: "AT-SPI", status: "ok", message: "fixture bus available" },
  ] }) + "\\n");
  process.exit(0);
}
if (args[0] !== "serve") process.exit(64);
const socketPath = after("--socket");
const pidFile = after("--pid-file");
if (!socketPath || !pidFile || !args.includes("--embedded") || after("--permission-mode") !== "standard") {
  process.exit(64);
}
const count = existsSync(state) ? Number(readFileSync(state, "utf8")) + 1 : 1;
writeFileSync(state, String(count));
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
const metadata = {
  driver_version: "0.19.3",
  contract_version: "0.6.0",
  tools_list_schema_version: "1",
  capability_version: "1",
  mcp_protocol_version: "2025-06-18",
  pid: process.pid,
  embedded: true,
  host_bundle_id: "com.openmausbot.app",
};
const tools = ["click", "get_window_state", "list_apps", "type_text"].map((name) => ({ name }));
const server = net.createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\\n");
    if (newline === -1) return;
    const request = JSON.parse(input.slice(0, newline));
    const result = request.method === "metadata" ? metadata : request.method === "list" ? tools : null;
    socket.end(JSON.stringify(result ? { ok: true, result } : { ok: false, error: "unknown" }) + "\\n");
    if (count === 1 && request.method === "list") setTimeout(() => server.close(() => process.exit(17)), 5000);
  });
});
server.listen(socketPath, () => chmodSync(socketPath, 0o600));
const shutdown = () => server.close(() => {
  for (const file of [socketPath, pidFile]) { try { unlinkSync(file); } catch {} }
  process.exit(0);
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
`,
);
chmodSync(sentinel, 0o755);

let output = "";
let smokeResult = null;
const child = spawn(executable, [], {
  cwd: root,
  detached: true,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_RUNTIME_DIR: xdgRuntime,
    CUA_DRIVER_PATH: sentinel,
    OMB_SMOKE_TEST: "1",
    OMB_SMOKE_CUA: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/\[smoke\] renderer-ready (\{.*\})\r?\n/);
    if (match && !smokeResult) smokeResult = JSON.parse(match[1]);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (child.exitCode !== null) {
      throw new Error(`Electron exited ${child.exitCode} while waiting for ${description}.\n${output}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}.\n${output}`);
}

async function waitForExit() {
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null) throw new Error(`Electron did not exit after its window closed.\n${output}`);
}

async function stopProcess() {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const stopDeadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < stopDeadline) await delay(50);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

try {
  const result = await until(async () => smokeResult, "the packaged renderer smoke result");
  const {
    capabilities,
    cuaCrashReason,
    cuaRetryStatus,
    displayMediaRequests,
    health,
    initialCapabilities,
    location,
    title,
  } = result;
  if (health?.app !== "openmausbot" || health.static !== true) {
    throw new Error(`unexpected embedded health response: ${JSON.stringify(health)}`);
  }
  if (!String(title).includes("OpenMausBot")) throw new Error(`unexpected renderer title: ${title}`);
  if (capabilities.host.platform !== "linux") throw new Error("renderer did not report Linux");
  if (capabilities.host.session !== "x11") throw new Error("Xvfb did not report an X11 session");
  if (!capabilities.screenPreview.available || capabilities.screenPreview.interaction !== "direct") {
    throw new Error("X11 screen preview capability was not available");
  }
  if (capabilities.dictation.available) throw new Error("dictation must be unavailable on Linux");
  if (!initialCapabilities.localComputer.available) throw new Error("initial Linux CUA runtime was not ready");
  if (initialCapabilities.localComputer.support !== "limited") throw new Error("Linux CUA was not marked beta/limited");
  if (cuaCrashReason !== "daemon-exited") throw new Error("daemon crash did not invalidate local control");
  if (cuaRetryStatus?.status !== "ready" || !capabilities.localComputer.available) {
    throw new Error("explicit CUA retry did not create a ready generation");
  }
  if (displayMediaRequests !== 0) throw new Error("launch triggered display capture without user intent");

  await waitForExit();
  const staleHealth = await fetch(new URL("/api/health", location)).catch(() => null);
  if (staleHealth?.ok) throw new Error("embedded harness remained reachable after Electron quit");
  const invocations = readFileSync(marker, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const commands = invocations.map((entry) => entry.args.join(" "));
  for (const expected of ["--version", "manifest", "doctor --json"]) {
    if (!commands.some((command) => command === expected)) throw new Error(`missing CUA probe: ${expected}`);
  }
  const daemons = invocations.filter((entry) => entry.args[0] === "serve");
  if (daemons.length !== 2) throw new Error(`expected crash + retry daemon generations, found ${daemons.length}`);
  for (const daemon of daemons) {
    try {
      process.kill(daemon.pid, 0);
      throw new Error(`owned CUA daemon remained alive after quit: ${daemon.pid}`);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  console.log("[smoke-linux-package] OK: renderer, private CUA crash/retry, harness, and shutdown");
} finally {
  await stopProcess();
  if (process.env.OMB_KEEP_SMOKE_DIR !== "1") rmSync(sandbox, { recursive: true, force: true });
  else console.log(`[smoke-linux-package] kept ${sandbox}`);
}
