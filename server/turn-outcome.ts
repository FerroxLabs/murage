import type { RuntimeEvent } from "./contracts.ts";
import { STOPPED_MID_DESKTOP_ACTION } from "../shared/host-stop.ts";
import { ASK_STOP_REASONS } from "./drivers/ask-stop.ts";

type TerminalTurn = Pick<Extract<RuntimeEvent, { type: "turn.completed" }>, "ok" | "stopReason">;

/** A stopped turn settles ok:true with stopReason "cancelled" (ACP, Pi,
 * Claude and Codex all report a requested stop this way, so the chat shows
 * the normal stopped state instead of an engine error). `ok` alone therefore
 * means "not an engine failure", never "the work finished". */
export function turnStopped(event: TerminalTurn): boolean {
  return event.stopReason === "cancelled" || turnAskStopped(event);
}

/** Murage itself ended the turn at the Ask boundary (./drivers/ask-stop.ts): the engine settles ok:true with an Ask
 * stop reason (Antigravity's "ask_stop"). It is a stop, never finished work, so turnStopped holds for it and
 * turnSucceeded does not; but the person did not press Stop, so no "Stopped by you" line: ASK_STOP_NOTE stands. */
export function turnAskStopped(event: TerminalTurn): boolean {
  return typeof event.stopReason === "string" && (ASK_STOP_REASONS as readonly string[]).includes(event.stopReason);
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

/** The host-stop reason (shared/host-stop.ts, read as "Stopped: <reason>") for a turn the ENGINE ended right after a
 * permission ask was denied (turn.completed `deniedBy`). Nobody pressed Stop, so "Stopped by you" would be untrue;
 * this says what happened and how to carry on. */
export function deniedTurnStopReason(deniedBy: "user" | "timeout" | "system"): string {
  if (deniedBy === "timeout") return "a request went unanswered, so the engine ended the turn. Send a message to carry on.";
  if (deniedBy === "user") return "the engine ended the turn after the request was declined. Send a message to carry on.";
  return "the engine ended the turn after a request could not be answered. Send a message to carry on.";
}
