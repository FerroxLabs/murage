// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recently opened conversations, kept in the renderer so switching back to
// one paints at once (store.tsx `switchTask`). Bounded twice: by how many
// conversations it holds and by their size, the least recently opened going
// first.
//
// A cached page is a picture of the past, so it is kept true in two ways:
// - Live frames for a cached thread patch it the moment they arrive: an edit,
//   a message withheld or forgotten, a card answered. A frame that moves the
//   branch (an edit that forks, a rewind) or deletes the thread drops it.
// - Opening it always reconciles with the server, by the changes since the
//   version the page was read at (GET/POST `since=`), whatever the frames did.
//
// Loaded on first use (conversation-cache-host.ts), so the first paint does
// not carry it.
import type { Message } from "@/state/store";
import { applyThreadDelta } from "./conversation-cache-host";

export const CACHE_MAX_ENTRIES = 12;
export const CACHE_MAX_BYTES = 12 * 1024 * 1024;

export interface CachedConversation {
  ownerId: string;
  threadId: string;
  messages: Message[];
  hasMore?: boolean;
  olderFrom?: string;
  activeLeafId?: string | null;
  openCards?: Message[];
  openCardsLeaf?: string;
  /** The server's thread version the page was read at (`since=` answers from it). */
  version?: string;
}

interface Entry extends CachedConversation {
  bytes: number;
}

/** What a message costs to hold, roughly: its text twice over (UTF-16), any
 * inline image, and a fixed share for the rest of the record. */
export function messageBytes(message: Message): number {
  let bytes = 256 + 2 * (message.text?.length ?? 0);
  if (message.png) bytes += message.png.length;
  if (message.card) bytes += 512;
  return bytes;
}

function entryBytes(entry: CachedConversation): number {
  let bytes = 0;
  for (const message of entry.messages) bytes += messageBytes(message);
  for (const message of entry.openCards ?? []) bytes += messageBytes(message);
  return bytes;
}

/** A live frame as store.tsx receives it. */
export interface ThreadFrame {
  kind: string;
  threadId?: string;
  message?: Message;
}

/** The changes since a version: messages to lay over the page, the branch
 * head now, and the version they bring it to. */
export interface ThreadDelta {
  messages: Message[];
  activeLeafId?: string | null;
  version?: string;
}

export class ConversationCache {
  private readonly entries = new Map<string, Entry>();
  private total = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }

  /** The entry for a thread, now the most recently used. */
  get(threadId: string): CachedConversation | undefined {
    const entry = this.entries.get(threadId);
    if (!entry) return undefined;
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    return entry;
  }

  peek(threadId: string): CachedConversation | undefined {
    return this.entries.get(threadId);
  }

  put(conversation: CachedConversation): void {
    this.drop(conversation.threadId);
    const entry: Entry = { ...conversation, bytes: entryBytes(conversation) };
    // One conversation bigger than the whole budget is not kept at all.
    if (entry.bytes > this.maxBytes) return;
    this.entries.set(entry.threadId, entry);
    this.total += entry.bytes;
    for (const [threadId] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxBytes) break;
      this.drop(threadId);
    }
  }

  drop(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.entries.delete(threadId);
    this.total -= entry.bytes;
  }

  dropOwner(ownerId: string): void {
    const owned: string[] = [];
    for (const entry of this.entries.values()) if (entry.ownerId === ownerId) owned.push(entry.threadId);
    for (const threadId of owned) this.drop(threadId);
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  /** Lay a server delta over a held entry (the reconcile on open, a prefetch). */
  applyDelta(threadId: string, delta: ThreadDelta): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const next = applyThreadDelta(entry, delta.messages);
    this.replace({
      ...next,
      activeLeafId: delta.activeLeafId === undefined ? entry.activeLeafId : delta.activeLeafId,
      version: delta.version ?? entry.version,
    });
  }

  /** A live frame: patch what it changed in a held page, or drop a page it
   * makes untrustworthy. Frames for threads not held are ignored. */
  applyFrame(frame: ThreadFrame): void {
    const threadId = frame.threadId;
    if (!threadId) return;
    const entry = this.entries.get(threadId);
    if (!entry) return;
    switch (frame.kind) {
      case "message.patch": {
        const message = frame.message;
        if (!message) return this.drop(threadId);
        if (!entry.messages.some((m) => m.id === message.id) && !entry.openCards?.some((m) => m.id === message.id)) return;
        this.replace({
          ...entry,
          messages: entry.messages.map((m) => (m.id === message.id ? message : m)),
          openCards: entry.openCards?.map((m) => (m.id === message.id ? message : m)),
        });
        return;
      }
      case "message": {
        const message = frame.message;
        if (!message) return this.drop(threadId);
        if (entry.messages.some((m) => m.id === message.id)) return;
        // Every append chains onto the head and becomes it; a late artifact
        // parented elsewhere joins without moving the head (store.tsx messageAdded).
        const adopts = (message.parentId ?? null) === (entry.activeLeafId ?? null);
        this.replace({ ...entry, messages: [...entry.messages, message], activeLeafId: adopts ? message.id : entry.activeLeafId });
        return;
      }
      // The branch moved (an edit that forks, a rewind) or the thread went:
      // the held page may show rows that are no longer the conversation.
      case "thread":
      case "thread.deleted":
        this.drop(threadId);
        return;
      default:
        return;
    }
  }

  private replace(conversation: CachedConversation): void {
    const entry = this.entries.get(conversation.threadId);
    if (!entry) return;
    const bytes = entryBytes(conversation);
    this.total += bytes - entry.bytes;
    this.entries.set(conversation.threadId, { ...conversation, bytes });
    if (this.total > this.maxBytes) {
      for (const [threadId] of this.entries) {
        if (this.total <= this.maxBytes) break;
        this.drop(threadId);
      }
    }
  }
}

export type PageRequest = (path: string, init?: RequestInit) => Promise<any>;

/** The newest page of a thread, as a switch would open it, into the cache:
 * the changes since the held version when one is held, else the page. A
 * prefetch; `signal` cancels it. */
export async function prefetchConversation(
  cache: ConversationCache,
  request: PageRequest,
  target: { ownerId: string; threadId: string; pageSize: number },
  signal: AbortSignal,
): Promise<void> {
  const { ownerId, threadId, pageSize } = target;
  const held = cache.peek(threadId);
  const since = held?.version ? `&since=${encodeURIComponent(held.version)}` : "";
  const page = await request(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=${pageSize}&view=switch${since}`, { signal });
  if (signal.aborted || !page || !Array.isArray(page.messages)) return;
  if (page.delta === true) {
    cache.applyDelta(threadId, { messages: page.messages, activeLeafId: page.activeLeafId, version: page.version });
    return;
  }
  cache.put({
    ownerId,
    threadId,
    messages: page.messages,
    hasMore: page.hasMore,
    olderFrom: page.olderFrom,
    activeLeafId: page.activeLeafId,
    openCards: page.openCards,
    openCardsLeaf: page.openCardsLeaf,
    version: page.version,
  });
}
