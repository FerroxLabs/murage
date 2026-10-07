import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLOSE_INHERITED_DESCRIPTORS,
  adbServerLaunch,
  adbServerPort,
  createAndroidDeviceController,
  parseAdbDevices,
  resolveAdbBinary,
} from "./android-device.mjs";

const devicesOutput = `List of devices attached
USB123\tdevice product:husky model:Pixel_8_Pro usb:1-2 transport_id:4
USB456\tunauthorized usb:1-3 transport_id:5
emulator-5554\tdevice product:sdk_gphone model:Android_SDK transport_id:6
192.0.2.4:5555\tdevice product:remote model:Remote_Phone transport_id:7
`;

describe("Android USB device bridge", () => {
  it("parses physical USB devices separately from emulators and network devices", () => {
    expect(parseAdbDevices(devicesOutput)).toEqual([
      expect.objectContaining({ serial: "USB123", state: "device", connection: "usb", model: "Pixel 8 Pro" }),
      expect.objectContaining({ serial: "USB456", state: "unauthorized", connection: "usb" }),
      expect.objectContaining({ serial: "emulator-5554", connection: "emulator" }),
      expect.objectContaining({ serial: "192.0.2.4:5555", connection: "network" }),
    ]);
  });

  it("resolves an explicit ADB path before PATH and SDK fallbacks", () => {
    const checked = [];
    const result = resolveAdbBinary({
      platform: "darwin",
      env: { MURAGE_ADB_PATH: "/trusted/adb", PATH: "/other/bin" },
      homeDir: "/Users/test",
      resourcesPath: "/Resources",
      exists(candidate) {
        checked.push(candidate);
        return candidate === "/trusted/adb";
      },
    });
    expect(result).toBe("/trusted/adb");
    expect(checked).toEqual(["/trusted/adb"]);
  });

  it("captures a validated USB device and maps normalized swipes to ADB pixels", async () => {
    const calls = [];
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2_000),
    ]);
    const run = async (_binary, args, options) => {
      calls.push({ args, options });
      if (args[0] === "devices") return { stdout: devicesOutput, stderr: "" };
      if (args.includes("screencap")) return { stdout: png, stderr: Buffer.alloc(0) };
      return { stdout: "", stderr: "" };
    };
    const controller = createAndroidDeviceController({ run, resolveBinary: () => "/trusted/adb" });

    await expect(controller.frame("USB123")).resolves.toMatchObject({
      serial: "USB123",
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    await controller.input("USB123", {
      type: "swipe",
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 240,
      width: 1080,
      height: 2400,
    });

    expect(calls.at(-1)?.args).toEqual([
      "-s", "USB123", "shell", "input", "swipe", "540", "1920", "540", "480", "240",
    ]);
  });

  it("starts the adb daemon itself, once, and stops it again", async () => {
    const calls = [], spawned = [];
    const run = async (_binary, args) => { calls.push(args); return { stdout: devicesOutput, stderr: "" }; };
    const child = { once: (event, handler) => { if (event === "exit") setImmediate(handler); }, unref: () => {} };
    const controller = createAndroidDeviceController({
      run, resolveBinary: () => "/trusted/adb", platform: "linux",
      probeServer: async () => false,
      spawn: (command, args, options) => { spawned.push({ command, args, options }); return child; },
    });

    await controller.status({ fresh: true });
    await controller.status({ fresh: true });
    // Started once, before the first ordinary command, and never again.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args.at(-2)).toBe("/trusted/adb");
    expect(spawned[0].args.at(-1)).toBe("start-server");
    expect(spawned[0].options).toMatchObject({ stdio: "ignore", detached: true });
    expect(calls[0]).toEqual(["devices", "-l"]);
    // Quitting takes the daemon with it.
    await expect(controller.stop()).resolves.toEqual({ stopped: true });
    expect(calls.at(-1)).toEqual(["kill-server"]);
    // Nothing left to stop a second time.
    await expect(controller.stop()).resolves.toEqual({ stopped: false });
  });

  it("never starts or stops a daemon somebody else is already running", async () => {
    const calls = [], spawned = [];
    const controller = createAndroidDeviceController({
      run: async (_binary, args) => { calls.push(args); return { stdout: devicesOutput, stderr: "" }; },
      resolveBinary: () => "/trusted/adb", platform: "linux",
      probeServer: async () => true,
      spawn: () => { spawned.push("started"); return { once: () => {}, unref: () => {} }; },
    });
    await controller.status({ fresh: true });
    expect(spawned).toEqual([]);
    await expect(controller.stop()).resolves.toEqual({ stopped: false });
    expect(calls).toEqual([["devices", "-l"]]);
  });

  // W-D5 (0.1.60 Windows): a daemon this app started outlived a crash or a
  // forced quit, holding the dead run's sockets (its debugging port), and
  // the next start took it for somebody else's and never stopped it.
  it("stops, at the next start, a daemon the last run started and never stopped (W-D5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-adb-owned-")), ownershipFile = join(dir, "adb-daemon-owned.json");
    try {
      const child = { once: (event, handler) => { if (event === "exit") setImmediate(handler); }, unref: () => {} };
      const first = createAndroidDeviceController({
        run: async () => ({ stdout: devicesOutput, stderr: "" }), resolveBinary: () => "/trusted/adb", platform: "linux",
        probeServer: async () => false, spawn: () => child, ownershipFile, env: {},
      });
      await first.status({ fresh: true });
      expect(JSON.parse(readFileSync(ownershipFile, "utf8"))).toMatchObject({ version: 1, port: 5037 });
      // The run ends without its quit cleanup. The next one finds its daemon.
      const calls = [];
      const next = () => createAndroidDeviceController({
        run: async (_binary, args) => { calls.push(args); return { stdout: "", stderr: "" }; }, resolveBinary: () => "/trusted/adb", platform: "linux",
        probeServer: async () => true, spawn: () => child, ownershipFile, env: {}, processAlive: () => false,
      });
      await expect(next().reclaimOrphan()).resolves.toEqual({ reclaimed: true });
      expect(calls).toEqual([["kill-server"]]);
      expect(existsSync(ownershipFile)).toBe(false);
      // Without a record, a running daemon is somebody else's and is left alone.
      await expect(next().reclaimOrphan()).resolves.toEqual({ reclaimed: false });
      expect(calls).toEqual([["kill-server"]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves a recorded daemon alone while the app that started it still runs, and forgets it on a clean quit (W-D5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-adb-owned-")), ownershipFile = join(dir, "adb-daemon-owned.json");
    try {
      writeFileSync(ownershipFile, JSON.stringify({ version: 1, port: 5037, appPid: 424242, startedAt: 1 }));
      const calls = [];
      const other = createAndroidDeviceController({
        run: async (_binary, args) => { calls.push(args); return { stdout: devicesOutput, stderr: "" }; }, resolveBinary: () => "/trusted/adb", platform: "linux",
        probeServer: async () => true, spawn: () => ({ once: () => {}, unref: () => {} }), ownershipFile, env: {}, processAlive: pid => pid === 424242,
      });
      await expect(other.reclaimOrphan()).resolves.toEqual({ reclaimed: false });
      expect(calls).toEqual([]);
      rmSync(ownershipFile);
      const child = { once: (event, handler) => { if (event === "exit") setImmediate(handler); }, unref: () => {} };
      const own = createAndroidDeviceController({
        run: async () => ({ stdout: devicesOutput, stderr: "" }), resolveBinary: () => "/trusted/adb", platform: "linux",
        probeServer: async () => false, spawn: () => child, ownershipFile, env: {},
      });
      await own.status({ fresh: true });
      expect(existsSync(ownershipFile)).toBe(true);
      await expect(own.stop()).resolves.toEqual({ stopped: true });
      expect(existsSync(ownershipFile)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the daemon behind a launcher that closes inherited descriptors", async () => {
    expect(adbServerLaunch("C:/adb.exe", { platform: "win32" })).toEqual({ command: "C:/adb.exe", args: ["start-server"] });
    const posix = adbServerLaunch("/trusted/adb", { platform: "linux", exists: (file) => file === "/bin/bash" });
    expect(posix.command).toBe("/bin/bash");
    expect(adbServerLaunch("/trusted/adb", { platform: "linux", exists: () => false }).command).toBe("/bin/sh");
    expect(posix.args[1]).toBe(CLOSE_INHERITED_DESCRIPTORS);
    expect(adbServerPort({})).toBe(5037);
    expect(adbServerPort({ ANDROID_ADB_SERVER_PORT: "5038" })).toBe(5038);
    expect(adbServerPort({ ANDROID_ADB_SERVER_PORT: "not a port" })).toBe(5037);
  });

  // fd 12 is handed to the child deliberately, standing in for the caches,
  // leveldb log and listening debug socket the daemon used to keep; Electron's
  // are numbered well above 9. The checker runs in a subshell, so a closed
  // descriptor cannot end it (`:` is a special builtin in dash).
  const INHERITED_FD = 12;
  const checker = `if ( : <&${INHERITED_FD} ) 2>/dev/null; then echo INHERITED; else echo CLOSED; fi`;
  // A spawn that fails outright may never emit close: settle on its error too,
  // so the test reports it instead of hanging to the runner's timeout.
  const withDescriptor = (command, args) => new Promise((resolve, reject) => {
    const fd = openSync(fileURLToPath(import.meta.url), "r");
    let settled = false;
    const settle = (finish) => { if (settled) return; settled = true; closeSync(fd); finish(); };
    const stdio = ["ignore", "pipe", "ignore", ...Array(INHERITED_FD - 3).fill("ignore"), fd];
    const child = spawn(command, args, { stdio });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => settle(() => resolve({ output: output.trim(), code })));
  });
  const bash = ["/bin/bash", "/usr/bin/bash"].find((file) => existsSync(file));

  it.skipIf(process.platform === "win32" || !bash)("really closes an inherited descriptor numbered above 9 before the daemon starts", async () => {
    // Without the launcher the descriptor survives the exec: the bug.
    expect((await withDescriptor("/bin/sh", ["-c", 'exec "$@"', "control", bash, "-c", checker])).output).toBe("INHERITED");
    // With it, as the app starts adb, nothing above stderr reaches the program.
    const { command, args } = adbServerLaunch(bash, { platform: process.platform });
    const launched = await withDescriptor(command, [...args.slice(0, -1), "-c", checker]);
    expect(launched).toEqual({ output: "CLOSED", code: 0 });
  });

  // Debian and Ubuntu's /bin/sh is dash, which cannot name a descriptor above
  // 9: `exec 12>&-` is "exec: 12: not found", and a failed exec ends the shell
  // before adb ever starts (0.1.60 CI triage). Under dash the launcher must
  // still start the program.
  const dash = ["/usr/bin/dash", "/bin/dash"].find((file) => existsSync(file));
  it.skipIf(process.platform === "win32" || !dash)("under dash, an inherited descriptor above 9 never stops the daemon from starting", async () => {
    const started = await withDescriptor(dash, ["-c", CLOSE_INHERITED_DESCRIPTORS, "murage-adb-start", "/bin/echo", "STARTED"]);
    expect(started).toEqual({ output: "STARTED", code: 0 });
  });

  it("rejects network devices and shell metacharacters", async () => {
    const run = async () => ({ stdout: devicesOutput, stderr: "" });
    const controller = createAndroidDeviceController({ run, resolveBinary: () => "/trusted/adb" });

    await expect(controller.frame("192.0.2.4:5555")).rejects.toThrow("no longer connected");
    await expect(
      controller.input("USB123", {
        type: "text",
        text: "hello; reboot",
      }),
    ).rejects.toThrow("basic punctuation");
  });
});
