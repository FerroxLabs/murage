// Rehearsal-only Telegram Bot API stand-in, `--import`ed ahead of
// server/index.ts by scripts/channel-live-qualify.ts. Production has no
// endpoint override, so the rehearsal replaces this process's fetch for
// https://api.telegram.org and refuses every other non-loopback origin.
// A live run never imports this file.
//
// CHANNEL_LIVE_TELEGRAM_DIR is driven with plain files:
//   updates.json   raw updates; getUpdates answers those at/after the offset,
//                  plus any marked "redeliver": true regardless of offset
//                  (a provider redelivery the channel must not repeat)
//   faults.json    {"getMe"|"getUpdates"|"sendMessage"|...: fault} until rewritten;
//                  fault is offline | conflict | unauthorized | bad-gateway |
//                  rate-limit (429, retry after 1 s) | dns (injected ENOTFOUND
//                  error; no real DNS query) | hang (no answer until the caller aborts)
//   requests.jsonl one line per Bot API call this process attempted
//   sent.jsonl     one line per sendMessage that was accepted
//   callbacks.jsonl one line per answerCallbackQuery that was accepted
//   edits.jsonl    one line per editMessageText that was accepted
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CHANNEL_LIVE_TELEGRAM_DIR;
if (!dir) throw new Error("The Telegram rehearsal requires CHANNEL_LIVE_TELEGRAM_DIR.");
const original = globalThis.fetch;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
let messageId = 0;

const readJson = (name, fallback) => {
  try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return fallback; }
};
const failure = (status, description) => Response.json({ ok: false, error_code: status, description }, { status });
// Message ids continue across same-data restarts, like a real chat.
const nextMessageId = () => {
  const file = join(dir, "sent.jsonl");
  if (!messageId && existsSync(file)) messageId = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  return ++messageId;
};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "https://api.telegram.org") {
    if (loopback.has(url.hostname)) return original(input, init);
    throw new TypeError("External network is disabled in the channel rehearsal");
  }
  const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const fault = readJson("faults.json", {})[method] ?? null;
  const keyboard = body.reply_markup?.inline_keyboard;
  appendFileSync(join(dir, "requests.jsonl"), JSON.stringify({ at: Date.now(), method, fault,
    ...(method === "getUpdates" ? { offset: Number(body.offset ?? 0) } : {}),
    ...(method === "sendMessage" ? { chatId: String(body.chat_id), text: body.text, ...(keyboard ? { keyboard } : {}) } : {}),
    ...(method === "answerCallbackQuery" ? { callbackId: body.callback_query_id } : {}),
    ...(method === "editMessageText" ? { messageId: body.message_id } : {}) }) + "\n");
  if (fault === "offline") throw new TypeError("fetch failed");
  if (fault === "dns") throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND", syscall: "getaddrinfo" }) });
  if (fault === "hang") return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  if (fault === "conflict") return failure(409, "Conflict: terminated by other getUpdates request");
  if (fault === "unauthorized") return failure(401, "Unauthorized");
  if (fault === "bad-gateway") return failure(502, "Bad Gateway");
  if (fault === "rate-limit") return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }, { status: 429 });
  if (method === "getMe") return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "rehearsal_bot" } });
  if (method === "getUpdates") {
    const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 100);
    const due = readJson("updates.json", []).filter(update => update.update_id >= offset || update.redeliver === true)
      .map(({ redeliver: _redeliver, ...update }) => update);
    return Response.json({ ok: true, result: due.slice(0, limit) });
  }
  if (method === "sendMessage") {
    const id = nextMessageId();
    appendFileSync(join(dir, "sent.jsonl"), JSON.stringify({ chatId: String(body.chat_id), text: body.text, messageId: id, ...(keyboard ? { keyboard } : {}) }) + "\n");
    return Response.json({ ok: true, result: { message_id: id, chat: { id: Number(body.chat_id) } } });
  }
  if (method === "answerCallbackQuery") {
    appendFileSync(join(dir, "callbacks.jsonl"), JSON.stringify({ callbackId: body.callback_query_id, text: body.text }) + "\n");
    return Response.json({ ok: true, result: true });
  }
  if (method === "editMessageText") {
    appendFileSync(join(dir, "edits.jsonl"), JSON.stringify({ chatId: String(body.chat_id), messageId: body.message_id, text: body.text, keyboard: keyboard ?? null }) + "\n");
    return Response.json({ ok: true, result: { message_id: body.message_id, chat: { id: Number(body.chat_id) } } });
  }
  return failure(400, "Unsupported method in channel rehearsal");
};
