// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memories waiting for the owner, in the Inbox (PROPOSAL-v2 section 3, item
// 0.4): one card per bot, counted PER ITEM in `decisions` (11 waiting is 11, not
// 1). Rides on the desktop's Inbox read beside the lesson suggestions. Counts
// and names only; the words of a memory never travel in the Inbox answer.
import type { InboxMemoryWaiting } from "../shared/inbox.ts";
import type { WaitingSummary } from "./memory/review.ts";

export type { InboxMemoryWaiting };

export function memoryWaitingRows(summary: WaitingSummary): InboxMemoryWaiting[] {
  return summary.subjects.filter(subject => subject.waiting > 0).map(subject => ({ kind: subject.kind, id: subject.id, name: subject.name, waiting: subject.waiting, everyday: subject.everyday }));
}

/** The Inbox read with the waiting memories attached and counted as owed. Unchanged when nothing waits. */
export function withMemoryWaiting<T extends { decisions?: number }>(body: T, rows: readonly InboxMemoryWaiting[]): T & { memoryWaiting?: InboxMemoryWaiting[] } {
  if (!rows.length) return body;
  const items = rows.reduce((sum, row) => sum + row.waiting, 0);
  return { ...body, memoryWaiting: [...rows], ...(typeof body.decisions === "number" ? { decisions: body.decisions + items } : {}) };
}
