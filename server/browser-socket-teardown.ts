// TEARING A BROWSER SOCKET DOWN WITHOUT KILLING THE SERVER.
//
// THE DEFECT, SHIPPED IN 0.1.57. Two places tore a WebSocket down with
// `removeAllListeners()` followed by `terminate()`, and that order ends the
// process. `terminate()` on a socket whose handshake never finished emits
// `'error'` on a LATER TICK, and `removeAllListeners()` has just taken away
// the handler that would have heard it. An `'error'` event with no listener
// does not warn on an EventEmitter — it throws — and this one throws inside a
// timer callback, where no `try` can reach it.
//
// The owner's install died exactly this way at 02:58:16Z on 2026-09-22, in
// the middle of a conversation:
//
//   Error: WebSocket was closed before the connection was established
//       at _WebSocket.terminate … at Object.resetStream
//       at UnifiedBrowserController.dispatch … at previewCapture
//       at captureOutsideHumanControl … at Timeout._onTimeout
//   Unhandled 'error' event → exited code=1
//
// `previewCapture` runs on a timer, so nobody has to touch the browser for it
// to fire, and on screen it does not look like a browser fault at all: every
// bot stops mid-turn, memory stops answering, tools stop, and a new message
// reports that it could not be queued. There is no server left to queue it.
//
// It existed twice because the teardown was written twice. It lives here now
// so there is one of it, and so it can be tested — the two call sites both
// hold their socket in a closure, where no test can reach the state that
// crashes.
import type WebSocket from "ws";

/**
 * Drop a socket and make sure whatever noise it makes on the way out is
 * heard by something.
 *
 * The no-op listener is the entire point and must not be "tidied away": it is
 * the ear for an `'error'` that arrives after every real handler is gone.
 */
export function closeSocketQuietly(socket: WebSocket | undefined | null): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.on("error", () => {});
  socket.terminate();
}
