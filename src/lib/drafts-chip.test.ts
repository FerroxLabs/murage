// One recovery surface per sendId: when the server holds a refused chip, the chip owns the words
// (U36: refused(s) settles the draft record that holds them; only a confirmed chip ever reaches it).
import { afterEach, expect, it, vi } from "vitest";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async (store = storage()) => { vi.resetModules(); vi.stubGlobal("localStorage", store); return { drafts: await import("./drafts"), store }; };
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const build = (sendId: string, content: { text: string }) => ({ sendId, kind: "bot" as const, botId: "b", threadId: "t1", text: content.text, at: 1, attempts: 0 });
const sendFrom = async (drafts: typeof import("./drafts"), id: string, text: string) => {
  drafts.setComposerDraftText(id, text);
  await flush();
  const begun = await drafts.beginDraftSend(id, { text, att: [], mode: "chat" }, build);
  if (!begun.ok) throw new Error(begun.reason);
  return begun;
};

it("a chip for a send in flight clears the words it owns and retires the pin", async () => {
  const { drafts } = await load();
  const begun = await sendFrom(drafts, "bot:b:t1", "words");
  drafts.noteRefusedChips(new Set([begun.sendId]));
  await flush();
  expect(drafts.readComposerDraft("bot:b:t1")).toMatchObject({ text: "", held: false });
});

it("a chip for a failed send whose words are still in the box clears them; an edited draft stays the person's", async () => {
  const { drafts } = await load();
  const first = await sendFrom(drafts, "bot:b:t2", "words");
  await drafts.settleDraftSend("bot:b:t2", first.sendId, first.attemptId, "failed");
  const second = await sendFrom(drafts, "bot:b:t3", "other words");
  await drafts.settleDraftSend("bot:b:t3", second.sendId, second.attemptId, "failed");
  drafts.setComposerDraftText("bot:b:t3", "other words, edited");
  await flush();
  drafts.noteRefusedChips(new Set([first.sendId, second.sendId]));
  await flush();
  expect(drafts.readComposerDraft("bot:b:t2").text).toBe("");
  expect(drafts.readComposerDraft("bot:b:t3").text).toBe("other words, edited");
});

it("a retry-list item for the sendId is released too", async () => {
  const { drafts } = await load();
  drafts.rememberFailedComposerSend("bot:b:t4", { sendId: "send-chip-0000000000003", text: "words", requestText: "words", threadId: "t4" });
  expect(drafts.failedComposerSends("bot:b:t4")).toHaveLength(1);
  drafts.releaseRecoveredSend("send-chip-0000000000003");
  expect(drafts.failedComposerSends("bot:b:t4")).toEqual([]);
});

it("a chip clears a persisted retry item of a conversation that is not loaded", async () => {
  const store = storage();
  store.setItem("murage-draft-failed-sends", JSON.stringify({
    "bot:b:other": [{ id: "x-1", sendId: "send-chip-0000000000009", text: "words", requestText: "words", threadId: "t9" }],
  }));
  const { drafts } = await load(store);
  drafts.noteRefusedChips(new Set(["send-chip-0000000000009"]));
  expect(JSON.parse(store.getItem("murage-draft-failed-sends") ?? "{}")["bot:b:other"] ?? []).toEqual([]);
  expect(drafts.failedComposerSends("bot:b:other")).toEqual([]);
});
