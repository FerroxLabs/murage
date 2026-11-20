import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoreProvider, useStore, type Action, type CommandOutboxEntry, commandOutboxBody, normalizeAudienceWire, createStreamDeltaBuffer, LIVE_REPLY_WITHHELD } from "../state/store";
import { createOutbox } from "../state/send-delivery";
import { engineCommandPick, matchEngineCommands, selectedCommandSend } from "../lib/engine-commands-menu";

describe("audience stream regions", () => {
  it("ux.stable-region and ux.reconnect-no-speech fold repeated revisions once", () => {
    let text = "";
    const buffer = createStreamDeltaBuffer((entries) => { for (const [, delta] of entries) text += delta.text; });
    const push = buffer.push as (...args: unknown[]) => void;
    push("t1", "assistant_text", "«redacted»", { regionId: "r1", itemRevision: 1, speechDisposition: "none" });
    buffer.flush();
    push("t1", "assistant_text", "«redacted»", { regionId: "r1", itemRevision: 1, speechDisposition: "none" });
    push("t1", "assistant_text", "«redacted»", { regionId: "r1", itemRevision: 2, speechDisposition: "none" });
    buffer.flush(); buffer.dispose();
    // CHANGED (redact2-1020): a whole withheld assistant region reads the plain line, still folded once; it was the bare marker
    expect(text).toBe(LIVE_REPLY_WITHHELD);
  });
  it("REDACT2-1020-LIVE a withheld assistant item never paints a bare «redacted» bubble while the bot works; inline masks and reasoning keep the server's text", () => {
    let text = "", reasoning = "";
    const buffer = createStreamDeltaBuffer((entries) => { for (const [, d] of entries) { if (d.replaceText) text = d.text; else text += d.text; if (d.replaceReasoning) reasoning = d.reasoning; else reasoning += d.reasoning; } });
    buffer.push("t1", "assistant_text", "Still sweeping. ", { regionId: "r1", itemRevision: 1, speechDisposition: "append", op: "append" });
    buffer.flush();
    expect(text).toBe("Still sweeping. ");
    // the next item is withheld whole: by an omit op, and by a replace whose text is only the marker
    buffer.push("t1", "assistant_text", "", { regionId: "r2", itemRevision: 1, speechDisposition: "none", op: "omit" });
    buffer.flush();
    expect(text).toBe(`Still sweeping. ${LIVE_REPLY_WITHHELD}`);
    buffer.push("t1", "assistant_text", "«redacted»", { regionId: "r3", itemRevision: 1, speechDisposition: "none", op: "replace" });
    buffer.flush();
    expect(text).not.toContain("«redacted»");
    // an inline mask inside the bot's other words is the server's own text, kept
    buffer.push("t1", "assistant_text", "token «redacted» rotated", { regionId: "r4", itemRevision: 1, speechDisposition: "none", op: "replace" });
    buffer.flush();
    expect(text).toContain("token «redacted» rotated");
    buffer.push("t1", "reasoning_text", "«redacted»", { regionId: "q1", itemRevision: 1, speechDisposition: "none", op: "replace" });
    buffer.flush(); buffer.dispose();
    expect(reasoning).toBe("«redacted»");
  });
  it("ux.clean-multiline and ux.unterminated preserve admitted server lines", () => {
    let text = "";
    const buffer = createStreamDeltaBuffer((entries) => { text += entries[0]![1].text; });
    buffer.push("t1", "assistant_text", "First\n"); buffer.flush(); expect(text).toBe("First\n");
    buffer.push("t1", "assistant_text", "Last"); buffer.flush(); buffer.dispose(); expect(text).toBe("First\nLast");
  });
  it("ux.cancel-no-flash discards unpainted output", () => {
    let calls = 0; const buffer = createStreamDeltaBuffer(() => calls++);
    buffer.push("t1", "assistant_text", "safe pending"); buffer.clear("t1"); buffer.flush(); buffer.dispose();
    expect(calls).toBe(0);
  });
  it("command menu after reconnect uses cache handles, never display labels as command bytes", () => {
    const command = { handle: "c.0123456789abcdef.0", label: "«redacted»", takesArguments: false };
    // Reconnect rebuilds the menu from the same safe cache JSON, no live turn.
    const view = JSON.parse(JSON.stringify([command]));
    expect(matchEngineCommands(view, "")).toEqual([command]);
    expect(engineCommandPick(view[0])).toEqual({ kind: "send", text: "/«redacted»", commandHandle: command.handle });
  });
});


afterEach(() => vi.unstubAllGlobals());
async function postAction(action: Action, expectedPosts = 1) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") posts.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
  let dispatch!: (action: Action) => void;
  const Probe = () => { dispatch = useStore().dispatch; return null; };
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
  dispatch(action);
  await vi.waitFor(() => expect(posts).toHaveLength(expectedPosts));
  return posts;
}

describe("serialized client actions", () => {
  it("posts one atomic answer and no provider labels", async () => {
    const displayAction = { requestHandle: "q.card-1", action: "answer" as const, answers: [0, 1, 2, 3].map((i) => ({ questionHandle: `q.${i}`, optionHandles: [`o.${i}.0`] })) };
    expect(await postAction({ type: "answerQuestion", threadId: "t1", requestId: "obsolete-provider-id", behavior: "answer", displayAction })).toEqual([
      { url: "/api/threads/t1/respond", body: displayAction },
    ]);
  });
  it("preserves an ordinary room late answer send-then-record flow using handles", async () => {
    const displayAction = { requestHandle: "q.card-1", action: "answer" as const, sentAsMessage: true as const, answers: [{ questionHandle: "q.0", optionHandles: [], other: "  original bytes  " }] };
    expect(await postAction({ type: "sendQuestionAsMessage", groupId: "g1", threadId: "t1", requestId: "q.card-1", displayAction, answers: [], text: "display text must not execute" }, 2)).toEqual([
      { url: "/api/groups/g1/messages", body: { threadId: "t1", sendId: "ask-card-1", mode: "chat", ...displayAction } },
      { url: "/api/threads/t1/respond", body: displayAction },
    ]);
  });
  it("keeps async room and direct late answers on the one-request path", async () => {
    const displayAction = { requestHandle: "q.card-1", action: "answer" as const, sentAsMessage: true as const, answers: [{ questionHandle: "q.0", optionHandles: ["o.0.0"] }] };
    for (const target of [{ botId: "b1" }, { groupId: "g1", answerAsSend: true }]) {
      expect(await postAction({ type: "sendQuestionAsMessage", ...target, threadId: "t1", requestId: "q.card-1", displayAction, answers: [], text: "safe preview" })).toEqual([
        { url: "/api/threads/t1/respond", body: displayAction },
      ]);
    }
  });
  it("sends cached command handles with exact args and sendId after reconnect", async () => {
    const command = { handle: "c.0123456789abcdef.1", label: "Safe command", takesArguments: true };
    const body = selectedCommandSend(command, "/Safe command  owner words\nwith spaces  ", "send-1")!;
    expect(body.args).toBe(" owner words\nwith spaces  ");
    expect(await postAction({ type: "sendEngineCommand", botId: "b1", threadId: "t1", ...body })).toEqual([
      { url: "/api/bots/b1/messages", body: { threadId: "t1", ...body } },
    ]);
    expect(selectedCommandSend(command, "/a different command", "send-2")).toBeNull();
  });
});


it("rebuilds handles after an outbox reload without using the displayed command", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const entry: CommandOutboxEntry = { kind: "bot", botId: "b1", threadId: "t1", sendId: "s1", text: "/«redacted»", at: 1, attempts: 0, displayCommand: { commandHandle: "c.0123456789abcdef.0", args: "  exact args  " } };
  createOutbox(storage).add(entry);
  const recovered = createOutbox(storage).list()[0]!;
  expect(commandOutboxBody(recovered)).toEqual({ threadId: "t1", sendId: "s1", ...entry.displayCommand });
  expect(() => commandOutboxBody({ ...entry, displayCommand: null } as unknown as CommandOutboxEntry)).toThrow("Choose the engine command again.");
});

it("normalizes handle-only reconnect cards without mutating the safe wire copy", () => {
  const card = { title: "Question", requestHandle: "q.card-1", questions: [{ handle: "q.0", question: "Choose", options: [{ handle: "o.0.0", label: "Option 1" }], multiSelect: false, allowOther: false }] };
  const wire = { bots: [{ messages: [{ id: "card-1", role: "bot", card }], openCards: [{ id: "card-1", role: "bot", card }] }] };
  const normalized = normalizeAudienceWire(wire);
  for (const key of ["messages", "openCards"]) {
    expect(normalized.bots[0][key][0].card.requestId).toBe("q.card-1");
    expect(normalized.bots[0][key][0].card.questions[0].id).toBe("q.0");
  }
  expect(card).not.toHaveProperty("requestId");
});


it("a replacement cannot restore a suppressed region or duplicate a clean revision", () => {
  let text = "";
  const buffer = createStreamDeltaBuffer((entries) => { for (const [, delta] of entries) text = (delta.replaceText ? "" : text) + delta.text; });
  buffer.push("t1", "assistant_text", "Safe\n", { regionId: "r1", itemRevision: 1, speechDisposition: "append" });
  buffer.flush();
  buffer.push("t1", "assistant_text", "Safe\n", { regionId: "r1", itemRevision: 1, speechDisposition: "append" });
  buffer.flush(); expect(text).toBe("Safe\n");
  buffer.push("t1", "assistant_text", "«redacted»", { regionId: "r1", itemRevision: 2, speechDisposition: "none", op: "replace" });
  // CHANGED (redact2-1020): the suppressed region reads the plain line (was the bare marker); it still cannot be restored
  buffer.flush(); expect(text).toBe(LIVE_REPLY_WITHHELD);
  buffer.push("t1", "assistant_text", "must not restore", { regionId: "r1", itemRevision: 3, speechDisposition: "none", op: "replace" });
  buffer.flush(); buffer.dispose(); expect(text).toBe(LIVE_REPLY_WITHHELD);
});
