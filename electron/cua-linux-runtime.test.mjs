import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const {
  createLinuxCuaPreferenceStore,
  createLinuxCuaRuntime,
  validateDaemonMetadata,
  validateToolSurface,
  writePrivateJson,
} = require("./cua-linux-runtime.cjs");

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openmausbot-cua-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, "cua-driver");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return binary;
}

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.stdin = {
    end: vi.fn(() => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }),
  };
  child.kill = vi.fn((signal) => {
    if (child.exitCode !== null) return true;
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    queueMicrotask(() => child.emit("exit", child.exitCode, signal));
    return true;
  });
  child.crash = () => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  return child;
}

function handshake(pid = 4321) {
  return {
    metadata: {
      driver_version: "0.19.3",
      contract_version: "0.6.0",
      tools_list_schema_version: "1",
      capability_version: "1",
      mcp_protocol_version: "2025-06-18",
      pid,
      embedded: true,
      host_bundle_id: "com.openmausbot.app",
    },
    tools: ["click", "get_window_state", "list_apps", "type_text"],
  };
}

function harness({ preferenceEnabled = false } = {}) {
  const userData = temporaryDirectory();
  const runtimeRoot = path.join(userData, "session");
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const binary = executable(path.join(userData, "driver"));
  const connectionStore = createCuaConnectionStore({ getUserData: () => userData });
  const preferenceStore = createLinuxCuaPreferenceStore({ getUserData: () => userData });
  if (preferenceEnabled) preferenceStore.write(true);
  const child = fakeChild();
  const inspect = vi.fn(async () => ({
    status: "ready",
    path: binary,
    source: "environment",
    driverVersion: "0.19.3",
    manifestSchema: "1",
    mcp: { command: binary, args: ["mcp"] },
    doctor: { ok: true, probes: [], warnings: [] },
  }));
  const spawnProcess = vi.fn(() => child);
  const probe = vi.fn(async () => handshake(child.pid));
  const changes = [];
  const runtime = createLinuxCuaRuntime({
    getUserData: () => userData,
    connectionStore,
    preferenceStore,
    platform: "linux",
    env: {
      HOME: userData,
      PATH: "/usr/bin",
      DISPLAY: ":0",
      XDG_SESSION_TYPE: "x11",
      XDG_RUNTIME_DIR: runtimeRoot,
      OPENAI_API_KEY: "must-not-leak",
    },
    inspect,
    spawnProcess,
    probe,
    identifier: () => "01234567-89ab-cdef-0123-456789abcdef",
    processId: 1234,
    onChange: (connection) => changes.push(connection),
  });
  return {
    binary,
    changes,
    child,
    connectionStore,
    inspect,
    preferenceStore,
    probe,
    runtime,
    spawnProcess,
    userData,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux CUA opt-in and lifecycle", () => {
  it("does not inspect or execute a driver before explicit opt-in", async () => {
    const context = harness();
    await context.runtime.initialize();
    expect(context.inspect).not.toHaveBeenCalled();
    expect(context.spawnProcess).not.toHaveBeenCalled();
    expect(context.runtime.getStatus()).toMatchObject({
      enabled: false,
      status: "disabled",
      reasonCode: "opt-in-required",
    });
  });

  it("coalesces starts, verifies a private daemon, and publishes a strict ready descriptor", async () => {
    const context = harness();
    const [first, second] = await Promise.all([context.runtime.enable(), context.runtime.enable()]);
    expect(first).toEqual(second);
    expect(context.inspect).toHaveBeenCalledTimes(1);
    expect(context.spawnProcess).toHaveBeenCalledTimes(1);
    expect(context.spawnProcess).toHaveBeenCalledWith(
      context.binary,
      expect.arrayContaining(["serve", "--embedded", "--socket", "--permission-mode", "standard"]),
      expect.objectContaining({ shell: false, stdio: ["pipe", "ignore", "pipe"] }),
    );
    const spawnOptions = context.spawnProcess.mock.calls[0][2];
    expect(spawnOptions.env).toMatchObject({
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
      CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app",
    });
    expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(context.probe).toHaveBeenCalledWith(expect.stringMatching(/driver\.sock$/), {
      childPid: context.child.pid,
    });
    expect(context.runtime.getConnection()).toMatchObject({
      schemaVersion: 1,
      mode: "linux-x11-supervised",
      platform: "linux",
      session: "x11",
      enabled: true,
      status: "ready",
      ownerPid: 1234,
      generation: "01234567-89ab-cdef-0123-456789abcdef",
      driver: { path: context.binary, version: "0.19.3", manifestSchema: "1" },
      daemon: { pid: 4321, contractVersion: "0.6.0" },
      mcp: {
        command: context.binary,
        args: ["mcp", "--embedded", "--socket", expect.stringMatching(/driver\.sock$/)],
      },
    });
    const descriptor = path.join(context.userData, "cua-connection.json");
    expect(fs.statSync(descriptor).mode & 0o777).toBe(0o600);
    expect(fs.statSync(context.userData).mode & 0o777).toBe(0o700);
  });

  it("invalidates readiness immediately when the owned daemon exits", async () => {
    const context = harness();
    await context.runtime.enable();
    context.child.crash();
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "unavailable",
      status: "error",
      reasonCode: "daemon-exited",
      generation: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(context.userData, "cua-connection.json"), "utf8")),
    ).toMatchObject({ mode: "unavailable", reasonCode: "daemon-exited" });
  });

  it("closes the parent-liveness pipe on shutdown without clearing durable opt-in", async () => {
    const context = harness();
    await context.runtime.enable();
    await context.runtime.shutdown();
    expect(context.child.stdin.end).toHaveBeenCalledOnce();
    expect(context.child.kill).not.toHaveBeenCalled();
    expect(context.preferenceStore.read()).toBe(true);
    expect(context.runtime.getConnection()).toMatchObject({
      mode: "unavailable",
      status: "stopped",
      reasonCode: "app-stopped",
    });
  });

  it("starts on launch only after a durable prior opt-in and supports explicit disable", async () => {
    const context = harness({ preferenceEnabled: true });
    await context.runtime.initialize();
    expect(context.runtime.getConnection().mode).toBe("linux-x11-supervised");
    await context.runtime.disable();
    expect(context.preferenceStore.read()).toBe(false);
    expect(context.runtime.getStatus()).toMatchObject({ enabled: false, status: "disabled" });
  });
});

describe("Linux CUA private data", () => {
  it("uses strict preference schema and private atomic files", () => {
    const userData = temporaryDirectory();
    const store = createLinuxCuaPreferenceStore({ getUserData: () => userData });
    store.write(true);
    const file = path.join(userData, "cua-local-control.json");
    expect(store.read()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, linuxLocalControlEnabled: true, extra: true }), {
      mode: 0o600,
    });
    expect(store.read()).toBe(false);
  });

  it("does not follow a symlink when creating private state", () => {
    const root = temporaryDirectory();
    const target = path.join(root, "target.json");
    const link = path.join(root, "state.json");
    fs.writeFileSync(target, "untouched", { mode: 0o600 });
    fs.symlinkSync(target, link);
    writePrivateJson(link, { ok: true });
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    expect(JSON.parse(fs.readFileSync(link, "utf8"))).toEqual({ ok: true });
  });
});

describe("Linux CUA handshake validation", () => {
  it("pins metadata to the certified child and contract", () => {
    const valid = { ok: true, result: handshake(99).metadata };
    expect(validateDaemonMetadata(valid, { childPid: 99 })).toEqual(valid.result);
    expect(() => validateDaemonMetadata(valid, { childPid: 100 })).toThrow(/PID/);
    expect(() =>
      validateDaemonMetadata({ ok: true, result: { ...valid.result, contract_version: "9" } }),
    ).toThrow(/contract_version/);
  });

  it("requires the inspect and mutation tool surface", () => {
    const tools = handshake().tools.map((name) => ({ name }));
    expect(validateToolSurface({ ok: true, result: tools })).toEqual([...handshake().tools].sort());
    expect(() =>
      validateToolSurface({ ok: true, result: tools.filter((tool) => tool.name !== "type_text") }),
    ).toThrow(/type_text/);
  });
});
