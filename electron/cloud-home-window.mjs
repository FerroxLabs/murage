// Murage Cloud B3 WP1: the cloud-home window and its Electron wiring.
//
// installCloudHome() is the ONLY thing main.mjs calls. With the Cloud flag off
// it returns null and touches nothing (no scheme, no session, no window), so a
// flag-off desktop is byte-for-byte the train. With the flag on it registers
// the privileged scheme (this must happen before app ready) and returns a
// controller; the window itself opens only when something calls open(homeId).
//
// The cloud window has NO preload and no bridge in WP1 (WP3 classifies the
// channels). Its top frame may load murage-home asar paths only.

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CLOUD_HOME_SCHEME, CLOUD_HOME_SCHEME_PRIVILEGES, cloudHomeEntryUrl, cloudPartition,
  createCloudHomeHandler, isValidHomeId,
} from "./cloud-home-protocol.mjs";
import { cloudHomeNavigationAction, createMainNavigationGuard } from "./main-ipc-trust.mjs";
import { cloudHomeSenderId } from "./main-trust.mjs";

export const CLOUD_FLAG_ENV = "MURAGE_DESKTOP_CLOUD";

/**
 * The developer force-on override. Off by default, and ALWAYS off in a packaged build: there only
 * MURAGE_DESKTOP_CLOUD=0 (the hard off) is honoured, and Cloud turns on only through the live gate.
 * In an unpackaged (development or qualification) build it is on when the environment sets
 * MURAGE_DESKTOP_CLOUD=1, or the user-data folder holds desktop-flags.json with {"cloud": true}.
 * `packaged` defaults to true so a caller that forgets it fails closed.
 */
export function cloudHomeEnabled({ env = {}, userDataDir, packaged = true } = {}) {
  if (packaged !== false) return false;
  const value = env[CLOUD_FLAG_ENV];
  if (value !== undefined && value !== "") return value === "1";
  try {
    const dir = typeof userDataDir === "function" ? userDataDir() : userDataDir;
    return Boolean(dir) && JSON.parse(readFileSync(path.join(dir, "desktop-flags.json"), "utf8"))?.cloud === true;
  } catch {
    return false;
  }
}

/** dist/ file reader. Refuses anything that resolves outside the root. */
export function createDistReader(distDir) {
  const root = path.resolve(distDir);
  return async (rel) => {
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return await fs.readFile(file);
    } catch {
      return null;
    }
  };
}

/** Block anything the cloud partition would fetch outside the scheme (devtools/data/blob excepted). */
export function cloudRequestAllowed(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === `${CLOUD_HOME_SCHEME}:` || protocol === "devtools:" || protocol === "data:" || protocol === "blob:" || protocol === "chrome-extension:";
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {{ registerSchemesAsPrivileged: Function }} deps.protocol electron protocol
 * @param {{ fromPartition: Function }} deps.session electron session
 * @param {Function} deps.BrowserWindow
 * @param {{ openExternal: Function }} deps.shell
 * @param {{ fetch: Function }} deps.net electron net
 * @param {NodeJS.ProcessEnv} deps.env
 * @param {string | (() => string)} [deps.userDataDir]
 * @param {boolean} [deps.packaged] app.isPackaged. Defaults to true (fail closed): the force-on override is honoured only when false.
 * @param {string} deps.distDir the desktop's own dist/ (inside the asar when packaged)
 * @param {import("./cloud-home-protocol.mjs").CloudHomeProvider | null} [deps.provider] explicit provider (tests); the client's wins when no provider is given
 * @param {() => { provider: Function, onAuthFailure: (homeId: string) => Promise<boolean> } | null} [deps.createClient]
 *   Called ONLY when the flag is on. main.mjs passes the WP2 client factory; its `provider` feeds the proxy and its
 *   `onAuthFailure` is what the proxy calls on a 401 / 403 session-invalid (one refresh, one retry).
 * @param {string} [deps.cloudPreload] absolute path of preload-cloud.cjs: the Cloud window's own tiny bridge (WP4). It is NOT the main
 *   preload; it exposes `muragecloud` (unread badge, approval notification, reachability, disconnect, https link out) and nothing else.
 * @param {(homeId: string) => void} [deps.onWindowClosed] a Cloud window closed (main re-applies the unread badge)
 * @param {(m: string) => void} [deps.warn]
 */
export function installCloudHome({ liveGate = null, packaged = true, protocol, session, BrowserWindow, shell, net, env, userDataDir, distDir, provider = null, createClient = null, cloudPreload, onWindowClosed = () => {}, warn = () => {} }) {
  // MURAGE_DESKTOP_CLOUD=0 is a hard off: nothing registered, null. Otherwise the scheme is ALWAYS registered (it must be
  // before app ready) but inert: active() is false, so every scheme request is refused, open() throws and the IPC stubs refuse,
  // until the developer override (unpackaged builds only) is on or the live gate (verified live:true from the pinned prod origin,
  // probed by this process) flips it, at runtime.
  if (env?.[CLOUD_FLAG_ENV] === "0") return null;
  const devOverride = cloudHomeEnabled({ env, userDataDir, packaged });
  const active = () => devOverride || liveGate?.isLive() === true;
  const client = typeof createClient === "function" ? createClient() : null;
  protocol.registerSchemesAsPrivileged([{ scheme: CLOUD_HOME_SCHEME, privileges: { ...CLOUD_HOME_SCHEME_PRIVILEGES } }]);
  let currentProvider = provider ?? (client ? (homeId) => client.provider(homeId) : null);
  const readAsset = createDistReader(distDir);
  const windows = new Map();
  const refusedResponse = () => new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  const activeListeners = new Set();
  /** True while this home's Cloud window is open. Going not-live never closes one: it may be in the middle of a task. */
  const windowOpen = (homeId) => { try { const win = windows.get(homeId); return Boolean(win) && !win.isDestroyed(); } catch { return false; } };
  // Going not-live refuses only NEW work (new opens, new IPC work). Windows already open stay open and keep being served
  // until the person closes them; the renderer is told so it hides the entry.
  liveGate?.onChange((live) => {
    for (const listener of [...activeListeners]) { try { listener(live && active()); } catch {} }
  });
  return {
    client,
    /** True while Cloud is on (developer override or verified live). Checked on every scheme request and IPC call. */
    active,
    /** Called with the new active state when the live gate flips. Returns an unsubscribe. */
    onActiveChange(listener) { activeListeners.add(listener); return () => activeListeners.delete(listener); },
    /** Replace the provider (tests, or a client created later). */
    setProvider(next) { currentProvider = next; },
    windows: () => new Map(windows),
    /** True while this home's Cloud window is open (it keeps working after Cloud stops being live). */
    windowOpen,
    /** The homeId of the Cloud window this IPC event came from, or null (WP4: per-window badge and notifications). */
    senderHomeId(event) {
      return cloudHomeSenderId(event, windows);
    },
    /** True when an IPC event came from the top frame of one of OUR Cloud-home windows (the gate's cloud sender kind). */
    isCloudSender(event) {
      return cloudHomeSenderId(event, windows) !== null;
    },
    /** Close the Cloud window for a home, if one is open (a disconnected computer has nothing to show). */
    close(homeId) {
      const existing = windows.get(homeId);
      if (existing && !existing.isDestroyed()) existing.close();
    },
    /** Open (or focus) the cloud window for a paired home. */
    open(homeId) {
      if (!active()) throw new Error("Cloud isn't available yet.");
      if (!isValidHomeId(homeId)) throw new Error("invalid cloud home id");
      const existing = windows.get(homeId);
      if (existing && !existing.isDestroyed()) { existing.focus(); return existing; }
      const partition = cloudPartition(homeId);
      const ses = session.fromPartition(partition);
      const handler = createCloudHomeHandler({
        homeId,
        home: () => currentProvider?.(homeId) ?? null,
        netFetch: (input, init) => net.fetch(input, init),
        readAsset,
        onAuthFailure: client ? (id) => client.onAuthFailure(id) : undefined,
        onStepUp: client ? (id, request) => client.stepUpRetry(id, request.path, request) : undefined,
        warn,
      });
      // Served while Cloud is on, or while THIS window is still open (a task in it keeps working after Cloud goes not-live).
      ses.protocol.handle(CLOUD_HOME_SCHEME, (request) => (active() || windowOpen(homeId) ? handler(request) : refusedResponse()));
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !cloudRequestAllowed(details.url) }));
      const win = new BrowserWindow({
        width: 1200, height: 800, minWidth: 900, minHeight: 600, show: true,
        webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, ...(cloudPreload ? { preload: cloudPreload, additionalArguments: [`--murage-cloud-home=${homeId}`] } : {}) },
      });
      windows.set(homeId, win);
      win.on("closed", () => { windows.delete(homeId); try { onWindowClosed(homeId); } catch {} });
      const guard = createMainNavigationGuard({
        origin: () => cloudHomeEntryUrl(homeId),
        action: (url) => cloudHomeNavigationAction(url, { homeId }),
        openExternal: (url) => shell.openExternal(url),
        warn: (m) => warn(`[cloud-navigation] ${m}`),
      });
      win.webContents.on("will-navigate", guard.willNavigate);
      win.webContents.on("will-redirect", guard.willRedirect);
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (cloudHomeNavigationAction(url, { homeId }) === "external") void Promise.resolve(shell.openExternal(url)).catch(() => {});
        return { action: "deny" };
      });
      void win.loadURL(cloudHomeEntryUrl(homeId)).catch((error) => warn(`cloud window load failed: ${error?.message ?? error}`));
      return win;
    },
  };
}
