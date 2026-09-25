import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DRIVER_FILE_IDENTITY_KEYS,
  REQUIRED_LINUX_TOOLS,
  decodeLinuxDescriptor,
  readCuaConnection,
  validateLegacyDescriptorRuntime,
  validateLinuxDescriptorRuntime,
} from "./local-computer.ts";

const require = createRequire(import.meta.url);
const { DRIVER_FILE_IDENTITY_KEYS: ELECTRON_DRIVER_FILE_IDENTITY_KEYS } = require(
  "../electron/cua-linux.cjs",
);
const { REQUIRED_TOOLS: ELECTRON_REQUIRED_TOOLS } = require("../electron/cua-linux-runtime.cjs");

function linuxDescriptor(userData: string, { session = "x11" }: { session?: "x11" | "wayland" } = {}) {
  const binary = join(userData, "cua-driver");
  const socket = join(userData, "runtime", "driver.sock");
  writeFileSync(binary, "fake", { mode: 0o700 });
  const stat = statSync(binary, { bigint: true });
  const fileIdentity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
  return {
    schemaVersion: 1,
    mode: session === "wayland" ? "linux-wayland-gnome-supervised" : "linux-x11-supervised",
    platform: "linux",
    session,
    ...(session === "wayland" ? { compositor: "gnome-mutter" } : {}),
    enabled: true,
    status: "ready",
    ownerPid: process.pid,
    generation: "01234567-89ab-cdef-0123-456789abcdef",
    driver: {
      path: binary,
      version: "0.19.3",
      source: "environment",
      manifestSchema: "1",
      fileIdentity,
    },
    daemon: {
      socketPath: socket,
      pid: process.pid,
      contractVersion: "0.6.0",
      toolsListSchemaVersion: "1",
      capabilityVersion: "1",
      mcpProtocolVersion: "2025-06-18",
    },
    mcp: {
      command: binary,
      args: ["mcp", "--embedded", "--socket", socket],
      env: {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: "com.murage.app",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        ...(session === "wayland" ? { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" } : {}),
      },
    },
    toolNames: ["click", "get_window_state", "list_apps", "type_text"],
    doctorWarnings: [],
  };
}

describe("local computer descriptor contract", () => {
  it("stays synchronized with the Electron producer", () => {
    expect(DRIVER_FILE_IDENTITY_KEYS).toEqual([...ELECTRON_DRIVER_FILE_IDENTITY_KEYS]);
    expect(REQUIRED_LINUX_TOOLS).toEqual([...ELECTRON_REQUIRED_TOOLS]);
  });
});

const temporaryDirectories: string[] = [];

function privateUserData(name: string) {
  const base = process.platform === "win32" ? tmpdir() : realpathSync("/tmp");
  const root = mkdtempSync(join(base, "murage-local-computer-"));
  temporaryDirectories.push(root);
  const userData = join(root, name);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  chmodSync(userData, 0o700);
  return userData;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local computer descriptor", () => {
  it("accepts only the exact certified Linux X11 descriptor", () => {
    const userData = privateUserData("linux-user-data");
    const descriptor = linuxDescriptor(userData);
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(descriptor), { mode: 0o600 });

    expect(
      readCuaConnection({
        platform: "linux",
        userData,
        validateLinuxRuntime: () => true,
      }),
    ).toEqual({
      command: descriptor.driver.path,
      args: descriptor.mcp.args,
      env: descriptor.mcp.env,
      platform: "linux",
      generation: descriptor.generation,
      scope: "local-computer",
    });
  });

  it("accepts the exact GNOME Wayland descriptor without weakening the X11 contract", () => {
    const userData = privateUserData("linux-wayland-user-data");
    const descriptor = linuxDescriptor(userData, { session: "wayland" });
    expect(decodeLinuxDescriptor(descriptor)).toEqual({
      command: descriptor.driver.path,
      args: descriptor.mcp.args,
      env: descriptor.mcp.env,
      platform: "linux",
      generation: descriptor.generation,
      scope: "local-computer",
    });
    expect(decodeLinuxDescriptor({ ...descriptor, compositor: "kde-kwin" })).toBeNull();
    const { CUA_DRIVER_RS_ENABLE_WAYLAND: _missing, ...x11OnlyEnv } = descriptor.mcp.env;
    expect(
      decodeLinuxDescriptor({ ...descriptor, mcp: { ...descriptor.mcp, env: x11OnlyEnv } }),
    ).toBeNull();
    const x11Descriptor = linuxDescriptor(userData);
    expect(
      decodeLinuxDescriptor({
        ...x11Descriptor,
        mcp: {
          ...x11Descriptor.mcp,
          env: { ...x11Descriptor.mcp.env, CUA_DRIVER_RS_ENABLE_WAYLAND: "1" },
        },
      }),
    ).toBeNull();
  });

  it("rejects unknown fields, stale modes, arbitrary argv, and incomplete tool surfaces", () => {
    const userData = privateUserData("linux-invalid-user-data");
    const descriptor = linuxDescriptor(userData);
    expect(decodeLinuxDescriptor({ ...descriptor, unexpected: true })).toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, status: "starting" })).toBeNull();
    const { CUA_DRIVER_RS_TELEMETRY_ENABLED: _telemetry, ...telemetryMissing } =
      descriptor.mcp.env;
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: { ...descriptor.mcp, env: telemetryMissing },
      }),
    ).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: { ...descriptor.mcp, args: ["mcp", "--socket", descriptor.daemon.socketPath, "--evil"] },
      }),
    ).toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, toolNames: ["list_apps"] })).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        mcp: {
          ...descriptor.mcp,
          env: { ...descriptor.mcp.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "true" },
        },
      }),
    ).toBeNull();
    expect(
      decodeLinuxDescriptor({
        ...descriptor,
        driver: { ...descriptor.driver, fileIdentity: { ...descriptor.driver.fileIdentity, extra: "1" } },
      }),
    ).toBeNull();
    const { fileIdentity: _missingIdentity, ...driverWithoutIdentity } = descriptor.driver;
    expect(decodeLinuxDescriptor({ ...descriptor, driver: driverWithoutIdentity })).toBeNull();
  });

  it("fails closed when runtime ownership or liveness validation fails", () => {
    const userData = privateUserData("linux-stale-user-data");
    const descriptor = linuxDescriptor(userData);
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(descriptor), { mode: 0o600 });
    expect(
      readCuaConnection({ platform: "linux", userData, validateLinuxRuntime: () => false }),
    ).toBeNull();
  });

  // Runtime ownership includes a real Linux Unix-domain socket and POSIX
  // permission checks. Keep the schema/decoder cases above cross-platform,
  // but run this host-filesystem proof only on the authoritative Linux lane.
  it.skipIf(process.platform !== "linux")(
    "validates private descriptor, executable, socket, and live owned processes",
    async () => {
      const userData = privateUserData("linux-runtime-security");
      const runtimeDirectory = join(userData, "runtime");
      mkdirSync(runtimeDirectory, { mode: 0o700 });
      const descriptor = linuxDescriptor(userData);
      const file = join(userData, "cua-connection.json");
      writeFileSync(file, JSON.stringify(descriptor), { mode: 0o600 });
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(descriptor.daemon.socketPath, resolve);
      });
      try {
        chmodSync(descriptor.daemon.socketPath, 0o600);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(true);
        expect(readCuaConnection({ platform: "linux", userData })).not.toBeNull();
        chmodSync(file, 0o644);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(false);
        chmodSync(file, 0o600);
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(true);
        appendFileSync(descriptor.driver.path, "changed after descriptor publication");
        expect(validateLinuxDescriptorRuntime(file, descriptor)).toBe(false);
        expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("still rejects an old embedded-looking Linux descriptor", () => {
    const userData = privateUserData("linux-forged-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp", "--embedded"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
      { mode: 0o600 },
    );
    expect(readCuaConnection({ platform: "linux", userData })).toBeNull();
  });

  it("preserves the selected Windows descriptor contract", () => {
    const userData = privateUserData("windows-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "embedded",
        status: "ready",
        socketPath: "\\\\.\\pipe\\cua-driver",
        mcpCommand: "C:\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );
    expect(readCuaConnection({ platform: "win32", userData })).toEqual({
      command: "C:\\cua-driver.exe",
      args: ["mcp"],
      env: { CUA_DRIVER_EMBEDDED: "1" },
      platform: "win32",
      scope: "local-computer",
    });
  });

  it("rejects malformed legacy argv and environment values", () => {
    const userData = privateUserData("invalid-user-data");
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({ mode: "embedded", mcpCommand: "cua-driver", mcpArgs: "mcp" }),
    );
    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });
});

// darwin is the primary platform and it takes the LEGACY branch, where the
// descriptor is a free-text command line with nothing binding it to a driver
// we shipped. The shape check alone therefore proves nothing: whoever could
// write that file chose what the harness executes. These hold the runtime
// check that the Linux branch has always had.
describe("legacy descriptor runtime custody", () => {
  const legacy = { mode: "embedded", status: "ready", socketPath: "/tmp/cua.sock", mcpCommand: "/usr/local/bin/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };
  const expected = {
    command: "/usr/local/bin/cua-driver",
    args: ["mcp"],
    env: {},
    platform: "darwin",
    scope: "local-computer",
  };

  it.skipIf(process.platform === "win32")("accepts a descriptor only this user could have written", () => {
    const userData = privateUserData("darwin-user-data");
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(legacy), { mode: 0o600 });
    expect(readCuaConnection({ platform: "darwin", userData })).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")("refuses a descriptor anyone on the machine could rewrite", () => {
    const userData = privateUserData("darwin-group-writable");
    const file = join(userData, "cua-connection.json");
    writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 });
    expect(readCuaConnection({ platform: "darwin", userData })).toEqual(expected);
    chmodSync(file, 0o666);
    expect(readCuaConnection({ platform: "darwin", userData })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a descriptor sitting in a directory anyone may write", () => {
    const userData = privateUserData("darwin-open-directory");
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(legacy), { mode: 0o600 });
    chmodSync(userData, 0o777);
    expect(readCuaConnection({ platform: "darwin", userData })).toBeNull();
    chmodSync(userData, 0o700);
  });

  it.skipIf(process.platform === "win32")("refuses a symlink pointing at a descriptor elsewhere", () => {
    const userData = privateUserData("darwin-symlink");
    const real = privateUserData("darwin-symlink-target");
    const target = join(real, "planted.json");
    writeFileSync(target, JSON.stringify(legacy), { mode: 0o600 });
    symlinkSync(target, join(userData, "cua-connection.json"));
    expect(readCuaConnection({ platform: "darwin", userData })).toBeNull();
  });

  it("keeps the ownership and permission bits out of the Windows judgement", () => {
    // libuv reports every writable Windows file as uid 0 mode 0o666, so
    // those bits cannot mean anything there; the symlink refusal still does.
    expect(
      validateLegacyDescriptorRuntime(join(privateUserData("win-bits"), "missing.json"), "win32"),
    ).toBe(false);
    const userData = privateUserData("win-bits-present");
    const file = join(userData, "cua-connection.json");
    writeFileSync(file, JSON.stringify(legacy), { mode: 0o666 });
    expect(validateLegacyDescriptorRuntime(file, "win32", { uid: -12345 })).toBe(true);
    expect(validateLegacyDescriptorRuntime(file, "darwin", { uid: -12345 })).toBe(false);
  });
});

// Upstream #1730: the descriptor used to fail open. A stale or broken file at
// the exact app-data path fell through to older folders (a previous install's
// OpenGrokBot descriptor, say), and any mode but "unavailable" mounted. Now
// the first descriptor that exists decides, and only a complete, ready one
// becomes a connection.
describe.skipIf(process.platform === "win32")("legacy descriptor fails closed", () => {
  const ready = { mode: "embedded", status: "ready", socketPath: "/tmp/cua.sock", mcpCommand: "/usr/local/bin/cua-driver", mcpArgs: ["mcp", "--embedded"], mcpEnv: {} };
  const write = (directory: string, value: unknown) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "cua-connection.json"), JSON.stringify(value), { mode: 0o600 });
  };
  const appSupport = (home: string, name: string) => join(home, "Library", "Application Support", name);

  it("mounts a complete, ready descriptor", () => {
    const userData = privateUserData("ready");
    write(userData, ready);
    for (const platform of ["darwin", "win32"] as const) {
      expect(readCuaConnection({ platform, userData })).toMatchObject({ command: ready.mcpCommand, args: ready.mcpArgs, platform });
    }
  });

  it.each([
    ["no status", { status: undefined }],
    ["an unavailable status", { status: "unavailable" }],
    ["a null status", { status: null }],
    ["an object status", { status: {} }],
    ["no socket", { socketPath: undefined }],
    ["an empty socket", { socketPath: "" }],
    ["no argv", { mcpArgs: undefined }],
    ["argv that is not the MCP subcommand", { mcpArgs: ["--eval", "x"] }],
    ["an empty argv", { mcpArgs: [] }],
    ["an unknown mode", { mode: "bundled" }],
    ["no mode", { mode: undefined }],
    ["a blank command", { mcpCommand: "  " }],
  ])("refuses a descriptor with %s", (_label, change) => {
    const userData = privateUserData("incomplete");
    write(userData, { ...ready, ...change });
    expect(readCuaConnection({ platform: "darwin", userData })).toBeNull();
    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
  });

  it("never falls back past a stale exact descriptor to an older folder", () => {
    const userData = privateUserData("exact-stale");
    const home = privateUserData("exact-stale-home");
    write(appSupport(home, "OpenGrokBot"), ready);
    write(userData, { mode: "unavailable", reason: "Screen Recording required" });
    expect(readCuaConnection({ platform: "darwin", userData, home })).toBeNull();
    write(userData, { mode: "embedded" });
    expect(readCuaConnection({ platform: "darwin", userData, home })).toBeNull();
    writeFileSync(join(userData, "cua-connection.json"), "{ not json", { mode: 0o600 });
    expect(readCuaConnection({ platform: "darwin", userData, home })).toBeNull();
  });

  it("uses only the app's exact folder when it names one, even before the app has written there", () => {
    const userData = privateUserData("exact-missing");
    const home = privateUserData("exact-missing-home");
    write(appSupport(home, "Murage"), ready);
    expect(readCuaConnection({ platform: "darwin", userData, home })).toBeNull();
  });

  it("treats the first present older descriptor as the answer", () => {
    const home = privateUserData("legacy-order-home");
    write(appSupport(home, "Murage"), { ...ready, status: "unavailable" });
    write(appSupport(home, "OpenGrokBot"), ready);
    expect(readCuaConnection({ platform: "darwin", userData: undefined, home })).toBeNull();
    write(appSupport(home, "Murage"), ready);
    expect(readCuaConnection({ platform: "darwin", userData: undefined, home })).toMatchObject({ command: ready.mcpCommand });
  });
});
