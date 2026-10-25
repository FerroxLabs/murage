// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two steps of the event fold that must be retryable when the database is locked (the bus redelivers the event): keeping a
// native session, and attaching generated images to the reply. Each commits its durable write before it gives up any
// state the next attempt needs.
import type { Message } from "./store.ts";

/** What a session was shown is written BEFORE the cursor that lets a later turn continue it. If the roots cannot be written the
 * cursor is withheld (an older one for this instance is dropped) and the failure propagates: a session continued without its
 * roots could carry context that was revoked since. `recordRoots` returning false means its lineage write did not commit and was
 * already rolled back and reported: the cursor is withheld the same way, and the cursor is published only after a committed write. */
export function retainSession(steps: { recordRoots?: () => unknown; saveCursor: () => void; dropCursor: () => void }): void {
  if (steps.recordRoots) {
    let recorded: unknown;
    try { recorded = steps.recordRoots(); }
    catch (error) { steps.dropCursor(); throw error; }
    if (recorded === false) { steps.dropCursor(); return; }
  }
  steps.saveCursor();
}

/** The turn's reply that carries generated images: its last bot text row, never a widget row (whose text is only a fallback). */
export function replyForStagedImages(rows: Message[], turnId: string): Message | undefined {
  return [...rows].reverse().find((message) => message.role === "bot" && message.kind === "text" && !message.widget && message.turnId === turnId);
}

type Attachment = NonNullable<Message["attachments"]>[number];
/** Attach staged images to the turn's reply (or, with no reply text, as a reply of their own). The staging is released only after
 * that write committed, and adopting is idempotent by path: a redelivery after a lock finds the images still staged, and one
 * after a commit adds nothing twice. */
export function adoptStagedImages(args: {
  staged: Map<string, Attachment[]>; key: string; reply: { id: string; attachments?: Attachment[] } | undefined;
  patch(id: string, attachments: Attachment[]): void; push(attachments: Attachment[]): void;
}): void {
  const generated = args.staged.get(args.key) ?? [];
  if (!generated.length) { args.staged.delete(args.key); return; }
  if (args.reply) {
    const held = new Set((args.reply.attachments ?? []).map(item => item.path));
    args.patch(args.reply.id, [...(args.reply.attachments ?? []), ...generated.filter(item => !held.has(item.path))]);
  } else args.push(generated);
  args.staged.delete(args.key);
}

/** Per-turn state the terminal event reads. Reading it does not consume it: the fold calls `consume` once the event's writes
 * committed, so a redelivery after a failed write finds the same state. Bounded: a close that never arrives must not accumulate. */
export class PendingTurnKeys {
  private readonly keys = new Set<string>();
  private readonly max: number;
  constructor(max = 512) { this.max = max; }
  add(key: string): void { this.keys.add(key); if (this.keys.size > this.max) this.keys.delete(this.keys.values().next().value!); }
  has(key: string | undefined): boolean { return key !== undefined && this.keys.has(key); }
  consume(key: string | undefined): void { if (key !== undefined) this.keys.delete(key); }
}

/** A callback that runs at most once, however often the fold that reads it is redelivered. */
export function once(run: () => void): () => void {
  let ran = false;
  return () => { if (ran) return; ran = true; run(); };
}

/** The ids a project card's room delivery posts under: a retry after a partial run finds its rows and adds nothing twice. */
export function cardRoomIds(requestId: string): { copy: string; line: string; correction(messageId: string): string } {
  return { copy: `card-room-${requestId}`, line: `card-room-line-${requestId}`, correction: (messageId) => `card-room-${requestId}-${messageId}` };
}

/** A reply that only repeated the memory references (MEMJSON1) is held as a marker until its turn completes. The outcome decided
 * for the marker is remembered on it, and the marker itself is dropped by the caller only after every terminal write committed:
 * a redelivery after a locked database must settle the turn the same way, not as a completed one. A marker left by another turn
 * (its settlement never finished) is not this event's. */
export type MemoryEchoMarker = { turnId?: string; text: string; failed?: boolean };
export function memoryEchoDecision(marker: MemoryEchoMarker | undefined, event: { turnId?: string }, state: { succeeded: boolean; hasReply: () => boolean }): { marker: MemoryEchoMarker | undefined; echoOnly: boolean } {
  if (!marker || (marker.turnId && event.turnId && marker.turnId !== event.turnId)) return { marker: undefined, echoOnly: false };
  marker.failed ??= Boolean(state.succeeded && !state.hasReply());
  return { marker, echoOnly: marker.failed };
}
