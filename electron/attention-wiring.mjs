// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S4a: the wiring between the OS and the action path. Pure (everything the OS offers is injected), so it tests
// with fakes. Two jobs:
//  1. createLockReader: an EXPLICIT boolean for "is the screen locked" (Electron's getSystemIdleState on Mac and Windows, logind's
//     LockedHint on Linux), or undefined when the OS cannot say. lock-state.mjs treats undefined as unknown, and unknown as locked,
//     so Allow and Reply stay refused until something has really said "unlocked".
//  2. wireAttentionInvalidation: every event that must kill outstanding tokens (lock, suspend, server restart or recovery,
//     data-owner change, Cloud window swap, previews change) calls actions.invalidateAll, and a resume asks the OS again.

const IDLE_THRESHOLD_SECONDS = 1; // getSystemIdleState needs a threshold above 0; "locked" does not depend on it.

/** deps: { platform, getSystemIdleState(seconds) -> string, execFile(file, args, opts, cb), env }. Returns an async () => true | false | undefined. */
export function createLockReader({ platform, getSystemIdleState, execFile, env = process.env, healthy = null }) {
  if (platform === "darwin" || platform === "win32") {
    return async () => {
      let state;
      try { state = getSystemIdleState(IDLE_THRESHOLD_SECONDS); } catch { return undefined; }
      if (state === "locked") return true;
      if (state === "active" || state === "idle") return false;
      return undefined; // "unknown" or anything new: the OS did not say
    };
  }
  if (platform === "linux") {
    return () => new Promise(resolve => {
      // Electron's lock-screen events do not exist on Linux: without a healthy logind watcher nothing may say "unlocked".
      if (typeof healthy === "function" && !healthy()) return resolve(undefined);
      const session = typeof env?.XDG_SESSION_ID === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(env.XDG_SESSION_ID) ? env.XDG_SESSION_ID : "auto";
      try {
        execFile("loginctl", ["show-session", session, "-p", "LockedHint", "--value"], { timeout: 2000, windowsHide: true }, (error, stdout) => {
          if (error) return resolve(undefined);
          const answer = String(stdout ?? "").trim().toLowerCase();
          resolve(answer === "yes" ? true : answer === "no" ? false : undefined);
        });
      } catch { resolve(undefined); }
    });
  }
  return async () => undefined;
}

/**
 * Linux: logind announces lock changes as PropertiesChanged signals (LockedHint) on the system bus; Electron emits no lock event there.
 * This follows them with `dbus-monitor` (no timers, one child). `spawn(file, args)` is injected. healthy() is false whenever the monitor
 * is not running, and onLost fires then, so the lock state fails closed. (S4c replaces this with its persistent dbus-next connection.)
 */
export function createLogindWatcher({ spawn }) {
  let ok = false;
  return {
    healthy: () => ok,
    start(onEvent, onLost, onReady = () => {}) {
      let stopped = false, child = null, tail = "";
      // Loss is terminal for this instance: everything after it (buffered data included) is ignored; health returns only through a new start().
      const lose = () => { if (stopped) return; stopped = true; ok = false; const dead = child; child = null; try { dead?.kill?.(); } catch { /* already gone */ } try { onLost(); } catch { /* never throws into main */ } };
      try {
        child = spawn("dbus-monitor", ["--system", "type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'"]);
        // NOT healthy yet: a lock signal sent before the subscription exists would be missed. The monitor is ready when it has
        // produced its first output (the bus daemon's own first message on the new connection); until then Allow and Reply stay refused.
        // S0 proves this on GNOME and KDE; if a desktop never says anything, the buttons stay Open-only there (fail closed).
        // A name can span two chunks: search the previous chunk's last characters together with this one.
        child.stdout?.on?.("data", chunk => {
          if (stopped) return;
          if (!ok) { ok = true; try { onReady(); } catch { /* never throws into main */ } }
          const text = tail + String(chunk);
          tail = text.slice(-("LockedHint".length - 1));
          if (text.includes("LockedHint")) { tail = ""; try { onEvent(); } catch { /* never throws into main */ } }
        });
        child.stdout?.on?.("error", lose); child.stdout?.on?.("close", lose);
        child.on?.("error", lose); child.on?.("exit", lose);
      } catch { child = null; lose(); }
      return () => { stopped = true; ok = false; try { child?.kill?.(); } catch { /* already gone */ } };
    },
  };
}

/**
 * deps: { actions: {invalidateAll(reason)}, lock: {onChange(cb), refresh(), markUnknown()}, powerMonitor: {on(event, cb)}, logind?: watcher }.
 * Create the lock state BEFORE this, so its own event handlers run first. Returns the notifiers main calls for the events that do
 * not come from powerMonitor, and a dispose.
 */
export function wireAttentionInvalidation({ actions, lock, powerMonitor, logind = null }) {
  const kill = reason => { try { actions.invalidateAll(reason); } catch { /* invalidation never throws into the caller */ } };
  const listeners = [];
  const on = (event, handler) => {
    if (powerMonitor && typeof powerMonitor.on === "function") { powerMonitor.on(event, handler); listeners.push([event, handler]); }
  };
  on("lock-screen", () => kill("lock-screen"));
  on("suspend", () => kill("suspend"));
  // After a wake the state is unknown (locked) until the OS says otherwise.
  on("resume", () => { void lock.refresh().catch(() => {}); });
  const stopLock = lock.onChange(locked => { if (locked) kill("locked"); });
  const stopLogind = logind ? logind.start(() => { lock.markUnknown?.(); kill("logind-signal"); void lock.refresh().catch(() => {}); }, () => { lock.markUnknown?.(); kill("logind-lost"); }, () => { lock.markUnknown?.(); kill("logind-ready"); void lock.refresh().catch(() => {}); }) : null;
  void lock.refresh().catch(() => {});
  return {
    serverChanged: () => kill("server"),
    ownerChanged: () => kill("data-owner"),
    cloudWindowChanged: () => kill("cloud-window"),
    previewsChanged: () => kill("previews"),
    dispose() {
      stopLock?.();
      stopLogind?.();
      for (const [event, handler] of listeners) { try { powerMonitor.removeListener?.(event, handler); } catch { /* shutting down */ } }
      listeners.length = 0;
    },
  };
}
