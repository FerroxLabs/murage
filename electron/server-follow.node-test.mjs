// The window follows the engine to its new port (server-follow.mjs).
//
// The witness runs main.mjs's own supervisor, port loop, follow step and window
// swap (sliced out of main.mjs, as approval-notification-state.node-test.mjs
// does), with fakes only for Electron and for the fork: 2026-11-18, the engine
// died under load, a local program held 8799, the replacement came up on 18799
// and the window kept calling 8799.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { LAUNCH_HEADER, launchIdOf, openChatThread, restartedWindowTarget } from "./server-follow.mjs";
import { CRASH_WINDOW_MS, createServerSupervisor, exitCodeNote } from "./server-supervisor.mjs";

const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

/** One top-level function of main.mjs, or "" when this main.mjs has none. */
function slice(name) {
  for (const head of [`async function ${name}(`, `function ${name}(`]) {
    const start = MAIN.indexOf(`\n${head}`);
    if (start < 0) continue;
    const end = MAIN.indexOf("\n}\n", start);
    assert.ok(end > start, `${name} has an end`);
    return MAIN.slice(start + 1, end + 2);
  }
  return "";
}

class FakeWindow extends EventEmitter {
  constructor(origin) {
    super();
    this.origin = origin;
    this.loaded = [];
    this.destroyed = false;
  }
  loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  isVisible() { return true; }
  isFocused() { return true; }
  isMaximized() { return false; }
  show() {}
  focus() {}
  showInactive() {}
  hide() {}
  maximize() {}
}

/** The packaged main process at the moment its engine on 8799 dies. `held`
 *  names the ports another program answers on when the replacement starts. */
function packagedMain({ held }) {
  const logs = [];
  const windows = [];
  const engines = [];
  const scope = {
    console, Date, URL, Promise, WeakMap, Set, Error,
    // The gaps are the supervisor's business (server-supervisor.node-test.mjs); here every one is a turn of the loop.
    setTimeout: (fn) => { setImmediate(fn); return 0; },
    CRASH_WINDOW_MS,
    serverSupervisor: createServerSupervisor(),
    restartedWindowTarget,
    slog: (line) => logs.push(line),
    publishServerLifecycle: (state) => logs.push(`lifecycle ${state.state}`),
    attentionWiring: null, attentionMain: null, attentionSurfaces: null,
    mcpServers: { resume: async () => {} },
    assertDesktopStartupActive: () => {},
    app: { isPackaged: true },
    nativeTheme: { shouldUseDarkColors: false },
    splashPage: () => "data:text/html,reconnecting",
    RECONNECTING_LINE: "Reconnecting…",
    desktopShutdownStarted: false, quitRequested: false,
    serverRestarting: false, serverReady: true, serverStartConflictOnly: false,
    memoryUpgradeBlocked: null, serverStartSlow: false,
    pendingSwap: null, replacingMainWindow: false, lastWindowReplaceAt: 0,
    pendingRevealWindows: new Set(), maximizeOnShow: new Set(),
    backgroundLifecycle: null,
    openChat: null,
    FOLLOW_RETRIES: 10, FOLLOW_RETRY_MS: 1000,
    SERVER_PORT: 8799,
    serverLaunchId: launchIdOf("nonce-first"),
    // The fork. startServerOn's refusal of a port another program holds is the real one's ("foreign-owner").
    startServerOn: async (port) => {
      if (held.includes(port)) { logs.push(`port ${port} is in use by another process; not starting the server there`); return { proc: null, reason: "foreign-owner" }; }
      const proc = new EventEmitter();
      engines.push({ port, proc });
      return { proc, lifecycle: {}, launch: launchIdOf(`nonce-${port}`) };
    },
    // createWindow's contract: a window is created for the origin the engine has NOW (its preload bridge
    // belongs to that origin), and it opens the given URL only on that origin.
    createWindow: ({ url = null } = {}) => {
      const origin = `http://127.0.0.1:${scope.SERVER_PORT}`;
      const win = new FakeWindow(origin);
      windows.push(win);
      win.murageRendererOrigin = origin;
      scope.mainWindow = win;
      win.loadURL(url && new URL(url).origin === origin ? url : origin);
      setImmediate(() => win.emit("ready-to-show"));
      return win;
    },
  };
  vm.createContext(scope);
  for (const name of ["superviseServerChild", "startServerPackaged", "followRestartedServer", "replaceMainWindow"]) {
    const source = slice(name);
    if (source) vm.runInContext(source, scope);
  }
  const first = new FakeWindow("http://127.0.0.1:8799");
  first.loadURL("http://127.0.0.1:8799");
  windows.push(first);
  first.murageRendererOrigin = first.origin;
  scope.mainWindow = first;
  const engine = new EventEmitter();
  scope.serverProc = engine;
  vm.runInContext("superviseServerChild(serverProc, { stopRequested: false })", scope);
  return { scope, logs, windows, engines, first, engine };
}

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("WITNESS 2026-11-18: 8799 taken during the restart: the chat loads from the replacement on 18799, never from 8799", async () => {
  const main = packagedMain({ held: [8799] });
  main.scope.openChat = "thread-alpha";
  const before = main.first.loaded.length;
  main.engine.emit("exit", 6);
  await settle();

  assert.equal(main.scope.SERVER_PORT, 18799, "the replacement came up on 18799");
  const win = main.scope.mainWindow;
  assert.notEqual(win, main.first, "a window created for 18799 replaced the 8799 one");
  assert.equal(win.murageRendererOrigin, "http://127.0.0.1:18799", "its bridge belongs to the new origin");
  assert.deepEqual(win.loaded, ["http://127.0.0.1:18799/#open=thread-alpha"], "it opens the chat that was open");
  assert.equal(main.first.destroyed, true, "the window on the dead origin is gone");
  assert.deepEqual(main.first.loaded.slice(before), [], "nothing was loaded from 8799 after the engine died");
  for (const w of main.windows) for (const url of w.loaded.slice(w === main.first ? before : 0)) assert.ok(!url.startsWith("http://127.0.0.1:8799"), url);
  assert.equal(main.scope.serverLaunchId, launchIdOf("nonce-18799"), "the renderer is told the replacement's launch id");
});

test("a replacement on the same port reloads the window, so its preload reads the new launch's proof", async () => {
  const main = packagedMain({ held: [] });
  main.scope.openChat = "thread-beta";
  main.engine.emit("exit", 1);
  await settle();
  assert.equal(main.scope.SERVER_PORT, 8799);
  assert.equal(main.scope.mainWindow, main.first, "same origin: the same window");
  assert.equal(main.first.loaded.at(-1), "http://127.0.0.1:8799/#open=thread-beta");
  assert.equal(main.scope.serverLaunchId, launchIdOf("nonce-8799"));
});

test("a swap that cannot happen yet shows the reconnecting page, never the dead origin, and tries again", async () => {
  const main = packagedMain({ held: [8799] });
  const retries = [];
  // The follow step's one-second retry is held back by hand; every other gap is a turn of the loop.
  main.scope.setTimeout = (fn, ms) => { if (ms === main.scope.FOLLOW_RETRY_MS) retries.push(fn); else setImmediate(fn); return 0; };
  main.scope.pendingSwap = {}; // another swap is in flight
  main.engine.emit("exit", 6);
  await settle();
  assert.equal(main.scope.mainWindow, main.first);
  assert.equal(main.first.loaded.at(-1), "data:text/html,reconnecting");
  assert.equal(retries.length, 1, "one retry is due");
  main.scope.pendingSwap = null;
  retries.shift()();
  await settle();
  assert.deepEqual(main.scope.mainWindow.loaded, ["http://127.0.0.1:18799/"]);
  assert.equal(main.scope.mainWindow.murageRendererOrigin, "http://127.0.0.1:18799");
});

test("createWindow opens a follow URL only on its own origin, and records that origin", () => {
  const body = slice("createWindow");
  assert.match(body, /const rendererOrigin = trustedRendererOrigin\(\);/);
  assert.match(body, /rendererOriginArguments\(trustedRendererOrigin\(\)\)/); // the same value, read in the same turn
  assert.match(body, /win\.murageRendererOrigin = rendererOrigin;/);
  assert.match(body, /url && new URL\(url\)\.origin === rendererOrigin \? url :/);
  assert.match(slice("replaceMainWindow"), /createWindow\(\{ quiet: true, url \}\)/);
});

test("restartedWindowTarget: replace across origins, reload on the same one, the chat through #open=", () => {
  assert.deepEqual(restartedWindowTarget({ windowOrigin: "http://127.0.0.1:8799", serverOrigin: "http://127.0.0.1:18799", openThread: "t-1" }),
    { mode: "replace", url: "http://127.0.0.1:18799/#open=t-1" });
  assert.deepEqual(restartedWindowTarget({ windowOrigin: "http://127.0.0.1:8799", serverOrigin: "http://127.0.0.1:8799", openThread: null }),
    { mode: "reload", url: "http://127.0.0.1:8799/" });
  assert.deepEqual(restartedWindowTarget({ windowOrigin: undefined, serverOrigin: "http://127.0.0.1:8799", openThread: "x".repeat(513) }),
    { mode: "replace", url: "http://127.0.0.1:8799/" });
  assert.equal(openChatThread(""), null);
  assert.equal(openChatThread(7), null);
  assert.equal(openChatThread("t-2"), "t-2");
});

test("the launch id is the SHA-256 of the nonce, as server/memory/boot-nonce.ts computes it", () => {
  assert.equal(LAUNCH_HEADER, "x-murage-launch");
  assert.equal(launchIdOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const nonceSource = readFileSync(new URL("../server/memory/boot-nonce.ts", import.meta.url), "utf8");
  assert.match(nonceSource, /const launch = createHash\("sha256"\)\.update\(nonce\)\.digest\("hex"\);/);
  const serverSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const handler = serverSource.slice(serverSource.indexOf("const server = createServer((req, res) => {"));
  assert.match(handler.slice(0, 600), /res\.setHeader\("x-murage-launch", bootLaunchId\(\)\);/, "every answer carries it, first thing in the handler");
});

test("exit code 6 is logged as SIGABRT on macOS and Linux", () => {
  assert.match(exitCodeNote(6, "darwin"), /SIGABRT/);
  assert.match(exitCodeNote(6, "linux"), /SIGABRT/);
  assert.equal(exitCodeNote(6, "win32"), "");
  assert.equal(exitCodeNote(1, "darwin"), "");
});
