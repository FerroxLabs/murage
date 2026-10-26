// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** What main sends a harness when the OS session is ending: write the deferred store saves now (server/graceful-shutdown.ts
 * APP_FLUSH_REQUEST_TYPE). `ack` names a file the harness creates once the writes are on disk; the harness keeps running. */
export const FLUSH_REQUEST_TYPE = "murage:flush";
/** How long main holds the OS callback for the harness's answer. Windows gives an app about 5 s after it is told the session ends. */
export const SESSION_FLUSH_WAIT_MS = 1_500;
/** The answer file's name, checked by the harness before it writes (server/graceful-shutdown.ts isFlushAckPath). */
export const flushAckName = (pid, nonce, index) => `murage-flush-${pid}-${nonce}-${index}`;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = performance.now() + ms; while (performance.now() < until) { /* no Atomics.wait here: spin */ } }
}

/** How long, after a call returns, another call of the same kind still belongs to the same OS notice. Windows delivers a query to each
 * window one after another; this keeps them in one notice so they share one deadline (docs: designs/SESSION-END-FLUSH-107.md). */
export const NOTICE_SETTLE_MS = 1_000;

/**
 * The OS ending the session (Windows logoff, restart or shutdown; macOS and Linux shutdown). Windows ends the app as soon as it returns
 * from the session-end callback, with no signal and no time for the graceful close, so posting a message is not enough: each live
 * harness is asked to write what it holds and this thread WAITS, synchronously and bounded, until each one has created its answer file.
 * The message is written to the harness's pipe at once (it does not need this thread's event loop), and the harness answers from its own
 * process, so the roster and channel saves still inside their 250 ms coalescing window (server/atomic.ts) are on disk before the
 * callback returns.
 *
 * One OS notice reaches every window (Electron 43.5 emits session-end on all windows inside one WM_ENDSESSION handler; Windows sends a
 * query to each window in turn), so the calls of one notice share ONE deadline: the whole notice holds the OS for at most `waitMs`.
 * Every call still posts a fresh flush (new nonce): nothing is merged or skipped. A call after the shared deadline posts without an
 * answer file and does not wait. A different kind (query, then end) is always a new notice with its own deadline.
 *
 * - query (Windows query-session-end): the session MAY end; another app can still cancel it. Flush only.
 * - end (Windows session-end) and shutdown (powerMonitor, macOS and Linux): the session IS ending. Flush, mark the quit, then quit through
 *   the ordinary path once.
 *
 * `children()` lists the harness processes this app owns (objects with post(message) => boolean); `ackDir` is a private temp folder.
 */
export function createSessionEndHandler({ children, beginQuit, quit, ackDir, log = () => {}, waitMs = SESSION_FLUSH_WAIT_MS, settleMs = NOTICE_SETTLE_MS, now = () => performance.now() }) {
  /** The OS notice in progress: its kind, the shared deadline, and until when a call of the same kind still joins it. */
  let notice = null;
  const flush = (kind, why) => {
    const started = now();
    if (!notice || notice.kind !== kind || started >= notice.until) notice = { kind, deadline: started + waitMs, until: started + waitMs };
    const { deadline } = notice;
    const nonce = randomUUID();
    const waiting = [];
    let asked = 0;
    let index = 0;
    for (const child of children()) {
      // Before the shared deadline the request names an answer file to wait for; after it, the harness still writes but nobody waits.
      const ack = now() < deadline ? path.join(ackDir, flushAckName(process.pid, nonce, index++)) : null;
      try {
        if (child.post(ack ? { type: FLUSH_REQUEST_TYPE, ack } : { type: FLUSH_REQUEST_TYPE })) { asked++; if (ack) waiting.push(ack); }
      } catch { /* exited or its port closed: it holds nothing to write */ }
    }
    let pending = waiting.filter(ack => !fs.existsSync(ack));
    while (pending.length && now() < deadline) { sleepSync(5); pending = pending.filter(ack => !fs.existsSync(ack)); }
    // Saved means an answer file that was read and says exactly "1". "0", other content, or a file that exists but cannot be read is not.
    let saved = 0, couldNotWrite = 0, unreadable = 0;
    for (const ack of waiting) {
      if (pending.includes(ack)) continue;
      let answer;
      try { answer = fs.readFileSync(ack, "utf8"); } catch { unreadable++; continue; }
      if (answer === "1") saved++; else couldNotWrite++;
      try { fs.unlinkSync(ack); } catch { /* already gone */ }
    }
    notice.until = Math.max(notice.until, now() + settleMs);
    const late = asked - waiting.length;
    log(`session ${why}: ${saved} of ${asked} harness process(es) wrote their deferred saves`
      + (couldNotWrite ? ` (${couldNotWrite} could not write)` : "")
      + (unreadable ? ` (${unreadable} answer(s) could not be read)` : "")
      + (pending.length ? ` (${pending.length} did not answer within ${waitMs} ms)` : "")
      + (late ? ` (${late} asked after this notice's ${waitMs} ms, not waited for)` : ""));
  };
  let quitting = false;
  const endNow = (kind, why) => {
    flush(kind, why);
    beginQuit();
    if (quitting) return;
    quitting = true;
    quit();
  };
  return {
    query() { flush("query", "may end"); },
    end() { endNow("end", "ending"); },
    shutdown() { endNow("shutdown", "shutting down"); },
  };
}
