// 1.0.20 STOP-CHIP (JOINT RULING STOP-VS-REFUSAL): the one terminal line of an owner Stop on a direct run, at most once per dispatch
// generation, in every phase. "Stopped by you" used to have one writer, the fold of a stopped turn.completed; a run stopped while it
// was queued or in dispatch preparation has no engine turn, so that event never comes, and the rejection that follows the Stop is
// dropped as stale by design. The Stop itself owes the line there. Design: swarm-b/stopchip-fable/DESIGN.md.
import { PendingTurnKeys } from "./fold-steps.ts";

/** How far a dispatch had got when the first Stop on its generation was accepted (the dispatch claim's phase). */
export type StopPhaseBeforeEngine = "setup" | "dispatching";

export function createOwnerStopTerminals(ports: {
  /** A host stop already said why this turn ended: the person did not press Stop. */
  hostStopNoted(threadId: string): boolean;
  /** Appends the stop line to the thread. May throw (a busy database). */
  writeLine(threadId: string): void;
  warn(message: string, error: unknown): void;
}) {
  const written = new PendingTurnKeys();
  const armed = new Map<string, { phase: StopPhaseBeforeEngine; hostNote?: string }>();
  /** The generation fence. Marked only after the row is written: a redelivered fold whose write failed writes it then, and a late
   * second caller for the same generation (a stale terminal event, a second Stop, the give-back after the Stop route) writes nothing. */
  const once = (generation: string | undefined, write: () => void): boolean => {
    if (written.has(generation)) return false;
    write();
    if (generation !== undefined) written.add(generation);
    return true;
  };
  /** A confirmed Stop ended a run that has no engine turn. A host stop keeps its own line. A failed write never fails the Stop. */
  const note = (threadId: string, generation: string, hostNote?: string): boolean => {
    if (hostNote !== undefined || ports.hostStopNoted(threadId)) return false;
    try { return once(generation, () => { ports.writeLine(threadId); }); }
    catch (error) { ports.warn(`[stop] could not record the stop line on thread ${threadId}`, error); return false; }
  };
  return {
    once,
    note,
    /** Records the claim phase of the first Stop on a generation. The fact belongs to the generation, not to one Stop call (the first
     * Stop consumes the claim), so a later or racing Stop on the same generation reads the same answer:
     * "setup" (the adapter was never invoked): whichever Stop releases the run writes the line (noteArmed);
     * "dispatching" (the adapter was invoked, no turn handed back yet): the guarded send keeps the run until it hands back, for a
     * second Stop as for the first, and its give-back writes the line when it retires the generation (note). */
    arm(generation: string, phase: StopPhaseBeforeEngine, hostNote?: string): void {
      if (armed.has(generation)) return;
      armed.set(generation, { phase, hostNote });
      if (armed.size > 512) armed.delete(armed.keys().next().value!);
    },
    dispatching: (generation: string): boolean => armed.get(generation)?.phase === "dispatching",
    /** The Stop route released a run with no known engine turn: it writes the line only for a generation stopped in setup. */
    noteArmed(threadId: string, generation: string): boolean {
      const stop = armed.get(generation);
      return stop?.phase === "setup" ? note(threadId, generation, stop.hostNote) : false;
    },
  };
}
