import type { RuntimeEvent } from "./contracts.ts";
import { STOPPED_MID_DESKTOP_ACTION } from "../shared/host-stop.ts";

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

/** The transcript line for a turn the person stopped. It is an activity note,
 * not an error: stopping is a normal thing to do. Whatever had already
 * streamed is kept above it (F6). */
export const TURN_STOPPED_NOTE = "Stopped by you";

/** The same line when the stop withdrew a desktop action the computer driver
 * was already running (shared/host-stop.ts). It replaces TURN_STOPPED_NOTE;
 * the turn never gets both. */
export const TURN_STOPPED_DESKTOP_ACTION_NOTE = STOPPED_MID_DESKTOP_ACTION;

/** The transcript line for a turn that was still running when Murage closed.
 * Routines, memory turns and team goals have always had one of these; a 1:1
 * turn had nothing, so the thread just ended on the person's message (F7). */
export const TURN_INTERRUPTED_NOTE = "Murage closed while this was running, so there is no answer. Send it again when you want one.";
