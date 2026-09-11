// Owned-main-sender predicate (0.1.52 K0 contract, audit B6).
//
// One shared answer to "did this IPC come from the top frame of the window
// we own, still showing our own renderer origin?". Privileged handlers
// (secret issuance, capture, credentials, recorder save, native file
// actions) call it before doing anything. It fails closed on every missing
// or unexpected shape: a destroyed window, a different webContents, a
// subframe, a detached frame, a navigated-away origin, an opaque origin.
//
// It is deliberately a pure function of the event and the expected window
// and origin, so tests exercise it without Electron.

/** The renderer origin the main window is expected to show. */
export function mainRendererOrigin({ packaged, serverPort, devUrl }) {
  const url = packaged ? `http://127.0.0.1:${serverPort}` : devUrl;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * @param {{ sender?: any, senderFrame?: any } | null | undefined} event IPC event
 * @param {{ window: any, origin: string | null | undefined }} expected
 * @returns {boolean}
 */
export function isOwnedMainSender(event, { window, origin } = {}) {
  try {
    if (!event || !window || typeof window.isDestroyed !== "function" || window.isDestroyed()) return false;
    const contents = window.webContents;
    const sender = event.sender;
    if (!contents || !sender || sender !== contents) return false;
    if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== sender.mainFrame || frame.detached === true) return false;
    if (typeof origin !== "string" || !origin) return false;
    const expected = new URL(origin).origin;
    if (expected === "null" || typeof frame.url !== "string" || !frame.url) return false;
    return new URL(frame.url).origin === expected;
  } catch {
    return false;
  }
}
