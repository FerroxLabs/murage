// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud links (murage://open-cloud, murage://connect-cloud, murage://door): ONE slot between the moment a link reaches main
// (open-url before or after ready, argv on a cold start, second-instance, the sealed handoff, the clipboard) and the moment
// main can act on it. Pure: no Electron. Nothing here logs; a door link carries a ticket.
//
// A link drains only when the app is ready, Cloud is live (the shared live gate, never a private switch) and the main window
// has loaded, so the Connect card it updates is on screen. A newer link replaces an older one that has not drained. While
// Cloud is not live a link asks the gate for one bounded probe; still not live, the link is dropped and the person is told.

/**
 * @param {object} deps
 * @param {() => boolean} deps.ready app.whenReady() has resolved
 * @param {() => boolean} deps.live the shared live gate (cloudHome.active())
 * @param {() => boolean} deps.windowLoaded the main window exists and its page has loaded
 * @param {(link: object) => (void | Promise<void>)} deps.handle acts on one link; never sees a link twice
 * @param {() => Promise<boolean>} deps.probe one bounded live probe (gate.probeNow()); resolves the gate's answer
 * @param {(link: object) => void} deps.notLive the probe said no: tell the person once; the link is dropped
 */
export function createCloudLinkQueue({ ready, live, windowLoaded, handle, probe = async () => false, notLive = () => {} }) {
  let pending = null;
  let probing = false;

  function drain() {
    if (!pending || !ready()) return false;
    if (!live()) {
      if (probing) return false;
      probing = true;
      void Promise.resolve().then(probe).catch(() => false).then((answer) => {
        probing = false;
        if (!pending) return;
        if (answer === true || live()) { drain(); return; }
        const dropped = pending; pending = null;
        notLive(dropped);
      });
      return false;
    }
    if (!windowLoaded()) return false;
    const link = pending; pending = null;
    void Promise.resolve().then(() => handle(link)).catch(() => {});
    return true;
  }

  return {
    /** A newer link replaces an older one that has not drained yet. */
    enqueue(link) { if (!link || typeof link.kind !== "string") return false; pending = link; drain(); return true; },
    drain,
    /** The kind waiting, for the window to show (never the link itself). */
    pendingKind: () => pending?.kind ?? null,
  };
}
