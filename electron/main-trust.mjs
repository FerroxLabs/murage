// Owned-main-sender predicate (0.1.52 K0 contract, audit B6).
//
// One shared answer to "did this IPC come from the top frame of the window
// we own, still showing our own renderer origin?". Privileged handlers
// (secret issuance, capture, credentials, recorder save, native file
// actions) call it before doing anything. It fails closed on every missing
// or unexpected shape: a destroyed window, a different webContents, a
// subframe, a detached frame from a dead process, a navigated-away origin, an opaque origin.
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
 * A parentless frame in the contents' CURRENT renderer process with the same
 * routing id as its main frame. A subframe, a frame left from a dead process
 * or another window's frame fails this.
 */
function isLiveTopFrame(frame, sender) {
  const main = sender.mainFrame;
  if (frame.parent !== null || !main || typeof sender.getProcessId !== "function") return false;
  const pid = sender.getProcessId();
  return Number.isInteger(pid) && frame.processId === pid && main.processId === pid
    && Number.isInteger(frame.routingId) && frame.routingId === main.routingId;
}

/**
 * The window's CURRENT top frame, judged at call time. After the renderer
 * process is replaced (killed, crashed, reloaded) Electron can hand the IPC
 * event a frame wrapper that is not the same object as `sender.mainFrame`,
 * and Electron 43 keeps `detached: true` on the main frame wrapper itself
 * (2026-10-06, measured: frame === mainFrame, same pid and routing id, same
 * origin, detached=true; every privileged IPC refused until the app was
 * reopened). So a detached mark alone does not refuse: a detached frame must
 * prove it lives in the current process. Nothing is cached from window creation.
 */
function isCurrentTopFrame(frame, sender) {
  if (frame.detached === true) return isLiveTopFrame(frame, sender);
  return frame === sender.mainFrame || isLiveTopFrame(frame, sender);
}

/**
 * The shared front half of both sender predicates: the event came from the CURRENT top frame of `window`'s own
 * webContents. Returns that frame, or null (fail closed on every missing or unexpected shape).
 */
function currentTopFrameOf(event, window) {
  if (!event || !window || typeof window.isDestroyed !== "function" || window.isDestroyed()) return null;
  const contents = window.webContents;
  const sender = event.sender;
  if (!contents || !sender || sender !== contents) return null;
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) return null;
  const frame = event.senderFrame;
  if (!frame || !isCurrentTopFrame(frame, sender)) return null;
  return frame;
}

/**
 * @param {{ sender?: any, senderFrame?: any } | null | undefined} event IPC event
 * @param {{ window: any, origin: string | null | undefined }} expected
 * @returns {boolean}
 */
export function isOwnedMainSender(event, { window, origin } = {}) {
  try {
    const frame = currentTopFrameOf(event, window);
    if (!frame) return false;
    if (typeof origin !== "string" || !origin) return false;
    const expected = new URL(origin).origin;
    if (expected === "null" || typeof frame.url !== "string" || !frame.url) return false;
    return new URL(frame.url).origin === expected;
  } catch {
    return false;
  }
}

/**
 * B3 WP3: did this IPC come from the top frame of the Cloud-home window for `homeId`, still showing a
 * murage-home://<homeId>/ document? (A privileged custom scheme has an opaque URL origin, so the scheme and host
 * are compared directly.) Same fail-closed frame rules as isOwnedMainSender.
 *
 * @param {{ sender?: any, senderFrame?: any } | null | undefined} event
 * @param {{ window: any, homeId: string }} expected
 */
export function isCloudHomeSender(event, { window, homeId } = {}) {
  try {
    const frame = currentTopFrameOf(event, window);
    if (!frame || typeof homeId !== "string" || !homeId) return false;
    if (typeof frame.url !== "string" || !frame.url) return false;
    const url = new URL(frame.url);
    return url.protocol === "murage-home:" && url.hostname === homeId && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

/**
 * B3 WP4: which Cloud-home window an IPC event came from. `windows` is homeId -> BrowserWindow. Returns the homeId, or
 * null for anything that is not the CURRENT top frame of one of those windows showing its own murage-home://<homeId>/
 * document. The cloud-safe handlers (unread badge, approval notification) use this, so a cloud sender is never judged
 * by the main window's rules and the main window is never mistaken for a cloud one.
 */
export function cloudHomeSenderId(event, windows) {
  try {
    for (const [homeId, window] of windows) if (isCloudHomeSender(event, { window, homeId })) return homeId;
  } catch {}
  return null;
}

/** Why isOwnedMainSender refused, for the refusal log line only: booleans,
 * process and routing ids and origins, never content or secrets. */
export function explainOwnedMainSender(event, { window, origin } = {}) {
  try {
    const contents = window && !window.isDestroyed?.() ? window.webContents : null;
    const sender = event?.sender, frame = event?.senderFrame, main = sender?.mainFrame;
    const pid = typeof sender?.getProcessId === "function" ? sender.getProcessId() : null;
    let frameOrigin = null; try { frameOrigin = frame?.url ? new URL(frame.url).origin : null; } catch { frameOrigin = "unparsable"; }
    return [`window=${Boolean(contents)}`, `sameContents=${Boolean(sender) && sender === contents}`, `frame=${Boolean(frame)}`,
      `detached=${frame?.detached === true}`, `isMainFrame=${frame === main}`, `parent=${frame ? frame.parent !== null : "n/a"}`,
      `pid=${pid}`, `framePid=${frame?.processId}`, `mainPid=${main?.processId}`, `frameRid=${frame?.routingId}`, `mainRid=${main?.routingId}`,
      `frameOrigin=${frameOrigin}`, `expected=${origin ?? null}`].join(" ");
  } catch (error) { return `explain-failed ${error?.message ?? error}`; }
}
