import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { normalizeTelegramUpdate } from "./telegram-update.ts";
it("actual root approval actions bind live card, instance and thread and resolve only once", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("approvals: targetBotId =>", source.indexOf("const telegram = new TelegramService"));
  const end = source.indexOf("\n  enqueue:", start);
  const expression = source.slice(start + "approvals: ".length, end).trim().replace(/,$/, "");
  const bot = { id: "bot", name: "Fixture", threadId: "thread", modelSelection: { instanceId: "claude" } };
  const message = { id: "card", card: { requestId: "request", tool: "Write", subtitle: "fixture.txt", answered: undefined as string | undefined } };
  const store = { bot: () => bot, messagesFor: () => [message] };
  const answerRequest = vi.fn(async () => { message.card.answered = "allow"; return "allowed-once"; });
  const actions = new Function("store", "askMessageByRequest", "createHash", "redactSecretsInText", "answerRequest", `return (${expression})("bot");`)(store, new Map([["thread:request", "card"]]), createHash, (text: string) => text, answerRequest);
  const offered = actions.pending()[0];
  message.card.subtitle = "different action";
  expect(await actions.resolve(offered, "allow")).toBe(false);
  const changed = actions.pending()[0];
  expect(await actions.resolve(changed, "allow")).toBe(true);
  expect(await actions.resolve(changed, "allow")).toBe(false);
  expect(answerRequest).toHaveBeenCalledExactlyOnceWith("thread", "claude", "request", "allow", undefined, { id: "bot", name: "Fixture" });
});
it("normalizes callbacks only from identifiable humans in private chats", () => {
  const callback = { id: "cb", from: { id: 7, is_bot: false }, message: { message_id: 3, chat: { id: 7, type: "private" } }, data: "nonce:a" };
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: callback })).toMatchObject({ kind: "callback", senderId: "7", chatId: "7", messageId: 3 });
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: { ...callback, from: { id: 7, is_bot: true } } })).toMatchObject({ kind: "ignored" });
  expect(normalizeTelegramUpdate({ update_id: 8, callback_query: { ...callback, message: { message_id: 3, chat: { id: -7, type: "group" } } } })).toMatchObject({ kind: "ignored" });
});
