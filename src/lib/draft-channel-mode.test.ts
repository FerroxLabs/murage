import { afterEach, expect, it, vi } from "vitest";
import { getDraftChannelMode, setDraftChannelMode, markDraftEdited, draftRevision, recoverFailedComposerSend, failedComposerSends, restoredSendId } from "./drafts";

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => vi.unstubAllGlobals());

it("keeps task modes separate and drops the stored mode after a successful send reset", () => {
  const store = storage();
  setDraftChannelMode(store, "A", "goal");
  expect(getDraftChannelMode(store, "B")).toBe("chat");
  expect(getDraftChannelMode(store, "A")).toBe("goal");
  expect(JSON.parse(store.getItem("murage-draft-channel-modes")!)).toEqual({ A: "goal" });
  setDraftChannelMode(store, "A", "chat");
  expect(JSON.parse(store.getItem("murage-draft-channel-modes")!)).toEqual({});
});

it.each([null, "{", "[]", '{"A":"invalid"}'])("legacy or invalid storage remains ordinary chat: %s", raw => {
  const store = storage(raw === null ? {} : { "murage-draft-channel-modes": raw });
  expect(getDraftChannelMode(store, "A")).toBe("chat");
});

it("loads a saved goal and isolates separate storage origins", () => {
  const first = storage({ "murage-draft-channel-modes": '{"A":"goal"}' });
  expect(getDraftChannelMode(first, "A")).toBe("goal");
  expect(getDraftChannelMode(storage(), "A")).toBe("chat");
});

it("retains goal intent in memory if read/write access to storage is denied", () => {
  const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
  expect(getDraftChannelMode(denied, "A")).toBe("chat");
  setDraftChannelMode(denied, "A", "goal");
  expect(getDraftChannelMode(denied, "A")).toBe("goal");
  setDraftChannelMode(denied, "A", "chat");
  expect(getDraftChannelMode(denied, "A")).toBe("chat");
});

it("failed send restores goal mode and its exact receipt when the task is unmounted", () => {
  const store = storage();
  vi.stubGlobal("localStorage", store);
  const id = "restore-goal";
  markDraftEdited(id);
  const sent = { draftId: id, revision: draftRevision(id), sendId: "goal-send-original", text: "Do the goal", requestText: "Do the goal", threadId: "thread-A", channelMode: "goal" as const, attachments: [] };
  setDraftChannelMode(store, id, "chat");
  expect(recoverFailedComposerSend(sent)).toBe("restored");
  expect(getDraftChannelMode(store, id)).toBe("goal");
  expect(restoredSendId(id)).toBe(sent.sendId);
});

it("late failure cannot overwrite newer chat intent and keeps the goal in the failed-send item", () => {
  const store = storage();
  vi.stubGlobal("localStorage", store);
  const id = "newer-mode";
  const sent = { draftId: id, revision: draftRevision(id), sendId: "old-goal-id", text: "Old goal", requestText: "Old goal", threadId: "thread-A", channelMode: "goal" as const, attachments: [] };
  markDraftEdited(id);
  setDraftChannelMode(store, id, "chat");
  expect(recoverFailedComposerSend(sent)).toBe("outbox");
  expect(getDraftChannelMode(store, id)).toBe("chat");
  expect(failedComposerSends(id).at(-1)).toMatchObject({ sendId: sent.sendId, channelMode: "goal" });
});
