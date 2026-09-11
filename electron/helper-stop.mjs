// Owned native helper stop (0.1.52 R2-T4, audit B5, adopted default U-15).
//
// Dictation and the skill recorder each run a macOS helper app launched through
// `/usr/bin/open -W`. A helper stops only when it sees its stop marker, and the
// `open` waiter's close is the only observed helper exit; killing that waiter
// would not stop the helper. So a Stop:
// - keeps the exact session owned until the helper's exit is observed,
// - reports a failed marker write and keeps ownership, so the next Stop, Start
//   or Quit writes the marker again,
// - waits no longer than the existing owned-work deadline; on expiry the
//   session stays owned and the caller reports it.
// Nothing here kills a process, and nothing ever matches one by name.
import { OWNED_WORK_TIMEOUT_MS } from "./server-child-lifecycle.mjs";

export const HELPER_STOP_TIMEOUT_MS = OWNED_WORK_TIMEOUT_MS;

function helperStopError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

/** Exit observation for one helper session. `markExited` is idempotent. */
export function createHelperExit() {
  let exited = false;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {
    promise,
    get exited() {
      return exited;
    },
    markExited() {
      if (exited) return;
      exited = true;
      resolve();
    },
  };
}

/**
 * Ask one owned helper session (`{ exit, stopRequested }`) to stop, then wait
 * for its observed exit. The owner clears its own session reference when the
 * exit arrives; a rejection here always means the session is still owned.
 */
export async function stopOwnedHelper(session, { name, writeMarker, timeoutMs = HELPER_STOP_TIMEOUT_MS }) {
  session.stopRequested = true;
  if (session.exit.exited) return;
  try {
    writeMarker();
  } catch (cause) {
    throw helperStopError(
      "HELPER_STOP_SIGNAL_FAILED",
      `${name} did not receive its stop signal. Murage is still tracking it; try again.`,
      cause,
    );
  }
  let timer;
  try {
    await Promise.race([
      session.exit.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(helperStopError(
            "HELPER_EXIT_TIMEOUT",
            `${name} has not exited yet. Murage is still tracking it; wait, then try again.`,
          )),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
