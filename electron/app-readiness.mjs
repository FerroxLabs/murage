// SPDX-License-Identifier: AGPL-3.0-or-later
// Is a window showing the app right now? A pending package install, Cloud link or tray/inbox event is delivered only to a window
// whose last committed main-frame navigation was the app (HTTP 200 on the trusted renderer origin). The server's setup page (503),
// the startup error page (data:) and any other origin are not the app, so a delivery that lands there would be swallowed.
//
// Readiness lives per webContents (a WeakMap), so a replaced window starts not ready. States (WIN-NOROUTE-1019 rev 2.4, A14):
//   NOT_READY    initial; a non-app commit; a real failure; the renderer gone.
//   READY        the app is committed and proved live.
//   NAVIGATING   a cross-document main-frame navigation is in flight; `before` = was the last committed document the app.
//   PROBING      a navigation ended without committing over the app; one probe was sent, an ack from the live top frame is awaited.
// A commit (did-navigate) is renderer-originated proof and grants readiness directly. A navigation that never commits (a cancelled
// external link, a download, a prevented will-navigate) NEVER sets ready by itself: at its stop the window enters PROBING and main
// asks the renderer (`probe`); only an ack from that window's live top frame (`alive`) grants READY and calls `onRestored(contents)`,
// which delivers what is queued (no did-finish-load fires for a navigation that never committed). A renderer that died before or
// during the stop can never ack, so a stop that Chromium emits during teardown (before render-process-gone) can never drain.
//
// Stale failures. Each main-frame navigation start is recorded (Electron's navigationId when the event carries one, plus every URL
// it visited through redirects). A did-fail-load that provably belongs to an older navigation (a different id, or a URL only an
// older navigation visited) is ignored, whether the newer one is still in flight or already committed, so a late failure never clears
// a newer navigation's state. ERR_ABORTED never changes state (the stop that follows every cancelled navigation decides); any other
// failure that is not provably stale fails closed (not ready). pushState and hash routes keep readiness (did-navigate does not fire
// for them). Pure: no Electron import.
//
// Rev 2.5 (A15.1, A15.2). An ack must come from a frame whose origin IS the trusted origin (a missing, unreadable or "null" origin, which is
// what an error document has, never grants READY). A non-aborted main-frame did-fail-load is ambiguous in Electron 43 (an error-page commit,
// or a post-commit report that can belong to an older same-URL navigation), so it is no longer trusted: the tracker reads the live document
// through `inspect`. An error document -> NOT_READY; in NAVIGATING nothing changes (the commit or the stop decides); the unchanged app still
// visible -> it must re-prove itself by ack (PROBING, deferred to the stop while the main frame is still loading); anything else -> NOT_READY.

import { webOrigin } from "./app-permissions.mjs";
import { errorCandidate } from "./load-failure-recovery.mjs";

/** True only for a 200 on exactly the trusted origin (same scheme, host and port). Fails closed on an unset origin. */
export function appPageLoaded({ url, code, origin } = {}) {
  if (code !== 200) return false;
  const trusted = webOrigin(origin);
  return trusted !== null && webOrigin(url) === trusted;
}

/** A14 sender trust, shared with the S3R renderer session: the top frame of a window, on exactly the trusted origin. */
export function trustedTopFrame({ top, url, origin } = {}) {
  const trusted = webOrigin(origin);
  return top === true && trusted !== null && webOrigin(url) === trusted;
}

const ERR_ABORTED = -3; // a navigation that was cancelled (a prevented link, a download, a newer navigation)
const MAX_QUEUED = 32;
const MAX_OLDER = 16;

/**
 * @param {{ origin: () => string | null | undefined, onRestored?: (contents: object) => void, probe?: (contents: object, token: number) => void }} deps
 * `origin` is read at each navigation (the packaged port is chosen at boot). `probe` asks the window's renderer to answer with `alive`.
 * `inspect(contents)` reads the live main document ({ committedUrl, frameUrl, frameOrigin, entryUrl }, or null); without it a non-aborted failure
 * fails closed to NOT_READY.
 */
export function createAppReadiness({ origin, onRestored, probe, inspect }) {
  // contents -> { ready, probing (token or null), epoch, pending, seq, committedId, committedUrl, older: Set<string>, queue }
  const state = new WeakMap();
  const slot = (contents) => (contents && typeof contents === "object" ? state.get(contents) : undefined);
  return {
    /** Start tracking one window's webContents. A webContents that was never tracked is never ready. */
    track(contents) {
      if (!contents || typeof contents !== "object") return;
      const s = { ready: false, probing: null, reprobeAtStop: false, epoch: 0, pending: null, seq: 0, committedId: undefined, committedUrl: undefined, older: new Set(), queue: [] };
      state.set(contents, s);
      const remember = (url) => {
        if (typeof url !== "string" || !url) return;
        s.older.add(url);
        if (s.older.size > MAX_OLDER) s.older.delete(s.older.values().next().value);
      };
      const retire = (pending) => { if (pending) for (const url of pending.urls) remember(url); };
      // Every transition moves the epoch; a probe token is the epoch it was sent at, so any later transition kills it.
      const setNotReady = () => { s.epoch += 1; s.ready = false; s.probing = null; s.reprobeAtStop = false; };
      const live = () => {
        if (typeof inspect !== "function") return null;
        try { return inspect(contents) ?? null; } catch { return null; }
      };
      // The unchanged app document: a non-opaque document of the trusted origin that is not an error document.
      const appVisible = (snap) => {
        const trusted = webOrigin(origin());
        if (!snap || trusted === null || snap.frameOrigin !== trusted) return false;
        return webOrigin(snap.frameUrl ?? snap.committedUrl) === trusted && !errorCandidate(snap, origin());
      };
      const enterProbe = () => {
        s.epoch += 1;
        s.ready = false;
        const token = s.epoch;
        s.probing = token;
        if (contents.isDestroyed?.() === true || typeof probe !== "function") return;
        try { probe(contents, token); } catch { /* no probe went out: with no ack this stays not ready */ }
      };
      // Electron passes a details event (isMainFrame, isSameDocument, url); older builds pass positional (url, isInPlace, isMainFrame).
      contents.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
        const main = event?.isMainFrame ?? isMainFrame;
        const sameDocument = event?.isSameDocument ?? isInPlace;
        if (main !== true || sameDocument === true) return;
        // A newer navigation supersedes an in-flight one; "before" stays the readiness of the last committed document.
        const before = s.pending ? s.pending.before : (s.ready || s.probing !== null || s.reprobeAtStop);
        retire(s.pending);
        s.seq += 1;
        const first = event?.url ?? url;
        s.pending = { id: event?.navigationId ?? s.seq, hasId: event?.navigationId !== undefined, urls: new Set(typeof first === "string" ? [first] : []), before };
        setNotReady();
      });
      contents.on("did-redirect-navigation", (event, url, isInPlace, isMainFrame) => {
        const main = event?.isMainFrame ?? isMainFrame;
        const target = event?.url ?? url;
        if (main === true && s.pending && typeof target === "string") s.pending.urls.add(target);
      });
      contents.on("did-navigate", (_event, url, code) => {
        if (s.committedUrl && s.committedUrl !== url) remember(s.committedUrl);
        s.committedId = s.pending?.hasId ? s.pending.id : undefined;
        s.committedUrl = url;
        s.pending = null;
        setNotReady();
        s.ready = appPageLoaded({ url, code, origin: origin() });
      });
      contents.on("did-fail-load", (event, code, _description, validatedURL, isMainFrame) => {
        if (isMainFrame === false) return;
        const p = s.pending;
        const id = event?.navigationId;
        let stale = false;
        if (id !== undefined) {
          stale = id !== (p ? p.id : s.committedId);
        } else if (typeof validatedURL === "string" && validatedURL) {
          const current = p ? p.urls.has(validatedURL) : validatedURL === s.committedUrl;
          stale = s.older.has(validatedURL) && !current;
        }
        if (stale) return;
        // A cancel ends nothing: only the stop that follows it ends an uncommitted navigation.
        if (code === ERR_ABORTED) return;
        // Any other failure is ambiguous (A15.2): read the live document instead of trusting the event.
        const snap = live();
        if (snap !== null) {
          if (errorCandidate(snap, origin())) { s.pending = null; setNotReady(); return; }
          if (s.pending) return; // NAVIGATING: a stale or post-commit report; the commit or the stop decides
          if ((s.ready || s.probing !== null || s.reprobeAtStop) && appVisible(snap)) {
            if (contents.isLoadingMainFrame?.() === true) {
              // A probe sent now would have its ack dropped by the loading belt: re-prove at the stop.
              s.epoch += 1; s.ready = false; s.probing = null; s.reprobeAtStop = true;
            } else {
              enterProbe();
            }
            return;
          }
        }
        s.pending = null;
        setNotReady();
      });
      // A navigation that started and stopped without committing leaves the previous document on screen, if it was the app and
      // the renderer still answers: ask it.
      contents.on("did-stop-loading", () => {
        if (s.reprobeAtStop) {
          s.reprobeAtStop = false;
          if (contents.isDestroyed?.() !== true && appVisible(live())) enterProbe(); else setNotReady();
          return;
        }
        const p = s.pending;
        if (!p) return;
        s.pending = null;
        if (p.before) enterProbe(); else setNotReady();
      });
      contents.on("render-process-gone", () => { s.pending = null; setNotReady(); });
      contents.once?.("destroyed", () => { s.reprobeAtStop = false; });
    },
    /** The A14 state name, read-only: NOT_READY, READY, NAVIGATING or PROBING. */
    stateOf(contents) {
      const s = slot(contents);
      if (!s) return "NOT_READY";
      if (s.pending) return "NAVIGATING";
      if (s.probing !== null) return "PROBING";
      return s.ready ? "READY" : "NOT_READY";
    },
    /**
     * The renderer's answer to a probe, from main's ipcMain handler: `top` is whether the sender frame is the top frame and `url` its
     * URL. Grants readiness only for the current probe token, from the top frame on the trusted origin, of a live window that is not
     * loading its main frame. Every other ack (duplicate, late, wrong frame, wrong origin, superseded token) is ignored.
     */
    alive(contents, token, { top, url, frameOrigin } = {}) {
      const s = slot(contents);
      if (!s || s.probing === null || token !== s.probing || top !== true) return false;
      const trusted = webOrigin(origin());
      if (trusted === null || webOrigin(url) !== trusted) return false;
      // A15.1: the frame's own origin must be the trusted one ("null" is what an error document has), and never a chrome-error URL.
      if (frameOrigin !== trusted || (typeof url === "string" && url.startsWith("chrome-error://"))) return false;
      if (contents.isDestroyed?.() === true || contents.isLoadingMainFrame?.() === true) return false;
      s.epoch += 1;
      s.probing = null;
      s.ready = true;
      if (typeof onRestored === "function") { try { onRestored(contents); } catch { /* the window went away */ } }
      return true;
    },
    ready(contents) { return Boolean(contents) && slot(contents)?.ready === true; },
    /** Queue `fn` for the next flush (the window finishing a load while it shows the app). Bounded; never runs for a replaced window. */
    defer(contents, fn) {
      const s = slot(contents);
      if (!s) return false;
      if (s.queue.length >= MAX_QUEUED) s.queue.shift();
      s.queue.push(fn);
      return true;
    },
    /** Run what defer queued, if the window is showing the app now. Call it from did-finish-load and from onRestored. */
    flush(contents) {
      const s = slot(contents);
      if (!s || !s.ready || s.queue.length === 0) return 0;
      const run = s.queue.splice(0);
      for (const fn of run) { try { fn(); } catch { /* the window went away */ } }
      return run.length;
    },
  };
}
