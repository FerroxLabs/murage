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
