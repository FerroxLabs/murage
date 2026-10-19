// Teardown primitives for suites that spawn a real process against a
// throwaway home directory.
//
// Both halves of that pattern have a race in them, and both races surface
// as a red suite whose assertions all passed — the most expensive kind of
// failure to read. These two helpers exist so the fix lives in one place
// instead of being re-derived (or forgotten) per suite.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { settleTestHandles, settleTestHandlesSync } from "../test-handle-registry.ts";
import { assertSafeToWipe, SafeWipeRefused } from "./safe-wipe.mjs";

/** How `waitForExit` should end the child, and how long to allow. */
export interface WaitForExitOptions {
  /** Sent immediately. Omit for a child the caller has already signalled. */
  signal?: NodeJS.Signals;
  /** How long the polite signal gets before SIGKILL. */
  graceMs?: number;
}

/**
 * End a child process and wait for it to actually be gone.
 *
 * `kill()` asks; it does not wait. A caller that proceeds straight from the
 * kill call to deleting the child's home directory is racing a process that
 * may still be mid-write, and on Linux that surfaces as an EACCES or ENOTEMPTY
 * from `rm` rather than anything that names the real cause.
 *
 * Pass `signal` and this sends it, rather than leaving the caller to send one
 * and then wait out a grace period that has already started counting. Both
 * halves of "stop it, and know that it stopped" then live in one call.
 *
 * From there: resolve on `close`, escalate to SIGKILL only after `graceMs`,
 * and keep waiting for `close` even then — a SIGKILL is not an exit either,
 * it just makes one imminent. The final backstop rejects an unconfirmed stop,
 * so callers cannot proceed to deleting a still-owned fixture directory.
 *
 * A loaded CI runner loses that race; a laptop wins it every time, which is
 * why it reads as a phantom.
 */
export function waitForExit(
  child: ChildProcess | undefined,
  options: WaitForExitOptions | number = {},
): Promise<void> {
  const { signal, graceMs = 5_000 } = typeof options === "number" ? { graceMs: options } : options;

  return new Promise<void>((resolve, reject) => {
    // signalCode, not just exitCode: a process killed by a signal reports its
    // death in the former and leaves the latter null.
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const clear = () => {
      if (timer) clearTimeout(timer);
      child.off("close", done);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clear();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    };
    child.once("close", done);

    if (signal) {
      try {
        child.kill(signal);
      } catch {
        /* already gone — `close` still arrives, or already has */
      }
    }

    if (settled) return;
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        fail(error);
        return;
      }
      if (settled) return;
      timer = setTimeout(() => fail(Object.assign(
        new Error(`Child process ${child.pid ?? "unknown"} did not confirm exit after SIGKILL`),
        { code: "CHILD_EXIT_UNCONFIRMED" },
      )), 2_000);
      timer.unref?.();
    }, graceMs);
    timer.unref?.();
  });
}

/** How a removal retries. The defaults suit a directory a just-closed database or a just-killed child is still letting go of. */
export interface RemoveTempDirOptions {
  /** Total time the retries may take. Default 15 s. */
  budgetMs?: number;
  /** Wait after the first failed attempt; doubles from there. Default 50 ms. */
  firstDelayMs?: number;
  /** The wait never grows past this. Default 1 s. */
  maxDelayMs?: number;
  /** Throw when the directory will not go, instead of warning. The async default is to warn (a leaked temp dir is not a red
   * suite); the sync default is to throw, because its callers reset a directory they are about to reuse. */
  strict?: boolean;
  /** Close every open data handle under `dir` first (async: also wait for the checkpointer threads to exit). Default true. */
  settle?: boolean;
}

/** The delays between attempts: firstDelayMs, doubling, capped at maxDelayMs, until budgetMs is spent. */
export function backoffDelays({ budgetMs = 15_000, firstDelayMs = 50, maxDelayMs = 1_000 }: RemoveTempDirOptions = {}): number[] {
  const delays: number[] = [];
  for (let spent = 0, next = firstDelayMs; spent < budgetMs; next = Math.min(next * 2, maxDelayMs)) {
    const wait = Math.min(next, budgetMs - spent);
    delays.push(wait); spent += wait;
  }
  return delays;
}

/** Seams for cleanup.test.ts only. */
export const cleanupInternals = {
  remove: (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }),
  sleep: (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)),
  sleepSync: (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  warn: (message: string): void => console.warn(message),
};

/**
 * assertSafeToWipe for a test directory. Most are under the OS temp directory; some suites make theirs in the checkout
 * (a scratch folder beside the sources, so a path stays short or on the same volume), which the plain check refuses as "not a
 * temp directory". That one refusal is retried with the working directory as the `within` root; every other rule (a home, a
 * data directory, a live lease, the working directory itself) still applies, and anything outside both is refused as before.
 */
function admit(dir: string): { path: string } {
  try {
    return assertSafeToWipe(dir);
  } catch (error) {
    if (!(error instanceof SafeWipeRefused) || !/not under the OS temp directory/.test(error.message)) throw error;
    return assertSafeToWipe(dir, { within: process.cwd() });
  }
}

const giveUp = (dir: string, lastError: unknown, strict: boolean | undefined, strictDefault: boolean): void => {
  if (lastError instanceof SafeWipeRefused) throw lastError;
  if (strict ?? strictDefault) throw lastError;
  cleanupInternals.warn(`test cleanup could not remove ${dir}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

/**
 * Remove a temp directory, and never fail a green suite over one.
 *
 * Three things keep a database directory from going: a connection the test (or a
 * `vi.resetModules()` copy of the module) left open, the log checkpointer thread that holds the
 * file until it is told to leave, and the filesystem itself (Windows answers EPERM/EBUSY while a
 * scanner or a just-closed handle lingers; Linux answers ENOTEMPTY while the checkpointer's last
 * close is still copying or deleting the -wal). So this first settles every open data handle under
 * the directory (server/test-handle-registry.ts: flush, close, await the checkpointer's exit), then
 * retries with exponential backoff (50 ms doubling to 1 s, 15 s in all). If the directory still will
 * not go, warn and leave it for the OS to reap: a leaked temp dir is a non-event, a red CI run that
 * says nothing about the code under test is not.
 *
 * The one thing that is not a non-event: the path not being a temp directory
 * at all. assertSafeToWipe runs on every attempt and a refusal that outlives
 * the retries is thrown, never warned away — see safe-wipe.mjs and
 * docs/verification/data-safety.md. It runs per attempt rather than once up
 * front because the lease rule reads a just-killed owner as live until the
 * OS reaps it (`process.kill(pid, 0)` answers for a zombie): judging once
 * turned that beat into a one-off SafeWipeRefused on a green suite
 * (FOLLOW7, SAFEWIPE1 verifier). Nothing is deleted while a refusal stands.
 */
export async function removeTempDir(dir: string, options: RemoveTempDirOptions = {}): Promise<void> {
  if (options.settle !== false) await settleTestHandles(dir);
  const delays = backoffDelays(options);
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const { path } = admit(dir);
      cleanupInternals.remove(path);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length) break;
      await cleanupInternals.sleep(delays[attempt]!);
    }
  }
  giveUp(dir, lastError, options.strict, false);
}

/**
 * removeTempDir for a hook that cannot await (a sync `beforeEach` that resets a data directory, a `finally`).
 * Same admission check per attempt and the same backoff, waited out with Atomics.wait (the checkpointer and any
 * other thread keep running while this one waits). It closes the data handles under `dir` and asks their
 * checkpointers to leave, but cannot wait for the exit event, so the backoff does that waiting. Throws when the
 * directory will not go (the removal it replaces threw too), unless `strict: false`.
 */
export function removeTempDirSync(dir: string, options: RemoveTempDirOptions = {}): void {
  if (options.settle !== false) settleTestHandlesSync(dir);
  const delays = backoffDelays(options);
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const { path } = admit(dir);
      cleanupInternals.remove(path);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length) break;
      cleanupInternals.sleepSync(delays[attempt]!);
    }
  }
  giveUp(dir, lastError, options.strict, true);
}

/**
 * A throwaway HOME that is outside the stop line's scratch roots.
 *
 * The stop line treats /tmp and /var/tmp as the bot's own scratch space
 * (server/index.ts, stop-line roots), so on Linux, where tmpdir() is /tmp, a
 * HOME made there puts ~/Documents inside it and "rm -rf ~/Documents/old"
 * raises no card. A person's HOME is never under /tmp. There the home goes in
 * the checkout's ignored .murage-scratch instead; elsewhere (macOS
 * /var/folders, Windows %TEMP%) it stays in the OS temp dir.
 */
export function makeTestHome(prefix: string): string {
  const temp = realpathSync.native(tmpdir());
  const shared = ["/tmp", "/private/tmp", "/var/tmp"].some(root => temp === root || temp.startsWith(`${root}/`));
  const base = shared ? join(fileURLToPath(new URL("../..", import.meta.url)), ".murage-scratch", "homes") : temp;
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}
