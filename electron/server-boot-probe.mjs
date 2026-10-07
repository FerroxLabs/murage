// Kernel of the packaged-server boot wait (see issue #506): poll a freshly
// forked child's /api/health until it either proves its identity, we learn
// some other process owns the port, or the wall-clock budget runs out.
//
// Extracted from electron/main.mjs so the failure modes below can carry
// regression tests without booting Electron (main.mjs is not importable in a
// bare node test — importing it starts the whole app bootstrap).
//
// - The budget is wall-clock and shared by every step: each in-flight probe is
//   aborted at the remaining deadline, so a server that accepts connections
//   but never answers cannot wedge the launcher past its own timeout.
// - ANY HTTP answer on the port proves somebody owns it. Only our own child's
//   identity payload counts as ready; everything else (a 404/503 from an
//   unrelated app, wrong pid, non-JSON body) is reported as a foreign owner
//   immediately instead of burning the rest of the budget re-polling a port
//   we will never win.
// - The expected pid must be read as a GETTER at response time, not captured
//   when the caller forks: Electron's utilityProcess assigns proc.pid on the
//   async `spawn` event, so a value grabbed right after fork() is still
//   undefined and our own freshly-bound child would fail the identity match
//   and be reaped as a "foreign owner" on its very first health answer.

// A refused local connection costs next to nothing, and this interval is the
// worst-case wait between the port opening and the window starting.
export const BOOT_PROBE_INTERVAL_MS = 100;
/** A running memory upgrade keeps the wait going in steps of this size ... */
export const BOOT_EXTEND_STEP_MS = 5_000;
/** ... but never past this, so a wedged child is still reaped. */
export const BOOT_EXTEND_LIMIT_MS = 30 * 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 *   extendWhile?: () => boolean,
 * }} options
 * @returns {Promise<{ outcome: "ready" | "foreign-owner" | "timeout" | "exited" }>}
*/
export async function pollServerIdentity({
  port,
  pid,
  bootTimeoutMs,
  isExited = () => false,
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
  extendWhile = () => false,
}) {
  const startedAt = now();
  let deadline = startedAt + bootTimeoutMs;
  // The child upgrading the owner's memory cannot answer health checks until
  // it finishes (a copy of a large messages.db can outlast the normal budget).
  // While it says so, the budget moves forward in small steps up to a hard cap.
  // When the upgrade ends past the normal budget, the child still has the rest
  // of its boot ahead of it: give it one fresh budget from that moment, not
  // whatever is left of the last 5 s step.
  let extended = false;
  let rebudgeted = false;
  const expired = () => {
    if (now() < deadline) return false;
    if (now() >= startedAt + BOOT_EXTEND_LIMIT_MS) return true;
    if (extendWhile()) { extended = true; deadline = now() + BOOT_EXTEND_STEP_MS; return false; }
    if (extended && !rebudgeted) { rebudgeted = true; deadline = now() + bootTimeoutMs; return false; }
    return true;
  };
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    if (expired()) return { outcome: "timeout" };
    const remainingMs = Math.max(1, deadline - now());

    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      // Not up yet, or this probe ran into the wall-clock budget — either way
      // back off to the poll interval, then let the loop condition decide.
      await sleep(Math.min(BOOT_PROBE_INTERVAL_MS, Math.max(1, deadline - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    // Body consumption is covered by the same abort signal as fetch. If it
    // reaches the deadline, a null body means the probe timed out—not that a
    // different process answered on the port.
    if (expired()) return { outcome: "timeout" };
    // Read the expected pid NOW, after the response landed: until the child's
    // `spawn` event fires the getter yields undefined, and a child that has
    // not spawned cannot be the one answering — so an answer during that
    // window is genuinely somebody else's.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "murage" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    // A response that finishes after the budget must not count as a healthy
    // boot — re-check the clock before declaring victory.
    if (expired()) return { outcome: "timeout" };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}
