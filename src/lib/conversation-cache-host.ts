// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first-paint side of the conversation cache: a handle to it once its
// chunk has loaded (conversation-cache.ts), the hover prefetch, and the
// one piece the store's reducer needs synchronously (laying a delta over a
// page). Until the chunk loads nothing has been cached, so there is nothing
// to miss.
import type { ConversationCache, PageRequest } from "./conversation-cache";
import type { Message } from "@/state/store";

let cache: ConversationCache | null = null;
let loading: Promise<ConversationCache | null> | null = null;

/** The cache, or null while its chunk is still loading. */
export function conversationCache(): ConversationCache | null {
  return cache;
}

export function loadConversationCache(): Promise<ConversationCache | null> {
  loading ??= import("./conversation-cache").then(
    (module) => (cache ??= new module.ConversationCache()),
    () => {
      loading = null;
      return null;
    },
  );
  return loading;
}

/** How long a pointer or focus rests on a row before its page is fetched. */
export const PREFETCH_INTENT_MS = 90;

/** Prefetch a conversation's first page once the pointer or focus has rested
 * on its row; the returned function cancels it (the pointer left, focus
 * moved on), whether it is still waiting or already on the wire. */
export function startConversationPrefetch(
  request: PageRequest,
  target: { ownerId: string; threadId: string; pageSize: number },
  delayMs = PREFETCH_INTENT_MS,
): () => void {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void loadConversationCache()
      .then(async (held) => {
        if (!held || controller.signal.aborted) return;
        const { prefetchConversation } = await import("./conversation-cache");
        await prefetchConversation(held, request, target, controller.signal);
      })
      // A prefetch that does not land costs nothing: opening the row fetches.
      .catch(() => {});
  }, delayMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/** Lay changed messages over a page: a held one is replaced where it sits, a
 * new one joins the end (the server sends them in the order written). Open
 * cards held beside the page are replaced in place. */
export function applyThreadDelta<T extends { messages: Message[]; openCards?: Message[] }>(page: T, changed: readonly Message[]): T {
  if (!changed.length) return page;
  const byId = new Map(changed.map((message) => [message.id, message]));
  const held = new Set(page.messages.map((message) => message.id));
  const beside = new Set(page.openCards?.map((message) => message.id));
  const messages = page.messages.map((message) => byId.get(message.id) ?? message);
  for (const message of changed) if (!held.has(message.id) && !beside.has(message.id)) messages.push(message);
  const openCards = page.openCards?.map((message) => byId.get(message.id) ?? message);
  return { ...page, messages, ...(openCards ? { openCards } : {}) };
}
