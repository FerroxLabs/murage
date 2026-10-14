import { describe, expect, it, vi } from "vitest";

import { ConversationCache, messageBytes, prefetchConversation, type CachedConversation } from "./conversation-cache";
import { applyThreadDelta } from "./conversation-cache-host";
import type { Message } from "@/state/store";

const msg = (id: string, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: "bot", kind: "text", text, at: 1, ...extra }) as Message;
const page = (threadId: string, n = 3, ownerId = "bot-1"): CachedConversation => {
  const messages = Array.from({ length: n }, (_, i) => msg(`${threadId}-${i}`, `${threadId} message ${i}`, { parentId: i ? `${threadId}-${i - 1}` : null } as Partial<Message>));
  return { ownerId, threadId, messages, hasMore: false, activeLeafId: messages.at(-1)?.id ?? null, version: "e1.10" };
};
const textOf = (cache: ConversationCache, threadId: string, id: string) => cache.peek(threadId)?.messages.find((m) => m.id === id)?.text;

describe("ConversationCache bounds", () => {
  it("keeps the most recently opened conversations, up to its count", () => {
    const cache = new ConversationCache(3, 10_000_000);
    for (const id of ["a", "b", "c"]) cache.put(page(id));
    cache.get("a"); // a is now the most recent
    cache.put(page("d"));
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("a")).toBeDefined();
    expect(cache.size).toBe(3);
  });

  it("keeps its size under the byte budget, dropping the least recent first", () => {
    const one = messageBytes(msg("x", "y".repeat(1_000)));
    const cache = new ConversationCache(50, one * 25);
    const big = (id: string): CachedConversation => ({ ...page(id, 0), messages: Array.from({ length: 10 }, (_, i) => msg(`${id}${i}`, "y".repeat(1_000))) });
    cache.put(big("a"));
    cache.put(big("b"));
    cache.put(big("c"));
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(one * 25);
    // one conversation larger than the whole budget is not kept
    cache.put({ ...page("huge", 0), messages: Array.from({ length: 40 }, (_, i) => msg(`h${i}`, "y".repeat(1_000))) });
    expect(cache.peek("huge")).toBeUndefined();
  });
});

describe("a cached page never shows what its events changed", () => {
  it("an edited message is replaced in place", () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    cache.applyFrame({ kind: "message.patch", threadId: "t", message: msg("t-1", "the edited text") });
    expect(textOf(cache, "t", "t-1")).toBe("the edited text");
  });

  it("a withheld or forgotten message carries its new state", () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    cache.applyFrame({ kind: "message.patch", threadId: "t", message: msg("t-0", "t message 0", { withheldFromBots: "forgotten" } as Partial<Message>) });
    expect(cache.peek("t")?.messages[0]).toMatchObject({ withheldFromBots: "forgotten" });
    cache.applyFrame({ kind: "message.patch", threadId: "t", message: msg("t-2", "t message 2", { withheldFromBots: true } as Partial<Message>) });
    expect(cache.peek("t")?.messages[2]).toMatchObject({ withheldFromBots: true });
  });

  it("an open card held beside the page is patched too", () => {
    const cache = new ConversationCache();
    cache.put({ ...page("t"), openCards: [msg("card", "Allow?", { kind: "options" } as Partial<Message>)] });
    cache.applyFrame({ kind: "message.patch", threadId: "t", message: msg("card", "Allowed", { kind: "options" } as Partial<Message>) });
    expect(cache.peek("t")?.openCards?.[0]?.text).toBe("Allowed");
  });

  it("a branch move (an edit that forks, a rewind) or a deleted thread drops the page", () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    cache.put(page("u"));
    cache.applyFrame({ kind: "thread", threadId: "t" });
    expect(cache.peek("t")).toBeUndefined();
    cache.applyFrame({ kind: "thread.deleted", threadId: "u" });
    expect(cache.peek("u")).toBeUndefined();
  });

  it("a deleted bot takes its pages with it, and a fresh snapshot clears everything", () => {
    const cache = new ConversationCache();
    cache.put(page("t", 3, "bot-1"));
    cache.put(page("u", 3, "bot-2"));
    cache.dropOwner("bot-1");
    expect(cache.peek("t")).toBeUndefined();
    expect(cache.peek("u")).toBeDefined();
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("a new message joins the page and becomes its head; frames for other threads change nothing", () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    cache.applyFrame({ kind: "message", threadId: "t", message: msg("t-3", "new", { parentId: "t-2" } as Partial<Message>) });
    expect(cache.peek("t")?.messages.at(-1)?.id).toBe("t-3");
    expect(cache.peek("t")?.activeLeafId).toBe("t-3");
    const before = cache.peek("t");
    cache.applyFrame({ kind: "message.patch", threadId: "other", message: msg("t-0", "not this one") });
    expect(cache.peek("t")).toBe(before);
  });

  it("the reconcile delta lays the server's versions over the page", () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    cache.applyDelta("t", { messages: [msg("t-1", "server text"), msg("t-3", "written since")], activeLeafId: "t-3", version: "e1.20" });
    const held = cache.peek("t")!;
    expect(held.messages.map((m) => m.text)).toEqual(["t message 0", "server text", "t message 2", "written since"]);
    expect(held.activeLeafId).toBe("t-3");
    expect(held.version).toBe("e1.20");
  });
});

describe("applyThreadDelta", () => {
  it("returns the same page when nothing changed", () => {
    const held = page("t");
    expect(applyThreadDelta(held, [])).toBe(held);
  });
});

describe("prefetchConversation", () => {
  it("stores the page a switch would open, with its version", async () => {
    const cache = new ConversationCache();
    const request = vi.fn(async () => ({ messages: [msg("p-0", "hello")], hasMore: true, activeLeafId: "p-0", version: "e1.5", openCards: [msg("c", "card")] }));
    await prefetchConversation(cache, request, { ownerId: "bot-1", threadId: "p", pageSize: 100 }, new AbortController().signal);
    expect(request).toHaveBeenCalledWith("/api/threads/p/messages?limit=100&view=switch", expect.anything());
    expect(cache.peek("p")).toMatchObject({ ownerId: "bot-1", hasMore: true, version: "e1.5", activeLeafId: "p-0" });
    expect(cache.peek("p")?.openCards).toHaveLength(1);
  });

  it("asks only for what changed when it already holds the page", async () => {
    const cache = new ConversationCache();
    cache.put(page("t"));
    const request = vi.fn(async () => ({ delta: true, messages: [msg("t-0", "changed")], activeLeafId: "t-2", version: "e1.11" }));
    await prefetchConversation(cache, request, { ownerId: "bot-1", threadId: "t", pageSize: 100 }, new AbortController().signal);
    expect(request).toHaveBeenCalledWith("/api/threads/t/messages?limit=100&view=switch&since=e1.10", expect.anything());
    expect(textOf(cache, "t", "t-0")).toBe("changed");
    expect(cache.peek("t")?.version).toBe("e1.11");
  });

  it("keeps nothing from a request that was cancelled", async () => {
    const cache = new ConversationCache();
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return { messages: [msg("p-0", "late")], version: "e1.5" };
    });
    await prefetchConversation(cache, request, { ownerId: "bot-1", threadId: "p", pageSize: 100 }, controller.signal);
    expect(cache.peek("p")).toBeUndefined();
  });
});
