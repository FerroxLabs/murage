// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page of a transcript a frame or a listing carries, in the shape the
// asking client takes (lane E, 1.0.2).
import type { IncomingHttpHeaders } from "node:http";

import type { Message, Store } from "./store.ts";
import { CARDS_BESIDE_HEADER, CARDS_BESIDE_QUERY, CARDS_BESIDE_VALUE } from "./task-delta.ts";

/** A screen message without its pixels. The client fetches those from
 * `/api/threads/:threadId/messages/:id/image` when it actually shows one. */
export function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, mime: _mime, ...rest } = message;
  return { ...rest, hasImage: true };
}

export type TranscriptStore = Pick<Store, "messagePage" | "newestPageSpan" | "branchHeadSpan" | "branchPage" | "openCardsOutside"> & Partial<Pick<Store, "openCardsOutsideStatus">>;

/** Whether a request or stream takes open request cards beside its page
 * (`openCards`, `olderFrom`). The 1.0.2 renderer says so (header on every call,
 * query on the event stream), the way it asks for task deltas; an older
 * renderer, the phone and the companion say nothing and are sent the page they
 * always were, with every open card inside it. */
export function takesCardsBeside(headers: IncomingHttpHeaders, query: URLSearchParams): boolean {
  return headers[CARDS_BESIDE_HEADER] === CARDS_BESIDE_VALUE || query.get(CARDS_BESIDE_QUERY) === CARDS_BESIDE_VALUE;
}

/** The page a client opens a thread on. A client that takes cards beside its
 * page gets at least `limit` of the newest rows, reaching back far enough to
 * hold the active branch head (up to BRANCH_HEAD_PAGE_CAP rows); a head further
 * back than that (another fork grew past it) gets the head's own branch, read by
 * parent links (Store.branchPage): the client renders the SELECTED branch from
 * what it holds, never the newest fork's rows in its place. Open request cards
 * older than the page travel beside it, so one old unanswered card never
 * inflates a switch. Any other client gets the page it always got: at least
 * `limit` rows and, within BRANCH_HEAD_PAGE_CAP, every open card and the branch head inside them. Zero stays
 * zero: that caller asked for settings, not a transcript. Either way a page
 * is at most max(limit, BRANCH_HEAD_PAGE_CAP) rows. */
export function transcriptPage(store: TranscriptStore, threadId: string, limit: number, beside: boolean): { messages: Message[]; hasMore: boolean; activeLeafId: string | null; olderFrom?: string | null } {
  // Every client's page stops at BRANCH_HEAD_PAGE_CAP rows past `limit`: one stale open card (or a head) 10,000 rows back must not make a phone page
  // 10,000 rows. A card or head older than that is reached by paging back (`before`), which is how a client without cards-beside already scrolls.
  if (!beside) return store.messagePage(threadId, limit > 0 ? Math.max(limit, Math.min(store.newestPageSpan(threadId), BRANCH_HEAD_PAGE_CAP)) : limit)!;
  const span = limit > 0 ? store.branchHeadSpan(threadId) : 0;
  return span > BRANCH_HEAD_PAGE_CAP ? store.branchPage(threadId, limit)! : store.messagePage(threadId, Math.max(limit, span))!;
}

/** The farthest a newest page stretches back for the branch head. */
const BRANCH_HEAD_PAGE_CAP = 500;

/** The rows of a page as sent, with the cards beside it and the cursor to page
 * back by when the page is a branch page. */
export function wirePage(store: TranscriptStore, threadId: string, page: ReturnType<typeof transcriptPage>, beside: boolean, bound = false) {
  return {
    messages: page.messages.map(slimMessage),
    ...(beside ? pageOpenCards(store, threadId, page.messages) : {}),
    // The branch head the cards were worked out for: a conversation that
    // branches binds them to it (a room does not branch).
    ...(beside && bound && page.activeLeafId ? { openCardsLeaf: page.activeLeafId } : {}),
    ...(beside && page.olderFrom ? { olderFrom: page.olderFrom } : {}),
    hasMore: page.hasMore,
  };
}

/** `openCards` for a frame, left out when the page already holds every open card. */
function pageOpenCards(store: TranscriptStore, threadId: string, page: readonly { id?: unknown }[]): { openCards?: Message[]; openCardsPending?: true } {
  const { cards, pending } = store.openCardsOutsideStatus ? store.openCardsOutsideStatus(threadId, page) : { cards: store.openCardsOutside(threadId, page), pending: false };
  // `openCardsPending`: the upgrade has not indexed this thread yet, so older open cards may be missing; a client keeps the cards it holds and asks again when told.
  return { ...(cards.length ? { openCards: cards.map(slimMessage) as Message[] } : {}), ...(pending ? { openCardsPending: true as const } : {}) };
}

