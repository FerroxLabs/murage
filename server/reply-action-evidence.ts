// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The record a reply's action claims are checked against, read from the line
// index instead of a window of rows (reply-action-guard.ts has the claim logic).
//
// What the check needs from the active branch, and how it is found:
//   - the closing turn's own rows (turn_first onward): its reply pieces, what it
//     completed, what it left opaque;
//   - the owner's last row (the owner class): the boundary of "since the owner
//     last spoke";
//   - for a class a claim names: the newest row of that class earlier than this
//     turn (the "earlier" evidence), and whether the same bot did it since the
//     owner spoke. Read newest first from that class alone, so a class the thread
//     never used costs nothing, and one it used is found where it last happened.
import { ACTION_CLASS_NAMES, LINE_ACTION_BASE, LINE_DELEGATION, LINE_OWNER, LINE_TEXT } from "./branch-index.ts";
import { isOwnerLine } from "./line-classes.ts";
import { authoredTurnPieces, delegationSources, rowActions, type ActionEvidence } from "./reply-action-guard.ts";
import type { ActionClass } from "../shared/reply-action-claims.ts";
import type { Message, Store } from "./store.ts";

type Reply = Pick<Message, "id" | "text" | "turnId" | "from">;

type Positioned = { message: Message; position: number; after: (other: number) => boolean };
/** The owner's last row on the branch: the newest of their text lines and their rows without words, read newest first. */
export function ownerLine(store: Store, threadId: string): Positioned | undefined {
  const text = store.newestRowOfClass(threadId, LINE_TEXT, isOwnerLine);
  const wordless = store.newestRowOfClass(threadId, LINE_OWNER);
  if (text && wordless) return text.after(wordless.position) ? text : wordless;
  return text ?? wordless;
}

/** The rows of teammates this bot handed work to, found from the delegation rows since the owner last spoke. */
export function delegatedRows(store: Store, threadId: string, groupThreadOf: (groupId: string) => string | undefined): Message[] {
  const ownerRow = ownerLine(store, threadId);
  const since: Message[] = [];
  for (const row of store.branchLinesNewest(threadId, LINE_DELEGATION)) {
    if (ownerRow && !row.after(ownerRow.position)) break;
    since.push(row.message);
  }
  since.reverse();
  const sources = delegationSources(ownerRow ? [ownerRow.message, ...since] : since, groupThreadOf);
  return sources.flatMap((source) => {
    // the rows written there since the owner's line, newest first, never the whole thread
    const rows: Message[] = [];
    store.scanNewest(source.threadId, (row) => { if (row.at < source.since) return true; rows.push(row); return false; }, Number.POSITIVE_INFINITY);
    rows.reverse();
    if (!source.messageIds) return rows.filter((row) => row.role === "bot");
    const turns = new Set(rows.filter((row) => source.messageIds!.includes(row.id)).map((row) => row.turnId).filter(Boolean));
    return rows.filter((row) => row.role === "bot" && (source.messageIds!.includes(row.id) || (row.turnId && turns.has(row.turnId))));
  });
}

export function branchActionEvidence(store: Store, threadId: string, reply: Reply, delegated: readonly Message[], unverifiable?: boolean): ActionEvidence {
  const onBranch = store.branchMembership(threadId);
  const turnRows = reply.turnId ? store.turnRows(threadId, reply.turnId).filter((row) => onBranch(row.id)) : [];
  const pieces = authoredTurnPieces(turnRows, reply);
  const current = new Set<ActionClass>(), opaque = new Set<ActionClass>();
  const operationsOf = (row: Message) => { const evidence = rowActions(row); return evidence.operations?.length ? evidence.operations : [evidence]; };
  for (const row of delegated) for (const operation of operationsOf(row)) if (operation.outcome === "completed") for (const cls of operation.classes) current.add(cls);
  for (const row of turnRows) {
    for (const operation of operationsOf(row)) {
      if (operation.outcome === "opaque") for (const cls of operation.classes) opaque.add(cls);
      if (operation.outcome === "completed") for (const cls of operation.classes) current.add(cls);
    }
  }
  const ownerPosition = ownerLine(store, threadId)?.position;
  const sameBot = (row: Message) => !row.from?.botId || !reply.from?.botId || row.from.botId === reply.from.botId;
  const scanned = new Map<ActionClass, { recent: boolean; earlier?: string }>();
  const scan = (cls: ActionClass) => {
    let found = scanned.get(cls);
    if (found) return found;
    found = { recent: false };
    for (const row of store.branchLinesNewest(threadId, LINE_ACTION_BASE + ACTION_CLASS_NAMES.indexOf(cls))) {
      if (reply.turnId !== undefined && row.message.turnId === reply.turnId) continue;
      found.earlier ??= row.message.id;
      const afterOwner = ownerPosition === undefined || row.after(ownerPosition);
      if (afterOwner && sameBot(row.message)) { found.recent = true; break; }
      if (!afterOwner) break; // older than the owner's last line: nothing newer can make it recent
    }
    scanned.set(cls, found);
    return found;
  };
  return { pieces, current, opaque, unverifiable, recent: (cls) => scan(cls).recent, earlier: (cls) => scan(cls).earlier };
}
