// Goal mode belongs to the draft (U36: its record), per conversation, across reloads and tabs.
import { afterEach, expect, it, vi } from "vitest";

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async (store: unknown) => { vi.resetModules(); vi.stubGlobal("localStorage", store); return import("./drafts"); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const build = (sendId: string, content: { text: string }) => ({ sendId, kind: "group" as const, groupId: "g", threadId: "t", text: content.text, mode: "goal" as const, at: 1, attempts: 0 });

it("keeps task modes separate and stores the mode in that task's record", async () => {
  const store = storage();
  const drafts = await load(store);
  drafts.setComposerDraftMode("group:g:A", "goal");
  await flush();
  expect(drafts.readComposerDraft("group:g:B").mode).toBe("chat");
  expect(JSON.parse(store.getItem("murage-draft:group:g:A")!).mode).toBe("goal");
  drafts.setComposerDraftMode("group:g:A", "chat");
  await flush();
  expect(JSON.parse(store.getItem("murage-draft:group:g:A")!).mode).toBe("chat");
  expect((await load(store)).readComposerDraft("group:g:A").mode).toBe("chat");
});

it.each([null, "{", "[]", '{"group:g:A":"invalid"}'])("a legacy or invalid 1.0.4 mode remains ordinary chat: %s", async (raw) => {
  const drafts = await load(storage(raw === null ? {} : { "murage-draft-channel-modes": raw }));
  expect(drafts.readComposerDraft("group:g:A").mode).toBe("chat");
});

it("migrates a saved 1.0.4 goal into the record", async () => {
  const store = storage({ "murage-draft-channel-modes": '{"group:g:A":"goal"}' });
  const drafts = await load(store);
  expect(drafts.readComposerDraft("group:g:A").mode).toBe("goal");
  await drafts.migrateLegacyDrafts();
  expect(JSON.parse(store.getItem("murage-draft:group:g:A")!).mode).toBe("goal");
  expect(store.getItem("murage-draft-channel-modes")).toBeNull();
});

it("retains goal intent for this page if storage refuses writes", async () => {
  const denied = { getItem() { return null; }, setItem() { throw new Error("quota"); } };
  const drafts = await load(denied);
  drafts.setComposerDraftMode("group:g:A", "goal");
  await flush();
  expect(drafts.readComposerDraft("group:g:A").mode).toBe("goal");
});

it("a failed goal send keeps its goal mode in the box (nothing is restored, nothing was removed)", async () => {
  const drafts = await load(storage());
  const id = "group:g:goal";
  drafts.setComposerDraftMode(id, "goal");
  drafts.setComposerDraftText(id, "Do the goal");
  await flush();
  const begun = await drafts.beginDraftSend(id, { text: "Do the goal", att: [], mode: "goal" }, build);
  if (!begun.ok) throw new Error(begun.reason);
  expect(drafts.setComposerDraftMode(id, "chat")).toBe(false); // read-only while held
  await drafts.settleDraftSend(id, begun.sendId, begun.attemptId, "failed");
  expect(drafts.readComposerDraft(id)).toMatchObject({ text: "Do the goal", mode: "goal", held: false });
});

it("the acknowledgement resets the mode with the words", async () => {
  const drafts = await load(storage());
  const id = "group:g:ack";
  drafts.setComposerDraftMode(id, "goal");
  drafts.setComposerDraftText(id, "Finish it");
  await flush();
  const begun = await drafts.beginDraftSend(id, { text: "Finish it", att: [], mode: "goal" }, build);
  if (!begun.ok) throw new Error(begun.reason);
  await drafts.settleDraftSend(id, begun.sendId, undefined, "acked");
  expect(drafts.readComposerDraft(id)).toMatchObject({ text: "", mode: "chat" });
});
