// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 (field gate, lane fix1022-withheld-fable): which engines last told Murage they need signing in.
// Owners: this lane owns this module and its use for the refused-send line (index.ts refusedSendLine); the drivers own the
// sign-in facts it reads (runtime.error authRequired, turn.completed stopReason "auth_required").
//
// Field report: a Claude login expired, the message was sent again, Murage refused to repeat the send (its checks never send one
// message twice) and the row read only "Murage could not send it again because the checks before sending did not pass". The
// person could not tell that signing in was the way out. A refused send on an engine marked here names the sign-in instead.
// The mark is display evidence only: it never authorizes, refuses or re-sends anything.

/** A mark older than this says nothing any more (the person may have signed in outside Murage, where no event tells Murage). */
export const SIGN_IN_OWED_TTL_MS = 30 * 60 * 1000;
const MAX_MARKS = 256;

export class EngineSignInOwed {
  private readonly marks = new Map<string, number>();
  /** The engine said it needs signing in (its error row, or a turn it ended as auth_required). */
  note(instanceId: string | undefined, now = Date.now()): void {
    if (!instanceId) return;
    this.marks.delete(instanceId);
    if (this.marks.size >= MAX_MARKS) this.marks.delete(this.marks.keys().next().value!);
    this.marks.set(instanceId, now);
  }
  /** A turn on this engine finished well, or its sign-in was confirmed: it is signed in. */
  clear(instanceId: string | undefined): void { if (instanceId) this.marks.delete(instanceId); }
  owed(instanceId: string | undefined, now = Date.now()): boolean {
    if (!instanceId) return false;
    const at = this.marks.get(instanceId);
    if (at === undefined) return false;
    if (now - at > SIGN_IN_OWED_TTL_MS) { this.marks.delete(instanceId); return false; }
    return true;
  }
  /** One runtime event of an engine: the two sign-in facts mark it, a turn that finished well clears it. */
  observe(instanceId: string | undefined, event: { type: string; authRequired?: unknown; ok?: unknown; stopReason?: unknown }, now = Date.now()): void {
    if (event.type === "runtime.error" && event.authRequired === true) this.note(instanceId, now);
    else if (event.type === "turn.completed" && event.stopReason === "auth_required") this.note(instanceId, now);
    else if (event.type === "turn.completed" && event.ok === true) this.clear(instanceId);
  }
}
