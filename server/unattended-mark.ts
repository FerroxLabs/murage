// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a turn's start does to its thread's unattended mark (startTurnAdmitting in index.ts calls this after the busy and
// thread-limit checks). A webhook or channel turn, or one inherited from a bot running unattended, marks the thread; a
// person typing into the bot clears it; and (1.0.10, NOLIMITS-CARDS r1) so does a scheduled or manual run of the owner's
// own routine, which is the owner's standing instruction, not an outside event. A peer turn, a card continuation and an
// asker wake leave the mark as it is.

export type UnattendedMarkAction = "mark" | "clear" | "keep";

export interface UnattendedMarkStart {
  automationSource?: string;
  unattended?: boolean;
  commsDepth?: number;
  cardContinuation?: unknown;
  askerWake?: unknown;
}

export function unattendedMarkAction(opts: UnattendedMarkStart | undefined, humanIsOwner: boolean): UnattendedMarkAction {
  if (opts?.automationSource === "webhook" || opts?.automationSource === "channel" || opts?.unattended) return "mark";
  if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) return "clear";
  if (humanIsOwner && (opts?.automationSource === "schedule" || opts?.automationSource === "manual") && !opts?.commsDepth && !opts?.cardContinuation && !opts?.askerWake) return "clear";
  return "keep";
}

/** The approval site's reading of a marked thread: a tool approval is unattended unless the turn is the follow-through
 * of the owner's own routine (a routine wake, or the owner's project routine run in a project room) carrying its ceiling. */
export function toolApprovalUnattended(marked: boolean, routineWake: unknown): boolean {
  return marked && !routineWake;
}
