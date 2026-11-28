import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackgroundLifecycle } from "./background-lifecycle.mjs";

const { updater, handlers, fixturePath, netFetch, ringFeedOptions } = vi.hoisted(() => ({
  netFetch: vi.fn(async () => new Response("")), ringFeedOptions: [],
  fixturePath: { root: "" },
  updater: { on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn() },
  handlers: new Map(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => fixturePath.root, getVersion: () => "9.8.7-fixture" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  net: { fetch: netFetch },
}));
vi.mock("node:module", () => ({ createRequire: () => () => ({ autoUpdater: updater }) }));
vi.mock("./package-install-command.mjs", async (original) => ({
  ...await original(), linuxPackageType: () => null,
}));
// These tests exercise window/state ownership on every host. The Linux
// publisher verifier and the macOS/Windows signed-build version check have
// their own fixtures (update-signature / update-build-version node tests).
const { downloadVerifier } = vi.hoisted(() => ({ downloadVerifier: { create: null } }));
// These rows predate rings (designs/RINGS-DESIGN.md) and run with no ring feed, as updater-staging.node-test.mjs does; the
// ring step and its install admission are witnessed through the same coordinator in updater-rings.node-test.mjs.
vi.mock("./updater-rings.mjs", async (original) => ({ ...(await original()), createRingFeed: (_updater, options) => { ringFeedOptions.push(options); return null; } }));
vi.mock("./update-build-version.mjs", () => ({
  createUpdateDownloadVerifier: (options) => downloadVerifier.create?.(options) ?? (async () => ({ recheck: async () => {} })),
}));

const emit = (event, payload) => {
  for (const [name, listener] of updater.on.mock.calls) if (name === event) listener(payload);
};
const fakeDownload = () => updater.downloadUpdate.mockImplementation(async () => {
  emit("download-progress", { percent: 50 });
  emit("update-downloaded", { version: "2.0.0" });
  return ["/unused-staged-update.zip"];
});

function registerMainNotice(ipcMain, reportUpdateNotice) {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const registration = source.match(/^ipcMain\.handle\("update:notice-report".*$/m)?.[0];
  expect(registration, 'main must register notice reports through its owned IPC gate').toBeDefined();
  vm.runInNewContext(registration, { ipcMain, reportUpdateNotice });
}

beforeEach(async () => {
  fixturePath.root = mkdtempSync(path.resolve(".updater-notify-fixture-"));
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  vi.useFakeTimers();
  const api = await import("./updater.mjs");
  registerMainNotice({ handle: (channel, listener) => handlers.set(channel, listener) }, api.reportUpdateNotice);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); rmSync(fixturePath.root, { recursive: true, force: true }); });

// Fable 6cdb66fe4b M3: the ring manifest and install-admission lookups go through Electron's network stack (system
// proxy), not Node's fetch, so a proxy-only machine is not refused every install.
it("the desktop ring feed fetches through Electron net, with the caller's request options", async () => {
  const api = await import("./updater.mjs");
  api.startUpdater({ scheduleChecks: false });
  const options = ringFeedOptions.at(-1);
  expect(typeof options?.fetchImpl).toBe("function");
  const init = { credentials: "omit", redirect: "manual" };
  await options.fetchImpl("https://raw.githubusercontent.com/fixture/rings.json", init).catch(() => undefined); // Node fetch has no network here
  expect(netFetch).toHaveBeenCalledWith("https://raw.githubusercontent.com/fixture/rings.json", init);
});

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

it("every state the renderer sees names the version that is running", async () => {
  // Linux has no About panel, so Settings → Updates is the one place a person
  // can read the version; it must come from the app itself, not the feed.
  const api = await import("./updater.mjs");
  const window = { webContents: { send: vi.fn() } };
  api.attachUpdaterWindow(window);
  api.registerUpdaterIpc();
  expect(handlers.get("update:get-state")()).toMatchObject({ currentVersion: "9.8.7-fixture" });
  api.startUpdater();
  fakeDownload();
  await handlers.get("update:download")();
  const sent = window.webContents.send.mock.calls.map(([, state]) => state);
  expect(sent.length).toBeGreaterThan(0);
  for (const state of sent) expect(state.currentVersion).toBe("9.8.7-fixture");
  expect(handlers.get("update:get-state")()).toMatchObject({ status: "downloaded", version: "2.0.0", currentVersion: "9.8.7-fixture" });
});

it.each(["darwin", "win32"])("%s: every download goes through the signed-build check, so a rollback feed never reaches downloaded", async (platform) => {
  // The feed file is unsigned: a latest*.yml naming a higher version can point at an older signed build. Before 1.0.4
  // only Linux checked a download against anything signed; macOS and Windows staged whatever the feed named.
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  const created = [];
  downloadVerifier.create = (options) => {
    created.push(options);
    return async () => { throw Object.assign(new Error("This update could not be verified, so Murage did not install it."), { code: "ERR_MURAGE_UPDATE_VERIFICATION" }); };
  };
  try {
    const api = await import("./updater.mjs");
    api.registerUpdaterIpc();
    api.startUpdater();
    fakeDownload();
    await handlers.get("update:download")();
    expect(created).toEqual([expect.objectContaining({ currentVersion: "9.8.7-fixture" })]);
    expect(handlers.get("update:get-state")().status).toBe("error");
  } finally {
    downloadVerifier.create = null;
    Object.defineProperty(process, "platform", original);
  }
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
  // main.mjs has two ready callbacks: a small one that only wires powerMonitor for the upgrade screen, and the boot block that opens the window.
  const ready = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(file) === "app.whenReady().then"
    && node.arguments[0]?.getText(file).includes("createWindow"));
  const activate = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(file) === "app.on"
    && node.arguments[0]?.text === "activate" && node.pos >= ready.pos && node.end <= ready.end);
  // Since the startup background controls (5b140c4f) the first window is
  // created from an if/else — the tray lifecycle reopens an existing window,
  // otherwise createWindow runs — and "activate" no longer calls createWindow
  // itself: it asks the lifecycle to open, whose `openWindow` callback is the
  // one that creates a window when none is alive. Both shapes are admitted
  // here, and nothing else is: a call to createWindow tucked inside any other
  // statement is still a lost wiring, and fails this execution.
  const calls = (statement, names) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && names.includes(statement.expression.expression.getText(file));
  const startup = ready.arguments[0].body.statements.filter((statement) => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) =>
      declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(file) === "createWindow");
    if (ts.isIfStatement(statement)) return [statement.thenStatement, statement.elseStatement].some((branch) => branch && calls(branch, ["createWindow"]));
    return calls(statement, ["createWindow", "ensureDesktopUpdater"]);
  });
  expect(startup.map((node) => node.getText(file).split("(")[0])).toEqual(["if", "ensureDesktopUpdater"]);
  const updaterFactory = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ensureDesktopUpdater");
  expect(updaterFactory).toBeDefined();
  // The real `openWindow` callback main.mjs hands the lifecycle, so "activate"
  // reaches the real createWindow through the real background-lifecycle
  // module rather than a stand-in that agrees with it by construction.
  const lifecycleFactory = nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "initializeBackgroundLifecycle");
  const openWindow = nodes.find((node) => ts.isPropertyAssignment(node) && node.name.getText(file) === "openWindow"
    && node.pos >= lifecycleFactory.pos && node.end <= lifecycleFactory.end);
  const liveWindows = [];
  class Window {
    constructor() {
      liveWindows.push(this);
      this.webContents = { send: vi.fn(), on: vi.fn(), once: vi.fn(), setWindowOpenHandler: vi.fn() };
      this.once = vi.fn((event, listener) => { if (event === "closed") this.onClosed = listener; });
      this.on = vi.fn();
      this.loadURL = vi.fn();
      this.destroyed = false;
      this.isDestroyed = () => this.destroyed;
      this.isMinimized = () => false;
      this.isVisible = () => !this.destroyed;
      this.restore = vi.fn(); this.show = vi.fn(); this.focus = vi.fn();
    }
    close() { this.destroyed = true; liveWindows.splice(liveWindows.indexOf(this), 1); this.onClosed?.(); }
    static getAllWindows() { return liveWindows; }
  }
  // Bind only the updater imports present in real main.mjs: omitting the
  // attachment import/call or losing startup wiring must fail this execution.
  const updaterImport = file.statements.find((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "./updater.mjs");
  const bindings = Object.fromEntries(updaterImport.importClause.namedBindings.elements.map((entry) =>
    [entry.name.text, api[entry.propertyName?.text ?? entry.name.text]]));
  const notices = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); notices.push(this); }
    show() {}
  }
  const context = vm.createContext({
    Notification, notificationAuthorization: { current: async () => ({ authorized: true }) }, powerMonitor: { on: vi.fn() },
    ...bindings, BrowserWindow: Window, mainWindow: null, persistedSkin: null, desktopUpdater: null,
    screen: { getPrimaryDisplay: () => ({ id: 1, workArea: {} }), getAllDisplays: () => [] },
    resolveWindowState: () => ({ bounds: {}, maximized: false }), readWindowState: () => null,
    readPersistedSkin: () => null, nativeTheme: { shouldUseDarkColors: true },
    APP_ICON: "fixture", skinChrome: () => ({ color: "#000000" }), windowChromeOptions: () => ({}),
    process: { platform: "darwin", env: {} }, path, __dirname: "/unused-fixture",
    startBrowserSurface: vi.fn(), installWindowStatePersistence: vi.fn(), applyUnreadBadge: vi.fn(),
    createMacInstallerFallback:()=>({peekPendingOffer:()=>null}),returnAuthority:{generation:0,userQuitRequested:false},backupScheduleHost:null,
    app: { isPackaged: true, getPath:()=>"/unused-fixture" }, serverReady: true, SERVER_PORT: 18888, desktopShutdownStarted: false, desktopRecoveryMode: false,
    backgroundLifecycle: null, loginLaunch: false, background: null,
    cloudHome: null, // Cloud flag off: createWindow passes --murage-cloud=1 only when installCloudHome returned a controller
    // createWindow now closes the startup splash (4931ea16d); the fixture has none to close.
    closeStartupSplash: vi.fn(), startupSplash: null, desktopMark: vi.fn(), noteVersionStarted: vi.fn(),
    rendererSessions: { track: vi.fn() }, osShell: { openExternal: vi.fn(), openPath: vi.fn() }, LOG_DIR: "/unused-log-dir", pathToFileURL: (value) => new URL(`file://${value}`),
    createMainWindowOpenHandler: () => vi.fn(), createMainNavigationGuard: () => ({ willNavigate: vi.fn(), willRedirect: vi.fn() }),
    trustedRendererOrigin: () => "http://127.0.0.1:18888", rendererOriginArguments: () => [], deliverPackageInstall: vi.fn(), appReadiness: { track: vi.fn() }, lastErrorPageUrl: null,
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    createRendererRecovery: () => ({ onGone: async () => "ignored" }), attachLoadFailureRecovery: () => ({}), loadFailureRecoveries: new WeakMap(), splashPage: () => "data:,", RECONNECTING_LINE: "Reconnecting",
    // Module state the lane's startup reveal (pendingRevealWindows, 15 s fallback) reads.
    pendingSwap: null, replacingMainWindow: false, pendingRevealWindows: new WeakSet(), maximizeOnShow: new WeakSet(), WINDOW_REVEAL_FALLBACK_MS: 15000, setTimeout: () => ({ unref() {} }),
    serverLifecycleState: { state: "running" }, startupSplash: null, closeStartupSplash: vi.fn(), slog: vi.fn(), showDesktopRecovery: vi.fn(), desktopMark: vi.fn(),
    rendererSessions: { track: vi.fn(), current: () => null, hello: vi.fn(), check: vi.fn() },
  });
  vm.runInContext(windowFactory.getText(file), context);
  vm.runInContext(updaterFactory.getText(file), context);
  context.backgroundLifecycle = createBackgroundLifecycle({
    platform: "darwin", loadPreferences: () => ({}), window: () => context.mainWindow, isQuitting: () => context.desktopShutdownStarted,
    login: { read: () => ({ supported: false, openAtLogin: false }) }, openWindow: vm.runInContext(`(${openWindow.initializer.getText(file)})`, context),
  });
  context.background = { lifecycle: context.backgroundLifecycle };
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
  // Exercise notification activation through ensureDesktopUpdater's actual
  // ensureWindow callback, lifecycle.open and createWindow, with a NEW window.
  reopened.close();
  await handlers.get("update:notice-report")({}, { version: "2.0.0", dismissed: false, title: "Ready" });
  expect(notices).toHaveLength(1);
  notices[0].emit('click');
  expect(liveWindows).toHaveLength(1);
  const activated = liveWindows[0];
  expect(activated).not.toBe(reopened);
  expect(reopened.isDestroyed()).toBe(true);
  expect(activated.focus).toHaveBeenCalled();
  expect(activated.webContents.send).toHaveBeenCalledWith('update:state', expect.objectContaining({ status: 'downloaded' }));
  expect(activated.webContents.send).toHaveBeenCalledWith('update:notice', '2.0.0');
  activated.close();
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

it("routes native focus, wake and trusted renderer reports through the owned updater", async () => {
  const { EventEmitter } = await import("node:events");
  const api = await import("./updater.mjs");
  const powerMonitor = new EventEmitter();
  const win = new EventEmitter();
  Object.assign(win, { webContents: { send: vi.fn() }, isDestroyed: () => false,
    isVisible: () => false, isFocused: () => false });
  const shown = vi.fn();
  class Notification extends EventEmitter { static isSupported() { return true; } show() { shown(); } }
  api.attachUpdaterWindow(win);
  api.registerUpdaterIpc();
  api.startUpdater({ scheduleChecks: false, notificationServices: {
    Notification, powerMonitor, authorization: { current: async () => ({ authorized: true }) },
  } });
  fakeDownload();
  await handlers.get("update:download")();
  await handlers.get("update:notice-report")({}, { version: "2.0.0", dismissed: false, title: "Murage 2.0.0 is ready to install" });
  expect(shown).toHaveBeenCalledOnce();
  win.emit("focus");
  expect(win.webContents.send).toHaveBeenCalledWith("update:notice", "2.0.0");
  win.webContents.send.mockClear();
  powerMonitor.emit("resume");
  expect(win.webContents.send).toHaveBeenCalledWith("update:notice", "2.0.0");
  const replacement = new EventEmitter();
  api.attachUpdaterWindow(replacement);
  expect(win.listenerCount("focus")).toBe(0);
  expect(replacement.listenerCount("focus")).toBe(1);
});

it("never starts the updater or notification service in either store build", async () => {
  for (const key of ["mas", "windowsStore"]) {
    vi.resetModules();
    const previous = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { value: true, configurable: true });
    try {
      const api = await import("./updater.mjs");
      expect(api.startUpdater({ scheduleChecks: false })).toBeUndefined();
      expect(updater.on).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(process, key, previous);
      else delete process[key];
    }
  }
});

it('every wake refreshes a missed failure even while a silent check is pending and throttled', async () => {
  const { EventEmitter } = await import('node:events');
  const api = await import('./updater.mjs');
  const powerMonitor = new EventEmitter();
  const win = { webContents: { send: vi.fn() } };
  api.attachUpdaterWindow(win); api.registerUpdaterIpc();
  api.startUpdater({ scheduleChecks: false, notificationServices: {
    Notification: { isSupported: () => false }, authorization: {}, powerMonitor,
  } });
  let finish;
  updater.checkForUpdates.mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const pending = handlers.get('update:check')();
  updater.downloadUpdate.mockImplementationOnce(async () => { throw Error('lost download'); });
  await handlers.get('update:download')();
  expect(handlers.get('update:get-state')().status).toBe('error');
  win.webContents.send.mockClear();
  powerMonitor.emit('resume'); powerMonitor.emit('resume');
  expect(win.webContents.send.mock.calls).toEqual([
    ['update:state', expect.objectContaining({ status: 'error' })],
    ['update:state', expect.objectContaining({ status: 'error' })],
  ]);
  finish(null); await pending;
});

it.each(['blur', 'hide', 'minimize'])('focused readiness retries on %s and detaches every listener', async (event) => {
  const api = await import('./updater.mjs');
  const win = new EventEmitter();
  Object.assign(win, { webContents: { send: vi.fn() }, isDestroyed: () => false,
    isVisible: () => true, isFocused: () => true, isMinimized: () => false });
  const shown = vi.fn();
  class Notification extends EventEmitter { static isSupported() { return true; } show() { shown(); } }
  api.attachUpdaterWindow(win); api.registerUpdaterIpc();
  api.startUpdater({ scheduleChecks: false, notificationServices: {
    Notification, powerMonitor: new EventEmitter(), authorization: { current: async () => ({ authorized: true }) },
  } });
  fakeDownload(); await handlers.get('update:download')();
  await handlers.get('update:notice-report')({}, { version: '2.0.0', title: 'Ready', dismissed: false });
  expect(shown).not.toHaveBeenCalled();
  if (event === 'blur') win.isFocused = () => false;
  if (event === 'hide') win.isVisible = () => false;
  if (event === 'minimize') win.isMinimized = () => true;
  win.emit(event); await Promise.resolve(); await Promise.resolve();
  expect(shown).toHaveBeenCalledOnce();
  for (const name of ['blur', 'hide', 'minimize']) win.emit(name);
  await Promise.resolve(); expect(shown).toHaveBeenCalledOnce();
  const replacement = new EventEmitter(); api.attachUpdaterWindow(replacement);
  for (const name of ['focus', 'blur', 'hide', 'minimize']) {
    expect(win.listenerCount(name)).toBe(0);
    expect(replacement.listenerCount(name)).toBe(1);
  }
});

it('refuses foreign update notice reports before reading their payload', async () => {
  const { createOwnedMainIpc, OWNED_MAIN_IPC_REFUSAL } = await import('./main-ipc-trust.mjs');
  const api = await import('./updater.mjs');
  api.startUpdater({ scheduleChecks: false, notificationServices: {
    Notification: { isSupported: () => true }, authorization: {}, powerMonitor: new EventEmitter(), ensureWindow() {},
  } });
  registerMainNotice(createOwnedMainIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, isTrusted: () => false,
  }), api.reportUpdateNotice);
  const read = vi.fn(() => { throw Error('listener read payload'); });
  const payload = Object.defineProperty({}, 'version', { get: read });
  await expect(handlers.get('update:notice-report')({}, payload)).rejects.toMatchObject({ code: OWNED_MAIN_IPC_REFUSAL });
  expect(read).not.toHaveBeenCalled();
});

// fablehunt-1020q item 9: the launch pause main.mjs registers at startup is the one the install uses.
it("the registered launch pause takes the timed jobs down before quitAndInstall", async () => {
  const api = await import("./updater.mjs");
  const order = [];
  api.useUpdateLaunchPause({ pause: () => { order.push("pause"); }, resume: () => { order.push("resume"); } });
  api.registerUpdaterIpc();
  api.startUpdater();
  fakeDownload();
  await handlers.get("update:download")();
  updater.quitAndInstall = vi.fn(() => { order.push("quitAndInstall"); });
  await handlers.get("update:install")();
  expect(order).toEqual(["pause", "quitAndInstall"]);
});
