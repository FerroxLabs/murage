// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// retains the downloaded ZIP until the explicit install starts native staging.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, clipboard, ipcMain as electronIpcMain, net } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { createUpdateDownloadVerifier } from "./update-build-version.mjs";
import { createGithubFallbackFeed } from "./updater-fallback.mjs";
import { createRingFeed, createRingMembership, readGetUpdatesEarly, writeGetUpdatesEarly } from "./updater-rings.mjs";
import { verifyDetachedSignature } from "./update-signature.mjs";
import { installWindowsUpdateVerifier } from "./windows-update-signature.mjs";

import { createUpdateNotifications, updateNotificationsEnabled } from "./update-notifications.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle" };
let updaterCoordinator = null;
let checksScheduled = false;
let notifications = null;
const onWindowFocus = () => {
  try { win?.webContents?.send("update:state", publicState()); } catch { /* window gone */ }
  notifications?.focus();
};

const onWindowBackground = () => { void notifications?.stateChanged(); };

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

// A system package is the distro's to install, not ours. Left to
// electron-updater, a .deb update raises a polkit root prompt out of a chat
// app, runs `dpkg -i` (which resolves no dependencies) and replaces
// /opt/Murage while this very process is still running.
const HAND_OFF_TYPES = new Set(HAND_OFF_PACKAGE_TYPES);

// Do what this app already does for engine installs: put the exact command on
// the clipboard and open a blank terminal to paste it into. The command is
// never executed for the user, so nothing here becomes a process argument.
export function handOffDownloadedPackage(packageType) {
  return async (files) => {
    const target = stagedInstallFile(files);
    const command = packageInstallCommand(packageType, target);
    clipboard.writeText(command);
    return { command, terminalOpened: await openBlankTerminal() };
  };
}

// Every state names the running version: on Linux there is no About panel,
// so Settings → Updates is where a person reads it.
function runningVersion() {
  try {
    return app.getVersion();
  } catch {
    return undefined;
  }
}

function publicState() {
  const currentVersion = runningVersion();
  return currentVersion ? { ...state, currentVersion } : state;
}

function setState(patch) {
  const previousStatus = state.status;
  state = { ...state, ...patch };
  if (patch.status === "downloading" && previousStatus !== "downloading") {
    if (patch.percent === undefined) delete state.percent;
    delete state.message;
  }
  if (patch.status === "available" && patch.releaseNotesText === undefined) delete state.releaseNotesText;
  if (patch.status && patch.status !== "error" && patch.message === undefined) delete state.message;
  if (patch.status && patch.action === undefined) delete state.action;
  if (patch.status && patch.downloadUrl === undefined) delete state.downloadUrl;
  if ("staleCheckSince" in patch && patch.staleCheckSince === undefined) delete state.staleCheckSince;
  void notifications?.stateChanged();
  try {
    win?.webContents?.send("update:state", publicState());
  } catch {
    /* window gone */
  }
}

// main.mjs passes its owned-main-window gate (main-ipc-trust.mjs, B6).
export function reportUpdateNotice(value) { return notifications?.report(value); }

// "Get updates early" (ring beta, designs/RINGS-DESIGN.md section 4). Stored only on this computer, never sent.
function updateChannelFile() { return join(app.getPath("userData"), "update-channel.json"); }

export function registerUpdaterIpc(ipcMain = electronIpcMain) {
  ipcMain.handle("update:get-state", () => publicState());
  ipcMain.handle("update:get-early", () => readGetUpdatesEarly(updateChannelFile()));
  ipcMain.handle("update:set-early", (_event, early) => writeGetUpdatesEarly(updateChannelFile(), early === true));
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
  ipcMain.handle("update:retry", () => updaterCoordinator?.retry());
}

// Windows come and go while the process-owned updater remains alive.
// Reattach broadcasts without re-registering listeners or polling timers.
/** "Check for updates" from the tray menu: the same manual check the app's
 * own button runs. False when no updater runs in this build. */
export function checkForUpdatesNow() {
  if (!updaterCoordinator) return false;
  void Promise.resolve(updaterCoordinator.check(true)).catch(() => {});
  return true;
}

export function attachUpdaterWindow(mainWindow) {
  win?.removeListener?.("focus", onWindowFocus);
  for (const event of ["blur", "hide", "minimize"]) win?.removeListener?.(event, onWindowBackground);
  win = mainWindow;
  win?.on?.("focus", onWindowFocus);
  for (const event of ["blur", "hide", "minimize"]) win?.on?.(event, onWindowBackground);
}

// `installerFallback` (macOS only, from main.mjs: electron/mac-install-guard.mjs) offers the dmg when Squirrel.Mac
// cannot replace this copy, and brings the app back if an install stalls after the server stopped.
// The packaged app's launch pause (electron/update-launch-pause.mjs), set by main.mjs at startup before any install.
let launchPause = null;
export function useUpdateLaunchPause(pause) { launchPause = pause; }

function bundledRingsFloor() {
  try { return Number(JSON.parse(readFileSync(new URL("./rings-floor.json", import.meta.url), "utf8"))?.seq) || 0; } catch { return 0; }
}
// A ring feed that cannot be built (unreadable key or profile path) leaves today's GitHub-latest path, never no updater.
function createDesktopRingFeed(autoUpdater) {
  try { return buildDesktopRingFeed(autoUpdater); } catch (error) {
    autoUpdater.logger?.warn?.(`rings: unavailable ${error?.message ?? error}`);
    return null;
  }
}
function buildDesktopRingFeed(autoUpdater) {
  const userData = app.getPath("userData");
  return createRingFeed(autoUpdater, {
    currentVersion: runningVersion(),
    publicKey: readFileSync(new URL("./release-key.asc", import.meta.url)),
    verify: verifyDetachedSignature,
    cacheFile: join(userData, "rings-cache.json"),
    killFile: join(userData, "kill-switches.json"),
    floorSeq: bundledRingsFloor(),
    // Electron's network stack (system proxy, like electron-updater's own requests): an install admission that only
    // Node's fetch could make would refuse every install on a machine that reaches GitHub only through its proxy.
    fetchImpl: (url, init) => net.fetch(url, init),
    membership: createRingMembership({ ringFile: join(userData, "update-ring.json"), channelFile: updateChannelFile(), readText: (file) => readFileSync(file, "utf8") }),
    log: (line) => autoUpdater.logger.info(line),
  });
}

export function startUpdater({ beforeInstall = null, scheduleChecks = true, installerFallback = null, returnAuthority = null, notificationServices = null } = {}) {
  const publishOffer = () => {
    if (!scheduleChecks || !installerFallback || !updaterCoordinator) return;
    const pending = installerFallback.peekPendingOffer?.(runningVersion());
    if (!pending) return;
    // With a ring feed the offer waits on R8 admission (a promise); the offer stays pending unless it was spent.
    const spent = updaterCoordinator.showInstallerOffer(pending.version,pending.reason);
    if (typeof spent?.then === "function") void spent.then((done) => { if (done) installerFallback.acknowledgePendingOffer?.(pending); }, () => {});
    else if (spent) installerFallback.acknowledgePendingOffer?.(pending);
  };
  const enableChecks = () => {
    if (!scheduleChecks || checksScheduled) return;
    checksScheduled = true;
    setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
    setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
  };
  if (updaterCoordinator) {
    publishOffer();
    enableChecks();
    return updaterCoordinator;
  }
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!updateNotificationsEnabled({ packaged: app.isPackaged, mas: process.mas, windowsStore: process.windowsStore })) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  // Squirrel.Mac installs a native-staged update on ordinary termination too.
  // Set this before any download: backup-mode quits must not arm an update.
  // The existing explicit quitAndInstall path starts native staging later.
  // This is prevention, not cancellation of an already-staged native update.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = updaterLogger();
  if (returnAuthority) autoUpdater.nativeUpdater?.on?.("before-quit-for-update",()=>{
    returnAuthority.nativeQuit=true;queueMicrotask(()=>{returnAuthority.nativeQuit=false;});
  });
  // Windows: the update's signature is checked natively (WinVerifyTrust through the engine-exclusion addon), never by
  // electron-updater's PowerShell check (murage-releases #1). Without the addon the vendored default refuses every update.
  installWindowsUpdateVerifier(autoUpdater);

  // Broadcast the install flavour before the first check so the banner never
  // offers a restart it cannot deliver.
  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    nativeUpdater: autoUpdater.autoInstallOnAppQuit ? autoUpdater.nativeUpdater : null,
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    beforeInstall,
    launchPause,
    returnAuthority,
    fallbackFeed: createGithubFallbackFeed(autoUpdater, { log: (line) => autoUpdater.logger.info(line) }),
    ringFeed: createDesktopRingFeed(autoUpdater),
    // Every platform checks the download against something signed, whichever feed (the normal one or the latest-release
    // fallback) named it: Linux a signed SHA256SUMS, macOS and Windows the version the signed build itself carries.
    verifyDownload: createUpdateDownloadVerifier({ currentVersion: runningVersion(), packageType }),
    ...(installerFallback ? { installerFallback: { ...installerFallback, events: autoUpdater.nativeUpdater ?? null } } : {}),
  });
  publishOffer();

  if (notificationServices) {
    const { Notification, authorization, powerMonitor, ensureWindow } = notificationServices;
    notifications = createUpdateNotifications({
      Notification, authorization, ensureWindow, recordPath: join(app.getPath("userData"), "update-notifications.json"),
      getWindow: () => win, getState: publicState,
      refreshState: () => {
        try { win?.webContents?.send("update:state", publicState()); } catch { /* window gone */ }
      },
      requestNotice: (version) => {
        try {
          win?.webContents?.send("update:state", publicState());
          win?.webContents?.send("update:notice", version);
        } catch { /* window gone; next focus retries */ }
      },
      check: () => updaterCoordinator?.check(),
    });
    powerMonitor.on("resume", () => notifications?.resume());
  }

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  enableChecks();
  return updaterCoordinator;
}
