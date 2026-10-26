// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A teammate's note on a project card (a reviewer's requested changes, the lead's send-back or reassign note) as another bot reads it.
//
// A note is a bot's own words, so it is worker text like any answer: it is kept with where it came from (the bot that wrote it, the request it
// was written in, and the stored message it rests on: the reviewer's answer, or the result the lead judged), and it reaches a bot only through
// the one result gate (server/result-egress.ts), asked again every time a prompt quotes it. A verdict the gate allows never carries its notes on
// its own: when the answer a note rests on is withheld, forgotten or deleted, or its request is no longer this project's to deliver, the note is
// left out. A note that names no request or no stored message cannot be checked, so it is left out too.
//
// Write-time lineage (DESIGN-WRITETIME 2.5; closes evhand r11c): a note a bot writes in its turn rests on that whole turn, not on the
// one answer it names. The words of a note may copy anything the turn was shown (a short PIN from the lead's own earlier reply passes any
// overlap match), so whether they are "fresh" is never guessed: the note gets a prefix carry from the writer's turn (recordNoteLineage),
// its origin keeps the note's object id, and releaseNote asks the one read predicate (memoryLookup) about that object every time, on
// top of the result gate. When the owner withholds or deletes anything the turn rested on, the note is withheld with it.
import { doorReader } from "./bot-read.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { memoryLookup } from "./memory/deny-read.ts";
import { memoryRefKey, verdictShows, type MemoryRef } from "./memory/lineage-types.ts";
import { murageObjectRef, recordTurnObject } from "./memory/prompt-parts.ts";
import { requestSourceThread } from "./execution-audience.ts";
import { WorkerText, type EgressOrigin, type ReleasedText } from "./released-text.ts";
import { releaseStoredResult } from "./result-egress.ts";
import { roomRequest } from "./room-requests.ts";
import { rateLimited } from "./observe.ts";

/** Where a note came from, as the activity row keeps it beside the note. */
export interface NoteOrigin {
  /** The bot that wrote it. */
  by: string;
  /** The request it was written in (the review run; the lead's own turn). */
  requestId: string;
  /** The stored message it rests on. Absent for a reviewer's tool verdict: its review run's own answer stands in when the note is read. */
  threadId?: string;
  messageIds?: string[];
  /** The note's own object id (murageObjectRef "project-note"), when it was written in a turn whose lineage was recorded. */
  lineage?: string;
}

/** A note as it is stored: its words, sealed, and its origin (null on a row written before notes kept one). */
export interface StoredNote { text: WorkerText; origin: NoteOrigin | null }

const ID = /^[^\u0000-\u001f\u2028\u2029]{1,200}$/u;

/** A kept origin, read back from an activity row's detail: anything that is not exactly the shape above is no origin at all. */
export function noteOriginFrom(value: unknown): NoteOrigin | null {
  let data = value;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { by, requestId, threadId, messageIds, lineage } = data as Record<string, unknown>;
  if (typeof by !== "string" || !ID.test(by) || typeof requestId !== "string" || !ID.test(requestId)) return null;
  // a lineage id that is present but malformed is no origin at all (never read as "no lineage")
  if (lineage !== undefined && (typeof lineage !== "string" || !ID.test(lineage))) return null;
  const kept = lineage === undefined ? {} : { lineage: lineage as string };
  if (threadId === undefined && messageIds === undefined) return { by, requestId, ...kept };
  if (typeof threadId !== "string" || !ID.test(threadId) || !Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 8
    || !messageIds.every(id => typeof id === "string" && ID.test(id))) return null;
  return { by, requestId, threadId, messageIds: [...messageIds] as string[], ...kept };
}

/** A stored note, sealed the moment it is read from its row. */
export function storedNote(text: unknown, origin: unknown): StoredNote | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return { text: new WorkerText(text), origin: noteOriginFrom(origin) };
}

/** The answer a request's run left (its result message, in the thread it ran in), or none. */
export function requestAnswerOrigin(request: { target_thread_id?: unknown; result_message_id?: unknown } | null | undefined): EgressOrigin | undefined {
  const threadId = request?.target_thread_id, messageId = request?.result_message_id;
  return typeof threadId === "string" && threadId && typeof messageId === "string" && messageId ? { threadId, messageIds: [messageId] } : undefined;
}

/** A note as a prompt may quote it now: its released words, "held" when a note was written but is not released now (what it rests on was
 * withheld or forgotten since, or it cannot be checked), or undefined when there is no note. A held note is said in the prompt (1.0.4 U02):
 * the reader knows a teammate's note exists and asks for it again, instead of working as if none was written. */
export function noteForPrompt(db: DatabaseSync, note: StoredNote | null | undefined, notOwnerAudience: boolean): ReleasedText | "held" | undefined {
  if (!note) return undefined;
  const released = releaseNote(db, note, notOwnerAudience);
  if (released !== undefined) return released;
  rateLimited(`project-note-held\u0000${note.origin?.requestId ?? "no-origin"}`, NOTE_HELD_LOG_MS, folded => `[project] note held request=${note.origin?.requestId ?? "none"} lineage=${note.origin?.lineage === undefined ? "none" : noteLineageShown(db, note.origin.lineage) ? "shown" : "withheld"}${folded ? ` more=${folded}` : ""}`);
  return "held";
}
const NOTE_HELD_LOG_MS = 60_000;

/** The note as the gate releases it to a bot now, or nothing. `notOwnerAudience`: the reading turn is not the owner's audience. */
export function releaseNote(db: DatabaseSync, note: StoredNote | null | undefined, notOwnerAudience: boolean): ReleasedText | undefined {
  const origin = note?.origin;
  if (!note || !origin) return undefined;
  try {
    const request = roomRequest(db, origin.requestId);
    const destination = request ? requestSourceThread(origin.requestId, db) : undefined;
    // the place the request's result returns to, as the delivery check itself reads it
    if (!request || destination === undefined) return undefined;
    const rests = origin.threadId && origin.messageIds?.length ? { threadId: origin.threadId, messageIds: origin.messageIds }
      : requestAnswerOrigin({ target_thread_id: request.targetThreadId, result_message_id: request.resultMessageId });
    if (!rests) return undefined;
    // the note's own lineage first (write-time, r11c): withheld or still being checked means left out
    if (origin.lineage !== undefined && !noteLineageShown(db, origin.lineage)) return undefined;
    const released = releaseStoredResult({ requestId: origin.requestId, origin: rests }, origin.by, destination, { fromBotId: request.fromBotId ?? "" }, notOwnerAudience, note.text);
    return released.kind === "text" ? released.text : undefined;
  } catch { return undefined; }
}

/** The object a note is, for the read predicate. */
export const noteRef = (lineage: string): MemoryRef => murageObjectRef("project-note", lineage);

/** Whether the read predicate shows the note's own object now (content checks: the result gate judges the audience). Any error reads
 * as not shown. */
function noteLineageShown(db: DatabaseSync, lineage: string): boolean {
  try {
    const ref = noteRef(lineage);
    const verdict = memoryLookup(db, [ref], doorReader()).get(memoryRefKey(ref));
    return verdict !== undefined && verdictShows(verdict);
  } catch { return false; }
}

/** The thread a request's turn runs in (its target thread, else the thread it started from). */
export function requestTurnThread(db: DatabaseSync, requestId: string | undefined): string | undefined {
  if (!requestId) return undefined;
  try {
    const request = roomRequest(db, requestId);
    return request ? (request.targetThreadId ?? request.rootThreadId ?? undefined) : undefined;
  } catch { return undefined; }
}

/** Records a note a bot writes in the turn running on `writerThreadId` (a prefix carry from that turn, DESIGN-WRITETIME 2.5) and returns
 * the note's object id for its origin, or undefined outside a recorded turn. Call it in the transaction that writes the note. */
export function recordNoteLineage(db: DatabaseSync, writerThreadId: string | undefined, requestId: string, writerBotId?: string): string | undefined {
  const lineage = `${requestId}:${randomUUID()}`;
  return recordTurnObject(db, writerThreadId, noteRef(lineage), writerBotId) ? lineage : undefined;
}
