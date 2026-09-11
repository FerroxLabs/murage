// Guards the desktop main module against load-time breakage that no other
// test reaches: electron/*.mjs is not typechecked, and the handler tests import
// their factories directly instead of loading main.mjs. A missing import of a
// factory used in a top-level ipcMain.handle(...) makes the whole main module
// throw at load, so the app starts with no window and no IPC.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function mainProcessModules() {
  return fs.readdirSync(electronDir)
    .filter((name) => /\.(mjs|cjs)$/.test(name))
    .filter((name) => !/\.(node-)?test\.mjs$/.test(name) && !/\.electron-smoke\.mjs$/.test(name))
    .sort()
    .map((name) => path.join(electronDir, name));
}

test("every electron main-process module references only defined identifiers", () => {
  const oxlint = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "murage-main-undef-"));
  try {
    const config = path.join(scratch, "no-undef.json");
    fs.writeFileSync(config, JSON.stringify({
      env: { node: true, es2024: true },
      rules: { "no-undef": "error" },
    }));
    const files = mainProcessModules();
    assert.ok(files.some((file) => path.basename(file) === "main.mjs"), "main.mjs must be linted");
    const result = spawnSync(process.execPath, [
      oxlint, "-c", config, "--disable-nested-config", "-A", "all", "-D", "no-undef", "--format", "json", ...files,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, String(result.error));
    const report = JSON.parse(result.stdout);
    const undefinedNames = report.diagnostics.map((item) =>
      `${path.relative(electronDir, item.filename)}:${item.labels?.[0]?.span?.line}: ${item.message}`);
    assert.deepEqual(undefinedNames, []);
    assert.equal(report.number_of_files, files.length);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function electronNamedImports() {
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

// The child replaces only the "electron" module. Every API is an inert,
// callable stand-in, except the two surfaces this test observes: ipcMain
// records its channels and app.whenReady never resolves, so nothing past
// module evaluation (windows, servers, helpers, leases) runs.
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
      "const record = globalThis.__murageElectronStub;",
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
      "  whenReady: () => { record.whenReady = true; return new Promise(() => {}); },",
      "}, { get(target, key) { return key in target ? target[key] : key === 'then' ? undefined : inert('app.' + String(key)); } });",
      "export const ipcMain = {",
      "  handle(channel, listener) { record.handle.push([channel, typeof listener]); },",
      "  on(channel, listener) { record.on.push([channel, typeof listener]); },",
      "  once(channel, listener) { record.on.push([channel, typeof listener]); },",
      "  removeHandler() {}, removeListener() {}, removeAllListeners() {},",
      "};",
      ...lines,
      "export default { app, ipcMain, " + exportNames.filter((name) => name !== "app" && name !== "ipcMain").join(", ") + " };",
    ].join("\n") };
  },
});
globalThis.__murageElectronStub = { handle: [], on: [], whenReady: false };
try {
  await import(process.env.MURAGE_TEST_MAIN_URL);
  process.stdout.write("MURAGE_MAIN_LOAD " + JSON.stringify({ ok: true, ...globalThis.__murageElectronStub }) + "\n");
  process.exit(0);
} catch (error) {
  process.stdout.write("MURAGE_MAIN_LOAD " + JSON.stringify({ ok: false, error: String(error?.stack ?? error) }) + "\n");
  process.exit(1);
}
`;

test("main.mjs evaluates to app.whenReady and registers native file IPC handlers", () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "murage-main-load-")));
  try {
    const home = path.join(scratch, "home");
    const userData = path.join(scratch, "user-data");
    const dataDir = path.join(scratch, "data");
    for (const directory of [home, userData, dataDir]) fs.mkdirSync(directory, { recursive: true });
    const paths = { home, userData, sessionData: userData, logs: path.join(userData, "logs"), temp: scratch,
      appData: scratch, downloads: scratch, desktop: scratch, documents: scratch, exe: process.execPath };
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("MURAGE_") || key.startsWith("ELECTRON_")) delete environment[key];
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        HOME: home,
        USERPROFILE: home,
        MURAGE_DATA_DIR: dataDir,
        MURAGE_USER_DATA: userData,
        MURAGE_TEST_MAIN_URL: pathToFileURL(path.join(electronDir, "main.mjs")).href,
        MURAGE_TEST_ELECTRON_EXPORTS: JSON.stringify(electronNamedImports()),
        MURAGE_TEST_ELECTRON_PATHS: JSON.stringify(paths),
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("MURAGE_MAIN_LOAD "));
    assert.ok(line, `main.mjs load produced no report (status ${result.status}):\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(line.slice("MURAGE_MAIN_LOAD ".length));
    assert.equal(report.error, undefined);
    assert.equal(report.ok, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.whenReady, true, "module evaluation must reach app.whenReady()");
    const handlers = new Map(report.handle);
    for (const channel of [
      "desktop:save-file",
      "skill-recorder:save",
      "skill-recorder:start",
      "skill-recorder:stop",
      "speech:start",
      "speech:stop",
    ]) {
      assert.equal(handlers.get(channel), "function", `${channel} must register a handler function`);
    }
    assert.equal(report.handle.length, handlers.size, "no IPC channel may be registered twice");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
