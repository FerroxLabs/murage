/** Wait for a multi-turn run to finish, giving it more time while it keeps moving.
 *
 * A fixed poll timeout sized for an idle runner flakes on a loaded one: a team at
 * turn 3 of 13 is healthy, just slow, and a 10 s wait called it a failure. Here
 * the wait ends early only when the progress mark (a turn count) stands still for
 * `idleMs`, and never runs past `maxMs` in all. */
export async function pollWhileProgressing<T>(
  read: () => Promise<T> | T,
  options: {
    done: (value: T) => boolean;
    progress: (value: T) => unknown;
    idleMs: number;
    maxMs: number;
    intervalMs?: number;
    now?: () => number;
  },
): Promise<T> {
  const now = options.now ?? Date.now;
  const start = now();
  let lastMove = start;
  let mark: unknown;
  let seen = false;
  for (;;) {
    const value = await read();
    if (options.done(value)) return value;
    const at = now();
    const next = options.progress(value);
    if (!seen || !Object.is(next, mark)) {
      seen = true;
      mark = next;
      lastMove = at;
    }
    if (at - lastMove >= options.idleMs || at - start >= options.maxMs) {
      let shown: string;
      try { shown = (JSON.stringify(value) ?? String(value)).slice(0, 2000); } catch { shown = String(value); }
      throw new Error(`run did not finish: no progress for ${at - lastMove} ms, ${at - start} ms in all; last value ${shown}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}
