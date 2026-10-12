// One recovery surface per sendId: when the server holds a refused chip, the words are not also put back in the draft.
import { afterEach, expect, it, vi } from "vitest";

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async () => { vi.resetModules(); vi.stubGlobal("localStorage", storage()); return import("./drafts"); };
const sent = (drafts: typeof import("./drafts"), draftId: string, sendId: string) => ({
  draftId, revision: drafts.draftRevision(draftId), sendId, text: "words", requestText: "words", attachments: [], threadId: "t1",
});

it("a first-send failure with a refused chip for the same sendId restores nothing", async () => {
  const drafts = await load();
  drafts.noteRefusedChips(new Set(["send-chip-0000000000001"]));
  expect(drafts.recoverFailedComposerSend(sent(drafts, "bot:b:t1", "send-chip-0000000000001"))).toBe("chip");
  expect(drafts.restoredSendId("bot:b:t1")).toBeUndefined();
  expect(drafts.failedComposerSends("bot:b:t1")).toEqual([]);
});

it("a draft restored first is cleared when the chip for its sendId arrives", async () => {
  const drafts = await load();
  expect(drafts.recoverFailedComposerSend(sent(drafts, "bot:b:t1", "send-chip-0000000000002"))).toBe("restored");
  expect(drafts.restoredSendId("bot:b:t1")).toBe("send-chip-0000000000002");
  drafts.noteRefusedChips(new Set(["send-chip-0000000000002"]));
  expect(drafts.restoredSendId("bot:b:t1")).toBeUndefined();
});

it("a retry-list item for the sendId is released too, and an edited draft stays the person's", async () => {
  const drafts = await load();
  drafts.markDraftEdited("bot:b:t2"); // the person typed something newer: the failed send goes to the retry list
  expect(drafts.recoverFailedComposerSend({ ...sent(drafts, "bot:b:t2", "send-chip-0000000000003"), revision: -1 })).toBe("outbox");
  expect(drafts.failedComposerSends("bot:b:t2")).toHaveLength(1);
  drafts.releaseRecoveredSend("send-chip-0000000000003");
  expect(drafts.failedComposerSends("bot:b:t2")).toEqual([]);
  expect(drafts.recoverFailedComposerSend(sent(drafts, "bot:b:t3", "send-chip-0000000000004"))).toBe("restored");
  drafts.markDraftEdited("bot:b:t3");
  drafts.noteRefusedChips(new Set(["send-chip-0000000000004"]));
  expect(drafts.restoredSendId("bot:b:t3")).toBeUndefined();
});

it("a frozen (in-flight) draft is not cleared by a chip, but is by the failure that follows", async () => {
  const drafts = await load();
  drafts.pinDraftSendId("bot:b:t4", "send-chip-0000000000005");
  drafts.freezeDraft("bot:b:t4");
  drafts.noteRefusedChips(new Set(["send-chip-0000000000005"]));
  expect(drafts.restoredSendId("bot:b:t4")).toBe("send-chip-0000000000005");
  expect(drafts.recoverFailedComposerSend(sent(drafts, "bot:b:t4", "send-chip-0000000000005"))).toBe("chip");
  expect(drafts.restoredSendId("bot:b:t4")).toBeUndefined();
});

it("a chip clears a persisted retry item of a conversation that is not loaded", async () => {
  const store = storage();
  store.setItem("murage-draft-failed-sends", JSON.stringify({
    "bot:b:other": [{ id: "x-1", sendId: "send-chip-0000000000009", text: "words", requestText: "words", threadId: "t9" }],
  }));
  vi.resetModules();
  vi.stubGlobal("localStorage", store);
  const drafts = await import("./drafts");
  drafts.noteRefusedChips(new Set(["send-chip-0000000000009"]));
  expect(JSON.parse(store.getItem("murage-draft-failed-sends") ?? "{}")["bot:b:other"] ?? []).toEqual([]);
  expect(drafts.failedComposerSends("bot:b:other")).toEqual([]);
});
