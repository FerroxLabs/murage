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

/** How much of a bot's description the roster carries (code points): what the sidebar, the chat intro (180) and the library's detail line
 * show. A bot whose description is longer is marked `descriptionCut`, and the settings panel reads the whole text from GET /api/bots/:id
 * before it can be edited. The owner's 43 descriptions were 41 KB of the boot page; the cut copies are 7 KB. */
export const ROSTER_DESCRIPTION_CHARS = 240;
/** A roster row is a preview: the sidebar needs a last line and a status, not a tool's whole payload. Over this many serialized bytes a row is cut.
 * The owner's text rows run 1.9 KB in the middle (159 of 224 boot rows), so the old 2 KB bar let most of them through whole; the sidebar shows
 * one line of each. */
export const ROSTER_ROW_BYTES = 512;
/** The text of a cut row (code points): two lines or so, of which the sidebar shows one. */
export const ROSTER_TEXT_CHARS = 160;
/** Fields of any cut row that only the open thread reads: the rows it was copied from, the turn's helper list, the attachments, the engine
 * and comm stamps, held Murage state. The sidebar reads kind, text, role, from, the tool's name and outcome, and a card's title. */
const HEAVY_ROW_FIELDS = ["copyOf", "turnHelpers", "attachments", "actionCheck", "engine", "comm", "murage"] as const;
/** Fields that can carry a whole tool run or error report; a cut activity row keeps its name, outcome and one-line read, not these. */
const HEAVY_ACTIVITY_FIELDS = ["errorDetails", "removedText", "steps", "providerError", "diagnostic", "localFailure", "actionCheck"] as const;
const HEAVY_TOOL_FIELDS = new Set(["input", "output", "errorDetails", "steps", "providerError", "diagnostic", "localFailure", "imageRecord"]);

/** The row as the roster carries it: unchanged when small, else cut to a preview marked `truncated: true`. The thread, when opened, fetches the full rows
 * (the client replaces every truncated row from the newest page; src/lib/scrollback.ts). */
export function previewMessage(message: Message | Record<string, unknown>): { row: Message | Record<string, unknown>; cut: boolean } {
  if (JSON.stringify(message).length <= ROSTER_ROW_BYTES) return { row: message, cut: false };
  const row: Record<string, unknown> = { ...message };
  if (typeof row.text === "string" && row.text.length > ROSTER_TEXT_CHARS) row.text = [...(row.text as string)].slice(0, ROSTER_TEXT_CHARS).join("");
  for (const key of HEAVY_ROW_FIELDS) delete row[key];
  if (row.kind === "activity") {
    for (const key of HEAVY_ACTIVITY_FIELDS) delete row[key];
    const tool = row.tool as Record<string, unknown> | undefined;
    if (tool) row.tool = Object.fromEntries(Object.entries(tool).filter(([key]) => !HEAVY_TOOL_FIELDS.has(key)));
  }
  // a routine run row carries the run's whole summary; the sidebar reads its text
  const run = row.routineRun as Record<string, unknown> | undefined;
  if (run && typeof run === "object" && "summary" in run) row.routineRun = Object.fromEntries(Object.entries(run).filter(([key]) => key !== "summary"));
  if (JSON.stringify(row).length >= JSON.stringify(message).length) return { row: message, cut: false };
  return { row: { ...row, truncated: true }, cut: true };
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
export function wirePage(store: TranscriptStore, threadId: string, page: ReturnType<typeof transcriptPage>, beside: boolean, bound = false, preview = false) {
  const slim = page.messages.map(slimMessage);
  const rows = preview ? slim.map(previewMessage) : undefined;
  const anyCut = rows?.some(item => item.cut) ?? false;
  return {
    messages: rows ? rows.map(item => item.row) : slim,
    ...(beside ? pageOpenCards(store, threadId, page.messages) : {}),
    // The branch head the cards were worked out for: a conversation that
    // branches binds them to it (a room does not branch).
    ...(beside && bound && page.activeLeafId ? { openCardsLeaf: page.activeLeafId } : {}),
    ...(beside && page.olderFrom ? { olderFrom: page.olderFrom } : {}),
    // A cut row means the page is not the whole story: the client asks for the full newest page when the thread opens.
    hasMore: page.hasMore || anyCut,
  };
}

/** `openCards` for a frame, left out when the page already holds every open card. */
function pageOpenCards(store: TranscriptStore, threadId: string, page: readonly { id?: unknown }[]): { openCards?: Message[]; openCardsPending?: true } {
  const { cards, pending } = store.openCardsOutsideStatus ? store.openCardsOutsideStatus(threadId, page) : { cards: store.openCardsOutside(threadId, page), pending: false };
  // `openCardsPending`: the upgrade has not indexed this thread yet, so older open cards may be missing; a client keeps the cards it holds and asks again when told.
  return { ...(cards.length ? { openCards: cards.map(slimMessage) as Message[] } : {}), ...(pending ? { openCardsPending: true as const } : {}) };
}

