import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  desktopCommandEnvironment,
  discoverLinuxCuaDriver,
  inspectLinuxCuaDriver,
  runCuaCommand,
  sanitizePath,
  validateDriverCandidate,
} = require("./cua-linux.cjs");

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openmausbot-cua-linux-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(directory, name = "cua-driver") {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return file;
}

function healthyDoctor() {
  return {
    ok: true,
    probes: [
      { label: "binary", status: "ok", message: "cua-driver 0.19.3" },
      { label: "display server", status: "ok", message: "X11 (DISPLAY=:0)" },
      { label: "X11 connection", status: "ok", message: "connected, 1 visible top-level window" },
      { label: "AT-SPI", status: "ok", message: "org.a11y.Bus reachable via session bus" },
      { label: "telemetry", status: "warn", message: "test warning" },
    ],
  };
}

function successfulRunner(binary) {
  return vi.fn(async (_command, args, options) => {
    expect(_command).toBe(binary);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    if (args[0] === "--version") return { exitCode: 0, stdout: "cua-driver 0.19.3\n", stderr: "" };
    if (args[0] === "manifest") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schema_version: "1",
          binary_version: "0.19.3",
          binary_path: binary,
          mcp_invocation: { command: binary, args: ["mcp"] },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: JSON.stringify(healthyDoctor()), stderr: "" };
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux CUA discovery", () => {
  it("rejects an invalid explicit override without falling through", () => {
    const root = temporaryDirectory();
    const fallback = executable(path.join(root, "bin"));
    const result = discoverLinuxCuaDriver({
      env: { CUA_DRIVER_PATH: path.join(root, "missing"), PATH: path.dirname(fallback) },
      homeDir: root,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "driver-not-found" });
  });

  it("resolves the official user-local symlink to its canonical executable", () => {
    const root = temporaryDirectory();
    const release = executable(path.join(root, ".cua-driver", "packages", "releases", "0.19.3"));
    const localBin = path.join(root, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true, mode: 0o700 });
    fs.symlinkSync(release, path.join(localBin, "cua-driver"));

    expect(discoverLinuxCuaDriver({ env: { PATH: "" }, homeDir: root })).toEqual({
      status: "found",
      path: release,
      source: "user-local",
    });
  });

  it("ignores empty and relative PATH entries and preserves literal metacharacters", () => {
    const root = temporaryDirectory();
    const safeDirectory = path.join(root, "driver $; directory");
    const binary = executable(safeDirectory);
    const value = ["", ".", "relative/bin", safeDirectory, safeDirectory].join(path.delimiter);
    expect(sanitizePath(value)).toBe(safeDirectory);
    expect(discoverLinuxCuaDriver({ env: { PATH: value }, homeDir: path.join(root, "home") })).toEqual({
      status: "found",
      path: binary,
      source: "path",
    });
  });

  it("rejects a group-writable executable", () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    fs.chmodSync(binary, 0o720);
    expect(validateDriverCandidate(binary)).toMatchObject({
      status: "unavailable",
      reasonCode: "unsafe-driver-permissions",
    });
  });
});

describe("Linux CUA diagnostics", () => {
  it("passes only the minimal desktop environment and returns a certified contract", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = successfulRunner(binary);
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      homeDir: path.join(root, "home"),
      env: {
        CUA_DRIVER_PATH: binary,
        XDG_SESSION_TYPE: "x11",
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        PATH: "/usr/bin",
        HOME: root,
        OPENAI_API_KEY: "must-not-leak",
      },
      run,
    });

    expect(result).toMatchObject({
      status: "ready",
      path: binary,
      driverVersion: "0.19.3",
      manifestSchema: "1",
      mcp: { command: binary, args: ["mcp"] },
    });
    expect(result.doctor.warnings).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails before discovery or execution outside Xorg", async () => {
    const run = vi.fn();
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "wayland-unsupported" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects version and manifest drift", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = vi.fn(async (_command, args) => {
      if (args[0] === "--version") return { exitCode: 0, stdout: "cua-driver 0.20.0", stderr: "" };
      throw new Error("should not continue");
    });
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      homeDir: root,
      env: { CUA_DRIVER_PATH: binary, XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "unsupported-driver-version" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("requires healthy X11 and AT-SPI probes", async () => {
    const root = temporaryDirectory();
    const binary = executable(path.join(root, "bin"));
    const run = successfulRunner(binary);
    run.mockImplementationOnce(async () => ({ exitCode: 0, stdout: "cua-driver 0.19.3", stderr: "" }));
    run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: "1",
        binary_version: "0.19.3",
        mcp_invocation: { command: binary, args: ["mcp"] },
      }),
      stderr: "",
    }));
    run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ...healthyDoctor(),
        probes: healthyDoctor().probes.map((probe) =>
          probe.label === "AT-SPI" ? { ...probe, status: "warn" } : probe,
        ),
      }),
      stderr: "",
    }));
    const result = await inspectLinuxCuaDriver({
      platform: "linux",
      homeDir: root,
      env: { CUA_DRIVER_PATH: binary, XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
      run,
    });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "at-spi-unavailable" });
  });
});

describe("bounded command execution", () => {
  it("times out and bounds output", async () => {
    await expect(
      runCuaCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "command-timeout" });

    await expect(
      runCuaCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
        maxOutputBytes: 64,
      }),
    ).rejects.toMatchObject({ code: "output-too-large" });
  });
});

describe("minimal child environment", () => {
  it("keeps desktop session values but drops application secrets", () => {
    expect(
      desktopCommandEnvironment({
        HOME: "/home/test",
        DISPLAY: ":0",
        PATH: ":relative:/usr/bin:/usr/bin",
        OPENAI_API_KEY: "secret",
      }),
    ).toEqual({
      HOME: "/home/test",
      DISPLAY: ":0",
      PATH: "/usr/bin",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
  });
});
