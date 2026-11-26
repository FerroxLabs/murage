// THE SERVER CHILD DIED TWICE IN ONE DAY AND LEFT NO NOTE.
//
// Both outages on 2026-09-22 were the same class of fault — an event nobody
// was listening for, ending the process that holds every bot, the memory, the
// tools, the browser and the phone:
//
//   02:58:16Z  an unhandled 'error' on a WebSocket  → browser-socket-teardown.ts
//   05:43:42Z  `write EPIPE` on a child's stdin pipe → child-pipe-quiet.mjs
//
// Those two files remove two known ways to die. This file does not remove any:
// it makes the NEXT one — the one nobody has met yet — say what it was on its
// way out. The desktop shell has had exactly this since the diagnostics work
// (electron/diagnostics.mjs, installDesktopCrashListeners, wired in
// electron/main.mjs). The server child, which is where the owner's work
// actually lives, has had nothing.
//
// OBSERVE, DO NOT SWALLOW. The instrument is `uncaughtExceptionMonitor`, and
// the choice is deliberate:
//
//   - `process.on("uncaughtException", …)` would also see the error — and
//     would CONSUME it. Node then does not exit, and the server keeps serving
//     from whatever half-written state the fault left behind: a turn that
//     never settled, a store mutation applied to memory and not to disk, a
//     lease held by nobody. A server that lies about being healthy is worse
//     than one that died, because supervision cannot see it. We are not
//     buying uptime here; we are buying a sentence in the log.
//   - `uncaughtExceptionMonitor` cannot change the outcome even by accident.
//     Node calls monitor listeners and then proceeds down its normal fatal
//     path regardless of what they do. There is no "handled" flag to set.
//
// UNHANDLED REJECTIONS COUNT, AND ARRIVE HERE TOO. Node's default rejection
// mode (`--unhandled-rejections=throw`) raises an unhandled rejection through
// the same fatal path, and the monitor is called with `origin` set to
// "unhandledRejection". That is why `diagnostics.mjs` allowlists both origins
// in MAIN_FAILURE_ORIGINS, and why this file does too. It holds only while
// nothing in the server registers a plain `process.on("unhandledRejection")`
// listener — such a listener would swallow every rejection before it ever
// became fatal. Nothing in this repo does; `server-child-crash.test.ts` pins
// the rejection path end to end so a future one cannot land unnoticed.
//
// WHY THE WRITE IS SYNCHRONOUS. `process.stderr` in the forked server child is
// a PIPE, and on POSIX a pipe-backed stdio stream is asynchronous. A line
// written to it during a fatal exception is queued, and if anything is already
// queued ahead of it — which is the normal state of a busy server's log — the
// process dies before the queue drains and the line is simply never seen.
// That is not a theory: `server-child-crash.test.ts` runs both, with a backlog
// ahead of them, and the asynchronous line is absent from the parent's capture
// every single time while the synchronous one is present every single time.
// `fs.writeSync` goes straight at the file descriptor and returns only when
// the bytes are gone.

import { writeSync } from "node:fs";

// Origins, exactly as diagnostics.mjs allowlists them. Anything else is not a
// shape we recognise and is reported as the conservative default rather than
// echoed.
const FAILURE_ORIGINS = new Set(["uncaughtException", "unhandledRejection"]);

// WHAT THIS LINE IS ALLOWED TO CONTAIN, AND WHY IT IS SO LITTLE.
//
// The server child holds API keys, message bodies, file paths under the
// owner's home directory, browser URLs and phone numbers. An error's
// `message` and `stack` are the places all of that ends up: a provider client
// puts the request URL (query string and all) in the message, a config parser
// quotes the offending value, a fetch failure names the host. So neither ever
// reaches this line — not redacted, not truncated, not at all. Redaction is a
// filter over text you have decided to publish; the cheaper and stronger move
// for a one-line crash marker is to publish no free text in the first place.
//
// Admitted: the ORIGIN (one of two fixed strings) and the error's CLASS NAME,
// and the class name only if it is one of the eight built-in Error types.
// Together they answer the question this line exists to answer — "was it a
// throw or a dropped promise, and roughly what kind of fault" — and neither
// can carry a value. The allowlist is what makes the class name safe: a
// bespoke `FluxAuthError` or a subclass someone named after the failing
// account does NOT pass, and is reported as the generic "Error". Losing that
// detail is the intended trade. This line goes to the server log, and the
// server log is what the owner pastes into a public issue.
//
// The obvious objection, and its answer: Node's own fatal dump prints the
// message and the stack to this same stderr a moment later, so what is the
// point? Two things. First, that dump is Node's, arbitrary and unstructured,
// and the diagnostics export scrubs it as free text on the way out
// (redactSecretsInLine, electron/diagnostics.mjs) — a structured field of our
// own reading `error=auth failed for https://…?key=…` would sail through that
// scrubber as a single unrecognised token and hand the export a copy the
// pattern matcher cannot see. Second, this line is the one meant to be quoted
// and pasted, which makes it exactly the one that must be safe to quote and
// paste. Adding no new copy of a secret is a lower bar than removing one, and
// it is the bar this file clears.
const ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/** The marker a reader greps for. Deliberately distinct from the desktop's
 * `main-process-failure`, so a log carrying both says which process died. */
export const SERVER_CHILD_FAILURE_EVENT = "server-child-failure";

function safeErrorName(error) {
  try {
    // `name` is an own or inherited string property and a subclass is free to
    // set it to anything, so it is checked against the allowlist rather than
    // trusted. A getter that throws falls through to the catch below.
    const name = error?.name;
    return typeof name === "string" && ERROR_NAMES.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

/**
 * Build the one line. No timestamp: the desktop parent stamps every line it
 * reads off this child's stderr (`slog` in electron/main.mjs), and a second
 * clock in the same line would only invite the two to disagree.
 *
 * @param {unknown} error the value Node was about to die of
 * @param {unknown} origin Node's origin argument
 * @returns {string} a complete line, newline included
 */
export function formatServerChildFailure(error, origin) {
  const safeOrigin =
    typeof origin === "string" && FAILURE_ORIGINS.has(origin) ? origin : "uncaughtException";
  return `event=${SERVER_CHILD_FAILURE_EVENT} origin=${safeOrigin} error=${safeErrorName(error)}\n`;
}

// A synchronous pause, which is normally a mistake and is the right tool
// exactly once: between EAGAIN retries on the fatal path, where yielding to
// the event loop is not an option because there will be no next tick. Without
// it the retry budget below burns through in microseconds while the pipe is
// still full, which is the same as not retrying at all.
function pauseBriefly() {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  } catch {
    // Unavailable (a locked-down embedder); retry immediately instead.
  }
}

/**
 * Write one line straight at a file descriptor, synchronously.
 *
 * EAGAIN is the one failure worth retrying: a pipe whose reader is behind
 * refuses the write rather than blocking, and giving up on the first refusal
 * would lose exactly the crash line that a busy, backlogged server most needs
 * to emit. The budget is bounded — at most 64 attempts, each waiting at most a
 * millisecond — because this runs on the way to process death and must
 * terminate. Every other failure (a closed pipe, a parent already gone) is
 * silently accepted: crash reporting must never become the cause of a crash.
 *
 * @param {string} line
 * @param {number} fd
 */
export function writeCrashLineSync(line, fd = 2) {
  const payload = Buffer.from(line, "utf8");
  let written = 0;
  for (let attempt = 0; attempt < 64 && written < payload.length; attempt += 1) {
    try {
      written += writeSync(fd, payload, written);
    } catch (error) {
      if (error?.code !== "EAGAIN") return;
      pauseBriefly();
    }
  }
}

/**
 * Install the observer. It changes nothing about how this process dies.
 *
 * Dependencies are injected for the same reason diagnostics.mjs injects them:
 * so the wiring can be exercised without spawning, while the real proof — that
 * the process still dies, and that the line survives the death — is done by
 * `server-child-crash.test.ts` against a process of its own.
 *
 * @param {{ processTarget?: NodeJS.Process, write?: (line: string) => void }} [options]
 * @returns {() => void} disposer, for tests; production never calls it
 */
export function installServerChildCrashObserver({
  processTarget = process,
  write = writeCrashLineSync,
} = {}) {
  const onFailure = (error, origin) => {
    try {
      write(formatServerChildFailure(error, origin));
    } catch {
      // A throw from here would run inside Node's fatal path and could turn a
      // legible crash into a confusing one. The record is worth less than the
      // crash it records.
    }
  };
  processTarget.on("uncaughtExceptionMonitor", onFailure);
  return () => processTarget.off("uncaughtExceptionMonitor", onFailure);
}

// WHY THE SERVER ENDED, EVERY TIME IT CAN SAY SO (cause12, 2026-11-21).
//
// Twenty-two server starts in three days on the owner's Mac, and for eight of
// them the log could not say whether the previous server was asked to close,
// threw, or was killed: the only exit record was the I/O census, which is
// written only when launch counts are non-zero and was dropped outright when
// stderr's pipe was full. These two lines close that gap from the inside:
//
//   event=server-child-close via=<SIGTERM|SIGINT|message|restart>
//       written the moment a close is asked for; a repeat while the first is
//       still running is written too (bounded), because a second SIGTERM is
//       the desktop's kill after its grace period ran out.
//   event=server-child-exit code=<n> cause=<close:<via>|failure|none>
//       written on EVERY 'exit' event, whatever the census counts.
//
// So a server whose last word is a close line and no exit line stalled in
// shutdown and was killed; one with neither was killed or aborted from
// outside (SIGKILL, V8 heap abort, a native fault: no JavaScript runs for
// those, and the desktop's "exited code=" line names the signal). Same rules
// as the failure line above: fixed vocabulary only, synchronous, never throws.

/** Marker for a close request the server received. */
export const SERVER_CHILD_CLOSE_EVENT = "server-child-close";
/** Marker for the server's exit event. */
export const SERVER_CHILD_EXIT_EVENT = "server-child-exit";
const CLOSE_VIAS = new Set(["SIGTERM", "SIGINT", "message", "restart"]);
/** Repeats beyond this are not news: the first ones already say it is stuck. */
const MAX_CLOSE_REPEATS = 3;

/**
 * Install the exit note. Returns `closeRequested(via)` for the server's close
 * paths to call, and a disposer for tests.
 *
 * @param {{ processTarget?: NodeJS.Process, write?: (line: string) => void }} [options]
 * @returns {{ closeRequested: (via: unknown) => void, dispose: () => void }}
 */
export function installServerChildExitNote({
  processTarget = process,
  write = writeCrashLineSync,
} = {}) {
  let cause = "none";
  let repeats = 0;
  const emit = (line) => {
    try { write(line); } catch { /* the record is worth less than the exit it records */ }
  };
  const onFailure = () => { cause = "failure"; };
  const onExit = (code) => {
    emit(`event=${SERVER_CHILD_EXIT_EVENT} code=${Number.isInteger(code) ? code : "-"} cause=${cause}\n`);
  };
  processTarget.on("uncaughtExceptionMonitor", onFailure);
  processTarget.once("exit", onExit);
  return {
    closeRequested(via) {
      const safeVia = typeof via === "string" && CLOSE_VIAS.has(via) ? via : "other";
      if (cause === "none") {
        cause = `close:${safeVia}`;
        emit(`event=${SERVER_CHILD_CLOSE_EVENT} via=${safeVia}\n`);
        return;
      }
      if (repeats >= MAX_CLOSE_REPEATS) return;
      repeats += 1;
      emit(`event=${SERVER_CHILD_CLOSE_EVENT} via=${safeVia} repeat=${repeats} still-closing\n`);
    },
    dispose() {
      processTarget.off("uncaughtExceptionMonitor", onFailure);
      processTarget.off("exit", onExit);
    },
  };
}
