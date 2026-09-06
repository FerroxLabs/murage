/** Observe an exact owned child from the instant it is forked. A successful
 * kill call is only a request: only exit permits another persistent writer. */
export function createServerChildLifecycle(child, { timeoutMs = 10_000 } = {}) {
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
  return {
    get exited() { return exited; },
    get failed() { return failed; },
    exit,
    stop() {
      if (exited) return Promise.resolve();
      if (stopping) return stopping;
      const operation = (async () => {
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

/** A deadline reports uncertainty, never successful cleanup. Keep the work
 * observed so its late rejection cannot escape after the caller retries. */
export async function awaitOwnedWork(work, label, timeoutMs = 10_000) {
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
