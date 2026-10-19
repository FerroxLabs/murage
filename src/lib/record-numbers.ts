// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server's numbers on a room record (CI-OVERLAY-DESIGN I-H2, r4 I-H1): every answer carrying a room carries `recordSeq`, the
// number of the last frame built for it, and `recordEpoch`, the run. A patch a client builds from such an answer (a restore's
// `hidden`, a PATCH reply's two fields) is still the server's statement about the room, so it carries the numbers and the reducer
// orders it against the held copy. A patch without them is the client's own optimistic change and applies as before.

export interface RecordNumbers { recordSeq?: number; recordEpoch?: string }

/** The numbers of a room record as an answer carried it; nothing when the answer is unnumbered (an older server). */
export function groupNumbers(record: unknown): RecordNumbers {
  if (!record || typeof record !== "object") return {};
  const { recordSeq, recordEpoch } = record as { recordSeq?: unknown; recordEpoch?: unknown };
  return typeof recordSeq === "number" && typeof recordEpoch === "string" ? { recordSeq, recordEpoch } : {};
}

/** The one patch a client builds from a room answer about `hidden` (archive, restore, the PATCH reply): the server's `hidden`
 * (true, or cleared) under the answer's numbers. */
export function hiddenPatchFrom(id: string, record: unknown): { id: string; hidden: true | undefined } & RecordNumbers {
  const hidden = !!record && typeof record === "object" && (record as { hidden?: unknown }).hidden === true ? true : undefined;
  return { id, hidden, ...groupNumbers(record) };
}
