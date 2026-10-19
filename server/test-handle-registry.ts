// Under vitest, the module that owns a data handle (the message database, its log checkpointer, the coalesced writer)
// says so here, and test cleanup closes them all before it removes a directory.
//
// Why a registry: `vi.resetModules()` gives a test a second, fresh copy of message-db.ts / wal-maintenance.ts. The global
// afterEach in server/testing/setup.ts imported the FIRST copy, so it closed a different instance and the test's own
// connection (and its checkpointer thread) stayed open. Windows then refuses to remove the directory (EPERM) and Linux
// sometimes finds the checkpointer's last close still copying or deleting the -wal (ENOTEMPTY), or replays it into the next
// test's fresh file. A registry on globalThis, keyed by Symbol.for, is shared by every copy of the module, so the cleanup
// helper can reach all of them.
//
// Inert outside vitest: nothing registers, and the product behaves exactly as it did.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type TestHandlePhase = "flush" | "close" | "stop";
interface Entry { phase: TestHandlePhase; run: (dir?: string) => void | Promise<unknown>; leaving?: () => string[] }

const KEY = Symbol.for("murage.test.dataHandleRegistry");
const registry = (): Set<Entry> => {
  const g = globalThis as Record<symbol, Set<Entry> | undefined>;
  return (g[KEY] ??= new Set<Entry>());
};

/** Register one module instance's closer. `run` receives the directory about to be removed (undefined: close everything) and
 * should do nothing for a handle that is demonstrably elsewhere. Only registers under vitest. Returns the function that unregisters it (for a test of the registry itself). */
export function registerTestHandle(phase: TestHandlePhase, run: (dir?: string) => void | Promise<unknown>, leaving?: () => string[]): () => void {
  if (!process.env.VITEST) return () => {};
  const entry = { phase, run, leaving };
  registry().add(entry);
  return () => { registry().delete(entry); };
}

const realish = (path: string): string => {
  try { return realpathSync.native(path); } catch { /* not there yet: resolve its parent instead */ }
  try { return resolve(realpathSync.native(dirname(path)), relative(dirname(path), path)); } catch { return resolve(path); }
};
const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** True when `path` is `dir` or lies inside it (compared as written and by real path, so /var vs /private/var and 8.3 names agree). */
export function pathIsWithin(path: string, dir: string | undefined): boolean {
  if (dir === undefined) return true;
  return inside(resolve(path), resolve(dir)) || inside(realish(path), realish(dir));
}

const ordered = (): Entry[] => {
  const all = [...registry()];
  return (["flush", "close", "stop"] as const).flatMap(phase => all.filter(e => e.phase === phase));
};

/** Flush deferred writes, close every registered connection and wait for every checkpointer thread to exit. Never throws. */
export async function settleTestHandles(dir?: string): Promise<void> {
  const entries = ordered();
  for (const phase of ["flush", "close"] as const) {
    for (const e of entries) if (e.phase === phase) { try { await e.run(dir); } catch { /* a handle already gone */ } }
  }
  await Promise.all(entries.filter(e => e.phase === "stop").map(async e => { try { await e.run(dir); } catch { /* already gone */ } }));
}

/** Seam for tests: how the synchronous settle sleeps. */
export const settleInternals = { sleepSync: (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } };

/** The part of settleTestHandles a synchronous hook can do: flush, close, ask each checkpointer to leave, then wait (up to
 * `waitMs`) for the files it removes on the way out to be gone. The thread closes its connection on its own thread, so
 * blocking this one does not hold it up; only its `exit` event needs the event loop, and the files are the proof used instead. */
export function settleTestHandlesSync(dir?: string, waitMs = 3_000): void {
  const entries = ordered();
  for (const e of entries) {
    try {
      const out = e.run(dir);
      if (out && typeof (out as Promise<unknown>).catch === "function") void (out as Promise<unknown>).catch(() => {});
    } catch { /* a handle already gone */ }
  }
  const owed = () => entries.flatMap(e => e.phase === "stop" ? (e.leaving?.() ?? []) : []).filter(file => pathIsWithin(file, dir) && existsSync(file));
  for (let waited = 0, step = 5; waited < waitMs && owed().length; waited += step, step = Math.min(step * 2, 100)) settleInternals.sleepSync(step);
}
