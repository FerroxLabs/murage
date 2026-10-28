// S30: a share or ask-intent line is never part of an owner turn's input and runs after it as its own unattended batch.
import { describe, expect, it } from "vitest";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import { sendStore } from "./send-store.ts";
import type { BotRecord, Message } from "./store.ts";

function bot(busy: boolean): BotRecord {
  return { id: "b", threadId: "t", name: "b", title: "", description: "", notifications: false, color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, resumeCursors: {}, busy, createdAt: 0 };
}
function store(b: BotRecord): SteerStore & { messages: Message[] } {
  const messages: Message[] = [];
  return {
    messages,
    bot: () => b,
    appendMessage: (_t, message) => { const full: Message = { id: `m${messages.length + 1}`, at: 0, ...message }; messages.push(full); return full; },
    patchMessage: () => null,
  };
}
const put = (text: string, extra: Record<string, unknown> = {}, n = 0) => {
  const r = sendStore.accept({ kind: "bot", ownerId: "b", threadId: "t", fingerprint: `${text}${n}`, text, status: "queued", ...extra } as never);
  if (r.kind !== "new") throw new Error("not new");
};

describe("a via line behind a running owner turn", () => {
  it("is not in that turn's input and runs after it as its own batch", () => {
    sendStore.reset();
    const b = bot(true);
    const s = store(b);
    put("owner words");
    put("shared words", { origin: "unproven", via: "share", queueOnly: true, viaDevice: "phone" });
    const runs: Array<{ prompt: string; ids: string[]; via: string | null; device: string | null }> = [];
    const run = (_b: string, _t: string, prompt: string, _m: Message, ids: string[], batch: { via: string | null; viaDevice: string | null }) => { runs.push({ prompt, ids, via: batch.via, device: batch.viaDevice }); };
    drainSteeredMessages(s, run);
    expect(runs).toEqual([]);
    b.busy = false;
    drainSteeredMessages(s, run);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prompt: "owner words", via: null, device: null });
    expect(runs[0]!.ids).toHaveLength(1);
    b.busy = true;
    drainSteeredMessages(s, run);
    expect(runs).toHaveLength(1);
    b.busy = false;
    drainSteeredMessages(s, run);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ prompt: "shared words", via: "share", device: "phone" });
    expect(s.messages.map((m) => m.text)).toEqual(["owner words", "shared words"]);
    expect(s.messages[1]).toMatchObject({ via: "share", origin: "unproven" });
  });
});

describe("a via line refused at the drain", () => {
  it("does not hold the owner lines queued behind it: the thread drains again in the same call", () => {
    sendStore.reset();
    const s = store(bot(false));
    // a stored document never rides as an owner-style attachment, so the drain refuses this row whole
    put("shared with a file", { origin: "unproven", via: "share", queueOnly: true, viaDevice: "phone", attachments: [{ kind: "file", path: "/a/x.pdf", mime: "application/pdf" }] }, 1);
    put("owner words behind it", {}, 2);
    const runs: Array<{ prompt: string; via: string | null }> = [];
    drainSteeredMessages(s, (_b, _t, prompt, _m, _ids, batch) => { runs.push({ prompt, via: batch.via }); });
    expect(runs).toEqual([{ prompt: "owner words behind it", via: null }]);
    expect(s.messages.map((m) => m.text)).toEqual(["owner words behind it"]);
  });

  it("two refused via rows in a row still reach the owner line, and a thread of only refused rows ends", () => {
    sendStore.reset();
    const s = store(bot(false));
    const refusedVia = { origin: "unproven", via: "ask-intent", queueOnly: true, viaDevice: "phone", attachments: [{ kind: "file", path: "/a/y.pdf", mime: "application/pdf" }] };
    put("refused one", refusedVia, 1);
    put("refused two", refusedVia, 2);
    put("owner last", {}, 3);
    const runs: string[] = [];
    drainSteeredMessages(s, (_b, _t, prompt) => { runs.push(prompt); });
    expect(runs).toEqual(["owner last"]);
    sendStore.reset();
    put("only refused", refusedVia, 4);
    drainSteeredMessages(s, (_b, _t, prompt) => { runs.push(prompt); });
    expect(runs).toEqual(["owner last"]);
  });
});
