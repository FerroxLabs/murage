// Composer drafts (src/lib/drafts.ts). U36: each draft is one record, `murage-draft:<draftId>`, holding its words,
// attachments, mode and reply; a send never takes the words out of the box, so a failure has nothing to restore.
import { afterEach, describe, expect, it, vi } from "vitest";

import { fileAttachment, pasteAttachment } from "../src/lib/composer-attachments.ts";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
const load = async (store: unknown) => { vi.resetModules(); vi.stubGlobal("localStorage", store); return import("../src/lib/drafts.ts"); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const build = (sendId: string, content: { text: string; reply?: string }) => ({ sendId, kind: "bot" as const, botId: "b", threadId: "thread-a", text: content.text, ...(content.reply ? { replyToId: content.reply } : {}), at: 1, attempts: 0 });

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("composer drafts", () => {
  it("keeps attachments in this page when storage refuses the write, and stores them when it can", async () => {
    const attachment = pasteAttachment("Keep this attachment");
    const denied = await load({ getItem: () => null, setItem: () => { throw new Error("storage denied"); } });
    denied.setComposerDraftAttachments("bot:denied:t", [attachment]);
    await flush();
    expect(denied.readComposerDraft("bot:denied:t").att).toEqual([attachment]);
    const store = memoryStore();
    const working = await load(store);
    working.setComposerDraftAttachments("bot:working:t", [attachment]);
    await flush();
    expect(JSON.parse(store.getItem("murage-draft:bot:working:t")!).att).toEqual([attachment]);
    expect((await load(store)).readComposerDraft("bot:working:t").att).toEqual([attachment]);
  });

  it("keeps text and attachments isolated per bot or room", async () => {
    const store = memoryStore();
    const drafts = await load(store);
    const paste = pasteAttachment("bot paste");
    const file = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    drafts.setComposerDraftText("bot:one:t", "hello");
    drafts.setComposerDraftAttachments("bot:one:t", [paste, file]);
    drafts.setComposerDraftText("group:two:t", "room text");
    await flush();
    const reloaded = await load(store);
    expect(reloaded.readComposerDraft("bot:one:t")).toMatchObject({ text: "hello", att: [paste, file] });
    expect(reloaded.readComposerDraft("group:two:t")).toMatchObject({ text: "room text", att: [] });
  });

  it("ignores a malformed record and malformed stored attachments", async () => {
    const store = memoryStore();
    store.setItem("murage-draft:bot:one:t", "{not json");
    store.setItem("murage-draft:bot:two:t", JSON.stringify({ v: 3, n: 0, text: "kept", att: [{ kind: "paste", id: "broken" }], mode: "chat" }));
    const drafts = await load(store);
    expect(drafts.readComposerDraft("bot:one:t").text).toBe("");
    expect(drafts.readComposerDraft("bot:two:t")).toMatchObject({ text: "kept", att: [] });
  });

  it("a rejected send leaves its words, attachments and reply in the box, owned by the same send id", async () => {
    const store = memoryStore();
    const drafts = await load(store);
    const draftId = "bot:restore:thread-a";
    const attachment = fileAttachment("notes.txt", "/tmp/notes.txt", 12);
    drafts.setComposerDraftText(draftId, "please retry");
    drafts.setComposerDraftAttachments(draftId, [attachment]);
    drafts.setComposerDraftReply(draftId, "message-1");
    await flush();
    const begun = await drafts.beginDraftSend(draftId, { text: "please retry", att: [attachment], mode: "chat" }, build);
    if (!begun.ok) throw new Error(begun.reason);
    await drafts.settleDraftSend(draftId, begun.sendId, begun.attemptId, "failed");
    expect(drafts.readComposerDraft(draftId)).toMatchObject({ text: "please retry", att: [attachment], reply: "message-1", held: false });
    expect(JSON.parse(store.getItem(`murage-draft:${draftId}`)!).pin.s).toBe(begun.sendId);
  });

  it("keeps a failed retry in the retry list, and forgets it when dismissed", async () => {
    const drafts = await load(memoryStore());
    const draftId = "group:preserve:thread-b";
    drafts.rememberFailedComposerSend(draftId, { sendId: "send-preserve", text: "older failed send", requestText: "older failed send", replyToId: "message-1", threadId: "thread-b" });
    expect(drafts.failedComposerSends(draftId)).toMatchObject([
      { text: "older failed send", requestText: "older failed send", replyToId: "message-1", threadId: "thread-b" },
    ]);
    const [failed] = drafts.failedComposerSends(draftId);
    drafts.forgetFailedComposerSend(draftId, failed.id);
    expect(drafts.failedComposerSends(draftId)).toEqual([]);
  });

  it("keeps reply targets isolated by task, in each task's record", async () => {
    const store = memoryStore();
    const drafts = await load(store);
    drafts.setComposerDraftReply("bot:r:thread-reply-a", "message-a");
    drafts.setComposerDraftReply("bot:r:thread-reply-b", "message-b");
    await flush();
    const reloaded = await load(store);
    expect(reloaded.readComposerDraft("bot:r:thread-reply-a").reply).toBe("message-a");
    expect(reloaded.readComposerDraft("bot:r:thread-reply-b").reply).toBe("message-b");
    reloaded.setComposerDraftReply("bot:r:thread-reply-a", undefined);
    await flush();
    expect(reloaded.readComposerDraft("bot:r:thread-reply-a").reply).toBeUndefined();
    expect(reloaded.readComposerDraft("bot:r:thread-reply-b").reply).toBe("message-b");
  });
});
