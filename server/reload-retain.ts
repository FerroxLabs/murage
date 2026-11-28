// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OPENAI-TOOLS-109 rev 5, H2: a fleet reload disposes every engine, and a dispose that could not confirm its children closed
// (ProviderStopUnconfirmedError) used to be swallowed while the reload released the project-write leases, the direct run and the
// local VM of every retired turn. A child that ignored the kill could still be writing with its mount token. Now the reload asks
// each unconfirmed instance's adapter which threads still have a child open, and keeps those threads' leases until the adapter's
// awaitTurnClose confirms the close, never by a timer (direct-late-close.ts, the same rule as a Stop).
import type { ProviderInstance } from "./contracts.ts";

type Watcher = Pick<ProviderInstance, "adapter">;

/** Resolves true when `close` is still open after one macrotask: a close of nothing tracked resolves at once. A rejection counts as
 * still open (nothing confirmed the close). */
async function stillOpen(close: Promise<void>): Promise<boolean> {
  let closed = false;
  close.then(() => { closed = true; }, () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return !closed;
}

/** For each of `threadIds` with a child still open on one of the `unconfirmed` instances' adapters, the promise of that child's (and
 * every such child's) confirmed close. Threads with nothing open, and adapters without awaitTurnClose (whose stop the harness cannot
 * observe; they keep the old release, as a Stop on them does), are absent. */
export async function unconfirmedCloses(threadIds: Iterable<string>, unconfirmed: readonly Watcher[] | undefined): Promise<Map<string, Promise<void>>> {
  const closes = new Map<string, Promise<void>>();
  const watching = (unconfirmed ?? []).flatMap((instance) => instance.adapter.awaitTurnClose ? [instance.adapter] : []);
  if (!watching.length) return closes;
  for (const threadId of new Set(threadIds)) {
    const close = Promise.all(watching.map((adapter) => adapter.awaitTurnClose!(threadId))).then(() => undefined);
    close.catch(() => undefined);
    if (await stillOpen(close)) closes.set(threadId, close);
  }
  return closes;
}

/** The closes reloads are still waiting on, kept across reloads (Astra code-r1 H2). A reload disposes only the fleet it replaces, so a
 * thread an earlier reload retained has no child on the new fleet: without this record the next reload would release its leases, its
 * direct run and its VM while the earlier child still runs. An entry leaves only on that child's confirmed close; a close that rejects
 * confirmed nothing and stays held. */
export class RetainedCloses {
  private readonly pending = new Map<string, Promise<void>>();

  /** Every thread a reload retained whose child has not confirmed its close yet. */
  snapshot(): Map<string, Promise<void>> {
    return new Map(this.pending);
  }

  note(threadId: string, close: Promise<void>): Promise<void> {
    const earlier = this.pending.get(threadId);
    const merged = earlier ? Promise.all([earlier, close]).then(() => undefined) : close;
    merged.catch(() => undefined);
    this.pending.set(threadId, merged);
    void merged.then(() => { if (this.pending.get(threadId) === merged) this.pending.delete(threadId); }, () => undefined);
    return merged;
  }
}

/** E15-V3: one turn a reload ended, on one engine instance. */
export interface EndedTurn { readonly threadId: string; readonly turnId: string; readonly instanceId: string }

/** E15-V3: which of the turns a reload ended still have their OWN engine child open. Decided per turn by that turn's own instance and
 * only against THIS reload's `unconfirmed` instances, never by `reloadRetained` (a thread an earlier reload kept, or another member's
 * engine on the same thread, says nothing about this turn). A turn whose instance is not unconfirmed, whose adapter cannot observe a
 * close, or whose adapter says it holds no child of the exact turn (`knowsTurnClose` / `turnChildTracked` false) is closed now. The
 * adapter is asked with the turn id: Claude answers a call without one with a promise that never settles. Only turns still open
 * carry a `close`. The caller never lets this throw into the reload (a throw means "closed now" for every turn). */
export async function turnCloses(turns: readonly EndedTurn[], unconfirmed: readonly (Watcher & { instanceId: string })[] | undefined): Promise<Array<{ turn: EndedTurn; close?: Promise<void> }>> {
  const byInstance = new Map((unconfirmed ?? []).map((instance) => [instance.instanceId, instance.adapter] as const));
  return Promise.all(turns.map(async (turn) => {
    const adapter = byInstance.get(turn.instanceId);
    if (!adapter?.awaitTurnClose) return { turn };
    const known = adapter.knowsTurnClose ? adapter.knowsTurnClose(turn.threadId, turn.turnId) : adapter.turnChildTracked?.(turn.threadId, turn.turnId);
    if (known === false) return { turn };
    const close = adapter.awaitTurnClose(turn.threadId, turn.turnId);
    close.catch(() => undefined);
    return await stillOpen(close) ? { turn, close } : { turn };
  }));
}
