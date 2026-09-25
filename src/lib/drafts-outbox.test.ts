// A send that failed after the person had already typed something newer
// goes to the composer's "failed" list (recoverFailedComposerSend →
// "outbox"). That list lived only in memory (drafts.ts:39), so a reload —
// or iOS killing a backgrounded WebView — lost the message outright.
import { afterEach, expect, it, vi } from "vitest";

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const load = async () => { vi.resetModules(); return import("./drafts"); };

it("keeps a failed send across a reload, and forgets it for good once dismissed", async () => {
  vi.stubGlobal("localStorage", storage());
  const first = await load();
  const id = "persist-outbox";
  const sent = { draftId: id, revision: first.draftRevision(id), sendId: "send-1", text: "Hello", requestText: "Hello", threadId: "thread-A", attachments: [] };
  first.markDraftEdited(id); // something newer is in the box, so this one goes to the outbox
  expect(first.recoverFailedComposerSend(sent)).toBe("outbox");

  const second = await load();
  const [kept] = second.failedComposerSends(id);
  expect(kept).toMatchObject({ sendId: "send-1", text: "Hello", requestText: "Hello", threadId: "thread-A" });
  second.forgetFailedComposerSend(id, kept!.id);

  expect((await load()).failedComposerSends(id)).toEqual([]);
});

it("drops tampered entries and keeps the valid ones", async () => {
  vi.stubGlobal("localStorage", storage({
    "murage-draft-failed-sends": JSON.stringify({
      d: [
        { id: "a", sendId: "s", text: "ok", requestText: "ok", threadId: "t" },
        { id: "b", sendId: 7, text: "bad", requestText: "bad", threadId: "t" },
        { id: "c", sendId: "s2", text: "mode", requestText: "mode", threadId: "t", channelMode: "shout" },
        "not an object",
      ],
    }),
  }));
  const drafts = await load();
  expect(drafts.failedComposerSends("d").map((send) => send.id)).toEqual(["a"]);
});

it("keeps at most 20 per conversation, newest last", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  for (let i = 0; i < 25; i += 1) {
    drafts.rememberFailedComposerSend("cap", { sendId: `s${i}`, text: `m${i}`, requestText: `m${i}`, threadId: "t" });
  }
  const reloaded = await load();
  const kept = reloaded.failedComposerSends("cap");
  expect(kept).toHaveLength(20);
  expect(kept.at(-1)?.sendId).toBe("s24");
});

it("still works in memory when storage is refused", async () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } });
  const drafts = await load();
  drafts.rememberFailedComposerSend("denied", { sendId: "s", text: "t", requestText: "t", threadId: "th" });
  expect(drafts.failedComposerSends("denied")).toHaveLength(1);
});
