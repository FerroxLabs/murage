import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { conversationCache, loadConversationCache, PREFETCH_INTENT_MS, startConversationPrefetch } from "./conversation-cache-host";

const target = { ownerId: "bot-1", threadId: "t-hover", pageSize: 100 };
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("hover prefetch", () => {
  beforeEach(async () => {
    await loadConversationCache();
    conversationCache()?.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("is never sent when the pointer leaves before it rests", async () => {
    const request = vi.fn(async () => ({ messages: [], version: "e.1" }));
    const cancel = startConversationPrefetch(request, target);
    await vi.advanceTimersByTimeAsync(PREFETCH_INTENT_MS - 10);
    cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).not.toHaveBeenCalled();
    expect(conversationCache()?.peek("t-hover")).toBeUndefined();
  });

  it("aborts the request on the wire when the pointer leaves, and keeps nothing", async () => {
    let signal: AbortSignal | undefined;
    let answer: (value: unknown) => void = () => {};
    const request = vi.fn((_path: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((resolve) => (answer = resolve));
    });
    const cancel = startConversationPrefetch(request, target);
    await vi.advanceTimersByTimeAsync(PREFETCH_INTENT_MS + 1);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);
    cancel();
    expect(signal?.aborted).toBe(true);
    answer({ messages: [{ id: "m", role: "bot", kind: "text", text: "late", at: 1 }], version: "e.2" });
    await flush();
    expect(conversationCache()?.peek("t-hover")).toBeUndefined();
  });

  it("fills the cache when the pointer rests", async () => {
    const request = vi.fn(async () => ({ messages: [{ id: "m", role: "bot", kind: "text", text: "hi", at: 1 }], hasMore: false, activeLeafId: "m", version: "e.3" }));
    startConversationPrefetch(request, target);
    await vi.advanceTimersByTimeAsync(PREFETCH_INTENT_MS + 1);
    await vi.waitFor(() => expect(conversationCache()?.peek("t-hover")).toMatchObject({ ownerId: "bot-1", version: "e.3" }));
  });
});
