import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { updater, handlers } = vi.hoisted(() => ({
  updater: { on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
  handlers: new Map(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-updater-fixture" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
}));
vi.mock("node:module", () => ({ createRequire: () => () => ({ autoUpdater: updater }) }));
vi.mock("./package-install-command.mjs", async (original) => ({
  ...await original(), linuxPackageType: () => null,
}));

const emit = (event, payload) => {
  for (const [name, listener] of updater.on.mock.calls) if (name === event) listener(payload);
};
const fakeDownload = () => updater.downloadUpdate.mockImplementation(async () => {
  emit("download-progress", { percent: 50 });
  emit("update-downloaded", { version: "2.0.0" });
  return ["/unused-staged-update.zip"];
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  vi.useFakeTimers();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("retargets progress and retained state without adding updater listeners or timers", async () => {
  const api = await import("./updater.mjs");
  const first = { webContents: { send: vi.fn() } };
  const reopened = { webContents: { send: vi.fn() } };
  api.attachUpdaterWindow(first);
  api.registerUpdaterIpc();
  api.startUpdater();
  const listeners = updater.on.mock.calls.length;
  const timers = vi.getTimerCount();
  first.webContents.send.mockClear();
  first.webContents.send.mockImplementation(() => { throw new Error("window destroyed"); });
  api.attachUpdaterWindow(reopened);
  fakeDownload();
  await handlers.get("update:download")();
  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send.mock.calls.map(([, state]) => state.status))
    .toEqual(["downloading", "downloading", "downloaded"]);
  expect(handlers.get("update:get-state")()).toMatchObject({ status: "downloaded", version: "2.0.0" });
  // An accidental repeat start must not erase a staged update or duplicate
  // process-owned listeners and polling timers.
  api.startUpdater();
  expect(updater.on.mock.calls).toHaveLength(listeners);
  expect(vi.getTimerCount()).toBe(timers);
  expect(handlers.get("update:get-state")().status).toBe("downloaded");
});

it("the actual main createWindow and activate wiring retargets the process updater", async () => {
  const api = await import("./updater.mjs");
  api.registerUpdaterIpc();
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const file = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const nodes = [];
  const walk = (node) => { nodes.push(node); ts.forEachChild(node, walk); };
  walk(file);
  const windowFactory = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow");
  const ready = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(file) === "app.whenReady().then");
  const activate = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(file) === "app.on"
    && node.arguments[0]?.text === "activate" && node.pos >= ready.pos && node.end <= ready.end);
  const startup = ready.arguments[0].body.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) =>
      declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(file) === "createWindow");
    return ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && ["createWindow", "startUpdater"].includes(statement.expression.expression.getText(file));
  });
  const liveWindows = [];
  class Window {
    constructor() {
      liveWindows.push(this);
      this.webContents = { send: vi.fn(), on: vi.fn(), once: vi.fn(), setWindowOpenHandler: vi.fn() };
      this.once = vi.fn((event, listener) => { if (event === "closed") this.onClosed = listener; });
      this.loadURL = vi.fn();
    }
    close() { liveWindows.splice(liveWindows.indexOf(this), 1); this.onClosed?.(); }
    static getAllWindows() { return liveWindows; }
  }
  // Bind only the updater imports present in real main.mjs: omitting the
  // attachment import/call or losing startup wiring must fail this execution.
  const updaterImport = file.statements.find((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "./updater.mjs");
  const bindings = Object.fromEntries(updaterImport.importClause.namedBindings.elements.map((entry) =>
    [entry.name.text, api[entry.propertyName?.text ?? entry.name.text]]));
  const context = vm.createContext({
    ...bindings, BrowserWindow: Window, mainWindow: null, persistedSkin: null,
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    resolveWindowState: () => ({ bounds: {}, maximized: false }), readWindowState: () => null,
    readPersistedSkin: () => null, nativeTheme: { shouldUseDarkColors: true },
    APP_ICON: "fixture", skinChrome: () => ({ color: "#000000" }), windowChromeOptions: () => ({}),
    process: { platform: "darwin", env: {} }, path, __dirname: "/unused-fixture",
    startBrowserSurface: vi.fn(), installWindowStatePersistence: vi.fn(), applyUnreadBadge: vi.fn(),
    app: { isPackaged: true }, serverReady: true, SERVER_PORT: 18888, desktopShutdownStarted: false, desktopRecoveryMode: false,
  });
  vm.runInContext(windowFactory.getText(file), context);
  vm.runInContext(startup.map((node) => node.getText(file)).join("\n"), context);
  expect(liveWindows).toHaveLength(1);
  expect(updater.on.mock.calls.length).toBeGreaterThan(0);
  const first = liveWindows[0];
  const listeners = updater.on.mock.calls.length;
  const timers = vi.getTimerCount();
  first.webContents.send.mockClear();
  first.close();
  vm.runInContext(`(${activate.arguments[1].getText(file)})()`, context);
  expect(liveWindows).toHaveLength(1);
  const reopened = liveWindows[0];
  expect(reopened).not.toBe(first);
  fakeDownload();
  await handlers.get("update:download")();
  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send).toHaveBeenCalledWith("update:state", expect.objectContaining({ status: "downloaded" }));
  expect(updater.on.mock.calls).toHaveLength(listeners);
  expect(vi.getTimerCount()).toBe(timers);
  reopened.close();
  context.desktopShutdownStarted = true;
  vm.runInContext(`(${activate.arguments[1].getText(file)})()`, context);
  expect(liveWindows).toHaveLength(0);
});


it("a retry clears the old percentage before the next progress event", async () => {
  const api = await import("./updater.mjs");
  api.registerUpdaterIpc();
  api.startUpdater();
  updater.downloadUpdate.mockImplementationOnce(async () => {
    emit("download-progress", { percent: 87 });
    throw new Error("connection reset");
  });
  await handlers.get("update:download")();
  expect(handlers.get("update:get-state")()).toMatchObject({ status: "error", percent: 87 });
  let resolve;
  updater.downloadUpdate.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const retry = handlers.get("update:retry")();
  expect(handlers.get("update:get-state")()).toMatchObject({ status: "downloading" });
  expect(handlers.get("update:get-state")().percent).toBeUndefined();
  expect(handlers.get("update:get-state")().message).toBeUndefined();
  emit("update-downloaded", { version: "2.0.0" });
  resolve(["/unused-staged-update.zip"]);
  await retry;
  expect(handlers.get("update:get-state")().status).toBe("downloaded");
});
