// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-inbox mutual lock (design 4.4): no #9 or #10 is dispatched on an inbox while an approve on that inbox is in flight, and an approve
// waits for the dispatches already in flight. Dispatches share the lock; an approve holds it alone, and a waiting approve goes before new
// dispatches so it is never starved.
interface LockState { readers: number; writer: boolean; waitingWriters: number; waiters: Array<() => void> }

export class InboxLocks {
  private readonly states = new Map<string, LockState>();

  private state(inboxId: string): LockState {
    let state = this.states.get(inboxId);
    if (!state) { state = { readers: 0, writer: false, waitingWriters: 0, waiters: [] }; this.states.set(inboxId, state); }
    return state;
  }
  private wake(inboxId: string, state: LockState): void {
    const waiters = state.waiters.splice(0);
    for (const wake of waiters) wake();
    // forgotten only when nobody holds, waits or was just woken (a woken waiter re-checks this same state)
    if (!waiters.length && !state.readers && !state.writer && !state.waitingWriters) this.states.delete(inboxId);
  }
  private async acquire(inboxId: string, exclusive: boolean): Promise<() => void> {
    const state = this.state(inboxId);
    if (exclusive) state.waitingWriters++;
    try {
      while (exclusive ? state.writer || state.readers > 0 : state.writer || state.waitingWriters > 0) await new Promise<void>(resolve => state.waiters.push(resolve));
    } finally { if (exclusive) state.waitingWriters--; }
    if (exclusive) state.writer = true; else state.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) state.writer = false; else state.readers--;
      this.wake(inboxId, state);
    };
  }
  async shared<T>(inboxId: string, fn: () => Promise<T>): Promise<T> { const release = await this.acquire(inboxId, false); try { return await fn(); } finally { release(); } }
  async exclusive<T>(inboxId: string, fn: () => Promise<T>): Promise<T> { const release = await this.acquire(inboxId, true); try { return await fn(); } finally { release(); } }
  /** For tests: whether anything holds or waits on the inbox. */
  busy(inboxId: string): boolean { return this.states.has(inboxId); }
}
