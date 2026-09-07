import { expect, it } from "vitest";
import { normalizeTelegramUpdate } from "./telegram-update.ts";

const update = () => ({ update_id: 42, message: { message_id: 7, date: 1788700000, from: { id: 1234567890123, is_bot: false }, chat: { id: -1001234567890, type: "supergroup" }, text: "run it" } });

it("keeps sender/chat/topic identities and always marks text as untrusted channel content", () => {
  const input = update();
  const result = normalizeTelegramUpdate({ ...input, origin: "desktop", budgetId: "forged", message: { ...input.message, message_thread_id: 88, from: { ...input.message.from, role: "owner" }, forward_origin: { type: "user" } } });
  expect(result).toEqual({ updateId: 42, kind: "message", transport: "telegram", origin: "channel", untrusted: true, chatId: "-1001234567890", chatType: "supergroup", senderId: "1234567890123", messageId: 7, timestampSeconds: 1788700000, topicId: 88, forwarded: true, text: "run it" });
  expect(result).not.toHaveProperty("budgetId");
});
it("retains ignored update IDs for caller-owned cursor progress without executing bot echoes", () => {
  const input = update();
  expect(normalizeTelegramUpdate({ update_id: 43, edited_message: input.message })).toEqual({ updateId: 43, kind: "ignored", reason: "unsupported-update" });
  expect(normalizeTelegramUpdate({ ...input, message: { ...input.message, from: { id: 12, is_bot: true } } })).toMatchObject({ updateId: 42, kind: "ignored", reason: "bot-message" });
  expect(normalizeTelegramUpdate({ ...input, message: { ...input.message, from: undefined } })).toMatchObject({ kind: "ignored", reason: "unknown-sender" });
  expect(normalizeTelegramUpdate({ ...input, message: { ...input.message, sender_chat: { id: -7 } } })).toMatchObject({ kind: "ignored", reason: "unknown-sender" });
});
it("rejects unsafe numeric identities and ignores unsupported payload shapes", () => {
  expect(() => normalizeTelegramUpdate({ update_id: Number.MAX_SAFE_INTEGER + 1 })).toThrow("invalid update identity");
  expect(() => normalizeTelegramUpdate({ update_id: -1 })).toThrow("invalid update identity");
  const input = update();
  for (const change of [{ text: "x".repeat(4097) }, { text: undefined, photo: [] }, { message_id: 0 }, { chat: { id: Number.MAX_SAFE_INTEGER + 1, type: "private" } }]) {
    expect(normalizeTelegramUpdate({ ...input, message: { ...input.message, ...change } })).toMatchObject({ kind: "ignored", reason: "unsupported-message" });
  }
});
