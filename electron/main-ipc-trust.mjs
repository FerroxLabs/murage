// Owned-main-window trust for the app bridge (0.1.52 S1-T3, audit B6).
//
// Three pieces, one policy: only the top frame of the window this process owns,
// still showing its own renderer origin (main-trust.mjs), may use the app
// bridge.
//
//   1. createOwnedMainIpc wraps ipcMain so every main.mjs registration refuses
//      any other sender before its listener runs: another window, a subframe,
//      a detached frame, a navigated-away or opaque origin. Secret issuance,
//      capture, credentials, companion, updater and the native actions all go
//      through it.
//   2. The main window may not leave its renderer origin. A renderer-initiated
//      navigation elsewhere is refused (a credential-free web link opens in the
//      default browser instead, the same policy as window.open) and a main-frame
//      redirect elsewhere is refused.
//   3. The preload exposes the bridge (and asks for the desktop secret) only
//      when the document is on the origin main handed it at window creation.
//
// Pure module: nothing here imports Electron, so node tests drive it directly.

import { externalWebUrl } from "./app-permissions.mjs";
import { CLOUD_HOME_SCHEME, isApiPath, resolveStaticPath } from "./cloud-home-protocol.mjs";

export const OWNED_MAIN_IPC_REFUSAL = "OWNED_MAIN_SENDER_REQUIRED";
const REFUSAL_MESSAGE = "This action is available only in the main Murage window.";

/** Prefix of the preload argument carrying the trusted renderer origin. */
export const RENDERER_ORIGIN_ARGUMENT = "--murage-renderer-origin=";

function webOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The `webPreferences.additionalArguments` entry that tells the preload which
 * origin may receive the bridge. Empty when the origin is unusable, so the
 * preload fails closed.
 *
 * @param {string | null | undefined} origin
 * @returns {string[]}
 */
export function rendererOriginArguments(origin) {
  const trusted = webOrigin(origin);
  return trusted ? [`${RENDERER_ORIGIN_ARGUMENT}${trusted}`] : [];
}

/**
 * Message of the refusal a Cloud-home window gets for a channel that is not cloud-safe. Only the message crosses
 * ipcRenderer.invoke, so the code is part of it; the promise rejects at once, it never hangs.
 */
export const CLOUD_WINDOW_IPC_REFUSAL = "LOCAL_ONLY_CHANNEL";
const CLOUD_REFUSAL_MESSAGE = `This action is available only on your computer. (${CLOUD_WINDOW_IPC_REFUSAL})`;

/**
 * An ipcMain stand-in whose registrations are gated by `isTrusted(event)`.
 *
 * - `handle`: an untrusted invoke rejects before the listener runs.
 * - `on`: an untrusted message is dropped before the listener runs. A
 *   synchronous channel must pass `{ refusedReturnValue }` so a refused
 *   `sendSync` still gets an answer instead of hanging the renderer.
 *
 * `cloud` (B3 WP3, passed only when the Cloud flag is on; omitted means the gate is exactly the main-window-only
 * gate it always was): `isCloudSender(event)` says the event came from a Cloud-home window's top frame and
 * `classOf(channel)` is the channel class (ipc-channel-classes.mjs). The decision is made here, in main, before the
 * listener runs: the main window may call local-only and cloud-safe channels (never cloud-only), the Cloud-home
 * window only cloud-safe and cloud-only ones, anything else nothing. A refused Cloud-home call is reported to
 * `cloud.onRefused(channel)` EVERY time (channel name only, no payload); other refusals go to `onRefused` as before.
 *
 * @param {{ ipcMain: { handle: Function, on: Function }, isTrusted: (event: any) => boolean, onRefused?: (channel: string) => void,
 *   cloud?: { isCloudSender: (event: any) => boolean, classOf: (channel: string) => string, onRefused?: (channel: string) => void } }} deps
 */
export function createOwnedMainIpc({ ipcMain, isTrusted, onRefused = () => {}, cloud }) {
  const registered = [];
  const trusted = (event) => {
    try {
      return isTrusted(event) === true;
    } catch {
      return false;
    }
  };
  const refuse = (channel) => {
    try {
      onRefused(channel);
    } catch {}
  };
  const refuseCloud = (channel) => {
    try {
      cloud.onRefused?.(channel);
    } catch {}
  };
  /** "allow", or the refusal to apply: "other" (not our window) / "cloud" (Cloud-home window, wrong class). */
  const decide = (channel, event) => {
    if (trusted(event)) return !cloud || cloud.classOf(channel) !== "cloud-only" ? "allow" : "other";
    if (!cloud) return "other";
    let fromCloud = false;
    try { fromCloud = cloud.isCloudSender(event) === true; } catch { fromCloud = false; }
    if (!fromCloud) return "other";
    let klass = "local-only";
    try { klass = cloud.classOf(channel); } catch { klass = "local-only"; }
    return klass === "cloud-safe" || klass === "cloud-only" ? "allow" : "cloud";
  };
  return {
    handle(channel, listener) {
      registered.push({ channel, kind: "handle" });
      ipcMain.handle(channel, (event, ...args) => {
        const verdict = decide(channel, event);
        if (verdict === "other") {
          refuse(channel);
          return Promise.reject(Object.assign(new Error(REFUSAL_MESSAGE), { code: OWNED_MAIN_IPC_REFUSAL }));
        }
        if (verdict === "cloud") {
          refuseCloud(channel);
          return Promise.reject(Object.assign(new Error(CLOUD_REFUSAL_MESSAGE), { code: CLOUD_WINDOW_IPC_REFUSAL }));
        }
        return listener(event, ...args);
      });
    },
    on(channel, listener, options) {
      const sync = Boolean(options && Object.hasOwn(options, "refusedReturnValue"));
      registered.push({ channel, kind: sync ? "sync" : "on" });
      ipcMain.on(channel, (event, ...args) => {
        const verdict = decide(channel, event);
        if (verdict !== "allow") {
          if (verdict === "cloud") refuseCloud(channel);
          else refuse(channel);
          if (sync) event.returnValue = options.refusedReturnValue;
          return;
        }
        listener(event, ...args);
      });
    },
    /** Every channel registered through this gate, in order. */
    registrations: () => registered.map((entry) => ({ ...entry })),
  };
}

/**
 * What the owned main window does with a navigation to `url`.
 *
 * @param {unknown} url
 * @param {{ origin: string | null | undefined }} context trusted renderer origin
 * @returns {"allow" | "external" | "deny"}
 */
export function mainNavigationAction(url, { origin } = {}) {
  const trusted = webOrigin(origin);
  const target = webOrigin(url);
  if (trusted && target && target === trusted) return "allow";
  try {
    externalWebUrl(url);
    return "external";
  } catch {
    return "deny";
  }
}

/**
 * What the cloud-home window's TOP FRAME does with a navigation to `url`:
 * allow only murage-home://<homeId>/ paths that resolve to the desktop's own
 * dist/ (never /api, never traversal or encoded separators, no credentials, no
 * other home); a credential-free web link opens externally; the rest is denied.
 *
 * @param {unknown} url
 * @param {{ homeId: string }} context
 * @returns {"allow" | "external" | "deny"}
 */
export function cloudHomeNavigationAction(url, { homeId } = {}) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === `${CLOUD_HOME_SCHEME}:`) {
      if (!homeId || parsed.hostname !== homeId || parsed.username || parsed.password || parsed.port) return "deny";
      if (isApiPath(parsed.pathname)) return "deny";
      return resolveStaticPath(parsed.pathname) ? "allow" : "deny";
    }
  } catch {
    return "deny";
  }
  try {
    externalWebUrl(url);
    return "external";
  } catch {
    return "deny";
  }
}

// Electron 43 passes a details event carrying url/isMainFrame and still appends
// the deprecated positional arguments. Read either; a missing frame flag is
// treated as the main frame so the check fails closed.
function navigationDetails(event, legacyUrl, legacyIsMainFrame) {
  const url = typeof event?.url === "string" ? event.url : legacyUrl;
  const isMainFrame = typeof event?.isMainFrame === "boolean" ? event.isMainFrame : legacyIsMainFrame !== false;
  return { url, isMainFrame };
}

/**
 * `will-navigate` and `will-redirect` listeners for the owned main window.
 * Subframes are not governed here: the preload runs only in the top frame and
 * every IPC from a subframe is refused by createOwnedMainIpc.
 *
 * `action` (cloud window) replaces the origin comparison with its own verdict.
 *
 * @param {{ origin: () => string | null | undefined, openExternal: (url: string) => unknown, warn?: (message: string) => void, action?: (url: unknown) => "allow" | "external" | "deny" }} deps
 */
export function createMainNavigationGuard({ origin, openExternal, warn = () => {}, action }) {
  const decide = (url) => {
    try {
      if (typeof action === "function") return action(url);
      return mainNavigationAction(url, { origin: origin() });
    } catch {
      return "deny";
    }
  };
  const prevent = (event) => {
    try {
      event?.preventDefault?.();
    } catch {}
  };
  return {
    willNavigate(event, legacyUrl, _isInPlace, legacyIsMainFrame) {
      const { url, isMainFrame } = navigationDetails(event, legacyUrl, legacyIsMainFrame);
      if (!isMainFrame) return;
      const action = decide(url);
      if (action === "allow") return;
      prevent(event);
      if (action !== "external") {
        warn("A navigation away from Murage was refused");
        return;
      }
      try {
        void Promise.resolve(openExternal(externalWebUrl(url))).catch(() => warn("The external web link could not be opened"));
      } catch {
        warn("The external web link could not be opened");
      }
    },
    willRedirect(event, legacyUrl, _isInPlace, legacyIsMainFrame) {
      const { url, isMainFrame } = navigationDetails(event, legacyUrl, legacyIsMainFrame);
      if (!isMainFrame) return;
      if (decide(url) === "allow") return;
      prevent(event);
      warn("A redirect away from Murage was refused");
    },
  };
}
