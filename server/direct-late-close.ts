// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// A direct run after its terminal event (A2):
//   SETTLING --close confirmed--> RELEASED
//   SETTLING --deadline---------> RETAINED   (reportUnconfirmedDirectStop)
//   RETAINED --confirmed close--> RELEASED_LATE
// The last edge is driven only by the engine's own confirmed close
// (ChildTeardown.onClosed through the adapter's awaitTurnClose), never by a
// timer: a child that never closes keeps the run retained.

/** The activity line written when a retained run is released by its engine's later close. */
export const ENGINE_CLOSED_LATE_NOTE = "Engine closed; you can continue this conversation.";
/** The activity line written when a run is retained (reportUnconfirmedDirectStop). It agrees with
 * ENGINE_CLOSED_LATE_NOTE: the conversation carries on by itself once the engine exits, and a restart
 * is only the way out if it never does. */
export const PROVIDER_STOP_UNCONFIRMED_LINE = "error: provider stop is unconfirmed; this conversation continues once the engine exits, or restart Murage if it stays stuck";

export interface LateCloseRelease {
  /** The exact turn's close, captured before the bounded wait began. */
  closed: Promise<void>;
  /** The retained run still owns its thread (directRuns.current). */
  owns: () => boolean;
  /** The conversation still exists. */
  threadExists: () => boolean;
  /** Writes the one activity line. */
  note: () => void;
  /** The same release a confirmed close at the deadline would have run. */
  release: () => void;
  /** FENCE-RACE-1018 r2 (E12): called once when the watch ends WITHOUT calling release (ownership lost, thread gone, a rejected
   *  close, a throwing note), so whatever waited on the release can still be decided. */
  abandon?: () => void;
}

/** RETAINED -> RELEASED_LATE. A no-op when a replacement run or a Stop already
 * took the thread, when the conversation is gone, or on a repeated callback. */
export function releaseOnLateClose(input: LateCloseRelease): void {
  let settled = false;
  let abandoned = false;
  const abandon = () => {
    if (abandoned) return;
    abandoned = true;
    try { input.abandon?.(); } catch (abandonError) { console.error("[direct-late-close] abandon", String(abandonError).slice(0, 200)); }
  };
  void input.closed.then(() => {
    if (settled) return;
    settled = true;
    if (!input.owns() || !input.threadExists()) { abandon(); return; }
    input.note();
    input.release();
  }).catch((error: unknown) => {
    console.error("[direct-late-close]", String(error instanceof Error ? error.message : error).slice(0, 200));
    settled = true;
    abandon();
  });
}
