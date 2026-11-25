// THE WINDOW FOLLOWS THE ENGINE TO ITS NEW PORT.
//
// THE DEFECT THIS EXISTS FOR. On 2026-11-18 the server child exited under heavy
// load. The supervisor's replacement found 8799 held by an unrelated local
// program and started the engine on 18799, as startServerPackaged allows. The
// window stayed on http://127.0.0.1:8799: every call went to the other program,
// every chat showed a red "no such route" and "Loading messages..." for ever.
//
// A replacement on the SAME port is no better for a window that stays put: the
// new child mints its own desktop secret (server/sse-visibility.ts) and the
// preload read the old one once, so the new engine answers the old page as an
// unproven caller. So every replacement that comes up moves the window: a reload
// at the engine's origin, or a fresh window when the origin changed (the
// preload's bridge belongs to the one origin its window was created for, B6).
//
// Pure module: no Electron import.
import { createHash } from "node:crypto";

/** The response header that names the engine launch that answered (server/index.ts). */
export const LAUNCH_HEADER = "x-murage-launch";

/** The launch id the engine forked with `nonce` puts in every answer: the
 *  SHA-256 of the nonce, computed exactly as server/memory/boot-nonce.ts does. */
export function launchIdOf(nonce) {
  return createHash("sha256").update(String(nonce)).digest("hex");
}

const MAX_THREAD_ID = 512;

/** A thread id the renderer reported, or null: the same bound deep links use (src/lib/deep-link.ts). */
export function openChatThread(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_THREAD_ID ? value : null;
}

/**
 * Where the main window goes once a replacement engine answers.
 *
 * `windowOrigin` is the origin the window was created for (its preload's
 * bridge origin), `serverOrigin` the replacement's. The open chat comes back
 * through the existing `#open=` deep link.
 *
 * @returns {{ mode: "reload" | "replace", url: string }}
 */
export function restartedWindowTarget({ windowOrigin, serverOrigin, openThread }) {
  const url = new URL(serverOrigin);
  url.pathname = "/";
  url.search = "";
  const thread = openChatThread(openThread);
  url.hash = thread ? new URLSearchParams({ open: thread }).toString() : "";
  return { mode: windowOrigin === url.origin ? "reload" : "replace", url: url.toString() };
}
