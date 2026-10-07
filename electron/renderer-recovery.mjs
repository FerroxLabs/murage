// When the window's renderer process is killed from outside (the 2026-10-05
// `killall "Murage Helper"` left a black window for 2.5 hours), the main
// process reloads it once the server answers, or shows the recovery page if
// the server cannot come back. Pure decisions with injected effects, so it is
// tested without Electron.

/** Reasons that mean the renderer was lost, not that it closed cleanly. */
export const RECOVERABLE_RENDERER_REASONS = Object.freeze(["killed", "crashed", "oom", "abnormal-exit"]);
export const RENDERER_RELOAD_WINDOW_MS = 120_000;
export const MAX_RENDERER_RELOADS_IN_WINDOW = 3;
export const SERVER_WAIT_MS = 60_000;
export const SERVER_POLL_MS = 500;
export const RECONNECTING_LINE = "Reconnecting…";

/**
 * @param {{
 *   quitting: () => boolean,
 *   serverState: () => string,
 *   healthy: () => Promise<boolean>,
 *   showReconnecting: () => void,
 *   load: () => void,
 *   showRecovery: () => void,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createRendererRecovery({ quitting, serverState, healthy, showReconnecting, load, showRecovery, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  let reloads = [];
  let inFlight = false;
  async function waitForServer() {
    const deadline = now() + SERVER_WAIT_MS;
    for (;;) {
      if (quitting()) return false;
      const state = serverState();
      if (state === "failed") return false;
      if (state === "running" && await healthy().catch(() => false)) return true;
      if (now() >= deadline) return false;
      await sleep(SERVER_POLL_MS);
    }
  }
  return {
    /** @returns {Promise<"ignored" | "reloaded" | "recovery">} */
    async onGone({ reason }) {
      if (quitting() || !RECOVERABLE_RENDERER_REASONS.includes(reason)) return "ignored";
      if (inFlight) return "ignored";
      inFlight = true;
      try {
        const at = now();
        reloads = reloads.filter((when) => at - when < RENDERER_RELOAD_WINDOW_MS);
        if (reloads.length >= MAX_RENDERER_RELOADS_IN_WINDOW) {
          log("renderer recovery: reload loop, showing recovery");
          showRecovery();
          return "recovery";
        }
        reloads.push(at);
        showReconnecting();
        if (!(await waitForServer())) {
          if (quitting()) return "ignored";
          log("renderer recovery: server did not come back, showing recovery");
          showRecovery();
          return "recovery";
        }
        load();
        return "reloaded";
      } finally {
        inFlight = false;
      }
    },
  };
}

/** After the GPU process is lost Electron starts a new one; ask each window to
 * repaint so it does not sit on a stale frame. */
export function repaintAfterGpuLoss(windows) {
  for (const win of windows) {
    try {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.invalidate();
    } catch { /* the window is going away */ }
  }
}
