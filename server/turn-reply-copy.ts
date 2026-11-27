// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The originals a turn's reply is a copy of (a hand-off's result, an ask's answer): the link the result gate walks and the delivered row keeps.
//
// 1.0.21 cause15 (rig-realsize RED item 2): a long turn writes a text line at every step, and the link named every one of them. A copy may
// name at most COPY_ORIGINS originals anywhere in the lineage (the gate's walk, the copy check, the copy's own lineage row), so a delegated
// turn with more text lines than that could never be delivered: its reply read "checking" for good, nothing on the memory side was owed, and
// after the whole wait the asker got the no-answer line.
//
// A HAND-OFF's result delivers only the turn's LAST reply (index.ts lastReply), so the copy it writes names at most COPY_ORIGINS lines: the
// newest ones, the reply itself last. But EVERY line of the turn is judged first, by the gate itself and by every rule of it, at every run
// of the finalizer (releaseHandoffLink): the link is cut into groups the gate can walk, each group is put to the gate, and the reply is
// released only when every group reads text. One group that reads withheld withholds the reply; one that is still being checked keeps the
// hand-off waiting. Nothing is looked up beforehand to decide which lines may be left out, and no shortened link is ever kept between runs:
// the finalizer holds the whole link (handoffReplyCopyOf) and judges all of it again at each re-check.
// (1.0.21 cause15 r2. The first fix chose the lines to name with a lookup of its own: an older line still being checked took a place from
// the newest 64, a flagged line among them fell out, and the re-check, which reused that link, released the reply once the older check
// cleared. That lookup also read with a looser reader than the gate does. Both are gone.)
// An ASK's answer joins every line of the turn, so its link stays whole (turnReplyCopyOf): every word delivered is judged.
import { LINE_BOT_EMPTY, LINE_TEXT } from "./branch-index.ts";
import { COPY_ORIGINS } from "./memory/lineage-types.ts";
import type { ReleasedResult } from "./result-egress.ts";
import type { Message } from "./store.ts";

/** What the link reads from the store (store.ts Store). */
export interface TurnReplyStore {
  turnReplyOriginals(threadId: string, turnId: string): string[];
  scanNewestLines(threadId: string, visit: (message: Message) => boolean, classes?: readonly number[]): boolean;
}

/** The groups a hand-off's link is judged in (`ids`: every line of the turn, oldest first, the reply last): the newest COPY_ORIGINS lines
 * are the last group (the one the delivered copy names), and the older lines come before it in groups of at most COPY_ORIGINS, oldest
 * first. Every id is in exactly one group. */
export function handoffLinkGroups(ids: readonly string[]): string[][] {
  const cut = Math.max(0, ids.length - COPY_ORIGINS);
  const groups: string[][] = [];
  for (let from = 0; from < cut; from += COPY_ORIGINS) groups.push(ids.slice(from, Math.min(from + COPY_ORIGINS, cut)));
  groups.push(ids.slice(cut));
  return groups;
}

/** The gate's answer for a hand-off's reply whose turn wrote `ids` (see the head of this file). `release` is the gate, asked about one
 * group of lines. Text (the answer for the newest group, whose lines the copy names) only when EVERY group reads text. Otherwise, fail
 * closed, the first of: a refusal, withheld, gone, checking (without the words a group's answer may hold: they belong to no copy), or
 * whatever else a group answered. A link the gate can walk in one go is asked about once, as before. */
export function releaseHandoffLink(ids: readonly string[], release: (messageIds: string[]) => ReleasedResult): ReleasedResult {
  if (ids.length <= COPY_ORIGINS) return release([...ids]);
  const answers = handoffLinkGroups(ids).map(group => release(group));
  if (answers.every(answer => answer.kind === "text")) return answers[answers.length - 1]!;
  const first = (kind: ReleasedResult["kind"]) => answers.find(answer => answer.kind === kind);
  const checking = first("checking");
  return first("refused") ?? first("withheld") ?? first("gone")
    ?? (checking?.kind === "checking" ? { kind: "checking", line: checking.line } : answers.find(answer => answer.kind !== "text")!);
}

/** A hand-off's link: every reply the turn wrote, the whole link. The finalizer keeps it and judges all of it at every run
 * (releaseHandoffLink); the copy it writes names the newest group only. */
export function handoffReplyCopyOf(store: TurnReplyStore, threadId: string, turnId: string | undefined, since?: number): Message["copyOf"] {
  return turnReplyCopyOf(store, threadId, turnId, since);
}

/** Every reply the turn wrote (an ask's answer joins them all, so all are named). */
export function turnReplyCopyOf(store: TurnReplyStore, threadId: string, turnId: string | undefined, since?: number): Message["copyOf"] {
  // The turn's own replies through the line index (every one, however many tool rows lie between them), and the
  // replies since the handoff began read newest first: never the thread's history.
  const isText = (m: Message) => m.role === "bot" && m.kind === "text" && !m.copyOf;
  const ids = turnId ? store.turnReplyOriginals(threadId, turnId) : [];
  const texts: Message[] = [];
  if (!ids.length) store.scanNewestLines(threadId, (m) => {
    if (since !== undefined && m.at < since) return true;
    if (isText(m)) { texts.unshift(m); if (since === undefined) return true; }
    return false;
  }, [LINE_TEXT, LINE_BOT_EMPTY]);
  // Without the turn's own rows: every reply the thread made since the
  // handoff started, else its latest one. Linking more than the original
  // only withholds the copy more often, never less.
  if (!ids.length && since !== undefined) ids.push(...texts.map((m) => m.id));
  // Only with neither: the thread's latest reply. A turn that wrote nothing since the handoff began has no original, and its copy (a
  // placeholder) needs no link.
  const latest = texts.at(-1);
  if (!ids.length && since === undefined && !turnId && latest) ids.push(latest.id);
  return ids.length ? { threadId, messageIds: ids } : undefined;
}
