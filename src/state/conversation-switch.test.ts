// Switching back to a task this window opened recently: the cached page is on
// screen in the same dispatch (no request in between), and the server's
// answer to the switch reconciles it by what changed since that page.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ConversationCache } from "@/lib/conversation-cache";
import { cachedPage, cachedPaintFor, initialState, opensFromCache, reducer, visibleMessages, type AppState, type Bot, type Message } from "./store";
import { httpNow } from "./test-origins";

const msg = (id: string, parentId: string | null, text: string, extra: Partial<Message> = {}): Message =>
  ({ id, parentId, role: "bot", kind: "text", text, at: 1, ...extra }) as Message;

const pageA = [msg("a1", null, "first in A"), msg("a2", "a1", "second in A")];
const pageB = [msg("b1", null, "first in B"), msg("b2", "b1", "second in B")];
const bot = {
  id: "bot-1",
  name: "Sable",
  threadId: "thread-a",
  messages: pageA,
  activeLeafId: "a2",
  hasMore: false,
  threadVersion: "e1.5",
  tasks: [
    { threadId: "thread-a", title: "A", createdAt: 1 },
    { threadId: "thread-b", title: "B", createdAt: 2 },
  ],
} as unknown as Bot;
const start: AppState = { ...initialState, bots: [bot], selectedId: "bot-1" };
const shown = (state: AppState) => visibleMessages(state.bots[0]!).map((m) => m.text);

describe("a cached switch", () => {
  it("renders the cached page in the dispatch itself, with no request to wait on", () => {
    const cache = new ConversationCache();
    cache.put({ ownerId: "bot-1", threadId: "thread-b", messages: pageB, activeLeafId: "b2", hasMore: false, version: "e1.4" });
    const next = reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: cache.get("thread-b")! });
    expect(next.bots[0]!.threadId).toBe("thread-b");
    expect(shown(next)).toEqual(["first in B", "second in B"]);
    expect(next.bots[0]!.threadVersion).toBe("e1.4");
  });

  it("keeps what it is leaving, so switching back is instant too", () => {
    const page = cachedPage(bot);
    expect(page).toMatchObject({ ownerId: "bot-1", threadId: "thread-a", activeLeafId: "a2", version: "e1.5" });
    expect(page.messages).toBe(pageA);
  });

  it("is refused for a task the bot no longer has, or another bot's page", () => {
    const gone = { ownerId: "bot-1", threadId: "thread-x", messages: pageB };
    expect(reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: gone })).toBe(start);
    const other = { ownerId: "bot-2", threadId: "thread-b", messages: pageB };
    expect(reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: other })).toBe(start);
    // the provider asks the same question before it sends since=
    expect(opensFromCache(bot, gone)).toBe(false);
    expect(opensFromCache(bot, other)).toBe(false);
    expect(opensFromCache(bot, { ownerId: "bot-1", threadId: "thread-b", messages: pageB })).toBe(true);
  });

  it("is reconciled by the server's changes since the cached version", () => {
    const opened = reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: { ownerId: "bot-1", threadId: "thread-b", messages: pageB, activeLeafId: "b2", version: "e1.4" } });
    const reconciled = reducer(opened, {
      type: "threadDeltaApplied", ...httpNow, intent: 0,
      bot: {
        ...bot,
        threadId: "thread-b",
        threadVersion: "e1.9",
        threadDelta: { messages: [msg("b2", "b1", "second in B, edited"), msg("b3", "b2", "written while away")], activeLeafId: "b3" },
      } as never,
    });
    expect(shown(reconciled)).toEqual(["first in B", "second in B, edited", "written while away"]);
    expect(reconciled.bots[0]!.threadVersion).toBe("e1.9");
  });

  it("drops a reconcile for a page a later switch already left", () => {
    const opened = reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: { ownerId: "bot-1", threadId: "thread-b", messages: pageB } });
    const late = reducer(opened, { type: "threadDeltaApplied", ...httpNow, intent: 0, bot: { ...bot, threadId: "thread-a", threadDelta: { messages: [msg("a1", null, "nope")] } } as never });
    expect(late).toBe(opened);
  });
});

describe("a cached page never renders what its events changed", () => {
  const leaveAndChange = (frame: { kind: string; threadId: string; message?: Message }) => {
    const cache = new ConversationCache();
    cache.put(cachedPage(bot));
    cache.applyFrame(frame);
    return cache.get("thread-a");
  };
  const reopen = (entry: ReturnType<typeof leaveAndChange>) => {
    const away = { ...start, bots: [{ ...bot, threadId: "thread-b", messages: pageB, activeLeafId: "b2" }] };
    return entry ? reducer(away, { type: "conversationFromCache", botId: "bot-1", entry }) : away;
  };

  it("an edited message shows its new text", () => {
    const state = reopen(leaveAndChange({ kind: "message.patch", threadId: "thread-a", message: msg("a2", "a1", "second in A, edited") }));
    expect(shown(state)).toEqual(["first in A", "second in A, edited"]);
  });

  it("a withheld or forgotten message shows as withheld", () => {
    const state = reopen(leaveAndChange({ kind: "message.patch", threadId: "thread-a", message: msg("a1", null, "first in A", { withheldFromBots: "forgotten" } as Partial<Message>) }));
    expect(visibleMessages(state.bots[0]!)[0]).toMatchObject({ withheldFromBots: "forgotten" });
  });

  it("a branch moved by an edit or a rewind is not opened from the cache", () => {
    expect(leaveAndChange({ kind: "thread", threadId: "thread-a" })).toBeUndefined();
  });

  it("a deleted conversation is not opened from the cache", () => {
    expect(leaveAndChange({ kind: "thread.deleted", threadId: "thread-a" })).toBeUndefined();
  });
});

describe("the provider wiring", () => {
  const store = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");
  const switchCase = store.slice(store.indexOf('        case "switchTask": {'), store.indexOf('        case "pinTask":'));

  it("paints the cached page before it sends the switch, and asks only for changes since it", () => {
    expect(switchCase).toContain("cache.put(cachedPage(leaving))");
    const paint = switchCase.indexOf('rawDispatch({ type: "conversationFromCache"');
    const request = switchCase.indexOf("api(`/api/bots/${action.botId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}${since}`");
    expect(paint).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(paint);
    expect(switchCase).toContain('rawDispatch({ type: "threadDeltaApplied", ...fromAnswer(r.bot), bot: r.bot, intent })');
    expect(switchCase).toContain('dispatch({ type: "taskSwitched", ...fromAnswer(r.bot), bot: r.bot, intent })');
  });

  it("feeds every transcript frame to the cache and clears it on a fresh snapshot", () => {
    for (const kind of ['case "message": {', 'case "message.patch":', 'case "thread":']) {
      const at = store.indexOf(kind, store.indexOf("handleFrame = (frame"));
      expect(store.slice(at, at + 120)).toContain("conversationCache()?.applyFrame(frame)");
    }
    expect(store).toMatch(/conversationCache\(\)\?\.clear\(\);[\s\S]{0,200}?rawDispatch\(\{\s+type: "hydrate",\s+\.\.\.fromAnswer\(answer\)/);
  });
});

describe("a patch that lands before the delta (P2-3)", () => {
  it("is not reverted by a delta read before it", () => {
    const opened = reducer(start, { type: "conversationFromCache", botId: "bot-1", entry: { ownerId: "bot-1", threadId: "thread-b", messages: pageB, activeLeafId: "b2", version: "e1.4" } });
    const patched = reducer(opened, { type: "messagePatched", threadId: "thread-b", message: msg("b2", "b1", "second in B, withheld") });
    const reconciled = reducer(patched, {
      type: "threadDeltaApplied", ...httpNow, intent: 0,
      bot: { ...bot, threadId: "thread-b", threadVersion: "e1.9", threadDelta: { messages: [msg("b2", "b1", "second in B"), msg("b3", "b2", "written while away")], activeLeafId: "b3" } } as never,
    });
    expect(shown(reconciled)).toEqual(["first in B", "second in B, withheld", "written while away"]);
    // and the guard is spent: a later delta applies normally
    expect(reconciled.bots[0]!.patchedSinceOpen).toBeUndefined();
  });
});

describe("a cached paint waits for a live stream (P2-4)", () => {
  const cache = new ConversationCache();
  cache.put({ ownerId: "bot-1", threadId: "thread-b", messages: pageB, version: "e1.4" });
  it("paints nothing while liveness is unknown, and the cached page once live", () => {
    expect(cachedPaintFor(cache, bot, "thread-b", false)).toBeUndefined();
    expect(cachedPaintFor(cache, bot, "thread-b", true)?.threadId).toBe("thread-b");
  });
});
