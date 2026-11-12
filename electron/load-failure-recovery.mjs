// SPDX-License-Identifier: AGPL-3.0-or-later
// A main-frame load that fails while the app's server is down (the setup page's own refresh meets a killed or restarting server) leaves
// Chromium's own error document (chrome-error://chromewebdata) on screen. That document has no refresh and no script, and nothing else in
// main reloads it: renderer recovery only handles a dead renderer and the readiness tracker only gates deliveries (WIN-NOROUTE-1019 S7,
// real Windows: the window stayed blank for 96-100 s after the engine was back).
//
// Rule (design rev 2.5.1, A15 + A15a): LEVEL-TRIGGERED on the committed document, never on failure events. The window needs recovery
// exactly when, read at decision time from the live webContents (never from an event payload):
//   1. the main frame is an error document: a CANDIDATE on our own origin (errorCandidate), CONFIRMED by the renderer itself, whose own
//      location.href starts with chrome-error:// (confirm). Electron holds no route or header knowledge: an opaque origin on our URL is
//      only a candidate, and a sandboxed page of ours answers with its http URL and is left alone;
//   2. nothing is loading;
//   3. the renderer is alive, not being recovered by renderer recovery, and the app is not quitting;
//   4. the readiness tracker is NOT_READY or PROBING (never READY or NAVIGATING);
//   5. the server answers /api/health, and 1-4 still hold after that await with no navigation started during it (gen).
// Events (and the server coming back) only WAKE the loop; they never decide. A stale, late, duplicated or misattributed event can only
// cause a re-read of the truth: if the screen shows a working page, condition 1 is false and nothing happens.
//
// Pure: no Electron import; every effect is injected.

import { webOrigin } from "./app-permissions.mjs";

/** Chromium's own error document. */
export function isChromeErrorUrl(url) {
  return typeof url === "string" && url.startsWith("chrome-error://");
}

/** The trusted origin, normalised; anything but an http(s) host:port origin is null (fail closed). */
function trustedOf(origin) {
  const o = webOrigin(origin);
  return o !== null && /^https?:\/\//.test(o) ? o : null;
}

/**
 * Could this snapshot of the live main frame be an error document of our own origin? Sync and pure, and blind to every URL path: an
 * opaque origin on our own committed URL is a candidate (Chromium commits its error page that way on some platforms), and so is any
 * sandboxed document of ours. Only the renderer's own answer (confirm) turns a candidate into an error document.
 * @param {{ committedUrl?: string, frameUrl?: string, frameOrigin?: string, entryUrl?: string } | null | undefined} snapshot
 * @param {string | null | undefined} origin the trusted renderer origin
 */
export function errorCandidate(snapshot, origin) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const trusted = trustedOf(origin);
  if (trusted === null) return false;
  const entry = webOrigin(snapshot.entryUrl);
  if (entry === null || entry !== trusted) return false;
  if (isChromeErrorUrl(snapshot.frameUrl) || isChromeErrorUrl(snapshot.committedUrl)) return true;
  const committed = webOrigin(snapshot.committedUrl);
  return snapshot.frameOrigin === "null" && committed !== null && committed === trusted;
}

const WAITING = new Set(["NOT_READY", "PROBING"]);
const MAX_UNSETTLED = 4; // unsettled documentHref calls tagged with the current gen

/**
 * @param {object} contents a webContents-like EventEmitter (isDestroyed, isCrashed, isLoadingMainFrame)
 * @param {{ origin: () => string | null | undefined, inspect: () => object | null, readiness: () => string,
 *           documentHref?: () => Promise<unknown>, healthy: () => Promise<boolean>, reload: (target: string) => void,
 *           quitting?: () => boolean, busy?: () => boolean,
 *           log?: (line: string) => void, backoffMs?: number[], pollMs?: number, confirmMs?: number,
 *           setTimer?: Function, clearTimer?: Function, now?: () => number }} deps
 * @returns {{ kick: () => void, watching: () => boolean }}
 */
export function attachLoadFailureRecovery(contents, {
  origin, inspect, readiness, documentHref = async () => undefined, healthy, reload, quitting = () => false, busy = () => false, log = () => {},
  backoffMs = [1500, 3000, 6000, 10000], pollMs = 1500, confirmMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
}) {
  let timer = null;
  let isWatching = false;
  let ticking = false; // at most one tick (confirm + health probe) in flight
  let gone = false;
  let gen = 0; // bumped by every cross-document main-frame navigation start: an older answer never acts
  let reloads = 0; // reloads since the last reset; indexes backoffMs
  let nextReloadAt = 0; // no reload (and no probe) before this time
  let kickPending = false;
  // Confirmation bookkeeping (A15a). `unsettled` holds every documentHref call that has not settled yet, each tagged with the gen it was
  // issued under and the WATCHING entry it belongs to. An attempt whose deadline fired is `expired`: its late value is never consumed.
  const unsettled = new Set();
  let attemptSeq = 0;
  let entry = 0; // moves on every IDLE -> WATCHING entry
  let loggedReasons = new Set(); // one `candidate unconfirmed (<reason>)` line per reason per WATCHING entry
  let lateLogged = false; // one `late confirm settled` line per WATCHING entry
  let confirmedLogged = false; // the `error document` line comes on the first confirmation only

  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const dead = () => gone || safe(() => contents.isDestroyed?.() === true, true) || safe(() => quitting() === true, true);
  /** Condition 1's sync half, read now. Returns the snapshot when the live main frame is a candidate error document of our origin, else null. */
  const readCandidate = () => {
    const snap = safe(() => inspect(), null);
    return errorCandidate(snap, safe(() => origin(), null)) ? snap : null;
  };
  /** Conditions 2-4, read now. */
  const idleToReload = () => safe(() => (
    contents.isLoadingMainFrame?.() !== true
    && contents.isCrashed?.() !== true
    && busy() !== true
    && WAITING.has(readiness())
  ), false);

  const clearTimerNow = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const goIdle = () => { isWatching = false; clearTimerNow(); reloads = 0; nextReloadAt = 0; kickPending = false; };
  const enterWatching = () => {
    isWatching = true;
    entry += 1;
    loggedReasons = new Set();
    lateLogged = false;
    confirmedLogged = false;
  };
  const schedule = (ms) => {
    if (!isWatching || timer !== null) return;
    timer = setTimer(() => { timer = null; void tick(); }, Math.max(0, ms));
    timer?.unref?.();
  };
  const logOnce = (reason, line) => {
    if (loggedReasons.has(reason)) return;
    loggedReasons.add(reason);
    log(line);
  };

  /**
   * Ask the renderer what document it is showing. Always one of "error", "page" or "unknown", never a boolean. A browser-side
   * chrome-error:// URL is settled at once with no JavaScript. Otherwise one fresh attempt races documentHref() against confirmMs on the
   * injected timer; the deadline cannot cancel the call, it only invalidates the attempt at that instant.
   * @returns {Promise<{ result: "error" | "page" | "unknown", reason?: string, href?: string }>}
   */
  function confirm(snap) {
    const direct = [snap.frameUrl, snap.committedUrl].find(isChromeErrorUrl);
    if (direct !== undefined) return Promise.resolve({ result: "error", href: direct });
    let current = 0;
    for (const call of unsettled) if (call.gen === gen) current += 1;
    if (current >= MAX_UNSETTLED) return Promise.resolve({ result: "unknown", reason: "cap" });
    const attempt = { n: (attemptSeq += 1), gen, entry, startedAt: now(), expired: false };
    unsettled.add(attempt);
    return new Promise((resolve) => {
      let deadline = null;
      const onDeadline = () => {
        deadline = null;
        attempt.expired = true; // invalidated now: a settlement after this instant is never consumed
        resolve({ result: "unknown", reason: "timeout" });
      };
      onDeadline.confirmDeadline = true;
      deadline = setTimer(onDeadline, confirmMs);
      deadline?.unref?.();
      const settle = (kind, value) => {
        unsettled.delete(attempt);
        if (deadline !== null) { clearTimer(deadline); deadline = null; }
        if (attempt.expired) {
          // A late value changes nothing. It is only worth one diagnostic line: how long the call really took (is confirmMs too short?).
          if (!lateLogged && attempt.gen === gen && attempt.entry === entry && isWatching) {
            lateLogged = true;
            const how = kind === "value" ? (isChromeErrorUrl(value) ? "error" : typeof value === "string" ? "page" : "reject") : "reject";
            log(`load recovery: late confirm settled after ${Math.max(0, now() - attempt.startedAt)} ms (${how})`);
          }
          return;
        }
        if (kind === "reject") { resolve({ result: "unknown", reason: "reject" }); return; }
        if (typeof value !== "string") { resolve({ result: "unknown", reason: "non-string" }); return; }
        resolve(isChromeErrorUrl(value) ? { result: "error", href: value } : { result: "page", href: value });
      };
      let call;
      try { call = Promise.resolve(documentHref()); } catch (error) { call = Promise.reject(error); }
      call.then((value) => settle("value", value), (error) => settle("reject", error));
    });
  }

  async function tick() {
    if (!isWatching) return;
    if (dead()) { goIdle(); return; }
    if (ticking) { schedule(pollMs); return; } // a tick is in flight: keep one timer pending so WATCHING never sits without one
    ticking = true;
    let delay = pollMs;
    schedule(pollMs); // pending while the confirm and the probe are in flight; the finally below replaces it with the real due time
    try {
      const first = readCandidate();
      if (!first) { goIdle(); return; } // not even a candidate: no JavaScript ever runs in such a page
      if (!idleToReload()) return; // a navigation in flight decides for itself; its end wakes us
      const wait = nextReloadAt - now();
      if (wait > 0) { delay = wait; return; } // the backoff since the last reload: neither confirm, probe nor reload
      const seen = gen;
      const confirmed = await confirm(first);
      // The staleness check comes before ANY result is acted on: an old answer never disarms or arms recovery for a newer document.
      if (!isWatching) return;
      if (dead()) { goIdle(); return; }
      let snap = readCandidate();
      if (!snap) { goIdle(); return; }
      if (seen !== gen || !idleToReload()) return; // stale: discard whatever it was, with no log, no probe and no IDLE
      if (confirmed.result === "page") { goIdle(); return; } // a sandboxed page of ours: left alone; re-checked once per wake, never polled
      if (confirmed.result === "unknown") {
        const reason = confirmed.reason === "timeout" ? "timeout, unsettled" : confirmed.reason;
        logOnce(confirmed.reason ?? "unknown", `load recovery: candidate unconfirmed (${reason})`);
        return; // fail closed for the reload, but keep converging: the finally reschedules
      }
      if (!confirmedLogged) {
        confirmedLogged = true;
        log(`load recovery: error document (committed=${snap.committedUrl} frame=${snap.frameUrl} origin=${snap.frameOrigin} href=${confirmed.href}), waiting for the server`);
      }
      let ok = false;
      try { ok = (await healthy()) === true; } catch { ok = false; }
      if (!isWatching) return;
      if (dead()) { goIdle(); return; }
      snap = readCandidate(); // every condition is read again after the await
      if (!snap) { goIdle(); return; }
      if (ok !== true || seen !== gen || !idleToReload()) return;
      const trusted = trustedOf(safe(() => origin(), null));
      if (trusted === null) return;
      const target = webOrigin(snap.entryUrl) === trusted ? snap.entryUrl : `${trusted}/`;
      log(`load recovery: the server answers again, reloading ${target}`);
      reloads += 1;
      nextReloadAt = now() + backoffMs[Math.min(reloads - 1, backoffMs.length - 1)];
      delay = backoffMs[Math.min(reloads - 1, backoffMs.length - 1)];
      try { reload(target); } catch { /* the window is going away */ }
    } finally {
      ticking = false;
      if (isWatching) {
        const wait = nextReloadAt - now();
        clearTimerNow();
        if (kickPending) { kickPending = false; schedule(0); }
        else schedule(wait > 0 && wait < delay ? wait : delay);
      }
    }
  }

  /** Events and kick() wake the loop. They never carry or store anything about their cause, and they read the sync candidate only. */
  const wake = () => {
    if (dead()) { goIdle(); return; }
    if (!readCandidate()) { goIdle(); return; }
    if (!isWatching) {
      enterWatching();
      void tick();
      return;
    }
    schedule(pollMs); // coalesced: a wake never brings the next tick forward
  };

  // Electron passes a details event (isMainFrame, isSameDocument); older builds pass positional (url, isInPlace, isMainFrame).
  contents.on("did-start-navigation", (event, _url, isInPlace, isMainFrame) => {
    const main = event?.isMainFrame ?? isMainFrame;
    const sameDocument = event?.isSameDocument ?? isInPlace;
    if (main === true && sameDocument !== true) gen += 1;
  });
  for (const name of ["did-fail-provisional-load", "did-fail-load"]) {
    contents.on(name, (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame !== false) wake(); });
  }
  for (const name of ["did-stop-loading", "did-finish-load", "did-navigate"]) contents.on(name, () => wake());
  contents.once?.("destroyed", () => { gone = true; goIdle(); });
  wake();
  return {
    /** The server child came back: probe now, with the backoff reset. The unsettled-call cap is not reset. */
    kick() {
      if (dead()) { goIdle(); return; }
      if (!readCandidate()) { goIdle(); return; }
      reloads = 0;
      nextReloadAt = 0;
      if (!isWatching) enterWatching();
      if (ticking) { kickPending = true; return; }
      clearTimerNow();
      void tick();
    },
    watching: () => isWatching,
  };
}
