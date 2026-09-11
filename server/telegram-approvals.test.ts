import { expect, it, vi } from "vitest";
import { TelegramApprovals, type TelegramApproval } from "./telegram-approvals.ts";
import type { TelegramUpdate } from "./telegram-update.ts";
function fixture() {
  let now = 1;
  let pending: TelegramApproval[] = [{ id: "request-card", fingerprint: "exact-action", summary: "Write fixture.txt" }];
  const resolve = vi.fn(async () => true);
  const sendMessage = vi.fn(async (_input: any) => ({ chatId: "7", messageId: 19 }));
  const answerCallbackQuery = vi.fn(async (_input: any) => {});
  const settleApprovalMessage = vi.fn(async (_input: any) => {});
  const manager = new TelegramApprovals({ pending: () => pending, resolve }, { sendMessage, answerCallbackQuery, settleApprovalMessage }, () => now);
  const owner = { senderId: "7", chatId: "7" }, signal = new AbortController().signal;
  const publish = () => manager.publish(owner, () => true, signal);
  const callback = (patch: Partial<Extract<TelegramUpdate, { kind: "callback" }>> = {}) => manager.answer({ updateId: 2, kind: "callback", callbackId: "callback", senderId: "7", chatId: "7", messageId: 19, data: sendMessage.mock.calls[0][0].buttons[0].data, ...patch }, owner, () => true, signal);
  return { manager, resolve, sendMessage, answerCallbackQuery, settleApprovalMessage, publish, callback,
    change: () => { pending = [{ ...pending[0], fingerprint: "changed-action" }]; },
    remove: () => { pending = []; }, expire: () => { now += 600001; } };
}
it("owner button authorizes exactly once; never auto-resends offers", async () => {
  const f = fixture(); await f.publish(); await f.publish();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  await f.callback(); await f.callback();
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "request-card", fingerprint: "exact-action" }), "allow");
});
it("deny button uses the same single-action binding", async () => {
  const f = fixture(); await f.publish(); await f.callback({ data: f.sendMessage.mock.calls[0][0].buttons[1].data });
  expect(f.resolve).toHaveBeenCalledWith(expect.anything(), "deny");
});
it.each(["sender", "chat", "message", "forged", "expired", "changed", "resolved", "revoked"])("rejects %s callbacks", async scenario => {
  const f = fixture(); await f.publish();
  const patch: any = scenario === "sender" ? { senderId: "8" } : scenario === "chat" ? { chatId: "8" }
    : scenario === "message" ? { messageId: 20 } : scenario === "forged" ? { data: "forged:a" } : {};
  if (scenario === "expired") f.expire();
  if (scenario === "changed") f.change();
  if (scenario === "resolved") f.remove();
  if (scenario === "revoked") f.manager.clear();
  await f.callback(patch); expect(f.resolve).not.toHaveBeenCalled();
});
it("uncertain delivery never yields an actionable callback or automatic resend", async () => {
  const f = fixture(); f.sendMessage.mockRejectedValueOnce(new Error("offline"));
  await expect(f.publish()).rejects.toThrow("offline"); await f.publish(); await f.callback();
  expect(f.sendMessage).toHaveBeenCalledTimes(1); expect(f.resolve).not.toHaveBeenCalled();
});
it("exception after approval consumption cannot retry the action", async () => {
  const f = fixture(); f.resolve.mockRejectedValueOnce(new Error("uncertain"));
  await f.publish(); await f.callback(); await f.callback(); expect(f.resolve).toHaveBeenCalledTimes(1);
});
it("settles denied card once and repeats the actual result for a second click", async () => {
  const f = fixture(); await f.publish(); const data = f.sendMessage.mock.calls[0][0].buttons[1].data;
  await f.callback({ data }); f.remove(); await f.publish(); await f.callback({ data });
  expect(f.settleApprovalMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "7", messageId: 19, text: "Write fixture.txt\n\nDenied." }));
  expect(f.answerCallbackQuery.mock.calls.at(-1)![0].text).toBe("Denied.");
  expect(f.resolve).toHaveBeenCalledTimes(1);
});
it("expires visible buttons without resolving the action", async () => {
  const f = fixture(); await f.publish(); f.expire(); await f.publish(); await f.callback();
  expect(f.settleApprovalMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Expired.") }));
  expect(f.resolve).not.toHaveBeenCalled();
});
it("card edit failure does not undo or repeat an allowed decision", async () => {
  const f = fixture(); f.settleApprovalMessage.mockRejectedValueOnce(new Error("offline"));
  await f.publish(); await f.callback(); await f.callback();
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.answerCallbackQuery.mock.calls.at(-1)![0].text).toBe("Allowed once.");
});

// ── questions (0.1.52 ASK3) ──────────────────────────────────────────────

function questionFixture(questions: NonNullable<TelegramApproval["questions"]>) {
  let now = 1;
  let pending: TelegramApproval[] = [{ id: "question-card", fingerprint: "exact-question", summary: "Ember has a question", questions }];
  const resolve = vi.fn(async () => true);
  const answer = vi.fn(async (_approval: TelegramApproval, _reply: unknown) => ({ ok: true as const }));
  let nextMessageId = 19;
  const sendMessage = vi.fn(async (_input: any) => ({ chatId: "7", messageId: nextMessageId++ }));
  const answerCallbackQuery = vi.fn(async (_input: any) => {});
  const settleApprovalMessage = vi.fn(async (_input: any) => {});
  const editQuestionMessage = vi.fn(async (_input: any) => {});
  const manager = new TelegramApprovals({ pending: () => pending, resolve, answer }, { sendMessage, answerCallbackQuery, settleApprovalMessage, editQuestionMessage }, () => now);
  const owner = { senderId: "7", chatId: "7" }, signal = new AbortController().signal;
  const publish = () => manager.publish(owner, () => true, signal);
  /** the keyboard of the latest sent question, flattened */
  const buttons = (): Array<{ text: string; data: string }> => [...sendMessage.mock.calls].reverse().find(call => call[0].keyboard)![0].keyboard.flat();
  const button = (text: string) => { const found = buttons().find(item => item.text === text || item.text.endsWith(` ${text}`)); if (!found) throw new Error(`no button ${text}`); return found; };
  /** the Telegram message id of the latest question (ids are handed out in send order from 19) */
  const questionMessageId = () => 19 + sendMessage.mock.calls.map(call => Boolean(call[0].keyboard)).lastIndexOf(true);
  const tap = (data: string, messageId = questionMessageId()) => manager.answer({ updateId: 2, kind: "callback", callbackId: "callback", senderId: "7", chatId: "7", messageId, data }, owner, () => true, signal);
  const say = (text: string, patch: Record<string, unknown> = {}) => manager.captureText({ updateId: 3, kind: "message", transport: "telegram", origin: "channel", untrusted: true, chatId: "7", chatType: "private", senderId: "7", messageId: 40, timestampSeconds: 1, forwarded: false, text, ...patch } as any, owner, () => true, signal);
  return { manager, answer, resolve, sendMessage, answerCallbackQuery, settleApprovalMessage, editQuestionMessage, publish, buttons, button, tap, say,
    remove: () => { pending = []; }, expire: () => { now += 30 * 60000 + 1; }, lastToast: () => answerCallbackQuery.mock.calls.at(-1)![0].text as string };
}
const single = { id: "q1", question: "Which format should the report use?", header: "Format", options: [{ label: "Summary", description: "A short overview" }, { label: "Detailed" }], multiSelect: false, allowOther: true };
const multi = { id: "q2", question: "Which sections?", options: [{ label: "Intro" }, { label: "Outro" }], multiSelect: true, allowOther: true };
const closed = { id: "q3", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false };

it("publishes a question with one button per option, numbered text, and the desktop card's answer path", async () => {
  const f = questionFixture([single]); await f.publish(); await f.publish();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  const sent = f.sendMessage.mock.calls[0][0];
  expect(sent.text).toContain("Ember has a question\nFormat: Which format should the report use?\n\n1. Summary — A short overview\n2. Detailed");
  expect(sent.text).toContain("Expires in 30 minutes");
  expect(sent.keyboard.map((row: any[]) => row.map(item => item.text))).toEqual([["Summary"], ["Detailed"], ["Reply with text", "Skip question"]]);
  for (const item of f.buttons()) expect(Buffer.byteLength(item.data)).toBeLessThanOrEqual(64);
  await f.tap(f.button("Detailed").data);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "question-card", fingerprint: "exact-question" }), { behavior: "answer", answers: [{ id: "q1", selected: ["Detailed"] }] });
  expect(f.lastToast()).toBe("Answered.");
  expect(f.settleApprovalMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 19, text: expect.stringContaining("Answered.") }));
  await f.tap(f.button("Summary").data);
  expect(f.answer).toHaveBeenCalledTimes(1);
  expect(f.lastToast()).toBe("Answered.");
});
it("multi-select toggles redraw the keyboard and Submit delivers every pick at once", async () => {
  const f = questionFixture([multi]); await f.publish();
  expect(f.sendMessage.mock.calls[0][0].keyboard.map((row: any[]) => row.map(item => item.text))).toEqual([["☐ Intro"], ["☐ Outro"], ["Reply with text", "Submit", "Skip question"]]);
  await f.tap(f.button("Submit").data);
  expect(f.lastToast()).toBe("Pick at least one option first.");
  expect(f.answer).not.toHaveBeenCalled();
  await f.tap(f.button("Intro").data);
  expect(f.lastToast()).toBe("Selected: Intro");
  expect(f.editQuestionMessage).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 19, keyboard: expect.arrayContaining([[expect.objectContaining({ text: "☑ Intro" })]]) }));
  await f.tap(f.button("Outro").data); await f.tap(f.button("Intro").data);
  expect(f.lastToast()).toBe("Selected: Outro");
  await f.tap(f.button("Submit").data);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { behavior: "answer", answers: [{ id: "q2", selected: ["Outro"] }] });
});
it("'Reply with text' makes the owner's next message the answer, never a new prompt", async () => {
  const f = questionFixture([single]); await f.publish();
  expect(await f.say("stray text before tapping")).toBe(false);
  await f.tap(f.button("Reply with text").data);
  expect(f.lastToast()).toContain("Reply in this chat");
  expect(await f.say("hello", { senderId: "8" })).toBe(false); // not the owner
  expect(await f.say("x".repeat(2001))).toBe(true); // too long: kept waiting, told why
  expect(f.answer).not.toHaveBeenCalled();
  expect(f.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("longer than 2,000"), replyToMessageId: 40 }));
  expect(await f.say("A one-page brief for the board")).toBe(true);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { behavior: "answer", answers: [{ id: "q1", selected: [], other: "A one-page brief for the board" }] });
  expect(f.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Answered.", replyToMessageId: 40 }));
  expect(await f.say("another message")).toBe(false); // capture is spent
});
it("/cancel disarms text capture, and a multi-select keeps the note beside its picks", async () => {
  const f = questionFixture([multi]); await f.publish();
  await f.tap(f.button("Reply with text").data);
  expect(await f.say("/cancel")).toBe(true);
  expect(await f.say("not captured")).toBe(false);
  await f.tap(f.button("Reply with text").data);
  expect(await f.say("and the appendix")).toBe(true);
  expect(f.editQuestionMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("Your words: and the appendix") }));
  await f.tap(f.button("Intro").data);
  await f.tap(f.button("Submit").data);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { behavior: "answer", answers: [{ id: "q2", selected: ["Intro"], other: "and the appendix" }] });
});
it("asks several questions one message at a time and delivers the whole answer once", async () => {
  const f = questionFixture([closed, single]); await f.publish();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.sendMessage.mock.calls[0][0].text).toContain("Ember has a question (1/2)");
  expect(f.sendMessage.mock.calls[0][0].keyboard.map((row: any[]) => row.map(item => item.text))).toEqual([["Yes"], ["No"], ["Skip question"]]);
  await f.tap(f.button("Yes").data);
  expect(f.lastToast()).toBe("Noted: Yes");
  expect(f.answer).not.toHaveBeenCalled();
  expect(f.settleApprovalMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 19, text: expect.stringContaining("Your answer: Yes") }));
  expect(f.sendMessage).toHaveBeenCalledTimes(2);
  expect(f.sendMessage.mock.calls[1][0].text).toContain("(2/2)");
  // a stale tap on the first message does nothing
  await f.tap(`${f.button("Summary").data.slice(0, 48)}:q0:o1`, 19);
  expect(f.answer).not.toHaveBeenCalled();
  await f.tap(f.button("Summary").data);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { behavior: "answer", answers: [{ id: "q3", selected: ["Yes"] }, { id: "q1", selected: ["Summary"] }] });
  expect(f.settleApprovalMessage).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 20, text: expect.stringContaining("Answered.") }));
});
it("Skip tells the bot nobody answered, exactly once, and a delivery error is reported not retried", async () => {
  const f = questionFixture([closed]); await f.publish();
  await f.tap(f.button("Skip question").data); await f.tap(f.button("Skip question").data);
  expect(f.answer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { behavior: "skip" });
  expect(f.lastToast()).toContain("Skipped");

  const g = questionFixture([closed]); g.answer.mockResolvedValueOnce({ ok: false, error: "This question was already settled." } as any); await g.publish();
  await g.tap(g.button("No").data); await g.tap(g.button("No").data);
  expect(g.answer).toHaveBeenCalledTimes(1);
  expect(g.lastToast()).toBe("Not delivered: This question was already settled.");
});
it("rejects forged, foreign, stale and expired question taps and never answers a question that left the card list", async () => {
  const f = questionFixture([closed]); await f.publish();
  const data = f.button("Yes").data;
  await f.tap("f".repeat(48) + ":q0:o0"); await f.tap(data.replace(/:o0$/, ":o7")); await f.tap(data, 18);
  await f.manager.answer({ updateId: 2, kind: "callback", callbackId: "c", senderId: "8", chatId: "7", messageId: 19, data }, { senderId: "7", chatId: "7" }, () => true, new AbortController().signal);
  expect(f.answer).not.toHaveBeenCalled();
  f.remove(); await f.tap(data); expect(f.answer).not.toHaveBeenCalled();

  const g = questionFixture([closed]); await g.publish(); g.expire(); await g.publish();
  expect(g.settleApprovalMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Expired.") }));
  await g.tap(g.button("Yes").data); expect(g.answer).not.toHaveBeenCalled();
});
it("keeps a question in-app when it cannot be shown whole or when the harness offers no answer path", async () => {
  const wide = { ...closed, question: "x".repeat(2000), options: Array.from({ length: 10 }, (_, i) => ({ label: `Option ${i}`, description: "y".repeat(200) })) };
  const f = questionFixture([wide]); await f.publish();
  expect(f.sendMessage).not.toHaveBeenCalled();
  const manager = new TelegramApprovals({ pending: () => [{ id: "q", fingerprint: "f", summary: "Ember has a question", questions: [closed] }], resolve: vi.fn(async () => true) }, { sendMessage: f.sendMessage, answerCallbackQuery: f.answerCallbackQuery }, () => 1);
  await manager.publish({ senderId: "7", chatId: "7" }, () => true, new AbortController().signal);
  expect(f.sendMessage).not.toHaveBeenCalled();
});
