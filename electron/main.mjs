import { mutateProviderCredentials } from "./provider-connection-control.mjs";
import { app, BrowserWindow, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, Menu, Tray, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { createBackgroundLifecycle, linuxTrayHostAvailable } from "./background-lifecycle.mjs";
import { applyLoginProfileArguments, createBackgroundLogin } from "./background-login.mjs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { assemblyAICredential, mintAssemblyAIStreamingToken } from "./assemblyai.mjs";
import { finishSpeech, startSpeech, stopSpeech } from "./speech.mjs";
import {
  recorderPermissionStatus,
  saveSkillRecording,
  startRecorder,
  stopRecorder,
} from "./skill-recorder.mjs";
import { harnessResourceEnvironment } from "./harness-resources.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { attachUpdaterWindow, startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { prepareUpdaterRestart } from "./updater-restart.mjs";
import {
  buildDiagnosticsReport,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
} from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { activateExistingWindow } from "./single-instance.mjs";
import { pollServerIdentity } from "./server-boot-probe.mjs";
import { acquireDataDirLease, dataDirLeasePaths, inspectDataDirLease } from "./data-dir-lease.mjs";
import { migrateLegacyDataDirectory } from "./data-dir-migration.mjs";
import { assertRestoreReviewed } from "./restore-review.mjs";
import { restoredConnectionProfile, restoredHarnessEnvironment, restoredBrowserPartition } from "./restored-connections.mjs";
import { openInstallationRecoveryWindow } from "./installation-recovery-window.mjs";
import { runInstallationRecoveryWorker } from "./installation-recovery-runner.mjs";
import { createServerChildLifecycle, awaitOwnedWork } from "./server-child-lifecycle.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { windowChromeOptions } from "./window-chrome.mjs";
import { defaultSaveName, withSavableFile } from "./save-file.mjs";
import { verifiedArtifactNativePath } from "./artifact-action.mjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
} from "./managed-composio.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  resolveManagedCompanionGuardian,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { isKnownSkin, skinChrome } from "./skin-overlay.cjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import {
  companionAccountCleanupPending,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
} from "./companion-account-service.mjs";
import capabilitiesModule from "./capabilities.cjs";

// Explicit fixture/profile isolation must precede credentials and the instance lock.
// Ordinary installed launches keep Electron's default paths unchanged.
applyLoginProfileArguments(process.argv,process.env);
if (process.env.MURAGE_USER_DATA !== undefined) {
  const userData = process.env.MURAGE_USER_DATA;
  const dataDir = process.env.MURAGE_DATA_DIR;
  if (!userData || !path.isAbsolute(userData) || !dataDir || !path.isAbsolute(dataDir)
    || !fs.lstatSync(userData).isDirectory() || !fs.lstatSync(dataDir).isDirectory()
    || fs.lstatSync(userData).isSymbolicLink() || fs.lstatSync(dataDir).isSymbolicLink()) {
    throw new Error("MURAGE_USER_DATA requires existing absolute non-symlink user-data and MURAGE_DATA_DIR directories");
  }
  const isolatedUserData = fs.realpathSync(userData);
  app.setPath("userData", isolatedUserData);
  app.setPath("sessionData", isolatedUserData);
  app.setAppLogsPath(path.join(isolatedUserData, "logs"));
}

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const companionToken = randomBytes(32).toString("hex");
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");
const { createDesktopWorkspaceManager } = require("./desktop-workspace.cjs");
const { createBrowserSurfaceManager } = require("./browser-surface.cjs");
const { browserPartition, browserProfilePartition } = require("./browser-snapshot.cjs");
const { createBrowserHost } = require("./browser-host.cjs");
const { browserSurfaceSupported } = require("./browser-platform.cjs");
const { clearBrowserPartitionSession } = require("./browser-partition-cleanup.cjs");
const {
  postBrowserConnection,
  removeBrowserConnectionDescriptor: removeBrowserConnectionDescriptorFile,
} = require("./browser-connection-sync.cjs");
const {
  applyBrowserControlHold,
  browserLifecycleResult,
  decodeBrowserLifecycleMessage,
} = require("./browser-control-sync.cjs");
const { createCuaConnectionStore: createDescriptorStore } = require("./cua-connection.cjs");
const { normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
const DEFAULT_COMPOSIO_BROKER_URL = "https://murage-composio.patient-meadow-1a11.workers.dev";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
let desktopViewerWindow = null;
let desktopViewerOwner = null;
let desktopViewerContextId = null;
let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;
// The built-in browser surface (Browser tab of the computer panel): views
// live in this process; bots reach them through a loopback host whose address
// and per-boot token are sent privately to the embedded harness.
let browserSurface = null;
let browserHost = null;
const browserSurfaceIsSupported = browserSurfaceSupported(process.platform);
// Positive server assertions survive renderer reloads and surface recreation.
// A release is deliberately local-panel-only; see browser-control-sync.cjs.
const browserControlHolds = new Set();
const browserConnectionStore = createDescriptorStore({
  getUserData: () => app.getPath("userData"),
  fileName: "browser-connection.json",
});
let pendingPackageInstallUrl = packageUrlFromCommandLine(process.argv);
let mainWindow = null;
let backgroundLifecycle=null;
let unreadCount = 0;
let unreadOverlayIcon = null;

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

// The palette the renderer last resolved. Persisted beside the window bounds so
// the NEXT cold start can paint `backgroundColor` correctly — without it a light
// user gets a black rectangle for the whole load, which is the flash the inline
// stamp in index.html closes on the renderer side but cannot reach here.
// Always a resolved id ("light" | "dark"), never the "auto" preference.
let persistedSkin = null;

function readPersistedSkin() {
  try {
    const value = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"))?.skin;
    return isKnownSkin(value) ? value : null;
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        bounds: win.getNormalBounds(),
        maximized: win.isMaximized(),
        // parseWindowState ignores unknown keys, so this rides along without
        // touching the bounds contract or its tests.
        ...(persistedSkin ? { skin: persistedSkin } : {}),
      }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`window state save failed: ${error?.message ?? error}`);
  }
}

function installWindowStatePersistence(win) {
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", flush);
}

function applyUnreadBadge(win = mainWindow) {
  const count = normalizeUnreadCount(unreadCount);
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    unreadOverlayIcon ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !unreadOverlayIcon.isEmpty() ? unreadOverlayIcon : null,
      count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations",
    );
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
}

// GNOME groups the window with its installed desktop entry only when both
// identities match. This must run before Electron becomes ready. Ubuntu also
// uses Chromium's software renderer: the supported machine reproduced two
// NVIDIA/libGLES GPU-process crashes that left an invisible focused window
// intercepting input. This app is not graphics-heavy, so reliability wins.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.setDesktopName("com.murage.app.desktop");
}

// One instance per user: without this lock a second launch forks a second
// harness server on a fallback port and splits data dirs in two. The loser
// exits before any child or window exists; the winner surfaces itself.
if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] Murage is already running — focusing that window");
  process.exit(0);
}
function deliverPackageInstall(win) {
  if (!pendingPackageInstallUrl || !win || win.isDestroyed()) return;
  if (win.webContents.isLoadingMainFrame()) return;
  win.webContents.send("package:install", pendingPackageInstallUrl);
  pendingPackageInstallUrl = null;
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  if(!activateExistingWindow(BrowserWindow.getAllWindows()))backgroundLifecycle?.open();
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
  return true;
}

app.on("open-url", (event, url) => {
  if (!queuePackageInstall(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
});

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
let desktopRecoveryMode = false;
let recoveryWindow = null;
let recoveryActivateRegistered = false;
let secureCredentials = {};
let secureCredentialState = null;
let desktopDataDir = null;
let desktopDataOwner = null;
const ownedServerChildren = new Set();
const credentialWrites = new Set();
const managedComposioShutdown = new AbortController();
const companionStarts = new Set();

function assertDesktopStartupActive() {
  if (desktopShutdownStarted || desktopRecoveryMode) throw new Error("Desktop startup was cancelled");
}

function acquireDesktopDataOwner() {
  assertDesktopStartupActive();
  if (!app.isPackaged) return;
  if (desktopDataOwner) return;
  // An empty override is invalid, not permission to open a new default home.
  const raw = process.env.MURAGE_DATA_DIR ?? path.join(app.getPath("home"), ".murage");
  const canonical = dataDirLeasePaths(raw).canonicalDataDir;
  // Retain the inspected location for recovery without granting ownership.
  desktopDataDir = canonical;
  const owner = acquireDataDirLease(canonical);
  desktopDataDir = canonical;
  desktopDataOwner = owner;
}

function ownedDesktopDataDir() {
  if (!app.isPackaged || !desktopDataOwner || !desktopDataDir) {
    throw new Error("The packaged desktop does not own this installation");
  }
  return desktopDataDir;
}

function trackOwnedServerChild(proc) {
  const child = createServerChildLifecycle(proc);
  ownedServerChildren.add(child);
  void child.exit.then(() => ownedServerChildren.delete(child));
  return child;
}

// The harness mints a fresh desktop secret every launch and pushes it here
// over the private utility-process port, before it starts listening. It is
// the renderer's proof that it IS the renderer: `requestSurface()` in
// server/sse-visibility.ts answers "desktop" for nothing else, so the
// execution-class routes stop being reachable by any local process that can
// type a header. Held in memory in this process only — never written to
// userData, never logged, never put in a child environment.
let desktopSurfaceSecret = "";

function receiveDesktopSurfaceSecret(message) {
  if (message?.type !== "murage:desktop-secret") return false;
  if (typeof message.secret === "string" && message.secret) desktopSurfaceSecret = message.secret;
  return true;
}

let CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");
let restoredConnections = null;
function configureRestoredDesktopConnections() {
  if (!app.isPackaged) return;
  restoredConnections = restoredConnectionProfile(ownedDesktopDataDir());
  if (!restoredConnections) return;
  CREDENTIALS_FILE = restoredConnections.credentialsFile;
  configureCompanionStorage({ settingsDirectory: restoredConnections.companionSettings, stateDirectory: restoredConnections.companionState });
}

/** Set once per launch: true when the store could not be READ, which is not
 * the same as the user having saved nothing. Everything downstream — the
 * server's view of "configured", and whether we may register a fresh
 * installation — keys off this rather than off an empty object. */
const modelProviderCommitToken = randomBytes(32).toString("hex");
let credentialStoreUnavailable = false;

async function loadSecureCredentials() {
  const result = await readSecureCredentials({
    exists: () => fs.existsSync(CREDENTIALS_FILE),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => fs.readFileSync(CREDENTIALS_FILE),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  credentialStoreUnavailable = result.status === "unavailable";
  if (credentialStoreUnavailable) {
    // Deliberately loud. A silent {} here is what made a keychain hiccup
    // look like "your connected apps are gone".
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  if (app.isPackaged) ownedDesktopDataDir();
  // A failed read means we do not know what the existing encrypted document
  // contains. Never derive a replacement from that incomplete view: boot
  // migrations must leave plaintext in place so a later launch can retry.
  if (credentialStoreUnavailable) {
    throw new Error("The operating-system credential store could not be read this launch");
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = ownedDesktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().startsWith("ak_")) {
      if (!secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKey.trim();
        await saveSecureCredentials(secureCredentials);
      }
      config.composio.apiKey = "";
      changed = true;
    } else if (typeof apiKey === "string" && apiKey.trim()) {
      config.composio.apiKey = "";
      changed = true;
    }
    // These were the old Connect credential and endpoint. They are no longer
    // read; remove them during the upgrade so an unused secret is not left in
    // plaintext indefinitely.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

// The remaining workspace credentials (xai/box/voice/OpenCode keys) get
// the same at-rest treatment as the Composio key above. New packaged-app
// saves go straight through credential:set below; this boot-time sweep also
// migrates plaintext left by older versions or direct development clients.
// See workspace-credentials.mjs for the exact rules.
async function secureWorkspaceConfig() {
  const dataDir = ownedDesktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    // credentials.bin first: if the OS store cannot take the secrets, the
    // plaintext stays put and the next boot retries — losing the only copy
    // is the one unacceptable outcome
    if (migrated.credentialsChanged) await saveSecureCredentials(migrated.credentials);
    secureCredentials = migrated.credentials;
    if (!migrated.configChanged) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

function composioBrokerUrl() {
  const configured = process.env.MURAGE_COMPOSIO_BROKER_URL?.trim();
  return normalizeManagedComposioBrokerUrl(
    configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : ""),
  );
}

// The packaged app has no terminal: everything about the server child's life
// goes to server.log in the OS log dir (~/Library/Logs/Murage on macOS,
// Console.app-visible; %APPDATA%\Murage\logs on Windows), which is also
// why stdio is piped, not inherited — under a Finder/Explorer launch the
// parent's stdio leads nowhere and a failed boot is otherwise undiagnosable.
const LOG_DIR = app.getPath("logs");
const DESKTOP_CRASH_LOG = path.join(LOG_DIR, "desktop-crashes.log");
const DESKTOP_CRASH_LOG_MAX_BYTES = 512 * 1024;
let logStream = null;
let desktopShutdownStarted = false;
import {
  companionAdvertisedHostedUrl,
  configureCompanionStorage,
  companionEnabledAtRest,
  companionOriginTarget,
  companionPairing,
  companionRefreshTailscale,
  companionRemoteAccessAtRest,
  companionRemoteAccessOrigin,
  rememberCompanionRemoteAccess,
  reconcileCompanionHttps,
  BROWSER_LOOPBACK_TARGET,
  companionCloudDesktopAccess,
  companionRevoke,
  companionRunning,
  companionState,
  rememberCompanionEnabled,
  rememberCompanionKeepAwake,
  setCompanionHostedUrl,
  setCompanionLifecycleListener,
  startCompanion,
  stopCompanion,
} from "./companion.mjs";
import {
  disableServe,
  enableServe,
  serveState,
} from "./companion-remote-access.mjs";

let companionPowerBlocker = null;

function syncCompanionKeepAwake(companionEnabled, keepAwake) {
  const shouldBlock = companionEnabled && keepAwake;
  if (shouldBlock && companionPowerBlocker === null) {
    companionPowerBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && companionPowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(companionPowerBlocker)) powerSaveBlocker.stop(companionPowerBlocker);
    companionPowerBlocker = null;
  }
}

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

// The server stream is intentionally asynchronous, but a fatal main-process
// exception may terminate Electron before such a write is flushed. Crash
// metadata gets its own tiny synchronous file. The formatter admits only a
// fixed set of fields, so renderer URLs, page titles, exception messages and
// absolute paths never land on disk or in a public bug report.
function recordDesktopCrash(event) {
  let handle = null;
  try {
    const record = formatDesktopCrashRecord(event);
    if (!record) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(DESKTOP_CRASH_LOG);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(DESKTOP_CRASH_LOG, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      // O_EXCL makes first creation race-safe on Windows, where O_NOFOLLOW is
      // unavailable, as well as on POSIX.
      try {
        handle = fs.openSync(
          DESKTOP_CRASH_LOG,
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
      } catch {
        return;
      }
    }

    const stats = fs.fstatSync(handle);
    // A hard-linked or non-regular target is not an app-owned crash log.
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    // A renderer crash loop must not grow a persistent log without bound.
    // The diagnostics export reads only a bounded tail, so dropping older
    // crash metadata here preserves the useful part of the record.
    if (stats.size >= DESKTOP_CRASH_LOG_MAX_BYTES) fs.ftruncateSync(handle, 0);
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, `[${new Date().toISOString()}] ${record}\n`, "utf8");
  } catch {
    /* crash diagnostics must never change app lifecycle */
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

// uncaughtExceptionMonitor observes Node's fatal path without converting it
// into a handled exception. In particular, an unhandled rejection still
// follows Node's normal exit behaviour after its metadata is persisted.
installDesktopCrashListeners({
  appTarget: app,
  processTarget: process,
  record: recordDesktopCrash,
  isShuttingDown: () => desktopShutdownStarted,
  mainWebContents: () => mainWindow?.webContents ?? null,
});

// ── managed companion connection ───────────────────────────────────────
// Account onboarding provisions one remote Cloudflare Tunnel per desktop,
// then calls reconcileManagedCompanionEndpointProvision below. Only the
// endpoint is public state. The connector token stays in credentials.bin and
// is passed to cloudflared through a private token file by the lifecycle
// module — never through IPC, argv, the environment, or logs.
let managedCompanionConnector = null;
let companionAccountService = null;
let companionDesiredThisLaunch = false;
let companionLaunchGeneration = 0;
let advertisementTransition = Promise.resolve();

/** The one serialized credential mutation hook. Account onboarding and every
 * other runtime credential writer share this state, so persisting a tunnel
 * token can never overwrite an API key saved at the same time (or vice
 * versa). */
export async function updateSecureCredentialDocument(derive, afterPersist) {
  assertDesktopStartupActive();
  if (app.isPackaged) ownedDesktopDataDir();
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  const write = secureCredentialState.update(derive, afterPersist);
  credentialWrites.add(write);
  try {
    return await write;
  } finally {
    credentialWrites.delete(write);
    secureCredentials = secureCredentialState.read();
  }
}

function publicManagedCompanionState() {
  const access = managedCompanionTunnelAccess(secureCredentials);
  const status = managedCompanionConnector?.getStatus();
  if (status) {
    const publicState = {
      status: status.status,
      configured: status.configured,
      ready: status.ready,
    };
    if (status.endpoint) publicState.url = status.endpoint;
    if (status.retryInMs) publicState.retryInMs = status.retryInMs;
    if (status.error) publicState.error = status.error;
    return publicState;
  }
  return access
    ? { status: "stopped", configured: true, ready: false, url: access.endpoint }
    : { status: "unconfigured", configured: false, ready: false };
}

// ── remote browser access ──────────────────────────────────────────────
// One switch: `tailscale serve` in front of the browser door, and the door
// bound to loopback where serve connects. The two are one decision and were
// two, which is why the door came up on the tailnet address while serve
// forwarded to a loopback port nothing was listening on.
//
// The last observed serve arrangement, so the panel can render without paying
// for a subprocess on every poll. Refreshed by every toggle, by startup, and
// by the explicit re-check — never inferred from the remembered setting,
// because "what the user asked for" and "what Tailscale is doing" are exactly
// the two things that disagree when this is broken.
let remoteAccessObserved = null;

/** The public, secret-free shape the renderer renders.
 *
 * Three separate facts, deliberately not collapsed into one boolean:
 *   `on`      — serve is fronting the door AND the sidecar knows it, so the
 *               advertised link really is the portless HTTPS one.
 *   `desired` — what the user last asked for. Differs from `on` while a
 *               toggle is failing, which is when the difference matters.
 *   `problem` — the honest reason, when there is one. */
function publicRemoteAccessState() {
  const origin = companionRemoteAccessOrigin();
  const observed = remoteAccessObserved;
  const active = Boolean(observed?.on && origin && origin === `https://${observed.host}`);
  const listenerMismatch = Boolean(observed?.on && !active);
  return {
    on: active,
    desired: companionRemoteAccessAtRest(),
    url: active ? origin : null,
    available: observed ? observed.available !== false : null,
    reason: observed?.reason ?? (listenerMismatch ? "listener" : null),
    problem: observed?.message ?? (listenerMismatch ? "HTTPS is configured, but the browser door is not ready on its matching private listener." : null),
  };
}

/** Look at what Tailscale is actually doing, and remember it. */
async function refreshRemoteAccessObservation() {
  try {
    remoteAccessObserved = await serveState({ proxyTarget: BROWSER_LOOPBACK_TARGET });
    reconcileCompanionHttps(remoteAccessObserved, slog);
  } catch {
    remoteAccessObserved = {
      available: false,
      on: false,
      host: null,
      reason: "failed",
      message: "Tailscale could not be checked on this computer.",
    };
  }
  return remoteAccessObserved;
}

/** The launch options for the sidecar, honouring the remote-access decision.
 *
 * `null` when remote access is off or unavailable, which is the fallback path
 * and is a complete, working configuration: the door binds the tailnet
 * address and answers plain HTTP over WireGuard exactly as it does today. */
function remoteAccessLaunch() {
  const observed = remoteAccessObserved;
  if (!observed?.on || !observed.host) return null;
  return { origin: `https://${observed.host}` };
}

function decorateDesktopCompanionState(state) {
  // The panel polls this state, so a sidecar that exited on its own releases
  // the blocker within one poll instead of keeping the computer awake forever.
  syncCompanionKeepAwake(state.enabled && !state.error, state.keepAwake === true);
  return {
    ...state,
    managedConnection: publicManagedCompanionState(),
    remoteAccess: publicRemoteAccessState(),
  };
}

async function desktopCompanionState() {
  return decorateDesktopCompanionState(await companionState());
}

function companionLaunchOptions(hostedUrl = null) {
  return {
    companionToken,
    resourcesPath: process.resourcesPath,
    harnessPort: SERVER_PORT,
    hostedUrl,
    remoteAccess: remoteAccessLaunch(),
    log: slog,
  };
}

function ensureManagedCompanionConnector() {
  if (managedCompanionConnector) return managedCompanionConnector;
  managedCompanionConnector = createManagedCompanionTunnel({
    binaryPath: resolveCloudflaredBinary({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    guardianEntry: resolveManagedCompanionGuardian({ appPath: app.getAppPath() }),
    runtimeExecutable: process.execPath,
    runtimeRoot: restoredConnections?.tunnelRuntime ?? path.join(app.getPath("userData"), "managed-companion-tunnel"),
    onChange: (status) => {
      slog(`managed companion connection ${status.status}`);
      if (!companionDesiredThisLaunch) return;
      void reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
    },
    log: slog,
  });
  return managedCompanionConnector;
}

/** Publish a hosted address only after its connector has passed public health
 * verification. Updating the owned sidecar in place preserves the exact
 * private origin generation and cannot invalidate an open pairing window. */
function reconcileCompanionAdvertisement(
  endpoint,
  ownedGeneration = companionLaunchGeneration,
) {
  const normalizedEndpoint = endpoint || null;
  const work = advertisementTransition.then(async () => {
    if (
      ownedGeneration !== companionLaunchGeneration ||
      !companionDesiredThisLaunch ||
      !companionRunning() ||
      companionAdvertisedHostedUrl() === normalizedEndpoint
    ) {
      return desktopCompanionState();
    }
    const updated = await setCompanionHostedUrl(normalizedEndpoint);
    return { ...updated, managedConnection: publicManagedCompanionState() };
  });
  advertisementTransition = work.then(
    () => {},
    () => {},
  );
  return work;
}

async function startManagedCompanionConnection({ waitForVerification = true } = {}) {
  assertDesktopStartupActive();
  if (companionAccountCleanupPending(secureCredentials)) {
    return publicManagedCompanionState();
  }
  const access = managedCompanionTunnelAccess(secureCredentials);
  if (!access) return publicManagedCompanionState();
  const target = companionOriginTarget();
  if (!target) return publicManagedCompanionState();
  const operation = ensureManagedCompanionConnector().start({ ...access, originTarget: target });
  if (!waitForVerification) {
    void operation.catch(() => {});
    return publicManagedCompanionState();
  }
  const status = await operation;
  await reconcileCompanionAdvertisement(status.ready ? status.endpoint : null);
  return publicManagedCompanionState();
}

async function startDesktopCompanion({ waitForHosted = true, remember = true } = {}) {
  assertDesktopStartupActive();
  const pending = Promise.withResolvers();
  companionStarts.add(pending.promise);
  try {
    companionDesiredThisLaunch = true;
    companionLaunchGeneration += 1;
    // Before the fork, not after: the fork's environment is where the door
    // learns it is behind a proxy, and a sidecar started without that knowledge
    // advertises its own socket. Only when remote access is actually wanted —
    // the default costs no subprocess.
    await refreshRemoteAccessObservation();
    assertDesktopStartupActive();
    // Direct LAN comes up first. The hosted endpoint is added in place only
    // after the guardian has verified the public route to this exact sidecar.
    const localState = await startCompanion(companionLaunchOptions());
    assertDesktopStartupActive();
    if (!localState.enabled || localState.error) {
      companionDesiredThisLaunch = false;
      return desktopCompanionState();
    }
    if (remember) rememberCompanionEnabled(true);
    await startManagedCompanionConnection({ waitForVerification: waitForHosted });
    return desktopCompanionState();
  } finally {
    companionStarts.delete(pending.promise);
    pending.resolve();
  }
}

/** Re-probe Tailscale for the panel. Starting the sidecar when it is off is
 * the honest reading of the request: the answer is a property of the sidecar,
 * and "off" is not an answer about Tailscale. The hosted route is not waited
 * on, because nothing here depends on it. */
async function refreshDesktopCompanionTailscale() {
  if (!companionRunning()) {
    const started = await startDesktopCompanion({ waitForHosted: false });
    if (!started.enabled || started.error) return started;
  }
  // The proxy in front is part of "is this reachable", and it is the half a
  // person is most likely to have just changed by hand.
  await refreshRemoteAccessObservation();
  return decorateDesktopCompanionState(await companionRefreshTailscale());
}

/** Turn remote browser access on or off. One action, both halves.
 *
 * ON, in order, and the order is the design:
 *   1. read `tailscale serve status` — a config that belongs to something
 *      else is refused here, before any write, and nothing is changed;
 *   2. `tailscale serve --bg --https=443 http://127.0.0.1:8813`, then read it
 *      back, because the exit code is not evidence and the host in the
 *      config is the name the certificate was issued for;
 *   3. only then restart the sidecar, with the door on loopback and the
 *      front's origin in its environment.
 *
 * A failure at 1 or 2 leaves the sidecar exactly as it was. That is the
 * honest downgrade: plain HTTP on the tailnet keeps working, the switch does
 * not stick, and the panel says why.
 *
 * OFF removes only an arrangement that is ours, then restarts the sidecar
 * back onto its ordinary tailnet bind.
 *
 * Idempotent: asking for the state it is already in re-reads Tailscale, does
 * not write, and does not restart. */
async function setDesktopCompanionRemoteAccess(enabled) {
  const wanted = Boolean(enabled);
  const observed = wanted
    ? await enableServe({ proxyTarget: BROWSER_LOOPBACK_TARGET })
    : await disableServe({ proxyTarget: BROWSER_LOOPBACK_TARGET });
  remoteAccessObserved = observed;

  if (wanted && !observed.on) {
    // Nothing was changed on this machine, so nothing is remembered either.
    // Remembering a wish that failed would restore a broken pair on the next
    // launch — serve config absent, door on loopback, unreachable.
    rememberCompanionRemoteAccess(false);
    slog(`remote browser access refused: ${observed.reason ?? "unknown"} — ${observed.message ?? ""}`);
    return desktopCompanionState();
  }
  rememberCompanionRemoteAccess(wanted);

  // The sidecar learns which side of this it is on through its environment,
  // so the change lands on a restart and only when it actually differs.
  const already = companionRemoteAccessOrigin();
  const target = wanted && observed.host ? `https://${observed.host}` : null;
  if (!companionRunning() || already === target) return desktopCompanionState();
  await stopCompanion();
  return startDesktopCompanion({ waitForHosted: false });
}

async function stopDesktopCompanion({ remember = true } = {}) {
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  if (remember) rememberCompanionEnabled(false);
  syncCompanionKeepAwake(false, false);
  await managedCompanionConnector?.stop();
  await stopCompanion();
  return desktopCompanionState();
}

setCompanionLifecycleListener(({ expected, pid }) => {
  if (expected) return;
  slog(`owned companion exited unexpectedly pid=${pid ?? "unknown"}`);
  companionDesiredThisLaunch = false;
  companionLaunchGeneration += 1;
  syncCompanionKeepAwake(false, false);
  // stop() invalidates the guardian's owner pipe synchronously, before the
  // sidecar module removes this generation's private socket.
  void managedCompanionConnector?.stop().catch(() => {});
});

/** Narrow main-process hook for the account onboarding flow. Its return value
 * is explicitly secret-free and can be used to refresh the settings panel. */
export async function reconcileManagedCompanionEndpointProvision(provision) {
  await updateSecureCredentialDocument((credentials) =>
    withManagedCompanionTunnelAccess(credentials, provision),
  );
  if (companionDesiredThisLaunch) {
    await startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

/** Called only after the control plane has revoked/deleted the endpoint. */
export async function clearManagedCompanionEndpointCredentials() {
  await updateSecureCredentialDocument((credentials) =>
    withoutManagedCompanionTunnelAccess(credentials),
  );
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

/** Account sign-out must stop advertising the hosted route before it asks
 * the control plane to revoke anything, but it must not erase the retry
 * credentials until that remote cleanup is durably scheduled. */
async function stopManagedCompanionEndpointLocally() {
  await managedCompanionConnector?.stop();
  if (companionDesiredThisLaunch) await reconcileCompanionAdvertisement(null);
  return publicManagedCompanionState();
}

async function activatePersistedManagedCompanionEndpoint() {
  if (companionDesiredThisLaunch) {
    return startManagedCompanionConnection({ waitForVerification: true });
  }
  return publicManagedCompanionState();
}

function installationDisplayName() {
  const hostname = [...os.hostname()]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  return hostname.slice(0, 80) || "This computer";
}

function ensureCompanionAccountService() {
  if (companionAccountService) return companionAccountService;
  const baseURL = resolveCompanionControlPlaneURL({
    isPackaged: app.isPackaged,
    environment: process.env,
  });
  let client = null;
  if (baseURL) {
    try {
      client = createControlPlaneClient({ baseURL });
    } catch {
      // An invalid explicit override disables hosted access. Direct LAN,
      // Bonjour, and Tailscale pairing remain completely independent.
    }
  }
  companionAccountService = createCompanionAccountService({
    client,
    readCredentials: () => secureCredentialState?.read() ?? secureCredentials,
    updateCredentials: updateSecureCredentialDocument,
    identity: {
      name: installationDisplayName(),
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      appVersion: app.getVersion().slice(0, 64),
    },
    newClientInstanceId: randomUUID,
    activatePersistedEndpoint: activatePersistedManagedCompanionEndpoint,
    stopManagedEndpoint: stopManagedCompanionEndpointLocally,
    managedConnectionState: publicManagedCompanionState,
    companionIsOn: () => companionDesiredThisLaunch,
  });
  return companionAccountService;
}

// Everything the bug-report bundle needs. The config summary comes from the
// server's own booleans-only /api/config status (credentials are never
// echoed), and the log goes through the redactor in diagnostics.mjs — so the
// file is safe to paste into a public issue even if a future log line ever
// carried a secret.
async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readSafeLogTail(logPath);
  const desktopLog = readSafeLogTail(DESKTOP_CRASH_LOG);
  return buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
    },
    configSummary: serverStatus ?? {},
    desktopLogTail: desktopLog?.tail ?? "",
    logTail: log?.tail ?? "",
  });
}

// Set by startServerPackaged: true only when every failing candidate port was
// taken by another process — decides which error-page message renders.
let serverStartConflictOnly = false;

function syncBrowserConnection(proc) {
  try {
    postBrowserConnection(proc, browserHost?.url ? browserHost.descriptor() : null);
  } catch (error) {
    slog(`browser connection sync failed: ${error?.message ?? error}`);
  }
}

function receiveBrowserControlHold(rawMessage) {
  const message = rawMessage?.data ?? rawMessage;
  return applyBrowserControlHold(message, (botId) => {
    browserControlHolds.add(botId);
    browserSurface?.setHumanControl(botId, true);
  });
}

async function clearBrowserPartition(partition) {
  await clearBrowserPartitionSession(session.fromPartition(partition));
}
const desktopBrowserPartition = botId => restoredBrowserPartition(browserPartition(botId), restoredConnections);
const desktopBrowserProfilePartition = profileId => restoredBrowserPartition(browserProfilePartition(profileId), restoredConnections);

async function applyBrowserLifecycleCleanup(lifecycle) {
  if (lifecycle.type === "bot-deleted") {
    browserSurface?.close(lifecycle.botId);
    browserControlHolds.delete(lifecycle.botId);
    browserHost?.revokeCapabilitiesForBot(lifecycle.botId);
    await clearBrowserPartition(desktopBrowserPartition(lifecycle.botId));
  } else {
    browserSurface?.forgetProfile(lifecycle.partitionId);
    browserHost?.revokeCapabilitiesForProfile(lifecycle.partitionId);
    await clearBrowserPartition(desktopBrowserProfilePartition(lifecycle.partitionId));
  }
  return true;
}

const browserLifecycleCleanups = new Map();
const completedBrowserLifecycleCleanups = new Set();
const MAX_COMPLETED_BROWSER_CLEANUPS = 512;

function rememberBrowserLifecycleCleanup(requestId) {
  if (!requestId) return;
  completedBrowserLifecycleCleanups.delete(requestId);
  completedBrowserLifecycleCleanups.add(requestId);
  while (completedBrowserLifecycleCleanups.size > MAX_COMPLETED_BROWSER_CLEANUPS) {
    completedBrowserLifecycleCleanups.delete(completedBrowserLifecycleCleanups.values().next().value);
  }
}

/** Run one private cleanup request at most once and acknowledge only after
 * Chromium confirms its session data is gone. Duplicate retries join the
 * same promise; a retry whose success ACK was lost receives a cached ACK. */
function receiveBrowserLifecycleCleanup(proc, rawMessage) {
  if (desktopRecoveryMode || desktopShutdownStarted) return false;
  const message = rawMessage?.data ?? rawMessage;
  const lifecycle = decodeBrowserLifecycleMessage(message);
  if (!lifecycle) return false;
  const requestId = lifecycle.requestId;
  let cleanup = requestId ? browserLifecycleCleanups.get(requestId) : null;
  if (!cleanup) {
    cleanup = requestId && completedBrowserLifecycleCleanups.has(requestId)
      ? Promise.resolve(true)
      : applyBrowserLifecycleCleanup(lifecycle).then((result) => {
          rememberBrowserLifecycleCleanup(requestId);
          return result;
        });
    if (requestId) {
      browserLifecycleCleanups.set(requestId, cleanup);
      void cleanup.finally(() => {
        if (browserLifecycleCleanups.get(requestId) === cleanup) browserLifecycleCleanups.delete(requestId);
      }).catch(() => {});
    }
  }
  void cleanup.then(
    () => {
      if (requestId) proc.postMessage(browserLifecycleResult(requestId, true));
    },
    (error) => {
      slog(`browser lifecycle cleanup failed: ${error?.message ?? error}`);
      if (requestId) {
        try {
          proc.postMessage(browserLifecycleResult(requestId, false));
        } catch (postError) {
          slog(`browser lifecycle result send failed: ${postError?.message ?? postError}`);
        }
      }
    },
  ).catch((error) => {
    slog(`browser lifecycle result send failed: ${error?.message ?? error}`);
  });
  return true;
}

async function startServerOn(port) {
  assertDesktopStartupActive();
  if (!desktopDataOwner || !desktopDataDir) throw new Error("The packaged desktop does not own this installation");
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...restoredHarnessEnvironment(process.env, restoredConnections),
    // A packaged utility child must never fall back to a descriptor inherited
    // from the launching shell. It starts fail-closed until this exact main
    // process sends the private in-memory connection after spawn.
    MURAGE_DESKTOP_PARENT: "1",
    MURAGE_COMPANION_TOKEN: companionToken,
    MURAGE_DATA_DIR: desktopDataDir,
    ...desktopDataOwner.utilityServerLeaseEnvironment(),
    // ui / skills / skills-library, all resolved out of Resources. Set here,
    // before the fork, because the child reads them at module load.
    ...harnessResourceEnvironment(process.resourcesPath),
    MURAGE_PORT: String(port),
    MURAGE_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    // "we could not read your keys" must not reach the UI as "you have none"
    MURAGE_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: modelProviderCommitToken,
    // one env var per stored workspace secret (xai/box/voice/OpenCode Go);
    // the server prefers these over config.json, whose plaintext fields
    // the boot migration has deleted
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.MURAGE_BROWSER_CONNECTION;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = trackOwnedServerChild(proc);
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    try {
      if (receiveDesktopSurfaceSecret(message)) return;
      if (receiveBrowserControlHold(message)) return;
      if (receiveBrowserLifecycleCleanup(proc, message)) return;
    } catch (error) {
      slog(`browser private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    syncBrowserConnection(proc);
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    // The secret belonged to THAT child. A replacement mints its own, and
    // holding a dead one would let the renderer keep presenting a proof the
    // new harness has never heard of.
    desktopSurfaceSecret = "";
    // Capabilities belong to turns in this exact server child. A crash or
    // restart invalidates them before any replacement child receives the
    // browser descriptor.
    browserHost?.clearCapabilities();
    slog(`exited code=${code}`);
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  // The budget is wall-clock, not a fixed poll count: a healthy boot can take
  // well past 20s on cold machines or when pre-listen network calls stall
  // (issue #506), and reaping an about-to-listen child reads to the user as
  // "something else is using its ports" even though nothing was on them.
  // The probe itself is deadline-bounded (a hung health endpoint cannot wedge
  // us here forever) and reports WHY it gave up, so the error page can tell
  // port conflict apart from slow startup.
  let identity;
  try {
    identity = await Promise.race([pollServerIdentity({
    port,
    // Getter, not value: proc.pid stays undefined until the async `spawn`
    // event fires, and capturing it here would make the probe judge our own
    // child a "foreign owner" on its first health answer.
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited || lifecycle.failed || desktopShutdownStarted,
    }), lifecycle.exit.then(() => ({ outcome: "exited" }))]);
    if (identity.outcome === "ready" && !lifecycle.exited && !desktopShutdownStarted) return { proc };
  } catch (error) {
    await lifecycle.stop();
    throw error;
  }
  if (identity.outcome === "exited") {
    slog(`child on port ${port} exited before answering /api/health`);
  } else {
    slog(
      identity.outcome === "foreign-owner"
        ? `port ${port} answered health checks from another process`
        : `child on port ${port} did not answer /api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }
  await lifecycle.stop();
  assertDesktopStartupActive();
  return { proc: null, reason: identity.outcome };
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      assertDesktopStartupActive();
      const started = await startServerOn(port);
      if (started.proc) {
        serverProc = started.proc;
        SERVER_PORT = port;
        return true;
      }
      // A child that exited or timed out is not evidence of a port conflict —
      // only "another process answered health checks" is.
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  serverStartConflictOnly = everyPortForeignOwned;
  return false;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "murage:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

// The page is built at failure time (not import time): the message depends on
// how the boot failed, and the log path comes from LOG_DIR so Windows and
// Linux users see their real location instead of a macOS guess. The link
// opens the log through the window's setWindowOpenHandler, which routes to
// the platform handler.
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildErrorPage({ allPortsOccupied }) {
  const serverLogPath = path.join(LOG_DIR, "server.log");
  const serverLogHref = pathToFileURL(serverLogPath).href;
  const reason = allPortsOccupied
    ? "Every Murage port answered health checks from another process — likely a second copy of the app, or another program on ports 8799–28799. Quit that program, then quit and reopen Murage."
    : "The background server didn't come up in time — this is usually slow startup, not a port conflict. Quit and reopen Murage.";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🔥</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} If it keeps happening, check <a target="_blank" rel="noopener" href="${serverLogHref}" style="color:#fcfcfc">${escapeHtml(serverLogPath)}</a>.</p></div></body>`,
    )
  );
}

// How long one packaged-server child gets to answer /api/health before the
// parent reaps it and tries the next port. Wall-clock, deliberately generous:
// first boots write data dirs and pre-listen network calls (managed composio,
// workspace credentials) can stall a healthy child far past 20s on some
// machines, which used to surface as the misleading "ports are busy" page.
const SERVER_BOOT_TIMEOUT_MS = 60_000;

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  // An empty response intentionally rejects the renderer request, and Electron
  // can surface that rejection by throwing from the callback. A selected
  // source should never fail delivery, so keep that path visible in logs.
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

function notifyDesktopViewer(open) {
  if (!desktopViewerOwner?.isDestroyed()) {
    desktopViewerOwner.send("desktop-viewer:state", {
      open,
      contextId: desktopViewerContextId,
    });
  }
}

function desktopViewerErrorPage(message, retryUrl) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta name="color-scheme" content="dark"><title>Desktop unavailable</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
        <main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">Couldn't open the live desktop</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escape(message)}</p>
        <a href="${escape(retryUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">Open in browser</a></main>
      </body>`)
  );
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId) {
  if (!owner || owner.isDestroyed()) throw new Error("The Murage window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";

  const nextContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  // Desktop URLs contain rotating access tokens. A newly minted URL replaces
  // the old viewer instead of being retained anywhere after its window closes.
  // Clear the ref first so the stale window's close handler no-ops; on a bot
  // change, tell the previous bot to release (same-bot reopen stays quiet).
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) {
    const previous = desktopViewerWindow;
    const previousOwner = desktopViewerOwner;
    const previousContextId = desktopViewerContextId;
    desktopViewerWindow = null;
    previous.close();
    if (previousContextId !== nextContextId && previousOwner && !previousOwner.isDestroyed()) {
      previousOwner.send("desktop-viewer:state", { open: false, contextId: previousContextId });
    }
  }
  desktopViewerOwner = owner.webContents;
  desktopViewerContextId = nextContextId;

  const viewer = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    // Not modal: the person still needs the app's "Hand control back" button
    // while the desktop is open. `parent` keeps it floating above the app.
    modal: false,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: skinChrome(persistedSkin).color,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Keep provider cookies away from the app renderer and discard them on
      // app exit. The secret-bearing URL is sufficient to authenticate.
      partition: "murage-desktop-viewer",
    },
  });
  desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;

  // VNC needs rendering, keyboard/mouse input and WebSockets, plus the few
  // permission-gated input capabilities a viewer page asks for: keyboard and
  // pointer capture, the clipboard for paste, full screen. Those go to the
  // viewer's own origin only — never camera, microphone, geolocation,
  // notifications, USB, or any other privileged browser capability in this
  // remote-content window (see desktop-viewer-permissions.mjs).
  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  // A child window floats above the app but does not take the keyboard until
  // it is focused: clicks land in the VNC canvas either way, keystrokes only
  // reach the key window. Left unfocused, typing "into the VM" lands in the
  // composer and ⌘1–9 switch bots while the mouse appears to work.
  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
  viewer.on("closed", () => {
    if (desktopViewerWindow !== viewer) return;
    desktopViewerWindow = null;
    // The panel drops its "viewer open" state and releases control on this.
    notifyDesktopViewer(false);
    desktopViewerOwner = null;
    desktopViewerContextId = null;
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = desktopViewerUrl(target);
      void shell.openExternal(external.toString());
    } catch {
      // Ignore non-web and insecure URLs from the remote viewer.
    }
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {
      // Keep privileged or malformed navigation out of the viewer.
    }
  });
  viewer.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || viewer.isDestroyed() || failedUrl.startsWith("data:")) return;
    void viewer.loadURL(desktopViewerErrorPage(description || "The viewer did not respond.", url.toString()));
  });

  notifyDesktopViewer(true);
  void viewer.loadURL(url.toString()).catch((error) => {
    if (viewer.isDestroyed()) return;
    void viewer.loadURL(desktopViewerErrorPage(error?.message ?? "The viewer did not respond.", url.toString()));
  });
  return true;
}

function ensureDesktopWorkspace(owner) {
  if (!owner || owner.isDestroyed()) throw new Error("The Murage window is unavailable");
  if (desktopWorkspaceManager) {
    if (desktopWorkspaceOwner !== owner) {
      throw new Error("The desktop workspace belongs to another app window");
    }
    return desktopWorkspaceManager;
  }

  desktopWorkspaceOwner = owner;
  const manager = createDesktopWorkspaceManager({
    owner,
    createView: (options) => new WebContentsView(options),
    partitionPrefix: `murage-desktop-workspace-${randomUUID()}`,
    notify: (state) => {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("desktop-workspace:state", state);
      }
    },
  });
  desktopWorkspaceManager = manager;

  // Native child views outlive the renderer DOM unless we explicitly tear
  // them down. Reloads, renderer crashes and owner destruction all close both
  // panes without retaining their secret-bearing noVNC URLs.
  owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) manager.closeAll();
  });
  owner.webContents.on("render-process-gone", () => manager.closeAll());
  owner.once("closed", () => {
    manager.closeAll();
    if (desktopWorkspaceManager === manager) {
      desktopWorkspaceManager = null;
      desktopWorkspaceOwner = null;
    }
  });
  return manager;
}

function desktopWorkspaceForEvent(event, create = false) {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The desktop workspace is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The desktop workspace belongs to another app window");
  }
  return create ? ensureDesktopWorkspace(owner) : desktopWorkspaceManager;
}

/** The built-in browser: WebContentsViews per bot inside the app window,
 * plus the loopback host the bot's tools call. The host and its in-memory
 * master token live for the whole process; the surface belongs to a
 * window and is rebuilt for every window created — macOS keeps the app
 * alive with none open, and `activate` makes a new one. Never blocks the
 * window: without it the Browser tab simply reports itself unavailable. */
function removeBrowserConnectionDescriptor() {
  try {
    removeBrowserConnectionDescriptorFile({ userData: app.getPath("userData") });
  } catch (error) {
    slog(`could not remove stale browser descriptor: ${error?.message ?? error}`);
  }
}

async function ensureBrowserHost() {
  if (!browserSurfaceIsSupported) {
    removeBrowserConnectionDescriptor();
    throw new Error("The sandboxed built-in browser is not yet available on this platform");
  }
  if (browserHost?.url) return browserHost;
  const candidate = createBrowserHost({ manager: () => browserSurface });
  try {
    await candidate.start();
    if (app.isPackaged) removeBrowserConnectionDescriptor();
    else browserConnectionStore.persist(candidate.descriptor());
    // Publish only after listen + descriptor handling both succeed. A failed
    // candidate is stopped below so the next window can retry cleanly.
    browserHost = candidate;
    if (serverProc) syncBrowserConnection(serverProc);
    return candidate;
  } catch (error) {
    await candidate.stop().catch(() => {});
    throw error;
  }
}

async function startBrowserSurface(owner) {
  if (!browserSurfaceIsSupported) {
    // Never leave a development descriptor behind that could make the server
    // advertise browser tools while the native surface is deliberately gated.
    removeBrowserConnectionDescriptor();
    if (serverProc) syncBrowserConnection(serverProc);
    return;
  }
  let surface = null;
  try {
    surface = createBrowserSurfaceManager({
      owner,
      partitionFor: desktopBrowserPartition,
      profilePartitionFor: desktopBrowserProfilePartition,
      createView: (options) => new WebContentsView(options),
      notify: (state) => {
        if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send("browser:state", state);
      },
      onUserInteraction: (state) => {
        if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send("browser:user-interaction", state);
      },
    });
    for (const botId of browserControlHolds) surface.setHumanControl(botId, true);
    browserSurface = surface;
    await ensureBrowserHost();
    // A renderer reload or crash loses the panel that positioned the views;
    // hide them until a mounted Browser tab lays them out again. The pages
    // themselves stay alive — a bot mid-task must not lose its tab.
    owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) browserSurface?.hideAll();
    });
    owner.webContents.on("render-process-gone", () => browserSurface?.hideAll());
    owner.once("closed", () => {
      surface.closeAll();
      if (browserSurface === surface) browserSurface = null;
    });
    slog(`browser surface ready for window ${owner.id} (host ${browserHost.url})`);
  } catch (error) {
    slog(`browser surface unavailable: ${error?.message ?? error}`);
    surface?.closeAll();
    if (browserSurface === surface) browserSurface = null;
  }
}

function browserSurfaceForEvent(event) {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The browser is available only to the main app window");
  }
  if (!browserSurface) throw new Error("The built-in browser is unavailable");
  return browserSurface;
}

ipcMain.handle("browser:available", () => Boolean(browserSurface && browserHost?.url));
ipcMain.handle("browser:state", (event, botId) => browserSurfaceForEvent(event).state(botId));
ipcMain.handle("browser:layout", (event, botId, bounds, profile, mode, layoutOwner) =>
  browserSurfaceForEvent(event).layout(
    botId,
    bounds ?? null,
    Object.prototype.toString.call(profile) === "[object String]" ? profile : undefined,
    mode === "expanded" ? "expanded" : "compact",
    Object.prototype.toString.call(layoutOwner) === "[object String]" && layoutOwner.length <= 128
      ? layoutOwner
      : undefined,
  ),
);
const browserProfileFromRenderer = (profile) =>
  Object.prototype.toString.call(profile) === "[object String]" ? profile : undefined;

ipcMain.handle("browser:forward", async (event, botId, profile) => {
  const result = await browserSurfaceForEvent(event).forward(botId, browserProfileFromRenderer(profile), { source: "user" });
  return { url: result.url, title: result.title };
});
ipcMain.handle("browser:reload", async (event, botId, profile) => {
  const result = await browserSurfaceForEvent(event).reload(botId, browserProfileFromRenderer(profile), { source: "user" });
  return { url: result.url, title: result.title };
});
ipcMain.handle("browser:navigate", async (event, botId, url, profile) => {
  const result = await browserSurfaceForEvent(event).navigate(botId, url, browserProfileFromRenderer(profile), { source: "user" });
  return { url: result.url, title: result.title };
});
ipcMain.handle("browser:back", async (event, botId, profile) => {
  const result = await browserSurfaceForEvent(event).back(botId, browserProfileFromRenderer(profile), { source: "user" });
  return { url: result.url, title: result.title };
});
ipcMain.handle("browser:set-human-control", (event, botId, held, profile) => {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The browser is available only to the main app window");
  }
  const id = String(botId ?? "");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error("A bot id is required");
  // Computer takeover is bot-wide even when the native browser is absent.
  // Remember the gate now; startBrowserSurface applies it before publishing
  // a future surface or exposing its host. Release clears that remembered gate.
  if (!browserSurface) {
    if (held === true) browserControlHolds.add(id);
    else browserControlHolds.delete(id);
    return true;
  }
  const surface = browserSurface;
  const applied = surface.setHumanControl(id, held === true, browserProfileFromRenderer(profile));
  if (held === true) browserControlHolds.add(id);
  else browserControlHolds.delete(id);
  return applied;
});
ipcMain.handle("browser:close", (event, botId) => browserSurfaceForEvent(event).close(botId));
// Deleting a profile: every bot's view on it goes, then its cookies, storage
// and cache. The partition directory itself is left for Chromium to reuse
// (removing it while the session object lives is the EBUSY trap every
// Electron app with profiles has hit); nothing identifying remains in it.
ipcMain.handle("browser:forget-profile", async (event, partitionId) => {
  const surface = browserSurfaceForEvent(event);
  const id = String(partitionId ?? "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || id === "guest") throw new Error("That browser partition id is invalid");
  const dropped = surface.forgetProfile(id);
  browserHost?.revokeCapabilitiesForProfile(id);
  await clearBrowserPartition(desktopBrowserProfilePartition(id));
  return { dropped };
});

ipcMain.on("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
});

// Synchronous on purpose: the preload reads this once while the page is
// still loading, so the first `fetch` and the first `EventSource` already
// carry the proof. An async invoke would leave a window in which the app's
// own hydration looked like a paired phone's.
//
// "" in development — there is no forked child to have sent one, and the dev
// renderer asks the harness directly instead (GET /api/desktop-secret).
ipcMain.on("desktop:surface-secret", (event) => {
  event.returnValue = desktopSurfaceSecret;
});

ipcMain.on("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

function showDesktopRecovery(reasonCode = "STARTUP_FAILED") {
  desktopRecoveryMode = true;
  serverReady = false;
  if (recoveryWindow && !recoveryWindow.isDestroyed()) { recoveryWindow.focus(); return recoveryWindow; }
  const ownership = reasonCode === "LEASE_FOREIGN_HOST" && desktopDataDir ? inspectDataDirLease(desktopDataDir) : null;
  const reason = reasonCode === "LEASE_FOREIGN_HOST"
    ? "This installation has an ownership record for a different computer name. This does not establish that your data is damaged. Reinstalling Murage will not clear this record."
    : reasonCode === "RESTORE_REVIEW_REQUIRED"
    ? "This restored installation is paused for recovery review. Your previous installation remains retained."
    : reasonCode === "PORT_CONFLICT"
      ? "Another process answered on Murage's ports. Close that process before retrying startup; restoring data will not resolve a port conflict."
      : "Murage could not finish startup. Keep the original installation while you inspect recovery options.";
  const recovery = openInstallationRecoveryWindow({
    BrowserWindow, ipcMain, dialog, baseDir: __dirname,
    context: { reason, ownership, dataDirectory: desktopDataDir, skin: readPersistedSkin() ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light") },
    isAvailable: () => Boolean(desktopDataOwner && desktopDataDir && !desktopShutdownStarted),
    run: runDesktopRecovery,
    retry: async () => { app.relaunch(); app.quit(); },
    openDiagnostics: async () => { const error = await shell.openPath(LOG_DIR); if (error) throw new Error("DIAGNOSTICS_UNAVAILABLE"); },
    onClosed: () => { recoveryWindow = null; },
  });
  recoveryWindow = recovery.window;
  void recovery.loaded.catch(() => {
    dialog.showErrorBox("Murage recovery could not open", "Installation data was preserved. Check the local diagnostics, then reopen Murage.");
    app.quit();
  });
  if (!recoveryActivateRegistered) {
    recoveryActivateRegistered = true;
    app.on("activate", () => {
      if (desktopRecoveryMode && !desktopShutdownStarted && !recoveryWindow) showDesktopRecovery(reasonCode);
    });
  }
  return recoveryWindow;
}

async function runDesktopRecovery(operation, parameters) {
  if (!desktopRecoveryMode || desktopShutdownStarted || !desktopDataOwner || !desktopDataDir) throw Object.assign(new Error("Recovery unavailable"), { code: "RECOVERY_OWNERSHIP_REQUIRED" });
  const args = operation === "plan-restore" ? ["plan-restore", "--archive", parameters.archive]
    : operation === "review" ? ["review", "--data-dir", desktopDataDir]
    : operation === "activate" ? ["activate", "--data-dir", desktopDataDir, "--review-hash", parameters.reviewHash]
    : operation === "backup" ? ["backup", "--data-dir", desktopDataDir, "--output", parameters.output]
    : operation === "restore" ? ["restore", "--data-dir", desktopDataDir, "--archive", parameters.archive, "--sha256", parameters.sha256]
    : operation === "rollback" ? ["rollback", "--data-dir", desktopDataDir] : null;
  if (!args || args.some(value => typeof value !== "string" || !value)) throw Object.assign(new Error("Invalid recovery request"), { code: "INVALID_RECOVERY_REQUEST" });
  await awaitOwnedWork(desktopStartup.catch(() => {}), "Desktop startup has not settled");
  await awaitOwnedWork(Promise.all([...ownedServerChildren].map(child => child.stop())), "Owned writers have not exited");
  serverProc = null;
  await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");
  await awaitOwnedWork(Promise.all([...companionStarts]), "Companion startup has not settled");
  await awaitOwnedWork(stopDesktopCompanion({ remember: false }), "Companion has not stopped");
  await awaitOwnedWork(Promise.all([...browserLifecycleCleanups.values()]), "Browser cleanup has not settled");
  browserSurface?.closeAll();
  await awaitOwnedWork(browserHost?.stop() ?? Promise.resolve(), "Browser host has not stopped");
  await awaitOwnedWork(cuaReady, "Computer-use startup has not settled");
  await awaitOwnedWork(stopCua(), "Computer-use cleanup has not completed");
  if (desktopShutdownStarted || !desktopDataOwner) throw Object.assign(new Error("Recovery unavailable"), { code: "RECOVERY_OWNERSHIP_REQUIRED" });
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (operation !== "plan-restore") Object.assign(env, desktopDataOwner.utilityServerLeaseEnvironment());
  return runInstallationRecoveryWorker({
    fork: (entry, argv, options) => utilityProcess.fork(entry, argv, options),
    entry: path.join(process.resourcesPath, "server", "installation-recovery-worker.js"),
    args, env, track: trackOwnedServerChild,
  });
}

function initializeBackgroundLifecycle(){
  const profileDir=desktopDataDir??(process.env.MURAGE_DATA_DIR&&process.env.MURAGE_USER_DATA?fs.realpathSync(process.env.MURAGE_DATA_DIR):null);
  const preferenceFile=profileDir?path.join(profileDir,"startup-background.json"):null;
  const primaryPath=path.join(app.getPath("home"),".murage");
  const login=createBackgroundLogin({platform:process.platform,app,installed:app.isPackaged,primaryProfile:profileDir===(fs.existsSync(primaryPath)?fs.realpathSync(primaryPath):primaryPath),profileDir,userDataDir:app.getPath("userData"),executable:process.env.APPIMAGE??app.getPath("exe"),autostartDir:path.join(path.isAbsolute(process.env.XDG_CONFIG_HOME??"")?process.env.XDG_CONFIG_HOME:path.join(app.getPath("home"),".config"),"autostart")});
  const automation=async(paused)=>{
    if(!serverReady||!desktopSurfaceSecret)throw new Error("Automatic-work controls are unavailable until the desktop server is ready.");
    const response=await fetch(`http://127.0.0.1:${SERVER_PORT}/api/automation-admission`,{method:paused===undefined?"GET":"POST",headers:{"content-type":"application/json","x-murage-surface":"desktop","x-murage-surface-secret":desktopSurfaceSecret},...(paused===undefined?{}:{body:JSON.stringify({paused})}),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error("Automatic-work settings could not be confirmed.");
    const value=await response.json();if(typeof value.paused!=="boolean")throw new Error("Automatic-work status is unavailable.");return value;
  };
  backgroundLifecycle=createBackgroundLifecycle({platform:process.platform,login,window:()=>mainWindow,isQuitting:()=>desktopShutdownStarted,serviceReady:()=>serverReady,
    preferencesWritable:()=>Boolean(preferenceFile),
    loadPreferences:()=>{try{if(!preferenceFile)return {};const stat=fs.lstatSync(preferenceFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)return {};return JSON.parse(fs.readFileSync(preferenceFile,"utf8"));}catch{return {};}},
    savePreferences:value=>{if(!preferenceFile)throw new Error("An owned installation is required to save startup settings.");if(app.isPackaged)ownedDesktopDataDir();const temporary=`${preferenceFile}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,preferenceFile);},
    dockAvailable:()=>process.platform==="darwin"&&app.dock?.isVisible()===true,
    createTray:onOpen=>{const icon=nativeImage.createFromPath(APP_ICON).resize({width:18,height:18});if(process.platform==="darwin")icon.setTemplateImage(true);const tray=new Tray(icon);tray.setToolTip("Murage");tray.on("click",onOpen);return tray;},
    setTrayMenu:(tray,items)=>tray.setContextMenu(Menu.buildFromTemplate(items)),
    probeTray:tray=>process.platform==="linux"?linuxTrayHostAvailable(execFile):(()=>{try{const bounds=tray.getBounds();return bounds.width>0&&bounds.height>0;}catch{return false;}})(),
    openWindow:()=>{const win=mainWindow&&!mainWindow.isDestroyed()?mainWindow:createWindow();if(win.isMinimized())win.restore();win.show();win.focus();},
    openInbox:()=>{const win=mainWindow;if(!win||win.isDestroyed())return;const send=()=>{if(!win.isDestroyed())win.webContents.send("startup-background:open-inbox");};if(win.webContents.isLoadingMainFrame())win.webContents.once("did-finish-load",send);else send();},
    explainClose:async win=>{const options={type:"info",title:"Murage stays available",message:"Closing this window keeps Murage running.",detail:"Use the Murage menu bar or tray icon to reopen it, open Inbox or quit. Automatic work only runs while Murage is open and this computer is awake. Change this in Settings → General → Startup & background.",buttons:["Keep running","Quit Murage"],defaultId:0,cancelId:0};const result=win?await dialog.showMessageBox(win,options):await dialog.showMessageBox(options);return result.response===1?"quit":"keep";},
    automationStatus:()=>automation(),setAutomationsPaused:paused=>automation(paused),quit:()=>app.quit(),
    onChange:state=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send("startup-background:changed",state);},
    onError:error=>{slog(`startup/background: ${error.message}`);},
  });
  return {lifecycle:backgroundLifecycle,login};
}
function backgroundForEvent(event){
  if(!mainWindow||mainWindow.isDestroyed()||event.sender!==mainWindow.webContents||event.senderFrame!==event.sender.mainFrame||new URL(event.senderFrame.url).origin!==rendererOrigin()||!backgroundLifecycle)throw new Error("Startup settings are available only in the main Murage window.");
  return backgroundLifecycle;
}
ipcMain.handle("startup-background:status",event=>backgroundForEvent(event).status());
ipcMain.handle("startup-background:update",(event,patch)=>backgroundForEvent(event).update(patch));

function createWindow({quiet=false}={}) {
  if (app.isPackaged && desktopRecoveryMode) return showDesktopRecovery();
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  // The palette the last session resolved, or — on a genuinely first run — what
  // the OS is doing right now, which is also what the renderer's "auto" default
  // will resolve to. Either way the very first frame is the right colour.
  persistedSkin = readPersistedSkin() ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: 900,
    minHeight: 600,
    // Shown immediately. This used to stay hidden on Windows until the
    // `desktop:skin` handshake recoloured the native caption overlay — but that
    // handler never called show(), nothing ever calls setTitleBarOverlay, and
    // windowChromeOptions() returns {} on Windows, so there was no overlay to
    // wait for and every Windows cold start sat invisible for the full 5s
    // fallback. With backgroundColor now theme-correct there is nothing left to
    // hide.
    show: !quiet,
    icon: APP_ICON,
    backgroundColor: skinChrome(persistedSkin).color,
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow = win;
  win.on("close",event=>backgroundLifecycle?.handleClose(event));
  win.on("query-session-end",()=>backgroundLifecycle?.beginQuit());
  win.on("session-end",()=>backgroundLifecycle?.beginQuit());
  attachUpdaterWindow(win);
  // Browser execution and viewing are owned by the unified harness engine.
  installWindowStatePersistence(win);
  applyUnreadBadge(win);
  if (restored.maximized&&!quiet) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-finish-load", () => deliverPackageInstall(win));

  // A renderer crash used to leave NO trace anywhere. RootErrorBoundary logs
  // "Murage failed to render" to the renderer console, and the renderer
  // console is not the terminal -- so a black window was the only artefact a
  // developer or a packaged user ever saw. That is the exact mystery the
  // boundary's own header comment says it exists to prevent, undone one
  // process boundary later.
  //
  // Errors and warnings only: forwarding `info` would tee every log the app
  // makes into the terminal it was never written for.
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    console.error(`[renderer] ${message}${sourceId ? ` (${sourceId}:${line})` : ""}`);
  });
  // The renderer dying outright -- OOM, a GPU fault, a killed process. Same
  // symptom as a render throw (black window), completely different cause, and
  // previously indistinguishable from it.
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exitCode ${details.exitCode})`);
  });
  // The dev server being down is the other black-window cause, and it is the
  // one that has actually bitten: Electron loads DEV_URL once and never
  // retries, so a vite that died during sleep leaves a window with nothing in
  // it and no message.
  win.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[renderer] failed to load ${failedUrl}: ${description} (${code})`);
  });

  // Native context menu for text inputs — without this, right-click does
  // nothing in the Electron window (no Cut/Copy/Paste/Select All).
  win.webContents.on("context-menu", (_event, params) => {
    // nothing actionable here — no menu at all, rather than a wall of
    // disabled items
    if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
    const menuItems = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuItems.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      if (menuItems.length) menuItems.push({ type: "separator" });
    }
    if (params.linkURL) {
      menuItems.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    menuItems.push(
      { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
      { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
      { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
      pasteMenuItem(params, clipboard, win.webContents),
      { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
    );
    Menu.buildFromTemplate(menuItems).popup({ window: win, frame: params.frame });
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (process.env.MURAGE_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.muragebox?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.MURAGE_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.muragebox.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, healthResponse] = await Promise.all([
              window.muragebox.getCapabilities(),
              fetch("/api/health"),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.muragebox.localControl.retry();
              capabilities = await window.muragebox.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.MURAGE_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.MURAGE_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

// Local-control screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
ipcMain.handle("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
});

ipcMain.handle("engine:open-setup-terminal", async (event, input) => {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame
    || !input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["instanceId", "action"].includes(key))
    || typeof input.instanceId !== "string" || input.instanceId.length > 180
    || !["install", "connect"].includes(input.action) || !desktopSurfaceSecret) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/engine-setup-command`, {
      method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || typeof result.command !== "string" || !result.command.trim() || result.command.length > 2000) return false;
    clipboard.writeText(result.command);
    return openBlankTerminal();
  } catch { return false; }
});

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
ipcMain.handle("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// One-click bug-report bundle. Secrets are never read; the report is
// redacted again on the way out (diagnostics.mjs). null means the user
// cancelled the save dialog.
ipcMain.handle("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
});

// Bots hand users files as markdown links to paths inside the Murage
// home (workspaces, attachments). As plain anchors those resolved against the
// page origin, so the click opened http://127.0.0.1:8799<path> in the default
// browser and the server's SPA fallback answered with index.html — a second
// copy of the chat UI instead of the file. Ask where to put it and copy it
// there instead: a save dialog tells the user the file landed somewhere and
// where, which a silent copy into ~/Downloads does not. The path is
// renderer-controlled, so it must resolve inside ~/.murage and be a
// regular file — never a symlink escape or directory.
ipcMain.handle("desktop:reveal-workspace", async (event, botId, threadId) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const expectedOrigin = new URL(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
  if (!parent || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== expectedOrigin
    || [botId, threadId].some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) || !desktopSurfaceSecret) throw new Error("Working folder is unavailable here.");
  const query = new URLSearchParams({ botId, threadId });
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/artifacts/workspace?${query}`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret }, signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!response.ok) throw new Error("Working folder is unavailable. Refresh Files.");
  const result = await response.json();
  if (typeof result.path !== "string" || !path.isAbsolute(result.path)) throw new Error("Working folder could not be verified.");
  const stat = fs.lstatSync(result.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Working folder changed. Refresh Files.");
  const error = await shell.openPath(result.path);
  if (error) throw new Error("The operating system could not open this folder.");
});

ipcMain.handle("desktop:artifact-action", async (event, id, action) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const expectedOrigin = new URL(app.isPackaged ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
  if (!parent || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== expectedOrigin
    || typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !["open", "reveal"].includes(action) || !desktopSurfaceSecret) throw new Error("File action is unavailable here.");
  const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/artifacts/${id}/native`, {
    headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret }, signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error("This saved file is unavailable. Refresh Files.");
  const record = await response.json();
  if (action === "open" && record.kind === "html") {
    const decision = await dialog.showMessageBox(parent, { type: "warning", title: "Open HTML report?", message: "Your browser may run scripts or access the network when opening this file. Use Preview in Murage for an isolated view.", buttons: ["Cancel", "Open in browser"], defaultId: 0, cancelId: 0 });
    if (decision.response !== 1) return;
  }
  const savedPath = verifiedArtifactNativePath(record, ownedDesktopDataDir());
  if (action === "open" && ![".html", ".htm", ".txt", ".md", ".csv", ".json", ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(path.extname(savedPath).toLowerCase())) {
    throw new Error("This file type cannot be opened directly by Murage. Download or reveal it for manual review.");
  }
  if (action === "reveal") shell.showItemInFolder(savedPath);
  else { const error = await shell.openPath(savedPath); if (error) throw new Error("The operating system could not open this file. Download it instead."); }
});

ipcMain.handle("desktop:save-file", async (event, rawPath) => {
  return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    // Cancelling is a decision, not a failure — the bubble stays quiet.
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
});

// The renderer owns the palette. Native Windows/Linux chrome is intentionally
// outside that surface; acknowledge the renderer handshake without creating a
// frameless caption overlay that can cover page controls.
//
// This takes a RESOLVED id ("light" | "dark"), never the "auto" preference:
// isKnownSkin("auto") is false, so a caller that piped the preference through
// would be rejected here rather than silently getting dark chrome on a light
// desktop. Recording it is what makes the NEXT cold start open with the right
// window background instead of a black rectangle.
ipcMain.handle("desktop:skin", (_event, skin) => {
  if (!isKnownSkin(skin)) return false;
  if (skin !== persistedSkin) {
    persistedSkin = skin;
    writeWindowState(mainWindow);
  }
  return true;
});

ipcMain.handle("desktop:open-external", async (_event, rawUrl) => {
  if (typeof rawUrl !== "string") throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  await shell.openExternal(url.toString());
  return true;
});

// The Box VNC viewer must be a top-level page for its token exchange. A
// sandboxed modal BrowserWindow satisfies that requirement while keeping the
// live desktop inside Murage instead of sending the person to a browser.
ipcMain.handle("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
});

// Two Local VM desktops share the existing app BrowserWindow. The renderer
// supplies only layout and intent; URL validation, sandboxing, session
// isolation and the one-interactive-pane invariant stay in the main process.
ipcMain.handle("desktop-workspace:open", (event, input) =>
  desktopWorkspaceForEvent(event, true).open(input),
);
ipcMain.handle("desktop-workspace:layout", (event, items) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return false;
  return manager.layout(items);
});
ipcMain.handle("desktop-workspace:set-interactive", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return contextId == null;
  return manager.setInteractive(contextId);
});
ipcMain.handle("desktop-workspace:close", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return true;
  return manager.close(contextId);
});

// Close only when the caller owns the current viewer — otherwise one bot's
// "Hand control back" would close (and release) another bot's viewer.
ipcMain.handle("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
});

// Lets a (re)mounted panel seed viewer-open state instead of defaulting to false.
ipcMain.handle("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
}));

ipcMain.handle("perm:status", () => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  // own-property lookup only — a renderer-supplied "__proto__"/"constructor"
  // would otherwise resolve up the prototype chain to a truthy object
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

ipcMain.handle("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
});
ipcMain.handle("speech:stop", () => {
  if (nativeActions.appleSpeech) stopSpeech();
});
ipcMain.handle("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
});

ipcMain.handle("skill-recorder:permissions", () => recorderPermissionStatus());
ipcMain.handle("skill-recorder:start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("The recorder window is unavailable");
  return startRecorder(win);
});
ipcMain.handle("skill-recorder:stop", () => stopRecorder());
ipcMain.handle("skill-recorder:save", (_event, payload) => saveSkillRecording(payload));

// ── companion sidecar ──────────────────────────────────────────────────
// The renderer gets these and nothing else: it can turn the companion on and
// off, look at it, ask it to re-read Tailscale, open or cancel a pairing
// window, and remove a device. It cannot reach the sidecar's control port
// itself.
ipcMain.handle("companion:state", () => desktopCompanionState());
ipcMain.handle("companion:start", () => startDesktopCompanion());
ipcMain.handle("companion:stop", () => stopDesktopCompanion());
ipcMain.handle("companion:keep-awake", async (_event, enabled) => {
  rememberCompanionKeepAwake(Boolean(enabled));
  return desktopCompanionState();
});
ipcMain.handle("companion:refresh-tailscale", () => refreshDesktopCompanionTailscale());
ipcMain.handle("companion:remote-access", (_event, enabled) =>
  setDesktopCompanionRemoteAccess(Boolean(enabled)),
);
ipcMain.handle("companion:pairing", (_event, open, expectedToken) =>
  companionPairing(Boolean(open), expectedToken).then(decorateDesktopCompanionState),
);
ipcMain.handle("companion:cloud-desktop", (_event, deviceId, allowed) =>
  companionCloudDesktopAccess(deviceId, Boolean(allowed)).then(() => desktopCompanionState()),
);
ipcMain.handle("companion:revoke", (_event, deviceId) =>
  companionRevoke(deviceId).then(() => desktopCompanionState()),
);

// Auth and connector credentials never cross this boundary. Every handler
// returns the same deliberately tiny, secret-free public account state.
ipcMain.handle("companion-account:state", () => ensureCompanionAccountService().state());
ipcMain.handle("companion-account:request-code", (_event, email) =>
  ensureCompanionAccountService().requestCode(email),
);
ipcMain.handle("companion-account:verify-code", (_event, email, code) =>
  ensureCompanionAccountService().verifyCode(email, code),
);
ipcMain.handle("companion-account:retry", () => ensureCompanionAccountService().retry());
ipcMain.handle("companion-account:sign-out", () => ensureCompanionAccountService().signOut());

ipcMain.handle("desktop:capabilities", async () =>
  desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  }),
);

ipcMain.handle("assemblyai:status", () => ({
  configured: Boolean(assemblyAICredential(secureCredentials)),
}));

ipcMain.handle("assemblyai:set-key", async (_event, value) => {
  if (typeof value !== "string") throw new Error("Unsupported credential");
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  await updateSecureCredentialDocument((credentials) => {
    if (secret) credentials.assemblyAiApiKey = secret;
    else delete credentials.assemblyAiApiKey;
    return credentials;
  });
  return { configured: Boolean(secret) };
});

ipcMain.handle("assemblyai:streaming-token", () =>
  mintAssemblyAIStreamingToken(assemblyAICredential(secureCredentials)),
);

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  tavilySearchApiKey: (value) => ({ webSearch: { tavilyApiKey: value } }),
  exaSearchApiKey: (value) => ({ webSearch: { exaApiKey: value } }),
  firecrawlSearchApiKey: (value) => ({ webSearch: { firecrawlApiKey: value } }),
  telegramBotToken: (value) => ({ telegram: { botToken: value } }),
};

ipcMain.handle("model-provider:mutate", async (_event, input) => {
  if (!desktopSurfaceSecret) throw new Error("Desktop authorization is not ready. Try again shortly.");
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("The operating-system credential store is unavailable");
  return mutateProviderCredentials(input, {
    packaged: app.isPackaged, updateDocument: updateSecureCredentialDocument, createId: randomUUID,
    post: async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, {
        method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret, authorization: `Bearer ${modelProviderCommitToken}` }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "Could not save model connection.");
      return result;
    },
  });
});

ipcMain.handle("credential:set", async (_event, name, value) => {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const applyToHarness = async () => {
    // In development the server is a separately launched process, so it
    // cannot receive credentials from Electron at boot. Keep its established
    // local config path there; production always uses the encrypted store.
    const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
    if (!desktopSurfaceSecret) throw new Error("Desktop authorization is not ready. Wait and retry saving the credential.");
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-murage-surface": "desktop",
        "x-murage-surface-secret": desktopSurfaceSecret,
      },
      body: JSON.stringify(patchFor(secret)),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
    return body;
  };
  if (!app.isPackaged) return applyToHarness();

  // Commit the encrypted value before the server makes it live. The shared
  // state rolls credentials.bin back if validation/reload fails, while also
  // keeping concurrent account and provider updates serialized.
  return updateSecureCredentialDocument(
    (credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    },
    applyToHarness,
  );
});

async function broadcastDesktopCapabilities() {
  const capabilities = desktopCapabilities({
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
  });
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("desktop:capabilities-changed", capabilities);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

const desktopStartup = app.whenReady().then(async () => {
  assertDesktopStartupActive();
  if (app.isPackaged) acquireDesktopDataOwner();
  if (app.isPackaged) {
    assertRestoreReviewed(ownedDesktopDataDir());
    // The child receives a canonical explicit override, so only this parent
    // can decide whether this was originally the default legacy installation.
    // Both target ownership and source ownership precede the rename.
    migrateLegacyDataDirectory({
      dataDir: ownedDesktopDataDir(),
      legacyDataDir: path.join(app.getPath("home"), ".opengrokbot"),
      enabled: process.env.MURAGE_DATA_DIR === undefined,
    });
    assertRestoreReviewed(ownedDesktopDataDir());
  }
  if (app.isPackaged) app.setAsDefaultProtocolClient("murage");
  configureRestoredDesktopConnections();
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  secureCredentials = await loadSecureCredentials();
  assertDesktopStartupActive();
  if (app.isPackaged) {
    await secureComposioConfig();
    assertDesktopStartupActive();
    await secureWorkspaceConfig();
    assertDesktopStartupActive();
  }
  // Boot migrations above are deliberately sequential. From this point on,
  // every account/API-key writer must use the shared serialized state.
  // An unreadable store must not become a WRITE of an empty document.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
  });
  secureCredentials = secureCredentialState.read();
  const hostedAccount = ensureCompanionAccountService();
  // Display capture remains user-initiated. The renderer first sends a
  // short-lived one-shot intent, then calls getDisplayMedia in the same click.
  // The handler binds that request to the same frame/origin, rejects audio,
  // and requires Electron's active user-gesture signal.
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        displayMediaRequestCount += 1;
        if (!displayMediaGuard.consume(request, rendererOrigin())) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        const capabilities = desktopCapabilities({
          platform: process.platform,
          env: process.env,
          packaged: app.isPackaged,
        });
        const captureHost =
          process.platform === "darwin" ? "darwin" : capabilities.host.session;
        if (!capabilities.screenPreview.available) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = selectCaptureSource({
              sources,
              host: captureHost,
              primaryDisplayId:
                process.platform === "linux" && captureHost === "x11"
                  ? screen.getPrimaryDisplay().id
                  : null,
            });
            if (!source) {
              console.warn(
                `[screen-preview] rejected ${captureHost} source set (${sources.length} candidates)`,
              );
            }
            respondToDisplayMediaRequest(callback, source ? { video: source } : {});
          })
          .catch((error) => {
            console.warn("[screen-preview] source discovery failed:", error);
            respondToDisplayMediaRequest(callback, {});
          });
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  androidDevice.registerIpc(ipcMain);
  registerUpdaterIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  cuaReady =
    process.platform === "darwin" || process.platform === "linux"
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  if (app.isPackaged) {
    // The embedded harness receives this descriptor only over its private
    // utility-process port. Never leave the master token in userData where a
    // shell-capable bot running as the same OS user could read it.
    removeBrowserConnectionDescriptor();
    await ensureBrowserHost().catch((error) => {
      slog(`browser host unavailable before server start: ${error?.message ?? error}`);
    });
    assertDesktopStartupActive();
    serverReady = await startServerPackaged();
  }
  assertDesktopStartupActive();
  // The companion the user left on comes back without anyone finding the
  // toggle again — one attempt, after the harness port is settled, with the
  // exact options the IPC handler uses. A failure surfaces in companionState
  // (the panel shows the error) rather than retrying; and it never delays
  // the window.
  if (app.isPackaged && !serverReady) {
    showDesktopRecovery(serverStartConflictOnly ? "PORT_CONFLICT" : "STARTUP_FAILED");
    return;
  }
  if (serverReady && companionEnabledAtRest()) {
    void startDesktopCompanion({ waitForHosted: false, remember: false }).catch(() => {
      if (!desktopShutdownStarted) slog("companion startup did not complete");
    });
  }
  const background=initializeBackgroundLifecycle();
  const backgroundReady=background.lifecycle.start();
  const loginLaunch=background.login.launchedAtLogin();
  if(loginLaunch)await backgroundReady;else void backgroundReady.catch(error=>slog(`background startup: ${error.message}`));
  assertDesktopStartupActive();
  if(mainWindow&&!mainWindow.isDestroyed())background.lifecycle.open();
  else createWindow({quiet:loginLaunch&&background.lifecycle.shouldStartQuietly()});
  powerMonitor.on("suspend",()=>backgroundLifecycle?.setSuspended(true));
  powerMonitor.on("resume",()=>backgroundLifecycle?.setSuspended(false));
  powerMonitor.on("shutdown",()=>backgroundLifecycle?.beginQuit());
  // Reconcile incomplete setup and resume interrupted sign-out only after the
  // local app is usable. This background network work never gates LAN pairing
  // or the first window.
  void hostedAccount.restore().catch(() => {});
  // Registration is optional network work. Start it only after the local
  // server and first window are usable, then update the server child over its
  // private parent port so Connected Apps becomes available without restart.
  // Registering while the store is unreadable would mint a SECOND installation
  // identity for a user who already has one — the first thing they would
  // notice is every connected app gone, permanently.
  if (credentialStoreUnavailable) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (app.isPackaged && composioBrokerUrl() && !credentialStoreUnavailable) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        timeoutSignal: (milliseconds) => AbortSignal.any([
          managedComposioShutdown.signal,
          AbortSignal.timeout(milliseconds),
        ]),
        // The shared credential state performs the one atomic encrypted
        // write after this registration has derived its complete document.
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials).catch(() => {
      if (!desktopShutdownStarted) slog("connected-apps registration did not complete");
    });
  }
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater({ beforeInstall: () => prepareUpdaterRestart({
    environment: process.env,
    isClosing: () => desktopShutdownStarted,
    isCleanedUp: () => cuaCleanedUp,
    readActivity: async () => {
      if (!serverReady || !desktopSurfaceSecret) throw new Error("Updater activity check unavailable");
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/bots?messages=0`, {
        headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": desktopSurfaceSecret },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Updater activity check unavailable");
      return response.json();
    },
    cleanup: cleanupDesktopForExit,
  }) });
  app.on("activate", () => {
    if (!desktopShutdownStarted)backgroundLifecycle?.open();
  });
});
void desktopStartup.catch((error) => {
  if (!desktopShutdownStarted) {
    // Lease errors are sanitized by the lease module; arbitrary child/errors
    // may carry credentials or paths and must not be echoed to diagnostics.
    const recoveryError = error?.name === "DataDirLeaseError" || error?.name === "DataDirMigrationError";
    const detail = recoveryError
      ? `${error.message} Close the other Murage process or resolve the installation ownership problem, then reopen Murage. No new workspace was created.`
      : "Murage could not finish desktop startup. Installation data was preserved. Check the local startup diagnostics, then reopen Murage.";
    slog(`desktop startup refused (${recoveryError ? error.code : "STARTUP_FAILED"})`);
    if (app.isPackaged) {
      try {
        showDesktopRecovery(error?.code === "RESTORE_REVIEW_REQUIRED" ? "RESTORE_REVIEW_REQUIRED"
          : recoveryError && error.code === "LEASE_FOREIGN_HOST" ? "LEASE_FOREIGN_HOST" : "STARTUP_FAILED");
        return;
      } catch { /* The native error box remains the last-resort fallback. */ }
    }
    dialog.showErrorBox("Murage could not open this installation", detail);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if(backgroundLifecycle?!backgroundLifecycle.keepAliveWithoutWindows():process.platform!=="darwin")app.quit();
});
app.on("will-quit",()=>backgroundLifecycle?.dispose());

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
// Deadlines report incomplete cleanup; they never authorize releasing a live
// installation writer. The person may retry Quit or force quit through the OS.
const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
let desktopCleanup = null;
let desktopCleanupStage = "owned harness";
let signalQuitRequested = false;

// Package managers, desktop watchdogs, and terminal launchers commonly stop
// Linux apps with SIGTERM/SIGINT. Convert the first signal into Electron's
// normal quit path so the embedded server, Cua descriptor/socket, and private
// AppImage stage receive the same bounded cleanup as a window close. A second
// signal keeps Node's default force-quit behavior because these are `once`
// listeners.
const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

function cleanupDesktopForExit() {
  desktopShutdownStarted = true;
  // Optional hosted registration must not hold the credential queue open for
  // its network timeout. Cancel the request, then drain actual writes below.
  managedComposioShutdown.abort();
  if (cuaCleanedUp) return Promise.resolve();
  if (desktopCleanup) return desktopCleanup;
  // Release the sleep blocker synchronously; child shutdown is awaited below.
  syncCompanionKeepAwake(false, false);
  // a live dictation session runs its own helper child that holds the mic —
  // stop it here so quitting never orphans a recording process
  if (nativeActions.appleSpeech) stopSpeech();
  stopRecorder();
  try {
    browserSurface?.closeAll();
  } catch {}
  desktopCleanup = (async () => {
    // Children are registered before their first await, including failed
    // port attempts that never became serverProc. Stop those first so boot
    // identity polling can settle, then drain any in-flight parent writers.
    desktopCleanupStage = "owned harness";
    await awaitOwnedWork(Promise.all([...ownedServerChildren].map((child) => child.stop())), "The owned harness has not exited");
    desktopCleanupStage = "desktop startup";
    await awaitOwnedWork(desktopStartup.catch(() => {}), "Desktop startup has not settled");
    desktopCleanupStage = "credential writes";
    await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");
    desktopCleanupStage = "companion startup";
    await awaitOwnedWork(Promise.all([...companionStarts]), "Companion startup has not settled");
    desktopCleanupStage = "owned companion";
    await awaitOwnedWork(stopDesktopCompanion({ remember: false }), "The owned companion has not stopped");
    desktopCleanupStage = "browser cleanup";
    await awaitOwnedWork(Promise.all([...browserLifecycleCleanups.values()]), "Browser cleanup has not settled");
    desktopCleanupStage = "browser host";
    await awaitOwnedWork(browserHost?.stop() ?? Promise.resolve(), "The owned browser host has not stopped");
    desktopCleanupStage = "computer-use startup/cleanup";
    await awaitOwnedWork(cuaReady, "Computer-use startup has not settled", CUA_STOP_TIMEOUT_MS);
    await awaitOwnedWork(stopCua(), "Computer-use cleanup has not completed", CUA_STOP_TIMEOUT_MS);
    desktopCleanupStage = "installation lease release";
    if (desktopDataOwner) {
      desktopDataOwner.release();
      desktopDataOwner = null;
    }
    cuaCleanedUp = true;
  })();
  const operation = desktopCleanup;
  void operation.finally(() => { if (desktopCleanup === operation) desktopCleanup = null; }).catch(() => {});
  return operation;
}

app.on("before-quit", (e) => {
  backgroundLifecycle?.beginQuit();
  if (cuaCleanedUp) return;
  e.preventDefault();
  const alreadyClosing = Boolean(desktopCleanup);
  const operation = cleanupDesktopForExit();
  if (alreadyClosing) return;
  void operation.then(() => app.quit()).catch(() => {
    slog(`desktop cleanup incomplete (${desktopCleanupStage}); installation ownership retained`);
    dialog.showErrorBox("Murage is still closing", `Cleanup is waiting on ${desktopCleanupStage}. Installation ownership was kept. Wait, then try Quit again. You can force quit through your operating system, but that is not a verified clean shutdown.`);
  });
});
