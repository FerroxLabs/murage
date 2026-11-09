// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 1D + r14.1 X1 (Fable r13 M1): the turn's replay WIDENING LOOP, extracted whole from startTurn (server/index.ts)
// so the turn and the lineage warmer's confirm (lineage-warm.ts) read exactly the same lines: the final activeMessages and skip set
// that every filterDirectReplay site of the turn takes. Every controlling input is a parameter (T11(h): the loop has no free
// variable): threadId, the window start, the store's line index, the bot viewer, routeHasTools, the externalUpdates key, the memory
// floor (memory mode / last resort, IX:12366), projectCardRun, the skip set and replayOptions. Per-turn work is the window that
// fills the replay budget, never the thread's history (lines older than the window are counted as not shown: replayMore).
import { botMessages, botViewer } from "../bot-read.ts";
import { database } from "../database.ts";
import { promptRows } from "../external-context-delivery.ts";
import type { Message } from "../store.ts";
import { replayWindow, type ReplayWindowOptions } from "./disclosures.ts";

/** The window of text lines a replay first reads; it doubles until the replay's own budget is filled from inside it. */
export const REPLAY_LINES_START = 80;

/** What the memory floor returns when memory is not active (or a last-resort rebuild): room-transcript.ts roomTranscriptWithoutMemory. */
export type ReplayFloor = { messages: Message[]; withheld: Set<string>; forgotten: Set<string>; checking: Set<string>; checked: Set<string> } | undefined;

/** The store's branch line index (store.ts activeTextLines). */
export interface ReplayLineIndex { activeTextLines(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; exact?: boolean } }

export interface TurnReplayInputsArgs {
  store: ReplayLineIndex;
  threadId: string;
  /** the bot whose viewer reads the rows (botViewer(botId)) */
  botId: string;
  routeHasTools: boolean;
  /** the task's queued external-update ids (promptRows' pending list) */
  externalUpdates: readonly string[] | undefined;
  /** null when memory mode is "active" and the turn is not the last resort (IX:12366): no floor. Otherwise the floor over the window's rows. */
  floor: ((activeMessages: Message[]) => ReplayFloor) | null;
  /** a project card run replays nothing, and the loop then runs to !replayMore (IX:12371) */
  projectCardRun: boolean;
  /** the turn's skip set: its own userMessage id and opts.excludeMessageIds (IX:12334); not modified */
  skip: ReadonlySet<string>;
  replayOptions: ReplayWindowOptions;
  /** r15 sec. 2: the lines kept free for the next turn's own user line U. The warmer's confirm runs at head h BEFORE U exists, so it
   * passes 1: each window W reads W - 1 lines, which are exactly the turn's W lines minus U (U is in the turn's skip set), so every
   * window, its hasMore, the replayable set, the replayed suffix and the stop are the turn's. The turn passes 0 (the default). */
  headSlot?: number;
  /** tests only: the first window (REPLAY_LINES_START) */
  windowStart?: number;
}

export interface TurnReplayInputs {
  /** the last window read */
  window: number;
  /** r15.1 (Fable Low): every window was read exactly (store.ts activeTextLines: no incomplete bounded walk, MDB:381, and no row of unknown
   * branch membership, MDB:392). An index that does not say is taken as not exact (any doubt). The warmer reads false as "checking: branch". */
  exact: boolean;
  /** each window's own exactness, in read order */
  exactWindows: boolean[];
  replayMore: boolean;
  branchMessages: Message[];
  activeMessages: Message[];
  tailIds: Set<string>;
  heldReplayIds: Set<string>;
  replayFloor: ReplayFloor;
  replayableMessages: Message[];
  replayedMessages: Message[];
  /** the final skip set: `skip` plus heldReplayIds (IX:12377) */
  skip: Set<string>;
}

/** The newest text lines of the active branch, read in a window that doubles until the replay's own budget is filled from inside it,
 * or the branch has no more (IX:12352-12377 at b13e, unchanged). */
export function turnReplayInputs(args: TurnReplayInputsArgs): TurnReplayInputs {
  const { store, threadId, botId, routeHasTools, externalUpdates, floor, projectCardRun, skip, replayOptions } = args;
  const headSlot = args.headSlot ?? 0;
  let replayMore = false;
  let branchMessages: Message[] = [], activeMessages: Message[] = [], tailIds = new Set<string>(), heldReplayIds = new Set<string>();
  let replayFloor: ReplayFloor;
  let replayableMessages: Message[] = [], replayedMessages: Message[] = [];
  let window = args.windowStart ?? REPLAY_LINES_START;
  const exactWindows: boolean[] = [];
  for (; ; window *= 2) {
    // MUTANT:no-head-slot
    const branchTail = store.activeTextLines(threadId, window - headSlot);
    replayMore = branchTail.hasMore;
    exactWindows.push(branchTail.exact === true);
    branchMessages = botMessages(database(), botViewer(botId), threadId, branchTail.messages);
    activeMessages = promptRows(branchMessages, routeHasTools, externalUpdates);
    const activeReplayIds = new Set(activeMessages.map(row => row.id));
    heldReplayIds = new Set(branchMessages.filter(row => !activeReplayIds.has(row.id)).map(row => row.id));
    tailIds = new Set(branchTail.messages.map(row => row.id));
    // With memory not active (capture only, paused or off) the replay still follows the content rule a room follows (0.1.61 T2 R3-7):
    // a reply made with memory the owner has since forgotten or changed, and a copy of one, reads as its withheld line (or is left out
    // for a turn that is not the owner's) instead of coming back raw. A thread that never used memory is read as it is (undefined).
    replayFloor = floor ? floor(activeMessages) : undefined;
    // Kept as messages, not just role/text: the external-delivery accounting needs to know WHICH ids a branch replay would actually
    // carry, and this filter (settled text only, the budget's window) is what decides that.
    replayableMessages = (projectCardRun ? [] : (replayFloor?.messages ?? activeMessages))
      .filter((m) => m.kind === "text" && m.text && !skip.has(m.id) && !heldReplayIds.has(m.id));
    replayedMessages = replayWindow(replayableMessages, replayOptions);
    // the replay's window ends inside what was read (an older line could not enter), or the branch has no older line
    if (!replayMore || replayedMessages.length < replayableMessages.length) break;
  }
  const finalSkip = new Set(skip);
  for (const id of heldReplayIds) finalSkip.add(id);
  return { window, exact: exactWindows.every(Boolean), exactWindows, replayMore, branchMessages, activeMessages, tailIds, heldReplayIds, replayFloor, replayableMessages, replayedMessages, skip: finalSkip };
}
