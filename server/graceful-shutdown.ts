import { writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/** The server's own shutdown allowance (U24 design R7): every provider's immediate stop wait (child-teardown.ts
 * PROVIDER_DISPOSE_BUDGET_MS) answers inside it, and the desktop's graceful close (electron/server-child-lifecycle.mjs
 * GRACEFUL_CLOSE_TIMEOUT_MS) waits longer than it. */
export const SERVER_SHUTDOWN_TIMEOUT_MS = 6_000;

export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** Build one idempotent shutdown callback for process signals. Cleanup jobs
 * run together, but a wedged provider cannot keep the desktop child alive
 * forever. The browser capability clear is one of these jobs, so a normal
 * server stop does not leave a turn bearer usable until its absolute TTL. */
export function createGracefulShutdown({
  cleanup,
  exit,
  timeoutMs = SERVER_SHUTDOWN_TIMEOUT_MS,
}: GracefulShutdownOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(cleanup.map((job) => Promise.resolve().then(job)))
      .then(() => undefined);

    void Promise.race([settled, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      exit(0);
    });
  };
}

/** The desktop's "close by yourself" request (electron/server-child-lifecycle.mjs
 * GRACEFUL_CLOSE_MESSAGE), answered like SIGTERM. Windows has no signal the
 * harness can catch: without this, quitting Murage there hard-terminates the
 * harness and a waiting run never says Murage closed (G12). */
export const APP_CLOSE_REQUEST_TYPE = "murage:close";

export function isAppCloseRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === APP_CLOSE_REQUEST_TYPE;
}

/** The desktop's "write what you are holding now" request (electron/session-end.mjs FLUSH_REQUEST_MESSAGE): the OS is ending the session
 * (Windows logoff, restart or shutdown) and may end this process with no signal and no time for a graceful close. The deferred roster and
 * channel writes (atomic.ts scheduleCoalesced, up to COALESCE_WINDOW_MS old) reach disk at once; nothing else stops. The answer is
 * APP_FLUSHED_TYPE. */
export const APP_FLUSH_REQUEST_TYPE = "murage:flush";
export const APP_FLUSHED_TYPE = "murage:flushed";

export function isAppFlushRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === APP_FLUSH_REQUEST_TYPE;
}

/** The answer file a flush request names (electron/session-end.mjs flushAckName): an absolute path whose name is exactly the desktop's
 * pattern, or null. The desktop waits, synchronously and bounded, for this file before it lets the OS end the session. */
export function flushAckPath(message: unknown): string | null {
  const ack = (message as { ack?: unknown } | null)?.ack;
  if (typeof ack !== "string" || !isAbsolute(ack)) return null;
  return /^murage-flush-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/.test(basename(ack)) ? ack : null;
}

/** Create the answer file (never overwrite one: "wx"). A failure only means the desktop stops waiting at its bound. */
export function writeFlushAck(ack: string, ok: boolean): void {
  try { writeFileSync(ack, ok ? "1" : "0", { flag: "wx", mode: 0o600 }); } catch { /* the desktop stops waiting at its bound */ }
}
