// Commit/rollback hooks for nested SQLite transactions.
//
// Code that mutates an in-memory cache or announces a change while a database
// transaction is open must not let that effect outlive a rollback. Every
// transaction layer (database.ts `transaction`, send-store.ts `atomically`)
// opens and closes a frame here; effects registered while a frame is open run
// only after the OUTERMOST frame commits, and cache-invalidation hooks run when
// any enclosing frame rolls back. Outside a frame, effects run immediately.

interface Frame { commit: Array<() => void>; rollback: Array<() => void> }
const frames: Frame[] = [];

export function txScopeBegin(): void { frames.push({ commit: [], rollback: [] }); }

export function txScopeEnd(committed: boolean): void {
  const frame = frames.pop();
  if (!frame) return;
  if (!committed) {
    for (const fn of frame.rollback.reverse()) { try { fn(); } catch { /* a hook never masks the rollback */ } }
    return;
  }
  const parent = frames.at(-1);
  if (parent) { parent.commit.push(...frame.commit); parent.rollback.push(...frame.rollback); return; }
  for (const fn of frame.commit) { try { fn(); } catch (error) { console.error("post-commit hook failed", error); } }
}

export function inTxScope(): boolean { return frames.length > 0; }

/** Run `fn` once the outermost open transaction commits (now, when none is open). */
export function afterCommit(fn: () => void): void {
  const top = frames.at(-1);
  if (top) top.commit.push(fn); else fn();
}

/** Run `fn` if the transaction layer enclosing this call rolls back. */
export function onRollback(fn: () => void): void {
  frames.at(-1)?.rollback.push(fn);
}

/**
 * Run a raw SQLite transaction or savepoint (`BEGIN`/`SAVEPOINT` ... `COMMIT`/`RELEASE`/`ROLLBACK`)
 * inside a tx-scope frame. `work` must contain the whole transaction INCLUDING its COMMIT or
 * RELEASE, so effects registered while it runs (store emits, send-chip refreshes) fire only after
 * the outermost frame commits. A throw, or a result for which `rolledBack(result)` is true (the
 * owner rolled its own savepoint back and returned a refusal), drops them instead.
 */
export function scopedTx<T>(work: () => T, rolledBack?: (result: T) => boolean): T {
  txScopeBegin();
  let result: T;
  try { result = work(); }
  catch (error) { txScopeEnd(false); throw error; }
  let undone = false;
  try { undone = rolledBack?.(result) === true; } catch { undone = false; }
  txScopeEnd(!undone);
  return result;
}
