// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to Murage and the
//    driver inherits them. One prompt, named Murage, out of the box.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain as electronIpcMain } from "electron";
// Modified for Murage: async subprocess adaptation informed by OpenMausBot
// PR1095, 31777c6c1e417d487e314fad3c1353f16c5264bd (Apache-2.0).
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createCuaConnectionStore } = require("./cua-connection.cjs");
const {
  createLinuxCuaPreferenceStore,
  createLinuxCuaRuntime,
  createUnavailableLinuxRuntime,
} = require("./cua-linux-runtime.cjs");
const {
  cleanupAppImageCuaBundle,
  reapStaleAppImageCuaBundles,
  stageAppImageCuaBundle,
} = require("./cua-linux-bundle.cjs");
const { linuxLocalControlSupport } = require("./capabilities.cjs");

const INSTALLED_DRIVER = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const HOST_BUNDLE_ID = "com.murage.app";
const CUA_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED ??= "0";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let startup = null;
let startupAbort = null;
let stopping = null;
let lifecycleGeneration = 0;
let macRetry = null;
let cleanupFailure = null;
const commands = new Map();
let linuxRuntime = null;
let linuxBundleStage = null;
let stateListener = () => {};
const connectionStore = createCuaConnectionStore({
  getUserData: () => app.getPath("userData"),
});

function ensureLinuxRuntime() {
  if (!linuxRuntime) {
    const support = linuxLocalControlSupport(process.platform, process.env);
    if (!support.available) {
      linuxRuntime = createUnavailableLinuxRuntime({
        connectionStore,
        preferenceStore: createLinuxCuaPreferenceStore({
          getUserData: () => app.getPath("userData"),
        }),
        clearPreference: true,
        reasonCode: support.reasonCode,
        message: support.message,
        onChange: (connection) => stateListener(connection),
      });
      return linuxRuntime;
    }
    try {
      let bundledDriverPath;
      if (app.isPackaged && !process.env.CUA_DRIVER_PATH) {
        bundledDriverPath = path.join(process.resourcesPath, "cua-linux-x64", "cua-driver");
        // AppImage builders may normalize the read-only resource tree to 0755
        // or 0775. Always copy only the pinned binaries to a fresh 0700
        // process-owned directory and verify their hashes after the copy, so
        // every AppImage follows the same execution invariant.
        if (process.env.APPIMAGE) {
          reapStaleAppImageCuaBundles();
          linuxBundleStage ??= stageAppImageCuaBundle({ resourcesPath: process.resourcesPath });
          bundledDriverPath = linuxBundleStage.driverPath;
        }
      }
      linuxRuntime = createLinuxCuaRuntime({
        getUserData: () => app.getPath("userData"),
        connectionStore,
        bundledDriverPath,
        onChange: (connection) => stateListener(connection),
      });
    } catch (error) {
      console.error("[cua] Bundled Linux driver failed integrity validation:", error);
      linuxRuntime = createUnavailableLinuxRuntime({
        connectionStore,
        onChange: (connection) => stateListener(connection),
      });
    }
  }
  return linuxRuntime;
}

export function setCuaStateListener(listener) {
  stateListener = typeof listener === "function" ? listener : () => {};
}

function persistAndNotify(next) {
  const connection = connectionStore.persist(next);
  stateListener(connection);
  return connection;
}

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(INSTALLED_DRIVER)) return INSTALLED_DRIVER;
  return null;
}

function socketAlive(sockPath, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    let timer;
    const abort = () => done(false);
    const done = (ok) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    timer = setTimeout(() => done(false), 1500);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function runCommand(command, args, options, signal) {
  signal?.throwIfAborted();
  let child;
  let cancel;
  let cancelled = false;
  const operation = new Promise((resolve) => {
    child = execFile(command, args, { ...options, killSignal: "SIGKILL" }, (error, stdout) => {
      resolve({ error, stdout });
    });
    cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill("SIGKILL");
    };
  });
  commands.set(operation, cancel);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return operation.finally(() => {
    commands.delete(operation);
    signal?.removeEventListener("abort", cancel);
  });
}

async function loadEmbeddedSdk() {
  if (!app.isPackaged) {
    const [embedded, permissions] = await Promise.all([
      import("@trycua/cua-driver/embedded"),
      import("@trycua/cua-driver/electron"),
    ]);
    return { ...embedded, ...permissions };
  }
  process.env.MURAGE_CUA_SDK_LIBRARY = path.join(
    process.resourcesPath,
    "cua-sdk",
    "native",
    "libcua_driver_sdk.dylib",
  );
  return import(pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "cua-sdk.mjs")).href);
}

async function attachStandalone(signal) {
  const driver = fs.existsSync(INSTALLED_DRIVER) ? INSTALLED_DRIVER : null;
  if (!driver) return null;
  if (!(await socketAlive(STANDALONE_SOCKET, signal))) {
    // Launch CuaDriver.app through LaunchServices so Accessibility /
    // Screen Recording stay on com.trycua.driver — the identity this
    // machine already granted — instead of the freshly signed Murage.
    await runCommand("/usr/bin/open", ["-a", "CuaDriver"], {
      timeout: 8000, maxBuffer: 8192,
    }, signal);
    for (let i = 0; i < 25; i++) {
      signal.throwIfAborted();
      if (await socketAlive(STANDALONE_SOCKET, signal)) break;
      await delay(200, undefined, { signal });
    }
  }
  if (!(await socketAlive(STANDALONE_SOCKET, signal))) return null;
  return {
    mode: "standalone",
    socketPath: STANDALONE_SOCKET,
    mcpCommand: driver,
    mcpArgs: ["mcp"],
    mcpEnv: { ...CUA_ENV },
  };
}

async function startEmbedded(binary, signal) {
  // Import from the staged Resources tree in production. The app intentionally
  // excludes general node_modules, so a bare package import only works in dev.
  const sdk = await loadEmbeddedSdk();
  signal.throwIfAborted();
  // CUA's embedding contract requires grants before the child daemon starts;
  // these SDK calls execute in Electron main so macOS attributes them to
  // Murage rather than to a terminal or helper process.
  const permissionStatus = sdk.requestMacOSPermissions();
  if (!sdk.hasRequiredMacOSPermissions(permissionStatus)) {
    const missing = [
      !permissionStatus.accessibility && "Accessibility",
      !permissionStatus.screenRecording && "Screen Recording",
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing || "macOS permissions"} required; grant access in System Settings and restart Murage`);
  }
  const host = new sdk.EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  embeddedHost = host;
  try {
    const conn = await host.start({ signal });
    signal.throwIfAborted();
    return {
      mode: "embedded",
      socketPath: conn.socketPath,
      mcpCommand: binary,
      mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
      mcpEnv: { ...CUA_ENV, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
    };
  } catch (err) {
    try {
      await host.stop();
      host.uniffiDestroy?.();
    } catch (error) {
      cleanupFailure = error;
      throw error;
    }
    embeddedHost = null;
    throw err;
  }
}

export async function startCua() {
  if (process.platform === "linux") return ensureLinuxRuntime().initialize();
  if (stopping) await stopping;
  if (cleanupFailure) throw cleanupFailure;
  if (startup) return startup;
  if (embeddedHost) return connectionStore.get();
  lifecycleGeneration++;
  startupAbort = new AbortController();
  const operation = initializeMacCua(startupAbort.signal);
  startup = operation;
  try { return await operation; }
  finally {
    if (startup === operation) {
      startup = null;
      startupAbort = null;
    }
  }
}

async function initializeMacCua(signal) {
  const binary = resolveDriverBinary();
  if (!binary) {
    return persistAndNotify({
      mode: "unavailable",
      reason: "cua-driver binary not found",
    });
  }

  const wantEmbedded =
    app.isPackaged || process.env.MURAGE_CUA_EMBEDDED === "1";
  let nextConnection;

  if (wantEmbedded) {
    try {
      nextConnection = await startEmbedded(binary, signal);
    } catch (err) {
      signal.throwIfAborted();
      // A failed SDK cleanup still owns a host: no fallback or replacement.
      if (embeddedHost) throw err;
      nextConnection = await attachStandalone(signal);
      if (!nextConnection) {
        nextConnection = {
          mode: "unavailable",
          reason: `embedded host failed: ${err?.message ?? err}`,
        };
      }
    }
  } else if (await socketAlive(STANDALONE_SOCKET, signal)) {
    // Dev machine with CuaDriver.app's daemon already running.
    nextConnection = {
      mode: "standalone",
      socketPath: STANDALONE_SOCKET,
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: { ...CUA_ENV },
    };
  } else {
    nextConnection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  signal.throwIfAborted();
  return persistAndNotify(nextConnection);
}

export async function cuaPermissionsStatus() {
  if (stopping) await stopping;
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = await runCommand(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    env: { ...process.env, ...CUA_ENV },
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (linuxRuntime) {
    await linuxRuntime.shutdown();
    if (linuxBundleStage) {
      cleanupAppImageCuaBundle(linuxBundleStage);
      linuxBundleStage = null;
    }
    return;
  }
  lifecycleGeneration++;
  startupAbort?.abort();
  for (const cancel of commands.values()) cancel();
  if (stopping) return stopping;
  const operation = (async () => {
    await Promise.all([...commands.keys()]);
    await startup?.catch(() => {});
    if (cleanupFailure) throw cleanupFailure;
    if (embeddedHost) {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
      embeddedHost = null;
    }
    if (connectionStore.get()) {
      persistAndNotify({ mode: "unavailable", reason: "desktop-host-stopped" });
    }
  })();
  stopping = operation;
  // Keep a rejected barrier: ownership is unresolved and replacement is unsafe.
  operation.then(() => { if (stopping === operation) stopping = null; }, () => {});
  return operation;
}

// main.mjs passes its owned-main-window gate (main-ipc-trust.mjs, B6).
export function registerCuaIpc(ipcMain = electronIpcMain) {
  ipcMain.handle("cua:connection", () => connectionStore.get());
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
  ipcMain.handle("cua:linux-status", () =>
    process.platform === "linux"
      ? ensureLinuxRuntime().getStatus()
      : { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" },
  );
  ipcMain.handle("cua:linux-enable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().enable();
    } catch (error) {
      console.error("[cua] Linux enable failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  });
  ipcMain.handle("cua:linux-disable", async () => {
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().disable();
    } catch (error) {
      console.error("[cua] Linux disable failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  });
  ipcMain.handle("cua:linux-retry", async () => {
    if (process.platform === "darwin") {
      if (macRetry) return macRetry;
      macRetry = (async () => {
      try {
        const stopped = stopCua();
        const generation = lifecycleGeneration;
        await stopped;
        if (generation !== lifecycleGeneration) throw new Error("Computer use restart cancelled");
        const connection = await startCua();
        const ready = connection?.mode === "embedded" || connection?.mode === "standalone";
        return {
          enabled: ready,
          status: ready ? "ready" : "error",
          reasonCode: ready ? undefined : "permissions-required",
          message: connection?.reason,
        };
      } catch (error) {
        console.error("[cua] macOS retry failed:", error);
        return {
          enabled: false,
          status: "error",
          reasonCode: "permissions-required",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      })().finally(() => { macRetry = null; });
      return macRetry;
    }
    if (process.platform !== "linux") {
      return { enabled: false, status: "unavailable", reasonCode: "unsupported-platform" };
    }
    try {
      await ensureLinuxRuntime().retry();
    } catch (error) {
      console.error("[cua] Linux retry failed:", error);
    }
    return ensureLinuxRuntime().getStatus();
  });
}
