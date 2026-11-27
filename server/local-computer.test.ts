import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CUA_CONTRACT_VERSION,
  CUA_DRIVER_VERSION,
  DRIVER_FILE_IDENTITY_KEYS,
  REQUIRED_LINUX_TOOLS,
  WINDOWS_DRIVER_ENV,
  decodeLegacyDescriptor,
  decodeLinuxDescriptor,
  decodeWindowsDescriptor,
  readCuaConnection,
  validateLegacyDescriptorRuntime,
  validateLinuxDescriptorRuntime,
} from "./local-computer.ts";
import { HostComputerBroker, hostComputerSession } from "./host-computer-broker.ts";
import { fakeHostDescriptorSource } from "./testing/fake-host-descriptor.ts";
import { localControlIsOff } from "./local-routing.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

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
      version: "0.55.0",
      source: "environment",
      manifestSchema: "1",
      fileIdentity,
    },
    daemon: {
      socketPath: socket,
      pid: process.pid,
      contractVersion: "0.9.0",
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
    removeTempDirSync(directory);
  }
});

describe("local computer descriptor", () => {
  it("exports the driver and contract pins the Linux decoder enforces (CONTRACT-REQ C1)", () => {
    expect([CUA_DRIVER_VERSION, CUA_CONTRACT_VERSION]).toEqual(["0.55.0", "0.9.0"]);
    const descriptor = linuxDescriptor(privateUserData("linux-pins"));
    expect(decodeLinuxDescriptor(descriptor)).not.toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, driver: { ...descriptor.driver, version: "0.54.0" } })).toBeNull();
    expect(decodeLinuxDescriptor({ ...descriptor, daemon: { ...descriptor.daemon, contractVersion: "0.8.0" } })).toBeNull();
  });

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

  // DESIGN 1022-cua-windows R8 / W-V2: this used to pin that a legacy win32 descriptor naming ANY command decodes.
  // D5 kills that path on purpose (a legacy file names whatever command it likes); win32 decodes only the pinned
  // windows-supervised shape (describe "win32 descriptor" below).
  it("W-V2 a legacy win32 descriptor naming any command never decodes", () => {
    const userData = privateUserData("windows-user-data");
    const legacy = {
      mode: "embedded",
      status: "ready",
      socketPath: "\\\\.\\pipe\\cua-driver",
      mcpCommand: "C:\\any.exe",
      mcpArgs: ["mcp"],
      // telemetry and update check off, so the darwin legacy decoder would take it: only the win32 rule refuses it
      mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false" },
    };
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(legacy));
    expect(readCuaConnection({ platform: "win32", userData, resourcesPath: "C:\\Program Files\\Murage\\resources" })).toBeNull();
    expect(decodeLegacyDescriptor(legacy, "win32")).toBeNull();
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
  // The off-keys electron/cua.mjs (CUA_ENV) writes into every Mac descriptor; the darwin decoder requires both (CONTRACT-REQ C2).
  const offEnv = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "false" };
  const legacy = { mode: "embedded", status: "ready", socketPath: "/tmp/cua.sock", mcpCommand: "/usr/local/bin/cua-driver", mcpArgs: ["mcp"], mcpEnv: offEnv };
  const expected = {
    command: "/usr/local/bin/cua-driver",
    args: ["mcp"],
    env: offEnv,
    platform: "darwin",
    scope: "local-computer",
  };

  it.skipIf(process.platform === "win32")("accepts a descriptor only this user could have written", () => {
    const userData = privateUserData("darwin-user-data");
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(legacy), { mode: 0o600 });
    expect(readCuaConnection({ platform: "darwin", userData })).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")("a Mac descriptor mounts only with driver telemetry and the update check both off", () => {
    const { CUA_DRIVER_RS_TELEMETRY_ENABLED: _telemetry, ...telemetryMissing } = offEnv;
    const { CUA_DRIVER_RS_UPDATE_CHECK: _update, ...updateMissing } = offEnv;
    const refused = {
      "no env": {},
      "telemetry missing": telemetryMissing,
      "update check missing": updateMissing,
      "telemetry on": { ...offEnv, CUA_DRIVER_RS_TELEMETRY_ENABLED: "1" },
      "telemetry true": { ...offEnv, CUA_DRIVER_RS_TELEMETRY_ENABLED: "true" },
      "update check on": { ...offEnv, CUA_DRIVER_RS_UPDATE_CHECK: "true" },
      "update check empty": { ...offEnv, CUA_DRIVER_RS_UPDATE_CHECK: "" },
    };
    const decoded = Object.fromEntries(Object.entries(refused).map(([label, mcpEnv]) => {
      const userData = privateUserData("darwin-phone-home");
      writeFileSync(join(userData, "cua-connection.json"), JSON.stringify({ ...legacy, mcpEnv }), { mode: 0o600 });
      return [label, readCuaConnection({ platform: "darwin", userData })];
    }));
    expect(decoded).toEqual(Object.fromEntries(Object.keys(refused).map((label) => [label, null])));
    const linuxSpelling = privateUserData("darwin-telemetry-false");
    const env = { ...offEnv, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };
    writeFileSync(join(linuxSpelling, "cua-connection.json"), JSON.stringify({ ...legacy, mcpEnv: env }), { mode: 0o600 });
    expect(readCuaConnection({ platform: "darwin", userData: linuxSpelling })).toEqual({ ...expected, env });
  });

  // Both broker spawn paths merge the harness env under the descriptor env: the
  // one-off child (host-computer-broker.ts dispatch) and the kept per-turn session
  // the live route uses (index.ts passes hostComputerSession). Mac and Linux both.
  it.skipIf(process.platform === "win32")("the Mac and Linux driver processes are spawned with telemetry and the update check off on both broker paths, even when the harness env turns them on", async () => {
    const darwinData = privateUserData("darwin-spawn-env");
    writeFileSync(join(darwinData, "cua-connection.json"), JSON.stringify(legacy), { mode: 0o600 });
    const linuxData = privateUserData("linux-spawn-env");
    writeFileSync(join(linuxData, "cua-connection.json"), JSON.stringify(linuxDescriptor(linuxData)), { mode: 0o600 });
    const connections = {
      darwin: readCuaConnection({ platform: "darwin", userData: darwinData })!,
      linux: readCuaConnection({ platform: "linux", userData: linuxData, validateLinuxRuntime: () => true })!,
    };
    const saved = { telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, update: process.env.CUA_DRIVER_RS_UPDATE_CHECK };
    process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "1";
    process.env.CUA_DRIVER_RS_UPDATE_CHECK = "true";
    const spawned: string[][] = [];
    try {
      for (const [platform, connection] of Object.entries(connections)) {
        for (const path of ["one-off", "session"] as const) {
          const broker = new HostComputerBroker((spec) => {
            spawned.push([platform, path, spec.command, spec.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, spec.env.CUA_DRIVER_RS_UPDATE_CHECK]);
            return { request: async (method: string) => (method === "tools/list" ? { tools: [] } : {}), close: async () => {} } as never;
          });
          const spec = { command: connection.command, args: connection.args, env: connection.env };
          const session = path === "session" ? hostComputerSession("bot-a", "thread-a", "gen-a", 1) : undefined;
          await broker.dispatch(spec, "tools/list", {}, () => true, undefined, session);
          await broker.drain();
        }
      }
    } finally {
      for (const [key, value] of [["CUA_DRIVER_RS_TELEMETRY_ENABLED", saved.telemetry], ["CUA_DRIVER_RS_UPDATE_CHECK", saved.update]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(spawned).toEqual([
      ["darwin", "one-off", "/usr/local/bin/cua-driver", "0", "false"],
      ["darwin", "session", "/usr/local/bin/cua-driver", "0", "false"],
      ["linux", "one-off", connections.linux.command, "false", "false"],
      ["linux", "session", connections.linux.command, "false", "false"],
    ]);
  });

  // The harness fixture (server/testing/fake-host-descriptor.ts) other suites
  // mount "this computer" through, e.g. computer-handover-turn-api.test.ts. Its
  // darwin branch only runs on a Mac, so run that branch here and decode it with
  // the real darwin decoder: it must mount, with the off-keys and the fixture env.
  it.skipIf(process.platform === "win32")("the harness's darwin fake host descriptor mounts through the real Mac decoder", () => {
    const dataDir = realpathSync(privateUserData("darwin-fake-host"));
    const source = fakeHostDescriptorSource({ driverSource: "", driverEnv: { FIXTURE_HOST_SECRET: "'synthetic-host-only'" } });
    // A real node child runs the fixture source verbatim; only `process.platform` reads "darwin".
    const prelude = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      `const dataDir = ${JSON.stringify(dataDir)};`,
      "const process = new Proxy(globalThis.process, { get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key)) });",
    ].join("\n");
    execFileSync(globalThis.process.execPath, ["--input-type=module", "-e", `${prelude}\n${source}`], { stdio: "pipe" });
    expect(readCuaConnection({ platform: "darwin", userData: dataDir })?.env).toEqual({
      FIXTURE_HOST_SECRET: "synthetic-host-only",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
  });

  it.skipIf(process.platform === "win32")("a working Mac descriptor never counts as local control off", () => {
    const userData = privateUserData("darwin-not-off");
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(legacy), { mode: 0o600 });
    expect(localControlIsOff(readCuaConnection({ platform: "darwin", userData }))).toBe(false);
    expect(localControlIsOff(readCuaConnection({ platform: "darwin", userData: privateUserData("darwin-empty") }))).toBe(true);
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
  const ready = { mode: "embedded", status: "ready", socketPath: "/tmp/cua.sock", mcpCommand: "/usr/local/bin/cua-driver", mcpArgs: ["mcp", "--embedded"], mcpEnv: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "false" } };
  const write = (directory: string, value: unknown) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "cua-connection.json"), JSON.stringify(value), { mode: 0o600 });
  };
  const appSupport = (home: string, name: string) => join(home, "Library", "Application Support", name);

  it("mounts a complete, ready descriptor", () => {
    const userData = privateUserData("ready");
    write(userData, ready);
    expect(readCuaConnection({ platform: "darwin", userData })).toMatchObject({ command: ready.mcpCommand, args: ready.mcpArgs, platform: "darwin" });
    // DESIGN 1022-cua-windows D5 / W-V2: win32 no longer takes the legacy branch at all.
    expect(readCuaConnection({ platform: "win32", userData })).toBeNull();
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

// DESIGN 1022-cua-windows R7 / W-V1: the only win32 descriptor that mounts anything (D5).
describe("win32 descriptor", () => {
  const resourcesPath = "C:\\Users\\owner\\AppData\\Local\\Programs\\Murage\\resources";
  const pin = { sha256: "a".repeat(64) };
  const driverPath = `${resourcesPath}\\cua-win32-x64\\cua-driver.exe`;
  const pipe = "\\\\.\\pipe\\murage-cua-4242-0123456789ab";
  const valid = () => ({
    mode: "windows-supervised",
    platform: "win32",
    schemaVersion: 1,
    status: "ready",
    generation: "0123456789ab",
    driver: { path: driverPath, version: "0.55.0", source: "bundled", sha256: "a".repeat(64), fileIdentity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" } },
    daemon: { pipe, pid: 4242, contractVersion: "0.9.0", toolsListSchemaVersion: "1", capabilityVersion: "1", mcpProtocolVersion: "2025-06-18" },
    mcp: { command: driverPath, args: ["mcp", "--embedded", "--socket", pipe], env: { ...WINDOWS_DRIVER_ENV } as Record<string, string> },
  });
  const decode = (value: Record<string, unknown>) => decodeWindowsDescriptor(value, { resourcesPath, pin });

  it("readCuaConnection(win32) mounts a valid pinned descriptor through the production reader", () => {
    const userData = privateUserData("win32-reader");
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify(valid()));
    expect(readCuaConnection({ platform: "win32", userData, resourcesPath, windowsPin: pin })).toMatchObject({ platform: "win32", command: driverPath, generation: "0123456789ab" });
  });
  it("valid decodes to the pinned driver with exactly the D4 env", () => {
    expect(decode(valid())).toMatchObject({ command: driverPath, args: ["mcp", "--embedded", "--socket", pipe], env: WINDOWS_DRIVER_ENV, platform: "win32", generation: "0123456789ab" });
  });
  it("no TELEMETRY key -> null", () => {
    const value = valid(); delete value.mcp.env.CUA_DRIVER_RS_TELEMETRY_ENABLED;
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("TELEMETRY \"true\" -> null", () => {
    const value = valid(); value.mcp.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "true";
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("no UPDATE_CHECK key -> null", () => {
    const value = valid(); delete value.mcp.env.CUA_DRIVER_RS_UPDATE_CHECK;
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("UPDATE_CHECK \"1\" -> null", () => {
    const value = valid(); value.mcp.env.CUA_DRIVER_RS_UPDATE_CHECK = "1";
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("an extra key -> null", () => {
    expect(decode({ ...valid(), extra: true })).toBeNull();
  });
  it("command != driver path -> null", () => {
    const value = valid(); value.mcp.command = "C:\\Windows\\System32\\cmd.exe";
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("driver path outside resources -> null", () => {
    const value = valid(); value.driver.path = "C:\\Temp\\cua-win32-x64\\cua-driver.exe"; value.mcp.command = value.driver.path;
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("a pipe that is not murage-cua-<pid>-<gen12> -> null", () => {
    const value = valid(); const bad = "\\\\.\\pipe\\cua-driver"; value.daemon.pipe = bad; value.mcp.args[3] = bad;
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("version 0.54.0 -> null", () => {
    const value = valid(); value.driver.version = "0.54.0";
    expect(decode(value), expect.getState().currentTestName).toBeNull();
  });
  it("driver.sha256 != the server's own pin -> null", () => {
    const value = valid(); value.driver.sha256 = "b".repeat(64);
    expect(decodeWindowsDescriptor(value, { resourcesPath, pin })).toBeNull();
  });
});
