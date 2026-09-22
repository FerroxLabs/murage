// Types for server-child-crash.mjs. Authored as `.mjs` for the same reason
// child-pipe-quiet.mjs is: the proof that this code does not stop the process
// from dying can only come from a REAL spawned node process observing its own
// exit code, and a spawned node cannot import TypeScript. The fixture imports
// this module directly, so the test exercises the shipped code, not a copy.

/** The marker in the emitted line: `event=server-child-failure`. */
export const SERVER_CHILD_FAILURE_EVENT: "server-child-failure";

/**
 * Build the single redacted crash line (newline included). Only the failure
 * origin and an allowlisted built-in error class name are admitted; no
 * message, stack, path or value ever reaches it.
 */
export function formatServerChildFailure(error: unknown, origin: unknown): string;

/** Write one line straight at a file descriptor with `fs.writeSync`, retrying
 * a bounded number of times on EAGAIN and swallowing every other failure. */
export function writeCrashLineSync(line: string, fd?: number): void;

/**
 * Observe this process's fatal faults without changing them.
 *
 * Registers a `uncaughtExceptionMonitor` listener, which Node calls on its way
 * to the normal fatal exit for both `uncaughtException` and
 * `unhandledRejection` origins. It cannot mark the fault handled, so the
 * process still dies with a non-zero code.
 *
 * @returns a disposer, provided for tests; production keeps the observer for
 * the lifetime of the process.
 */
export function installServerChildCrashObserver(options?: {
  processTarget?: NodeJS.Process;
  write?: (line: string) => void;
}): () => void;
