// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page of a transcript a frame or a listing carries, in the shape the
// asking client takes (lane E, 1.0.2).
import type { IncomingHttpHeaders } from "node:http";

import type { Message, Store } from "./store.ts";
import { CARDS_BESIDE_HEADER, CARDS_BESIDE_QUERY, CARDS_BESIDE_VALUE } from "./task-delta.ts";

/** A screen message without its pixels. The client fetches those from
 * `/api/threads/:threadId/messages/:id/image` when it actually shows one.
 * Not exported: every row leaves through wireThread. */
function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, mime: _mime, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** How much of a bot's description the roster carries (code points): what the sidebar, the chat intro (180) and the library's detail line
 * show. A bot whose description is longer is marked `descriptionCut`, and the settings panel reads the whole text from GET /api/bots/:id
 * before it can be edited. The owner's 43 descriptions were 41 KB of the boot page; the cut copies are 7 KB. Rows are never cut: the roster
 * carries a sidebar line instead of rows (shared/sidebar-line.ts), and every page of rows is whole. */
export const ROSTER_DESCRIPTION_CHARS = 240;

/** What the delivery gate asks of the store: one probe, the newest number, one row's number. */
export type SeqStore = Pick<Store, "threadNumbered" | "newestSeq" | "messageSeq">;
export type TranscriptStore = Pick<Store, "messagePage" | "newestPageSpan" | "branchHeadSpan" | "branchPage" | "openCardsOutside"> & Partial<Pick<Store, "openCardsOutsideStatus">> & SeqStore;

type Row = Message | Record<string, unknown>;
type Gated<B> = Omit<B, "newestSeq"> & { newestSeq?: number };

/** THE one exit for a thread's rows (ROOM-ORDER-DESIGN r8 R8): a page, a window, a delta, a frame, a POST answer. Takes the body that
 * carries the rows (`message`, `messages`, `openCards`, anything else passed through), probes `numbered(threadId)` ONCE, maps every row
 * (through slimMessage unless `slim: false`, the shape frames and answers always had) and then:
 * - a pending (not yet numbered) thread, or `legacy` (a branch page, in parent-link order): `seq` is removed from every row and the
 *   envelope carries no `newestSeq`;
 * - a numbered thread: every row carries `seq` (a missing stamp is read from the column) and the envelope carries
 *   `newestSeq` = the server's MAX(seq) now (0 for an empty thread).
 * The rows and the cache are never changed: the gate shapes copies. Read, probed and gated in one synchronous step, so no delivery
 * straddles the walk's flip of the thread. */
export function wireThread<B extends { message?: unknown; messages?: readonly unknown[]; openCards?: readonly unknown[] }>(store: SeqStore, threadId: string, body: B, options: { slim?: boolean; legacy?: boolean } = {}): Gated<B> {
  const numbered = !options.legacy && store.threadNumbered(threadId);
  const slim = options.slim !== false;
  const wire = (row: unknown): unknown => {
    if (!row || typeof row !== "object") return row;
    const shaped = (slim ? slimMessage(row as Message) : row) as Row;
    const { seq, ...rest } = shaped as Record<string, unknown>;
    if (!numbered) return rest;
    const number = typeof seq === "number" ? seq : typeof rest.id === "string" ? store.messageSeq(threadId, rest.id) : null;
    return number === null ? rest : { ...rest, seq: number };
  };
  const { newestSeq: _stale, ...out } = body as B & { newestSeq?: unknown };
  const gated = out as Record<string, unknown>;
  if (body.message !== undefined) gated.message = wire(body.message);
  if (Array.isArray(body.messages)) gated.messages = body.messages.map(wire);
  if (Array.isArray(body.openCards)) gated.openCards = body.openCards.map(wire);
  if (numbered) gated.newestSeq = store.newestSeq(threadId) ?? 0;
  return gated as Gated<B>;
}

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
export function transcriptPage(store: TranscriptStore, threadId: string, limit: number, beside: boolean): { messages: Message[]; hasMore: boolean; activeLeafId: string | null; olderFrom?: string | null; branch?: true } {
  // Every client's page stops at BRANCH_HEAD_PAGE_CAP rows past `limit`: one stale open card (or a head) 10,000 rows back must not make a phone page
  // 10,000 rows. A card or head older than that is reached by paging back (`before`), which is how a client without cards-beside already scrolls.
  if (!beside) return store.messagePage(threadId, limit > 0 ? Math.max(limit, Math.min(store.newestPageSpan(threadId), BRANCH_HEAD_PAGE_CAP)) : limit)!;
  const span = limit > 0 ? store.branchHeadSpan(threadId) : 0;
  // a branch page is in parent-link order, not number order: it goes out legacy (wirePage)
  return span > BRANCH_HEAD_PAGE_CAP ? { ...store.branchPage(threadId, limit)!, branch: true } : store.messagePage(threadId, Math.max(limit, span))!;
}

/** The farthest a newest page stretches back for the branch head. */
const BRANCH_HEAD_PAGE_CAP = 500;

/** The rows of a page as sent, with the cards beside it and the cursor to page
 * back by when the page is a branch page. */
export function wirePage(store: TranscriptStore, threadId: string, page: ReturnType<typeof transcriptPage>, beside: boolean, bound = false) {
  return wireThread(store, threadId, {
    messages: page.messages as Message[],
    ...(beside ? pageOpenCards(store, threadId, page.messages) : {}),
    // The branch head the cards were worked out for: a conversation that
    // branches binds them to it (a room does not branch).
    ...(beside && bound && page.activeLeafId ? { openCardsLeaf: page.activeLeafId } : {}),
    ...(beside && page.olderFrom ? { olderFrom: page.olderFrom } : {}),
    hasMore: page.hasMore,
  }, page.branch ? { legacy: true } : {});
}

/** `openCards` for a frame, left out when the page already holds every open card. */
function pageOpenCards(store: TranscriptStore, threadId: string, page: readonly { id?: unknown }[]): { openCards?: Message[]; openCardsPending?: true } {
  const { cards, pending } = store.openCardsOutsideStatus ? store.openCardsOutsideStatus(threadId, page) : { cards: store.openCardsOutside(threadId, page), pending: false };
  // `openCardsPending`: the upgrade has not indexed this thread yet, so older open cards may be missing; a client keeps the cards it holds and asks again when told.
  return { ...(cards.length ? { openCards: cards } : {}), ...(pending ? { openCardsPending: true as const } : {}) };
}

