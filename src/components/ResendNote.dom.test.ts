// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// D7, by the real click: the connected chat and room rows (the components ChatView and GroupView draw) are rendered, the Send again button
// is pressed, and exactly one action reaches dispatch: the ORIGINAL words (never the nearest user row), the intended thread or member, a fresh send id.
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { ChatResendNote, RoomResendNote } from "./ResendNote";
import { t } from "@/lib/i18n";

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); });

const line = "The AI may already be working on this message, so Murage did not send it twice. Use Send again to send it now.";
const user = (id: string, at: number, text: string, extra: object = {}) => ({ id, at, role: "user", kind: "text", text, ...extra }) as Message;
const refusal = (resendOf: Message["resendOf"], from?: Message["from"]) => ({ id: "n1", at: 9, role: "bot", kind: "activity", memoryNote: "resend", resendOf, ...(from ? { from } : {}), tool: { name: line, ok: true } }) as Message;
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="resend-note-send-again"]');
const click = async () => { act(() => { button()!.click(); }); await settle(); };

describe("Send again, by the real click", () => {
  // [A, B, refusal-for-A]: B was sent while A's turn ran (the steer queue), so it sits above the row the refused turn posts when it ENDS
  const A = user("uA", 1, "message A"), B = user("uB", 2, "message B");

  it("chat: one click dispatches ONE send of message A (not B), to the chat's thread, under a fresh send id", async () => {
    const dispatch = vi.fn();
    const note = refusal({ messageId: "uA", threadId: "thread-1", botId: "bot-1" });
    mount(h(ChatResendNote, { messages: [A, B, note], note, botId: "bot-1", threadId: "thread-1", mintSendId: () => "fresh-1", dispatch }));
    await click();
    await click(); // the button is spent after one press
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "send", botId: "bot-1", text: "message A", sendId: "fresh-1", threadId: "thread-1" });
    expect(dispatch.mock.calls[0][0].text).not.toBe("message B");
  });

  it("room: one click dispatches ONE sendGroup of message A (not B), to the same member and thread, under a fresh send id", async () => {
    const dispatch = vi.fn();
    const note = refusal({ messageId: "uA", threadId: "th1", botId: "m1" }, { botId: "m1", name: "Ada", color: "coral" });
    mount(h(RoomResendNote, { transcript: [A, B, note], note, memberIds: ["m1", "m2"], roomBusy: false, groupId: "g1", threadId: "th1", mintSendId: () => "fresh-2", dispatch }));
    await click();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "sendGroup", groupId: "g1", text: "message A", sendId: "fresh-2", threadId: "th1", mode: "chat", responderId: "m1" });
  });

  it("offers nothing when the source cannot be resolved (not loaded, another conversation, a picture, an old row)", async () => {
    const dispatch = vi.fn();
    const offered = (messages: Message[], note: Message) => { cleanup(); mount(h(ChatResendNote, { messages, note, botId: "bot-1", threadId: "thread-1", mintSendId: () => "x", dispatch })); return button() !== null; };
    expect(offered([B], refusal({ messageId: "uA", threadId: "thread-1", botId: "bot-1" }))).toBe(false);
    expect(offered([A], refusal({ messageId: "uA", threadId: "elsewhere", botId: "bot-1" }))).toBe(false);
    expect(offered([user("uA", 1, "with a picture", { attachments: [{ kind: "image", path: "p.png", mime: "image/png" }] })], refusal({ messageId: "uA", threadId: "thread-1", botId: "bot-1" }))).toBe(false);
    expect(offered([A], refusal(undefined))).toBe(false);
    expect(offered([A], refusal({ messageId: "uA", threadId: "thread-1", botId: "bot-1" }))).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // L1/A4: the press is claimed on the server first; only a won claim dispatches, and a spent row (resendUsed) is disabled after a reload
  describe("claimed once", () => {
    const base = refusal({ messageId: "uA", threadId: "thread-1", botId: "bot-1" });
    const render = (note: Message, dispatch: (a: unknown) => void, claim: () => Promise<boolean>) =>
      mount(h(ChatResendNote, { messages: [A, B, note], note, botId: "bot-1", threadId: "thread-1", mintSendId: () => "fresh-x", dispatch, claim }));
    it("a won claim dispatches once; after a reload the used row is disabled and a second press sends nothing", async () => {
      const dispatch = vi.fn(); const claim = vi.fn(async () => true);
      render(base, dispatch, claim);
      await click();
      expect(claim).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
      cleanup(); // the answer to the send was lost; the person reloads: the server row now says resendUsed
      render({ ...base, resendUsed: true } as Message, dispatch, async () => false);
      expect(button()!.disabled).toBe(true);
      await click();
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it("a lost claim answer sends nothing, and the reloaded row is disabled", async () => {
      const dispatch = vi.fn();
      render(base, dispatch, async () => { throw new Error("network"); });
      await click();
      expect(dispatch).not.toHaveBeenCalled();
      cleanup();
      render({ ...base, resendUsed: true } as Message, dispatch, async () => true);
      expect(button()!.disabled).toBe(true);
      await click();
      expect(dispatch).not.toHaveBeenCalled();
    });
    it("a refused claim (already used elsewhere) sends nothing", async () => {
      const dispatch = vi.fn();
      render(base, dispatch, async () => false);
      await click();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it("M2: the row with no button shows the uncertain copy, not the offer that promises one", async () => {
    const dispatch = vi.fn();
    const note = refusal({ messageId: "gone", threadId: "thread-1", botId: "bot-1" });
    mount(h(ChatResendNote, { messages: [A], note, botId: "bot-1", threadId: "thread-1", mintSendId: () => "x", dispatch }));
    expect(button()).toBeNull();
    expect(document.querySelector('[data-testid="resend-note"]')!.textContent).toContain(t("engine.submission.afterSubmissionUncertain"));
    expect(document.body.textContent).not.toContain(line);
  });
});
