import type { RuntimeEvent } from "./contracts.ts";

type TerminalTurn = Pick<Extract<RuntimeEvent, { type: "turn.completed" }>, "ok" | "stopReason">;

/** A stopped turn settles ok:true with stopReason "cancelled" (ACP, Pi,
 * Claude and Codex all report a requested stop this way, so the chat shows
 * the normal stopped state instead of an engine error). `ok` alone therefore
 * means "not an engine failure", never "the work finished". */
export function turnStopped(event: TerminalTurn): boolean {
  return event.stopReason === "cancelled";
}

/** The turn ran to its end. Anything that treats a turn's result as finished
 * work (publishing outputs, a delegation receipt, an ask_bot reply, a routine
 * marked completed, draining queued handoffs) must use this, not `ok`
 * (STOP1, U-02: cancelled or failed turns are never treated as done). */
export function turnSucceeded(event: TerminalTurn): boolean {
  return event.ok && !turnStopped(event);
}

/** The memory settlement label for a terminal turn. */
export function turnOutcome(event: TerminalTurn): "completed" | "cancelled" | "failed" {
  return turnStopped(event) ? "cancelled" : event.ok ? "completed" : "failed";
}
