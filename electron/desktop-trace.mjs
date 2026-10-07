// SPDX-License-Identifier: AGPL-3.0-or-later
// Cold-start timing marks for the desktop main process, behind
// MURAGE_TURN_TRACE=1 like the server's startup marks. Off, a mark is one
// environment read. `ms` is milliseconds since this process started, so the gap
// between two marks is the cost of the step between them. Fixed step names only.
export function createDesktopTrace({ env = process.env, now = () => performance.now(), sink } = {}) {
  return function desktopMark(step) {
    if (env.MURAGE_TURN_TRACE !== "1") return;
    try { sink?.(`[desktop-trace] phase=${step} ms=${Math.round(now())}`); } catch { /* tracing never changes a run */ }
  };
}
