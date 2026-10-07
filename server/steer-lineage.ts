// Output lineage of a steer (memory schema v6). A steer folds a line, and the
// reply it quotes, into a running turn. The quote's roots are what that text
// discloses to the engine, so they are taken when the text is rendered and
// recorded on the running turn and its engine session at the write boundary:
// inside the driver's submission fence, which runs with no await before the
// engine write. They are never recomputed after the engine's acknowledgement:
// by then the quoted reply can be withheld (its source revoked), and a check
// made then would record nothing for text the engine already has.
import type { Message } from "./store.ts";
import { capturedMessageWithheld, mergeOutputRoots, outputRootsBad, outputRootsFor, recordSessionRoots, type OutputRoots } from "./memory/replay-lineage.ts";
import { steerBusyDesk } from "./project-card-executor.ts";

/** A running turn's output lineage: the roots of what it was shown, laid on
 * each reply it produces and on its engine session. */
export interface RunningTurnLineage { roots: OutputRoots; instanceId: string; session?: string }
export type ShownLine = { threadId: string; id: string; role?: string; copyOf?: Message["copyOf"] };

/** The flat root set of the lines a turn's context showed: owner and person
 * lines never count, and a line withheld on content was shown as its
 * withheld line, not its words. A check that cannot finish fails closed. */
export function shownLinesRoots(lines: ReadonlyArray<ShownLine>): OutputRoots {
  try {
    return outputRootsFor(lines.filter(line => line.role !== "user" && !capturedMessageWithheld(line.threadId, line.id)));
  } catch (error) {
    console.warn(`[memory] output lineage could not be read (${error instanceof Error ? error.message.slice(0, 80) : "error"}); this turn's replies are withheld from bots`);
    return { roots: new Set(), over: true };
  }
}

/** Roots shown to a running turn after it started: they join the turn's
 * replies (every later output) and its engine session. */
export function addRootsToRunningTurn(threadId: string, lineage: RunningTurnLineage | undefined, added: OutputRoots): void {
  if (!lineage) return;
  if (!added.over && !added.roots.size) return;
  lineage.roots = mergeOutputRoots(lineage.roots, added);
  if (lineage.session) {
    try { recordSessionRoots(threadId, lineage.instanceId, lineage.session, added); }
    catch (error) { console.warn(`[memory] session lineage not recorded (${error instanceof Error ? error.message.slice(0, 80) : "error"})`); }
  }
}

type SteerAdapter = Parameters<typeof steerBusyDesk>[0];

/** Steers `text` into the running turn. `holds` is the session fence; `quote`
 * is the reply the text quotes, and `lineage` the running turn it joins (the
 * turn's entry when the steer started). The quote's roots are taken now, with
 * the text, and recorded right after the fence passes, before the write:
 * whatever the acknowledgement later says ("uncertain" included), the engine
 * may have the text. The fence also refuses when those roots no longer hold
 * (a source revoked or unprovable since the text was rendered, as while a
 * Claude steer waits for `init`): the text was rendered under the old
 * eligibility, so it is not written, and the line runs as its own turn, which
 * renders the quote again. A fence refusal writes nothing and records nothing. */
export function steerWithQuoteLineage(adapter: SteerAdapter, threadId: string, text: string, allowed: boolean, opts: {
  holds: () => boolean;
  steerId?: string;
  quote?: ShownLine;
  lineage: RunningTurnLineage | undefined;
}): Promise<"steer" | "queue" | "uncertain"> {
  const quoted = opts.quote ? shownLinesRoots([opts.quote]) : undefined;
  return steerBusyDesk(adapter, threadId, text, allowed, () => {
    if (!opts.holds()) throw new Error("MEMORY_CONTEXT_REVOKED");
    if (quoted && outputRootsBad(quoted)) throw new Error("MEMORY_CONTEXT_REVOKED");
    if (quoted) addRootsToRunningTurn(threadId, opts.lineage, quoted);
  }, opts.steerId);
}
