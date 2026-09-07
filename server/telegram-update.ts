/** Telegram content never establishes local-desktop authority. Pairing and
 * routing must separately match these numeric identities to an approved owner. */
export type TelegramUpdate =
  | { updateId: number; kind: "callback"; callbackId: string; senderId: string; chatId: string; messageId: number; data: string }
  | { updateId: number; kind: "ignored"; reason: "unsupported-update" | "unsupported-message" | "unknown-sender" | "bot-message" }
  | { updateId: number; kind: "message"; transport: "telegram"; origin: "channel"; untrusted: true;
      chatId: string; chatType: "private" | "group" | "supergroup"; senderId: string; messageId: number;
      timestampSeconds: number; topicId?: number; forwarded: boolean; text: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, positive = false): value is number => typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);

export function normalizeTelegramUpdate(value: unknown): TelegramUpdate {
  if (!object(value) || !Object.hasOwn(value, "update_id") || !integer(value.update_id)) throw new Error("Telegram returned an invalid update identity");
  const updateId = value.update_id;
  const ignore = (reason: Extract<TelegramUpdate, { kind: "ignored" }>["reason"]): TelegramUpdate => ({ updateId, kind: "ignored", reason });
  if (object(value.callback_query)) {
    const callback = value.callback_query, message = callback.message;
    if (typeof callback.id !== "string" || !callback.id || callback.id.length > 200 || !object(callback.from) || !integer(callback.from.id, true) || callback.from.is_bot !== false
      || !object(message) || !integer(message.message_id, true) || !object(message.chat) || message.chat.type !== "private" || !integer(message.chat.id, true)
      || typeof callback.data !== "string" || Buffer.byteLength(callback.data) > 64 || callback.inline_message_id !== undefined) return ignore("unsupported-update");
    return { updateId, kind: "callback", callbackId: callback.id, senderId: String(callback.from.id), chatId: String(message.chat.id), messageId: message.message_id, data: callback.data };
  }
  if (!Object.hasOwn(value, "message") || !object(value.message)) return ignore("unsupported-update");
  const message = value.message;
  if (!object(message.from) || !integer(message.from.id, true) || typeof message.from.is_bot !== "boolean" || message.sender_chat !== undefined) return ignore("unknown-sender");
  if (message.from.is_bot) return ignore("bot-message");
  if (!object(message.chat) || typeof message.chat.id !== "number" || !Number.isSafeInteger(message.chat.id) || message.chat.id === 0
    || !["private", "group", "supergroup"].includes(String(message.chat.type))
    || !integer(message.message_id, true) || !integer(message.date)
    || typeof message.text !== "string" || !message.text.trim() || message.text.length > 4096
    || (message.message_thread_id !== undefined && !integer(message.message_thread_id, true))) return ignore("unsupported-message");
  return { updateId, kind: "message", transport: "telegram", origin: "channel", untrusted: true,
    chatId: String(message.chat.id), chatType: message.chat.type as "private" | "group" | "supergroup",
    senderId: String(message.from.id), messageId: message.message_id, timestampSeconds: message.date,
    ...(message.message_thread_id === undefined ? {} : { topicId: message.message_thread_id }),
    forwarded: message.forward_origin !== undefined, text: message.text };
}
