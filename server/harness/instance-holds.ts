// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Holds Murage's own sessions on an engine while a deleted conversation is removed from that engine's files. A hold does three
// things, in this order: new turns on the held instances WAIT (they are not refused; they start when the hold is released);
// turns already running are left alone and given up to `waitMs` to finish; and the idle processes the adapters keep warm are
// closed (`holdIdle`). An instance whose running turn did not finish in time is released again at once and reported busy:
// Murage never interrupts the owner's turn to delete something else. An instance whose idle engines could not be CONFIRMED gone
// is treated the same way: released and reported busy, so its files are left alone this attempt.
//
// Admission and the running count are one synchronous step (`admit`): a hold taken at any moment either sees the turn running
// (and waits for it) or finds the turn still waiting at the gate; there is no moment where a turn is past the gate but not counted.
import type { IdleHold, ProviderAdapter, ProviderInstance } from "../contracts.ts";

export const WAITING_NOTE = "Waiting while Murage finishes deleting a conversation.";

export interface HoldResult {
  /** instance ids whose running turns did not finish in time: they are not held */
  busy: string[];
  release: () => void;
  /** True once a turn has waited this hold's `waitMs` at the gate of one of its instances: the holder is asked to stop at its next safe
   * point and release, so the owner's turn never waits for a whole removal (DELETE-HOLDS-ENGINE). */
  yieldAsked: () => boolean;
  /** Resolves the first time `yieldAsked` turns true; never for a hold no turn waits on. Lets a holder's sleep end early. */
  yielded: Promise<void>;
}

/** One hold on one instance, as the waiting turns see it: asked when a turn has waited `waitMs` from the later of `from` and its start. */
interface HoldHandle { waitMs: number; from: number; asked: boolean; ask: () => void }

export class InstanceHolds {
  private readonly held = new Map<string, number>();
  private readonly gates = new Map<string, Array<() => void>>();
  private readonly running = new Map<string, Map<string, number>>();
  private readonly idleWaiters = new Map<string, Array<() => void>>();
  private readonly probes = new Map<string, (threadId: string) => boolean>();
  /** When each instance last saw a turn end. */
  private readonly endedAt = new Map<string, number>();
  private readonly freeWaiters = new Set<{ ids: string[]; since: number; wake: () => void }>();
  /** The holds (from `hold`, never `holdNow`) on each instance, each asked to yield at its own budget. */
  private readonly handles = new Map<string, Set<HoldHandle>>();
  /** The turns waiting at each instance's gate, kept from their first wait until the gate is really down. */
  private readonly waiting = new Map<string, Set<{ since: number }>>();
  /** One timer per instance, for the soonest handle due (`rearm`). */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Called once for each turn that has to wait, with the thread it was for. */
  onWait?: (instanceId: string, threadId: string) => void;

  isHeld(instanceId: string): boolean { return (this.held.get(instanceId) ?? 0) > 0; }
  /** How many turns are running on the instance. A thread the adapter no longer has a session for (a turn that ended without
   * saying so) is forgotten here. */
  runningTurns(instanceId: string): number {
    const set = this.running.get(instanceId);
    if (!set) return 0;
    const probe = this.probes.get(instanceId);
    // a turn that is still being dispatched has no session yet: only an entry older than this is judged by the adapter
    if (probe) for (const [threadId, since] of [...set]) { let alive = true; try { alive = probe(threadId); } catch { alive = true; } if (!alive && Date.now() - since > 30_000) set.delete(threadId); }
    return set.size;
  }
  watch(instanceId: string, alive: (threadId: string) => boolean): void { this.probes.set(instanceId, alive); }

  noteStarted(instanceId: string, threadId: string): void {
    let set = this.running.get(instanceId);
    if (!set) { set = new Map(); this.running.set(instanceId, set); }
    if (!set.has(threadId)) set.set(threadId, Date.now());
  }
  noteEnded(instanceId: string, threadId: string): void {
    const set = this.running.get(instanceId);
    if (!set?.delete(threadId)) return;
    this.endedAt.set(instanceId, Date.now());
    if (set.size === 0) {
      for (const wake of this.idleWaiters.get(instanceId)?.splice(0) ?? []) wake();
      for (const waiter of [...this.freeWaiters]) this.checkFree(waiter);
    }
  }

  /** Calls `wake` once, the first moment none of these instances has a running turn AND at least one of them saw a turn end at or
   * after `since`. A deletion skipped because Murage's own turn was running uses it to try again as soon as that turn ends (a Stop
   * ends it too). An instance that saw no turn end never wakes it: an instance reported busy only because its idle engines could not
   * be confirmed closed is left to the deletion's own schedule. Returns how to stop waiting. */
  whenFree(instanceIds: readonly string[], since: number, wake: () => void): () => void {
    const waiter = { ids: [...new Set(instanceIds)], since, wake };
    if (!waiter.ids.length) return () => {};
    this.freeWaiters.add(waiter);
    // the turn may have ended between the hold and this registration
    this.checkFree(waiter);
    return () => { this.freeWaiters.delete(waiter); };
  }

  private checkFree(waiter: { ids: string[]; since: number; wake: () => void }): void {
    if (!this.freeWaiters.has(waiter)) return;
    if (!waiter.ids.some((id) => (this.endedAt.get(id) ?? -Infinity) >= waiter.since)) return;
    if (waiter.ids.some((id) => (this.running.get(id)?.size ?? 0) > 0)) return;
    this.freeWaiters.delete(waiter);
    try { waiter.wake(); } catch { /* a waiter never breaks the turn that ended */ }
  }

  /** Resolves at once when the instance is not held, otherwise when its hold is released. */
  async gate(instanceId: string, threadId: string): Promise<void> {
    if (!this.isHeld(instanceId)) return;
    this.onWait?.(instanceId, threadId);
    await new Promise<void>((resolve) => {
      const list = this.gates.get(instanceId) ?? [];
      list.push(resolve);
      this.gates.set(instanceId, list);
    });
  }

  /** A turn's admission: waits while the instance is held, and registers the turn as running in the same synchronous step as the
   * check that found no hold. After this resolves the turn is counted, so a hold installed at any later moment waits for it. */
  async admit(instanceId: string, threadId: string): Promise<void> {
    let waiter: { since: number } | undefined;
    try {
      while (this.isHeld(instanceId)) {
        if (!waiter) {
          waiter = { since: Date.now() };
          const set = this.waiting.get(instanceId) ?? new Set();
          set.add(waiter);
          this.waiting.set(instanceId, set);
          this.onWait?.(instanceId, threadId);
          this.rearm(instanceId);
        }
        await new Promise<void>((resolve) => {
          const list = this.gates.get(instanceId) ?? [];
          list.push(resolve);
          this.gates.set(instanceId, list);
        });
      }
    } finally {
      if (waiter) {
        const set = this.waiting.get(instanceId);
        set?.delete(waiter);
        if (set && !set.size) this.waiting.delete(instanceId);
        this.rearm(instanceId);
      }
    }
    this.noteStarted(instanceId, threadId);
  }

  /** Arms the instance's one timer for the soonest unasked handle due while a turn waits at its gate: a handle is due `waitMs` after the
   * later of its own start and the oldest waiting turn's. On fire every due handle of the LIVE set is asked, then the timer is armed
   * again for the rest. No waiter, no unasked handle or the gate down: no timer. */
  private rearm(instanceId: string): void {
    const armed = this.timers.get(instanceId);
    if (armed) { clearTimeout(armed); this.timers.delete(instanceId); }
    const oldest = this.oldestWaiter(instanceId);
    const handles = this.handles.get(instanceId);
    if (oldest === undefined || !handles?.size || !this.isHeld(instanceId)) return;
    let due = Infinity;
    for (const handle of handles) if (!handle.asked) due = Math.min(due, Math.max(handle.from, oldest) + handle.waitMs);
    if (due === Infinity) return;
    const timer = setTimeout(() => {
      this.timers.delete(instanceId);
      const since = this.oldestWaiter(instanceId);
      if (since !== undefined) {
        const now = Date.now();
        for (const handle of [...(this.handles.get(instanceId) ?? [])]) {
          if (handle.asked || Math.max(handle.from, since) + handle.waitMs > now) continue;
          handle.asked = true;
          try { handle.ask(); } catch { /* an ask never breaks the waiting turn */ }
        }
      }
      this.rearm(instanceId);
    }, Math.max(0, due - Date.now()));
    timer.unref();
    this.timers.set(instanceId, timer);
  }

  private oldestWaiter(instanceId: string): number | undefined {
    const set = this.waiting.get(instanceId);
    if (!set?.size) return undefined;
    let oldest = Infinity;
    for (const waiter of set) oldest = Math.min(oldest, waiter.since);
    return oldest;
  }

  private addHandle(instanceId: string, handle: HoldHandle): void {
    const set = this.handles.get(instanceId) ?? new Set();
    set.add(handle);
    this.handles.set(instanceId, set);
    this.rearm(instanceId);
  }

  private dropHandle(instanceId: string, handle: HoldHandle | undefined): void {
    if (!handle) return;
    const set = this.handles.get(instanceId);
    set?.delete(handle);
    if (set && !set.size) this.handles.delete(instanceId);
    this.rearm(instanceId);
  }

  private unhold(instanceId: string): void {
    const left = (this.held.get(instanceId) ?? 1) - 1;
    if (left > 0) { this.held.set(instanceId, left); return; }
    this.held.delete(instanceId);
    for (const wake of this.gates.get(instanceId)?.splice(0) ?? []) wake();
  }

  private idle(instanceId: string, deadline: number): Promise<boolean> {
    if (this.runningTurns(instanceId) === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = this.idleWaiters.get(instanceId) ?? [];
      this.idleWaiters.set(instanceId, waiters);
      const wake = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        const at = waiters.indexOf(wake);
        if (at >= 0) waiters.splice(at, 1);
        resolve(this.runningTurns(instanceId) === 0);
      }, Math.max(0, deadline - Date.now()));
      timer.unref();
      waiters.push(wake);
    });
  }

  /** Holds these instances at once, in one synchronous step, and returns how to let them go (once, however often it is called).
   * For the moment before the port opens: nothing is running yet, so there is nothing to wait for and no idle process to close. */
  holdNow(instanceIds: readonly string[]): () => void {
    const ids = [...new Set(instanceIds)];
    for (const id of ids) this.held.set(id, (this.held.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) this.unhold(id);
    };
  }

  /** Holds these instances. `idleOf` closes the idle processes of one instance and returns how to let them start again and
   * whether they are all confirmed gone; an adapter that fails to say so, or throws, leaves its instance reported busy. */
  async hold(instanceIds: readonly string[], waitMs: number, idleOf: (instanceId: string) => Promise<IdleHold | undefined>): Promise<HoldResult> {
    const ids = [...new Set(instanceIds)];
    let asked = false;
    let markYielded!: () => void;
    const yielded = new Promise<void>((resolve) => { markYielded = resolve; });
    const ask = () => { if (asked) return; asked = true; markYielded(); };
    const mine = new Map<string, HoldHandle>();
    const now = Date.now();
    for (const id of ids) {
      this.held.set(id, (this.held.get(id) ?? 0) + 1);
      const handle: HoldHandle = { waitMs, from: now, asked: false, ask };
      mine.set(id, handle);
      this.addHandle(id, handle);
    }
    const deadline = Date.now() + waitMs;
    const ok = await Promise.all(ids.map((id) => this.idle(id, deadline)));
    const busy = ids.filter((_, index) => !ok[index]);
    for (const id of busy) { this.unhold(id); this.dropHandle(id, mine.get(id)); }
    const kept: string[] = [];
    const releases: Array<() => void> = [];
    for (const id of ids.filter((_, index) => ok[index])) {
      let idle: IdleHold | undefined;
      let confirmed = true;
      try { idle = await idleOf(id); if (idle && !idle.confirmed) confirmed = false; } catch { confirmed = false; }
      if (confirmed) { kept.push(id); if (idle) releases.push(idle.release); continue; }
      // Not confirmed idle: let the adapter start engines again, lift the hold, and report the instance busy.
      try { idle?.release(); } catch { /* already free */ }
      this.unhold(id);
      this.dropHandle(id, mine.get(id));
      busy.push(id);
    }
    let released = false;
    return {
      busy,
      release: () => {
        if (released) return;
        released = true;
        for (const back of releases) { try { back(); } catch { /* already free */ } }
        for (const id of kept) { this.unhold(id); this.dropHandle(id, mine.get(id)); }
      },
      yieldAsked: () => asked,
      yielded,
    };
  }
}

/** The instance as the registry hands it out: its adapter's sendTurn waits while the instance is held, and the adapter's turns
 * are counted so a hold can wait for the running ones. Everything else passes through. */
export function decorateHoldInstance(live: ProviderInstance, holds: InstanceHolds): ProviderInstance {
  const original = live.adapter;
  const id = live.instanceId;
  holds.watch(id, (threadId) => original.hasSession(threadId));
  const unsubscribe = original.onEvent((event) => {
    if (event.type === "turn.started") holds.noteStarted(id, event.threadId);
    else if (event.type === "turn.completed" || event.type === "session.exited") holds.noteEnded(id, event.threadId);
  });
  const sendTurn: ProviderAdapter["sendTurn"] = async (input) => {
    await holds.admit(id, input.threadId);
    try { return await original.sendTurn(input); } catch (error) { holds.noteEnded(id, input.threadId); throw error; }
  };
  const adapter = new Proxy(original, {
    get(target, property) {
      if (property === "sendTurn") return sendTurn;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
  return new Proxy(live, {
    get(target, property) {
      if (property === "adapter") return adapter;
      if (property === "dispose") return async () => { unsubscribe(); await target.dispose(); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
