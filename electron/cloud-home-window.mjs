// Murage Cloud B3 WP1: the cloud-home window and its Electron wiring.
//
// installCloudHome() is the ONLY thing main.mjs calls. With the Cloud flag off
// it returns null and touches nothing (no scheme, no session, no window), so a
// flag-off desktop is byte-for-byte the train. With the flag on it registers
// the privileged scheme (this must happen before app ready) and returns a
// controller; the window itself opens only when something calls open(homeId).
//
// The Cloud preload has its own classified bridge. Its top frame may load
// murage-home asar paths only; browser pop-outs share this session but not its IPC authority.

import { createCloudBrowserPopouts } from "./browser-popout.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CLOUD_HOME_SCHEME, CLOUD_HOME_SCHEME_PRIVILEGES, cloudHomeEntryUrl, cloudPartition,
  createCloudHomeHandler, isApiPath, isValidHomeId,
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

/** A Cloud window whose page hasn't loaded this long after it was asked for (or whose load failed) shows the offline
 * screen instead of a blank window: never an endless wait. Upstream 8c960af7b (OPEN_MS). */
export const CLOUD_OPEN_MS = 30_000;
/** While the offline screen shows, the window looks again by itself this often (Try again looks at once). */
export const CLOUD_RETRY_MS = 30_000;
const DEFAULT_TIMERS = {
  set: (work, ms) => { const timer = setTimeout(work, ms); timer.unref?.(); return timer; },
  clear: (timer) => clearTimeout(timer),
};

/**
 * The offline screen: a self-contained page (nothing fetched, no script). Its one link is the Cloud's own entry,
 * which the window's navigation hook turns into a fresh, watched load. The bridge refuses a data: page, so it
 * can reach nothing.
 */
export function cloudOfflinePage(homeId) {
  const entry = cloudHomeEntryUrl(homeId).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Murage Cloud</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
<main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">Can't reach your Cloud right now</h2>
<p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">Murage keeps trying by itself.</p>
<a href="${entry}" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">Try again</a></main></body>`);
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

/** True when `value` (a URL or an origin) is exactly this home's own murage-home:// origin: no other host, port or user. */
export function isThisHomeUrl(value, homeId) {
  if (typeof value !== "string" || !value || !isValidHomeId(homeId)) return false;
  try {
    const url = new URL(value);
    return url.protocol === `${CLOUD_HOME_SCHEME}:` && url.hostname === homeId && url.port === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * E5 (PARITYFIX): may the Cloud window's page use this permission? Only the microphone (audio, never video, never the
 * empty media list Electron uses for screen capture) and notifications, only for this home's own origin, only from the top
 * frame of this home's own Cloud window. Everything else stays refused.
 */
export function cloudPermissionRequestAllowed({ contents, ownedContents, homeId, permission, details }) {
  try {
    if (!contents || !ownedContents || contents !== ownedContents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (!details || typeof details !== "object" || details.isMainFrame !== true) return false;
    if (!isThisHomeUrl(details.requestingUrl, homeId)) return false;
    if (permission === "notifications") return true;
    if (permission !== "media") return false;
    if (details.securityOrigin !== undefined && !isThisHomeUrl(details.securityOrigin, homeId)) return false;
    return Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === "audio");
  } catch {
    return false;
  }
}

/**
 * The matching permission CHECK, so Notification.permission reads "granted" and the microphone check agrees with the
 * request. Every check must come from this home's own Cloud window (its webContents) and its top frame (isMainFrame true),
 * never the browser pop-out page. On real Electron 43.8.1 the page's Notification.permission, requestPermission and
 * new Notification are all checked from the owned window's top frame; only a worker's check is frame-less (no sender,
 * isMainFrame false, no requestingUrl). It cannot say which window (the pop-out shares this origin), so it is refused like
 * any check with no sender. A subframe, this origin embedded in another, and every other permission are refused.
 */
export function cloudPermissionCheckAllowed({ contents, ownedContents, homeId, permission, requestingOrigin, details }) {
  try {
    if (!details || typeof details !== "object") return false;
    if (details.isMainFrame !== true) return false;
    if (!contents || !ownedContents || contents !== ownedContents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (typeof details.requestingUrl === "string" && new URL(details.requestingUrl).searchParams.get("surface") === "browser-popout") return false;
    if (details.embeddingOrigin !== undefined && details.embeddingOrigin !== "" && !isThisHomeUrl(details.embeddingOrigin, homeId)) return false;
    if (!isThisHomeUrl(requestingOrigin, homeId)) return false;
    if (details.requestingUrl !== undefined && !isThisHomeUrl(details.requestingUrl, homeId)) return false;
    if (permission === "notifications") return true;
    if (permission !== "media") return false;
    if (details.securityOrigin !== undefined && !isThisHomeUrl(details.securityOrigin, homeId)) return false;
    return details.mediaType === "audio";
  } catch {
    return false;
  }
}

/**
 * E6 (PARITYFIX): a file the Cloud window downloads must come from this home's own file routes (murage-home://<home>/api/...,
 * or a blob: the page made on this home's origin), and from this home's own Cloud window. Every URL in the redirect chain
 * is checked. Anything else is cancelled before a byte is written.
 */
export function cloudDownloadAllowed({ contents, ownedContents, homeId, urls }) {
  try {
    if (!contents || !ownedContents || contents !== ownedContents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (!Array.isArray(urls) || urls.length === 0) return false;
    return urls.every((value) => {
      if (typeof value !== "string") return false;
      if (value.startsWith("blob:")) return isThisHomeUrl(value.slice("blob:".length), homeId);
      if (!isThisHomeUrl(value, homeId)) return false;
      return isApiPath(new URL(value).pathname);
    });
  } catch {
    return false;
  }
}

/** The name the save dialog suggests: a plain file name (no folders, no control characters), never empty. */
export function cloudDownloadName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return base || "download";
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
 * @param {() => string} [deps.downloadsDir] the system Downloads folder the save dialog starts in (E6)
 * @param {(homeId: string) => void} [deps.onWindowClosed] a Cloud window closed (main re-applies the unread badge)
 * @param {(m: string) => void} [deps.warn]
 */
export function installCloudHome({ liveGate = null, packaged = true, protocol, session, BrowserWindow, shell: osShell, net, env, userDataDir, distDir, provider = null, createClient = null, cloudPreload, downloadsDir = null, onWindowClosed = () => {}, onWindowOpened = () => {}, warn = () => {}, timers = DEFAULT_TIMERS, popoutState = {} }) {
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
  const downloadSessions = new WeakSet();
  const refusedResponse = () => new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  const activeListeners = new Set();
  /** True while this home's Cloud window is open. Going not-live never closes one: it may be in the middle of a task. */
  const windowOpen = (homeId) => { try { const win = windows.get(homeId); return Boolean(win) && !win.isDestroyed(); } catch { return false; } };
  // Going not-live refuses only NEW work (new opens, new IPC work). Windows already open stay open and keep being served
  // until the person closes them; the renderer is told so it hides the entry.
  liveGate?.onChange((live) => {
    for (const listener of [...activeListeners]) { try { listener(live && active()); } catch {} }
  });
  const controller = {
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
      controller.browserPopouts.closeAll(homeId);
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
      // E5: microphone (audio only) and notifications for THIS home's own Cloud window, top frame only. Pop-outs share
      // this session but are never the owned window, so they are refused.
      let ownedContents = null;
      ses.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(cloudPermissionRequestAllowed({ contents, ownedContents, homeId, permission, details })));
      ses.setPermissionCheckHandler?.((contents, permission, requestingOrigin, details) =>
        cloudPermissionCheckAllowed({ contents, ownedContents, homeId, permission, requestingOrigin, details }));
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !cloudRequestAllowed(details.url) }));
      // E6: a download from this home's own window opens the system save dialog, suggesting the Downloads folder.
      // Installed once per session: a reopened window of the same home reuses its partition.
      if (!downloadSessions.has(ses)) {
        downloadSessions.add(ses);
        ses.on?.("will-download", (event, item, contents) => {
          const urls = typeof item?.getURLChain === "function" ? item.getURLChain() : [item?.getURL?.()];
          if (!cloudDownloadAllowed({ contents, ownedContents: windows.get(homeId)?.webContents ?? null, homeId, urls })) {
            try { event?.preventDefault?.(); } catch {}
            try { item?.cancel?.(); } catch {}
            warn("cloud window download refused: not from this home's own files");
            return;
          }
          let folder = "";
          try { folder = typeof downloadsDir === "function" ? downloadsDir() : ""; } catch {}
          const name = cloudDownloadName(item.getFilename?.());
          item.setSaveDialogOptions({ title: "Save file", defaultPath: folder ? path.join(folder, name) : name });
        });
      }
      const win = new BrowserWindow({
        width: 1200, height: 800, minWidth: 900, minHeight: 600, show: true,
        webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, ...(cloudPreload ? { preload: cloudPreload, additionalArguments: [`--murage-cloud-home=${homeId}`] } : {}) },
      });
      ownedContents = win.webContents;
      windows.set(homeId, win);
      try { onWindowOpened(homeId); } catch {} // NOTIFY-EVERYWHERE-1019 S4a: a replaced Cloud window kills outstanding attention tokens
      // F43 load watchdog: a page that fails or hasn't loaded in CLOUD_OPEN_MS is the offline screen, which looks again by
      // itself every CLOUD_RETRY_MS and on Try again. `generation` makes a superseded load's late answer a no-op.
      const entry = cloudHomeEntryUrl(homeId);
      let generation = 0, watchdog = null, retry = null, offline = false, closed = false;
      const stopTimers = () => { timers.clear(watchdog); timers.clear(retry); watchdog = null; retry = null; };
      const showOffline = (gen, why) => {
        if (closed || gen !== generation || offline) return;
        offline = true; stopTimers();
        warn(`cloud window didn't load (${why}); showing the offline screen`);
        try { win.webContents.stop?.(); } catch {}
        generation += 1; // the stopped load's rejection belongs to the old generation
        void Promise.resolve(win.loadURL(cloudOfflinePage(homeId))).catch(() => {});
        retry = timers.set(() => load(), CLOUD_RETRY_MS);
      };
      const loaded = (gen) => { if (gen !== generation || closed) return; timers.clear(watchdog); watchdog = null; };
      function load() {
        if (closed) return;
        stopTimers();
        offline = false;
        const gen = ++generation;
        watchdog = timers.set(() => showOffline(gen, `nothing after ${CLOUD_OPEN_MS / 1000} s`), CLOUD_OPEN_MS);
        let pending;
        try { pending = Promise.resolve(win.loadURL(entry)); } catch (error) { pending = Promise.reject(error); }
        // ERR_ABORTED is the page moving on by itself (a newer navigation), not a failure: the watchdog still covers it.
        pending.then(() => loaded(gen), (error) => { if (error?.code !== "ERR_ABORTED") showOffline(gen, error?.code ?? error?.message ?? String(error)); });
      }
      win.on("closed", () => { closed = true; stopTimers(); windows.delete(homeId); try { onWindowClosed(homeId); } catch {} });
      // A load of our own entry that finished after an ERR_ABORTED hand-over still ends the watchdog.
      win.webContents.on("did-finish-load", () => { try { if (!offline && String(win.webContents.getURL?.() ?? "").startsWith(entry)) loaded(generation); } catch {} });
      const guard = createMainNavigationGuard({
        origin: () => cloudHomeEntryUrl(homeId),
        action: (url) => cloudHomeNavigationAction(url, { homeId }),
        openExternal: (url) => osShell.openExternal(url),
        warn: (m) => warn(`[cloud-navigation] ${m}`),
      });
      win.webContents.on("will-navigate", (event, ...rest) => {
        // Try again on the offline screen: our own entry only, as a fresh watched load (never the page's own navigation).
        const url = typeof event?.url === "string" ? event.url : rest[0];
        if (offline && cloudHomeNavigationAction(url, { homeId }) === "allow") { try { event?.preventDefault?.(); } catch {} load(); return; }
        guard.willNavigate(event, ...rest);
      });
      win.webContents.on("will-redirect", guard.willRedirect);
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (cloudHomeNavigationAction(url, { homeId }) === "external") void Promise.resolve(osShell.openExternal(url)).catch(() => {});
        return { action: "deny" };
      });
      load();
      return win;
    },
  };
  const statePath = key => path.join(typeof userDataDir === "function" ? userDataDir() : userDataDir, `browser-popout-${encodeURIComponent(key)}.json`);
  controller.browserPopouts = createCloudBrowserPopouts({ cloud: controller, preload: cloudPreload,
    createWindow: options => new BrowserWindow(options),
    navigationGuard: homeId => createMainNavigationGuard({ origin: () => cloudHomeEntryUrl(homeId),
      action: url => cloudHomeNavigationAction(url, { homeId }), openExternal: url => osShell.openExternal(url), warn }),
    readState: key => JSON.parse(readFileSync(statePath(key), "utf8")),
    writeState: (key, state) => writeFileSync(statePath(key), JSON.stringify(state), { mode: 0o600 }),
    ...popoutState,
  });
  return controller;
}
