// @vitest-environment jsdom
// SEAN-REPORTED 1.0.23: the only item in Needs you was a bot's suggestion. He approved it, the page said
// "Nothing is waiting on you right now" (0 everywhere) and the sidebar badge still said 1. The page and the badge read
// the same /api/inbox answer; the badge's hook only re-read on the server's `inbox.changed` frame, the slow poll or a
// window focus, and answering a suggestion (a lesson row, no message) sent none of them. Every resolve must refresh both.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";
import { usePendingApprovals } from "./usePendingApprovals";

const mocks = vi.hoisted(() => ({ owed: 1, memory: false, reads: [] as string[], writes: [] as string[] }));
vi.mock("@/state/store", () => ({
  useStoreIfAny: () => undefined,
  api: vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST" && path === "/api/memory/action") {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { action?: string };
      if (body.action === "waiting-list") return { items: [{ id: "m1", version: 1, group: "everyday" }] };
      mocks.writes.push(path); mocks.owed = 0;
      return { kept: 1, results: [{ id: "m1", status: "kept", version: 1 }], summary: { subjects: [], total: 0, later: 0 } };
    }
    if (init?.method === "POST") { if (!path.startsWith("/api/inbox")) { mocks.writes.push(path); mocks.owed = 0; } return { ok: true }; }
    if (!path.startsWith("/api/inbox")) return {};
    mocks.reads.push(path);
    const suggestion = { botId: "dax", botName: "Dax", lessonId: "lesson-1", version: 1, text: "Reply in short sentences", at: 1, kind: "lesson", lessonKind: "note" };
    return { items: [], total: 0, page: 0, pageSize: 25, unread: 0, approvals: 0, questions: 0, connections: 0, decisions: mocks.owed,
      ...(mocks.owed && !mocks.memory ? { learningSuggestions: [suggestion] } : {}),
      ...(mocks.owed && mocks.memory ? { memoryWaiting: [{ kind: "bot", id: "dax", name: "Dax", waiting: 1, everyday: 1 }] } : {}) };
  }),
}));

let root: Root, host: HTMLDivElement;
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
function Both() {
  const badge = usePendingApprovals(true, true);
  return createElement("div", null,
    createElement("span", { "data-testid": "badge" }, String(badge.decisions ?? "?")),
    createElement(Inbox, { onOpen: () => {}, onClose: () => {}, door: true } as never));
}
const badge = () => document.querySelector("[data-testid=badge]")!.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.owed = 1; mocks.memory = false; mocks.reads.length = 0; mocks.writes.length = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("answering the only Needs you item", () => {
  it("drops the sidebar badge to 0 with the page, without waiting for a frame, a poll or a focus", async () => {
    await act(async () => root.render(createElement(Both)));
    await settle();
    expect(badge()).toBe("1");
    const find = () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Apply");
    for (let tries = 0; tries < 50 && !find(); tries++) await settle();
    const apply = find();
    expect(apply, "the suggestion row offers an answer").toBeTruthy();
    await act(async () => { apply!.click(); });
    await settle();
    expect(mocks.writes.length).toBe(1);
    expect(badge()).toBe("0");
  });

  it("does the same when the only item is a memory Dax would like to keep (Keep all)", async () => {
    mocks.memory = true;
    await act(async () => root.render(createElement(Both)));
    await settle();
    expect(badge()).toBe("1");
    const find = () => [...document.querySelectorAll("button")].find(button => /^Keep all/.test(button.textContent?.trim() ?? ""));
    for (let tries = 0; tries < 50 && !find(); tries++) await settle();
    const keep = find();
    expect(keep, "the memory card offers Keep all").toBeTruthy();
    await act(async () => { keep!.click(); });
    await settle();
    expect(mocks.writes.length).toBe(1);
    expect(badge()).toBe("0");
  });
});
