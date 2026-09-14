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
//   faults.json    {"getMe"|"getUpdates"|"sendMessage": fault} until rewritten;
//                  fault is offline | conflict | unauthorized | bad-gateway
//   requests.jsonl one line per Bot API call this process attempted
//   sent.jsonl     one line per sendMessage that was accepted
import { appendFileSync, readFileSync } from "node:fs";
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

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "https://api.telegram.org") {
    if (loopback.has(url.hostname)) return original(input, init);
    throw new TypeError("External network is disabled in the channel rehearsal");
  }
  const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const fault = readJson("faults.json", {})[method] ?? null;
  appendFileSync(join(dir, "requests.jsonl"), JSON.stringify({ at: Date.now(), method, fault,
    ...(method === "getUpdates" ? { offset: Number(body.offset ?? 0) } : {}),
    ...(method === "sendMessage" ? { chatId: String(body.chat_id), text: body.text } : {}) }) + "\n");
  if (fault === "offline") throw new TypeError("fetch failed");
  if (fault === "conflict") return failure(409, "Conflict: terminated by other getUpdates request");
  if (fault === "unauthorized") return failure(401, "Unauthorized");
  if (fault === "bad-gateway") return failure(502, "Bad Gateway");
  if (method === "getMe") return Response.json({ ok: true, result: { id: 123, is_bot: true, username: "rehearsal_bot" } });
  if (method === "getUpdates") {
    const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 100);
    const due = readJson("updates.json", []).filter(update => update.update_id >= offset || update.redeliver === true)
      .map(({ redeliver: _redeliver, ...update }) => update);
    return Response.json({ ok: true, result: due.slice(0, limit) });
  }
  if (method === "sendMessage") {
    appendFileSync(join(dir, "sent.jsonl"), JSON.stringify({ chatId: String(body.chat_id), text: body.text }) + "\n");
    return Response.json({ ok: true, result: { message_id: ++messageId, chat: { id: Number(body.chat_id) } } });
  }
  return failure(400, "Unsupported method in channel rehearsal");
};
