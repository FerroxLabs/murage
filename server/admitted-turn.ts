// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A direct turn owns its thread from admission (IndependentThreadRuns.admit).
// Everything between admission and the background setup used to run with no
// way back: a throw there (a routine due at boot read module state the server
// had not created yet) left the thread's slot taken, and every later run on
// that thread stayed queued until Murage restarted. Here the start of an
// admitted turn always ends one of two ways: the background setup owns the
// run, or the run is given back.

/** Runs `start`, which launches the admitted turn's background setup and
 * returns its promise. A synchronous throw gives the run back (in a finally)
 * and is rethrown to the caller. A rejection of the background work (its own
 * failure handling failed before it let go of the run) gives the run back too.
 * `giveBack` must be idempotent and act only while the run is still current. */
export function startAdmittedTurn(start: () => Promise<void>, giveBack: (error: unknown, phase: AdmittedPhase) => void, log: (line: string) => void = (line) => console.error(line)): Promise<void> {
  let handedOff = false;
  let thrown: unknown;
  try {
    const work = start();
    handedOff = true;
    return work.then(undefined, (error: unknown) => {
      log(`[turn] a started turn failed after admission and gave its thread back: ${describe(error)}`);
      giveBackQuietly(giveBack, error, "setup", log);
    });
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    if (!handedOff) giveBackQuietly(giveBack, thrown, "start", log);
  }
}

function giveBackQuietly(giveBack: (error: unknown, phase: AdmittedPhase) => void, error: unknown, phase: AdmittedPhase, log: (line: string) => void): void {
  // the original error is the one the caller sees; a failing give-back is logged, never swapped in for it
  try { giveBack(error, phase); }
  catch (releaseError) { log(`[turn] could not give an admitted thread back: ${describe(releaseError)}`); }
}

/** "start": the throw came before the background setup began, and is rethrown to the caller (which reports it).
 * "setup": the background setup's own failure handling failed; nobody else will report or clean up after it. */
export type AdmittedPhase = "start" | "setup";

/** What the turn's own failure handler has already settled, so the give-back never undoes or repeats it. */
export type AdmittedTurnState = {
  /** The engine's stop was unconfirmed after access changed: the handler keeps the thread until restart, on purpose. */
  keepThread: boolean;
  /** The handler already told the caller (onDispatchError). */
  reported: boolean;
};

export type GiveBackSteps = {
  /** PROVISIONAL INTERFACE: I supplies the captured batch terminalizer. It must
   * commit first or throw; false means stale ownership, so no cleanup is allowed. */
  commitTerminal?: (error: unknown) => boolean | void;
  /** This run still owns the thread. */
  current: () => boolean;
  /** Some run (a newer turn) holds the thread now. */
  threadHeld: () => boolean;
  /** End this generation's per-turn marks (attribution, capabilities, watch, routine binding). */
  endMarks: () => void;
  release: () => void;
  markIdle: () => void;
  report: (error: unknown) => void;
  drain: () => void;
};

/** Gives an admitted turn's thread back after its start or its failure handling failed. Every step runs on its own,
 * so one that throws never leaves the bot marked busy or its queue stuck behind it. A thread the handler chose to
 * keep stays kept; a newer turn's run and busy mark are never touched. */
export function giveBackAdmitted(state: AdmittedTurnState, phase: AdmittedPhase, error: unknown, steps: GiveBackSteps, log: (line: string) => void = (line) => console.error(line)): void {
  const run = (name: string, step: () => void) => { try { step(); } catch (stepError) { log(`[turn] give-back step ${name} failed: ${describe(stepError)}`); } };
  if (steps.commitTerminal) {
    try { if (steps.commitTerminal(error) === false) return; }
    catch (commitError) { log(`[turn] receipt settlement pending: ${describe(commitError)}`); return; }
  }
  run("endMarks", steps.endMarks);
  if (state.keepThread) return;
  let current = false, held = true;
  run("current", () => { current = steps.current(); });
  if (current) run("release", steps.release);
  run("threadHeld", () => { held = steps.threadHeld(); });
  if (!held) run("markIdle", steps.markIdle);
  if (phase === "setup" && !state.reported) run("report", () => steps.report(error));
  run("drain", steps.drain);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PROVISIONAL INTERFACE: I supplies generation-scoped effect receivers and the
 * existing explanation lookup/writer. All six terminal paths use this object;
 * receipt failure is retried without keeping an open transaction or releasing. */
export function createAttemptTerminalizer(
  store: import("./send-attempt-state.ts").SendAttemptStore,
  bindings: readonly import("./send-attempt-state.ts").BindingKey[],
  hooks: {
    current: () => boolean;
    seal: () => void;
    requestStop: () => void;
    explanationExists: (attemptId: string) => boolean;
    explain: (receipt: import("./send-attempt-state.ts").AttemptSnapshot, key: string) => void;
    effect: (effect: import("./send-attempt-state.ts").CleanupEffect) => boolean | void;
  },
) {
  let pending: { outcome: import("./send-attempt-state.ts").TerminalOutcome; delivery: import("./send-attempt-state.ts").AttemptDelivery } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;
  const retry = () => {
    if (timer || stopped) return;
    timer = setTimeout(() => { timer = undefined; attempt(); }, Math.min(5_000, 1_000 * 2 ** failures++));
    timer.unref?.();
  };
  const attempt = (): boolean => {
    if (!pending || stopped) return false;
    if (!hooks.current()) { stopped = true; return false; }
    try {
      // Reload evidence revisions only; immutable captured bindings/fences are
      // passed unchanged, so a rebuild can never adopt an old callback.
      store.settleBatch(bindings.map(key => ({ key, revision: store.byId(key.attemptId)?.revision ?? -1 })), pending.outcome, pending.delivery);
      const first = bindings[0];
      if (!first) { stopped = true; return true; }
      const complete = store.flushEffects(first.threadId, first.generation, effect => {
        if (!hooks.current()) return false;
        if (effect.kind === "publication") {
          for (const key of bindings) {
            const receipt = store.byId(key.attemptId)!;
            if ((receipt.terminalOutcome === "failed" || receipt.terminalOutcome === "refused") && !hooks.explanationExists(receipt.attemptId)) hooks.explain(receipt, `${receipt.attemptId}:${receipt.revision}`);
          }
        }
        // current is checked again after the explanation writer, which may
        // synchronously change ownership; no stale release/idle/drain follows.
        if (!hooks.current()) return false;
        return hooks.effect(effect);
      });
      if (!complete) { retry(); return false; }
      stopped = true; return true;
    } catch (error) {
      if ((error as { code?: string }).code === "stale_action") { stopped = true; return false; }
      hooks.seal();
      try { hooks.requestStop(); } catch { /* durable ownership remains */ }
      retry(); return false;
    }
  };
  return {
    settle(outcome: import("./send-attempt-state.ts").TerminalOutcome, delivery: import("./send-attempt-state.ts").AttemptDelivery): boolean {
      if (!pending) pending = { outcome, delivery }; // first terminal intent wins
      return attempt();
    },
    retry: attempt,
    dispose() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
