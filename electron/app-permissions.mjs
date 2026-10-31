// Main-app permission and external-link policy (0.1.52 S1-T2).
//
// Adapted from OpenMausBot PR #986 (merge 7aa86499bca77253d971c52826956d8c1bb639d9,
// electron/app-permissions.mjs), Copyright the OpenMausBot authors, licensed
// under the Apache License, Version 2.0. Murage changes: the policy is bound to
// the owned main window's top frame as well as its origin, media requests also
// check Chromium's security origin, the external-link IPC is gated by the K0
// owned-main-sender predicate (main-trust.mjs) instead of upstream's localOnly
// helper, and the startup error page keeps an exact, trusted server-log link.
//
// The local UI needs a small set of capabilities: audio media (microphone for
// push-to-talk and the skill recorder), notifications, clipboard and full
// screen. Screen preview keeps its own one-shot, user-gesture-bound display
// media guard (screen-preview.cjs); this policy only lets Electron route the
// request there.
//
// Everything else stays off: camera/video, geolocation, USB, HID, serial, MIDI,
// unguarded screen capture, window management, pointer/keyboard lock, storage
// access, external protocol launches. The allow-list applies only to the
// verified renderer origin; opaque, look-alike and foreign origins are refused.
// This policy is for the default session's main window only. The desktop
// viewer, browser panel, VM workspaces and server-connection windows keep their
// own deny-by-default sessions.

import { isOwnedMainSender } from "./main-trust.mjs";

const ALLOWED_APP_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

// Opaque origins (data:, about:blank, javascript:) serialise as the string
// "null"; never let two of them match each other.
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
 * Pure policy: may this permission be granted to a page on this origin?
 *
 * Electron 43 routes getDisplayMedia through permission "media" with an empty
 * `mediaTypes` array before calling the display-media request handler, so an
 * empty list is allowed here and the guarded handler still decides. Omitted,
 * unknown, video, mixed and conflicting media details are refused.
 *
 * @param {string} permission Electron/Chromium permission name
 * @param {string} requestingUrlOrOrigin URL or origin asking for it
 * @param {string | null | undefined} rendererOrigin trusted main renderer origin
 * @param {{ mediaTypes?: unknown, mediaType?: unknown, securityOrigin?: unknown } | null} [details]
 * @returns {boolean}
 */
export function appPermissionAllowed(permission, requestingUrlOrOrigin, rendererOrigin, details = {}) {
  const requesting = webOrigin(requestingUrlOrOrigin);
  const allowed = webOrigin(rendererOrigin);
  if (!requesting || !allowed || requesting !== allowed) return false;

  if (permission === "media") {
    if (!details || typeof details !== "object") return false;
    // Chromium's security origin for the media request must be ours as well.
    if (details.securityOrigin !== undefined && webOrigin(details.securityOrigin) !== allowed) return false;
    if (details.mediaType !== undefined && details.mediaType !== "audio") return false;
    if (details.mediaTypes !== undefined) {
      // [] is Electron's getDisplayMedia routing; ["audio"] is the microphone.
      return Array.isArray(details.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    }
    return details.mediaType === "audio";
  }

  return ALLOWED_APP_PERMISSIONS.has(permission);
}

/**
 * Session permission *request* decision for the default session.
 * Only the owned main window's top frame on the renderer origin qualifies.
 *
 * @param {{ contents: any, permission: string, details: any, ownedContents: any, origin: string | null | undefined }} input
 */
export function mainAppPermissionRequestAllowed({ contents, permission, details, ownedContents, origin } = {}) {
  try {
    if (!contents || !ownedContents || contents !== ownedContents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (!details || details.isMainFrame !== true) return false;
    return appPermissionAllowed(permission, details.requestingUrl, origin, details);
  } catch {
    return false;
  }
}

/**
 * Session permission *check* decision for the default session.
 *
 * Electron passes a null webContents for cross-origin subframes and for some
 * checks such as notifications, so a null sender is judged by origin alone,
 * while a present sender must be the owned main window's top frame. When an
 * embedding origin is reported it must also be the renderer origin, so our
 * origin framed inside a foreign page is refused.
 *
 * @param {{ contents: any, permission: string, requestingOrigin: string, details: any, ownedContents: any, origin: string | null | undefined }} input
 */
export function mainAppPermissionCheckAllowed({ contents, permission, requestingOrigin, details, ownedContents, origin } = {}) {
  try {
    if (contents) {
      if (!ownedContents || contents !== ownedContents) return false;
      if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
      if (details?.isMainFrame === false) return false;
    }
    if (details?.embeddingOrigin !== undefined && details.embeddingOrigin !== "" &&
      webOrigin(details.embeddingOrigin) !== webOrigin(origin)) return false;
    return appPermissionAllowed(permission, requestingOrigin, origin, details ?? {});
  } catch {
    return false;
  }
}

/**
 * Both explicit IPC links and window.open use the same web-only policy.
 * Returns the normalized URL string, or throws without echoing the input.
 */
export function externalWebUrl(rawUrl) {
  if (typeof rawUrl !== "string") throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web links can be opened");
  if (url.username || url.password) throw new Error("Web links must not include user credentials");
  return url.toString();
}

/**
 * Decide what a main-window `window.open` does. Every popup is denied; a
 * credential-free web URL opens in the default browser, and the startup error
 * page's exact server-log link (a data: page, see buildErrorPage) opens that
 * one log file. Anything else is refused.
 *
 * @param {unknown} url requested popup URL
 * @param {{ currentUrl?: string, diagnosticsLogHref?: string | null }} context
 * @returns {{ kind: "external", url: string } | { kind: "diagnostics-log" } | { kind: "refuse" }}
 */
export function mainWindowOpenAction(url, { currentUrl, diagnosticsLogHref } = {}) {
  if (
    typeof url === "string" && typeof diagnosticsLogHref === "string" && diagnosticsLogHref &&
    url === diagnosticsLogHref && typeof currentUrl === "string" && currentUrl.startsWith("data:text/html")
  ) {
    return { kind: "diagnostics-log" };
  }
  try {
    return { kind: "external", url: externalWebUrl(url) };
  } catch {
    return { kind: "refuse" };
  }
}

/**
 * Build the main window's setWindowOpenHandler. Always denies the popup.
 * Opening failures are logged without the raw URL.
 */
export function createMainWindowOpenHandler({ openExternal, openDiagnosticsLog, currentUrl, diagnosticsLogHref, warn = () => {} }) {
  return ({ url } = {}) => {
    let action;
    try {
      action = mainWindowOpenAction(url, { currentUrl: currentUrl?.(), diagnosticsLogHref: diagnosticsLogHref?.() });
    } catch {
      action = { kind: "refuse" };
    }
    const failed = (message) => () => warn(message);
    try {
      if (action.kind === "external") {
        void Promise.resolve(openExternal(action.url)).catch(failed("The external web link could not be opened"));
      } else if (action.kind === "diagnostics-log") {
        void Promise.resolve(openDiagnosticsLog()).catch(failed("The server log could not be opened"));
      }
    } catch {
      warn(action.kind === "diagnostics-log" ? "The server log could not be opened" : "The external web link could not be opened");
    }
    return { action: "deny" };
  };
}

/**
 * Build the `desktop:open-external` IPC handler. The sender is checked before
 * the URL is even parsed, so a foreign, subframe or navigated-away caller
 * learns nothing about the link policy and nothing is opened.
 *
 * @param {{ isTrustedSender: (event: any) => boolean, openExternal: (url: string) => Promise<unknown> }} deps
 */
export function createOpenExternalHandler({ isTrustedSender, openExternal }) {
  return async (event, rawUrl) => {
    let trusted = false;
    try {
      trusted = isTrustedSender(event) === true;
    } catch {
      trusted = false;
    }
    if (!trusted) throw new Error("Web links can be opened only from the main Murage window");
    await openExternal(externalWebUrl(rawUrl));
    return true;
  };
}

/** The owned-main-sender predicate bound to a lazily read window and origin. */
export function ownedMainSenderGate({ window, origin }) {
  return (event) => isOwnedMainSender(event, { window: window(), origin: origin() });
}
