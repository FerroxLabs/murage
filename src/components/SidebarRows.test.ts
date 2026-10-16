// Lane E (1.0.2 scale): the bot list does not redo work for dispatches that did not touch a row.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({
  analyticsEnabled: () => false, optAction: () => "none" as const, setAnalyticsEnabled: () => {}, initAnalytics: () => {},
  track: () => {}, identifyEmail: () => {}, emailGateDone: () => false, setEmailGateDone: () => {},
}));
(globalThis as unknown as { window?: unknown }).window ??= {};
const { BotListItem, sidebarBotPreview } = await import("./Sidebar");
import { initialState, messageVersions, reducer, visibleMessages, type Bot, type Message } from "@/state/store";
import { sidebarLineOf } from "../../shared/sidebar-line";

const message = (id: string, extra: Partial<Message> = {}) => ({ id, at: 1, role: "bot", kind: "text", text: id, ...extra }) as Message;
const bot = (id: string, messages: Message[] = [message(`${id}-m1`)], extra: Partial<Bot> = {}) =>
  ({ id, threadId: `t-${id}`, name: id, messages, ...extra }) as unknown as Bot;

describe("sidebar rows", () => {
  it("is a memoised component, compared shallowly", () => {
    const row = BotListItem as unknown as { $$typeof: symbol; compare: unknown };
    expect(row.$$typeof).toBe(Symbol.for("react.memo"));
    expect(row.compare).toBeNull();
  });

  it("an unrelated dispatch keeps every other bot's object, so its row props are unchanged", () => {
    const a = bot("a");
    const b = bot("b");
    const state = { ...initialState, bots: [a, b] };
    const next = reducer(state, { type: "markUnread", botId: "a" });
    expect(next.bots[1]).toBe(b);
    expect(next.bots[0]).not.toBe(a);
  });

  it("derives the visible path and preview once per held transcript", () => {
    const m1 = message("m1");
    const m2 = message("m2", { parentId: "m1", text: "newest" });
    const held = [m1, m2];
    const first = bot("a", held, { activeLeafId: "m2", sidebarLine: sidebarLineOf(m2) });
    expect(visibleMessages(first)).toBe(visibleMessages({ ...first, busy: true }));
    expect(sidebarBotPreview(first)).toBe("newest");
    // a busy flag changes the row text without recomputing the tail
    expect(sidebarBotPreview({ ...first, busy: true })).toBe("Working…");
    expect(sidebarBotPreview({ ...first, busy: false })).toBe("newest");
    // a new head (through the reducer, which keeps the line on it) is a new answer
    const next = reducer({ ...initialState, bots: [first] }, { type: "messageAdded", threadId: "t-a", message: message("m3", { parentId: "m2", text: "later" }) });
    expect(sidebarBotPreview(next.bots[0]!)).toBe("later");
    // an action that leaves the rows alone keeps the line object, so the row's cached text holds
    expect(reducer(next, { type: "markUnread", botId: "a" }).bots[0]!.sidebarLine).toBe(next.bots[0]!.sidebarLine);
  });

  it("answers message versions from a per-transcript index, in order, like the filter it replaced", () => {
    const parent = message("p", { role: "bot" });
    const v2 = message("v2", { role: "user", parentId: "p", at: 5 });
    const v1 = message("v1", { role: "user", parentId: "p", at: 2 });
    const other = message("o", { role: "user", parentId: "q", at: 3 });
    const b = bot("a", [parent, v2, v1, other]);
    const expected = b.messages.filter((m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === "p").sort((x, y) => x.at - y.at);
    expect(messageVersions(b, v2).map((m) => m.id)).toEqual(expected.map((m) => m.id));
    expect(messageVersions(b, other).map((m) => m.id)).toEqual(["o"]);
    expect(messageVersions(b, parent)).toEqual([parent]);
  });
});
