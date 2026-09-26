import { execFile, spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATUS_TTL_MS = 750;
const ADB_DEFAULT_PORT = 5037;
const SERVER_START_TIMEOUT_MS = 8_000;
const SERVER_PROBE_TIMEOUT_MS = 400;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEYCODES = new Map([
  ["back", "KEYCODE_BACK"],
  ["delete", "KEYCODE_DEL"],
  ["down", "KEYCODE_DPAD_DOWN"],
  ["end", "KEYCODE_MOVE_END"],
  ["enter", "KEYCODE_ENTER"],
  ["escape", "KEYCODE_BACK"],
  ["home", "KEYCODE_HOME"],
  ["left", "KEYCODE_DPAD_LEFT"],
  ["recent", "KEYCODE_APP_SWITCH"],
  ["return", "KEYCODE_ENTER"],
  ["right", "KEYCODE_DPAD_RIGHT"],
  ["space", "KEYCODE_SPACE"],
  ["tab", "KEYCODE_TAB"],
  ["up", "KEYCODE_DPAD_UP"],
]);

function executableName(platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

export function resolveAdbBinary({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  resourcesPath = process.resourcesPath,
  exists = fs.existsSync,
} = {}) {
  const executable = executableName(platform);
  const candidates = [
    env.MURAGE_ADB_PATH,
    resourcesPath && path.join(resourcesPath, "android-platform-tools", platform, executable),
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
    platform === "darwin" && path.join(homeDir, "Library/Android/sdk/platform-tools/adb"),
    platform === "darwin" && "/opt/homebrew/bin/adb",
    platform === "darwin" && "/usr/local/bin/adb",
    platform === "linux" && path.join(homeDir, "Android/Sdk/platform-tools/adb"),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** Close every descriptor above stderr, then become the program.
 *
 * The first adb command starts a DAEMON (`adb … fork-server server`) that
 * long outlives the command, and on Unix it keeps whatever descriptors it
 * was exec'd with. Murage's are not all close-on-exec — Chromium's are not —
 * so the daemon ended up holding the app's caches, its leveldb log and a
 * LISTENING debug socket, and went on holding them after Murage had quit.
 *
 * Every descriptor number comes from the directory the kernel keeps of this
 * shell's own open files (`/proc/<pid>/fd` on Linux, `/dev/fd` elsewhere),
 * and is closed only after it is proven to be nothing but digits, so nothing
 * from the environment is ever evaluated. A platform with neither directory
 * leaves the glob unexpanded, the digits test rejects it, and the exec still
 * happens: no descriptor is closed, and nothing breaks. */
export const CLOSE_INHERITED_DESCRIPTORS = [
  'for entry in "/proc/$$/fd"/* /dev/fd/*; do',
  '  fd=${entry##*/}',
  "  case \"$fd\" in ''|*[!0-9]*) continue ;; esac",
  '  if [ "$fd" -gt 2 ]; then eval "exec $fd>&-" 2>/dev/null; fi',
  "done",
  'exec "$@"',
].join("\n");

/** How to start the adb daemon so it inherits nothing from this app.
 *
 * On Windows the binary is run directly. Node starts children with handle
 * inheritance on, so the daemon can still pick up any handle the app holds
 * as inheritable: the 0.1.60 Windows pass saw it keep the Chromium debugging
 * port bound after the app was ended. That is why the daemon's ownership is
 * recorded (createAndroidDeviceController ownershipFile) and a leftover one
 * is stopped at the next start (reclaimOrphan), as well as on every quit. */
export function adbServerLaunch(binary, { platform = process.platform } = {}) {
  if (platform === "win32") return { command: binary, args: ["start-server"] };
  return { command: "/bin/sh", args: ["-c", CLOSE_INHERITED_DESCRIPTORS, "murage-adb-start", binary, "start-server"] };
}

export function adbServerPort(env = process.env) {
  const configured = Number.parseInt(String(env.ANDROID_ADB_SERVER_PORT ?? ""), 10);
  return Number.isInteger(configured) && configured > 0 && configured < 65_536 ? configured : ADB_DEFAULT_PORT;
}

/** Is somebody else's adb daemon already listening? If so Murage adopts it
 * for reads and never stops it on quit: it is not ours to stop. */
function probeAdbServer(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (running) => { socket.destroy(); resolve(running); };
    socket.setTimeout(SERVER_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function connectionKind(serial, fields) {
  if (serial.startsWith("emulator-")) return "emulator";
  if (fields.some((field) => field.startsWith("usb:"))) return "usb";
  if (serial.includes(":") || serial.startsWith("adb-")) return "network";
  return "usb";
}

export function parseAdbDevices(output) {
  const lines = String(output).split(/\r?\n/);
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices attached") || trimmed.startsWith("* daemon")) {
      continue;
    }
    const [serial, state, ...fields] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const properties = Object.fromEntries(
      fields
        .map((field) => field.split(/:(.*)/s))
        .filter(([key, value]) => Boolean(key && value)),
    );
    devices.push({
      serial,
      state,
      connection: connectionKind(serial, fields),
      model: String(properties.model ?? properties.product ?? "Android device").replaceAll("_", " "),
      product: properties.product,
      transportId: properties.transport_id,
    });
  }
  return devices;
}

function trustedMainFrame(event) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  const mainFrame = sender?.mainFrame;
  return Boolean(
    sender &&
      frame &&
      mainFrame &&
      frame.processId === mainFrame.processId &&
      frame.routingId === mainFrame.routingId,
  );
}

function safeDimension(value) {
  return Number.isFinite(value) && value >= 100 && value <= 10_000 ? value : null;
}

function safeUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function createAndroidDeviceController(options = {}) {
  const run = options.run ?? execFileAsync;
  const spawn = options.spawn ?? spawnProcess;
  const probeServer = options.probeServer ?? probeAdbServer;
  const platform = options.platform ?? process.platform;
  const resolveBinary = options.resolveBinary ?? (() => resolveAdbBinary(options));
  let cachedStatus = null;
  // Set only when THIS app started the daemon, so quitting never takes down
  // a daemon the person was already using for their own work.
  let ownsServer = false;
  let startingServer = null;
  // W-D5: remembered on disk too. A daemon this app started outlives a crash
  // or a forced quit, and on Windows it inherits the app's inheritable
  // handles, the Chromium debugging socket among them. The next start then
  // saw a daemon on the port, took it for somebody else's and never stopped
  // it, so the old port stayed bound. The record lets the next start (or
  // this quit) stop the one that is ours.
  const ownershipFile = typeof options.ownershipFile === "string" ? options.ownershipFile : null;
  const env = options.env ?? process.env;
  const remember = () => {
    if (!ownershipFile) return;
    try { fs.writeFileSync(ownershipFile, JSON.stringify({ version: 1, port: adbServerPort(env), appPid: process.pid, startedAt: Date.now() }), { mode: 0o600 }); } catch { /* the in-memory flag still stops it on quit */ }
  };
  const forget = () => { if (ownershipFile) try { fs.rmSync(ownershipFile, { force: true }); } catch { /* retried next start */ } };
  const recorded = () => {
    if (!ownershipFile) return null;
    try {
      const value = JSON.parse(fs.readFileSync(ownershipFile, "utf8"));
      return value?.version === 1 && Number.isInteger(value.port) && value.port > 0 && value.port < 65_536 && Number.isInteger(value.appPid) ? value : null;
    } catch { return null; }
  };
  const alive = options.processAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } });

  /** Start the daemon deliberately, once, instead of letting the first
   * ordinary adb command fork one out of the middle of the app. */
  const ensureServer = async (binary) => {
    if (ownsServer) return;
    if (startingServer) { await startingServer; return; }
    startingServer = (async () => {
      if (await probeServer(adbServerPort(options.env ?? process.env))) return;
      const { command, args } = adbServerLaunch(binary, { platform });
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: platform !== "win32",
        windowsHide: true,
        env: { ...process.env, ADB_TRACE: "" },
      });
      ownsServer = true;
      remember();
      child.unref?.();
      await new Promise((resolve) => {
        const done = setTimeout(resolve, SERVER_START_TIMEOUT_MS);
        done.unref?.();
        const settle = () => { clearTimeout(done); resolve(undefined); };
        child.once?.("exit", settle);
        child.once?.("error", settle);
      });
    })();
    try { await startingServer; } catch { /* A daemon we could not start is reported by the command that needed it. */ }
    finally { startingServer = null; }
  };

  /** Stop the daemon this app started. Called on quit: without it, the
   * daemon simply stayed, still holding its ports. */
  const stop = async () => {
    if (!ownsServer) return { stopped: false };
    ownsServer = false;
    cachedStatus = null;
    const binary = resolveBinary();
    if (!binary) return { stopped: false };
    try {
      await run(binary, ["kill-server"], { timeout: 4_000, env: { ...process.env, ADB_TRACE: "" } });
      forget();
      return { stopped: true };
    } catch { return { stopped: false }; }
  };

  /** At start: a daemon the last run of this app started and never stopped
   * (it crashed or was ended) is stopped now, before anything uses adb.
   * A daemon somebody else started is never touched: there is no record of
   * it, and a record whose app is still running belongs to that app. */
  const reclaimOrphan = async () => {
    const record = recorded();
    if (!record) return { reclaimed: false };
    if (record.appPid !== process.pid && alive(record.appPid)) return { reclaimed: false };
    if (record.port !== adbServerPort(env) || !(await probeServer(record.port))) { forget(); return { reclaimed: false }; }
    const binary = resolveBinary();
    if (!binary) return { reclaimed: false };
    try {
      await run(binary, ["kill-server"], { timeout: 4_000, env: { ...process.env, ADB_TRACE: "" } });
      forget();
      cachedStatus = null;
      return { reclaimed: true };
    } catch { return { reclaimed: false }; }
  };

  const invoke = async (binary, args, extra = {}) => {
    await ensureServer(binary);
    const result = await run(binary, args, {
      timeout: extra.timeout ?? 6_000,
      maxBuffer: extra.maxBuffer ?? 32 * 1024 * 1024,
      encoding: extra.encoding ?? "utf8",
      env: { ...process.env, ADB_TRACE: "" },
    });
    return result;
  };

  const status = async ({ fresh = false } = {}) => {
    if (!fresh && cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
      return cachedStatus.value;
    }
    const binary = resolveBinary();
    if (!binary) {
      const value = { available: false, reasonCode: "adb-unavailable", devices: [] };
      cachedStatus = { at: Date.now(), value };
      return value;
    }
    try {
      const { stdout } = await invoke(binary, ["devices", "-l"]);
      const devices = parseAdbDevices(stdout).filter((device) => device.connection === "usb");
      const value = { available: true, adbPath: binary, devices };
      cachedStatus = { at: Date.now(), value };
      return value;
    } catch (error) {
      const value = {
        available: false,
        reasonCode: "adb-failed",
        message: error instanceof Error ? error.message : String(error),
        devices: [],
      };
      cachedStatus = { at: Date.now(), value };
      return value;
    }
  };

  const readyDevice = async (serial) => {
    if (typeof serial !== "string" || !serial) throw new Error("An Android device is required");
    const current = await status({ fresh: true });
    const device = current.devices.find((candidate) => candidate.serial === serial);
    if (!device) throw new Error("That USB Android device is no longer connected");
    if (device.state !== "device") {
      throw new Error(
        device.state === "unauthorized"
          ? "Unlock the Android phone and allow USB debugging"
          : `The Android device is ${device.state}`,
      );
    }
    const binary = resolveBinary();
    if (!binary) throw new Error("Android platform tools are unavailable");
    return { binary, device };
  };

  const frame = async (serial) => {
    const { binary } = await readyDevice(serial);
    const { stdout } = await invoke(binary, ["-s", serial, "exec-out", "screencap", "-p"], {
      timeout: 8_000,
      encoding: "buffer",
    });
    const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (png.length < 1_024 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error("The Android device returned an invalid screen capture");
    }
    return { serial, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  };

  const input = async (serial, payload) => {
    const { binary } = await readyDevice(serial);
    if (!payload || typeof payload !== "object") throw new Error("Invalid Android input");
    const width = safeDimension(payload.width);
    const height = safeDimension(payload.height);
    const point = (x, y) => {
      const unitX = safeUnit(x);
      const unitY = safeUnit(y);
      if (unitX === null || unitY === null || width === null || height === null) {
        throw new Error("Invalid Android coordinates");
      }
      return [Math.round(unitX * width), Math.round(unitY * height)];
    };

    let command;
    if (payload.type === "tap") {
      const [x, y] = point(payload.x, payload.y);
      command = ["input", "tap", String(x), String(y)];
    } else if (payload.type === "swipe") {
      const [fromX, fromY] = point(payload.fromX, payload.fromY);
      const [toX, toY] = point(payload.toX, payload.toY);
      const duration = Number.isFinite(payload.durationMs)
        ? Math.max(80, Math.min(1_500, Math.round(payload.durationMs)))
        : 260;
      command = [
        "input",
        "swipe",
        String(fromX),
        String(fromY),
        String(toX),
        String(toY),
        String(duration),
      ];
    } else if (payload.type === "key") {
      const keycode = KEYCODES.get(String(payload.key ?? "").toLowerCase());
      if (!keycode) throw new Error("Unsupported Android key");
      command = ["input", "keyevent", keycode];
    } else if (payload.type === "text") {
      if (
        typeof payload.text !== "string" ||
        payload.text.length < 1 ||
        payload.text.length > 64 ||
        !/^[A-Za-z0-9 _.,@-]+$/.test(payload.text)
      ) {
        throw new Error("Android text currently supports letters, numbers, spaces, and basic punctuation");
      }
      command = ["input", "text", payload.text.replaceAll(" ", "%s")];
    } else {
      throw new Error("Unsupported Android input");
    }
    await invoke(binary, ["-s", serial, "shell", ...command]);
  };

  const registerIpc = (ipcMain) => {
    const protect = (handler) => async (event, ...args) => {
      if (!trustedMainFrame(event)) throw new Error("Android device access is limited to the main app");
      return handler(...args);
    };
    ipcMain.handle("android-device:status", protect(() => status({ fresh: true })));
    ipcMain.handle("android-device:frame", protect(frame));
    ipcMain.handle("android-device:input", protect(input));
  };

  return { frame, input, reclaimOrphan, registerIpc, status, stop };
}
