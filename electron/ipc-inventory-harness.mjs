// Murage Cloud B3 WP3: the IPC channel inventory, measured on the real main.mjs.
//
// Loads main.mjs under an inert Electron stub (app.whenReady never resolves, so no window, server or helper starts)
// and records every channel it registers through the owned-main gate, plus the registrars main calls after app
// readiness (cua, updater) and the Android channels. Used by ipc-channel-classes.node-test.mjs (class coverage and
// the flag-off snapshot) and runnable by hand:
//
//   node electron/ipc-inventory-harness.mjs [electronDir]      # prints {"handles":[...],"ons":[...]} for that tree
//
// The caller's environment is scrubbed of MURAGE_* / ELECTRON_*; pass `env` to add e.g. MURAGE_DESKTOP_CLOUD=1.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function electronNamedImports(electronDir) {
  const names = new Set(["app", "ipcMain"]);
  for (const name of fs.readdirSync(electronDir).filter((file) => file.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(electronDir, name), "utf8");
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) {
      for (const part of match[1].split(",")) {
        const imported = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (imported) names.add(imported);
      }
    }
  }
  return [...names].sort();
}

const childSource = String.raw`
import { registerHooks } from "node:module";
const exportNames = JSON.parse(process.env.MURAGE_TEST_ELECTRON_EXPORTS);
const stubUrl = "murage-test:electron";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: stubUrl, format: "module", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== stubUrl) return nextLoad(url, context);
    const lines = exportNames.filter((name) => name !== "app" && name !== "ipcMain")
      .map((name) => "export const " + name + " = inert(" + JSON.stringify(name) + ");");
    return { format: "module", shortCircuit: true, source: [
      "const record = globalThis.__murageIpc;",
      "function inert(label) {",
      "  const target = function () {};",
      "  return new Proxy(target, {",
      "    get(_t, key) {",
      "      if (key === 'then') return undefined;",
      "      if (key === Symbol.toPrimitive) return () => '';",
      "      if (key === Symbol.iterator) return undefined;",
      "      return inert(label + '.' + String(key));",
      "    },",
      "    apply() { return inert(label + '()'); },",
      "    construct() { return inert('new ' + label); },",
      "  });",
      "}",
      "const paths = JSON.parse(process.env.MURAGE_TEST_ELECTRON_PATHS);",
      "export const app = new Proxy({",
      "  isPackaged: false,",
      "  getPath: (name) => paths[name] ?? paths.userData,",
      "  getVersion: () => '0.0.0-test',",
      "  getName: () => 'Murage',",
      "  requestSingleInstanceLock: () => true,",
      "  whenReady: () => new Promise(() => {}),",
      "}, { get(target, key) { return key in target ? target[key] : key === 'then' ? undefined : inert('app.' + String(key)); } });",
      "export const ipcMain = {",
      "  handle(channel) { record.handles.add(channel); },",
      "  on(channel) { record.ons.add(channel); },",
      "  once(channel) { record.ons.add(channel); },",
      "  removeHandler() {}, removeListener() {}, removeAllListeners() {},",
      "};",
      ...lines,
      "export default { app, ipcMain, " + exportNames.filter((name) => name !== "app" && name !== "ipcMain").join(", ") + " };",
    ].join("\n") };
  },
});
globalThis.__murageIpc = { handles: new Set(), ons: new Set() };
try {
  const mainUrl = process.env.MURAGE_TEST_MAIN_URL;
  await import(mainUrl);
  const record = globalThis.__murageIpc;
  for (const [specifier, register] of [
    ["./cua.mjs", (m, ipc) => m.registerCuaIpc(ipc)],
    ["./updater.mjs", (m, ipc) => m.registerUpdaterIpc(ipc)],
  ]) {
    const mod = await import(new URL(specifier, mainUrl).href);
    register(mod, { handle: (channel) => record.handles.add(channel), on: (channel) => record.ons.add(channel) });
  }
  process.stdout.write("MURAGE_IPC_INVENTORY " + JSON.stringify({ ok: true, handles: [...record.handles], ons: [...record.ons] }) + "\n");
  process.exit(0);
} catch (error) {
  process.stdout.write("MURAGE_IPC_INVENTORY " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }) + "\n");
  process.exit(1);
}
`;

/** Channels android-device.mjs registers through registerIpc(ipcMain) (needs a live controller, so read from source). */
function androidChannels(electronDir) {
  const source = fs.readFileSync(path.join(electronDir, "android-device.mjs"), "utf8");
  return [...source.matchAll(/\bipcMain\.handle\(\s*"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * @param {{ electronDir?: string, env?: Record<string, string> }} [options]
 * @returns {{ handles: string[], ons: string[] }} sorted channel names main registers with this tree
 */
export function loadIpcInventory({ electronDir = here, env = {} } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murage-ipc-inventory-")));
  try {
    const home = path.join(scratch, "home");
    const userData = path.join(scratch, "user-data");
    const dataDir = path.join(scratch, "data");
    for (const directory of [home, userData, dataDir]) fs.mkdirSync(directory, { recursive: true });
    const paths = { home, userData, sessionData: userData, logs: path.join(userData, "logs"), temp: scratch,
      appData: scratch, downloads: scratch, desktop: scratch, documents: scratch, exe: process.execPath };
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (key.startsWith("MURAGE_") || key.startsWith("ELECTRON_")) delete environment[key];
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: scratch, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment, ...env, HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: dataDir, MURAGE_USER_DATA: userData,
        MURAGE_TEST_MAIN_URL: pathToFileURL(path.join(electronDir, "main.mjs")).href,
        MURAGE_TEST_ELECTRON_EXPORTS: JSON.stringify(electronNamedImports(electronDir)),
        MURAGE_TEST_ELECTRON_PATHS: JSON.stringify(paths),
      },
    });
    if (result.error) throw result.error;
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("MURAGE_IPC_INVENTORY "));
    if (!line) throw new Error(`main.mjs produced no inventory (status ${result.status}):\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(line.slice("MURAGE_IPC_INVENTORY ".length));
    if (!report.ok) throw new Error(report.error);
    const handles = new Set([...report.handles, ...androidChannels(electronDir)]);
    return { handles: [...handles].sort(), ons: [...new Set(report.ons)].sort() };
  } finally {
    safeWipeSync(scratch);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : here;
  process.stdout.write(`${JSON.stringify(loadIpcInventory({ electronDir: dir }), null, 2)}\n`);
}
