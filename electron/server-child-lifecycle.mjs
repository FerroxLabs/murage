/** The bounded wait for owned work (harness children, quit stages, native
 * helper exits). A deadline reports uncertainty; it never releases ownership. */
export const OWNED_WORK_TIMEOUT_MS = 10_000;

/** What main sends the harness to ask it to close by itself (server/index.ts
 * answers it like SIGTERM). Windows has no signal for this: utilityProcess
 * kill() there is TerminateProcess, so no handler runs and the harness never
 * writes "Stopped: Murage closed while this was running" (G12). */
export const GRACEFUL_CLOSE_MESSAGE = Object.freeze({ type: "murage:close" });
/** The harness's own shutdown gives up after 6 s (server/graceful-shutdown.ts);
 * past this, main stops waiting for it and kills it. */
export const GRACEFUL_CLOSE_TIMEOUT_MS = 7_000;
/** The longest a graceful stop can take: the grace period, then the kill wait.
 * A caller's own deadline for stop() must be at least this. */
export const SERVER_CHILD_STOP_TIMEOUT_MS = GRACEFUL_CLOSE_TIMEOUT_MS + OWNED_WORK_TIMEOUT_MS;

/** Observe an exact owned child from the instant it is forked. A successful
 * kill call is only a request: only exit permits another persistent writer.
 * With gracefulClose, stop() first asks the child to close and waits a
 * bounded time for it to exit, then kills it. */
export function createServerChildLifecycle(child, { timeoutMs = OWNED_WORK_TIMEOUT_MS, gracefulClose = false, graceMs = GRACEFUL_CLOSE_TIMEOUT_MS } = {}) {
  let exited = child.exitCode != null || child.signalCode != null;
  let failed = false;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  if (exited) resolveExit();
  child.once("exit", () => { exited = true; resolveExit(); });
  // UtilityProcess/ChildProcess errors must not become an unhandled event.
  // An error without exit is NOT evidence the child no longer owns data.
  child.on("error", () => { failed = true; });
  let stopping = null;
  let stopRequested = false;
  return {
    /** True once this app asked the child to stop, whatever its exit code.
     * An exit nobody asked for is a crash even when the code is 0. */
    get stopRequested() { return stopRequested; },
    get exited() { return exited; },
    get failed() { return failed; },
    exit,
    stop({ graceful = gracefulClose } = {}) {
      stopRequested = true;
      if (exited) return Promise.resolve();
      if (stopping) return stopping;
      const operation = (async () => {
        if (graceful && await askToClose(child, exit, graceMs)) return;
        try { child.kill(); }
        catch { /* Exit may race kill; otherwise the bounded wait refuses. */ }
        await awaitOwnedWork(exit, "The owned harness has not exited", timeoutMs);
      })();
      stopping = operation;
      void operation.then(() => { stopping = null; }, () => { stopping = null; });
      return operation;
    },
  };
}

/** True once the child exited within graceMs of being asked to close. A
 * child that cannot be asked (no message channel, a closed port) is not
 * waited for. */
async function askToClose(child, exit, graceMs) {
  try { child.postMessage(GRACEFUL_CLOSE_MESSAGE); }
  catch { return false; }
  let timer;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A deadline reports uncertainty, never successful cleanup. Keep the work
 * observed so its late rejection cannot escape after the caller retries. */
export async function awaitOwnedWork(work, label, timeoutMs = OWNED_WORK_TIMEOUT_MS) {
  let timer;
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}; Murage kept installation ownership. Wait and retry Quit.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
