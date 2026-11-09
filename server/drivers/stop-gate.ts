// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STOP-NONACP-DISPOSE (design r3 + r3.1): ONE stop gate and ONE ending rule for every non-ACP engine.
//
// - An asked Stop (interruptTurn, resetSession, stopAll) ends a turn as the stopped pair; a dispose nobody asked for ends it as the
//   engine closing. An asked Stop that reached the turn before its turn.completed wins over a dispose, in either order, and both win
//   over any verdict (version, model, scope, refusal) that an await returns after the mark. The precedence lives in exactly one place:
//   `GateEntry.finish`, read AT EMISSION, never from a captured reason.
// - Engines end a turn only through `e.finish` and start one only through `e.markStarted` (rule R2, checked by
//   stop-gate.rules.test.ts). Every await on the turn path is `gate.step` (rule R1) and every irreversible call (spawn, prompt write,
//   POST) runs in a `gate.launch` callback (rule R3).
// - Dispose is: `gate.close(); live stops; open = await gate.drain(ms); gate.settleOutstanding(open); <existing reap>;` and
//   `listeners.clear()` only after the engine's existing reap confirmed the child stop. The drain bound is providerCloseDeadlineMs()
//   (5 s); the Windows job stop can take ~8 s, which is why listeners.clear() stays after the reap and the bound never moves.
import { engineClosedLine } from "./stop-copy.ts";

export type StopWhy = "asked" | "closing";

/** What a turn ended with, as the engine knows it. `final`: emitted as is under any mark (a gate incident, a refusal, a shutdown timeout). */
export type Verdict = {
  ok: boolean;
  stopReason: string | null;
  /** A terminal error: a string becomes the runtime.error message, an object is spread into the runtime.error event. */
  error?: string | Record<string, unknown>;
  /** Extra fields spread into turn.completed (cost, usage, ...). Kept under an asked or closing mark too: usage and cost are money data (MurageMain 11-08). */
  extra?: Record<string, unknown>;
  /** The line a closing ending shows (exit code, last words) when the engine knows more than the plain line. */
  closedLine?: string;
  final?: true;
};

export class GateStopped extends Error {
  // a plain field, not a parameter property: the real server loads this file with node type-stripping, which rejects parameter properties
  readonly why: StopWhy | null;
  constructor(why: StopWhy | null) {
    super(why === "asked" ? "stopped before launch" : why === "closing" ? "closing before launch" : "turn already ended");
    this.why = why;
    this.name = "GateStopped";
  }
}

export interface GateEntry {
  readonly threadId: string;
  /** Set by the engine as soon as it mints the turn id (before any ending). */
  turnId: string | undefined;
  readonly signal: AbortSignal;
  /** An asked Stop reached this turn. */
  asked: boolean;
  /** The irreversible call ran (child spawned, prompt written, POST answered): a stop must now reach the live handle. */
  live: boolean;
  /** The turn's turn.completed was emitted (or the entry was settled). */
  done: boolean;
  /** Startup continues after sendTurn returned (`gate.handoff`). */
  detached: boolean;
  started: boolean;
  /** Installed by the engine once a live handle exists; a mark reaching a live entry calls it. */
  stopLive?: (why: StopWhy) => void;
  /** Installed by the engine while a terminal is already on its way (muse endUnconfirmed / active.stopping, codex settle): startup is not abandoned. */
  terminalPending?: () => boolean;
  /** Installed by the engine: the usage (and cost) it already reported on this turn. A SYNCHRONOUS getter, no await, no side effects: the gate's
   *  settleOutstanding after a drain timeout carries it as extra, so tokens already spent are not dropped (MurageMain ruling U, 11-08). */
  kept?: () => Record<string, unknown> | undefined;
  markStarted(payload?: Record<string, unknown>): void;
  finish(v: Verdict): void;
}

export type GateEnv = {
  /** Display name in the closing line ("Claude", "Codex", "the Cloud computer"). */
  engineName: string;
  emit: (event: Record<string, unknown>) => void;
  base: (threadId: string, turnId: string) => Record<string, unknown>;
  /** Antigravity keeps its ruled pre-prompt shape: one turn.completed and no turn.started. Default true. "mark-only": turn.started comes from
   *  markStarted() alone (a live turn announces itself), and a pre-prompt ending emits none (MurageMain ruling 11-08). */
  announceStart?: boolean | "mark-only";
};

export type Classify = (error: unknown) => Verdict | null;

export function createStopGate(env: GateEnv) {
  const entries = new Set<InternalEntry>();
  const waiters = new Set<() => void>();
  let closed = false;

  type InternalEntry = GateEntry & { controller: AbortController };

  const notifyIfEmpty = () => {
    if (entries.size > 0) return;
    for (const w of [...waiters]) w();
  };

  const why = (e: GateEntry): StopWhy | null => (e.asked ? "asked" : closed ? "closing" : null);

  const leave = (e: GateEntry): void => {
    if (!entries.delete(e as InternalEntry)) return;
    notifyIfEmpty();
  };

  const enter = (threadId: string, o?: { turnId?: string; announceStart?: boolean | "mark-only" }): GateEntry => {
    const controller = new AbortController();
    const announce = o?.announceStart ?? env.announceStart ?? true;
    const e: InternalEntry = {
      threadId,
      turnId: o?.turnId,
      signal: controller.signal,
      controller,
      asked: false,
      live: false,
      done: false,
      detached: false,
      started: false,
      markStarted(payload) {
        if (e.started || e.done) return;
        e.started = true;
        if (!announce) return;
        env.emit({ ...env.base(threadId, e.turnId ?? ""), ...payload, type: "turn.started" });
      },
      finish(v) {
        if (e.done) return;
        e.done = true;
        const turnId = e.turnId ?? "";
        const w = v.final ? null : why(e);
        try {
          if (!e.started && announce === true) {
            e.started = true;
            env.emit({ ...env.base(threadId, turnId), type: "turn.started" });
          }
          e.started = true;
          if (w === "asked") {
            env.emit({ ...v.extra, ...env.base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: v.extra?.cost ?? null });
          } else if (w === "closing") {
            env.emit({ ...env.base(threadId, turnId), type: "runtime.error", message: v.closedLine ?? engineClosedLine(env.engineName, null) });
            env.emit({ ...v.extra, ...env.base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "exit_before_result", cost: v.extra?.cost ?? null });
          } else {
            if (v.error !== undefined) {
              const detail = typeof v.error === "string" ? { message: v.error } : v.error;
              env.emit({ ...env.base(threadId, turnId), type: "runtime.error", ...detail });
            }
            env.emit({ ...env.base(threadId, turnId), type: "turn.completed", ok: v.ok, stopReason: v.stopReason, cost: null, ...v.extra });
          }
        } finally {
          leave(e);
        }
      },
    };
    entries.add(e);
    return e;
  };

  const mark = (e: InternalEntry) => {
    const w = why(e);
    if (e.controller.signal.aborted) return;
    e.controller.abort();
    if (e.live && w) e.stopLive?.(w);
  };

  /** interruptTurn(id), resetSession(id), stopAll(): marks the entries asked and aborts their signals. Touches the gate first, before any await. */
  const ask = (threadId?: string): void => {
    for (const e of [...entries]) {
      if (threadId !== undefined && e.threadId !== threadId) continue;
      e.asked = true;
      mark(e);
    }
  };

  /** dispose, synchronously first: closing for every entry now and every turn that enters later. */
  const close = (): void => {
    closed = true;
    for (const e of [...entries]) mark(e);
  };

  /** Waits until every entry left, bounded; resolves with the entries still open at the bound (empty: fully drained). */
  const drain = (ms: number): Promise<GateEntry[]> => {
    if (entries.size === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        waiters.delete(check);
        resolve([...entries]);
      };
      const check = () => { if (entries.size === 0) done(); };
      waiters.add(check);
      timer = setTimeout(done, Math.max(0, ms));
      timer.unref?.();
    });
  };

  /** After a bounded drain timed out: every outstanding entry ends exactly once (closing, since the gate is closed) before listeners clear. */
  const settleOutstanding = (open: GateEntry[]): void => {
    for (const e of open) {
      if (e.done) continue;
      const extra = e.kept?.();
      e.finish({ ok: false, stopReason: "exit_before_result", ...(extra ? { extra } : {}) });
    }
  };

  /** Awaits p fully, then reads the gate. A mark (or an already settled entry) reaps via onStopped, reaches a live handle, and throws GateStopped. */
  const step = async <T>(e: GateEntry, p: Promise<T>, o?: { onStopped?(v: T): void }): Promise<T> => {
    const v = await p;
    const w = why(e);
    if (w || e.done) {
      o?.onStopped?.(v);
      if (e.live && !e.done) e.stopLive?.(w ?? "closing");
      throw new GateStopped(w);
    }
    return v;
  };

  /** Awaits p for a stop or close continuation: never throws on a mark, never reaches a live handle, never reads `done`. */
  const cleanupStep = async <T>(_e: GateEntry, p: Promise<T>): Promise<T> => await p;

  /** Reads the gate right before fn, in the same tick. liveOn "call": live at the call; "resolve": live when fn's promise resolves and liveWhen (default: always) accepts the value (a refused POST never goes live). */
  const launch = <T>(e: GateEntry, fn: () => T, o?: { liveOn?: "call" | "resolve"; liveWhen?: (v: Awaited<T>) => boolean }): T => {
    const w = why(e);
    if (w || e.done) throw new GateStopped(w);
    if (o?.liveOn === "resolve") {
      const r = fn() as unknown as Promise<unknown>;
      return r.then((v) => { if (!o.liveWhen || o.liveWhen(v as Awaited<T>)) e.live = true; return v; }) as unknown as T;
    }
    // A launch that throws synchronously gives back the PRIOR value (never a forced false): a write launch on an already-live entry stays live,
    // because the close path owns that ending; a spawn launch goes back to not live, so the wrapper ends the turn (STOP-NONACP ruling A, 11-08).
    const was = e.live;
    e.live = true;
    try { return fn(); } catch (x) { e.live = was; throw x; }
  };

  /** Binds a live handle in one call: live, the stop that reaches it, and where its usage lives. `kept` is REQUIRED, so a live turn with no usage
   *  source does not compile (ruling B). An engine with nothing to kill (pi: stop() closes in the same tick) passes `kept: () => undefined`.
   *  `markLive: false` is for an engine whose launch makes the entry live later (codex reuse, muse): the getter and stop are installed, live is left alone. */
  const bindLive = (e: GateEntry, b: { stop?: (why: StopWhy) => void; kept: () => Record<string, unknown> | undefined; markLive?: false }): void => {
    if (b.markLive !== false) e.live = true;
    if (b.stop) e.stopLive = b.stop;
    e.kept = b.kept;
  };

  const settleThrow = (e: GateEntry, error: unknown, classify: Classify): { turnId: string } => {
    if (e.done) {
      // a rejection after the entry was settled (timeout settle, an earlier ending): swallowed, never a second ending
      console.warn("stop-gate: late rejection after the turn ended", error instanceof Error ? error.message : error);
      return { turnId: e.turnId ?? "" };
    }
    // Fable M-C: a live turn's ending belongs to the live close path (cost, usage, the interrupted ending); the wrapper never finishes it
    if (e.live) return { turnId: e.turnId ?? "" };
    const v: Verdict | null = error instanceof GateStopped ? { ok: false, stopReason: "refused" } : classify(error);
    if (v) { e.finish(v); return { turnId: e.turnId ?? "" }; }
    if (why(e)) { e.finish({ ok: false, stopReason: "refused" }); return { turnId: e.turnId ?? "" }; }
    throw error;
  };

  /** The sendTurn wrapper. Rejections with no mark and no verdict stay rejections (busy, validation) and release the entry. */
  const run = async <T>(e: GateEntry, body: () => Promise<T>, classify: Classify): Promise<T | { turnId: string }> => {
    let failed = false;
    try {
      return await body();
    } catch (error) {
      failed = true;
      return settleThrow(e, error, classify);
    } finally {
      if (failed && !e.detached && !e.live && !e.done) leave(e);
    }
  };

  /** Detached startup (muse runTurn, codex launchAttempt): the entry stays in the gate until the turn's single terminal. */
  const handoff = (e: GateEntry, body: () => Promise<void>, classify: Classify): void => {
    e.detached = true;
    void (async () => {
      try {
        await body();
        // Fable M-B: abandonment only with no mark and no terminal already on its way (muse endUnconfirmed, codex settle)
        if (!e.live && !e.done && why(e) === null && !e.terminalPending?.()) {
          // startup ended without launching: never silent
          console.warn("stop-gate: detached startup ended without launching");
          e.finish({ ok: false, stopReason: "error", error: `${env.engineName} did not start this turn` });
        }
      } catch (error) {
        try { settleThrow(e, error, classify); } catch (unclassified) {
          if (!e.done) e.finish({ ok: false, stopReason: "error", error: unclassified instanceof Error ? unclassified.message : String(unclassified) });
        }
      } finally {
        // a marked entry whose startup ended with nothing launched and no terminal pending is settled closing/asked, then leaves
        if (!e.live && !e.done && !e.terminalPending?.()) {
          if (why(e)) e.finish({ ok: false, stopReason: "refused" });
          else leave(e);
        }
      }
    })();
  };

  return { enter, leave, ask, close, why, drain, settleOutstanding, step, cleanupStep, launch, bindLive, run, handoff, size: () => entries.size };
}

export type StopGate = ReturnType<typeof createStopGate>;
